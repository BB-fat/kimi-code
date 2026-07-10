/**
 * `replayBuilder` domain — read-time projection from the op-native
 * `ReplayTimeline` into the v1-shaped `AgentReplayRecord` DTO the SDK/TUI
 * hydrates resumed sessions from (`ResumedAgentState.replay`).
 *
 * The timeline stores `{ type, payload }` entries reduced from wire Ops; this
 * projection mirrors the push decisions v1's `ReplayBuilder` made at restore
 * time (packages/agent-core `agent/replay/index.ts` and its domain push sites):
 *
 * - `context.append_message`           → `message`; deferred while a tool
 *   exchange is open and flushed once it closes (v1 deferral parity)
 * - `context.append_loop_event`        → folded into `message` records the
 *   way the live context folds a turn: one assistant `message` per step
 *   (emitted when the step closes), one tool `message` per `tool.result`.
 *   A trailing exchange left open by an interrupted session — or a gap
 *   mid-history — is closed with synthetic interrupted tool results (v1
 *   `finishResume` / step-boundary parity). Fold semantics mirror
 *   `reduceContextTranscript` in `contextMemory`.
 * - `context.apply_compaction`         → `compaction` carrying the durable
 *   result (summary + token counts live on this op's payload in v2); also
 *   resets the loop-event fold bookkeeping the way live `resetFold` does —
 *   pending calls and deferred messages are forgotten, while the open step's
 *   assistant keeps buffering (the partial assistant survives in live state)
 * - `full_compaction.begin`            → `compaction` with instruction only
 *   (v1 pushes the same at restore; the TUI skips result-less records)
 * - `full_compaction.cancel`           → `compaction` with result 'cancelled'
 * - `full_compaction.complete`         → nothing (empty payload; the visible
 *   result already came from `context.apply_compaction`)
 * - `goal.create` / `goal.update`      → `goal_updated`; goal state is folded
 *   per record so each snapshot reflects that point in the timeline, and
 *   counter-only updates are skipped like v1 (`restoreUpdate` returns early
 *   when no status is present)
 * - `goal.clear`                       → nothing (v1 pushes no record)
 * - `plan_mode.enter` / cancel / exit  → `plan_updated`
 * - `config.update`                    → `config_updated`
 * - `permission.set_mode`              → `permission_updated`
 * - `permission.record_approval_result`→ `approval_result`
 *
 * Timeline entries carry no record time (the derived model reduces op
 * payloads, not persisted records), and no consumer reads
 * `AgentReplayRecord.time`, so every record stamps `0`.
 */

import {
  createToolMessage,
  type ContentPart,
  type ToolCall,
} from '#/app/llmProtocol/message';
import type { ContextCompactionPayload } from '#/agent/contextMemory/contextOps';
import { TOOL_INTERRUPTED_ON_RESUME_OUTPUT } from '#/agent/contextMemory/loopEventFold';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { CompactionResult } from '#/agent/fullCompaction/types';
import type { GoalState, GoalUpdatePayload } from '#/agent/goal/goalOps';
import type {
  GoalBudgetLimits,
  GoalBudgetReport,
  GoalChange,
  GoalSnapshot,
} from '#/agent/goal/types';

import type { ReplayTimeline } from './replayTimelineModel';
import type { AgentReplayRecord } from './types';

const NO_TIME = 0;

export function projectReplayTimeline(timeline: ReplayTimeline): readonly AgentReplayRecord[] {
  const records: AgentReplayRecord[] = [];
  let goal: GoalState | null = null;

  let openAssistant: { content: ContentPart[]; toolCalls: ToolCall[] } | null = null;
  const pendingToolCallIds = new Set<string>();
  let deferredMessages: ContextMessage[] = [];

  const pushMessage = (message: ContextMessage): void => {
    records.push({ time: NO_TIME, type: 'message', message });
  };
  const flushDeferred = (): void => {
    if (pendingToolCallIds.size > 0 || deferredMessages.length === 0) return;
    for (const message of deferredMessages) pushMessage(message);
    deferredMessages = [];
  };
  const closeOpenAssistant = (): void => {
    if (openAssistant === null) return;
    pushMessage({
      role: 'assistant',
      content: openAssistant.content,
      toolCalls: openAssistant.toolCalls,
    });
    openAssistant = null;
  };
  const closePendingAsInterrupted = (): void => {
    for (const toolCallId of pendingToolCallIds) {
      pushMessage({
        ...createToolMessage(toolCallId, TOOL_INTERRUPTED_ON_RESUME_OUTPUT),
        isError: true,
      });
    }
    pendingToolCallIds.clear();
  };
  const resetLoopFold = (): void => {
    pendingToolCallIds.clear();
    deferredMessages = [];
  };

  for (const entry of timeline) {
    switch (entry.type) {
      case 'context.append_message':
        if (pendingToolCallIds.size > 0) {
          deferredMessages.push(entry.payload.message);
        } else {
          pushMessage(entry.payload.message);
        }
        break;
      case 'context.append_loop_event': {
        const event = entry.payload.event;
        switch (event.type) {
          case 'step.begin':
            closeOpenAssistant();
            closePendingAsInterrupted();
            flushDeferred();
            openAssistant = { content: [], toolCalls: [] };
            break;
          case 'content.part':
            openAssistant?.content.push(event.part);
            break;
          case 'tool.call': {
            const call: ToolCall = {
              type: 'function',
              id: event.toolCallId,
              name: event.name,
              arguments: event.args === undefined ? null : JSON.stringify(event.args),
              extras: event.extras,
            };
            pendingToolCallIds.add(event.toolCallId);
            openAssistant?.toolCalls.push(call);
            break;
          }
          case 'tool.result':
            if (pendingToolCallIds.has(event.toolCallId)) {
              pendingToolCallIds.delete(event.toolCallId);
              const output = event.result.output;
              pushMessage({
                ...createToolMessage(
                  event.toolCallId,
                  typeof output === 'string' ? output : [...output],
                ),
                isError: event.result.isError,
                note: event.result.note,
              });
              flushDeferred();
            }
            break;
          case 'step.end':
            closeOpenAssistant();
            flushDeferred();
            break;
        }
        break;
      }
      case 'context.apply_compaction': {
        resetLoopFold();
        const payload = entry.payload;
        const result: CompactionResult = {
          summary: compactionSummary(payload),
          contextSummary: 'contextSummary' in payload ? payload.contextSummary : undefined,
          compactedCount: payload.compactedCount ?? 0,
          tokensBefore: payload.tokensBefore ?? 0,
          tokensAfter: payload.tokensAfter ?? 0,
          keptUserMessageCount: payload.keptUserMessageCount,
          keptHeadUserMessageCount: payload.keptHeadUserMessageCount,
          droppedCount: payload.droppedCount,
        };
        records.push({ time: NO_TIME, type: 'compaction', result });
        break;
      }
      case 'full_compaction.begin':
        records.push({ time: NO_TIME, type: 'compaction', instruction: entry.payload.instruction });
        break;
      case 'full_compaction.cancel':
        records.push({ time: NO_TIME, type: 'compaction', result: 'cancelled' });
        break;
      case 'full_compaction.complete':
        break;
      case 'goal.create':
        goal = {
          goalId: entry.payload.goalId,
          objective: entry.payload.objective,
          completionCriterion: entry.payload.completionCriterion,
          status: 'active',
          turnsUsed: 0,
          tokensUsed: 0,
          wallClockMs: 0,
          budgetLimits: {},
        };
        records.push({
          time: NO_TIME,
          type: 'goal_updated',
          snapshot: goalSnapshot(goal),
          change: { kind: 'created' },
        });
        break;
      case 'goal.update': {
        if (goal === null) break;
        const payload = entry.payload;
        const statusChanged = payload.status !== undefined && payload.status !== goal.status;
        goal = applyGoalUpdate(goal, payload);
        // v1 parity: `restoreUpdate` only pushes a replay record when the
        // update carries a status transition; pure counter bumps are not
        // transcript events.
        if (!statusChanged) break;
        const change: GoalChange =
          payload.status === 'complete'
            ? {
                kind: 'completion',
                status: payload.status,
                reason: payload.reason,
                stats: {
                  turnsUsed: goal.turnsUsed,
                  tokensUsed: goal.tokensUsed,
                  wallClockMs: goal.wallClockMs,
                },
                actor: payload.actor,
              }
            : { kind: 'lifecycle', status: payload.status, reason: payload.reason, actor: payload.actor };
        records.push({
          time: NO_TIME,
          type: 'goal_updated',
          snapshot: goalSnapshot(goal),
          change,
        });
        break;
      }
      case 'goal.clear':
        goal = null;
        break;
      case 'plan_mode.enter':
        records.push({ time: NO_TIME, type: 'plan_updated', enabled: true });
        break;
      case 'plan_mode.cancel':
      case 'plan_mode.exit':
        records.push({ time: NO_TIME, type: 'plan_updated', enabled: false });
        break;
      case 'config.update': {
        const payload = entry.payload;
        records.push({
          time: NO_TIME,
          type: 'config_updated',
          config: {
            cwd: payload.cwd,
            modelAlias: payload.modelAlias,
            profileName: payload.profileName,
            thinkingLevel: payload.thinkingLevel ?? payload.thinkingEffort,
            systemPrompt: payload.systemPrompt,
          },
        });
        break;
      }
      case 'permission.set_mode':
        records.push({ time: NO_TIME, type: 'permission_updated', mode: entry.payload.mode });
        break;
      case 'permission.record_approval_result':
        records.push({ time: NO_TIME, type: 'approval_result', record: entry.payload });
        break;
    }
  }
  closeOpenAssistant();
  closePendingAsInterrupted();
  flushDeferred();
  return records;
}

/** Mirror of `goalOps` `updateGoal.apply` so per-record snapshots track the timeline. */
function applyGoalUpdate(state: GoalState, payload: GoalUpdatePayload): GoalState {
  let next = state;
  if (payload.status !== undefined && payload.status !== state.status) {
    next = {
      ...next,
      status: payload.status,
      terminalReason: payload.status === 'active' ? undefined : payload.reason,
    };
  }
  if (payload.turnsUsed !== undefined && payload.turnsUsed !== next.turnsUsed) {
    next = { ...next, turnsUsed: payload.turnsUsed };
  }
  if (payload.tokensUsed !== undefined && payload.tokensUsed !== next.tokensUsed) {
    next = { ...next, tokensUsed: payload.tokensUsed };
  }
  if (payload.wallClockMs !== undefined && payload.wallClockMs !== next.wallClockMs) {
    next = { ...next, wallClockMs: payload.wallClockMs };
  }
  if (payload.budgetLimits !== undefined && payload.budgetLimits !== next.budgetLimits) {
    next = { ...next, budgetLimits: payload.budgetLimits };
  }
  return next;
}

function goalSnapshot(state: GoalState): GoalSnapshot {
  return {
    goalId: state.goalId,
    objective: state.objective,
    completionCriterion: state.completionCriterion,
    status: state.status,
    turnsUsed: state.turnsUsed,
    tokensUsed: state.tokensUsed,
    wallClockMs: state.wallClockMs,
    budget: budgetReport(state.budgetLimits, state),
    terminalReason: state.terminalReason,
  };
}

function budgetReport(
  limits: GoalBudgetLimits,
  used: { readonly turnsUsed: number; readonly tokensUsed: number; readonly wallClockMs: number },
): GoalBudgetReport {
  const tokenBudget = limits.tokenBudget ?? null;
  const turnBudget = limits.turnBudget ?? null;
  const wallClockBudgetMs = limits.wallClockBudgetMs ?? null;
  const tokenBudgetReached = tokenBudget !== null && used.tokensUsed >= tokenBudget;
  const turnBudgetReached = turnBudget !== null && used.turnsUsed >= turnBudget;
  const wallClockBudgetReached = wallClockBudgetMs !== null && used.wallClockMs >= wallClockBudgetMs;
  return {
    tokenBudget,
    turnBudget,
    wallClockBudgetMs,
    remainingTokens: tokenBudget === null ? null : Math.max(0, tokenBudget - used.tokensUsed),
    remainingTurns: turnBudget === null ? null : Math.max(0, turnBudget - used.turnsUsed),
    remainingWallClockMs:
      wallClockBudgetMs === null ? null : Math.max(0, wallClockBudgetMs - used.wallClockMs),
    tokenBudgetReached,
    turnBudgetReached,
    wallClockBudgetReached,
    overBudget: tokenBudgetReached || turnBudgetReached || wallClockBudgetReached,
  };
}

function compactionSummary(payload: ContextCompactionPayload): string {
  if (typeof payload.summary === 'string') return payload.summary;
  if ('contextSummary' in payload && typeof payload.contextSummary === 'string') {
    return payload.contextSummary;
  }
  // Legacy v1 records stored the literal summary ContextMessage the model saw.
  const message = payload.summary as ContextMessage | undefined;
  if (message !== undefined && Array.isArray(message.content)) {
    return message.content.map((part) => (part?.type === 'text' ? part.text : '')).join('');
  }
  return '';
}

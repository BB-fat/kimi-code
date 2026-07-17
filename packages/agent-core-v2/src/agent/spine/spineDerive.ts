/**
 * `spine` domain (L4) — derives the task tree purely from the stored
 * `contextMemory` message stream.
 *
 * The message stream is the single source of truth: a spine control-tool call
 * whose accepted receipt landed in history IS the transition — no parallel op
 * records, no commit protocol, and nothing to repair when the history shrinks
 * (an undo that removes a transition's messages removes the transition).
 * `deriveSpineState` scans the surviving messages, matches each `spine_open` /
 * `spine_close` / `spine_next` call to its accepted receipt — the exact
 * `ACCEPTED_OUTPUT` carrier text, or the legacy bare `accepted` left by older
 * sessions; persisted metadata can degrade, so the match is textual and a
 * near-miss does not count — and replays the transitions under the same
 * guards the legacy ops enforced (cursor position, non-empty bodies, root
 * epochs never close). Root-epoch boundaries come from the compaction summary
 * message itself (`origin.kind === 'compaction_summary'`, with the summary
 * prefix text as the fallback carrier when the origin metadata is absent). A
 * closing node's memory body is assembled from the live span — user requests
 * keep their fold ordinals and already-closed children contribute their
 * assembled bodies — so an undo that rewrites the span rewrites the memory
 * with it. Consumed by `spineService`; the fold projection and archive
 * rendering are unchanged.
 *
 * Silence is the design, not an oversight: a call whose accepted receipt never
 * landed, a receipt whose call is missing, or a transition the guards reject
 * (a close under a stale cursor, an empty body) simply does not happen, with
 * no lost-commit audit and no repair op. The stream is the whole truth, so a
 * transition the stream does not fully witness is not a transition — the
 * legacy op world needed `reportLostCommits` precisely because it kept a
 * second record that could disagree with the receipts.
 */

import {
  COMPACTION_SUMMARY_PREFIX,
  isCompactionSummaryMessage,
} from '#/agent/contextMemory/compactionHandoff';
import type { ContextMessage } from '#/agent/contextMemory/types';

import { SPINE_TOOL_CLOSE, SPINE_TOOL_NEXT, SPINE_TOOL_OPEN } from './spine';
import { collectSpanUserRequests } from './spineFold';
import type { SpineNode, SpineState } from './spineOps';
import {
  assembleMemoryBody,
  childNodeId,
  closedChildMemories,
  epochStartupNodeId,
  isRootEpoch,
  nextChildIndex,
  parentNodeId,
  SPINE_VOID_OPENED_AT,
} from './spineTree';
import { ACCEPTED_OUTPUT } from './tools/controlResult';

/** Receipt left by sessions predating the delayed-commit receipt wording. */
const LEGACY_ACCEPTED_RECEIPT = 'accepted';

export function deriveSpineState(messages: readonly ContextMessage[]): SpineState {
  const accepted = collectAcceptedCallIds(messages);
  const nodes: Record<string, SpineNode> = {};
  let openStack: readonly string[] = [];
  let rootEpoch = 0;
  let epochStartAt = 0;
  let epochMemoryAt: number | undefined;

  function openEpoch(epoch: number, startupOpenedAt: number): void {
    const epochId = String(epoch);
    const startupId = epochStartupNodeId(epoch);
    nodes[epochId] = {
      id: epochId,
      summary: `root epoch ${String(epoch)}`,
      openedAt: SPINE_VOID_OPENED_AT,
      children: [startupId],
    };
    nodes[startupId] = {
      id: startupId,
      summary: 'startup',
      openedAt: startupOpenedAt,
      children: [],
    };
    openStack = [epochId, startupId];
    rootEpoch = epoch;
  }

  function assembleNodeMemory(node: SpineNode, closedAt: number, nodeMemory: string): string {
    return assembleMemoryBody({
      userRequests: collectSpanUserRequests(messages, node.openedAt, closedAt),
      childMemories: closedChildMemories(nodes, node),
      nodeMemory,
    });
  }

  function openNode(summary: string, openedAt: number): void {
    const parentId = openStack.at(-1);
    if (parentId === undefined) return;
    const parent = nodes[parentId];
    if (parent === undefined || parent.closedAt !== undefined) return;
    const trimmed = summary.trim();
    if (trimmed.length === 0) return;
    const id = childNodeId(parentId, nextChildIndex(parent.children));
    nodes[id] = { id, summary: trimmed, openedAt, children: [] };
    nodes[parentId] = { ...parent, children: [...parent.children, id] };
    openStack = [...openStack, id];
  }

  function closeNode(memory: string, carrierAt: number): void {
    const id = openStack.at(-1);
    if (id === undefined || isRootEpoch(id)) return;
    const node = nodes[id];
    if (node === undefined || node.closedAt !== undefined) return;
    const trimmed = memory.trim();
    if (trimmed.length === 0) return;
    // The span ends BEFORE the assistant message carrying the transition call,
    // so the carrier and its receipt stay visible in the parent context.
    const closedAt = Math.max(carrierAt - 1, node.openedAt);
    nodes[id] = { ...node, closedAt, memory: assembleNodeMemory(node, closedAt, trimmed) };
    openStack = openStack.slice(0, -1);
  }

  function nextNode(summary: string, memory: string, carrierAt: number): void {
    const closedId = openStack.at(-1);
    if (closedId === undefined || isRootEpoch(closedId)) return;
    const closing = nodes[closedId];
    if (closing === undefined || closing.closedAt !== undefined) return;
    const trimmedSummary = summary.trim();
    const trimmedMemory = memory.trim();
    if (trimmedSummary.length === 0 || trimmedMemory.length === 0) return;
    const parentId = parentNodeId(closedId);
    if (parentId === null) return;
    const parent = nodes[parentId];
    if (parent === undefined) return;
    const closedAt = Math.max(carrierAt - 1, closing.openedAt);
    const openedId = childNodeId(parentId, nextChildIndex(parent.children));
    nodes[closedId] = {
      ...closing,
      closedAt,
      memory: assembleNodeMemory(closing, closedAt, trimmedMemory),
    };
    // The sibling opens right after the closing span — at the carrier's index —
    // so the carrier and its receipt ride inside the new sibling's span.
    nodes[openedId] = {
      id: openedId,
      summary: trimmedSummary,
      openedAt: closedAt + 1,
      children: [],
    };
    nodes[parentId] = { ...parent, children: [...parent.children, openedId] };
    openStack = [...openStack.slice(0, -1), openedId];
  }

  openEpoch(1, 0);
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message === undefined) continue;
    if (isEpochBoundary(message)) {
      openEpoch(rootEpoch + 1, i + 1);
      epochStartAt = i + 1;
      epochMemoryAt = i;
      continue;
    }
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls) {
      if (!accepted.has(call.id)) continue;
      const args = parseTransitionArgs(call.arguments);
      if (args === undefined) continue;
      if (call.name === SPINE_TOOL_OPEN) {
        openNode(args.summary, i);
      } else if (call.name === SPINE_TOOL_CLOSE) {
        closeNode(args.memory, i);
      } else if (call.name === SPINE_TOOL_NEXT) {
        nextNode(args.summary, args.memory, i);
      }
    }
  }

  return { nodes, openStack, rootEpoch, epochStartAt, epochMemoryAt };
}

interface SpineTransitionArgs {
  readonly summary: string;
  readonly memory: string;
}

function parseTransitionArgs(raw: string | null | undefined): SpineTransitionArgs | undefined {
  if (raw === undefined || raw === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const summary = record['summary'];
  const memory = record['memory'];
  return {
    summary: typeof summary === 'string' ? summary : '',
    memory: typeof memory === 'string' ? memory : '',
  };
}

function collectAcceptedCallIds(messages: readonly ContextMessage[]): ReadonlySet<string> {
  const spineCallIds = new Set<string>();
  for (const message of messages) {
    if (message === undefined || message.role !== 'assistant') continue;
    for (const call of message.toolCalls) {
      if (isSpineTransitionTool(call.name)) spineCallIds.add(call.id);
    }
  }
  const accepted = new Set<string>();
  for (const message of messages) {
    if (message === undefined || message.role !== 'tool') continue;
    const callId = message.toolCallId;
    if (callId === undefined || !spineCallIds.has(callId)) continue;
    if (message.isError === true) continue;
    const text = messageText(message);
    if (text === ACCEPTED_OUTPUT || text === LEGACY_ACCEPTED_RECEIPT) accepted.add(callId);
  }
  return accepted;
}

function isSpineTransitionTool(name: string): boolean {
  return name === SPINE_TOOL_OPEN || name === SPINE_TOOL_CLOSE || name === SPINE_TOOL_NEXT;
}

function isEpochBoundary(message: ContextMessage): boolean {
  if (message.role !== 'user') return false;
  if (isCompactionSummaryMessage(message)) return true;
  // Fallback carrier for degraded persistence: only when the origin metadata
  // is absent — a message that still carries a non-summary origin is trusted.
  if (message.origin !== undefined) return false;
  return messageText(message).startsWith(COMPACTION_SUMMARY_PREFIX);
}

function messageText(message: ContextMessage): string {
  return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

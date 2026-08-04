/**
 * CoworkStatusTool — the shared dashboard: mission table, roster, per-branch
 * review-gate state (latest review round/status and whether it still matches
 * the branch tip), the caller's inbox count, and the recent activity log.
 */

import type { Agent } from '#/agent';
import { z } from 'zod';

import { branchExists, branchTip } from '../../../agent/cowork';
import type { CoworkMission, CoworkState } from '../../../agent/cowork';
import type { BuiltinTool } from '../../../agent/tool';
import { coworkRateLimiter } from '../../../loop/rate-limiter';
import type { RateLimiterSnapshot } from '../../../loop/rate-limiter';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import { callerName, newStore, runCoworkTool } from './support';

export const CoworkStatusToolInputSchema = z.object({}).strict();

export type CoworkStatusToolInput = z.infer<typeof CoworkStatusToolInputSchema>;

const STATUS_EMOJI: Record<CoworkMission['status'], string> = {
  planned: '🟡',
  active: '🔵',
  completed: '🟢',
  blocked: '🔴',
  paused: '⏸️',
  merged: '✅',
};

const INBOX_COUNT_LIMIT = 1000;
const RECENT_LOG_LINES = 10;

export class CoworkStatusTool implements BuiltinTool<CoworkStatusToolInput> {
  readonly name = 'CoworkStatus' as const;
  readonly description: string = `Show the cowork dashboard: missions (status/owner), the agent roster, the review-gate state of every unmerged branch (latest review round/status and whether the reviewed commit still matches the branch tip), your inbox message count, and the last activity log lines.`;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(CoworkStatusToolInputSchema);

  constructor(private readonly agent: Agent) {}

  resolveExecution(_args: CoworkStatusToolInput): ToolExecution {
    return {
      description: 'Reading cowork status',
      approvalRule: this.name,
      execute: () =>
        runCoworkTool(async () => {
          const store = newStore(this.agent);
          const state = await store.load();
          const caller = callerName(this.agent, state);

          const sections: string[] = [
            `# Cowork status — base: ${state.base} (mode: ${state.mode}), you are: ${caller}`,
            '',
            '## Missions',
            '',
            ...renderMissions(state),
            '',
            '## Roster',
            '',
            ...renderRoster(state),
            '',
            '## Review gate (unmerged branches)',
            '',
            ...(await this.renderReviewGate(store, state)),
          ];

          if (
            state.missions.length > 0 &&
            state.missions.every((mission) => mission.status === 'merged')
          ) {
            sections.push(
              '',
              '## Done',
              '',
              'All missions are merged. Free the worktree checkouts now: run CoworkTeardown (branches and .cowork/comms/ are kept; dirty worktrees are protected).',
            );
          }

          const inbox = await store.readInbox(caller, INBOX_COUNT_LIMIT);
          sections.push(
            '',
            '## Inbox',
            '',
            `${String(inbox.length)} message(s) visible to you — read with CoworkInbox.`,
            '',
            '## Concurrency (adaptive)',
            '',
            renderConcurrency(coworkRateLimiter.snapshot()),
            '',
            '## Recent activity',
            '',
          );
          const log = await store.recentLog(RECENT_LOG_LINES);
          sections.push(...(log.length > 0 ? log : ['(activity log is empty)']));
          return { output: sections.join('\n') };
        }),
    };
  }

  private async renderReviewGate(
    store: ReturnType<typeof newStore>,
    state: CoworkState,
  ): Promise<string[]> {
    const pending = state.missions.filter((m) => m.status !== 'merged');
    if (pending.length === 0) return ['(all missions merged — or none planned yet)'];
    const lines: string[] = [];
    for (const mission of pending) {
      const review = await store.latestReview(mission.branch);
      if (review === undefined) {
        lines.push(`- ${mission.branch} (${mission.id}): no review yet`);
        continue;
      }
      const tip = (await branchExists(store.repoRoot, mission.branch))
        ? await branchTip(store.repoRoot, mission.branch)
        : undefined;
      const sync =
        tip === undefined
          ? 'branch not created yet'
          : tip === review.reviewedCommit
            ? 'reviewed commit matches tip'
            : `STALE — tip moved to ${tip.slice(0, 7)}, re-review required`;
      lines.push(
        `- ${mission.branch} (${mission.id}): round ${String(review.round)} by ${review.reviewer} — ${review.status} (${sync})`,
      );
    }
    return lines;
  }
}

function renderConcurrency(snapshot: RateLimiterSnapshot): string {
  const parts = [
    `budget: ${String(snapshot.budget)} agent(s) · inflight: ${String(snapshot.inflight)}`,
  ];
  if (snapshot.blockedUntil !== null) {
    const remainingMs = snapshot.blockedUntil - Date.now();
    parts.push(
      remainingMs > 0
        ? `spawns PAUSED for ~${String(Math.ceil(remainingMs / 1000))}s (provider rate limit — successful requests lift the pause early)`
        : 'spawn pause expired — budget probing resumes',
    );
  } else {
    parts.push('spawns open');
  }
  return parts.join(' · ');
}

function renderMissions(state: CoworkState): string[] {
  if (state.missions.length === 0) return ['(no missions planned — use CoworkPlan)'];
  return [
    '| ID | Mission | Branch | Worktree | Status | Owner |',
    '| -- | ------- | ------ | -------- | ------ | ----- |',
    ...state.missions.map(
      (m) =>
        `| ${m.id} | ${m.title}${m.kind === 'survey' ? ' 🔍' : ''} | ${m.branch} | ${m.worktree} | ${STATUS_EMOJI[m.status]} ${m.status} | ${m.owner ?? '—'} |`,
    ),
  ];
}

function renderRoster(state: CoworkState): string[] {
  if (state.roster.agents.length === 0) {
    return ['(no agents registered — spawn workers/reviewers with CoworkSpawn)'];
  }
  return state.roster.agents.map((a) => {
    const assignment =
      a.kind === 'worker'
        ? `mission ${a.missionId ?? '?'} (branch ${a.branch ?? '?'}, worktree ${a.worktree ?? '?'})`
        : `reviewing ${a.reviewTarget ?? '?'}`;
    return `- ${a.name} (${a.kind}) — agent ${a.agentId}, ${assignment}`;
  });
}

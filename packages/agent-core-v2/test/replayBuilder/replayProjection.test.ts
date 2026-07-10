import { describe, expect, it } from 'vitest';

import { projectReplayTimeline } from '#/agent/replayBuilder/replayProjection';
import type { ReplayTimeline } from '#/agent/replayBuilder/replayTimelineModel';

/** Test entries are partial payloads cast into the op-native timeline shape. */
function timeline(entries: readonly unknown[]): ReplayTimeline {
  return entries as ReplayTimeline;
}

describe('projectReplayTimeline', () => {
  it('projects message and plan ops to v1-shaped replay records', () => {
    const records = projectReplayTimeline(
      timeline([
        {
          type: 'context.append_message',
          payload: {
            message: { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
          },
        },
        { type: 'plan_mode.enter', payload: { id: 'p1' } },
        { type: 'plan_mode.exit', payload: { id: 'p1' } },
      ]),
    );
    expect(records).toEqual([
      expect.objectContaining({ type: 'message', message: expect.objectContaining({ role: 'user' }) }),
      expect.objectContaining({ type: 'plan_updated', enabled: true }),
      expect.objectContaining({ type: 'plan_updated', enabled: false }),
    ]);
  });

  it('folds goal ops into per-record snapshots and change records', () => {
    const records = projectReplayTimeline(
      timeline([
        { type: 'goal.create', payload: { goalId: 'g1', objective: 'ship it' } },
        { type: 'goal.update', payload: { status: 'paused', reason: 'wait' } },
        { type: 'goal.update', payload: { turnsUsed: 3 } },
        { type: 'goal.update', payload: { status: 'complete', reason: 'done' } },
      ]),
    );
    // The counter-only update (turnsUsed) is not a transcript event.
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({
      type: 'goal_updated',
      change: { kind: 'created' },
      snapshot: { goalId: 'g1', objective: 'ship it', status: 'active' },
    });
    expect(records[1]).toMatchObject({
      type: 'goal_updated',
      change: { kind: 'lifecycle', status: 'paused', reason: 'wait' },
      snapshot: { status: 'paused' },
    });
    expect(records[2]).toMatchObject({
      type: 'goal_updated',
      change: { kind: 'completion', status: 'complete', stats: { turnsUsed: 3 } },
      snapshot: { status: 'complete', turnsUsed: 3 },
    });
  });

  it('drops goal state on clear so later updates produce no records', () => {
    const records = projectReplayTimeline(
      timeline([
        { type: 'goal.create', payload: { goalId: 'g1', objective: 'x' } },
        { type: 'goal.clear', payload: {} },
        { type: 'goal.update', payload: { status: 'paused' } },
      ]),
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ change: { kind: 'created' } });
  });

  it('projects compaction ops into begin/result/cancelled records', () => {
    const records = projectReplayTimeline(
      timeline([
        { type: 'full_compaction.begin', payload: { instruction: 'keep facts', source: 'manual' } },
        {
          type: 'context.apply_compaction',
          payload: { summary: 'condensed', compactedCount: 4, tokensBefore: 1000, tokensAfter: 200 },
        },
        { type: 'full_compaction.complete', payload: {} },
        { type: 'full_compaction.cancel', payload: {} },
      ]),
    );
    expect(records).toEqual([
      expect.objectContaining({ type: 'compaction', instruction: 'keep facts' }),
      expect.objectContaining({
        type: 'compaction',
        result: expect.objectContaining({
          summary: 'condensed',
          compactedCount: 4,
          tokensBefore: 1000,
          tokensAfter: 200,
        }),
      }),
      expect.objectContaining({ type: 'compaction', result: 'cancelled' }),
    ]);
  });

  it('projects permission, approval, and config ops', () => {
    const approval = { toolCallId: 't1', toolName: 'Bash', action: 'run', result: { decision: 'approved' } };
    const records = projectReplayTimeline(
      timeline([
        { type: 'permission.set_mode', payload: { mode: 'yolo' } },
        { type: 'permission.record_approval_result', payload: approval },
        { type: 'config.update', payload: { modelAlias: 'k2' } },
      ]),
    );
    expect(records).toEqual([
      expect.objectContaining({ type: 'permission_updated', mode: 'yolo' }),
      expect.objectContaining({ type: 'approval_result', record: approval }),
      expect.objectContaining({ type: 'config_updated', config: { modelAlias: 'k2' } }),
    ]);
  });
});

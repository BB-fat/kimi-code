import { describe, expect, it } from 'vitest';

import { projectReplayTimeline } from '#/agent/replayBuilder/replayProjection';
import type { ReplayTimeline } from '#/agent/replayBuilder/replayTimelineModel';

/** Test entries are partial payloads cast into the op-native timeline shape. */
function timeline(entries: readonly unknown[]): ReplayTimeline {
  return entries as ReplayTimeline;
}

function userEntry(text: string): unknown {
  return {
    type: 'context.append_message',
    payload: { message: { role: 'user', content: [{ type: 'text', text }], toolCalls: [] } },
  };
}

function loopEntry(event: Record<string, unknown>): unknown {
  return { type: 'context.append_loop_event', payload: { event } };
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

  it('folds loop events into assistant and tool message records in stream order', () => {
    const records = projectReplayTimeline(
      timeline([
        userEntry('hi'),
        loopEntry({ type: 'step.begin', uuid: 's1' }),
        loopEntry({ type: 'content.part', stepUuid: 's1', part: { type: 'text', text: 'hello ' } }),
        loopEntry({ type: 'content.part', stepUuid: 's1', part: { type: 'text', text: 'world' } }),
        loopEntry({ type: 'tool.call', stepUuid: 's1', toolCallId: 'tc1', name: 'Bash', args: { command: 'ls' } }),
        loopEntry({ type: 'step.end', uuid: 's1' }),
        loopEntry({ type: 'tool.result', toolCallId: 'tc1', result: { output: 'file.txt' } }),
        loopEntry({ type: 'step.begin', uuid: 's2' }),
        loopEntry({ type: 'content.part', stepUuid: 's2', part: { type: 'text', text: 'done' } }),
        loopEntry({ type: 'step.end', uuid: 's2' }),
      ]),
    );
    expect(records).toEqual([
      expect.objectContaining({ type: 'message', message: expect.objectContaining({ role: 'user' }) }),
      expect.objectContaining({
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'hello ' },
            { type: 'text', text: 'world' },
          ],
          toolCalls: [
            { type: 'function', id: 'tc1', name: 'Bash', arguments: '{"command":"ls"}' },
          ],
        },
      }),
      expect.objectContaining({
        type: 'message',
        message: expect.objectContaining({
          role: 'tool',
          toolCallId: 'tc1',
          content: [{ type: 'text', text: 'file.txt' }],
        }),
      }),
      expect.objectContaining({
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
          toolCalls: [],
        },
      }),
    ]);
  });

  it('defers user messages while a tool exchange is open and flushes after it closes', () => {
    const records = projectReplayTimeline(
      timeline([
        userEntry('first'),
        loopEntry({ type: 'step.begin', uuid: 's1' }),
        loopEntry({ type: 'tool.call', stepUuid: 's1', toolCallId: 'tc1', name: 'Bash' }),
        loopEntry({ type: 'step.end', uuid: 's1' }),
        userEntry('second'),
        loopEntry({ type: 'tool.result', toolCallId: 'tc1', result: { output: 'ok' } }),
      ]),
    );
    expect(
      records.map((record) => ('message' in record ? record.message.role : record.type)),
    ).toEqual(['user', 'assistant', 'tool', 'user']);
    expect(records[3]).toMatchObject({
      message: { content: [{ type: 'text', text: 'second' }] },
    });
  });

  it('closes a trailing interrupted exchange with synthetic tool results', () => {
    const records = projectReplayTimeline(
      timeline([
        userEntry('hi'),
        loopEntry({ type: 'step.begin', uuid: 's1' }),
        loopEntry({ type: 'content.part', stepUuid: 's1', part: { type: 'text', text: 'partial' } }),
        loopEntry({ type: 'tool.call', stepUuid: 's1', toolCallId: 'tc1', name: 'Bash' }),
      ]),
    );
    expect(records).toEqual([
      expect.objectContaining({ type: 'message', message: expect.objectContaining({ role: 'user' }) }),
      expect.objectContaining({
        type: 'message',
        message: expect.objectContaining({
          role: 'assistant',
          content: [{ type: 'text', text: 'partial' }],
          toolCalls: [expect.objectContaining({ id: 'tc1' })],
        }),
      }),
      expect.objectContaining({
        type: 'message',
        message: expect.objectContaining({
          role: 'tool',
          toolCallId: 'tc1',
          isError: true,
        }),
      }),
    ]);
  });

  it('closes a mid-history tool gap at the next step boundary', () => {
    const records = projectReplayTimeline(
      timeline([
        loopEntry({ type: 'step.begin', uuid: 's1' }),
        loopEntry({ type: 'tool.call', stepUuid: 's1', toolCallId: 'tc1', name: 'Bash' }),
        loopEntry({ type: 'step.end', uuid: 's1' }),
        loopEntry({ type: 'step.begin', uuid: 's2' }),
        loopEntry({ type: 'content.part', stepUuid: 's2', part: { type: 'text', text: 'recovered' } }),
        loopEntry({ type: 'step.end', uuid: 's2' }),
        loopEntry({ type: 'tool.result', toolCallId: 'tc1', result: { output: 'late' } }),
      ]),
    );
    expect(
      records.map((record) =>
        'message' in record ? [record.message.role, record.message.toolCallId] : [record.type],
      ),
    ).toEqual([
      ['assistant', undefined],
      ['tool', 'tc1'],
      ['assistant', undefined],
    ]);
    // The gap-closing result is the synthetic interrupted one; the stale late
    // result is dropped, so no second `tc1` record appears.
    expect(records[1]).toMatchObject({ message: { isError: true } });
  });

  it('pairs a tool result with a call that arrived outside an open step', () => {
    const records = projectReplayTimeline(
      timeline([
        loopEntry({ type: 'tool.call', stepUuid: 's0', toolCallId: 'tc1', name: 'Bash', args: { command: 'ls' } }),
        loopEntry({ type: 'tool.result', toolCallId: 'tc1', result: { output: 'file.txt' } }),
      ]),
    );
    // Live fold marks the call pending even with no open assistant, so the
    // result still produces a tool message on resume.
    expect(records).toEqual([
      expect.objectContaining({
        type: 'message',
        message: expect.objectContaining({ role: 'tool', toolCallId: 'tc1' }),
      }),
    ]);
  });

  it('keeps buffering the open step assistant across a compaction reset', () => {
    const records = projectReplayTimeline(
      timeline([
        loopEntry({ type: 'step.begin', uuid: 's1' }),
        loopEntry({ type: 'content.part', stepUuid: 's1', part: { type: 'text', text: 'before ' } }),
        { type: 'context.apply_compaction', payload: { summary: 'condensed', compactedCount: 3 } },
        loopEntry({ type: 'content.part', stepUuid: 's1', part: { type: 'text', text: 'after' } }),
        loopEntry({ type: 'step.end', uuid: 's1' }),
      ]),
    );
    expect(records).toEqual([
      expect.objectContaining({ type: 'compaction' }),
      expect.objectContaining({
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'before ' },
            { type: 'text', text: 'after' },
          ],
          toolCalls: [],
        },
      }),
    ]);
  });

  it('forgets pending calls at a compaction reset without synthesizing interrupted results', () => {
    const records = projectReplayTimeline(
      timeline([
        loopEntry({ type: 'step.begin', uuid: 's1' }),
        loopEntry({ type: 'tool.call', stepUuid: 's1', toolCallId: 'tc1', name: 'Bash' }),
        { type: 'context.apply_compaction', payload: { summary: 'condensed', compactedCount: 3 } },
        loopEntry({ type: 'tool.result', toolCallId: 'tc1', result: { output: 'late' } }),
        loopEntry({ type: 'step.end', uuid: 's1' }),
      ]),
    );
    // The late result pairs with nothing (live `resetFold` forgets pending the
    // same way); the assistant keeps the dangling call.
    expect(records).toEqual([
      expect.objectContaining({ type: 'compaction' }),
      expect.objectContaining({
        type: 'message',
        message: expect.objectContaining({
          role: 'assistant',
          toolCalls: [expect.objectContaining({ id: 'tc1' })],
        }),
      }),
    ]);
  });
});

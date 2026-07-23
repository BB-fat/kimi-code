// Ported from v1 agent-core test/agent/resume.test.ts (`limitAgentReplayByTurns`
// block, #1976) onto the v2 `PromptOrigin` union; adds the `task`-origin case
// that replaces v1's `background_task`.
import { describe, expect, it } from 'vitest';

import { limitAgentReplayByTurns } from '../../src/core/replay-turns';
import type { AgentReplayRecord, PromptOrigin } from '../../src/core/types';

describe('limitAgentReplayByTurns', () => {
  const replayMessage = (
    role: 'user' | 'assistant',
    text: string,
    origin?: PromptOrigin,
  ): AgentReplayRecord =>
    ({
      time: 0,
      type: 'message',
      message: { role, content: [{ type: 'text', text }], ...(origin ? { origin } : {}) },
    }) as AgentReplayRecord;

  it('returns the full replay when maxTurns is undefined', () => {
    const records = [replayMessage('user', 'a'), replayMessage('assistant', 'b')];
    expect(limitAgentReplayByTurns(records, undefined)).toBe(records);
  });

  it('returns an empty replay when maxTurns is zero', () => {
    expect(limitAgentReplayByTurns([replayMessage('user', 'a')], 0)).toEqual([]);
  });

  it('keeps the most recent user turns, treating system-triggered user messages as continuations', () => {
    const records = [
      replayMessage('user', 'first', { kind: 'user' }),
      replayMessage('assistant', 'one'),
      replayMessage('user', 'second', { kind: 'user' }),
      replayMessage('user', 'goal continuation', { kind: 'system_trigger', name: 'goal' }),
      replayMessage('assistant', 'two'),
      replayMessage('user', 'third', { kind: 'user' }),
      replayMessage('assistant', 'three'),
    ];
    expect(limitAgentReplayByTurns(records, 2)).toEqual(records.slice(2));
  });

  it('treats user-slash activations and shell command inputs as boundaries, but not their outputs', () => {
    const records = [
      replayMessage('user', 't1', { kind: 'user' }),
      replayMessage('user', '/skill', {
        kind: 'skill_activation',
        activationId: 'act-1',
        skillName: 'demo',
        trigger: 'user-slash',
      }),
      replayMessage('user', '!ls', { kind: 'shell_command', phase: 'input' }),
      replayMessage('user', 'ls output', { kind: 'shell_command', phase: 'output' }),
      replayMessage('user', 't2', { kind: 'user' }),
    ];
    expect(limitAgentReplayByTurns(records, 2)).toEqual(records.slice(2));
  });

  it('treats task results as continuations, not turn boundaries', () => {
    const records = [
      replayMessage('user', 't1', { kind: 'user' }),
      replayMessage('user', 'task finished', {
        kind: 'task',
        taskId: 'task-1',
        status: 'completed',
        notificationId: 'notif-1',
      }),
      replayMessage('assistant', 'done'),
      replayMessage('user', 't2', { kind: 'user' }),
    ];
    expect(limitAgentReplayByTurns(records, 1)).toEqual(records.slice(3));
  });

  it('treats goal continuation prompts as turn boundaries, but not other system triggers', () => {
    const rounds = (n: number): AgentReplayRecord[] =>
      Array.from({ length: n }, (_, i) => [
        replayMessage('user', 'Resume the active goal.', {
          kind: 'system_trigger',
          name: 'goal_continuation',
        }),
        replayMessage('assistant', `round ${i}`),
      ]).flat();
    const records = [
      replayMessage('user', '/goal ship it', { kind: 'user' }),
      ...rounds(15),
      replayMessage('user', 'cancelled reminder', {
        kind: 'system_trigger',
        name: 'goal_cancelled',
      }),
    ];
    const limited = limitAgentReplayByTurns(records, 10);
    // The /goal prompt and the first five continuation rounds fall away; the
    // trailing reminder stays attached to the last kept turn.
    expect(limited).toEqual(records.slice(11));
  });
});

import { describe, expect, it } from 'vitest';
import type { AppMessage, AppMessageContent, AppMessageRole } from '../api/types';
import { spineTreeFromMessages } from './spineTree';

let seq = 0;
function msg(role: AppMessageRole, content: AppMessageContent[]): AppMessage {
  seq += 1;
  return { id: `m${seq}`, sessionId: 's1', role, content, createdAt: '2026-01-01T00:00:00Z' };
}

function call(id: string, toolName: string, input: unknown): AppMessage {
  return msg('assistant', [{ type: 'toolUse', toolCallId: id, toolName, input }]);
}

function result(id: string, output: unknown, isError?: boolean): AppMessage {
  return msg('tool', [{ type: 'toolResult', toolCallId: id, output, isError }]);
}

/** Core's real accepted receipt (ACCEPTED_OUTPUT in agent-core-v2's
 *  controlResult.ts). */
const ACCEPTED_RECEIPT = 'accepted — commits after this step completes';
const accepted = (id: string): AppMessage => result(id, ACCEPTED_RECEIPT);

describe('spineTreeFromMessages', () => {
  it('returns [] for a transcript without spine calls', () => {
    expect(spineTreeFromMessages([])).toEqual([]);
    expect(
      spineTreeFromMessages([
        call('t1', 'TodoList', { todos: [{ title: 'x', status: 'pending' }] }),
        result('t1', 'ok'),
      ]),
    ).toEqual([]);
  });

  it('opens a root node flagged active', () => {
    const tree = spineTreeFromMessages([call('t1', 'spine_open', { summary: 'task A' }), accepted('t1')]);
    expect(tree).toEqual([{ title: 'task A', status: 'in_progress', active: true, children: [] }]);
  });

  it('parses string tool input', () => {
    const tree = spineTreeFromMessages([
      call('t1', 'spine_open', JSON.stringify({ summary: 'task A' })),
      accepted('t1'),
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.title).toBe('task A');
  });

  it('nests children under the cursor and closes via spine_close', () => {
    const tree = spineTreeFromMessages([
      call('t1', 'spine_open', { summary: 'A' }),
      accepted('t1'),
      call('t2', 'spine_open', { summary: 'B' }),
      accepted('t2'),
      call('t3', 'spine_close', { memory: 'done B' }),
      accepted('t3'),
    ]);
    expect(tree).toEqual([
      {
        title: 'A',
        status: 'in_progress',
        active: true,
        children: [{ title: 'B', status: 'done', children: [] }],
      },
    ]);
  });

  it('spine_next closes the cursor and opens a sibling', () => {
    const tree = spineTreeFromMessages([
      call('t1', 'spine_open', { summary: 'A' }),
      accepted('t1'),
      call('t2', 'spine_open', { summary: 'B' }),
      accepted('t2'),
      call('t3', 'spine_next', { summary: 'C', memory: 'm' }),
      accepted('t3'),
    ]);
    expect(tree).toEqual([
      {
        title: 'A',
        status: 'in_progress',
        children: [
          { title: 'B', status: 'done', children: [] },
          { title: 'C', status: 'in_progress', active: true, children: [] },
        ],
      },
    ]);
  });

  it('keeps the all-done tree after the last close (root epoch)', () => {
    const tree = spineTreeFromMessages([
      call('t1', 'spine_open', { summary: 'A' }),
      accepted('t1'),
      call('t2', 'spine_close', { memory: 'm' }),
      accepted('t2'),
    ]);
    expect(tree).toEqual([{ title: 'A', status: 'done', children: [] }]);
  });

  it('keeps closed history across epochs', () => {
    const tree = spineTreeFromMessages([
      call('t1', 'spine_open', { summary: 'A' }),
      accepted('t1'),
      call('t2', 'spine_close', { memory: 'm' }),
      accepted('t2'),
      call('t3', 'spine_open', { summary: 'B' }),
      accepted('t3'),
    ]);
    expect(tree).toEqual([
      { title: 'A', status: 'done', children: [] },
      { title: 'B', status: 'in_progress', active: true, children: [] },
    ]);
  });

  it('ignores rejected transitions (error results)', () => {
    expect(
      spineTreeFromMessages([
        call('t1', 'spine_open', { summary: 'A' }),
        result('t1', 'spine_open failed: summary required', true),
      ]),
    ).toEqual([]);
    expect(
      spineTreeFromMessages([
        call('t1', 'spine_open', { summary: 'A' }),
        result('t1', 'rejected: another transition pending', true),
      ]),
    ).toEqual([]);
  });

  it('applies non-error results regardless of output shape', () => {
    const tree = spineTreeFromMessages([
      call('t1', 'spine_open', { summary: 'A' }),
      result('t1', [{ type: 'text', text: ACCEPTED_RECEIPT }]),
    ]);
    expect(tree).toHaveLength(1);
  });

  it('ignores malformed calls: missing summary, next/close without a cursor', () => {
    expect(
      spineTreeFromMessages([
        call('t1', 'spine_next', { summary: 'A', memory: 'm' }),
        accepted('t1'),
        call('t2', 'spine_close', { memory: 'm' }),
        accepted('t2'),
        call('t3', 'spine_open', {}),
        accepted('t3'),
      ]),
    ).toEqual([]);
  });

  it('ignores results for unknown or already-settled call ids', () => {
    const tree = spineTreeFromMessages([
      result('nope', ACCEPTED_RECEIPT),
      call('t1', 'spine_open', { summary: 'A' }),
      accepted('t1'),
      accepted('t1'), // duplicate — the pending entry was already consumed
      call('t2', 'Read', { path: 'x' }),
      result('t2', ACCEPTED_RECEIPT),
    ]);
    expect(tree).toEqual([{ title: 'A', status: 'in_progress', active: true, children: [] }]);
  });
});

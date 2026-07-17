import { describe, expect, it } from 'vitest';
import type { AppMessage, AppMessageContent, AppMessageRole, AppSpineTreeNode, AppSpineTreeSeed } from '../api/types';
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

// ---------------------------------------------------------------------------
// Snapshot seed continuation
//
// Wire messages ids embed the zero-padded transcript index
// (`msg_<sid>_<index>`); the seed tests use that grammar so the watermark
// comparison is exercised. `msg()`/`call()`/`accepted()` above use bare `mN`
// ids, which sit outside the grammar and always replay (like live ULIDs).
// ---------------------------------------------------------------------------

function wireMsg(index: number, role: AppMessageRole, content: AppMessageContent[]): AppMessage {
  return {
    id: `msg_s1_${String(index).padStart(6, '0')}`,
    sessionId: 's1',
    role,
    content,
    createdAt: '2026-01-01T00:00:00Z',
  };
}

function wireCall(index: number, id: string, toolName: string, input: unknown): AppMessage {
  return wireMsg(index, 'assistant', [{ type: 'toolUse', toolCallId: id, toolName, input }]);
}

function wireAccepted(index: number, id: string): AppMessage {
  return wireMsg(index, 'tool', [{ type: 'toolResult', toolCallId: id, output: ACCEPTED_RECEIPT }]);
}

function wireUser(index: number, text: string): AppMessage {
  return wireMsg(index, 'user', [{ type: 'text', text }]);
}

function seedNode(partial: Partial<AppSpineTreeNode> & Pick<AppSpineTreeNode, 'id' | 'title'>): AppSpineTreeNode {
  return { parentId: null, memory: '', tokenCost: 0, status: 'closed', error: null, ...partial };
}

function flattenTitles(nodes: ReturnType<typeof spineTreeFromMessages>): string[] {
  return nodes.flatMap((n) => [n.title, ...flattenTitles(n.children)]);
}

describe('spineTreeFromMessages with a snapshot seed', () => {
  it('seeds early nodes and continues folding live transitions past the watermark (>100 messages)', () => {
    // Transcript positions 1..4 hold the spine transitions for the early
    // tree; 136 filler messages push them far outside any 100-message window.
    // The seed carries exactly those early nodes; the covered messages must
    // NOT be re-applied, and the live continuation must attach at the seed
    // cursor.
    const messages: AppMessage[] = [
      wireCall(1, 't1', 'spine_open', { summary: 'early root' }),
      wireAccepted(2, 't1'),
      wireCall(3, 't2', 'spine_close', { memory: 'm' }),
      wireAccepted(4, 't2'),
      ...Array.from({ length: 136 }, (_, i) => wireUser(5 + i, `filler ${i}`)),
      wireCall(141, 't3', 'spine_open', { summary: 'live task' }),
      wireAccepted(142, 't3'),
    ];
    const seed: AppSpineTreeSeed = {
      coveredThroughId: 'msg_s1_000140',
      nodes: [
        seedNode({ id: 'n1', title: 'early root' }),
        seedNode({ id: 'n2', title: 'second root', status: 'active' }),
      ],
    };
    expect(messages.length).toBeGreaterThan(100);
    expect(spineTreeFromMessages(messages, seed)).toEqual([
      { title: 'early root', status: 'done', children: [] },
      {
        title: 'second root',
        status: 'in_progress',
        children: [{ title: 'live task', status: 'in_progress', active: true, children: [] }],
      },
    ]);
  });

  it('falls back to the plain window replay when the seed is absent', () => {
    const messages = [call('t1', 'spine_open', { summary: 'A' }), accepted('t1')];
    expect(spineTreeFromMessages(messages, undefined)).toEqual(spineTreeFromMessages(messages));
  });

  it('never replays transitions from older pages at or below the watermark', () => {
    const seed: AppSpineTreeSeed = {
      coveredThroughId: 'msg_s1_000150',
      nodes: [seedNode({ id: 'x1', title: 'seeded task' })],
    };
    const messages: AppMessage[] = [
      // A page loaded from far before the window: replaying it would both
      // resurrect covered history and duplicate the seed's own coverage.
      wireCall(10, 'o1', 'spine_open', { summary: 'paged task' }),
      wireAccepted(11, 'o1'),
      wireCall(12, 'o2', 'spine_close', { memory: 'm' }),
      wireAccepted(13, 'o2'),
      // Exactly at the watermark: covered by the seed, strictly skipped.
      wireCall(150, 'b1', 'spine_open', { summary: 'boundary task' }),
      // Live continuation: strictly newer than the watermark.
      wireCall(151, 'n1', 'spine_open', { summary: 'fresh task' }),
      wireAccepted(152, 'n1'),
    ];
    const tree = spineTreeFromMessages(messages, seed);
    expect(flattenTitles(tree)).toEqual(['seeded task', 'fresh task']);
    expect(tree).toEqual([
      { title: 'seeded task', status: 'done', children: [] },
      { title: 'fresh task', status: 'in_progress', active: true, children: [] },
    ]);
  });

  it('replays from scratch when coveredThroughId is null', () => {
    const messages: AppMessage[] = [
      wireCall(1, 't1', 'spine_open', { summary: 'A' }),
      wireAccepted(2, 't1'),
      wireCall(3, 't2', 'spine_close', { memory: 'm' }),
      wireAccepted(4, 't2'),
    ];
    // Null watermark (empty transcript at snapshot time): every message
    // replays, exactly the no-seed behavior — and seed nodes are kept.
    expect(spineTreeFromMessages(messages, { coveredThroughId: null, nodes: [] })).toEqual(
      spineTreeFromMessages(messages),
    );
    expect(
      spineTreeFromMessages(messages, {
        coveredThroughId: null,
        nodes: [seedNode({ id: 'p1', title: 'seed node' })],
      }),
    ).toEqual([
      { title: 'seed node', status: 'done', children: [] },
      { title: 'A', status: 'done', children: [] },
    ]);
  });

  it('is idempotent: a repeated batch cannot duplicate nodes', () => {
    const seed: AppSpineTreeSeed = {
      coveredThroughId: 'msg_s1_000150',
      nodes: [seedNode({ id: 's1', title: 'seeded' })],
    };
    const batch = [wireCall(151, 't1', 'spine_open', { summary: 'live' }), wireAccepted(152, 't1')];
    const once = spineTreeFromMessages(batch, seed);
    expect(spineTreeFromMessages([...batch, ...batch], seed)).toEqual(once);
    expect(spineTreeFromMessages(batch, seed)).toEqual(once);
    expect(once).toEqual([
      { title: 'seeded', status: 'done', children: [] },
      { title: 'live', status: 'in_progress', active: true, children: [] },
    ]);
  });

  it('keeps folding live messages whose ids carry no transcript index (no freeze after seed install)', () => {
    const seed: AppSpineTreeSeed = {
      coveredThroughId: 'msg_s1_000150',
      nodes: [seedNode({ id: 's1', title: 'seeded root', status: 'active' })],
    };
    const liveCall: AppMessage = {
      id: 'msg_ulid01hzyx',
      sessionId: 's1',
      role: 'assistant',
      content: [{ type: 'toolUse', toolCallId: 't9', toolName: 'spine_open', input: { summary: 'streamed task' } }],
      createdAt: '2026-01-01T00:00:00Z',
    };
    const liveResult: AppMessage = {
      id: 'msg_ulid01hz-2',
      sessionId: 's1',
      role: 'tool',
      content: [{ type: 'toolResult', toolCallId: 't9', output: ACCEPTED_RECEIPT }],
      createdAt: '2026-01-01T00:00:00Z',
    };
    expect(spineTreeFromMessages([liveCall, liveResult], seed)).toEqual([
      {
        title: 'seeded root',
        status: 'in_progress',
        children: [{ title: 'streamed task', status: 'in_progress', active: true, children: [] }],
      },
    ]);
  });

  it('reconstructs the cursor chain from active seed nodes for spine_next', () => {
    const seed: AppSpineTreeSeed = {
      coveredThroughId: 'msg_s1_000150',
      nodes: [
        seedNode({ id: 'a', title: 'A', status: 'active' }),
        seedNode({ id: 'b', parentId: 'a', title: 'B', status: 'active' }),
        seedNode({ id: 'c', parentId: 'b', title: 'C' }),
      ],
    };
    const messages = [
      wireCall(151, 't1', 'spine_next', { summary: 'D', memory: 'm' }),
      wireAccepted(152, 't1'),
    ];
    expect(spineTreeFromMessages(messages, seed)).toEqual([
      {
        title: 'A',
        status: 'in_progress',
        children: [
          {
            title: 'B',
            status: 'done',
            children: [{ title: 'C', status: 'done', children: [] }],
          },
          // spine_next closes the cursor (B) and opens a SIBLING under A.
          { title: 'D', status: 'in_progress', active: true, children: [] },
        ],
      },
    ]);
  });

  it('projects canceled seed nodes as done history', () => {
    const seed: AppSpineTreeSeed = {
      coveredThroughId: 'msg_s1_000001',
      nodes: [seedNode({ id: 'c', title: 'killed', status: 'canceled', error: 'superseded' })],
    };
    expect(spineTreeFromMessages([], seed)).toEqual([
      { title: 'killed', status: 'done', children: [] },
    ]);
  });

  it('ignores a seed whose coveredThroughId sits outside the wire id grammar', () => {
    const messages = [call('t1', 'spine_open', { summary: 'A' }), accepted('t1')];
    const seed: AppSpineTreeSeed = {
      coveredThroughId: 'not-a-wire-id',
      nodes: [seedNode({ id: 's', title: 'seeded' })],
    };
    expect(spineTreeFromMessages(messages, seed)).toEqual([
      { title: 'A', status: 'in_progress', active: true, children: [] },
    ]);
  });
});

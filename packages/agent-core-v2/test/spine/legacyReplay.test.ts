/**
 * `spine` domain (L4) — P3.5 regression net: replay REAL pre-rewrite session
 * wire logs and diff the op-replayed `SpineModel` state against the pure
 * derivation (`deriveSpineState` over the restored `contextMemory` stream).
 *
 * Fixtures (`./fixtures/*.jsonl`) are sanitized real v2 wire logs from local
 * pre-derivation sessions (2026-07-31 sanitization, one-off script kept out of
 * tree): record count/order untouched, spine op payloads and message-side
 * spine_* args mapped through one global dictionary to deterministic
 * placeholders (so op-side == message-side exactly when the raw strings were
 * equal), accepted receipts kept verbatim, all other free text placeholdered,
 * blobref media neutralized to inline text parts. Sources:
 *   - legacy-open-close.jsonl   0feff1ef (2026-07-14 build, open/close chain)
 *   - legacy-next.jsonl         2fddef08 (2026-07-14 build, spine.next ×2, ends mid-session)
 *   - legacy-receipt-anchor.jsonl 01KX07W6 (2026-07-08 build, pre f0c56f31b)
 *   - legacy-undo-divergence.jsonl 2f793f68 (2026-07-16 build, undo ×7 +
 *     truncate_repair ×4 + spine.next; tail cut right after the last
 *     truncate_repair — a prefix cut never shifts message indices)
 *   - legacy-root-compact.jsonl mremv61a (2026-07-10 build, spine.root_compact
 *     ×1 → 2 root epochs). The only other real root_compact sample found
 *     (mre987c4, 5 epochs) was rejected: 34 MB and a pre-fix build. Further
 *     synthetic root_compact coverage lives in `compaction.test.ts`.
 *
 * ASSERTION GROUPS — the op-replay world and the derivation agree on real
 * logs only up to three documented historical semantic differences (verified
 * 2026-07-31 against 12 real sessions, none are derivation defects):
 *
 *  1. Span anchors (f0c56f31b, 2026-07-13). The legacy commit path persisted
 *     close/next span ends at the transition's RECEIPT index (and some builds
 *     anchored opens at carrier+1); f0c56f31b moved close/next to carrier−1
 *     so the carrier and its receipt stay visible in the parent context.
 *     Sessions written by older builds replay with the old anchors — the
 *     receipt-anchor group pins the exact relation instead of equality.
 *  2. Stored memory form (P5, plan/spine-v3-alignment.md). The legacy commit
 *     path persisted `assembleMemoryBody()` output (## User Message / ##
 *     Child Memory sections), and f0c56f31b's interrupted-transition commit
 *     could persist a pending body whose accepted receipt never landed. The
 *     derivation keeps the model-written close/next body verbatim (the fold
 *     re-materializes user requests and child slots at read time). Where a
 *     fixture exhibits this, the differing memory values are pinned exactly.
 *  3. Witness-removing undos (the derivation's documented contract: "a
 *     transition the stream does not fully witness is not a transition").
 *     The op world kept frozen nodes for unwitnessed transitions
 *     (truncate_repair voids/restarts spans); the derivation drops them and
 *     re-derives ids/parents from the surviving stream. The undo-divergence
 *     group pins both topologies and their documented relationship exactly.
 *
 * TOLERATED DRIFT (only): `baselineTokens` / `finalTokens` are not in the
 * message stream and `archivePath` is deterministically re-derived, so the
 * derivation never carries them; the exact-match group asserts they are
 * absent on the derived side while present in the replayed legacy ops.
 *
 * Every fixture additionally asserts: restore reports ZERO unknown/malformed
 * record skips (the "legacy op definitions stay registered" acceptance), all
 * span indices stay inside the restored message bounds, and the open stack is
 * self-consistent (ids exist, are open, and chain through `children`).
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  resetUnexpectedErrorHandler,
  setUnexpectedErrorHandler,
} from '#/_base/errors/unexpectedError';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { SPINE_TOOL_CLOSE } from '#/agent/spine/spine';
import type { SpineState } from '#/agent/spine/spineOps';
import type { WireRecord } from '#/wire/record';
import {
  deriveSpineState,
  IAgentContextMemoryService,
  IWireService,
  SpineModel,
  SPINE_VOID_OPENED_AT,
} from '#/index';

import {
  InMemoryWireRecordPersistence,
  testAgent,
  wireRecordPersistenceServices,
} from '../harness';

interface RestoredFixture {
  readonly replayed: SpineState;
  readonly derived: SpineState;
  readonly messages: readonly ContextMessage[];
  readonly unexpected: readonly unknown[];
}

function loadFixtureRecords(name: string): WireRecord[] {
  const path = new URL(`./fixtures/${name}.jsonl`, import.meta.url);
  const records: WireRecord[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue;
    records.push(JSON.parse(line) as WireRecord);
  }
  return records;
}

async function restoreFixture(name: string): Promise<RestoredFixture> {
  const unexpected: unknown[] = [];
  setUnexpectedErrorHandler((err) => unexpected.push(err));
  try {
    const ctx = testAgent(
      wireRecordPersistenceServices(new InMemoryWireRecordPersistence(loadFixtureRecords(name))),
    );
    await ctx.restorePersisted();
    const messages = ctx.get(IAgentContextMemoryService).get();
    return {
      replayed: ctx.get(IWireService).getModel(SpineModel) as SpineState,
      derived: deriveSpineState(messages),
      messages,
      unexpected,
    };
  } finally {
    resetUnexpectedErrorHandler();
  }
}

/** The legacy-op acceptance: nothing in a real old log may be skipped. */
function expectZeroSkips(unexpected: readonly unknown[]): void {
  expect(unexpected.map(String)).toEqual([]);
}

function expectSpanInvariants(state: SpineState, messageCount: number): void {
  for (const node of Object.values(state.nodes)) {
    // A voided span (openedAt === SPINE_VOID_OPENED_AT) is fold-excluded and
    // kept for reference only: its stale closedAt may index messages a prefix
    // truncation cut away, so bounds apply to live spans only.
    if (node.openedAt === SPINE_VOID_OPENED_AT) continue;
    expect(node.openedAt, `${node.id} openedAt`).toBeGreaterThanOrEqual(0);
    expect(node.openedAt, `${node.id} openedAt`).toBeLessThan(messageCount);
    if (node.closedAt !== undefined) {
      expect(node.closedAt, `${node.id} closedAt`).toBeGreaterThanOrEqual(0);
      expect(node.closedAt, `${node.id} closedAt`).toBeLessThan(messageCount);
      expect(node.closedAt, `${node.id} span`).toBeGreaterThanOrEqual(node.openedAt);
    }
  }
  expect(state.openStack.length).toBeGreaterThan(0);
  expect(state.openStack[0]).toBe(String(state.rootEpoch));
  for (let i = 0; i < state.openStack.length; i++) {
    const id = state.openStack[i]!;
    const node = state.nodes[id];
    expect(node, `openStack id ${id}`).toBeDefined();
    expect(node?.closedAt, `openStack id ${id} stays open`).toBeUndefined();
    if (i > 0) {
      const parent = state.nodes[state.openStack[i - 1]!];
      expect(parent?.children, `openStack ${state.openStack[i - 1]!} → ${id}`).toContain(id);
    }
  }
}

interface Span {
  readonly openedAt: number;
  readonly closedAt?: number;
}

function expectSpans(state: SpineState, spans: Readonly<Record<string, Span>>): void {
  expect(Object.keys(state.nodes).sort()).toEqual(Object.keys(spans).sort());
  for (const [id, span] of Object.entries(spans)) {
    const node = state.nodes[id];
    expect(node?.openedAt, `${id} openedAt`).toBe(span.openedAt);
    expect(node?.closedAt, `${id} closedAt`).toBe(span.closedAt);
  }
}

function parentOf(state: SpineState, id: string): string | null {
  for (const [candidate, node] of Object.entries(state.nodes)) {
    if (node.children.includes(id)) return candidate;
  }
  return null;
}

describe('Spine legacy wire replay (exact-match group)', () => {
  /**
   * Sessions written by the final op-based build (post-f0c56f31b anchors,
   * verbatim memory) with no witness-removing undo: the derivation must
   * reproduce the op-replayed tree field by field.
   */
  function expectSameTree(replayed: SpineState, derived: SpineState): void {
    expect(Object.keys(derived.nodes).sort()).toEqual(Object.keys(replayed.nodes).sort());
    for (const [id, r] of Object.entries(replayed.nodes)) {
      const d = derived.nodes[id]!;
      expect(d.summary, `${id} summary`).toBe(r.summary);
      expect(d.openedAt, `${id} openedAt`).toBe(r.openedAt);
      expect(d.closedAt, `${id} closedAt`).toBe(r.closedAt);
      expect(d.memory, `${id} memory`).toBe(r.memory);
      expect(d.children, `${id} children`).toEqual(r.children);
      // Tolerated drift: token gauges and archive paths are not derivable.
      expect(d.baselineTokens, `${id} baselineTokens`).toBeUndefined();
      expect(d.finalTokens, `${id} finalTokens`).toBeUndefined();
      expect(d.archivePath, `${id} archivePath`).toBeUndefined();
    }
    expect(derived.openStack).toEqual(replayed.openStack);
    expect(derived.rootEpoch).toBe(replayed.rootEpoch);
    expect(derived.epochStartAt).toBe(replayed.epochStartAt);
    expect(derived.epochMemoryAt).toBe(replayed.epochMemoryAt);
  }

  it('legacy-open-close: 47-transition-free open/close chain replays identically', async () => {
    const { replayed, derived, messages, unexpected } = await restoreFixture('legacy-open-close');
    expectZeroSkips(unexpected);
    expect(messages.length).toBe(34);
    expect(Object.keys(replayed.nodes).length).toBe(5);
    // The tolerated drift is real: the legacy ops carry token gauges.
    expect(Object.values(replayed.nodes).some((n) => n.baselineTokens !== undefined)).toBe(true);
    expectSameTree(replayed, derived);
    expectSpanInvariants(replayed, messages.length);
    expectSpanInvariants(derived, messages.length);
  });

  it('legacy-next: spine.next siblings and an open cursor replay identically', async () => {
    const { replayed, derived, messages, unexpected } = await restoreFixture('legacy-next');
    expectZeroSkips(unexpected);
    expect(messages.length).toBe(41);
    expect(Object.keys(replayed.nodes).length).toBe(5);
    // Mid-session snapshot: the cursor node is still open.
    expect(replayed.openStack).toEqual(['1', '1.1', '1.1.3']);
    expect(replayed.nodes['1.1.3']?.closedAt).toBeUndefined();
    expectSameTree(replayed, derived);
    expectSpanInvariants(replayed, messages.length);
    expectSpanInvariants(derived, messages.length);
  });
});

describe('Spine legacy wire replay (receipt-anchor group)', () => {
  /**
   * The index of the first tool message answering the spine_close call whose
   * carrier sits at `carrierIndex` — i.e. where a pre-f0c56f31b build
   * anchored the span end.
   */
  function closeReceiptIndex(messages: readonly ContextMessage[], carrierIndex: number): number {
    const carrier = messages[carrierIndex];
    expect(carrier?.role, `carrier at ${carrierIndex}`).toBe('assistant');
    const call = carrier?.toolCalls.find((c) => c.name === SPINE_TOOL_CLOSE);
    expect(call, `spine_close call at ${carrierIndex}`).toBeDefined();
    for (let i = carrierIndex + 1; i < messages.length; i++) {
      const message = messages[i]!;
      if (message.role === 'tool' && message.toolCallId === call!.id) return i;
    }
    throw new Error(`no receipt found for the close call at ${carrierIndex}`);
  }

  it('legacy-receipt-anchor: tree identical, closedAt pinned to the receipt index', async () => {
    const { replayed, derived, messages, unexpected } = await restoreFixture('legacy-receipt-anchor');
    expectZeroSkips(unexpected);
    expect(messages.length).toBe(278);
    expect(Object.keys(replayed.nodes).length).toBe(49);

    // Tree shape and content agree everywhere — only span ends drift.
    expect(Object.keys(derived.nodes).sort()).toEqual(Object.keys(replayed.nodes).sort());
    let closedCount = 0;
    for (const [id, d] of Object.entries(derived.nodes)) {
      const r = replayed.nodes[id]!;
      expect(r.summary, `${id} summary`).toBe(d.summary);
      expect(r.children, `${id} children`).toEqual(d.children);
      expect(r.memory, `${id} memory`).toBe(d.memory);
      expect(r.openedAt, `${id} openedAt`).toBe(d.openedAt);
      if (d.closedAt === undefined) continue;
      closedCount++;
      // Pre-f0c56f31b anchor: the persisted span end IS the receipt index;
      // the derivation ends the span right before the carrier instead.
      const carrier = d.closedAt + 1;
      expect(r.closedAt, `${id} closedAt anchors at the receipt`).toBe(
        closeReceiptIndex(messages, carrier),
      );
      expect(r.closedAt, `${id} drift`).toBeGreaterThan(d.closedAt);
    }
    expect(closedCount).toBe(47);
    expect(derived.openStack).toEqual(replayed.openStack);
    expectSpanInvariants(replayed, messages.length);
    expectSpanInvariants(derived, messages.length);
  });

  it('legacy-root-compact: two epochs identical, spans and one memory pinned', async () => {
    const { replayed, derived, messages, unexpected } = await restoreFixture('legacy-root-compact');
    expectZeroSkips(unexpected);
    expect(messages.length).toBe(80);

    // The root_compact acceptance: the derivation reconstructs the epoch
    // boundary from the compaction-summary message exactly as the persisted
    // spine.root_compact op replayed it.
    expect(derived.rootEpoch).toBe(2);
    expect(derived.epochStartAt).toBe(71);
    expect(derived.epochMemoryAt).toBe(70);
    expect(replayed.rootEpoch).toBe(2);
    expect(replayed.epochStartAt).toBe(71);
    expect(replayed.epochMemoryAt).toBe(70);
    expect(derived.openStack).toEqual(['2', '2.1']);
    expect(replayed.openStack).toEqual(['2', '2.1']);

    // Tree shape and content agree (ids, summaries, children).
    expect(Object.keys(derived.nodes).sort()).toEqual(Object.keys(replayed.nodes).sort());
    for (const [id, d] of Object.entries(derived.nodes)) {
      const r = replayed.nodes[id]!;
      expect(r.summary, `${id} summary`).toBe(d.summary);
      expect(r.children, `${id} children`).toEqual(d.children);
    }

    // Pre-f0c56f31b span anchors (this 2026-07-10 build also anchored nested
    // opens late): both span tables pinned exactly.
    expectSpans(replayed, {
      1: { openedAt: SPINE_VOID_OPENED_AT },
      2: { openedAt: SPINE_VOID_OPENED_AT },
      '1.1': { openedAt: 0 },
      '1.1.1': { openedAt: 1, closedAt: 65 },
      '1.1.1.1': { openedAt: 4, closedAt: 16 },
      '1.1.1.2': { openedAt: 17, closedAt: 36 },
      '1.1.1.3': { openedAt: 37, closedAt: 50 },
      '1.1.1.4': { openedAt: 51, closedAt: 61 },
      '2.1': { openedAt: 71 },
    });
    expectSpans(derived, {
      1: { openedAt: SPINE_VOID_OPENED_AT },
      2: { openedAt: SPINE_VOID_OPENED_AT },
      '1.1': { openedAt: 0 },
      '1.1.1': { openedAt: 1, closedAt: 63 },
      '1.1.1.1': { openedAt: 4, closedAt: 14 },
      '1.1.1.2': { openedAt: 15, closedAt: 34 },
      '1.1.1.3': { openedAt: 35, closedAt: 48 },
      '1.1.1.4': { openedAt: 49, closedAt: 58 },
      '2.1': { openedAt: 71 },
    });

    // P5 memory-form difference on the one node with closed children: the
    // legacy op stored an assembleMemoryBody() composite (from an interrupted
    // pending commit); the derivation keeps the surviving close call's body
    // verbatim. Values are the sanitization dictionary's placeholders.
    expect(replayed.nodes['1.1.1']?.memory).toBe('memory_88');
    expect(derived.nodes['1.1.1']?.memory).toBe('memory_87');
    for (const id of ['1.1.1.1', '1.1.1.2', '1.1.1.3', '1.1.1.4']) {
      expect(derived.nodes[id]?.memory, `${id} memory`).toBe(replayed.nodes[id]?.memory);
    }

    expectSpanInvariants(replayed, messages.length);
    expectSpanInvariants(derived, messages.length);
  });
});

describe('Spine legacy wire replay (undo-divergence group)', () => {
  it('legacy-undo-divergence: both topologies and their documented relationship', async () => {
    const { replayed, derived, messages, unexpected } = await restoreFixture('legacy-undo-divergence');
    expectZeroSkips(unexpected);
    expect(messages.length).toBe(592);
    expectSpanInvariants(replayed, messages.length);
    expectSpanInvariants(derived, messages.length);

    // ---- The op-replay world (frozen at crash time): 32 nodes. ----
    expect(Object.keys(replayed.nodes).length).toBe(32);
    expect(replayed.openStack).toEqual(['1', '1.1', '1.1.28']);
    expect(replayed.nodes['1']?.children).toEqual(['1.1']);
    const replayedWorkChildren = replayed.nodes['1.1']?.children ?? [];
    expect(replayedWorkChildren.length).toBe(28);
    expect(replayedWorkChildren.slice(0, 8)).toEqual([
      '1.1.1', '1.1.2', '1.1.3', '1.1.4', '1.1.5', '1.1.6', '1.1.7', '1.1.8',
    ]);
    expect(replayedWorkChildren).toContain('1.1.9');
    expect(replayedWorkChildren.at(-1)).toBe('1.1.28');
    // truncate_repair voided the spans whose witnesses the first and last
    // undos removed (openedAt = SPINE_VOID_OPENED_AT, kept for reference).
    expect(replayed.nodes['1.1.2']?.openedAt).toBe(SPINE_VOID_OPENED_AT);
    expect(replayed.nodes['1.1.2']?.closedAt).toBe(41);
    expect(replayed.nodes['1.1.27']?.openedAt).toBe(SPINE_VOID_OPENED_AT);
    expect(replayed.nodes['1.1.27']?.closedAt).toBe(601);
    // The nesting the second undo made unwitnessed: 1.1.8 → {1.1.8.1, 1.1.8.2}.
    expect(replayed.nodes['1.1.8']?.children).toEqual(['1.1.8.1', '1.1.8.2']);
    expect(replayed.nodes['1.1.8']?.openedAt).toBe(160);
    expect(replayed.nodes['1.1.8']?.closedAt).toBe(180);
    expect(replayed.nodes['1.1.8.1']?.openedAt).toBe(161);
    expect(replayed.nodes['1.1.8.1']?.closedAt).toBe(167);
    expect(replayed.nodes['1.1.8.2']?.openedAt).toBe(172);
    expect(replayed.nodes['1.1.8.2']?.closedAt).toBe(177);
    // The node whose open the third undo unwitnessed: kept frozen by the ops.
    expect(replayed.nodes['1.1.9']?.openedAt).toBe(181);
    expect(replayed.nodes['1.1.9']?.closedAt).toBe(181);

    // ---- The derivation (surviving-stream truth): exact topology. ----
    const DERIVED_TOPOLOGY: Readonly<Record<string, { parent: string | null } & Span>> = {
      1: { parent: null, openedAt: SPINE_VOID_OPENED_AT },
      '1.1': { parent: '1', openedAt: 0, closedAt: 181 },
      '1.1.1': { parent: '1.1', openedAt: 1, closedAt: 12 },
      '1.1.2': { parent: '1.1', openedAt: 17, closedAt: 46 },
      '1.1.3': { parent: '1.1', openedAt: 51, closedAt: 88 },
      '1.1.4': { parent: '1.1', openedAt: 102, closedAt: 115 },
      '1.1.5': { parent: '1.1', openedAt: 120, closedAt: 129 },
      '1.1.6': { parent: '1.1', openedAt: 134, closedAt: 156 },
      '1.1.7': { parent: '1.1', openedAt: 161, closedAt: 167 },
      '1.1.8': { parent: '1.1', openedAt: 172, closedAt: 177 },
      '1.2': { parent: '1', openedAt: 182, closedAt: 198 },
      '1.3': { parent: '1', openedAt: 205, closedAt: 209 },
      '1.4': { parent: '1', openedAt: 214, closedAt: 226 },
      '1.5': { parent: '1', openedAt: 231, closedAt: 262 },
      '1.6': { parent: '1', openedAt: 267, closedAt: 274 },
      '1.7': { parent: '1', openedAt: 279, closedAt: 284 },
      '1.8': { parent: '1', openedAt: 289, closedAt: 291 },
      '1.9': { parent: '1', openedAt: 296, closedAt: 304 },
      '1.10': { parent: '1', openedAt: 309, closedAt: 342 },
      '1.11': { parent: '1', openedAt: 347, closedAt: 375 },
      '1.12': { parent: '1', openedAt: 381, closedAt: 390 },
      '1.13': { parent: '1', openedAt: 397, closedAt: 405 },
      '1.14': { parent: '1', openedAt: 415, closedAt: 423 },
      '1.15': { parent: '1', openedAt: 449, closedAt: 460 },
      '1.16': { parent: '1', openedAt: 461, closedAt: 526 },
      '1.17': { parent: '1', openedAt: 529, closedAt: 564 },
      '1.18': { parent: '1', openedAt: 571, closedAt: 580 },
      '1.19': { parent: '1', openedAt: 590 },
    };
    expect(Object.keys(derived.nodes).sort()).toEqual(Object.keys(DERIVED_TOPOLOGY).sort());
    for (const [id, expected] of Object.entries(DERIVED_TOPOLOGY)) {
      const node = derived.nodes[id];
      expect(node?.openedAt, `${id} openedAt`).toBe(expected.openedAt);
      expect(node?.closedAt, `${id} closedAt`).toBe(expected.closedAt);
      expect(parentOf(derived, id), `${id} parent`).toBe(expected.parent);
    }
    expect(derived.openStack).toEqual(['1', '1.19']);
    expect(derived.rootEpoch).toBe(1);
    expect(derived.epochStartAt).toBe(0);
    expect(derived.epochMemoryAt).toBeUndefined();

    // ---- The documented relationship between the two worlds. ----
    // Undo #3 unwitnessed 1.1.9's open: the surviving spine.next closes the
    // derivation's cursor (the startup node) with 1.1.9's redirect memory and
    // re-parents everything after it to the root epoch.
    expect(derived.nodes['1.1.9']).toBeUndefined();
    expect(derived.nodes['1.1.8.1']).toBeUndefined();
    expect(derived.nodes['1.1.27']).toBeUndefined();
    expect(derived.nodes['1.1']?.memory).toBe(replayed.nodes['1.1.9']?.memory);
    expect(derived.nodes['1.2']?.summary).toBe(replayed.nodes['1.1.10']?.summary);
    // Undo #1 unwitnessed the first "1.1.2": the derivation reuses the id for
    // the redo the ops numbered 1.1.3 (the whole 1.1.x series shifts by one).
    expect(derived.nodes['1.1.2']?.summary).toBe(replayed.nodes['1.1.3']?.summary);
    // Undo #2 unwitnessed 1.1.8's open: nested 1.1.8.1/1.1.8.2 flatten into
    // the derivation's sibling 1.1.7/1.1.8.
    expect(derived.nodes['1.1.7']?.summary).toBe(replayed.nodes['1.1.8.1']?.summary);
    expect(derived.nodes['1.1.8']?.summary).toBe(replayed.nodes['1.1.8.2']?.summary);
    // The last undo (cut=589) voided 1.1.27 in the op world; the derivation's
    // open cursor is the redo the ops numbered 1.1.28.
    expect(derived.nodes['1.19']?.summary).toBe(replayed.nodes['1.1.28']?.summary);
  });
});

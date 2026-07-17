/**
 * `spine` domain (L4) — the LEGACY wire Model (`SpineModel`) and its Ops
 * (`spine.open` / `spine.close` / `spine.next` / `spine.root_compact` /
 * `spine.truncate_repair`), plus the `SpineState` / `SpineNode` types the
 * whole domain shares.
 *
 * Since the derivation rewrite, the live tree is rebuilt from the
 * `contextMemory` message stream by `spineDerive.deriveSpineState` and these
 * ops are NEVER dispatched: they stay registered only so sessions persisted
 * before the rewrite still replay without unknown-op errors, and their
 * reducers are kept honest by the `Spine reducers (via wire)` tests. The
 * state shape below is the derivation's output contract — a node map, the
 * open-node stack (its top is the cursor), and the current root-epoch
 * boundary, with `openedAt`/`closedAt` indexing the stored history. Consumed
 * by the Agent-scope `spineService` and the `spineFold` projection.
 */

import { z } from 'zod';

import { defineModel } from '#/wire/model';

import {
  epochStartupNodeId,
  isRootEpoch,
  SPINE_VOID_OPENED_AT,
} from './spineTree';

export interface SpineNode {
  readonly id: string;
  readonly summary: string;
  readonly openedAt: number;
  readonly closedAt?: number;
  readonly memory?: string;
  readonly archivePath?: string;
  readonly baselineTokens?: number;
  readonly finalTokens?: number;
  readonly children: readonly string[];
}

export interface SpineState {
  readonly nodes: Readonly<Record<string, SpineNode>>;
  readonly openStack: readonly string[];
  readonly rootEpoch: number;
  readonly epochStartAt: number;
  readonly epochMemoryAt?: number;
}

function syntheticEpochNode(epoch: number, archivePath?: string): SpineNode {
  return {
    id: String(epoch),
    summary: `root epoch ${String(epoch)}`,
    openedAt: SPINE_VOID_OPENED_AT,
    archivePath,
    children: [epochStartupNodeId(epoch)],
  };
}

function syntheticStartupNode(epoch: number, openedAt: number): SpineNode {
  return {
    id: epochStartupNodeId(epoch),
    summary: 'startup',
    openedAt,
    children: [],
  };
}

function initialSpineState(): SpineState {
  const epoch = syntheticEpochNode(1);
  const startup = syntheticStartupNode(1, 0);
  return {
    nodes: { [epoch.id]: epoch, [startup.id]: startup },
    openStack: [epoch.id, startup.id],
    rootEpoch: 1,
    epochStartAt: 0,
  };
}

export const SpineModel = defineModel<SpineState>('spine', initialSpineState);

declare module '#/wire/types' {
  interface PersistedOpMap {
    'spine.open': typeof spineOpen;
    'spine.close': typeof spineClose;
    'spine.next': typeof spineNext;
    'spine.root_compact': typeof spineRootCompact;
    'spine.truncate_repair': typeof spineTruncateRepair;
  }
}

export const spineOpen = SpineModel.defineOp('spine.open', {
  schema: z.object({
    id: z.string(),
    summary: z.string(),
    parentId: z.string(),
    openedAt: z.number(),
    baselineTokens: z.number().optional(),
  }),
  apply: (s, p): SpineState => {
    const parent = s.nodes[p.parentId];
    const top = s.openStack.at(-1);
    if (parent === undefined || parent.closedAt !== undefined) return s;
    if (top !== p.parentId || p.id in s.nodes || p.summary.length === 0) return s;
    const node: SpineNode = {
      id: p.id,
      summary: p.summary,
      openedAt: p.openedAt,
      baselineTokens: p.baselineTokens,
      children: [],
    };
    return {
      ...s,
      nodes: {
        ...s.nodes,
        [p.id]: node,
        [p.parentId]: { ...parent, children: [...parent.children, p.id] },
      },
      openStack: [...s.openStack, p.id],
    };
  },
});

export const spineClose = SpineModel.defineOp('spine.close', {
  schema: z.object({
    id: z.string(),
    closedAt: z.number(),
    memory: z.string(),
    archivePath: z.string().optional(),
    finalTokens: z.number().optional(),
  }),
  apply: (s, p): SpineState => {
    const node = s.nodes[p.id];
    const top = s.openStack.at(-1);
    if (node === undefined || node.closedAt !== undefined) return s;
    if (top !== p.id || isRootEpoch(p.id) || p.memory.length === 0) return s;
    return {
      ...s,
      nodes: {
        ...s.nodes,
        [p.id]: {
          ...node,
          closedAt: p.closedAt,
          memory: p.memory,
          archivePath: p.archivePath,
          finalTokens: p.finalTokens,
        },
      },
      openStack: s.openStack.slice(0, -1),
    };
  },
});

export const spineNext = SpineModel.defineOp('spine.next', {
  schema: z.object({
    closedId: z.string(),
    closedAt: z.number(),
    memory: z.string(),
    archivePath: z.string().optional(),
    finalTokens: z.number().optional(),
    openedId: z.string(),
    summary: z.string(),
    baselineTokens: z.number().optional(),
  }),
  apply: (s, p): SpineState => {
    const closing = s.nodes[p.closedId];
    const top = s.openStack.at(-1);
    if (closing === undefined || closing.closedAt !== undefined) return s;
    if (top !== p.closedId || isRootEpoch(p.closedId) || p.memory.length === 0) return s;
    if (p.openedId in s.nodes || p.summary.length === 0) return s;
    const parentStack = s.openStack.slice(0, -1);
    const parentId = parentStack.at(-1);
    if (parentId === undefined) return s;
    const parent = s.nodes[parentId];
    if (parent === undefined) return s;
    const opened: SpineNode = {
      id: p.openedId,
      summary: p.summary,
      // The sibling opens right after the closing span — at the transition
      // carrier's index — so the carrier assistant message and its receipt
      // belong to the new sibling's span, not the closed one's.
      openedAt: p.closedAt + 1,
      baselineTokens: p.baselineTokens,
      children: [],
    };
    return {
      ...s,
      nodes: {
        ...s.nodes,
        [p.closedId]: {
          ...closing,
          closedAt: p.closedAt,
          memory: p.memory,
          archivePath: p.archivePath,
          finalTokens: p.finalTokens,
        },
        [p.openedId]: opened,
        [parentId]: { ...parent, children: [...parent.children, p.openedId] },
      },
      openStack: [...parentStack, p.openedId],
    };
  },
});

export const spineRootCompact = SpineModel.defineOp('spine.root_compact', {
  schema: z.object({
    epoch: z.number(),
    epochStartAt: z.number(),
    epochMemoryAt: z.number(),
    archivePath: z.string().optional(),
  }),
  apply: (s, p): SpineState => {
    if (p.epoch !== s.rootEpoch + 1) return s;
    if (p.epochStartAt < 0) return s;
    const epoch = syntheticEpochNode(p.epoch, p.archivePath);
    const startup = syntheticStartupNode(p.epoch, p.epochStartAt);
    return {
      nodes: { ...s.nodes, [epoch.id]: epoch, [startup.id]: startup },
      openStack: [epoch.id, startup.id],
      rootEpoch: p.epoch,
      epochStartAt: p.epochStartAt,
      epochMemoryAt: p.epochMemoryAt,
    };
  },
});

export const spineTruncateRepair = SpineModel.defineOp('spine.truncate_repair', {
  schema: z.object({
    cut: z.number(),
  }),
  apply: (s, p): SpineState => {
    const cut = Number.isFinite(p.cut) ? Math.max(0, Math.floor(p.cut)) : 0;
    let changed = false;
    const nodes: Record<string, SpineNode> = {};
    for (const [id, node] of Object.entries(s.nodes)) {
      let next: SpineNode = node;
      if (node.openedAt >= 0) {
        if (node.openedAt >= cut) {
          if (node.closedAt === undefined) {
            // Open node whose span start was truncated away: restart it at the
            // cut, so its eventual closed span covers only surviving messages.
            next = { ...node, openedAt: cut };
          } else {
            // Closed span fully inside the truncated range: void it (excluded
            // from the fold; the node stays in the tree with its memory and
            // archive path for reference).
            next = { ...node, openedAt: SPINE_VOID_OPENED_AT };
          }
        } else if (node.closedAt !== undefined && node.closedAt >= cut) {
          // Closed span straddling the cut: fold only the surviving prefix, so
          // messages appended after the cut never collide with the span.
          next = { ...node, closedAt: cut - 1 };
        }
      }
      if (next !== node) changed = true;
      nodes[id] = next;
    }
    // The epoch boundary indexes the stored history too. If the cut removed
    // the epoch summary anchor (or the boundary itself), the pre-boundary
    // history has no summary to fold behind: fall back to epochStartAt 0 so
    // the surviving history stays fully visible (closed spans still fold
    // normally). Every currently reachable cut stays at or after the
    // boundary — undo rejects at the compaction summary, `/clear` cuts at
    // 0 — so this is the no-loss conservative rule for future cut shapes.
    const anchorLost =
      (s.epochMemoryAt !== undefined && s.epochMemoryAt >= cut) || s.epochStartAt > cut;
    const epochStartAt = anchorLost ? 0 : s.epochStartAt;
    const epochMemoryAt = anchorLost ? undefined : s.epochMemoryAt;
    if (
      epochStartAt !== s.epochStartAt ||
      epochMemoryAt !== s.epochMemoryAt
    ) {
      changed = true;
    }
    return changed ? { ...s, nodes, epochStartAt, epochMemoryAt } : s;
  },
});

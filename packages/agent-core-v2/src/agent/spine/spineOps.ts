/**
 * `spine` domain (L4) — wire Model (`SpineModel`) and the Ops that mutate the
 * model-driven task tree (`spine.open` / `spine.close` / `spine.next` /
 * `spine.root_compact` / `spine.truncate_repair`).
 *
 * Declares the tree as `SpineState` (initial root epoch `1` with an open
 * synthetic startup node `1.1`): a node map, the open-node stack (its top is
 * the cursor), and the current root-epoch boundary. Every Op's `apply` is a
 * pure state transform that returns a NEW reference on a real change and the
 * SAME reference when its guard fails (so the wire's reference-equality gate
 * stays quiet); guards reject malformed or out-of-order payloads so a replay
 * never lands the tree in an inconsistent shape — cursor, parent linkage and
 * child numbering are derived by the live service, never trusted from a record.
 * Node ids and memory bodies live on the records themselves, so `wire.dispatch`
 * and `wire.replay` rebuild the same tree. Consumed by the Agent-scope
 * `spineService` and the `spineFold` projection.
 */

import { defineModel } from '#/wire/model';
import { defineOp } from '#/wire/op';

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

export interface SpineOpenPayload {
  readonly id: string;
  readonly summary: string;
  readonly parentId: string;
  readonly openedAt: number;
  readonly baselineTokens?: number;
}

export const spineOpen = defineOp(SpineModel, 'spine.open', {
  apply: (s, p: SpineOpenPayload): SpineState => {
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

export interface SpineClosePayload {
  readonly id: string;
  readonly closedAt: number;
  readonly memory: string;
  readonly archivePath?: string;
}

export const spineClose = defineOp(SpineModel, 'spine.close', {
  apply: (s, p: SpineClosePayload): SpineState => {
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
        },
      },
      openStack: s.openStack.slice(0, -1),
    };
  },
});

export interface SpineNextPayload {
  readonly closedId: string;
  readonly closedAt: number;
  readonly memory: string;
  readonly archivePath?: string;
  readonly openedId: string;
  readonly summary: string;
  readonly baselineTokens?: number;
}

export const spineNext = defineOp(SpineModel, 'spine.next', {
  apply: (s, p: SpineNextPayload): SpineState => {
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
      openedAt: p.closedAt,
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
        },
        [p.openedId]: opened,
        [parentId]: { ...parent, children: [...parent.children, p.openedId] },
      },
      openStack: [...parentStack, p.openedId],
    };
  },
});

export interface SpineRootCompactPayload {
  readonly epoch: number;
  readonly epochStartAt: number;
  readonly epochMemoryAt: number;
  readonly archivePath?: string;
}

export const spineRootCompact = defineOp(SpineModel, 'spine.root_compact', {
  apply: (s, p: SpineRootCompactPayload): SpineState => {
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

export interface SpineTruncateRepairPayload {
  readonly cut: number;
}

export const spineTruncateRepair = defineOp(SpineModel, 'spine.truncate_repair', {
  apply: (s, p: SpineTruncateRepairPayload): SpineState => {
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

declare module '#/agent/wireRecord/wireRecord' {
  interface WireRecordMap {
    'spine.open': SpineOpenPayload;
    'spine.close': SpineClosePayload;
    'spine.next': SpineNextPayload;
    'spine.root_compact': SpineRootCompactPayload;
    'spine.truncate_repair': SpineTruncateRepairPayload;
  }
}

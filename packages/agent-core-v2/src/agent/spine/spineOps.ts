/**
 * `spine` domain (L4) — wire Model (`SpineModel`) and the Ops that mutate the
 * model-driven task tree (`spine.open` / `spine.close` / `spine.next` /
 * `spine.root_compact`).
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
  SPINE_STARTUP_OPENED_AT,
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
    openedAt: SPINE_STARTUP_OPENED_AT,
    archivePath,
    children: [epochStartupNodeId(epoch)],
  };
}

function syntheticStartupNode(epoch: number): SpineNode {
  return {
    id: epochStartupNodeId(epoch),
    summary: 'startup',
    openedAt: SPINE_STARTUP_OPENED_AT,
    children: [],
  };
}

function initialSpineState(): SpineState {
  const epoch = syntheticEpochNode(1);
  const startup = syntheticStartupNode(1);
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
    const startup = syntheticStartupNode(p.epoch);
    return {
      nodes: { ...s.nodes, [epoch.id]: epoch, [startup.id]: startup },
      openStack: [epoch.id, startup.id],
      rootEpoch: p.epoch,
      epochStartAt: p.epochStartAt,
      epochMemoryAt: p.epochMemoryAt,
    };
  },
});

declare module '#/agent/wireRecord/wireRecord' {
  interface WireRecordMap {
    'spine.open': SpineOpenPayload;
    'spine.close': SpineClosePayload;
    'spine.next': SpineNextPayload;
    'spine.root_compact': SpineRootCompactPayload;
  }
}

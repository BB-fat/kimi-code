/**
 * `spine` domain (L4) — pure NodeId path, memory-assembly and tree-rendering
 * helpers shared by the reducers, the service and the projection fold.
 *
 * Owns the spine node-id grammar (`<epoch>` for a root epoch,
 * `<epoch>.<n>[.<n>…]` for work nodes) and the read-only `spine.tree`
 * rendering. Node memory is the model-written body verbatim — the folded
 * view's slot layout (surviving user requests in place, per-node
 * `<spine_memory node_id="...">` slots) is `spineFold`'s render-time concern.
 * Also owns `SPINE_VOID_OPENED_AT`, the sentinel `openedAt` for nodes that
 * must never produce a fold span: the synthetic root-epoch node (never
 * closable) and work nodes whose closed span a truncation repair voided. The
 * startup node does NOT use it — it opens at the real epoch boundary and
 * closes like any other work node. Holds no state and performs no IO;
 * consumed by `spineOps` (reducers), `spineDerive` (message-stream
 * derivation), `spineService` (commit orchestration) and `spineFold`
 * (projection).
 */

import type { SpineNode } from './spineOps';

export const SPINE_VOID_OPENED_AT = -1;

export function nodeDepth(id: string): number {
  return id.split('.').length;
}

export function isRootEpoch(id: string): boolean {
  return nodeDepth(id) === 1;
}

export function parentNodeId(id: string): string | null {
  const last = id.lastIndexOf('.');
  return last < 0 ? null : id.slice(0, last);
}

export function childNodeId(parentId: string, childIndex: number): string {
  return `${parentId}.${String(childIndex)}`;
}

export function nextChildIndex(childIds: readonly string[]): number {
  return childIds.length + 1;
}

export function epochStartupNodeId(epoch: number): string {
  return `${String(epoch)}.1`;
}

export interface SpineTreeNodeView {
  readonly id: string;
  readonly summary: string;
  readonly closed: boolean;
  readonly archivePath: string | undefined;
  readonly tokenCost: number | undefined;
  readonly children: readonly SpineTreeNodeView[];
}

export interface SpineTreeRenderInput {
  readonly cursorId: string | undefined;
  readonly rootIds: readonly string[];
  readonly resolve: (id: string) => SpineTreeNodeView | undefined;
}

export function renderTree(input: SpineTreeRenderInput): string {
  const lines: string[] = [];
  for (const rootId of input.rootIds) {
    renderNode(rootId, '', input, lines);
  }
  if (lines.length === 0) return '(empty spine tree)';
  return lines.join('\n');
}

function renderNode(
  id: string,
  indent: string,
  input: SpineTreeRenderInput,
  lines: string[],
): void {
  const node = input.resolve(id);
  if (node === undefined) return;
  const cursor = id === input.cursorId ? ' <== cursor' : '';
  const state = node.closed ? 'closed' : 'open';
  const cost = node.tokenCost === undefined ? '' : `, ~${formatTokens(node.tokenCost)}`;
  const archive = node.archivePath === undefined ? '' : `, archive: ${node.archivePath}`;
  lines.push(`${indent}${id} [${state}${cost}${archive}]${cursor} — ${node.summary}`);
  const childIndent = `${indent}  `;
  for (const child of node.children) {
    renderNode(child.id, childIndent, input, lines);
  }
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(tokens >= 10000 ? 0 : 1)}K`;
  return String(tokens);
}

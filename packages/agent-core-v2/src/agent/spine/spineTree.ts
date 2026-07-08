/**
 * `spine` domain (L4) — pure NodeId path, memory-assembly and tree-rendering
 * helpers shared by the reducers, the service and the projection fold.
 *
 * Owns the spine node-id grammar (`<epoch>` for a root epoch,
 * `<epoch>.<n>[.<n>…]` for work nodes), the continuation-memory body layout
 * (`## Child Memory` from already-closed children followed by `## Node Memory`
 * from the closing model call), and the read-only `spine.tree` rendering.
 * Holds no state and performs no IO; consumed by `spineOps` (reducers),
 * `spineService` (commit orchestration) and `spineFold` (projection).
 */

export const SPINE_STARTUP_OPENED_AT = -1;

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

export interface SpineMemoryAssemblyInput {
  readonly childMemories: readonly string[];
  readonly nodeMemory: string;
}

export function assembleMemoryBody(input: SpineMemoryAssemblyInput): string {
  const child = input.childMemories
    .map((body) => body.trim())
    .filter((body) => body.length > 0)
    .join('\n\n');
  const node = input.nodeMemory.trim();
  if (child.length === 0) return node;
  if (node.length === 0) return `## Child Memory\n\n${child}`;
  return `## Child Memory\n\n${child}\n\n## Node Memory\n\n${node}`;
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

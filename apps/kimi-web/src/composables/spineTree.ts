// apps/kimi-web/src/composables/spineTree.ts
// Derives the CURRENT spine task tree from a session transcript. The agent
// drives its Spine task tree via the spine_open / spine_close / spine_next
// control tools, and core's contract is accepted ⟺ non-error tool result
// (a rejected transition surfaces its reason as an error), so the tree can
// be rebuilt app-side from the transcript alone — the same scrape channel
// the TodoList projection (latestTodos) uses, and the same isError-only
// check the TUI's live path applies.
// Replaying the accepted transitions in transcript order mirrors the tree:
//   spine_open(summary)         → push a child under the cursor; cursor = child
//   spine_close(memory)         → close the cursor node; pop
//   spine_next(summary, memory) → close the cursor node; open a sibling
// Closed nodes render as done, the open cursor chain as in_progress, and the
// cursor node is flagged `active`. The tree persists after the last close:
// back at the root epoch it stays visible as all-done history, so only a
// transcript without any spine activity yields [] (the dock then falls back
// to the flat todo list). Rejected transitions (error results) never touch
// the tree. Differs from the TUI's spine-projection.ts, which returns [] at
// the root epoch.

import type { AppMessage } from '../api/types';
import type { TodoTreeNode } from '../types';
import { normalizeToolName } from '../lib/toolMeta';

type SpineControlToolName = 'spine_open' | 'spine_close' | 'spine_next';

const SPINE_CONTROL_TOOL_NAMES: ReadonlySet<string> = new Set([
  'spine_open',
  'spine_close',
  'spine_next',
]);

function isSpineControlToolName(name: string): name is SpineControlToolName {
  return SPINE_CONTROL_TOOL_NAMES.has(name);
}

interface SpineNode {
  summary: string;
  parentIndex: number | null;
  closed: boolean;
}

function parseArgs(input: unknown): Record<string, unknown> {
  let value = input;
  if (typeof value === 'string') {
    if (value.trim().length === 0) return {};
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readSummary(args: Record<string, unknown>): string | null {
  const summary = args['summary'];
  return typeof summary === 'string' && summary.trim().length > 0 ? summary : null;
}

function applyTransition(
  nodes: SpineNode[],
  cursorStack: number[],
  name: SpineControlToolName,
  args: Record<string, unknown>,
): void {
  switch (name) {
    case 'spine_open': {
      const summary = readSummary(args);
      if (summary === null) return;
      const parentIndex = cursorStack.at(-1) ?? null;
      nodes.push({ summary, parentIndex, closed: false });
      cursorStack.push(nodes.length - 1);
      return;
    }
    case 'spine_close': {
      const cursor = cursorStack.at(-1);
      if (cursor === undefined) return;
      nodes[cursor]!.closed = true;
      cursorStack.pop();
      return;
    }
    case 'spine_next': {
      const summary = readSummary(args);
      const cursor = cursorStack.at(-1);
      if (summary === null || cursor === undefined) return;
      const parentIndex = nodes[cursor]?.parentIndex ?? null;
      nodes[cursor]!.closed = true;
      nodes.push({ summary, parentIndex, closed: false });
      cursorStack[cursorStack.length - 1] = nodes.length - 1;
      return;
    }
  }
}

function projectTree(nodes: SpineNode[], cursorStack: number[]): TodoTreeNode[] {
  // No early return at the root epoch: a fully closed tree stays visible as
  // all-done history. A transcript without spine activity still yields [] via
  // the empty children map.
  const cursor = cursorStack.at(-1);

  const childrenByParent = new Map<number | null, number[]>();
  for (const [index, node] of nodes.entries()) {
    const bucket = childrenByParent.get(node.parentIndex);
    if (bucket === undefined) {
      childrenByParent.set(node.parentIndex, [index]);
    } else {
      bucket.push(index);
    }
  }

  const build = (index: number): TodoTreeNode => {
    const node = nodes[index]!;
    return {
      title: node.summary,
      status: node.closed ? 'done' : 'in_progress',
      active: index === cursor ? true : undefined,
      children: (childrenByParent.get(index) ?? []).map(build),
    };
  };
  return (childrenByParent.get(null) ?? []).map(build);
}

export function spineTreeFromMessages(messages: AppMessage[]): TodoTreeNode[] {
  const nodes: SpineNode[] = [];
  /** Ancestor chain root → cursor as node indexes; empty at the root epoch. */
  const cursorStack: number[] = [];
  const pending = new Map<string, { name: SpineControlToolName; args: Record<string, unknown> }>();

  for (const msg of messages) {
    for (const c of msg.content) {
      if (c.type === 'toolUse') {
        const name = normalizeToolName(c.toolName);
        if (isSpineControlToolName(name)) {
          pending.set(c.toolCallId, { name, args: parseArgs(c.input) });
        }
        continue;
      }
      if (c.type !== 'toolResult') continue;
      const call = pending.get(c.toolCallId);
      if (call === undefined) continue;
      pending.delete(c.toolCallId);
      // Only accepted transitions touch the tree. Core's contract: accepted ⟺
      // isError !== true — a rejected transition surfaces its reason as an
      // error. The same isError-only check the TUI's live path applies.
      if (c.isError) continue;
      applyTransition(nodes, cursorStack, call.name, call.args);
    }
  }

  return projectTree(nodes, cursorStack);
}

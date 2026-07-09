/**
 * TodoPanel — live-updating TODO list shown before the input area.
 *
 * Mounted as a dedicated `Container` slot between the activity pane
 * (spinners / thinking stream) and the queue / editor block. The panel has
 * two mutually-exclusive modes:
 *
 * - flat: the host calls {@link setTodos} whenever the LLM invokes the
 *   `TodoList` tool; state survives across turns so the list stays visible
 *   until explicitly cleared (`todos: []`), a new session starts, or
 *   `/clear` is issued.
 * - tree: spine sessions never emit `TodoList` calls, so the host feeds the
 *   transcript-derived spine task tree through {@link setTree} instead.
 *
 * The mode follows whichever setter ran last; `clear()` resets both.
 */

import type { Component } from '@moonshot-ai/pi-tui';
import { truncateToWidth } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';

import { currentTheme } from '#/tui/theme';
import type { ColorPalette } from '#/tui/theme/colors';

export type TodoStatus = 'pending' | 'in_progress' | 'done';

export interface TodoItem {
  readonly title: string;
  readonly status: TodoStatus;
}

/**
 * Panel-facing view of one spine task-tree node. The spine tree has no
 * "pending": a node is either closed (done) or on the open cursor chain
 * (in_progress); `active` marks the single cursor node.
 */
export interface TodoTreeNode {
  readonly title: string;
  readonly status: 'in_progress' | 'done';
  readonly active?: boolean;
  readonly children: readonly TodoTreeNode[];
}

const MAX_VISIBLE = 5;

export interface VisibleTodos {
  readonly rows: readonly TodoItem[];
  readonly hidden: number;
  readonly hiddenCounts: Record<TodoStatus, number>;
}

/**
 * Pick which todos to render when the list exceeds {@link MAX_VISIBLE}.
 *
 * The selector is order-agnostic — the TodoList tool keeps whatever
 * order the model produced and does not group items by status, so an
 * interleaved sequence like `pending, done, pending, done, ...` is
 * possible and must still yield MAX_VISIBLE rows when enough exist.
 *
 * Strategy:
 * 1. Include every `in_progress` item (capped at MAX_VISIBLE).
 * 2. Fill remaining slots with "what's next" — the earliest `pending`
 *    items in their original positions — while reserving one slot for
 *    "what just finished" — the latest `done` item — when both kinds
 *    exist. If one side has too few candidates, the other expands.
 *
 * Items are returned in their original order.
 */
export function selectVisibleTodos(todos: readonly TodoItem[]): VisibleTodos {
  if (todos.length <= MAX_VISIBLE) {
    return {
      rows: [...todos],
      hidden: 0,
      hiddenCounts: { done: 0, in_progress: 0, pending: 0 },
    };
  }

  const inProgress: number[] = [];
  const pending: number[] = [];
  const done: number[] = [];
  for (const [i, todo] of todos.entries()) {
    if (todo.status === 'in_progress') inProgress.push(i);
    else if (todo.status === 'pending') pending.push(i);
    else done.push(i);
  }

  const picked = new Set<number>();
  for (const i of inProgress.slice(0, MAX_VISIBLE)) picked.add(i);

  if (picked.size < MAX_VISIBLE) {
    // Most recent done first; earliest pending first.
    const doneCandidates = done.toReversed();
    const pendingCandidates = pending;

    const remaining = MAX_VISIBLE - picked.size;
    let doneCount: number;
    let pendingCount: number;
    if (doneCandidates.length === 0) {
      doneCount = 0;
      pendingCount = Math.min(remaining, pendingCandidates.length);
    } else if (pendingCandidates.length === 0) {
      pendingCount = 0;
      doneCount = Math.min(remaining, doneCandidates.length);
    } else {
      doneCount = 1;
      pendingCount = Math.min(remaining - 1, pendingCandidates.length);
      if (pendingCount < remaining - 1) {
        doneCount = Math.min(doneCandidates.length, remaining - pendingCount);
      }
    }

    for (let i = 0; i < doneCount; i++) picked.add(doneCandidates[i] as number);
    for (let i = 0; i < pendingCount; i++) picked.add(pendingCandidates[i] as number);
  }

  const sortedIdx = [...picked].toSorted((a, b) => a - b);

  const hiddenCounts: Record<TodoStatus, number> = { done: 0, in_progress: 0, pending: 0 };
  for (const [i, todo] of todos.entries()) {
    if (!picked.has(i)) {
      hiddenCounts[todo.status] += 1;
    }
  }

  return {
    rows: sortedIdx.map((i) => todos[i] as TodoItem),
    hidden: todos.length - sortedIdx.length,
    hiddenCounts,
  };
}

/** One rendered tree line, after folding and before width truncation. */
interface FlatTreeRow {
  readonly node: TodoTreeNode;
  readonly depth: number;
  /** Descendants hidden by folding this done subtree; 0 when not folded. */
  readonly foldedDescendants: number;
}

function countDescendants(node: TodoTreeNode): number {
  let count = 0;
  for (const child of node.children) count += 1 + countDescendants(child);
  return count;
}

/**
 * Depth-first flattening. Collapsed mode folds every done subtree into its
 * root line (spine never reopens closed nodes, so nothing inside can still
 * change); expanded mode walks everything.
 */
function buildTreeRows(
  roots: readonly TodoTreeNode[],
  expanded: boolean,
): FlatTreeRow[] {
  const rows: FlatTreeRow[] = [];
  const visit = (node: TodoTreeNode, depth: number): void => {
    const folds = !expanded && node.status === 'done' && node.children.length > 0;
    rows.push({ node, depth, foldedDescendants: folds ? countDescendants(node) : 0 });
    if (!folds) {
      for (const child of node.children) visit(child, depth + 1);
    }
  };
  for (const root of roots) visit(root, 0);
  return rows;
}

/**
 * Window folded rows down to {@link MAX_VISIBLE} lines, anchoring on the
 * cursor row so the active line (plus up to MAX_VISIBLE-1 context lines
 * above it when available) always stays visible.
 */
function windowTreeRows(rows: readonly FlatTreeRow[]): { rows: readonly FlatTreeRow[]; hidden: number } {
  if (rows.length <= MAX_VISIBLE) return { rows, hidden: 0 };
  const activeIndex = rows.findIndex((row) => row.node.active === true);
  const anchor = activeIndex >= 0 ? activeIndex : rows.length - 1;
  const start = Math.min(
    Math.max(0, anchor - (MAX_VISIBLE - 1)),
    rows.length - MAX_VISIBLE,
  );
  return { rows: rows.slice(start, start + MAX_VISIBLE), hidden: rows.length - MAX_VISIBLE };
}

export class TodoPanelComponent implements Component {
  private mode: 'flat' | 'tree' = 'flat';
  private todos: readonly TodoItem[] = [];
  private roots: readonly TodoTreeNode[] = [];
  private expanded = false;

  setTodos(todos: readonly TodoItem[]): void {
    this.mode = 'flat';
    this.todos = todos.map((t) => ({ title: t.title, status: t.status }));
  }

  setTree(roots: readonly TodoTreeNode[]): void {
    this.mode = 'tree';
    this.roots = roots.map(copyTreeNode);
  }

  getTodos(): readonly TodoItem[] {
    return this.todos;
  }

  clear(): void {
    this.mode = 'flat';
    this.todos = [];
    this.roots = [];
    this.expanded = false;
  }

  isEmpty(): boolean {
    return this.mode === 'tree' ? this.roots.length === 0 : this.todos.length === 0;
  }

  /**
   * True when expanding would show more than the collapsed view: flat mode
   * over the cap, or tree mode with folded subtrees / rows over the cap.
   */
  hasOverflow(): boolean {
    if (this.mode !== 'tree') return this.todos.length > MAX_VISIBLE;
    const rows = buildTreeRows(this.roots, false);
    return rows.some((row) => row.foldedDescendants > 0) || rows.length > MAX_VISIBLE;
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
  }

  toggleExpanded(): void {
    this.expanded = !this.expanded;
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (this.isEmpty()) return [];
    const c = currentTheme.palette;
    const lines: string[] = [
      chalk.hex(c.border)('─'.repeat(width)),
      chalk.hex(c.primary).bold('  Todo'),
    ];

    if (this.mode === 'tree') {
      lines.push(...this.renderTreeBody(c));
    } else if (this.expanded) {
      for (const todo of this.todos) {
        lines.push(renderRow(todo, c));
      }
      if (this.todos.length > MAX_VISIBLE) {
        lines.push(
          chalk.hex(c.textDim)(`  all ${String(this.todos.length)} items · ctrl+t to collapse`),
        );
      }
    } else {
      const { rows, hidden, hiddenCounts } = selectVisibleTodos(this.todos);
      for (const todo of rows) {
        lines.push(renderRow(todo, c));
      }
      if (hidden > 0) {
        const distribution = formatHiddenCounts(hiddenCounts);
        const suffix = distribution.length > 0 ? ` (${distribution})` : '';
        lines.push(
          chalk.hex(c.textDim)(`  … +${hidden} more${suffix} · ctrl+t to expand`),
        );
      }
    }

    return lines.map((line) => truncateToWidth(line, width));
  }

  private renderTreeBody(c: ColorPalette): string[] {
    if (this.expanded) {
      const rows = buildTreeRows(this.roots, true);
      const lines = rows.map((row) => renderTreeRow(row, c));
      if (rows.length > MAX_VISIBLE) {
        lines.push(
          chalk.hex(c.textDim)(`  all ${String(rows.length)} nodes · ctrl+t to collapse`),
        );
      }
      return lines;
    }

    const { rows, hidden } = windowTreeRows(buildTreeRows(this.roots, false));
    const lines = rows.map((row) => renderTreeRow(row, c));
    if (hidden > 0) {
      lines.push(chalk.hex(c.textDim)(`  … +${hidden} more · ctrl+t to expand`));
    }
    return lines;
  }
}

function copyTreeNode(node: TodoTreeNode): TodoTreeNode {
  return {
    title: node.title,
    status: node.status,
    active: node.active,
    children: node.children.map(copyTreeNode),
  };
}

function renderRow(todo: TodoItem, colors: ColorPalette): string {
  const marker = statusMarker(todo.status, colors);
  const titleStyled = styleTitle(todo.title, todo.status, colors);
  return `  ${marker} ${titleStyled}`;
}

function renderTreeRow(row: FlatTreeRow, colors: ColorPalette): string {
  const indent = '  ' + '  '.repeat(row.depth);
  const marker = statusMarker(row.node.status, colors);
  const titleStyled = styleTreeTitle(row.node, colors);
  const suffix =
    row.foldedDescendants > 0
      ? chalk.hex(colors.textDim)(` · ${String(row.foldedDescendants)}`)
      : '';
  return `${indent}${marker} ${titleStyled}${suffix}`;
}

function statusMarker(status: TodoStatus, colors: ColorPalette): string {
  switch (status) {
    case 'in_progress':
      return chalk.hex(colors.primary).bold('●');
    case 'done':
      return chalk.hex(colors.success)('✓');
    case 'pending':
      return chalk.hex(colors.textDim)('○');
  }
}

function styleTitle(title: string, status: TodoStatus, colors: ColorPalette): string {
  switch (status) {
    case 'in_progress':
      return chalk.hex(colors.text).bold(title);
    case 'done':
      return chalk.hex(colors.textDim).strikethrough(title);
    case 'pending':
      return chalk.hex(colors.text)(title);
  }
}

/** Done subtrees read identically to flat mode; only the cursor row is bold. */
function styleTreeTitle(node: TodoTreeNode, colors: ColorPalette): string {
  if (node.status === 'done') return chalk.hex(colors.textDim).strikethrough(node.title);
  return node.active === true
    ? chalk.hex(colors.text).bold(node.title)
    : chalk.hex(colors.text)(node.title);
}

const STATUS_LABELS: readonly { status: TodoStatus; label: string }[] = [
  { status: 'done', label: 'done' },
  { status: 'in_progress', label: 'in progress' },
  { status: 'pending', label: 'pending' },
];

export function formatHiddenCounts(counts: Record<TodoStatus, number>): string {
  return STATUS_LABELS.filter(({ status }) => counts[status] > 0)
    .map(({ status, label }) => `${counts[status]} ${label}`)
    .join(' · ');
}

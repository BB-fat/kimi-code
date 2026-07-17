<!-- apps/kimi-web/src/components/chat/TodoCard.vue -->
<!-- Read-only todo list driven by the model's TodoList tool (latest full-list
     write wins). Rendered inside the dock panel, which owns the card shell
     and the "待办 · N/M" header — this is just the rows + empty state.
     Rows share StatusGlyph with the background bash/subagent task list so the
     two stay visually identical. -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { TodoTreeNode, TodoView } from '../../types';
import StatusGlyph, { type StatusGlyphStatus } from './StatusGlyph.vue';

const props = defineProps<{
  todos: TodoView[];
  /** Spine task tree mirrored from the transcript — when non-empty it
      replaces the flat todo list (spine sessions never emit TodoList). */
  tree?: TodoTreeNode[];
}>();

const { t } = useI18n();

interface TreeRow {
  node: TodoTreeNode;
  depth: number;
}

/** Depth-first flattening of the spine tree: every node renders (done
    subtrees included) — the dock panel scrolls, so no folding like the TUI. */
const treeRows = computed<TreeRow[]>(() => {
  const rows: TreeRow[] = [];
  const visit = (nodes: TodoTreeNode[], depth: number): void => {
    for (const node of nodes) {
      rows.push({ node, depth });
      visit(node.children, depth + 1);
    }
  };
  visit(props.tree ?? [], 0);
  return rows;
});

function glyphStatus(status: TodoView['status']): StatusGlyphStatus {
  return status === 'in_progress' ? 'run' : status;
}
</script>

<template>
  <div class="todo-card">
    <div v-if="treeRows.length === 0 && props.todos.length === 0" class="tc-empty">
      <svg class="tc-empty-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M9 11l2 2 4-4" />
        <rect x="4" y="4" width="16" height="16" rx="3" />
      </svg>
      <span>{{ t('tasks.emptyTodo') }}</span>
    </div>

    <template v-if="treeRows.length > 0">
      <div
        v-for="(row, i) in treeRows"
        :key="i"
        class="tc-row"
        :class="[`s-${row.node.status}`, { 's-active': row.node.active }]"
      >
        <span
          v-if="row.depth > 0"
          class="tc-indent"
          :style="{ width: `${row.depth * 14}px` }"
          aria-hidden="true"
        ></span>
        <StatusGlyph :status="glyphStatus(row.node.status)" />
        <span class="tc-name">{{ row.node.title }}</span>
      </div>
    </template>
    <template v-else>
      <div v-for="(td, i) in props.todos" :key="i" class="tc-row" :class="`s-${td.status}`">
        <StatusGlyph :status="glyphStatus(td.status)" />
        <span class="tc-name">{{ td.title }}</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.todo-card {
  display: flex;
  flex-direction: column;
  gap: 1px;
  font-size: var(--text-base);
}

.tc-row {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 4px 0;
  color: var(--color-text);
}
.tc-name { flex: 1; min-width: 0; overflow-wrap: anywhere; line-height: 1.4; }
.tc-row.s-in_progress .tc-name { font-weight: var(--weight-medium); }
.tc-row.s-done .tc-name {
  color: var(--color-text-faint);
  text-decoration: line-through;
}
.tc-row.s-active .tc-name { color: var(--color-accent); }
.tc-indent { flex: none; }

.tc-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-6) var(--space-4);
  color: var(--color-text-faint);
  font-size: var(--text-sm);
}
.tc-empty-ico { width: 28px; height: 28px; color: var(--color-line-strong); }

/* Mobile (~/todo tab): match the chat font bump; row spacing opens up. */
@media (max-width: 640px) {
  .todo-card { font-size: var(--text-lg); }
  .tc-row { padding: var(--space-2) var(--space-3); }
}
</style>

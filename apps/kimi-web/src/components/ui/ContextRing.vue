<!-- apps/kimi-web/src/components/ui/ContextRing.vue -->
<!-- Composer context-meter: a small circular progress ring. Bespoke data
     visualization (not a line icon), so it lives here rather than in the icon
     registry. The arc length is derived from `pct`. -->
<script setup lang="ts">
// `rawPct` is the unfolded-request share of the window; it only diverges from
// `pct` once a fold reclaimed context, so the second arc stays hidden before
// that (raw >= projected by construction, the projected arc paints over it).
const props = defineProps<{ pct: number; rawPct?: number }>();

const R = 7;
const circumference = 2 * Math.PI * R;
</script>

<template>
  <svg class="ctx-ring" viewBox="0 0 20 20" aria-hidden="true">
    <circle class="ctx-ring-track" cx="10" cy="10" :r="R" fill="none" stroke-width="2.5" />
    <circle
      v-if="props.rawPct !== undefined"
      class="ctx-ring-raw"
      cx="10"
      cy="10"
      :r="R"
      fill="none"
      stroke-width="2.5"
      stroke-linecap="round"
      :stroke-dasharray="`${circumference}`"
      :stroke-dashoffset="`${circumference * (1 - props.rawPct / 100)}`"
    />
    <circle
      class="ctx-ring-fill"
      cx="10"
      cy="10"
      :r="R"
      fill="none"
      stroke-width="2.5"
      stroke-linecap="round"
      :stroke-dasharray="`${circumference}`"
      :stroke-dashoffset="`${circumference * (1 - props.pct / 100)}`"
    />
  </svg>
</template>

<style scoped>
.ctx-ring {
  width: 16px;
  height: 16px;
  flex: none;
  transform: rotate(-90deg);
}
.ctx-ring-track {
  stroke: var(--line);
}
.ctx-ring-raw {
  stroke: var(--color-warning);
  transition: stroke-dashoffset 0.3s ease;
}
.ctx-ring-fill {
  stroke: var(--color-accent);
  transition: stroke-dashoffset 0.3s ease, stroke 0.3s ease;
}
</style>

<template>
  <div
    v-if="coverage.show"
    class="render-coverage"
    aria-live="polite"
    :title="`${coverage.label} annotations rendered. Only a subset is drawn at a time for performance — pan, zoom, or filter to bring more into view.`"
  >
    <span class="render-coverage__label">
      {{ coverage.label }} <span class="render-coverage__suffix">rendered</span>
    </span>
    <div class="render-coverage__track">
      <div
        class="render-coverage__fill"
        :style="{ width: `${(coverage.fraction * 100).toFixed(1)}%` }"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import annotationStore from "@/store/annotation";
import { computeRenderCoverage } from "@/utils/renderCoverage";

// displayed = annotations currently rendered (the visibility budget); loaded =
// all stubs held in memory. The indicator appears only while the render budget
// is actively downsampling the current view (displayed saturated at the budget);
// a mid-size dataset that fits under the budget renders fully and stays hidden.
// Compares against effectiveMaxVisible (the zoom-scaled budget the last update
// applied), not the static config cap, so it stays accurate as the budget
// shrinks when zoomed out.
const coverage = computed(() =>
  computeRenderCoverage({
    stubOnlyMode: annotationStore.stubOnlyMode,
    displayed: annotationStore.visibleAnnotationIds.size,
    loaded: annotationStore.annotationStubs.size,
    maxVisible: annotationStore.effectiveMaxVisible,
  }),
);
</script>

<style lang="scss" scoped>
.render-coverage {
  position: absolute;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 2000;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 4px 10px 5px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.7);
  color: white;
  // Purely informational — never intercept clicks/drags on the canvas beneath.
  pointer-events: none;
  user-select: none;
}

.render-coverage__label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  white-space: nowrap;
}

.render-coverage__suffix {
  font-weight: 400;
  opacity: 0.7;
}

.render-coverage__track {
  width: 160px;
  height: 4px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.2);
  overflow: hidden;
}

.render-coverage__fill {
  height: 100%;
  // A floor so a tiny fraction (e.g. 50K / 709K ≈ 7%) is still visibly a sliver.
  min-width: 2px;
  background: rgb(var(--v-theme-primary));
  transition: width 0.2s ease;
}
</style>

<template>
  <div
    v-if="coverage.show"
    class="render-coverage"
    aria-live="polite"
    :title="`${coverage.shownLabel} drawn — only a subset is rendered at a time for performance. Zoom in or filter to see more. ${coverage.totalLabel} in this dataset.`"
  >
    <span class="render-coverage__label">
      Showing {{ coverage.shownLabel }}
    </span>
    <div class="render-coverage__track">
      <div
        class="render-coverage__fill"
        :style="{ width: `${(coverage.fraction * 100).toFixed(1)}%` }"
      />
    </div>
    <span class="render-coverage__suffix">{{ coverage.totalLabel }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import annotationStore from "@/store/annotation";
import { computeRenderCoverage } from "@/utils/renderCoverage";

// Shows how much of what's in the CURRENT VIEWPORT is actually drawn (the "am I
// seeing everything here?" metric), with the dataset total as context. Appears
// only while some in-view annotations are downsampled away; when everything in
// view is rendered (mid-size dataset, or zoomed in far enough) it stays hidden.
const coverage = computed(() =>
  computeRenderCoverage({
    stubOnlyMode: annotationStore.stubOnlyMode,
    viewportShown: annotationStore.viewportRenderedCount,
    viewportTotal: annotationStore.viewportAnnotationCount,
    loaded: annotationStore.annotationStubs.size,
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

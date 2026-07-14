<template>
  <div
    v-if="coverage.show"
    class="render-coverage"
    aria-live="polite"
    :title="`Annotation rendering coverage for the current view. When large, only a subset is drawn at a time for performance — zoom in or filter to see more. ${coverage.totalLabel} in this dataset.`"
  >
    <span class="render-coverage__label">
      {{ coverage.shownLabel }}
    </span>
    <div class="render-coverage__track">
      <div
        class="render-coverage__fill"
        :style="{ width: `${(coverage.fraction * 100).toFixed(1)}%` }"
      />
    </div>
    <span class="render-coverage__suffix">{{ coverage.totalLabel }}</span>

    <v-menu :close-on-content-click="false" location="bottom end" offset="6">
      <template #activator="{ props: menuProps }">
        <v-btn
          icon="mdi-cog"
          size="x-small"
          variant="text"
          density="comfortable"
          class="render-coverage__gear"
          aria-label="Rendering settings"
          v-bind="menuProps"
        />
      </template>
      <v-card class="render-coverage__settings" min-width="320" max-width="360">
        <v-card-title class="text-subtitle-2"
          >Annotation rendering</v-card-title
        >
        <v-card-text>
          <VisibilitySettings :show-blurb="false" />
        </v-card-text>
      </v-card>
    </v-menu>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import annotationStore from "@/store/annotation";
import { computeRenderCoverage } from "@/utils/renderCoverage";
import VisibilitySettings from "@/components/VisibilitySettings.vue";

// Shows how much of what's in the CURRENT VIEWPORT is actually drawn (the "am I
// seeing everything here?" metric), with the dataset total as context. Always
// visible in stub-only (large-dataset) mode — a stable readout and the home for
// the rendering-settings gear.
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
  padding: 4px 22px 5px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.7);
  color: white;
  // Purely informational — never intercept clicks/drags on the canvas beneath.
  // The gear opts back in to pointer events (below) so it stays clickable.
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
  font-size: 10px;
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

.render-coverage__gear {
  position: absolute;
  // Vertically centered on the "Showing…" label line.
  top: 4px;
  right: 1px;
  // Sized to sit at about the widget's text size.
  width: 16px;
  height: 16px;
  min-width: 16px;
  color: white;
  opacity: 0.7;
  // Re-enable clicks on just the gear (the container is click-through).
  pointer-events: auto;

  :deep(.v-icon) {
    font-size: 14px;
  }

  &:hover {
    opacity: 1;
  }
}

.render-coverage__settings {
  // The popup content must accept pointer events even though it is teleported
  // out of the click-through container.
  pointer-events: auto;
}
</style>

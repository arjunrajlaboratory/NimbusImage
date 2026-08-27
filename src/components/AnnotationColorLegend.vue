<template>
  <div v-if="legend" class="color-legend-anchor">
    <div v-if="legend.showLegend" class="color-legend-panel">
      <div class="legend-header">
        <span class="legend-title" :title="legend.propertyName">
          {{ legend.propertyName }}
        </span>
        <v-btn
          variant="text"
          icon
          size="x-small"
          aria-label="Hide legend"
          @click="setShowLegend(false)"
        >
          <v-icon size="16">mdi-chevron-down</v-icon>
        </v-btn>
      </div>
      <!-- Horizontal bar: the panel's width is set by the property name, so a
           full-width ramp fills it instead of leaving dead space beside a
           narrow vertical bar. -->
      <div v-if="legend.type === 'continuous'" class="legend-continuous">
        <div class="legend-gradient" :style="gradientStyle" />
        <div class="legend-gradient-labels">
          <span :title="extentTitle">{{ lowLabel }}</span>
          <span :title="extentTitle">{{ highLabel }}</span>
        </div>
      </div>
      <div v-else class="legend-categories">
        <div
          v-for="category in displayedCategories"
          :key="category.value"
          class="legend-category"
        >
          <span class="legend-swatch" :style="{ background: category.color }" />
          <span class="legend-category-label" :title="category.value">
            {{ category.value }}
          </span>
          <span class="legend-category-count">{{ category.count }}</span>
        </div>
        <div v-if="hiddenCategoryCount > 0" class="legend-more">
          +{{ hiddenCategoryCount }} more
        </div>
      </div>
    </div>
    <v-btn
      v-else
      class="legend-reopen"
      variant="outlined"
      size="x-small"
      prepend-icon="mdi-palette-swatch"
      @click="setShowLegend(true)"
    >
      Legend
    </v-btn>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import store from "@/store";
import { cssLinearGradient } from "@/utils/colors";

// Longer categorical legends scroll; past this many rows we stop rendering
// and summarize, so a legend can't fill the viewer.
const MAX_DISPLAYED_CATEGORIES = 30;

// Keyed by dataset in the configuration (a configuration can be shared across
// datasets), so read it through the store's per-dataset getter.
const legend = computed(() => store.colorByPropertyForCurrentDataset);

const gradientStyle = computed(() => {
  const stops = legend.value?.stops;
  if (!stops || stops.length === 0) {
    return {};
  }
  // "to right" puts the first stop (the range minimum) at the left of the
  // bar, matching the min label below-left and max label below-right.
  return {
    background: cssLinearGradient(stops, "to right"),
  };
});

const displayedCategories = computed(
  () => legend.value?.categories?.slice(0, MAX_DISPLAYED_CATEGORIES) ?? [],
);

const hiddenCategoryCount = computed(() => {
  const total = legend.value?.categories?.length ?? 0;
  return Math.max(total - MAX_DISPLAYED_CATEGORIES, 0);
});

// Three significant digits, grouped, without scientific notation for any
// magnitude a legend realistically shows: toPrecision(3) rendered a 1960 range
// end as "1.96e+3".
const valueFormat = new Intl.NumberFormat(undefined, {
  maximumSignificantDigits: 3,
});

function formatValue(value: number | undefined): string {
  if (value == null) {
    return "";
  }
  if (Number.isInteger(value) && Math.abs(value) < 1e6) {
    return value.toString();
  }
  return valueFormat.format(value);
}

// The ramp usually spans percentiles, so values beyond its ends are clamped
// to the end colors. Say so with ≤ / ≥ rather than implying the label is the
// data's extreme; the tooltip carries the true extent.
const lowLabel = computed(() => {
  const value = formatValue(legend.value?.min);
  return legend.value?.clippedLow ? `≤ ${value}` : value;
});

const highLabel = computed(() => {
  const value = formatValue(legend.value?.max);
  return legend.value?.clippedHigh ? `≥ ${value}` : value;
});

const extentTitle = computed(() => {
  const current = legend.value;
  if (!current || current.dataMin == null || current.dataMax == null) {
    return undefined;
  }
  return `Data range ${formatValue(current.dataMin)} – ${formatValue(
    current.dataMax,
  )}`;
});

// The show/hide toggle is part of the persisted legend state (shared via the
// configuration, like the mapping itself).
function setShowLegend(show: boolean) {
  const current = legend.value;
  if (!current) {
    return;
  }
  store.saveColorByProperty({ ...current, showLegend: show });
}

defineExpose({
  legend,
  displayedCategories,
  hiddenCategoryCount,
  gradientStyle,
  formatValue,
  lowLabel,
  highLabel,
  extentTitle,
  setShowLegend,
});
</script>

<style lang="scss" scoped>
.color-legend-anchor {
  position: absolute;
  left: 16px;
  bottom: 96px;
  /* Below the layer-info popup (z 1000, expands up from bottom:40 over this
     region in ImageViewer.vue) so that transient panel wins while open, and
     above the map (z 200). */
  z-index: 999;
  /* Slide smoothly with the rest of the bottom-left cluster. */
  transition: transform 0.2s ease;
}

/* Slide right of the open left-palette column like the rest of the
   bottom-left cluster (layer-info/lock/reset buttons, progress bars).
   `.left-palettes-open` is set on <v-app> by App.vue (an ancestor); scoped
   CSS adds the data-v attribute to the last compound selector only, so the
   ancestor class still matches. */
.left-palettes-open .color-legend-anchor {
  transform: translateX(calc(var(--nimbus-left-palette-clear-x) - 16px));
}

.color-legend-panel {
  min-width: 130px;
  max-width: 220px;
  padding: 8px 10px;
  border-radius: 6px;
  font-size: 12px;

  .v-theme--dark & {
    background: rgba(20, 22, 28, 0.85);
    border: 1px solid rgba(255, 255, 255, 0.08);
  }
  .v-theme--light & {
    background: rgba(255, 255, 255, 0.9);
    border: 1px solid rgba(0, 0, 0, 0.08);
  }
}

.legend-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  margin-bottom: 6px;
}

.legend-title {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.legend-continuous {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.legend-gradient {
  width: 100%;
  height: 12px;
  border-radius: 3px;
}

.legend-gradient-labels {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-variant-numeric: tabular-nums;
}

.legend-categories {
  max-height: 240px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.legend-category {
  display: flex;
  align-items: center;
  gap: 6px;
}

.legend-swatch {
  flex: 0 0 auto;
  width: 12px;
  height: 12px;
  border-radius: 3px;
}

.legend-category-label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.legend-category-count {
  flex: 0 0 auto;
  opacity: 0.6;
}

.legend-more {
  opacity: 0.6;
  padding-left: 18px;
}
</style>

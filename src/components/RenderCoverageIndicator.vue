<template>
  <div
    v-if="coverage.show"
    class="render-coverage"
    aria-live="polite"
    :title="`Annotation rendering coverage for the current view. When large, only a subset is drawn at a time for performance — zoom in or filter to see more. ${coverage.totalLabel} in this dataset.`"
  >
    <span class="render-coverage__label">
      {{ coverage.shownLabel }}
      <!-- Both counts above are computed AFTER filters and analysis gates, so
           a restored gate can make the HUD read "826 of 826" in a viewport
           that visibly holds thousands. The suffix says narrowing is active,
           its tooltip says which, and clicking it opens the panel that owns
           it — the palette badges are too far from the count being read. -->
      <button
        v-if="coverage.constraintLabel"
        type="button"
        class="render-coverage__constraints"
        :title="constraintTooltip"
        :aria-label="constraintTooltip"
        @click="openConstraintPanels"
      >
        {{ coverage.constraintLabel }}
      </button>
    </span>
    <div class="render-coverage__track">
      <div
        class="render-coverage__fill"
        :style="{ width: `${(coverage.fraction * 100).toFixed(1)}%` }"
      />
    </div>
    <!-- One interpolation (not sibling nodes) so the space between the total
         and the passing count cannot be dropped by template whitespace
         handling. -->
    <span class="render-coverage__suffix">{{
      coverage.passingLabel
        ? `${coverage.totalLabel} ${coverage.passingLabel}`
        : coverage.totalLabel
    }}</span>

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
import store from "@/store";
import annotationStore from "@/store/annotation";
import connectionListStore from "@/store/connectionList";
import filterStore from "@/store/filters";
import propertyStore from "@/store/properties";
import { TRequestablePalette } from "@/store/model";
import { summarizeActiveConstraints } from "@/utils/activeConstraints";
import { computeRenderCoverage } from "@/utils/renderCoverage";
import VisibilitySettings from "@/components/VisibilitySettings.vue";

// Shows how much of what's in the CURRENT VIEWPORT is actually drawn (the "am I
// seeing everything here?" metric), with the dataset total as context. Always
// visible in stub (large-dataset) mode — a stable readout and the home for the
// rendering-settings gear.

// "Stub mode" for display purposes, derived REACTIVELY (not the load-time
// stubOnlyMode data flag): the dataset was loaded stub-only, OR its count now
// exceeds the stub-mode threshold. Lowering the threshold below the count in
// the settings therefore surfaces the indicator immediately, without a reload —
// annotationStubs (replaced on load) and visibilityConfig (replaced on every
// settings change) are both reactive, so this recomputes when either changes.
const stubMode = computed(
  () =>
    annotationStore.stubOnlyMode ||
    annotationStore.annotationStubs.size >
      annotationStore.visibilityConfig.stubThreshold,
);

// Filters AND analysis gates, from the one list the app-bar badges count too
// (utils/activeConstraints.ts), so the three surfaces cannot disagree.
const constraints = computed(() => filterStore.activeConstraints);

const coverage = computed(() =>
  computeRenderCoverage({
    stubMode: stubMode.value,
    viewportShown: annotationStore.viewportRenderedCount,
    viewportTotal: annotationStore.viewportAnnotationCount,
    loaded: annotationStore.annotationStubs.size,
    constraintCount: constraints.value.length,
    // The lens-aware count, NOT filteredAnnotations.length: the track-object
    // opt-in hides whole tracks after the ordinary filters run, and the raw
    // length would claim they all "pass filters" while they are hidden. A
    // plain cached length read while the lens is off.
    passingCount: connectionListStore.displayedPassingCount,
  }),
);

// Which palettes own the active constraints, Analysis first: it is a primary
// palette, and Filters is a companion that hosts alongside it — opening them
// the other way round would close the one just opened.
const constraintPalettes = computed<TRequestablePalette[]>(() => {
  const palettes: TRequestablePalette[] = [];
  if (
    constraints.value.some((constraint) => constraint.source === "analysis")
  ) {
    palettes.push("analysisPanel");
  }
  // The track filter lives in the Object Browser's Connections tab — but the
  // Object Browser and Analysis are mutually-evicting right-zone primaries
  // (App.vue paletteRoles), so requesting both would open Analysis and then
  // immediately evict it. When both constraint sources are active, Analysis
  // wins the click; the tooltip derives from this list, so it names only what
  // actually opens. (PR #1340 Codex P2.)
  else if (
    constraints.value.some((constraint) => constraint.source === "connections")
  ) {
    palettes.push("annotationPanel");
  }
  if (constraints.value.some((constraint) => constraint.source === "filters")) {
    palettes.push("filtersPanel");
  }
  return palettes;
});

const PALETTE_NAMES: Record<TRequestablePalette, string> = {
  analysisPanel: "Analysis",
  filtersPanel: "Filters",
  annotationPanel: "the Object Browser",
};

const constraintTooltip = computed(() => {
  const summary = summarizeActiveConstraints(constraints.value, (path) =>
    propertyStore.getFullNameFromPath(path),
  );
  const names = constraintPalettes.value.map((id) => PALETTE_NAMES[id]);
  return `Objects are narrowed by ${summary}. Click to open ${names.join(" and ")}.`;
});

function openConstraintPanels() {
  store.requestPaletteOpen(constraintPalettes.value);
}
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

.render-coverage__constraints {
  // A real <button> (it is clickable and focusable), stripped back to text so
  // it reads as part of the sentence rather than as a form control.
  background: none;
  border: 0;
  padding: 0;
  // Explicit, so the gap does not depend on how the template's whitespace
  // survives compilation.
  margin-left: 4px;
  // Warning-tinted and underlined: the reason the counts are smaller than the
  // eye expects, sitting on the line the user is actually reading.
  color: rgb(var(--v-theme-warning));
  font: inherit;
  text-decoration: underline dotted;
  text-underline-offset: 2px;
  cursor: pointer;
  // Re-enable clicks on just this button (the container is click-through).
  pointer-events: auto;

  &:hover,
  &:focus-visible {
    text-decoration: underline solid;
  }
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

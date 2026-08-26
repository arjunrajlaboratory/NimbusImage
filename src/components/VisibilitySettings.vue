<template>
  <div class="visibility-settings">
    <p v-if="showBlurb" class="settings-blurb">
      <v-icon size="x-small" class="settings-blurb__icon"
        >mdi-information-outline</v-icon
      >
      <span>
        For datasets with very large annotation counts (e.g. spatial data),
        NimbusImage renders a subset at a time to stay responsive. These tune
        that behavior — the defaults suit most datasets, and showing more
        annotations at once makes panning large datasets slower.
      </span>
    </p>

    <section class="overview-settings">
      <div class="overview-settings__title">Annotation overview</div>
      <v-switch
        v-model="overviewEnabled"
        label="Annotation overview raster"
        density="compact"
        hide-details
        v-description="{
          section: 'Annotation rendering',
          title: 'Annotation overview raster',
          description:
            'Show every annotation in a server-rendered raster while zoomed out, then switch to interactive vectors near full resolution.',
        }"
      />
      <div class="overview-settings__controls">
        <v-select
          v-model="overviewMode"
          :items="overviewModeItems"
          item-title="title"
          item-value="value"
          label="Overview style"
          density="compact"
          hide-details
          :disabled="!overviewEnabled"
        />
        <v-text-field
          v-model.number="overviewThresholdDraft"
          label="Vector switch (image px / screen px)"
          type="number"
          step="0.1"
          :min="overviewThresholdBounds.min"
          :max="overviewThresholdBounds.max"
          density="compact"
          hide-details
          :disabled="!overviewEnabled"
          @blur="commitOverviewThreshold"
          @keydown.enter="commitOverviewThreshold"
        />
      </div>
      <div class="overview-opacity-row">
        <span class="text-caption">Raster opacity</span>
        <v-slider
          v-model="overviewOpacityDraft"
          :min="overviewOpacityBounds.min"
          :max="overviewOpacityBounds.max"
          step="0.05"
          density="compact"
          hide-details
          :disabled="!overviewEnabled"
          @end="commitOverviewOpacity"
        />
        <span class="text-caption overview-opacity-value">
          {{ Math.round(overviewOpacityDraft * 100) }}%
        </span>
      </div>
      <p class="overview-settings__note">
        Display-only while active; interactive vectors return when zoomed in.
        The raster hides while frames are unrolled.
      </p>
    </section>

    <div v-for="field in numericFields" :key="field.key" class="field-row">
      <v-text-field
        v-model.number="draft[field.key]"
        :label="field.label"
        type="number"
        :step="field.step"
        :min="bounds[field.key].min"
        :max="bounds[field.key].max"
        density="compact"
        hide-details
        @blur="commitField(field.key)"
        @keydown.enter="commitField(field.key)"
        v-description="{
          section: 'Annotation rendering',
          title: field.label,
          description: field.description,
        }"
      >
        <template #append-inner>
          <v-tooltip location="top" max-width="320">
            <template #activator="{ props: tipProps }">
              <v-icon size="x-small" class="info-icon" v-bind="tipProps">
                mdi-information-outline
              </v-icon>
            </template>
            {{ field.description }}
            <br />
            <span class="info-range">
              Allowed {{ bounds[field.key].min.toLocaleString() }}–{{
                bounds[field.key].max.toLocaleString()
              }}
            </span>
          </v-tooltip>
        </template>
      </v-text-field>
      <div v-if="notes[field.key]" class="adjust-note text-caption">
        {{ notes[field.key] }}
      </div>
    </div>

    <v-switch
      hide-details
      density="compact"
      v-model="revealMoreOnZoom"
      label="Reveal more when zooming in"
      v-description="{
        section: 'Annotation rendering',
        title: 'Reveal more when zooming in',
        description:
          'When off (default), the coverage target is enforced at every zoom, so the view stays at that density (uncrowded) and reveals everything only when you zoom into a sparse region. When on, the coverage target only limits the fully-zoomed-out view and more annotations are progressively revealed as you zoom in (working zooms can get crowded).',
      }"
    />

    <v-switch
      hide-details
      density="compact"
      v-model="globalThreshold"
      label="Global threshold (all layers)"
      v-description="{
        section: 'Annotation rendering',
        title: 'Global threshold',
        description:
          'When on, the visibility threshold applies to total annotations across all layers. When off, each layer is checked independently.',
      }"
    />

    <div class="reset-row">
      <v-btn
        variant="text"
        size="small"
        prepend-icon="mdi-restore"
        @click="resetToDefaults"
        v-description="{
          section: 'Annotation rendering',
          title: 'Reset to defaults',
          description:
            'Restore all annotation-rendering settings to their shipped default values.',
        }"
      >
        Reset to defaults
      </v-btn>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import annotationStore from "@/store/annotation";
import {
  VISIBILITY_BOUNDS,
  clampVisibilityConfig,
  type TVisibilityNumericKey,
} from "@/utils/visibilityConfigBounds";
import {
  ANNOTATION_OVERVIEW_OPACITY_BOUNDS,
  ANNOTATION_OVERVIEW_THRESHOLD_BOUNDS,
  clampAnnotationOverviewConfig,
} from "@/utils/annotationOverview";

withDefaults(defineProps<{ showBlurb?: boolean }>(), { showBlurb: true });

interface INumericField {
  key: TVisibilityNumericKey;
  label: string;
  description: string;
  step: number;
}

// Single source of truth for the field labels/descriptions, driving both the
// rendered controls and the HelpPanel descriptions.
const numericFields: INumericField[] = [
  {
    key: "stubThreshold",
    label: "Stub mode threshold",
    description:
      "Dataset annotation count above which stub-only (lazy) mode activates: stubs load first and coordinates/property values load on demand. Independent of the render budget below.",
    step: 1000,
  },
  {
    key: "maxVisible",
    label: "Max visible annotations",
    description:
      "Maximum annotations drawn per frame (as dots or shapes). Also the size gate — datasets at or below this render fully at every zoom. Higher shows more at once but makes panning large datasets slower.",
    step: 1000,
  },
  {
    key: "minimumVisible",
    label: "Minimum visible annotations",
    description:
      "Floor on the zoom-adaptive budget: at least this many are drawn at any zoom (never more than Max visible). A view holding fewer than this shows everything; a busier view shows at least this many (or the zoom-rule count, whichever is higher). Set to 0 to defer entirely to the zoom rule.",
    step: 1000,
  },
  {
    key: "maxHydrated",
    label: "Max hydrated annotations",
    description:
      "Maximum annotations drawn as full shapes per refresh; the rest show as dots. Cannot exceed Max visible.",
    step: 1000,
  },
  {
    key: "hydrationCacheCap",
    label: "Hydration cache cap",
    description:
      "Total cap on cached full-shape annotations. Accumulates across pans/zooms; least-recently-used are evicted past the cap (selected are protected until the selection alone exceeds the cap, a hard ceiling). Cannot be below Max hydrated.",
    step: 1000,
  },
  {
    key: "coverageTarget",
    label: "Coverage target",
    description:
      "Target fraction of the screen the rendered dots may cover (only for datasets larger than the render cap). Lower = sparser. With 'Reveal more when zooming in' OFF (default) it is evaluated at the current zoom, so density stays ~constant; with it ON it sets the zoomed-out budget, which doubles per zoom level up to the cap. Minimum visible can raise either budget.",
    step: 0.05,
  },
  {
    key: "viewportRefreshFraction",
    label: "Zoom refresh threshold",
    description:
      "How much the zoom magnification must change (e.g. 0.2 = 20%) before the view re-renders and re-hydrates. Higher = fewer refreshes / less loading churn while zooming. Panning always refreshes, so this affects zoom only.",
    step: 0.05,
  },
];

const bounds = VISIBILITY_BOUNDS;
const overviewOpacityBounds = ANNOTATION_OVERVIEW_OPACITY_BOUNDS;
const overviewThresholdBounds = ANNOTATION_OVERVIEW_THRESHOLD_BOUNDS;
const overviewModeItems = [
  { title: "Filled footprints", value: "shapes" as const },
  { title: "Centroid discs", value: "discs" as const },
];
const overviewOpacityDraft = ref(annotationStore.overviewConfig.opacity);
const overviewThresholdDraft = ref(
  annotationStore.overviewConfig.vectorSwitchThreshold,
);

// Local editable copy of the numeric fields (free typing; committed on blur).
const draft = reactive<Record<TVisibilityNumericKey, number>>(
  numericFields.reduce(
    (acc, field) => {
      acc[field.key] = annotationStore.visibilityConfig[field.key];
      return acc;
    },
    {} as Record<TVisibilityNumericKey, number>,
  ),
);

const notes = reactive<Partial<Record<TVisibilityNumericKey, string>>>({});
const noteTimers: Partial<Record<TVisibilityNumericKey, number>> = {};

// VisibilitySettings can mount before the selected configuration finishes
// loading. Keep the editable numeric draft aligned when persisted settings are
// hydrated or when the user switches configurations.
watch(
  () => annotationStore.visibilityConfig,
  (config) => {
    for (const field of numericFields) {
      draft[field.key] = config[field.key];
    }
  },
);

watch(
  () => annotationStore.overviewConfig,
  (config) => {
    overviewOpacityDraft.value = config.opacity;
    overviewThresholdDraft.value = config.vectorSwitchThreshold;
  },
);

function flashNote(key: TVisibilityNumericKey, value: number) {
  notes[key] = `Adjusted to ${value.toLocaleString()}`;
  if (noteTimers[key] !== undefined) {
    window.clearTimeout(noteTimers[key]);
  }
  noteTimers[key] = window.setTimeout(() => {
    delete notes[key];
  }, 4000);
}

// Clear pending flashNote timers on unmount so a callback can't fire and mutate
// reactive state on a destroyed component (Finding 9).
onBeforeUnmount(() => {
  for (const timer of Object.values(noteTimers)) {
    if (timer !== undefined) {
      window.clearTimeout(timer);
    }
  }
});

function commitField(key: TVisibilityNumericKey) {
  const { config, adjusted } = clampVisibilityConfig(
    { [key]: draft[key] },
    annotationStore.visibilityConfig,
  );
  annotationStore.updateVisibilityConfig(config);
  // Reflect the accepted values back into the inputs (covers cross-field
  // changes to fields the user didn't touch).
  for (const field of numericFields) {
    draft[field.key] = config[field.key];
  }
  for (const adjustedKey of adjusted) {
    flashNote(adjustedKey, config[adjustedKey]);
  }
}

const globalThreshold = computed({
  get: () => annotationStore.visibilityConfig.globalThreshold,
  set: (value: boolean) => {
    annotationStore.updateVisibilityConfig({ globalThreshold: value });
  },
});

const revealMoreOnZoom = computed({
  get: () => annotationStore.visibilityConfig.revealMoreOnZoom,
  set: (value: boolean) => {
    annotationStore.updateVisibilityConfig({ revealMoreOnZoom: value });
  },
});

const overviewEnabled = computed({
  get: () => annotationStore.overviewConfig.enabled,
  set: (enabled: boolean) => annotationStore.updateOverviewConfig({ enabled }),
});

const overviewMode = computed({
  get: () => annotationStore.overviewConfig.mode,
  set: (mode: "shapes" | "discs") =>
    annotationStore.updateOverviewConfig({ mode }),
});

function commitOverviewOpacity() {
  const config = clampAnnotationOverviewConfig({
    ...annotationStore.overviewConfig,
    opacity: overviewOpacityDraft.value,
  });
  overviewOpacityDraft.value = config.opacity;
  annotationStore.updateOverviewConfig({ opacity: config.opacity });
}

function commitOverviewThreshold() {
  const config = clampAnnotationOverviewConfig({
    ...annotationStore.overviewConfig,
    vectorSwitchThreshold: overviewThresholdDraft.value,
  });
  overviewThresholdDraft.value = config.vectorSwitchThreshold;
  annotationStore.updateOverviewConfig({
    vectorSwitchThreshold: config.vectorSwitchThreshold,
  });
}

function resetToDefaults() {
  annotationStore.resetVisibilityConfig();
  annotationStore.resetOverviewConfig();
  // Reflect the restored values back into the inputs and clear any pending
  // "adjusted" notes/timers.
  for (const field of numericFields) {
    draft[field.key] = annotationStore.visibilityConfig[field.key];
  }
  for (const key of Object.keys(notes) as TVisibilityNumericKey[]) {
    if (noteTimers[key] !== undefined) {
      window.clearTimeout(noteTimers[key]);
      delete noteTimers[key];
    }
    delete notes[key];
  }
}
</script>

<style lang="scss" scoped>
.settings-blurb {
  // Info-note styling: small, muted, with a leading info icon. Font size is set
  // explicitly (not via the text-caption utility) so it wins over Vuetify's
  // cascade-layered utilities, which an unlayered parent rule was overriding —
  // that override is what made this blurb render at the surrounding body size.
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 0.72rem;
  line-height: 1.45;
  letter-spacing: 0.01em;
  opacity: 0.7;
  margin-bottom: 10px;
}

.settings-blurb__icon {
  flex: 0 0 auto;
  margin-top: 1px;
  color: rgb(var(--v-theme-info));
  opacity: 0.9;
}

.field-row {
  margin-bottom: 10px;
}

.overview-settings {
  padding: 10px;
  margin-bottom: 14px;
  border: 1px solid rgb(var(--v-theme-on-surface) / 12%);
  border-radius: 6px;
}

.overview-settings__title {
  margin-bottom: 2px;
  font-size: 0.8rem;
  font-weight: 600;
}

.overview-settings__controls {
  display: grid;
  grid-template-columns: 1fr 1.3fr;
  gap: 10px;
  margin: 8px 0;
}

.overview-opacity-row {
  display: grid;
  grid-template-columns: auto 1fr 36px;
  gap: 8px;
  align-items: center;
}

.overview-opacity-value {
  text-align: right;
}

.overview-settings__note {
  margin: 2px 0 0;
  font-size: 0.7rem;
  line-height: 1.4;
  opacity: 0.65;
}

.info-icon {
  opacity: 0.6;
  cursor: help;
}

.info-range {
  opacity: 0.8;
}

.adjust-note {
  margin-top: 2px;
  color: rgb(var(--v-theme-warning));
}

.reset-row {
  display: flex;
  justify-content: flex-end;
  margin-top: 8px;
}
</style>

<template>
  <div class="visibility-settings">
    <p v-if="showBlurb" class="settings-blurb text-caption">
      For datasets with very large annotation counts (e.g. spatial data),
      NimbusImage renders a subset at a time to stay responsive. These tune that
      behavior — the defaults suit most datasets, and showing more annotations
      at once makes panning large datasets slower.
    </p>

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
      v-model="globalThreshold"
      label="Global threshold (all layers)"
      v-description="{
        section: 'Annotation rendering',
        title: 'Global threshold',
        description:
          'When on, the visibility threshold applies to total annotations across all layers. When off, each layer is checked independently.',
      }"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive } from "vue";
import annotationStore from "@/store/annotation";
import {
  VISIBILITY_BOUNDS,
  clampVisibilityConfig,
  type TVisibilityNumericKey,
} from "@/utils/visibilityConfigBounds";

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
    label: "Zoomed-out coverage target",
    description:
      "Fraction of the screen the rendered dots may cover when fully zoomed out (only for datasets larger than the render cap). Lower = sparser, cleaner overview. The budget doubles per zoom level up to the cap.",
    step: 0.05,
  },
  {
    key: "viewportRefreshFraction",
    label: "Viewport refresh threshold",
    description:
      "How much the zoom (magnification) or pan (fraction of the viewport) must change (e.g. 0.2 = 20%) before the view re-renders and re-hydrates. Higher = fewer refreshes / less loading churn while navigating.",
    step: 0.05,
  },
];

const bounds = VISIBILITY_BOUNDS;

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
  annotationStore.setVisibilityConfig(config);
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
    annotationStore.setVisibilityConfig({ globalThreshold: value });
  },
});
</script>

<style lang="scss" scoped>
.settings-blurb {
  opacity: 0.8;
  margin-bottom: 8px;
}

.field-row {
  margin-bottom: 10px;
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
</style>

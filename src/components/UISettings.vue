<template>
  <section class="settings-section">
    <h4 class="settings-section-title">Interface</h4>
    <div class="settings-section-body">
      <v-switch
        hide-details
        density="compact"
        v-model="darkMode"
        label="Dark mode"
        v-description="{
          section: 'Interface settings',
          title: 'Dark mode',
          description: 'Enable dark mode',
        }"
      />
      <v-divider class="settings-divider" />

      <v-expansion-panels v-model="advancedOpen" flat class="advanced-panels">
        <v-expansion-panel value="advanced">
          <v-expansion-panel-title class="advanced-title">
            Advanced settings for large numbers of annotations
          </v-expansion-panel-title>
          <v-expansion-panel-text>
            <p class="settings-blurb text-caption">
              For datasets with very large annotation counts (e.g. spatial
              data), NimbusImage renders a subset at a time to stay responsive.
              These tune that behavior — the defaults suit most datasets, and
              showing more annotations at once makes panning large datasets
              slower.
            </p>

            <div
              v-for="field in numericFields"
              :key="field.key"
              class="field-row"
            >
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
                      <v-icon
                        size="x-small"
                        class="info-icon"
                        v-bind="tipProps"
                      >
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
          </v-expansion-panel-text>
        </v-expansion-panel>
      </v-expansion-panels>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { useTheme } from "vuetify";
import annotationStore from "@/store/annotation";
import Persister from "@/store/Persister";
import {
  VISIBILITY_BOUNDS,
  clampVisibilityConfig,
  type TVisibilityNumericKey,
} from "@/utils/visibilityConfigBounds";

const theme = useTheme();

const darkMode = computed({
  get: () => theme.global.name.value === "dark",
  set: (value: boolean) => {
    theme.global.name.value = value ? "dark" : "light";
  },
});

// Disclosure open state, persisted so a power user who opens it keeps it open.
const PERSIST_KEY = "uiSettingsAdvancedOpen";
const advancedOpen = ref<string | undefined>(
  Persister.get(PERSIST_KEY, false) ? "advanced" : undefined,
);
watch(advancedOpen, (value) => {
  Persister.set(PERSIST_KEY, value === "advanced");
});

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
      "Total cap on cached full-shape annotations. Accumulates across pans/zooms; least-recently-used are evicted past the cap (selected are never evicted). Cannot be below Max hydrated.",
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

defineExpose({ darkMode });
</script>

<style lang="scss" scoped>
.advanced-panels {
  // Strip the card chrome so the disclosure reads as part of the settings list.
  :deep(.v-expansion-panel) {
    background: transparent;
  }
  :deep(.v-expansion-panel-title) {
    min-height: 36px;
    padding: 6px 0;
    font-size: 13px;
  }
  :deep(.v-expansion-panel-text__wrapper) {
    padding: 4px 0 0;
  }
}

.advanced-title {
  font-weight: 500;
}

.settings-blurb {
  margin-bottom: 12px;
  opacity: 0.75;
  line-height: 1.4;
}

.field-row {
  margin-bottom: 10px;
}

.info-icon {
  opacity: 0.6;
  cursor: help;
}

.info-range {
  opacity: 0.85;
}

.adjust-note {
  margin-top: 2px;
  color: rgb(var(--v-theme-warning));
}
</style>

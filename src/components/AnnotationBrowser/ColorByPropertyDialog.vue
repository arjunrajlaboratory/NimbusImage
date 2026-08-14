<template>
  <v-dialog v-model="showDialog" max-width="560px">
    <v-card>
      <v-card-title>Color annotations by property</v-card-title>
      <v-card-text>
        <div class="mb-3 text-caption">
          Assigns each annotation's color from its value for a property.
          Annotations without a value for the property fall back to their layer
          color. Applying replaces the current colors of
          <strong>every</strong> annotation in the dataset — including manually
          assigned ones — and cannot be undone.
        </div>
        <v-autocomplete
          v-model="selectedPathKey"
          :items="propertyItems"
          label="Property"
          density="compact"
          variant="outlined"
          hide-details
          class="mb-4"
        />
        <div class="mode-row mb-4">
          <span class="text-caption mr-3">Mode</span>
          <v-btn-toggle
            v-model="mode"
            mandatory
            density="compact"
            variant="outlined"
            color="primary"
          >
            <v-btn value="auto" size="x-small">Auto</v-btn>
            <v-btn value="continuous" size="x-small">Continuous</v-btn>
            <v-btn value="categorical" size="x-small">Categorical</v-btn>
          </v-btn-toggle>
        </div>
        <template v-if="mode !== 'categorical'">
          <v-select
            v-model="colormap"
            :items="colormapNames"
            label="Colormap"
            density="compact"
            variant="outlined"
            hide-details
            class="mb-4"
          >
            <template v-slot:item="{ item, props: itemProps }">
              <v-list-item v-bind="itemProps">
                <template #append>
                  <span class="colormap-preview" :style="gradientStyle(item)" />
                </template>
              </v-list-item>
            </template>
            <template v-slot:selection="{ item }">
              <span class="mr-2">{{ item }}</span>
              <span class="colormap-preview" :style="gradientStyle(item)" />
            </template>
          </v-select>
          <div class="text-caption mb-2">
            The color ramp spans percentiles by default, so a few outliers can't
            flatten it. Values outside the range take the end colors.
          </div>
          <v-row density="comfortable">
            <v-col cols="6">
              <v-text-field
                v-model="percentileLowText"
                label="Low percentile"
                :placeholder="String(DEFAULT_PERCENTILE_LOW)"
                :error-messages="boundErrors.percentileLow ?? []"
                type="number"
                density="compact"
                variant="outlined"
                persistent-placeholder
                hide-details="auto"
              />
            </v-col>
            <v-col cols="6">
              <v-text-field
                v-model="percentileHighText"
                label="High percentile"
                :placeholder="String(DEFAULT_PERCENTILE_HIGH)"
                :error-messages="boundErrors.percentileHigh ?? []"
                type="number"
                density="compact"
                variant="outlined"
                persistent-placeholder
                hide-details="auto"
              />
            </v-col>
          </v-row>
          <v-row density="comfortable">
            <v-col cols="6">
              <v-text-field
                v-model="rangeMinText"
                label="Min value (overrides)"
                :error-messages="boundErrors.rangeMin ?? []"
                type="number"
                density="compact"
                variant="outlined"
                hide-details="auto"
              />
            </v-col>
            <v-col cols="6">
              <v-text-field
                v-model="rangeMaxText"
                label="Max value (overrides)"
                :error-messages="boundErrors.rangeMax ?? []"
                type="number"
                density="compact"
                variant="outlined"
                hide-details="auto"
              />
            </v-col>
          </v-row>
        </template>
        <v-alert
          v-if="errorMessage"
          type="error"
          variant="tonal"
          density="compact"
          class="mt-4"
        >
          {{ errorMessage }}
        </v-alert>
      </v-card-text>
      <v-card-actions class="button-bar">
        <!-- Disabled, not hidden, when logged out: an unauthenticated viewer
             of a public dataset still sees the active coloring, but the
             endpoint requires an authenticated write token (same rule as
             Apply and the menu entries). -->
        <v-btn
          v-if="hasActiveColoring"
          variant="text"
          color="error"
          size="small"
          :disabled="isApplying || !store.isLoggedIn"
          @click="removeColoring"
        >
          Remove coloring
        </v-btn>
        <v-spacer />
        <v-btn variant="text" size="small" @click="showDialog = false">
          Cancel
        </v-btn>
        <v-btn
          variant="flat"
          color="primary"
          size="small"
          :loading="isApplying"
          :disabled="!canApply || isApplying"
          @click="apply"
        >
          Apply
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from "vue";
import store from "@/store";
import annotationStore from "@/store/annotation";
import propertyStore from "@/store/properties";
import { IColorByPropertyOptions } from "@/store/model";
import { cssLinearGradient } from "@/utils/colors";
import { extractErrorMessage } from "@/utils/errors";
import { createPathStringFromPathArray } from "@/utils/paths";
import { logError } from "@/utils/log";

type TColorByMode = "auto" | "continuous" | "categorical";

// Shown as placeholders; the server applies these when the fields are blank
// (Annotation.DEFAULT_PERCENTILE_LOW/HIGH).
const DEFAULT_PERCENTILE_LOW = 1;
const DEFAULT_PERCENTILE_HIGH = 99;

const props = defineProps<{
  show: boolean;
}>();

const emit = defineEmits<{
  (e: "update:show", value: boolean): void;
}>();

const showDialog = computed({
  get: () => props.show,
  set: (value: boolean) => emit("update:show", value),
});

const selectedPathKey = ref<string | null>(null);
const mode = ref<TColorByMode>("auto");
const colormap = ref("viridis");
const rangeMinText = ref("");
const rangeMaxText = ref("");
const percentileLowText = ref("");
const percentileHighText = ref("");
const isApplying = ref(false);
const errorMessage = ref<string | null>(null);
const options = ref<IColorByPropertyOptions | null>(null);

const propertyItems = computed(() =>
  propertyStore.computedPropertyPaths.map((path) => ({
    title: propertyStore.getFullNameFromPath(path) ?? path.join(" / "),
    value: createPathStringFromPathArray(path),
  })),
);

const pathByKey = computed(() => {
  const map = new Map<string, string[]>();
  for (const path of propertyStore.computedPropertyPaths) {
    map.set(createPathStringFromPathArray(path), path);
  }
  return map;
});

const colormapNames = computed(() =>
  options.value ? Object.keys(options.value.colormaps) : ["viridis"],
);

const hasActiveColoring = computed(
  () => !!store.colorByPropertyForCurrentDataset,
);

// Invalid numeric text must be a distinct state from blank, not collapse
// into it: parseBound maps both to undefined, and a request sent without the
// bound recolors every annotation with the DEFAULT range — a destructive,
// non-undoable operation the user thought they had constrained. "1e309"
// parses to Infinity and a partial exponent to NaN; both must block Apply.
function boundError(text: string): string | null {
  const trimmed = text.trim();
  return trimmed === "" || Number.isFinite(Number(trimmed))
    ? null
    : "Not a finite number";
}

const boundErrors = computed(() => ({
  rangeMin: boundError(rangeMinText.value),
  rangeMax: boundError(rangeMaxText.value),
  percentileLow: boundError(percentileLowText.value),
  percentileHigh: boundError(percentileHighText.value),
}));

// Categorical mode hides the range fields and apply() never sends them, so
// stale invalid text from continuous mode must not block an apply about
// fields the user can no longer see (twin of the send-side guard in apply).
const hasInvalidBound = computed(
  () =>
    mode.value !== "categorical" &&
    Object.values(boundErrors.value).some((error) => error !== null),
);

// The dialog instance survives dataset/configuration switches (the browser
// palette stays mounted), so a previously selected path may no longer exist.
// Requiring a live pathByKey entry keeps Apply from being an enabled no-op.
const canApply = computed(
  () =>
    store.isLoggedIn &&
    selectedPathKey.value !== null &&
    pathByKey.value.has(selectedPathKey.value) &&
    !hasInvalidBound.value,
);

function gradientStyle(name: string) {
  const stops = options.value?.colormaps[name];
  if (!stops) {
    return {};
  }
  return { background: cssLinearGradient(stops, "to right") };
}

// The colormap catalog comes from the backend (single source of truth for
// the gradients); fetch it once, the first time the dialog opens.
watch(showDialog, async (open) => {
  if (!open) {
    return;
  }
  errorMessage.value = null;
  if (!options.value) {
    try {
      options.value = await store.annotationsAPI.getColorByPropertyOptions();
      colormap.value = options.value.default;
    } catch (error) {
      logError(`Failed to fetch colormap options: ${(error as Error).message}`);
    }
  }
});

function parseBound(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === "") {
    return undefined;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

async function apply() {
  const propertyPath = selectedPathKey.value
    ? pathByKey.value.get(selectedPathKey.value)
    : undefined;
  if (!propertyPath) {
    return;
  }
  isApplying.value = true;
  errorMessage.value = null;
  try {
    // The store action owns the apply invariant (backend colors ⇒ local
    // apply from the returned assignment ⇒ legend in configuration); the
    // dialog only holds form state.
    // Categorical ignores the colormap and range entirely, and its fields are
    // hidden — so don't send them. A stale invalid pair left over from
    // continuous mode (Min 100 / Max 50) would otherwise 400 a categorical
    // apply, complaining about fields the user can no longer see.
    const rangeParams =
      mode.value === "categorical"
        ? {}
        : {
            colormap: colormap.value,
            rangeMin: parseBound(rangeMinText.value),
            rangeMax: parseBound(rangeMaxText.value),
            percentileLow: parseBound(percentileLowText.value),
            percentileHigh: parseBound(percentileHighText.value),
          };
    await annotationStore.applyColorByProperty({
      propertyPath,
      propertyName:
        propertyStore.getFullNameFromPath(propertyPath) ??
        propertyPath.join(" / "),
      mode: mode.value,
      ...rangeParams,
    });
    showDialog.value = false;
  } catch (error) {
    errorMessage.value = extractErrorMessage(error);
  } finally {
    isApplying.value = false;
  }
}

async function removeColoring() {
  isApplying.value = true;
  errorMessage.value = null;
  try {
    await annotationStore.removeColorByProperty();
    showDialog.value = false;
  } catch (error) {
    errorMessage.value = extractErrorMessage(error);
  } finally {
    isApplying.value = false;
  }
}

defineExpose({
  showDialog,
  selectedPathKey,
  mode,
  colormap,
  rangeMinText,
  rangeMaxText,
  percentileLowText,
  percentileHighText,
  errorMessage,
  isApplying,
  propertyItems,
  canApply,
  boundErrors,
  hasActiveColoring,
  apply,
  removeColoring,
});
</script>

<style lang="scss" scoped>
.mode-row {
  display: flex;
  align-items: center;
}

.colormap-preview {
  display: inline-block;
  width: 96px;
  height: 12px;
  border-radius: 2px;
  vertical-align: middle;
}
</style>

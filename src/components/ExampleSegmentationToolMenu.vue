<template>
  <v-card>
    <v-card-title>Options</v-card-title>

    <!-- Main menu -->
    <v-card-text v-if="exampleState">
      <div class="status-line text-body-2 mb-2">{{ statusText }}</div>

      <div class="text-subtitle-1 font-weight-bold">
        {{ putativeCount }} putative object{{ putativeCount === 1 ? "" : "s" }}
      </div>
      <div class="text-caption mb-2">
        {{ examplesTotal }} example{{ examplesTotal === 1 ? "" : "s" }} ({{
          foregroundCount
        }}
        object / {{ backgroundCount }} background)
      </div>

      <div class="mb-2">
        <div class="text-caption mb-1">Circle marks:</div>
        <v-btn-toggle
          v-model="nextPolarity"
          mandatory
          divided
          density="comfortable"
        >
          <v-btn
            value="foreground"
            variant="outlined"
            color="primary"
            size="small"
          >
            Object
          </v-btn>
          <v-btn
            value="background"
            variant="outlined"
            color="primary"
            size="small"
          >
            Background
          </v-btn>
        </v-btn-toggle>
      </div>

      <v-slider
        class="my-2"
        v-model="threshold"
        min="0.05"
        max="0.95"
        step="0.01"
        label="Threshold"
      >
        <template v-slot:append>
          <v-text-field
            v-model="threshold"
            type="number"
            min="0.05"
            max="0.95"
            step="0.01"
            style="width: 70px"
            class="mt-0 pt-0"
          >
          </v-text-field>
        </template>
      </v-slider>

      <div class="d-flex align-center mb-2">
        <v-text-field
          v-model="minSizeInput"
          type="number"
          label="Min size"
          density="compact"
          :placeholder="autoMinPlaceholder"
          class="mr-2"
          hide-details
        />
        <v-text-field
          v-model="maxSizeInput"
          type="number"
          label="Max size"
          density="compact"
          :placeholder="autoMaxPlaceholder"
          class="mr-2"
          hide-details
        />
        <v-btn
          variant="text"
          color="primary"
          size="small"
          :disabled="sizeRangeValue.min === null && sizeRangeValue.max === null"
          @click="resetSizeRangeToAuto"
        >
          Auto
        </v-btn>
      </div>

      <v-slider
        class="my-2"
        v-model="simplificationTolerance"
        min="0"
        max="10"
        step="0.01"
        label="Simplification"
      >
        <template v-slot:append>
          <v-text-field
            v-model="simplificationTolerance"
            type="number"
            min="0"
            max="10"
            step="0.01"
            style="width: 60px"
            class="mt-0 pt-0"
          >
          </v-text-field>
        </template>
      </v-slider>

      <div>
        <v-btn
          variant="outlined"
          color="primary"
          size="small"
          class="my-1"
          :disabled="examplesTotal === 0"
          @click="undoExample"
        >
          Undo example
        </v-btn>
        <v-btn
          variant="outlined"
          color="primary"
          size="small"
          class="my-1"
          :disabled="examplesTotal === 0 && putativeCount === 0"
          @click="clearAll"
        >
          Clear
        </v-btn>
        <v-btn
          variant="flat"
          color="primary"
          size="small"
          class="my-1"
          :disabled="putativeCount === 0 || isAccepting"
          :loading="isAccepting"
          @click="accept"
        >
          Accept {{ putativeCount }} annotation{{
            putativeCount === 1 ? "" : "s"
          }}
        </v-btn>
      </div>
    </v-card-text>

    <!-- Error menu -->
    <v-card-text v-else-if="errorState">
      <v-expansion-panel-text>
        <div class="d-flex">
          <code class="code-block">{{
            errorState.error ? errorState.error.message : "Unknown error"
          }}</code>
        </div>
      </v-expansion-panel-text>
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import { debounce } from "lodash";
import store from "@/store";
import annotationStore from "@/store/annotation";
import {
  ExampleSegmentationToolStateSymbol,
  IAnnotationBase,
  IToolConfiguration,
} from "@/store/model";
import { NoOutput } from "@/pipelines/computePipeline";

const DEFAULT_THRESHOLD = 0.5;
const DEFAULT_SIMPLIFICATION_TOLERANCE = 1;

const props = defineProps<{
  toolConfiguration: IToolConfiguration;
}>();

const isAccepting = ref(false);

const toolState = computed(() => {
  return store.selectedTool?.state;
});

const errorState = computed(() => {
  const state = toolState.value;
  return state && "error" in state ? state : null;
});

const exampleState = computed(() => {
  const state = toolState.value;
  return state?.type === ExampleSegmentationToolStateSymbol ? state : null;
});

const status = computed(() => exampleState.value?.status ?? null);

const examples = computed(() => exampleState.value?.examples ?? []);
const examplesTotal = computed(() => examples.value.length);
const foregroundCount = computed(
  () =>
    examples.value.filter((example) => example.polarity === "foreground")
      .length,
);
const backgroundCount = computed(
  () => examplesTotal.value - foregroundCount.value,
);

const putativeCount = computed(
  () => exampleState.value?.proposals?.length ?? 0,
);

const statusText = computed(() => {
  const currentStatus = status.value;
  if (!currentStatus) {
    return "";
  }
  switch (currentStatus.phase) {
    case "idle":
      return "Circle an example object to get started.";
    case "computing":
      return "Computing…";
    case "error":
      return currentStatus.error ?? "An error occurred.";
    case "ready": {
      const timings = currentStatus.timings ?? {};
      const parts: string[] = [];
      if (timings.trainMs != null) {
        parts.push(`trained in ${Math.round(timings.trainMs)} ms`);
      }
      if (timings.predictMs != null) {
        parts.push(`predicted in ${Math.round(timings.predictMs)} ms`);
      }
      if (timings.postprocessMs != null) {
        parts.push(`processed in ${Math.round(timings.postprocessMs)} ms`);
      }
      return parts.length ? `Ready — ${parts.join(", ")}` : "Ready";
    }
    default:
      return "";
  }
});

const autoSizeRange = computed(() => status.value?.autoSizeRange ?? null);
const autoMinPlaceholder = computed(() =>
  autoSizeRange.value ? String(Math.round(autoSizeRange.value.min)) : "Auto",
);
const autoMaxPlaceholder = computed(() =>
  autoSizeRange.value ? String(Math.round(autoSizeRange.value.max)) : "Auto",
);

const nextPolarity = computed({
  get: () => exampleState.value?.nextPolarity ?? "foreground",
  set: (value: "foreground" | "background") => {
    const state = exampleState.value;
    if (state) {
      state.nextPolarity = value;
    }
  },
});

const thresholdNode = computed(
  () => exampleState.value?.nodes.input.threshold ?? null,
);
const threshold = computed({
  get: () => {
    const value = thresholdNode.value?.output;
    return value == null || value === NoOutput ? DEFAULT_THRESHOLD : value;
  },
  set: (value: number) => {
    thresholdNode.value?.setValue(Number(value));
  },
});

const simplificationToleranceNode = computed(
  () => exampleState.value?.nodes.input.simplificationTolerance ?? null,
);
const simplificationTolerance = computed({
  get: () => {
    const value = simplificationToleranceNode.value?.output;
    return value == null || value === NoOutput
      ? DEFAULT_SIMPLIFICATION_TOLERANCE
      : value;
  },
  set: (value: number) => {
    simplificationToleranceNode.value?.setValue(Number(value));
  },
});

const sizeRangeNode = computed(
  () => exampleState.value?.nodes.input.sizeRange ?? null,
);
const sizeRangeValue = computed(() => {
  const value = sizeRangeNode.value?.output;
  return value == null || value === NoOutput ? { min: null, max: null } : value;
});

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const num = Number(value);
  return Number.isNaN(num) ? null : num;
}

const minSizeInput = computed({
  get: () => sizeRangeValue.value.min,
  set: (value: unknown) => {
    sizeRangeNode.value?.setValue({
      ...sizeRangeValue.value,
      min: toNullableNumber(value),
    });
  },
});
const maxSizeInput = computed({
  get: () => sizeRangeValue.value.max,
  set: (value: unknown) => {
    sizeRangeNode.value?.setValue({
      ...sizeRangeValue.value,
      max: toNullableNumber(value),
    });
  },
});

function resetSizeRangeToAuto() {
  sizeRangeNode.value?.setValue({ min: null, max: null });
}

function undoExample() {
  const state = exampleState.value;
  if (!state || state.examples.length === 0) {
    return;
  }
  state.nodes.input.examples.setValue(state.examples.slice(0, -1));
}

async function clearAll() {
  const state = exampleState.value;
  if (!state) {
    return;
  }
  // Drop the worker's trained model first so the examples-cleared recompute
  // below resolves to NoOutput (clearing the proposals) instead of
  // re-predicting with the stale model.
  await state.nodes.reset();
  state.nodes.input.examples.setValue([]);
}

async function accept() {
  const state = exampleState.value;
  const proposals = state?.proposals;
  const datasetId = store.dataset?.id;
  if (!state || !proposals || proposals.length === 0 || !datasetId) {
    return;
  }
  isAccepting.value = true;
  try {
    const { location, channel } =
      await annotationStore.getAnnotationLocationFromTool(
        props.toolConfiguration,
      );
    const { tags, shape, color } = props.toolConfiguration.values.annotation;
    const annotationBases: IAnnotationBase[] = proposals.map((coordinates) => ({
      tags,
      shape,
      channel,
      location,
      coordinates,
      datasetId,
      color: color ?? null,
    }));
    await annotationStore.createMultipleAnnotations(annotationBases);
    // Newly-committed annotations must be deduped out of future proposals
    // (spec §4.4 step 7), but the pipeline only recomputes proposals when one
    // of its input nodes changes - it has no dedicated "revalidate" entry
    // point and does not watch annotationStore itself. Re-setting the
    // threshold node to its own current value (immediate, bypassing the
    // debounce) is the cheapest available lever: it only re-triggers the
    // cheap postprocess -> proposals chain (no retrain), and
    // computeProposals re-reads annotationStore.annotations fresh each time.
    thresholdNode.value?.setValue(threshold.value, true);
  } finally {
    isAccepting.value = false;
  }
}

const toolValuesChangedImpl = () => {
  const changedValues = {
    threshold: threshold.value,
    simplificationTolerance: simplificationTolerance.value,
  };
  const originalValues = props.toolConfiguration.values;
  let modified = false;
  for (const [key, value] of Object.entries(changedValues)) {
    if (originalValues[key] !== value) {
      modified = true;
      break;
    }
  }
  if (!modified) {
    return;
  }
  const newToolValues = { ...originalValues, ...changedValues };
  const newTool = {
    ...props.toolConfiguration,
    values: newToolValues,
  };
  store.editToolInConfiguration(newTool);
};
const toolValuesChanged = debounce(toolValuesChangedImpl, 1000, {
  leading: false,
  trailing: true,
});

watch(threshold, () => {
  toolValuesChanged();
});

watch(simplificationTolerance, () => {
  toolValuesChanged();
});

onMounted(() => {
  const configuredThreshold = Number(props.toolConfiguration.values.threshold);
  if (!Number.isNaN(configuredThreshold)) {
    threshold.value = configuredThreshold;
  }
  const configuredSimplification = Number(
    props.toolConfiguration.values.simplificationTolerance,
  );
  if (!Number.isNaN(configuredSimplification)) {
    simplificationTolerance.value = configuredSimplification;
  }
});

defineExpose({
  isAccepting,
  toolState,
  errorState,
  exampleState,
  status,
  examples,
  examplesTotal,
  foregroundCount,
  backgroundCount,
  putativeCount,
  statusText,
  autoSizeRange,
  autoMinPlaceholder,
  autoMaxPlaceholder,
  nextPolarity,
  thresholdNode,
  threshold,
  simplificationToleranceNode,
  simplificationTolerance,
  sizeRangeNode,
  sizeRangeValue,
  minSizeInput,
  maxSizeInput,
  resetSizeRangeToAuto,
  undoExample,
  clearAll,
  accept,
  toolValuesChanged,
});
</script>

<style lang="scss" scoped>
.status-line {
  opacity: 0.8;
}
</style>

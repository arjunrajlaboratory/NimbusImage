<template>
  <v-card>
    <v-card-title>Options</v-card-title>

    <!-- Main menu -->
    <v-card-text v-if="similarityState">
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
        <div class="text-caption mb-1">Click marks:</div>
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

      <div class="d-flex align-center mb-1">
        <span class="text-caption mr-1">Similarity</span>
        <v-tooltip
          text="Expressed as a fraction of the examples' own mutual similarity, not an absolute score."
        >
          <template v-slot:activator="{ props: tooltipProps }">
            <v-icon v-bind="tooltipProps" size="14"
              >mdi-information-outline</v-icon
            >
          </template>
        </v-tooltip>
      </div>
      <v-slider
        class="my-2"
        v-model="similarityThreshold"
        min="0.05"
        max="0.95"
        step="0.01"
        label="Similarity"
      >
        <template v-slot:append>
          <v-text-field
            v-model="similarityThreshold"
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

      <v-select
        v-model="promptMode"
        :items="promptModeItems"
        item-title="text"
        item-value="value"
        label="Prompt mode"
        density="compact"
        hide-details
        class="mb-3"
      />

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
import { computed, ref, watch, onMounted } from "vue";
import { debounce } from "lodash";
import store from "@/store";
import annotationStore from "@/store/annotation";
import {
  IAnnotationBase,
  IToolConfiguration,
  SamSimilarityToolStateSymbol,
} from "@/store/model";
import { NoOutput } from "@/pipelines/computePipeline";

const DEFAULT_SIMILARITY_THRESHOLD = 0.5;
const DEFAULT_SIMPLIFICATION_TOLERANCE = 1;
type TPromptMode = "point" | "box" | "grid";
const DEFAULT_PROMPT_MODE: TPromptMode = "point";
const PROMPT_MODE_ITEMS: { text: string; value: TPromptMode }[] = [
  { text: "Point prompts", value: "point" },
  { text: "Box prompts", value: "box" },
  { text: "Thorough grid scan (slow)", value: "grid" },
];

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

const similarityState = computed(() => {
  const state = toolState.value;
  return state?.type === SamSimilarityToolStateSymbol ? state : null;
});

const status = computed(() => similarityState.value?.status ?? null);

const examples = computed(() => similarityState.value?.examples ?? []);
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
  () => similarityState.value?.proposals?.length ?? 0,
);

const statusText = computed(() => {
  const currentStatus = status.value;
  if (!currentStatus) {
    return "";
  }
  // Candidate-decode progress takes priority over the phase text whenever a
  // decode run is in flight (see ISamSimilarityStatus.progress).
  if (currentStatus.progress) {
    return `Scanning candidates… ${currentStatus.progress.done}/${currentStatus.progress.total}`;
  }
  switch (currentStatus.phase) {
    case "idle":
      return "Click an example object to get started.";
    case "computing":
      return "Computing…";
    case "error":
      return currentStatus.error ?? "An error occurred.";
    case "ready": {
      const timings = currentStatus.timings ?? {};
      const parts: string[] = [];
      if (timings.encodeMs != null) {
        parts.push(`encoded in ${Math.round(timings.encodeMs)} ms`);
      }
      if (timings.decodeMs != null) {
        parts.push(`decoded in ${Math.round(timings.decodeMs)} ms`);
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
  get: () => similarityState.value?.nextPolarity ?? "foreground",
  set: (value: "foreground" | "background") => {
    const state = similarityState.value;
    if (state) {
      state.nextPolarity = value;
    }
  },
});

const similarityThresholdNode = computed(
  () => similarityState.value?.nodes.input.similarityThreshold ?? null,
);
const similarityThreshold = computed({
  get: () => {
    const value = similarityThresholdNode.value?.output;
    return value == null || value === NoOutput
      ? DEFAULT_SIMILARITY_THRESHOLD
      : value;
  },
  set: (value: number) => {
    similarityThresholdNode.value?.setValue(Number(value));
  },
});

const promptModeItems = PROMPT_MODE_ITEMS;
const promptModeNode = computed(
  () => similarityState.value?.nodes.input.promptMode ?? null,
);
const promptMode = computed({
  get: () => {
    const value = promptModeNode.value?.output;
    return value == null || value === NoOutput ? DEFAULT_PROMPT_MODE : value;
  },
  set: (value: TPromptMode) => {
    promptModeNode.value?.setValue(value);
  },
});

function promptModeConfigValue(mode: TPromptMode) {
  return (
    PROMPT_MODE_ITEMS.find((item) => item.value === mode) ?? {
      text: mode,
      value: mode,
    }
  );
}

const simplificationToleranceNode = computed(
  () => similarityState.value?.nodes.input.simplificationTolerance ?? null,
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
  () => similarityState.value?.nodes.input.sizeRange ?? null,
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
  const state = similarityState.value;
  if (!state || state.examples.length === 0) {
    return;
  }
  state.nodes.input.examples.setValue(state.examples.slice(0, -1));
}

async function clearAll() {
  const state = similarityState.value;
  if (!state) {
    return;
  }
  // Drop the descriptor cache first (same rationale as AutoSeg's clearAll):
  // otherwise the examples-cleared recompute below could resolve using the
  // still-cached descriptors instead of truly starting over.
  await state.nodes.reset();
  state.nodes.input.examples.setValue([]);
}

async function accept() {
  const state = similarityState.value;
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
    // (mirrors the "already segmented" dedupe check), but the pipeline only
    // recomputes proposals when one of its input nodes changes. Re-setting
    // the similarity threshold node to its own current value (immediate,
    // bypassing the debounce) is the cheapest available lever: it only
    // re-triggers the cheap verify/NMS -> proposals tail (no re-decode), and
    // that tail re-reads annotationStore.annotations fresh each time — same
    // pattern as ExampleSegmentationToolMenu.accept.
    similarityThresholdNode.value?.setValue(similarityThreshold.value, true);
  } finally {
    isAccepting.value = false;
  }
}

const toolValuesChangedImpl = () => {
  const originalValues = props.toolConfiguration.values;
  const modified =
    originalValues.similarityThreshold !== similarityThreshold.value ||
    originalValues.simplificationTolerance !== simplificationTolerance.value ||
    originalValues.promptMode?.value !== promptMode.value;
  if (!modified) {
    return;
  }
  const newToolValues = {
    ...originalValues,
    similarityThreshold: similarityThreshold.value,
    simplificationTolerance: simplificationTolerance.value,
    promptMode: promptModeConfigValue(promptMode.value),
  };
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

watch(similarityThreshold, () => {
  toolValuesChanged();
});

watch(simplificationTolerance, () => {
  toolValuesChanged();
});

watch(promptMode, () => {
  toolValuesChanged();
});

onMounted(() => {
  const configuredSimilarity = Number(
    props.toolConfiguration.values.similarityThreshold,
  );
  if (!Number.isNaN(configuredSimilarity)) {
    similarityThreshold.value = configuredSimilarity;
  }
  const configuredSimplification = Number(
    props.toolConfiguration.values.simplificationTolerance,
  );
  if (!Number.isNaN(configuredSimplification)) {
    simplificationTolerance.value = configuredSimplification;
  }
  const configuredPromptMode = props.toolConfiguration.values.promptMode
    ?.value as TPromptMode | undefined;
  if (configuredPromptMode) {
    promptMode.value = configuredPromptMode;
  }
});

defineExpose({
  isAccepting,
  toolState,
  errorState,
  similarityState,
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
  similarityThresholdNode,
  similarityThreshold,
  promptModeItems,
  promptModeNode,
  promptMode,
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

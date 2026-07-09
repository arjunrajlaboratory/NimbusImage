<template>
  <v-card v-if="isVisible" class="object-segmentation-panel" elevation="8">
    <div class="panel-header">
      <v-icon size="16" class="mr-1">mdi-shape-plus</v-icon>
      <span class="panel-title">Segment similar objects</span>
      <v-progress-circular
        v-if="isComputing"
        indeterminate
        size="12"
        width="2"
        class="ml-2"
      />
      <v-spacer />
      <v-btn
        variant="text"
        icon
        size="x-small"
        title="Close (deactivate the tool)"
        @click="deactivate"
      >
        <v-icon size="16">mdi-close</v-icon>
      </v-btn>
    </div>

    <div v-if="errorState" class="text-error text-body-2 mt-2">
      {{
        errorState.error
          ? errorState.error.message
          : "The tool failed to initialize."
      }}
    </div>

    <template v-else-if="segState">
      <div class="control-row">
        <span class="control-label">Select by</span>
        <v-btn-toggle
          v-model="selectionMode"
          mandatory
          density="compact"
          divided
          class="toggle"
        >
          <v-btn value="samClick" size="x-small">Click (SAM)</v-btn>
          <v-btn value="samBox" size="x-small">Box (SAM)</v-btn>
          <v-btn value="circle" size="x-small">Circle</v-btn>
        </v-btn-toggle>
      </div>

      <div class="control-row">
        <span class="control-label">Find with</span>
        <v-btn-toggle
          v-model="applicationMethod"
          mandatory
          density="compact"
          divided
          class="toggle"
        >
          <v-btn value="samSimilarity" size="x-small">SAM</v-btn>
          <v-btn value="classifier" size="x-small">Classifier</v-btn>
          <v-btn
            value="samThenClassifier"
            size="x-small"
            title="Run SAM, then train the classifier on everything SAM found"
          >
            SAM→Classifier
          </v-btn>
        </v-btn-toggle>
      </div>

      <div class="control-row">
        <span class="control-label">Marks</span>
        <v-btn-toggle
          v-model="nextPolarity"
          mandatory
          density="compact"
          divided
          class="toggle"
        >
          <v-btn value="foreground" size="x-small">Object</v-btn>
          <v-btn value="background" size="x-small">Background</v-btn>
        </v-btn-toggle>
      </div>

      <div class="control-row">
        <span class="control-label">Apply to</span>
        <v-btn-toggle
          v-model="scope"
          mandatory
          density="compact"
          divided
          class="toggle"
        >
          <v-btn value="viewport" size="x-small">Current view</v-btn>
          <v-btn
            value="image"
            size="x-small"
            disabled
            title="Whole-image scanning is coming soon"
          >
            Whole image
          </v-btn>
        </v-btn-toggle>
      </div>

      <div class="hint text-caption mb-1">{{ selectionHint }}</div>

      <div class="control-row">
        <span class="control-label">Threshold</span>
        <v-slider
          v-model="threshold"
          :min="0.05"
          :max="0.95"
          :step="0.01"
          density="compact"
          hide-details
          class="flex-grow-1"
        />
        <span class="control-value">{{ threshold.toFixed(2) }}</span>
      </div>

      <div class="control-row">
        <span class="control-label">Size</span>
        <v-text-field
          v-model="minSizeInput"
          :placeholder="autoMinPlaceholder"
          type="number"
          density="compact"
          hide-details
          variant="outlined"
          class="size-field"
        />
        <span class="mx-1">–</span>
        <v-text-field
          v-model="maxSizeInput"
          :placeholder="autoMaxPlaceholder"
          type="number"
          density="compact"
          hide-details
          variant="outlined"
          class="size-field"
        />
      </div>

      <div v-if="samIsActive" class="control-row">
        <span class="control-label">Prompt mode</span>
        <v-select
          v-model="promptMode"
          :items="promptModeItems"
          item-title="text"
          item-value="value"
          density="compact"
          hide-details
          variant="outlined"
          class="flex-grow-1"
        />
      </div>

      <div v-if="samIsActive && promptMode === 'grid'" class="control-row">
        <span class="control-label">Grid points</span>
        <v-text-field
          v-model.number="gridSize"
          type="number"
          min="2"
          max="48"
          density="compact"
          hide-details
          variant="outlined"
          class="size-field"
        />
        <span class="control-value">²</span>
      </div>

      <div class="control-row">
        <span class="control-label">Simplify</span>
        <v-slider
          v-model="simplificationTolerance"
          :min="0"
          :max="5"
          :step="0.5"
          density="compact"
          hide-details
          class="flex-grow-1"
        />
        <span class="control-value">{{ simplificationTolerance }}</span>
      </div>

      <div class="status-line text-body-2">{{ statusText }}</div>
      <div class="text-caption mb-1">
        {{ putativeCount }} putative object{{
          putativeCount === 1 ? "" : "s"
        }}
        · {{ foregroundCount }} example{{ foregroundCount === 1 ? "" : "s" }}
        <span v-if="backgroundCount"> + {{ backgroundCount }} bg</span>
      </div>

      <div class="d-flex align-center">
        <v-btn
          variant="text"
          size="small"
          :disabled="examplesTotal === 0"
          @click="undoExample"
        >
          Undo
        </v-btn>
        <v-btn
          variant="text"
          size="small"
          :disabled="examplesTotal === 0 && putativeCount === 0"
          @click="clearAll"
        >
          Clear
        </v-btn>
        <v-spacer />
        <v-btn
          color="primary"
          variant="flat"
          size="small"
          :loading="isAccepting"
          :disabled="putativeCount === 0 || isAccepting"
          @click="accept"
        >
          Accept {{ putativeCount }}
        </v-btn>
      </div>
    </template>
  </v-card>
</template>

<script setup lang="ts">
import { computed, ref, watch, onMounted } from "vue";
import { debounce } from "lodash";
import store from "@/store";
import {
  ObjectSegmentationToolStateSymbol,
  TObjectApplicationMethod,
  TObjectSelectionMode,
  TObjectSegmentationScope,
} from "@/store/model";
import { readManualInputOr } from "@/pipelines/computePipeline";
import { acceptProposalsFromTool } from "@/utils/proposalAccept";
import { toNullableNumber } from "@/utils/parsing";

const DEFAULT_THRESHOLD = 0.5;
const DEFAULT_SIMPLIFICATION_TOLERANCE = 1;
const DEFAULT_GRID_SIZE = 16;
type TPromptMode = "point" | "box" | "grid";
const DEFAULT_PROMPT_MODE: TPromptMode = "point";
const PROMPT_MODE_ITEMS: { text: string; value: TPromptMode }[] = [
  { text: "Point prompts", value: "point" },
  { text: "Box prompts", value: "box" },
  { text: "Thorough grid scan (slow)", value: "grid" },
];
const promptModeItems = PROMPT_MODE_ITEMS;

const isAccepting = ref(false);

// The panel is a singleton mounted by ImageViewer; it reads the active tool
// straight from the store rather than taking a per-tool prop.
const configuration = computed(() => store.selectedTool?.configuration ?? null);
const isVisible = computed(
  () => configuration.value?.type === "objectSegmentation",
);
const toolState = computed(() => store.selectedTool?.state);
const errorState = computed(() => {
  const state = toolState.value;
  return state && "error" in state ? state : null;
});
const segState = computed(() => {
  const state = toolState.value;
  return state?.type === ObjectSegmentationToolStateSymbol ? state : null;
});

const status = computed(() => segState.value?.status ?? null);
const isComputing = computed(() => status.value?.phase === "computing");

const examples = computed(() => segState.value?.examples ?? []);
const examplesTotal = computed(() => examples.value.length);
const foregroundCount = computed(
  () =>
    examples.value.filter((example) => example.polarity === "foreground")
      .length,
);
const backgroundCount = computed(
  () => examplesTotal.value - foregroundCount.value,
);
const putativeCount = computed(() => segState.value?.proposals?.length ?? 0);

const statusText = computed(() => {
  const currentStatus = status.value;
  if (!currentStatus) {
    return "";
  }
  if (currentStatus.progress) {
    return `Scanning candidates… ${currentStatus.progress.done}/${currentStatus.progress.total}`;
  }
  switch (currentStatus.phase) {
    case "idle":
      return "Shift-click an example object to get started.";
    case "computing":
      return "Computing…";
    case "error":
      return currentStatus.error ?? "An error occurred.";
    case "ready":
      return putativeCount.value > 0 ? "Ready" : "No matches found.";
    default:
      return "";
  }
});

const selectionMode = computed({
  get: (): TObjectSelectionMode => segState.value?.selectionMode ?? "samClick",
  set: (value: TObjectSelectionMode) => {
    const state = segState.value;
    if (state) {
      state.selectionMode = value;
    }
  },
});

const selectionHint = computed(() => {
  switch (selectionMode.value) {
    case "circle":
      return "Shift-drag a lasso around example objects. Plain drag pans.";
    case "samBox":
      return "Shift-drag a box around example objects. Plain drag pans; shift-right-click marks background.";
    default:
      return "Shift-click example objects. Plain drag pans; shift-right-click marks background.";
  }
});

// applicationMethod gates the pipeline branches, so it is set through the
// input node (the pipeline mirrors it back into state.applicationMethod).
const applicationMethod = computed({
  get: (): TObjectApplicationMethod =>
    segState.value?.applicationMethod ?? "samSimilarity",
  set: (value: TObjectApplicationMethod) => {
    segState.value?.nodes.input.applicationMethod.setValue(value);
  },
});

const scope = computed({
  get: (): TObjectSegmentationScope => segState.value?.scope ?? "viewport",
  set: (value: TObjectSegmentationScope) => {
    const state = segState.value;
    if (state) {
      state.scope = value;
    }
  },
});

const nextPolarity = computed({
  get: () => segState.value?.nextPolarity ?? "foreground",
  set: (value: "foreground" | "background") => {
    const state = segState.value;
    if (state) {
      state.nextPolarity = value;
    }
  },
});

const thresholdNode = computed(
  () => segState.value?.nodes.input.similarityThreshold ?? null,
);

// Reactive UI source-of-truth refs. Bind v-model to THESE, never to a computed
// that reads node.output: ComputeNode.output is a plain (non-reactive) field,
// so a computed reading it never re-evaluates and the control snaps back to its
// stale value (the "prompt-mode dropdown always shows Point prompts" bug). The
// refs push into the pipeline input nodes via the watchers below; they're
// seeded from the tool config in initFromConfig().
const threshold = ref(DEFAULT_THRESHOLD);
const promptMode = ref<TPromptMode>(DEFAULT_PROMPT_MODE);
const simplificationTolerance = ref(DEFAULT_SIMPLIFICATION_TOLERANCE);
const gridSize = ref(DEFAULT_GRID_SIZE);
const minSizeInput = ref<number | string | null>(null);
const maxSizeInput = ref<number | string | null>(null);

watch(threshold, (value) =>
  segState.value?.nodes.input.similarityThreshold.setValue(Number(value)),
);
watch(promptMode, (value) =>
  segState.value?.nodes.input.promptMode.setValue(value),
);
watch(simplificationTolerance, (value) =>
  segState.value?.nodes.input.simplificationTolerance.setValue(Number(value)),
);
watch(gridSize, (value) =>
  segState.value?.nodes.input.gridSize.setValue(Number(value)),
);
watch([minSizeInput, maxSizeInput], () =>
  segState.value?.nodes.input.sizeRange.setValue({
    min: toNullableNumber(minSizeInput.value),
    max: toNullableNumber(maxSizeInput.value),
  }),
);

function promptModeConfigValue(mode: TPromptMode) {
  return (
    PROMPT_MODE_ITEMS.find((item) => item.value === mode) ?? {
      text: mode,
      value: mode,
    }
  );
}

const autoSizeRange = computed(() => status.value?.autoSizeRange ?? null);
const autoMinPlaceholder = computed(() =>
  autoSizeRange.value ? String(Math.round(autoSizeRange.value.min)) : "Auto",
);
const autoMaxPlaceholder = computed(() =>
  autoSizeRange.value ? String(Math.round(autoSizeRange.value.max)) : "Auto",
);
// True when SAM runs (own similarity mode, or the chained SAM→classifier),
// gating the SAM-only controls (prompt mode, grid density).
const samIsActive = computed(
  () =>
    applicationMethod.value === "samSimilarity" ||
    applicationMethod.value === "samThenClassifier",
);

function undoExample() {
  const state = segState.value;
  if (!state) {
    return;
  }
  // Slice the input node's own array rather than the state.examples mirror:
  // the mirror holds freshly-built resolved-example objects, and the
  // pipeline's descriptor cache is keyed by the input objects' identity -
  // feeding mirror objects back in would miss the cache and re-resolve every
  // remaining example.
  const currentExamples = readManualInputOr(state.nodes.input.examples, []);
  if (currentExamples.length === 0) {
    return;
  }
  state.nodes.input.examples.setValue(currentExamples.slice(0, -1));
}

async function clearAll() {
  const state = segState.value;
  if (!state) {
    return;
  }
  // Reset drops the descriptor cache and the classifier worker model first,
  // so the examples-cleared recompute truly starts over.
  await state.nodes.reset();
  state.nodes.input.examples.setValue([]);
}

async function accept() {
  const proposals = segState.value?.proposals;
  const config = configuration.value;
  if (!proposals || !config) {
    return;
  }
  isAccepting.value = true;
  try {
    if (!(await acceptProposalsFromTool(config, proposals))) {
      return;
    }
    // Newly-committed annotations must be deduped out of future proposals, but
    // the pipeline only recomputes when an input node changes. Re-setting the
    // threshold node to its own value (immediate) re-triggers only the cheap
    // verify/dedupe tail, which re-reads the annotation store fresh.
    thresholdNode.value?.setValue(threshold.value, true);
  } finally {
    isAccepting.value = false;
  }
}

// Persist the panel choices into the tool configuration so they restore on
// re-selection (same debounced editToolInConfiguration pattern as the old
// menus).
const toolValuesChangedImpl = () => {
  const config = configuration.value;
  if (!config) {
    return;
  }
  const originalValues = config.values;
  const newToolValues = {
    ...originalValues,
    threshold: threshold.value,
    simplificationTolerance: simplificationTolerance.value,
    promptMode: promptModeConfigValue(promptMode.value),
    gridSize: gridSize.value,
    selectionMode: selectionMode.value,
    applicationMethod: applicationMethod.value,
    scope: scope.value,
  };
  store.editToolInConfiguration({ ...config, values: newToolValues });
};
const toolValuesChanged = debounce(toolValuesChangedImpl, 1000, {
  leading: false,
  trailing: true,
});
watch(
  [
    threshold,
    simplificationTolerance,
    promptMode,
    gridSize,
    selectionMode,
    applicationMethod,
    scope,
  ],
  () => toolValuesChanged(),
);

function deactivate() {
  store.setSelectedToolId(null);
}

// Seed the reactive UI refs / state from the saved tool config. Called on
// mount and whenever the active tool's state object changes (re-selection),
// so a re-opened tool restores its persisted choices.
function initFromConfig() {
  const values = configuration.value?.values ?? {};
  const configuredThreshold = Number(values.threshold);
  if (!Number.isNaN(configuredThreshold)) {
    threshold.value = configuredThreshold;
  }
  const configuredSimplification = Number(values.simplificationTolerance);
  if (!Number.isNaN(configuredSimplification)) {
    simplificationTolerance.value = configuredSimplification;
  }
  const configuredGridSize = Number(values.gridSize);
  if (!Number.isNaN(configuredGridSize) && configuredGridSize > 0) {
    gridSize.value = configuredGridSize;
  }
  const configuredPromptMode = values.promptMode?.value as
    | TPromptMode
    | undefined;
  if (configuredPromptMode) {
    promptMode.value = configuredPromptMode;
  }
  const configuredSelectionMode = values.selectionMode as
    | TObjectSelectionMode
    | undefined;
  if (configuredSelectionMode) {
    selectionMode.value = configuredSelectionMode;
  }
  const configuredApplicationMethod = values.applicationMethod as
    | TObjectApplicationMethod
    | undefined;
  if (configuredApplicationMethod) {
    applicationMethod.value = configuredApplicationMethod;
  }
  const configuredScope = values.scope as TObjectSegmentationScope | undefined;
  if (configuredScope) {
    scope.value = configuredScope;
  }
}

onMounted(initFromConfig);
// Re-seed when the tool's state object is (re)created, e.g. after deselect/
// reselect — the fresh pipeline nodes start at defaults and need the config
// pushed back in.
watch(segState, (newState) => {
  if (newState) {
    initFromConfig();
  }
});
</script>

<style lang="scss" scoped>
.object-segmentation-panel {
  position: absolute;
  bottom: 10px;
  right: 10px;
  z-index: 200;
  width: 340px;
  padding: 8px 10px;
  background: rgba(var(--v-theme-surface), 0.95);
}

.panel-header {
  display: flex;
  align-items: center;
}

.panel-title {
  font-size: 13px;
  font-weight: 500;
}

.control-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 4px 0;
}

.control-label {
  flex: 0 0 66px;
  font-size: 11px;
  opacity: 0.8;
}

.control-value {
  flex: 0 0 32px;
  text-align: right;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.toggle {
  height: 24px;
}

.size-field {
  max-width: 90px;
}

.hint {
  opacity: 0.7;
}

.status-line {
  margin-top: 4px;
  min-height: 20px;
}

// The app's global v-btn defaults (elevated variant, base font) override
// Vuetify's x-small size class, so buttons render at the inherited 16px.
// Force a compact, label-appropriate size for every button in the panel.
.object-segmentation-panel :deep(.v-btn) {
  font-size: 11px;
  letter-spacing: normal;
  text-transform: none;
  min-width: 0;
}

.object-segmentation-panel :deep(.v-btn__content) {
  font-size: 11px;
}

.toggle :deep(.v-btn) {
  height: 22px;
  padding: 0 8px;
}

// Keep the not-yet-available "Whole image" option clearly disabled rather
// than reading as the selected option.
.toggle :deep(.v-btn--disabled) {
  opacity: 0.4;
}
</style>

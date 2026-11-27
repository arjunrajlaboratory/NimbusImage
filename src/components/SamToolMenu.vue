<template>
  <v-card>
    <v-card-title>Options</v-card-title>

    <!-- Main menu -->
    <v-card-text v-if="samState && datasetId">
      <!-- A failed node otherwise looks exactly like "no prompts" -->
      <v-alert
        v-if="failure"
        type="error"
        density="compact"
        class="mb-2 sam-failure"
      >
        <div>{{ failureTitle }}: {{ failure.message }}</div>
        <v-btn
          v-if="failure.canRetry"
          variant="text"
          size="small"
          class="mt-1"
          @click="retryLoad"
        >
          Retry
        </v-btn>
      </v-alert>
      <v-checkbox label="Turbo mode" v-model="turboMode" />
      <div v-if="!turboMode">
        <div>
          <v-btn
            variant="outlined"
            color="primary"
            size="small"
            class="my-1"
            @click="undo"
            :disabled="prompts.length === 0"
          >
            Undo last prompt
          </v-btn>
          <v-btn
            variant="outlined"
            color="primary"
            size="small"
            class="my-1"
            @click="redo"
            :disabled="promptHistory.length === 0"
          >
            Redo last prompt
          </v-btn>
          <v-btn
            variant="outlined"
            color="primary"
            size="small"
            class="my-1"
            @click="resetPrompts"
            :disabled="prompts.length === 0"
          >
            Reset prompts
          </v-btn>
          <v-btn
            variant="flat"
            color="primary"
            size="small"
            class="my-1"
            @click="submit"
            :disabled="!outputCoordinates"
          >
            Submit annotation
          </v-btn>
        </div>
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
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { debounce } from "lodash";
import store from "@/store";
import annotationStore from "@/store/annotation";
import {
  IToolConfiguration,
  SamAnnotationToolStateSymbol,
  TSamPrompt,
} from "@/store/model";
import { NoOutput } from "@/pipelines/computePipeline";

const props = defineProps<{
  toolConfiguration: IToolConfiguration;
}>();

// The first element is the oldest
const promptHistory = ref<TSamPrompt[]>([]);
const turboMode = ref<boolean>(true);

const toolState = computed(() => {
  return store.selectedTool?.state;
});

const errorState = computed(() => {
  const state = toolState.value;
  return state && "error" in state ? state : null;
});

const samState = computed(() => {
  const state = toolState.value;
  return state?.type === SamAnnotationToolStateSymbol ? state : null;
});

const loadingMessages = computed(() => {
  return samState.value?.loadingMessages ?? [];
});

const failure = computed(() => samState.value?.failure ?? null);

const failureTitle = computed(() =>
  failure.value?.stage === "load"
    ? "Could not load the SAM model"
    : "SAM could not segment the image",
);

function retryLoad() {
  samState.value?.nodes.retryLoad();
}

const simplificationToleranceNode = computed(() => {
  return samState.value?.nodes.input.simplificationTolerance ?? null;
});

const simplificationTolerance = computed({
  get: () => {
    const value = simplificationToleranceNode.value?.output;
    return value == null || value === NoOutput ? -1 : value;
  },
  set: (tolerance: number) => {
    simplificationToleranceNode.value?.setValue(tolerance);
  },
});

const promptNode = computed(() => {
  return samState.value?.nodes.input.mainPrompt ?? null;
});

// Read from the reactive mirror: the node's own output is on a markRaw'd
// pipeline node, so a computed reading it never updates.
const prompts = computed({
  get: (): TSamPrompt[] => samState.value?.prompts ?? [],
  set: (promptsVal: TSamPrompt[]) => {
    promptNode.value?.setValue(promptsVal.length === 0 ? NoOutput : promptsVal);
  },
});

const outputCoordinates = computed(() => {
  return samState.value?.output ?? null;
});

const datasetId = computed(() => {
  return store.dataset?.id ?? null;
});

function turboModeChanged() {
  // When the turbo mode changes, reset the prompts
  resetPrompts();
}

const toolValuesChangedImpl = () => {
  const changedValues = {
    turboMode: turboMode.value,
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
// Save a pending edit now rather than from a dead instance: pinning or
// unpinning the selected SAM tool remounts this menu in another section.
onBeforeUnmount(() => toolValuesChanged.flush());

watch(turboMode, () => {
  turboModeChanged();
  toolValuesChanged();
});

watch(simplificationTolerance, () => {
  toolValuesChanged();
});

watch(
  () => props.toolConfiguration,
  (newToolConfig: IToolConfiguration, oldToolConfig: IToolConfiguration) => {
    // Reset when the configuration changes but not when the configuration settings change
    if (newToolConfig.id !== oldToolConfig.id) {
      resetPrompts();
    }
  },
);

watch(outputCoordinates, () => {
  if (turboMode.value) {
    submit();
  }
});

// Both build a new list: the mirror is a snapshot, and the pipeline only
// sees a change through setValue.
function undo() {
  const currentPrompts = prompts.value;
  const removedPrompt = currentPrompts[currentPrompts.length - 1];
  if (!removedPrompt) {
    return;
  }
  promptHistory.value.push(removedPrompt);
  prompts.value = currentPrompts.slice(0, -1);
}

function redo() {
  const newPrompt = promptHistory.value.pop();
  if (!newPrompt) {
    return;
  }
  prompts.value = [...prompts.value, newPrompt];
}

function resetPrompts() {
  promptHistory.value = [];
  prompts.value = [];
}

function submit() {
  const coordinates = outputCoordinates.value;
  const dsId = datasetId.value;
  const toolConfiguration = props.toolConfiguration;
  // Nothing to submit (no mask yet, or a recompute just cleared it): keep the
  // prompts. In turbo mode the output watcher calls this on every change,
  // including the reset to null at the start of each decode.
  if (!coordinates || !dsId) {
    return;
  }
  annotationStore.addAnnotationFromTool({
    coordinates,
    datasetId: dsId,
    toolConfiguration,
  });
  resetPrompts();
}

onMounted(() => {
  turboMode.value = props.toolConfiguration.values.turboMode;
  simplificationTolerance.value = Number(
    props.toolConfiguration.values.simplificationTolerance,
  );
});

defineExpose({
  promptHistory,
  turboMode,
  toolState,
  errorState,
  samState,
  loadingMessages,
  failure,
  retryLoad,
  simplificationToleranceNode,
  simplificationTolerance,
  promptNode,
  prompts,
  outputCoordinates,
  datasetId,
  undo,
  redo,
  resetPrompts,
  submit,
  toolValuesChanged,
});
</script>

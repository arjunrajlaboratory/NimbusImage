<template>
  <v-card>
    <!-- Title and loading -->
    <v-menu
      offset-x
      :closeOnClick="false"
      :closeOnContentClick="false"
      :value="loadingMessages.length > 0"
      z-index="100"
    >
      <template #activator="{}">
        <v-card-title> Options </v-card-title>
      </template>
      <v-card class="d-flex flex-column">
        <v-progress-circular indeterminate />
        <div v-for="(message, i) in loadingMessages" :key="`sam-loading-${i}`">
          {{ message }}
        </div>
      </v-card>
    </v-menu>

    <!-- Main menu -->
    <v-card-text v-if="samState && datasetId">
      <v-checkbox label="Turbo mode" v-model="turboMode" />
      <div v-if="!turboMode">
        <div>
          <v-btn class="my-1" @click="undo" :disabled="prompts.length === 0">
            Undo last prompt
          </v-btn>
          <v-btn
            class="my-1"
            @click="redo"
            :disabled="promptHistory.length === 0"
          >
            Redo last prompt
          </v-btn>
          <v-btn
            class="my-1"
            @click="resetPrompts"
            :disabled="prompts.length === 0"
          >
            Reset prompts
          </v-btn>
          <v-btn class="my-1" @click="submit" :disabled="!outputCoordinates">
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
      <v-expansion-panel-content>
        <div class="d-flex">
          <code class="code-block">{{
            errorState.error ? errorState.error.message : "Unknown error"
          }}</code>
        </div>
      </v-expansion-panel-content>
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
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

const prompts = computed({
  get: () => {
    const promptsVal = promptNode.value?.output;
    return promptsVal && promptsVal !== NoOutput ? promptsVal : [];
  },
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

function undo() {
  const removedPrompt = prompts.value.pop();
  if (!removedPrompt) {
    return;
  }
  promptHistory.value.push(removedPrompt);
  // Update the prompts in the pipeline (call setValue)
  prompts.value = prompts.value;
}

function redo() {
  const newPrompt = promptHistory.value.pop();
  if (!newPrompt) {
    return;
  }
  prompts.value.push(newPrompt);
  prompts.value = prompts.value;
  // Update the prompts in the pipeline (call setValue)
  prompts.value = prompts.value;
}

function resetPrompts() {
  promptHistory.value = [];
  prompts.value = [];
}

function submit() {
  const coordinates = outputCoordinates.value;
  const dsId = datasetId.value;
  const toolConfiguration = props.toolConfiguration;
  if (coordinates && dsId) {
    annotationStore.addAnnotationFromTool({
      coordinates,
      datasetId: dsId,
      toolConfiguration,
    });
  }
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

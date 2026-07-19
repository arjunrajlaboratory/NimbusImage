<template>
  <!-- eager keeps the content mounted while closed so in-progress edits and a
       live run survive the dialog being closed and reopened. -->
  <v-dialog
    v-model="dialogOpen"
    min-width="900px"
    max-width="1100px"
    width="85%"
    class="wide-dialog"
    eager
  >
    <v-card>
      <v-card-title class="d-flex align-center">
        <v-btn
          v-if="activeView !== 'list'"
          variant="text"
          icon
          size="small"
          class="mr-2"
          @click="backToList"
        >
          <v-icon>mdi-arrow-left</v-icon>
        </v-btn>
        <span class="flex-grow-1">
          Pipelines
          <span
            v-if="activeView === 'editor' && activePipeline"
            class="text-body-2 text-medium-emphasis"
          >
            — {{ activePipeline.name }}
          </span>
        </span>
        <v-btn variant="text" icon size="small" @click="dialogOpen = false">
          <v-icon>mdi-close</v-icon>
        </v-btn>
      </v-card-title>
      <v-card-text>
        <!-- Run status is shown in every view so a run is never out of sight. -->
        <pipeline-run-status />

        <pipeline-list
          v-if="activeView === 'list'"
          @open="openEditor"
          @open-suggest="showSuggestDialog = true"
        />
        <pipeline-editor
          v-else-if="activeView === 'editor' && activePipeline"
          :pipeline="activePipeline"
        />
      </v-card-text>
    </v-card>
  </v-dialog>

  <pipeline-suggest-dialog
    v-model="showSuggestDialog"
    @use-suggestion="onUseSuggestion"
  />
</template>

<script setup lang="ts">
import { computed, onMounted, provide, ref, watch } from "vue";
import store from "@/store";
import pipelinesStore from "@/store/pipelines";
import PipelineList from "@/components/pipelines/PipelineList.vue";
import PipelineEditor from "@/components/pipelines/PipelineEditor.vue";
import PipelineRunStatus from "@/components/pipelines/PipelineRunStatus.vue";
import PipelineSuggestDialog from "@/components/pipelines/PipelineSuggestDialog.vue";
import {
  createPipelineRunController,
  PipelineRunControllerKey,
} from "@/components/pipelines/usePipelineRun";
import { IPipeline } from "@/store/model";

const props = defineProps<{
  modelValue: boolean;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: boolean): void;
}>();

const dialogOpen = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit("update:modelValue", value),
});

// One run controller for the whole dialog, shared with the editor and the
// status strip via provide/inject.
const controller = createPipelineRunController();
provide(PipelineRunControllerKey, controller);

onMounted(controller.fetchCollectionDatasetCount);
watch(
  () => store.selectedConfigurationId,
  controller.fetchCollectionDatasetCount,
);

type TPipelineDialogView = "list" | "editor";

const activeView = ref<TPipelineDialogView>("list");
const activePipeline = ref<IPipeline | null>(null);
const showSuggestDialog = ref(false);

function openEditor(pipeline: IPipeline) {
  activePipeline.value = pipeline;
  activeView.value = "editor";
  // A finished run's summary belongs to the pipeline that ran. When opening a
  // *different* pipeline (and nothing is running), drop it so the status strip
  // doesn't hover a stale result over an unrelated editor.
  if (
    !controller.isRunning.value &&
    controller.activePipelineId.value !== pipeline.id
  ) {
    controller.clearResult();
  }
}

function backToList() {
  activeView.value = "list";
  activePipeline.value = null;
}

function onUseSuggestion(pipeline: IPipeline) {
  openEditor(pipeline);
}

// On (re)open: if a run is in flight, land on that pipeline's editor so it is
// immediately visible; otherwise reset to the list.
watch(dialogOpen, (open) => {
  if (!open) {
    return;
  }
  const runningId = pipelinesStore.runningPipelineId;
  const running = runningId ? pipelinesStore.getPipelineById(runningId) : null;
  if (running) {
    openEditor(running);
  } else {
    backToList();
  }
});

defineExpose({
  activeView,
  activePipeline,
  openEditor,
  backToList,
});
</script>

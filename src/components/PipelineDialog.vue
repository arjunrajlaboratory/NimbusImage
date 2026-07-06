<template>
  <v-dialog
    v-model="dialogOpen"
    min-width="900px"
    max-width="1100px"
    width="85%"
    class="wide-dialog"
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
            v-if="activeView !== 'list' && activePipeline"
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
        <pipeline-list
          v-if="activeView === 'list'"
          @open-builder="openBuilder"
          @open-run="openRun"
          @open-suggest="showSuggestDialog = true"
        />
        <pipeline-builder
          v-else-if="activeView === 'builder' && activePipeline"
          :model-value="activePipeline"
          @update:model-value="activePipeline = $event"
          @saved="backToList"
          @close="backToList"
        />
        <pipeline-run-panel
          v-else-if="activeView === 'run' && activePipeline"
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
import { computed, ref, watch } from "vue";
import PipelineList from "@/components/pipelines/PipelineList.vue";
import PipelineBuilder from "@/components/pipelines/PipelineBuilder.vue";
import PipelineRunPanel from "@/components/pipelines/PipelineRunPanel.vue";
import PipelineSuggestDialog from "@/components/pipelines/PipelineSuggestDialog.vue";
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

type TPipelineDialogView = "list" | "builder" | "run";

const activeView = ref<TPipelineDialogView>("list");
const activePipeline = ref<IPipeline | null>(null);
const showSuggestDialog = ref(false);

function openBuilder(pipeline: IPipeline) {
  activePipeline.value = pipeline;
  activeView.value = "builder";
}

function openRun(pipeline: IPipeline) {
  activePipeline.value = pipeline;
  activeView.value = "run";
}

function backToList() {
  activeView.value = "list";
  activePipeline.value = null;
}

function onUseSuggestion(pipeline: IPipeline) {
  openBuilder(pipeline);
}

// Reset to the list view every time the dialog is (re)opened.
watch(dialogOpen, (open) => {
  if (open) {
    backToList();
  }
});

defineExpose({
  activeView,
  activePipeline,
  openBuilder,
  openRun,
  backToList,
});
</script>

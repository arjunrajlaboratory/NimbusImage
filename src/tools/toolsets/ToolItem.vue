<template>
  <v-list-item
    density="compact"
    :value="tool.id"
    :active="isToolSelected"
    :style="{ 'max-height': '32px' }"
    :id="getTourStepId(tool.name)"
    v-tour-trigger="getTourTriggerId(tool.name)"
    v-mousetrap="
      tool.hotkey
        ? {
            bind: tool.hotkey,
            handler: toggleTool,
            data: {
              section: 'Tools',
              description: `Toggle tool:  ${tool.name}`,
            },
          }
        : []
    "
    v-bind="$attrs"
    @click="toggleTool"
    @mouseover="isHovering = true"
    @mouseleave="isHovering = false"
  >
    <template #prepend>
      <tool-icon :tool="tool" />
    </template>
    <v-list-item-title>
      {{ tool.name }}
      <v-progress-circular
        v-if="isToolLoading"
        indeterminate
        width="4"
        size="16"
      />
      <v-icon v-else-if="statusIcon">{{ statusIcon }}</v-icon>
    </v-list-item-title>
    <template #append>
      <v-btn
        icon
        :max-height="32"
        @click.stop="editDialog = true"
        v-show="isHovering"
      >
        <v-icon>mdi-pen</v-icon>
      </v-btn>
    </template>
    <v-dialog v-model="editDialog">
      <tool-edition :tool="tool" @close="editDialog = false" />
    </v-dialog>
  </v-list-item>
</template>

<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { IToolConfiguration } from "@/store/model";
import store from "@/store";
import ToolIcon from "@/tools/ToolIcon.vue";
import ToolEdition from "@/tools/ToolEdition.vue";
import jobs from "@/store/jobs";
import { getTourStepId, getTourTriggerId } from "@/utils/strings";

const props = defineProps<{
  tool: IToolConfiguration;
}>();

const isHovering = ref(false);
const editDialog = ref(false);
const statusIcon = ref<string | null>(null);

function toggleTool() {
  if (isToolSelected.value) {
    store.setSelectedToolId(null);
  } else {
    store.setSelectedToolId(props.tool.id);
  }
}

const isToolSelected = computed(() => {
  return store.selectedTool?.configuration.id === props.tool.id;
});

const isToolLoading = computed(() => {
  return !isToolSelected.value && !!jobId.value;
});

const jobId = computed((): string | null => {
  return jobs.jobIdForToolId[props.tool.id] ?? null;
});

function onJobChanged() {
  if (!jobId.value) {
    return;
  }
  jobs
    .getPromiseForJobId(jobId.value)
    .then(
      (success: boolean) =>
        (statusIcon.value = success ? "mdi-check" : "mdi-close"),
    );
}

watch(jobId, onJobChanged);

defineExpose({
  isHovering,
  editDialog,
  statusIcon,
  toggleTool,
  isToolSelected,
  isToolLoading,
  jobId,
  onJobChanged,
});
</script>

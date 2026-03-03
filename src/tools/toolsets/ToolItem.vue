<template>
  <v-list-item
    density="compact"
    :value="tool.id"
    :active="isToolSelected"
    :color="isToolSelected ? 'primary' : undefined"
    :class="['tool-item', { 'tool-item--active': isToolSelected }]"
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
      <span v-if="isToolSelected" class="tool-item__active-dot" />
      <tool-icon :tool="tool" :size="18" />
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
        size="x-small"
        variant="text"
        icon
        @click.stop="editDialog = true"
        v-show="isHovering"
      >
        <v-icon size="14">mdi-pen</v-icon>
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

<style scoped>
.tool-item {
  --v-list-prepend-gap: 6px;
  min-height: 36px;
  border-left: 3px solid transparent;
  border-radius: 0 4px 4px 0;
  margin: 1px 4px 1px 0;
  transition:
    background-color 0.15s ease,
    border-color 0.15s ease,
    opacity 0.15s ease;
}

.tool-item--active {
  border-left-color: rgb(var(--v-theme-primary));
  background-color: rgba(var(--v-theme-primary), 0.12);
  --v-activated-opacity: 0;
}

.tool-item:hover:not(.tool-item--active) {
  background-color: rgba(255, 255, 255, 0.05);
}

.tool-item :deep(.v-list-item-title) {
  opacity: 0.7;
  transition:
    opacity 0.15s ease,
    font-weight 0.15s ease;
}

.tool-item--active :deep(.v-list-item-title) {
  opacity: 1;
  font-weight: 500;
}

.tool-item__active-dot {
  display: inline-block;
  width: 6px;
  min-width: 6px;
  height: 6px;
  border-radius: 50%;
  background-color: rgb(var(--v-theme-primary));
}

.tool-item :deep(.v-list-item__prepend) {
  gap: 6px;
}
</style>

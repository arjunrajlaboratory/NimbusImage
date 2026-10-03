<template>
  <v-list-item
    density="compact"
    :value="tool.id"
    :active="isToolSelected"
    :color="isToolSelected ? 'primary' : undefined"
    :class="['tool-item', { 'tool-item--active': isToolSelected }]"
    :data-tour="getTourAnchorId(tool.name)"
    v-tour-trigger="getTourAnchorId(tool.name)"
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
      <div v-show="isHovering" class="tool-item__actions">
        <v-btn
          size="x-small"
          variant="text"
          icon
          :aria-label="tool.pinned ? 'Unpin tool' : 'Pin tool'"
          class="tool-item__pin"
          @click.stop="togglePinned"
        >
          <v-icon size="14">
            {{ tool.pinned ? "mdi-pin-off-outline" : "mdi-pin-outline" }}
          </v-icon>
        </v-btn>
        <v-btn
          size="x-small"
          variant="text"
          icon
          aria-label="Edit tool"
          @click.stop="editDialog = true"
        >
          <v-icon size="14">mdi-pen</v-icon>
        </v-btn>
        <!-- Drag handle for the Toolset's per-section sortable; clicking it
             must not toggle the tool. -->
        <v-icon
          size="14"
          class="tool-item__drag-handle"
          aria-hidden="true"
          @click.stop
        >
          mdi-drag-vertical
        </v-icon>
      </div>
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
import { getTourAnchorId } from "@/utils/strings";

const props = defineProps<{
  tool: IToolConfiguration;
}>();

const isHovering = ref(false);
const editDialog = ref(false);

function togglePinned() {
  store.setToolPinned({ toolId: props.tool.id, pinned: !props.tool.pinned });
}

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

const statusIcon = computed((): string | null => {
  const success = jobs.toolJobOutcomes[props.tool.id];
  if (success === undefined) {
    return null;
  }
  return success ? "mdi-check" : "mdi-close";
});

function onJobChanged() {
  if (!jobId.value) {
    return;
  }
  const toolId = props.tool.id;
  // Undefined if the job already settled (the jobs store drops finished
  // entries), in which case there is no outcome left to show an icon for.
  // The outcome goes to the store so it survives this item remounting.
  jobs
    .getPromiseForJobId(jobId.value)
    ?.then((success: boolean) => jobs.setToolJobOutcome({ toolId, success }));
}

watch(jobId, onJobChanged);

defineExpose({
  isHovering,
  editDialog,
  statusIcon,
  toggleTool,
  togglePinned,
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

.tool-item__actions {
  display: flex;
  align-items: center;
}

.tool-item__drag-handle {
  cursor: grab;
  opacity: 0.6;
}

.tool-item :deep(.v-list-item__prepend) {
  gap: 6px;
}
</style>

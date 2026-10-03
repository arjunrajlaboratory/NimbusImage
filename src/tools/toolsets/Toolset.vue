<template>
  <div class="toolset">
    <div class="toolset-actions">
      <!-- Tool Type Selection -->
      <v-dialog v-model="toolTypeDialogOpen" max-width="1000px">
        <template v-slot:activator="{ props: dialogProps }">
          <v-tooltip text="Browse tool types">
            <template v-slot:activator="{ props: tooltipProps }">
              <v-btn
                variant="flat"
                color="primary"
                size="small"
                v-bind="mergeProps(dialogProps, tooltipProps)"
                :data-tour="TOUR_ANCHORS.addTool"
                v-tour-trigger="TOUR_TRIGGERS.addTool"
                :disabled="!isLoggedIn"
              >
                Add new tool
              </v-btn>
            </template>
          </v-tooltip>
        </template>
        <tool-type-selection @selected="handleToolTypeSelected" />
      </v-dialog>
      <v-tooltip text="Suggest tools with AI">
        <template v-slot:activator="{ props: tooltipProps }">
          <v-btn
            v-bind="tooltipProps"
            variant="text"
            color="primary"
            icon
            size="small"
            class="tool-suggestions-ai-btn"
            :class="{ 'tool-suggestions-glow': toolSuggestionsGlow }"
            aria-label="Suggest tools with AI"
            :disabled="!isLoggedIn || toolSuggestionsLoading"
            :loading="toolSuggestionsLoading"
            @click="openToolSuggestions"
          >
            <v-icon size="small">mdi-lightbulb-on-outline</v-icon>
          </v-btn>
        </template>
      </v-tooltip>
      <v-spacer />
      <v-tooltip text="Pipelines: chain worker steps and run them in sequence">
        <template v-slot:activator="{ props: tooltipProps }">
          <v-btn
            v-bind="tooltipProps"
            variant="text"
            color="primary"
            size="small"
            aria-label="Pipelines"
            :disabled="!isLoggedIn"
            @click="openPipelines"
          >
            <v-icon size="small" start>mdi-sitemap</v-icon>
            Pipelines
          </v-btn>
        </template>
      </v-tooltip>
    </div>
    <!-- List toolset tools in sections: pinned tools first, then canvas tools
         you use directly on the image, then worker tools that open a
         configuration panel. Each section reorders by dragging a tool's grip;
         sections are separate sortables, so a tool can't be dropped into
         another section. -->
    <v-list v-if="toolGroups.length" density="compact" class="tight-list">
      <template v-for="group in toolGroups" :key="group.key">
        <v-list-subheader class="tool-group-header">
          {{ group.label }}
        </v-list-subheader>
        <draggable
          :model-value="group.tools"
          item-key="id"
          handle=".tool-item__drag-handle"
          :animation="150"
          :disabled="!isLoggedIn"
          :data-tool-group="group.key"
          @update:model-value="onToolSectionReordered"
        >
          <template #item="{ element: tool }">
            <div>
              <v-tooltip location="end" transition="none" z-index="100">
                <template v-slot:activator="{ props: activatorProps }">
                  <tool-item
                    :tool="tool"
                    :disabled="!isLoggedIn"
                    v-bind="activatorProps"
                  />
                </template>
                <div class="d-flex flex-column">
                  <div style="margin: 5px">
                    <div
                      v-for="(
                        propEntry, forKey
                      ) in getToolPropertiesDescription(tool)"
                      :key="forKey"
                    >
                      {{ propEntry[0] }}: {{ propEntry[1] }}
                    </div>
                  </div>
                </div>
              </v-tooltip>
              <!-- SAM tools expose their options in an inline panel. The
                   unified "Segment similar objects" tool exposes its options
                   in the bottom-right ObjectSegmentationPanel (mounted by
                   ImageViewer) instead. -->
              <sam-tool-menu
                v-if="
                  tool.type === 'samAnnotation' &&
                  selectedTool &&
                  selectedTool.id === tool.id
                "
                :toolConfiguration="tool"
              />
            </div>
          </template>
        </draggable>
      </template>
      <circle-to-dot-menu
        :tool="selectedTool"
        v-if="
          selectedTool &&
          selectedTool.type === 'snap' &&
          selectedTool.values.snapTo.value === 'circleToDot'
        "
      />
    </v-list>
    <v-list-subheader v-if="!toolsetTools.length">
      No tools in the current toolset.
    </v-list-subheader>

    <!-- Worker tools open their configuration in a centered, scrim-less dialog
         so the image (and any worker preview overlays) stay visible behind it.
         A single dialog tracks whichever worker tool is currently selected.
         Clicking anywhere outside it (or pressing Escape) closes it, except
         for the outside interactions onWorkerDialogClickOutside vetoes. -->
    <v-dialog
      :model-value="!!selectedWorkerTool"
      :scrim="false"
      width="680"
      class="worker-dialog"
      @click:outside="onWorkerDialogClickOutside"
      @update:model-value="onWorkerDialogToggle"
    >
      <annotation-worker-menu
        v-if="selectedWorkerTool"
        :tool="selectedWorkerTool"
        @close="store.setSelectedToolId(null)"
      />
    </v-dialog>
    <!-- Tool creation dialog -->
    <v-dialog
      v-model="toolCreationDialogOpen"
      :width="toolCreationWide ? '85%' : '55%'"
      :max-width="toolCreationWide ? '1400px' : '800px'"
      class="wide-dialog"
      @update:model-value="onToolCreationDialogInput"
    >
      <tool-creation
        @done="onToolCreationDone"
        :open="toolCreationDialogOpen"
        :initial-selected-tool="selectedToolType"
        @advanced-changed="toolCreationWide = $event"
      />
    </v-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, mergeProps, watch, onBeforeUnmount } from "vue";
import store from "@/store";
import {
  AnnotationNames,
  AnnotationShape,
  IToolConfiguration,
} from "@/store/model";

import AnnotationWorkerMenu from "@/components/AnnotationWorkerMenu.vue";
import SamToolMenu from "@/components/SamToolMenu.vue";
import CircleToDotMenu from "@/components/CircleToDotMenu.vue";
import ToolCreation from "@/tools/creation/ToolCreation.vue";
import ToolTypeSelection from "@/tools/creation/ToolTypeSelection.vue";
import ToolItem from "./ToolItem.vue";
import draggable from "vuedraggable";
import {
  groupTools,
  reorderSection,
  WORKER_TOOL_TYPE,
} from "@/utils/toolOrder";
import { TOUR_ANCHORS, TOUR_TRIGGERS } from "@/tours/anchors";
import toolSuggestionsStore from "@/store/toolSuggestions";

// Lists tools from a toolset, allows selecting a tool from the list, and adding new tools

const selectedToolId = computed({
  get: () => store.selectedTool?.configuration.id || null,
  set: (id: string | null) => store.setSelectedToolId(id || null),
});

const tools = computed(() => store.tools);

const configuration = computed(() => store.configuration);

const toolsetTools = computed(() => configuration.value?.tools || []);

const selectedTool = computed<IToolConfiguration | null>(
  () => store.selectedTool?.configuration ?? null,
);

const toolGroups = computed(() => groupTools(toolsetTools.value));

function onToolSectionReordered(sectionTools: IToolConfiguration[]) {
  const toolOrder = reorderSection(
    toolsetTools.value.filter(Boolean).map(({ id }) => id),
    sectionTools.map(({ id }) => id),
  );
  if (toolOrder) {
    store.setToolOrder(toolOrder);
  }
}

// The single worker dialog tracks whichever worker tool is selected (if any).
const selectedWorkerTool = computed<IToolConfiguration | null>(() =>
  selectedTool.value?.type === WORKER_TOOL_TYPE ? selectedTool.value : null,
);

const isLoggedIn = computed(() => store.isLoggedIn);

const toolCreationDialogOpen = ref(false);
const toolTypeDialogOpen = ref(false);
const selectedToolType = ref<any>(null);
const toolCreationWide = ref(false);
const toolSuggestionsLoading = computed(
  () => toolSuggestionsStore.status === "loading",
);
const toolSuggestionsDismissed = computed(() => toolSuggestionsStore.dismissed);
const toolSuggestionsGlow = ref(false);
let toolSuggestionsGlowTimeout: ReturnType<typeof setTimeout> | null = null;

function onToolCreationDone() {
  // The child emitted "done" meaning the dialog is closing/cancelled/finished
  toolCreationDialogOpen.value = false;
  selectedToolType.value = null; // Now is the right time to clear it
}

function onToolCreationDialogInput(newVal: boolean) {
  toolCreationDialogOpen.value = newVal;
  if (!newVal) {
    // The dialog was just closed by clicking outside or ESC
    selectedToolType.value = null;
  }
}

function handleToolTypeSelected(toolType: any) {
  selectedToolType.value = toolType;
  toolTypeDialogOpen.value = false;
  toolCreationDialogOpen.value = true;
}

function openToolSuggestions() {
  stopToolSuggestionsGlow();
  toolSuggestionsStore.setDismissed(false);
  if (toolSuggestionsStore.status !== "loading") {
    toolSuggestionsStore.suggestForCurrentConfiguration();
  }
}

function openPipelines() {
  store.setIsPipelineDialogOpen(true);
}

function stopToolSuggestionsGlow() {
  if (toolSuggestionsGlowTimeout !== null) {
    clearTimeout(toolSuggestionsGlowTimeout);
    toolSuggestionsGlowTimeout = null;
  }
  toolSuggestionsGlow.value = false;
}

function triggerToolSuggestionsGlow() {
  if (toolSuggestionsGlowTimeout !== null) {
    clearTimeout(toolSuggestionsGlowTimeout);
  }
  toolSuggestionsGlow.value = true;
  toolSuggestionsGlowTimeout = setTimeout(() => {
    toolSuggestionsGlow.value = false;
    toolSuggestionsGlowTimeout = null;
  }, 1800);
}

function getToolPropertiesDescription(tool: IToolConfiguration): string[][] {
  const propDesc: string[][] = [["Name", tool.name]];

  if (tool.values) {
    const { values } = tool;

    if (values.selectionType && values.selectionType.text) {
      propDesc.push(["Selection type", values.selectionType.text]);
    }

    if (values.annotation) {
      propDesc.push([
        "Shape",
        AnnotationNames[values.annotation.shape as AnnotationShape],
      ]);
      if (values.annotation.tags && values.annotation.tags.length) {
        propDesc.push(["Tag(s)", values.annotation.tags.join(", ")]);
      }
    }
    if (
      values.connectTo &&
      values.connectTo.tags &&
      values.connectTo.tags.length
    ) {
      propDesc.push(["Connect to tags", values.connectTo.tags.join(", ")]);
      const layerId = values.connectTo.layer;
      const layer = store.getLayerFromId(layerId);
      if (layer) {
        propDesc.push(["Connect only on layer", layer.name]);
      }
    }
  }

  if (tool.hotkey !== null) {
    propDesc.push(["Hotkey", tool.hotkey]);
  }

  return propDesc;
}

// The worker dialog closes on a click outside it, but two outside
// interactions must not close it:
//  - dragging (panning) the image behind the scrim-less dialog, and
//  - clicking another worker tool in the list. Vuetify runs its close in a
//    setTimeout, i.e. *after* that click has already selected the new tool,
//    so an unguarded close would deselect the tool the user just picked.
// Snapshot the pointer position and selected tool at pointerdown; the
// click:outside handler then vetoes the close Vuetify emits right after it.
// Escape emits no click:outside, so it always closes.
const WORKER_DIALOG_CLICK_TOLERANCE_PX = 5;
let workerDialogPointerDown: {
  x: number;
  y: number;
  toolId: string | null;
} | null = null;
let isWorkerDialogCloseVetoed = false;

function recordWorkerDialogPointerDown(event: PointerEvent) {
  workerDialogPointerDown = {
    x: event.clientX,
    y: event.clientY,
    toolId: selectedToolId.value,
  };
}

watch(
  () => !!selectedWorkerTool.value,
  (isOpen, _wasOpen, onCleanup) => {
    if (!isOpen) {
      return;
    }
    window.addEventListener("pointerdown", recordWorkerDialogPointerDown, true);
    onCleanup(() => {
      window.removeEventListener(
        "pointerdown",
        recordWorkerDialogPointerDown,
        true,
      );
      workerDialogPointerDown = null;
    });
  },
  { immediate: true },
);

function onWorkerDialogClickOutside(event: MouseEvent) {
  const pointerDown = workerDialogPointerDown;
  isWorkerDialogCloseVetoed =
    !pointerDown ||
    pointerDown.toolId !== selectedToolId.value ||
    Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) >
      WORKER_DIALOG_CLICK_TOLERANCE_PX;
}

function onWorkerDialogToggle(open: boolean) {
  const isVetoed = isWorkerDialogCloseVetoed;
  isWorkerDialogCloseVetoed = false;
  if (!open && !isVetoed) {
    store.setSelectedToolId(null);
  }
}

watch(toolSuggestionsDismissed, (dismissed, wasDismissed) => {
  if (dismissed && !wasDismissed) {
    triggerToolSuggestionsGlow();
  }
});

onBeforeUnmount(stopToolSuggestionsGlow);

defineExpose({
  selectedToolId,
  tools,
  toolsetTools,
  toolGroups,
  onToolSectionReordered,
  selectedWorkerTool,
  onWorkerDialogClickOutside,
  configuration,
  selectedTool,
  isLoggedIn,
  toolCreationDialogOpen,
  toolTypeDialogOpen,
  selectedToolType,
  toolCreationWide,
  toolSuggestionsLoading,
  toolSuggestionsGlow,
  onToolCreationDone,
  onToolCreationDialogInput,
  handleToolTypeSelected,
  openToolSuggestions,
  openPipelines,
  triggerToolSuggestionsGlow,
  getToolPropertiesDescription,
  onWorkerDialogToggle,
});
</script>
<style scoped>
.toolset {
  padding: 4px 0 8px;
}

.toolset-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 12px 8px;
}

.tool-suggestions-ai-btn {
  position: relative;
}

.tool-suggestions-ai-btn.tool-suggestions-glow {
  animation: tool-suggestions-glow 1.8s ease-out;
}

@keyframes tool-suggestions-glow {
  0% {
    background-color: rgba(var(--v-theme-primary), 0.22);
    box-shadow: 0 0 0 0 rgba(var(--v-theme-primary), 0.6);
  }
  70% {
    background-color: rgba(var(--v-theme-primary), 0.12);
    box-shadow: 0 0 0 10px rgba(var(--v-theme-primary), 0);
  }
  100% {
    background-color: transparent;
    box-shadow: 0 0 0 0 rgba(var(--v-theme-primary), 0);
  }
}

.tight-list {
  padding: 4px 0;
}

.tool-group-header {
  min-height: 24px;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  opacity: 0.6;
}

.tool-group-header:not(:first-child) {
  margin-top: 4px;
}

.tight-list :deep(.v-list-item) {
  padding-left: 8px;
  padding-right: 4px;
}
</style>

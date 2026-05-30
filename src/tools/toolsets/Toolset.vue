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
                data-tour="add-tool"
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
    </div>
    <!-- List toolset tools, grouped by behavior: canvas tools you use directly
         on the image vs. worker tools that open a configuration panel. -->
    <v-list v-if="toolGroups.length" density="compact" class="tight-list">
      <template v-for="group in toolGroups" :key="group.label">
        <v-list-subheader class="tool-group-header">
          {{ group.label }}
        </v-list-subheader>
        <v-tooltip
          v-for="tool in group.tools"
          :key="tool.id"
          location="end"
          transition="none"
          z-index="100"
        >
          <template v-slot:activator="{ props: activatorProps }">
            <!-- SAM tools expose their options in an inline panel -->
            <template v-if="tool.type === 'samAnnotation'">
              <div>
                <tool-item
                  :tool="tool"
                  :disabled="!isLoggedIn"
                  v-bind="activatorProps"
                />
                <template v-if="selectedTool && selectedTool.id === tool.id">
                  <sam-tool-menu :toolConfiguration="tool" />
                </template>
              </div>
            </template>
            <template v-else>
              <tool-item
                :tool="tool"
                :disabled="!isLoggedIn"
                v-bind="activatorProps"
              />
            </template>
          </template>
          <div class="d-flex flex-column">
            <div style="margin: 5px">
              <div
                v-for="(propEntry, forKey) in getToolPropertiesDescription(
                  tool,
                )"
                :key="forKey"
              >
                {{ propEntry[0] }}: {{ propEntry[1] }}
              </div>
            </div>
          </div>
        </v-tooltip>
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
         A single dialog tracks whichever worker tool is currently selected. -->
    <v-dialog
      :model-value="!!selectedWorkerTool"
      :scrim="false"
      persistent
      width="680"
      class="worker-dialog"
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
import { ref, computed, mergeProps } from "vue";
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
import { TOUR_TRIGGERS } from "@/tours/anchors";

// Lists tools from a toolset, allows selecting a tool from the list, and adding new tools

// Worker tools (type "segmentation") open a configuration dialog; everything
// else is used directly on the canvas. Group them so the distinction is
// obvious — see the two-section list and the worker dialog in the template.
const WORKER_TOOL_TYPE = "segmentation";

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

const toolGroups = computed(() => {
  const canvasTools: IToolConfiguration[] = [];
  const workerTools: IToolConfiguration[] = [];
  for (const tool of toolsetTools.value) {
    if (!tool) {
      continue;
    }
    (tool.type === WORKER_TOOL_TYPE ? workerTools : canvasTools).push(tool);
  }
  const groups: { label: string; tools: IToolConfiguration[] }[] = [];
  if (canvasTools.length) {
    groups.push({ label: "Annotation tools", tools: canvasTools });
  }
  if (workerTools.length) {
    groups.push({ label: "Analysis tools", tools: workerTools });
  }
  return groups;
});

// The single worker dialog tracks whichever worker tool is selected (if any).
const selectedWorkerTool = computed<IToolConfiguration | null>(() =>
  selectedTool.value?.type === WORKER_TOOL_TYPE ? selectedTool.value : null,
);

const isLoggedIn = computed(() => store.isLoggedIn);

const toolCreationDialogOpen = ref(false);
const toolTypeDialogOpen = ref(false);
const selectedToolType = ref<any>(null);
const toolCreationWide = ref(false);

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

function onWorkerDialogToggle(open: boolean) {
  if (!open) {
    store.setSelectedToolId(null);
  }
}

defineExpose({
  selectedToolId,
  tools,
  toolsetTools,
  toolGroups,
  selectedWorkerTool,
  configuration,
  selectedTool,
  isLoggedIn,
  toolCreationDialogOpen,
  toolTypeDialogOpen,
  selectedToolType,
  toolCreationWide,
  onToolCreationDone,
  onToolCreationDialogInput,
  handleToolTypeSelected,
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
  padding: 4px 12px 8px;
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

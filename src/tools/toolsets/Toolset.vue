<template>
  <v-expansion-panels v-model="panels">
    <v-expansion-panel expand v-model="panels">
      <v-expansion-panel-title class="pa-2">
        <v-toolbar-title> Toolset </v-toolbar-title>
        <!-- Tool Type Selection -->
        <v-dialog v-model="toolTypeDialogOpen" max-width="1000px">
          <template v-slot:activator="{ props: dialogProps }">
            <v-tooltip text="Browse tool types">
              <template v-slot:activator="{ props: tooltipProps }">
                <v-btn
                  class="ml-2"
                  color="primary"
                  v-bind="mergeProps(dialogProps, tooltipProps)"
                  id="add-tool-tourstep"
                  v-tour-trigger="'add-tool-tourtrigger'"
                  :disabled="!isLoggedIn"
                >
                  Add new tool
                </v-btn>
              </template>
            </v-tooltip>
          </template>
          <tool-type-selection @selected="handleToolTypeSelected" />
        </v-dialog>
      </v-expansion-panel-title>
      <v-expansion-panel-text>
        <!-- List toolset tools -->
        <v-list v-if="toolsetTools.length" density="compact" class="tight-list">
              <template v-for="(tool, index) in toolsetTools" :key="index">
                <v-tooltip
                  location="end"
                  transition="none"
                  z-index="100"
                  v-if="tool"
                >
                  <template v-slot:activator="{ props: activatorProps }">
                    <!-- If type === segmentation, add an annotation worker menu -->
                    <template v-if="tool.type === 'segmentation'">
                      <v-menu
                        :ref="setAnnotationMenuRef"
                        :closeOnClick="false"
                        :closeOnContentClick="false"
                        :model-value="!!selectedTool && selectedTool.id === tool.id"
                        z-index="100"
                      >
                        <template #activator="{}">
                          <tool-item
                            :tool="tool"
                            :disabled="!isLoggedIn"
                            v-bind="activatorProps"
                          />
                        </template>
                        <annotation-worker-menu
                          :tool="tool"
                          @loaded="onWorkerMenuLoaded"
                        />
                      </v-menu>
                    </template>
                    <!-- When the tool is a SAM tool, show options in an expansion panel -->
                    <template v-else-if="tool.type === 'samAnnotation'">
                      <div>
                        <tool-item
                          :tool="tool"
                          :disabled="!isLoggedIn"
                          v-bind="activatorProps"
                        />
                        <template
                          v-if="selectedTool && selectedTool.id === tool.id"
                        >
                          <sam-tool-menu :toolConfiguration="tool" />
                        </template>
                      </div>
                    </template>
                    <!-- Otherwiser, only tool item -->
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
      </v-expansion-panel-text>
    </v-expansion-panel>
  </v-expansion-panels>
  <!-- Tool creation dialog (outside expansion panels to avoid watcher conflicts) -->
  <v-dialog
    v-model="toolCreationDialogOpen"
    width="60%"
    @update:model-value="onToolCreationDialogInput"
  >
    <tool-creation
      @done="onToolCreationDone"
      :open="toolCreationDialogOpen"
      :initial-selected-tool="selectedToolType"
    />
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, mergeProps } from "vue";
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

// Lists tools from a toolset, allows selecting a tool from the list, and adding new tools

const annotationMenuRefs = ref<any[]>([]);
function setAnnotationMenuRef(el: any) {
  if (el && !annotationMenuRefs.value.includes(el)) {
    annotationMenuRefs.value.push(el);
  }
}

const panels = ref<number>(0);

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

const isLoggedIn = computed(() => store.isLoggedIn);

const toolCreationDialogOpen = ref(false);
const toolTypeDialogOpen = ref(false);
const selectedToolType = ref<any>(null);

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

function onWorkerMenuLoaded() {
  nextTick(() => {
    for (const menuItem of annotationMenuRefs.value) {
      if (menuItem && typeof menuItem.updateDimensions === "function") {
        menuItem.updateDimensions();
      }
    }
  });
}

defineExpose({
  panels,
  selectedToolId,
  tools,
  toolsetTools,
  configuration,
  selectedTool,
  isLoggedIn,
  toolCreationDialogOpen,
  toolTypeDialogOpen,
  selectedToolType,
  onToolCreationDone,
  onToolCreationDialogInput,
  handleToolTypeSelected,
  getToolPropertiesDescription,
  onWorkerMenuLoaded,
});
</script>
<style scoped>
.tight-list .v-list-item {
  padding: 0px;
}
</style>

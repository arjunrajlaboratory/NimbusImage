<template>
  <v-expansion-panels v-model="panels">
    <v-expansion-panel expand v-model="panels">
      <v-expansion-panel-header class="pa-2">
        <v-toolbar-title> Toolset </v-toolbar-title>
        <!-- Tool Type Selection -->
        <v-dialog v-model="toolTypeDialogOpen" width="90%">
          <template v-slot:activator="{ on: dialog }">
            <v-tooltip top>
              <template v-slot:activator="{ on: tooltip }">
                <v-btn
                  class="ml-2"
                  color="primary"
                  v-on="{ ...dialog, ...tooltip }"
                  id="add-tool-tourstep"
                  v-tour-trigger="'add-tool-tourtrigger'"
                >
                  Add new tool
                </v-btn>
              </template>
              <span>Browse tool types</span>
            </v-tooltip>
          </template>
          <tool-type-selection @selected="handleToolTypeSelected" />
        </v-dialog>
        <!-- Tool creation -->
        <v-dialog
          v-model="toolCreationDialogOpen"
          width="60%"
          @input="onToolCreationDialogInput"
        >
          <tool-creation
            @done="onToolCreationDone"
            :open="toolCreationDialogOpen"
            :initial-selected-tool="selectedToolType"
          />
        </v-dialog>
      </v-expansion-panel-header>
      <v-expansion-panel-content>
        <!-- List toolset tools -->
        <v-list v-if="toolsetTools.length" dense class="tight-list">
          <v-list-item-group v-model="selectedToolId">
            <draggable>
              <template v-for="(tool, index) in toolsetTools">
                <v-tooltip
                  right
                  transition="none"
                  z-index="100"
                  :key="index"
                  v-if="tool"
                >
                  <template v-slot:activator="{ on, attrs }">
                    <!-- If type === segmentation, add an annotation worker menu -->
                    <template v-if="tool.type === 'segmentation'">
                      <v-menu
                        offset-x
                        :closeOnClick="false"
                        :closeOnContentClick="false"
                        :value="selectedTool && selectedTool.id === tool.id"
                        z-index="100"
                      >
                        <template #activator="{}">
                          <tool-item :tool="tool" v-bind="attrs" v-on="on" />
                        </template>
                        <annotation-worker-menu :tool="tool" />
                      </v-menu>
                    </template>
                    <!-- When the tool is a SAM tool, show options in an expansion panel -->
                    <template v-else-if="tool.type === 'samAnnotation'">
                      <div>
                        <tool-item :tool="tool" v-bind="attrs" v-on="on" />
                        <template
                          v-if="selectedTool && selectedTool.id === tool.id"
                        >
                          <sam-tool-menu :toolConfiguration="tool" />
                        </template>
                      </div>
                    </template>
                    <!-- Otherwiser, only tool item -->
                    <template v-else>
                      <tool-item :tool="tool" v-bind="attrs" v-on="on" />
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
            </draggable>
          </v-list-item-group>
          <circle-to-dot-menu
            :tool="selectedTool"
            v-if="
              selectedTool &&
              selectedTool.type === 'snap' &&
              selectedTool.values.snapTo.value === 'circleToDot'
            "
          />
        </v-list>
        <v-subheader v-if="!toolsetTools.length">
          No tools in the current toolset.
        </v-subheader>
      </v-expansion-panel-content>
    </v-expansion-panel>
  </v-expansion-panels>
</template>

<script lang="ts">
import { Vue, Component } from "vue-property-decorator";
import draggable from "vuedraggable";
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
@Component({
  components: {
    ToolCreation,
    ToolTypeSelection,
    ToolItem,
    AnnotationWorkerMenu,
    SamToolMenu,
    CircleToDotMenu,
    draggable,
  },
})
export default class Toolset extends Vue {
  readonly store = store;

  panels: number = 0;

  get selectedToolId() {
    return this.store.selectedTool?.configuration.id || null;
  }

  set selectedToolId(id: string | null) {
    this.store.setSelectedToolId(id || null);
  }

  get tools() {
    return this.store.tools;
  }

  get toolsetTools() {
    return this.configuration?.tools || [];
  }

  get configuration() {
    return this.store.configuration;
  }

  get selectedTool(): IToolConfiguration | null {
    return this.store.selectedTool?.configuration ?? null;
  }

  toolCreationDialogOpen: boolean = false;
  toolTypeDialogOpen: boolean = false;
  selectedToolType: any = null;

  onToolCreationDone() {
    // The child emitted "done" meaning the dialog is closing/cancelled/finished
    this.toolCreationDialogOpen = false;
    this.selectedToolType = null; // Now is the right time to clear it
  }

  onToolCreationDialogInput(newVal: boolean) {
    this.toolCreationDialogOpen = newVal;
    if (!newVal) {
      // The dialog was just closed by clicking outside or ESC
      this.selectedToolType = null;
    }
  }

  handleToolTypeSelected(toolType: any) {
    this.selectedToolType = toolType;
    this.toolTypeDialogOpen = false;
    this.toolCreationDialogOpen = true;
  }

  getToolPropertiesDescription(tool: IToolConfiguration): string[][] {
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
        const layer = this.store.getLayerFromId(layerId);
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
}
</script>
<style scoped>
.tight-list .v-list-item {
  padding: 0px;
}
</style>

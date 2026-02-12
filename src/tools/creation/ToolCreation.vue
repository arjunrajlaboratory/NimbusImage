<template>
  <div>
    <v-card class="pa-1">
      <v-card-title> Add a new tool </v-card-title>
      <v-card-text>
        <!-- Form elements generated from the template -->
        <tool-configuration
          :template="selectedTemplate"
          :defaultValues="selectedDefaultValues"
          v-model="toolValues"
          ref="toolConfiguration"
        />
        <v-container v-if="selectedTemplate" class="pa-4">
          <!-- Tool name with autofill -->
          <v-row dense>
            <v-col>
              <div class="title white--text">Tool Name</div>
            </v-col>
          </v-row>
          <v-row dense class="px-4">
            <v-col>
              <v-text-field
                v-model="toolName"
                :append-icon="userToolName ? 'mdi-refresh' : ''"
                @click:append="userToolName = false"
                @input="userToolName = true"
                dense
                id="tool-name-tourstep"
              />
            </v-col>
          </v-row>
          <!-- Tool hotkey -->
          <v-row dense>
            <v-col>
              <div class="title white--text">Tool Hotkey</div>
            </v-col>
          </v-row>
          <v-row dense class="px-4">
            <v-col>
              <hotkey-selection v-model="hotkey" />
            </v-col>
          </v-row>
        </v-container>
      </v-card-text>
      <v-card-actions>
        <v-container class="button-bar ma-0 pa-0">
          <v-spacer />
          <v-btn class="mr-4" color="warning" @click="close">CANCEL</v-btn>
          <v-btn
            class="mr-4"
            color="primary"
            @click="createTool"
            :disabled="!selectedTemplate"
            id="tool-creation-add-tool-button-tourstep"
            v-tour-trigger="`tool-creation-add-tool-button-tourtrigger`"
          >
            ADD TOOL TO TOOLSET
          </v-btn>
        </v-container>
      </v-card-actions>
    </v-card>
  </div>
</template>
<script lang="ts">
import { Vue, Component, Watch, Prop } from "vue-property-decorator";
import store from "@/store";
import propertiesStore from "@/store/properties";
import { IToolConfiguration, IToolTemplate } from "@/store/model";

import ToolConfiguration from "@/tools/creation/ToolConfiguration.vue";
import ToolTypeSelection, {
  TReturnType as TToolTypeSelectionValue,
} from "@/tools/creation/ToolTypeSelection.vue";
import HotkeySelection from "@/components/HotkeySelection.vue";
import { v4 as uuidv4 } from "uuid";

const defaultValues = {
  name: "New Tool",
  description: "",
};

// Popup for new tool configuration
@Component({
  components: {
    ToolConfiguration,
    ToolTypeSelection,
    HotkeySelection,
  },
})
export default class ToolCreation extends Vue {
  readonly store = store;
  readonly propertyStore = propertiesStore;

  toolValues: Record<string, any> = { ...defaultValues };

  selectedTemplate: IToolTemplate | null = null;
  selectedDefaultValues: any | null = null;

  errorMessages: string[] = [];
  successMessages: string[] = [];

  userToolName = false;
  toolName = "New Tool";

  hotkey: string | null = null;

  @Prop({ default: false })
  readonly open!: boolean;

  @Prop({ default: null })
  readonly initialSelectedTool!: TToolTypeSelectionValue | null;

  private _selectedTool: TToolTypeSelectionValue | null = null;

  @Watch("initialSelectedTool", { immediate: true })
  onInitialSelectedToolChange(newVal: TToolTypeSelectionValue | null) {
    this.selectedTool = newVal;
  }

  createTool() {
    if (this.selectedTemplate === null) {
      return;
    }

    const tool: IToolConfiguration = {
      id: uuidv4(),
      name: this.toolName || "Unnamed Tool",
      template: this.selectedTemplate,
      values: this.toolValues,
      type: this.selectedTemplate.type,
      hotkey: this.hotkey,
    };

    // Add this tool to the current toolset
    this.store.addToolToConfiguration(tool);

    this.close();
  }

  set selectedTool(value) {
    this._selectedTool = value;
    this.selectedTemplate = value?.template ?? null;
    this.selectedDefaultValues = value?.defaultValues ?? null;
  }

  get selectedTool(): TToolTypeSelectionValue | null {
    return this.selectedTemplate ? this._selectedTool : null;
  }

  @Watch("selectedTemplate")
  @Watch("toolValues", { deep: true })
  @Watch("userToolName")
  updateAutoToolName() {
    if (this.userToolName) {
      return;
    }
    const toolNameStrings: string[] = [];
    const dockerImage = this.toolValues?.image?.image;
    if (dockerImage) {
      const defaultToolName = this.propertyStore.defaultToolName(dockerImage);
      if (defaultToolName) {
        toolNameStrings.push(defaultToolName);
      }
    }
    if (this.toolValues?.annotation?.tags) {
      toolNameStrings.push(this.toolValues.annotation.tags.join(", "));
    }
    if (this.toolValues?.model) {
      toolNameStrings.push(this.toolValues.model.text);
    }
    // AR: I removed the shortName from the tool name because I thought it made the tool name cluttered,
    // but I'm keeping it here in case we ever want to use it again.
    // if (this.selectedTemplate?.shortName) {
    //   toolNameStrings.push(`(${this.selectedTemplate.shortName})`);
    // }
    if (this.toolValues?.action) {
      toolNameStrings.push(this.toolValues.action.text);
    }
    if (this.selectedTemplate?.type === "tagging" && this.toolValues?.tags) {
      toolNameStrings.push(this.toolValues.tags.join(", "));
    }
    if (this.toolValues?.parentAnnotation && this.toolValues?.childAnnotation) {
      const parentValues = this.toolValues.parentAnnotation;
      const childValues = this.toolValues.childAnnotation;
      const newString =
        (parentValues.tags.join(", ") ||
          (parentValues.tagsInclusive ? "All" : "No tag")) +
        " to " +
        (childValues.tags.join(", ") ||
          (childValues.tagsInclusive ? "All" : "No tag"));
      toolNameStrings.push(newString);
    }
    if (toolNameStrings.length > 0) {
      this.toolName = toolNameStrings.join(" ");
      return;
    }
    if (this._selectedTool?.selectedItem?.text) {
      toolNameStrings.push(this._selectedTool?.selectedItem?.text);
    }
    if (this.selectedTemplate) {
      toolNameStrings.push(this.selectedTemplate.name);
    }
    if (toolNameStrings.length > 0) {
      this.toolName = toolNameStrings.join(" ");
      return;
    }
    this.toolName = "New Tool";
  }

  @Watch("open")
  onOpenChange(newValue: boolean) {
    if (!newValue) {
      // Only reset when closing
      this.reset();
    }
  }

  reset() {
    this.userToolName = false;
    this.toolName = "New Tool";
    this.selectedTemplate = null;
    this.selectedDefaultValues = null;
    this.hotkey = null;

    if (!this.$refs.toolConfiguration) {
      return;
    }

    const toolConfiguration = this.$refs.toolConfiguration as any;
    if (toolConfiguration) {
      toolConfiguration.reset();
    }
  }

  close() {
    this.reset();
    this.$emit("done");
  }
}
</script>

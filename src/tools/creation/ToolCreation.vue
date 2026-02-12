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
          ref="toolConfigurationRef"
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

<script setup lang="ts">
import { ref, watch, computed } from "vue";
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

const props = withDefaults(
  defineProps<{
    open?: boolean;
    initialSelectedTool?: TToolTypeSelectionValue | null;
  }>(),
  {
    open: false,
    initialSelectedTool: null,
  },
);

const emit = defineEmits<{
  (e: "done"): void;
}>();

const toolValues = ref<Record<string, any>>({ ...defaultValues });
const selectedTemplate = ref<IToolTemplate | null>(null);
const selectedDefaultValues = ref<any | null>(null);
const userToolName = ref(false);
const toolName = ref("New Tool");
const hotkey = ref<string | null>(null);
const _selectedTool = ref<TToolTypeSelectionValue | null>(null);
const toolConfigurationRef = ref<InstanceType<typeof ToolConfiguration> | null>(
  null,
);

// Computed getter/setter for selectedTool
const selectedTool = computed({
  get: (): TToolTypeSelectionValue | null => {
    return selectedTemplate.value ? _selectedTool.value : null;
  },
  set: (value: TToolTypeSelectionValue | null) => {
    _selectedTool.value = value;
    selectedTemplate.value = value?.template ?? null;
    selectedDefaultValues.value = value?.defaultValues ?? null;
  },
});

function createTool() {
  if (selectedTemplate.value === null) {
    return;
  }

  const tool: IToolConfiguration = {
    id: uuidv4(),
    name: toolName.value || "Unnamed Tool",
    template: selectedTemplate.value,
    values: toolValues.value,
    type: selectedTemplate.value.type,
    hotkey: hotkey.value,
  };

  // Add this tool to the current toolset
  store.addToolToConfiguration(tool);

  close();
}

function updateAutoToolName() {
  if (userToolName.value) {
    return;
  }
  const toolNameStrings: string[] = [];
  const dockerImage = toolValues.value?.image?.image;
  if (dockerImage) {
    const defaultToolName = propertiesStore.defaultToolName(dockerImage);
    if (defaultToolName) {
      toolNameStrings.push(defaultToolName);
    }
  }
  if (toolValues.value?.annotation?.tags) {
    toolNameStrings.push(toolValues.value.annotation.tags.join(", "));
  }
  if (toolValues.value?.model) {
    toolNameStrings.push(toolValues.value.model.text);
  }
  if (toolValues.value?.action) {
    toolNameStrings.push(toolValues.value.action.text);
  }
  if (selectedTemplate.value?.type === "tagging" && toolValues.value?.tags) {
    toolNameStrings.push(toolValues.value.tags.join(", "));
  }
  if (toolValues.value?.parentAnnotation && toolValues.value?.childAnnotation) {
    const parentValues = toolValues.value.parentAnnotation;
    const childValues = toolValues.value.childAnnotation;
    const newString =
      (parentValues.tags.join(", ") ||
        (parentValues.tagsInclusive ? "All" : "No tag")) +
      " to " +
      (childValues.tags.join(", ") ||
        (childValues.tagsInclusive ? "All" : "No tag"));
    toolNameStrings.push(newString);
  }
  if (toolNameStrings.length > 0) {
    toolName.value = toolNameStrings.join(" ");
    return;
  }
  if (_selectedTool.value?.selectedItem?.text) {
    toolNameStrings.push(_selectedTool.value?.selectedItem?.text);
  }
  if (selectedTemplate.value) {
    toolNameStrings.push(selectedTemplate.value.name);
  }
  if (toolNameStrings.length > 0) {
    toolName.value = toolNameStrings.join(" ");
    return;
  }
  toolName.value = "New Tool";
}

function reset() {
  userToolName.value = false;
  toolName.value = "New Tool";
  selectedTemplate.value = null;
  selectedDefaultValues.value = null;
  hotkey.value = null;

  if (!toolConfigurationRef.value) {
    return;
  }

  toolConfigurationRef.value.reset();
}

function close() {
  reset();
  emit("done");
}

// Watch initialSelectedTool prop (immediate)
watch(
  () => props.initialSelectedTool,
  (newVal) => {
    selectedTool.value = newVal;
  },
  { immediate: true },
);

// Watch selectedTemplate, toolValues (deep), userToolName -> updateAutoToolName
watch(selectedTemplate, updateAutoToolName);
watch(toolValues, updateAutoToolName, { deep: true });
watch(userToolName, updateAutoToolName);

// Watch open prop -> reset when closing
watch(
  () => props.open,
  (newValue) => {
    if (!newValue) {
      reset();
    }
  },
);

defineExpose({
  toolValues,
  selectedTemplate,
  selectedDefaultValues,
  userToolName,
  toolName,
  hotkey,
  selectedTool,
  toolConfigurationRef,
  createTool,
  updateAutoToolName,
  reset,
  close,
});
</script>

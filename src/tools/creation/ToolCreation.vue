<template>
  <div>
    <v-card class="tool-creation-card">
      <v-card-title class="tool-creation-header">
        Add a new tool
        <v-btn
          v-if="showAdvancedButton"
          size="small"
          variant="text"
          :color="advancedOpen ? 'primary' : undefined"
          @click="advancedOpen = !advancedOpen"
        >
          Advanced
          <v-icon size="small" class="ml-1">
            {{ advancedOpen ? "mdi-chevron-left" : "mdi-chevron-right" }}
          </v-icon>
        </v-btn>
      </v-card-title>
      <div class="tool-creation-body">
        <!-- Main column: config + tool name/hotkey -->
        <div class="tool-creation-main">
          <div class="tool-creation-config">
            <tool-configuration
              :template="selectedTemplate"
              :defaultValues="selectedDefaultValues"
              v-model="toolValues"
              ref="toolConfigurationRef"
              :external-advanced="true"
            />
          </div>
          <!-- Tool name and hotkey (above buttons) -->
          <div v-if="selectedTemplate" class="tool-creation-name-section">
            <div class="name-row">
              <div class="name-label">Tool Name</div>
              <v-text-field
                v-model="toolName"
                :append-inner-icon="userToolName ? 'mdi-refresh' : undefined"
                @click:append-inner="userToolName = false"
                @input="userToolName = true"
                variant="outlined"
                density="compact"
                hide-details
                class="tool-name-field"
                id="tool-name-tourstep"
              />
            </div>
            <div class="hotkey-row">
              <hotkey-selection v-model="hotkey" />
            </div>
          </div>
          <v-card-actions class="tool-creation-actions">
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
          </v-card-actions>
        </div>
        <!-- Advanced panel (right column, conditional) -->
        <div
          v-if="advancedOpen && advancedItems.length"
          class="tool-creation-advanced"
        >
          <div class="advanced-content">
            <v-container>
              <template v-for="(item, index) in advancedItems" :key="index">
                <tool-configuration-item
                  v-if="shouldShowAdvancedItem(item)"
                  :item="item"
                  :advanced="true"
                  @change="onAdvancedItemChanged"
                  v-model="configToolValues[item.id]"
                  :ref="getAdvancedRefSetter(item.id)"
                />
              </template>
            </v-container>
          </div>
        </div>
      </div>
    </v-card>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, computed } from "vue";
import store from "@/store";
import propertiesStore from "@/store/properties";
import { IToolConfiguration, IToolTemplate } from "@/store/model";

import ToolConfiguration from "@/tools/creation/ToolConfiguration.vue";
import ToolConfigurationItem from "@/tools/creation/ToolConfigurationItem.vue";
import { type TReturnType as TToolTypeSelectionValue } from "@/tools/creation/ToolTypeSelection.vue";
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
  (e: "advanced-changed", isOpen: boolean): void;
}>();

const toolValues = ref<Record<string, any>>({ ...defaultValues });
const selectedTemplate = ref<IToolTemplate | null>(null);
const selectedDefaultValues = ref<any | null>(null);
const userToolName = ref(false);
const toolName = ref("New Tool");
const hotkey = ref<string | null>(null);
const _selectedTool = ref<TToolTypeSelectionValue | null>(null);
const advancedOpen = ref(false);
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

// Show the Advanced button only when a template is selected and has advanced items
const showAdvancedButton = computed(
  () =>
    !!selectedTemplate.value &&
    (toolConfigurationRef.value?.hasAdvancedItems ?? false),
);

// Access ToolConfiguration's internal state for rendering advanced items externally
const advancedItems = computed(
  () => toolConfigurationRef.value?.advancedInternalTemplate ?? [],
);

const configToolValues = computed(
  () => toolConfigurationRef.value?.toolValues ?? {},
);

function shouldShowAdvancedItem(item: any): boolean {
  return toolConfigurationRef.value?.shouldShowConfigurationItem(item) ?? true;
}

function getAdvancedRefSetter(id: string) {
  return toolConfigurationRef.value?.getRefSetter(id) ?? (() => {});
}

function onAdvancedItemChanged() {
  toolConfigurationRef.value?.changed();
}

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
  advancedOpen.value = false;

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

// Emit advanced-changed when advancedOpen toggles
watch(advancedOpen, (isOpen) => {
  emit("advanced-changed", isOpen);
});

defineExpose({
  toolValues,
  selectedTemplate,
  selectedDefaultValues,
  userToolName,
  toolName,
  hotkey,
  selectedTool,
  advancedOpen,
  toolConfigurationRef,
  createTool,
  updateAutoToolName,
  reset,
  close,
});
</script>

<style scoped>
.tool-creation-card {
  display: flex;
  flex-direction: column;
  max-height: 80vh;
  width: 100%;
}

.tool-creation-header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.tool-creation-body {
  flex: 1 1 auto;
  display: flex;
  min-height: 0;
  overflow: hidden;
}

.tool-creation-main {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}

.tool-creation-config {
  flex: 1 1 auto;
  overflow-y: scroll;
  padding: 0 8px;
}

.tool-creation-name-section {
  flex: 0 0 auto;
  padding: 12px 24px;
  border-top: 1px solid rgba(128, 128, 128, 0.15);
}

.name-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.name-label {
  font-size: 0.85rem;
  font-weight: 600;
  opacity: 0.7;
  flex-shrink: 0;
}

.tool-name-field {
  flex: 1 1 auto;
}

.tool-name-field :deep(.v-field) {
  font-weight: 600;
}

.hotkey-row {
  margin-top: 4px;
}

.tool-creation-actions {
  flex: 0 0 auto;
  border-top: 1px solid rgba(128, 128, 128, 0.15);
}

/* Advanced panel (right column) */
.tool-creation-advanced {
  flex: 0 0 50%;
  max-width: 70%;
  display: flex;
  flex-direction: column;
  border-left: 1px solid rgba(128, 128, 128, 0.15);
  min-height: 0;
}

.advanced-content {
  flex: 1 1 auto;
  overflow-y: scroll;
}

.advanced-content :deep(.v-container) {
  padding: 8px;
}

.advanced-content :deep(.v-card-text .v-container) {
  padding: 2px 6px;
}

.advanced-content :deep(.v-checkbox .v-label) {
  white-space: normal;
  min-width: 120px;
}
</style>

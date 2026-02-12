<template>
  <v-card>
    <v-card-title>
      <span class="headline">Edit tool:</span>
      <v-text-field
        dense
        hide-details
        class="ma-0 ml-2 headline"
        v-model="toolName"
      />
    </v-card-title>
    <v-card-text>
      <tool-configuration
        :template="tool.template"
        :defaultValues="tool.values"
        v-model="toolValues"
        ref="toolConfigurationRef"
      />
      <div class="ma-6 mb-0">
        <div class="title white--text">Tool Hotkey</div>
        <hotkey-selection v-model="toolHotkey" />
      </div>
    </v-card-text>
    <v-card-actions class="py-4">
      <v-btn @click="removeTool" color="red" class="mr-4">
        Delete tool
        <v-icon class="ml-1">mdi-delete</v-icon>
      </v-btn>
      <v-spacer />
      <v-btn @click="cancel" color="warning" class="mr-4">
        Cancel
        <v-icon class="ml-1">mdi-undo</v-icon>
      </v-btn>
      <v-btn @click="submit" color="primary" class="mr-4">
        Update tool
        <v-icon class="ml-1">mdi-check</v-icon>
      </v-btn>
    </v-card-actions>
  </v-card>
</template>

<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import { IToolConfiguration } from "@/store/model";
import store from "@/store";
import ToolConfiguration from "@/tools/creation/ToolConfiguration.vue";
import HotkeySelection from "@/components/HotkeySelection.vue";

const props = defineProps<{
  tool: IToolConfiguration;
}>();

const emit = defineEmits<{
  (e: "close"): void;
}>();

const toolConfigurationRef = ref<InstanceType<typeof ToolConfiguration> | null>(
  null,
);
const toolValues = ref<any>({});
const toolName = ref("");
const toolHotkey = ref<string | null>(null);

function reset() {
  toolName.value = props.tool.name;
  toolHotkey.value = props.tool.hotkey;

  const tc = toolConfigurationRef.value;
  if (tc) {
    tc.reset();
  }
}

function submit() {
  const newTool: IToolConfiguration = {
    ...props.tool,
    name: toolName.value,
    hotkey: toolHotkey.value,
    values: toolValues.value,
  };
  store.editToolInConfiguration(newTool);
  emit("close");
}

function cancel() {
  reset();
  emit("close");
}

function removeTool() {
  store.removeToolFromConfiguration(props.tool.id);
  emit("close");
}

watch(() => props.tool, reset);

onMounted(() => {
  reset();
});

defineExpose({
  toolValues,
  toolName,
  toolHotkey,
  reset,
  submit,
  cancel,
  removeTool,
});
</script>

<template>
  <v-card class="pa-4">
    <v-card-title>Channel Color Preferences</v-card-title>
    <v-card-text>
      <p class="text-subtitle-2 mb-4">
        Customize the default colors for your fluorescence channels. These
        preferences will be applied when creating new layers.
      </p>
      <p class="text-caption mb-4 text--secondary">
        <v-icon small class="mr-1">mdi-asterisk</v-icon>
        Channels marked with * have custom overrides
      </p>

      <v-row>
        <v-col
          v-for="channel in allChannels"
          :key="channel"
          cols="12"
          md="6"
          lg="4"
        >
          <v-row align="center" no-gutters>
            <v-col cols="8">
              <v-text-field
                :value="displayColors[channel]"
                @input="onColorInput(String(channel), $event)"
                :label="getChannelLabel(String(channel))"
                dense
                outlined
                hide-details
                :rules="[colorRule]"
              />
            </v-col>
            <v-col cols="3" class="ml-2">
              <v-btn
                :color="
                  typeof displayColors[channel] === 'string'
                    ? displayColors[channel]
                    : '#FFFFFF'
                "
                block
                small
                @click="openColorPicker(String(channel))"
              >
                <v-icon>mdi-palette</v-icon>
              </v-btn>
            </v-col>
            <v-col cols="1">
              <v-btn
                v-if="!isCustomChannel(String(channel))"
                icon
                small
                @click="resetColor(String(channel))"
                title="Reset to default"
              >
                <v-icon>mdi-refresh</v-icon>
              </v-btn>
              <v-btn
                v-else
                icon
                small
                @click="resetColor(String(channel))"
                title="Remove override"
              >
                <v-icon>mdi-close</v-icon>
              </v-btn>
            </v-col>
          </v-row>
        </v-col>
      </v-row>

      <v-row class="mt-4">
        <v-col>
          <v-btn
            outlined
            color="secondary"
            @click="showAddChannelDialog = true"
            class="mb-2"
          >
            <v-icon left>mdi-plus</v-icon>
            Add New Channel Default
          </v-btn>
        </v-col>
      </v-row>

      <v-row class="mt-2">
        <v-col>
          <v-btn color="primary" @click="saveAndClose" :loading="saving">
            Save Preferences
          </v-btn>
          <v-btn class="ml-2" @click="resetAllColors"> Reset All </v-btn>
          <v-btn class="ml-2" text @click="cancelChanges"> Cancel </v-btn>
        </v-col>
      </v-row>

      <v-snackbar v-model="showSuccess" color="success" timeout="3000">
        Color preferences saved successfully!
      </v-snackbar>
    </v-card-text>

    <!-- Color picker dialog -->
    <v-dialog v-model="colorPickerDialog" max-width="300">
      <v-card>
        <v-card-title>Choose Color for {{ selectedChannel }}</v-card-title>
        <v-card-text>
          <v-color-picker v-model="pickerColor" hide-mode-switch />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn text @click="colorPickerDialog = false">Cancel</v-btn>
          <v-btn color="primary" @click="applyPickerColor">Apply</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Add new channel dialog -->
    <v-dialog v-model="showAddChannelDialog" max-width="400">
      <v-card>
        <v-card-title>Add New Channel Default</v-card-title>
        <v-card-text>
          <v-text-field
            v-model="newChannelName"
            label="Channel Name"
            placeholder="e.g., NEWCHANNEL, CUSTOM_MARKER"
            :rules="[channelNameRule]"
            @keyup.enter="addNewChannel"
            autofocus
          />
          <v-text-field
            v-model="newChannelColor"
            label="Default Color"
            placeholder="#FF0000"
            :rules="[colorRule]"
            @keyup.enter="addNewChannel"
          >
            <template #append-outer>
              <v-btn icon small @click="openNewChannelColorPicker">
                <v-icon :color="newChannelColor">mdi-palette</v-icon>
              </v-btn>
            </template>
          </v-text-field>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn text @click="cancelAddChannel">Cancel</v-btn>
          <v-btn
            color="primary"
            @click="addNewChannel"
            :disabled="!isNewChannelValid"
          >
            Add Channel
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- New channel color picker dialog -->
    <v-dialog v-model="newChannelColorPickerDialog" max-width="300">
      <v-card>
        <v-card-title>Choose Color for New Channel</v-card-title>
        <v-card-text>
          <v-color-picker v-model="newChannelColorPicker" hide-mode-switch />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn text @click="newChannelColorPickerDialog = false"
            >Cancel</v-btn
          >
          <v-btn color="primary" @click="applyNewChannelColor">Apply</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-card>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import store from "@/store";
import { getChannelColors, COLOR } from "@/store/model";
import { logError } from "@/utils/log";

const props = withDefaults(
  defineProps<{
    visible: boolean;
  }>(),
  { visible: false },
);

const emit = defineEmits<{
  (e: "close"): void;
}>();

// Store ONLY user overrides locally for editing
const localOverrides = ref<Record<string, string>>({});

const saving = ref(false);
const showSuccess = ref(false);
const colorPickerDialog = ref(false);
const selectedChannel = ref("");
const pickerColor = ref<string>(COLOR.RED);

// Add new channel dialog state
const showAddChannelDialog = ref(false);
const newChannelName = ref("");
const newChannelColor = ref<string>(COLOR.RED);
const newChannelColorPickerDialog = ref(false);
const newChannelColorPicker = ref<string>(COLOR.RED);

// Common channels that we should list first
const commonChannels = [
  "DAPI",
  "GFP",
  "YFP",
  "CY3",
  "CY5",
  "CY7",
  "FITC",
  "TRITC",
  "ALEXA488",
  "ALEXA594",
  "MCHERRY",
  "BFP",
  "CFP",
  "DEFAULT",
];

// Computed property: all channels to display (base + custom overrides)
const allChannels = computed<string[]>(() => {
  const base = Object.keys(getChannelColors());
  // Order base by common channels
  const orderedBase = commonChannels.filter((channel) =>
    base.includes(channel),
  );
  const remainingBase = base.filter(
    (channel) => !commonChannels.includes(channel),
  );
  const custom = Object.keys(localOverrides.value).filter(
    (channel) => !base.includes(channel),
  );
  return [...orderedBase, ...remainingBase, ...custom];
});

function isCustomChannel(channel: string): boolean {
  const base = Object.keys(getChannelColors());
  return !base.includes(channel) && channel in localOverrides.value;
}

// Computed property: merged display colors (defaults + overrides)
const displayColors = computed<Record<string, string>>(() => {
  return getChannelColors(localOverrides.value);
});

watch(
  () => props.visible,
  async (isVisible) => {
    if (isVisible) {
      // Refresh store from database, then load into local state
      await store.loadUserColors();
      loadColors();
    }
  },
);

function getChannelLabel(channel: string): string {
  return hasUserOverride(channel) ? `${channel} *` : channel;
}

function hasUserOverride(channel: string): boolean {
  return channel in localOverrides.value;
}

function loadColors() {
  // Load overrides from store only (do not include defaults)
  const userColors = store.userChannelColors || {};

  const newOverrides: Record<string, string> = {};
  for (const [channel, color] of Object.entries(userColors)) {
    newOverrides[channel] = String(color);
  }

  // Replace the entire overrides object to trigger reactivity
  localOverrides.value = newOverrides;
}

async function saveColors() {
  saving.value = true;
  try {
    // Save ONLY the overrides (matches DB schema)
    await store.saveUserColors(localOverrides.value);
    showSuccess.value = true;
  } catch (error) {
    logError("Failed to save color preferences:", error);
  } finally {
    saving.value = false;
  }
}

function resetColor(channel: string) {
  // Remove the override, falling back to default
  if (channel in localOverrides.value) {
    const { [channel]: _, ...rest } = localOverrides.value;
    localOverrides.value = rest;
  }
}

function openColorPicker(channel: string) {
  selectedChannel.value = channel;
  pickerColor.value = displayColors.value[channel];
  colorPickerDialog.value = true;
}

function applyPickerColor() {
  if (selectedChannel.value) {
    localOverrides.value = {
      ...localOverrides.value,
      [selectedChannel.value]: pickerColor.value,
    };
  }
  colorPickerDialog.value = false;
}

function onColorInput(channel: string, value: string) {
  // Validate input via rule; if valid, set override, else ignore
  const isValid = colorRule(value) === true;
  if (isValid) {
    localOverrides.value = { ...localOverrides.value, [channel]: value };
  }
}

function colorRule(value: string) {
  return (
    /^#[0-9A-F]{6}$/i.test(value) || "Must be a valid hex color (e.g., #FF0000)"
  );
}

function channelNameRule(value: string) {
  if (!value || value.trim() === "") {
    return "Channel name is required";
  }
  // Prevent duplicates against merged map (defaults + overrides)
  if (value.toUpperCase() in getChannelColors(localOverrides.value)) {
    return "Channel name already exists";
  }
  if (!/^[A-Z0-9_]+$/i.test(value)) {
    return "Channel name can only contain letters, numbers, and underscores";
  }
  return true;
}

const isNewChannelValid = computed(() => {
  return (
    channelNameRule(newChannelName.value) === true &&
    colorRule(newChannelColor.value) === true
  );
});

function openNewChannelColorPicker() {
  newChannelColorPicker.value = newChannelColor.value;
  newChannelColorPickerDialog.value = true;
}

function applyNewChannelColor() {
  newChannelColor.value = newChannelColorPicker.value;
  newChannelColorPickerDialog.value = false;
}

function cancelAddChannel() {
  showAddChannelDialog.value = false;
  newChannelName.value = "";
  newChannelColor.value = COLOR.RED;
}

function addNewChannel() {
  if (!isNewChannelValid.value) {
    return;
  }

  const channelName = newChannelName.value.trim().toUpperCase();

  // Replace entire object to trigger Vue 2.7 reactivity for new keys
  localOverrides.value = {
    ...localOverrides.value,
    [channelName]: newChannelColor.value,
  };

  // Reset the form
  cancelAddChannel();
}

async function saveAndClose() {
  await saveColors();
  if (!saving.value) {
    // Close dialog - store should already be updated
    emit("close");
  }
}

function resetAllColors() {
  // Clear all local overrides (reverts to defaults in UI)
  localOverrides.value = {};
}

function cancelChanges() {
  // Reload from store to discard any unsaved changes
  loadColors();
  emit("close");
}

onMounted(async () => {
  // Refresh store from database, then load into local state
  try {
    await store.loadUserColors();
  } catch (error) {
    logError("Failed to load user colors from backend:", error);
  }
  loadColors();
});

defineExpose({
  localOverrides,
  saving,
  allChannels,
  displayColors,
  isNewChannelValid,
  colorRule,
  channelNameRule,
  isCustomChannel,
  getChannelLabel,
  loadColors,
  saveColors,
  resetColor,
  openColorPicker,
  applyPickerColor,
  onColorInput,
  addNewChannel,
  saveAndClose,
  resetAllColors,
  cancelChanges,
});
</script>

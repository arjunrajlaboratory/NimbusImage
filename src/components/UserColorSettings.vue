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

<script lang="ts">
import Vue from "vue";
import {
  Component,
  Watch,
  Prop,
  Vue as VueClass,
} from "vue-property-decorator";
import store from "@/store";
import { getChannelColors, COLOR } from "@/store/model";
import { logError } from "@/utils/log";

@Component
export default class UserColorSettings extends VueClass {
  readonly store = store;

  @Prop({ type: Boolean, default: false })
  visible!: boolean;

  // Store ONLY user overrides locally for editing
  localOverrides: { [key: string]: string } = {};

  saving = false;
  showSuccess = false;
  colorPickerDialog = false;
  selectedChannel = "";
  pickerColor: string = COLOR.RED;

  // Add new channel dialog state
  showAddChannelDialog = false;
  newChannelName = "";
  newChannelColor: string = COLOR.RED;
  newChannelColorPickerDialog = false;
  newChannelColorPicker: string = COLOR.RED;

  // Common channels that we should list first
  commonChannels = [
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
  get allChannels(): string[] {
    const base = Object.keys(getChannelColors());
    // Order base by common channels
    const orderedBase = this.commonChannels.filter((channel) =>
      base.includes(channel),
    );
    const remainingBase = base.filter(
      (channel) => !this.commonChannels.includes(channel),
    );
    const custom = Object.keys(this.localOverrides).filter(
      (channel) => !base.includes(channel),
    );
    return [...orderedBase, ...remainingBase, ...custom];
  }

  isCustomChannel(channel: string): boolean {
    const base = Object.keys(getChannelColors());
    return !base.includes(channel) && channel in this.localOverrides;
  }

  // Computed property: merged display colors (defaults + overrides)
  get displayColors(): { [key: string]: string } {
    return getChannelColors(this.localOverrides);
  }

  @Watch("visible")
  async onVisibleChanged(isVisible: boolean) {
    if (isVisible) {
      // Refresh store from database, then load into local state
      await this.store.loadUserColors();

      this.loadColors();
    }
  }

  getChannelLabel(channel: string): string {
    const hasUserOverride = this.hasUserOverride(channel);
    return hasUserOverride ? `${channel} *` : channel;
  }

  hasUserOverride(channel: string): boolean {
    // Check if this channel has a user override
    return channel in this.localOverrides;
  }

  async mounted() {
    // Refresh store from database, then load into local state
    try {
      await this.store.loadUserColors();
    } catch (error) {
      logError("Failed to load user colors from backend:", error);
    }
    this.loadColors();
  }

  loadColors() {
    // Load overrides from store only (do not include defaults)
    const userColors = this.store.userChannelColors || {};

    const newOverrides: { [key: string]: string } = {};
    for (const [channel, color] of Object.entries(userColors)) {
      newOverrides[channel] = String(color);
    }

    // Replace the entire overrides object to trigger reactivity
    this.localOverrides = newOverrides;
  }

  async saveColors() {
    this.saving = true;
    try {
      // Save ONLY the overrides (matches DB schema)
      await this.store.saveUserColors(this.localOverrides);

      this.showSuccess = true;
    } catch (error) {
      logError("Failed to save color preferences:", error);
    } finally {
      this.saving = false;
    }
  }

  resetColor(channel: string) {
    // Remove the override, falling back to default
    if (channel in this.localOverrides) {
      Vue.delete(this.localOverrides, channel);
    }
  }

  openColorPicker(channel: string) {
    this.selectedChannel = channel;
    this.pickerColor = this.displayColors[channel];
    this.colorPickerDialog = true;
  }

  applyPickerColor() {
    if (this.selectedChannel) {
      // Set/override user color using Vue.set for reactivity
      Vue.set(this.localOverrides, this.selectedChannel, this.pickerColor);
    }
    this.colorPickerDialog = false;
  }

  onColorInput(channel: string, value: string) {
    // Validate input via rule; if valid, set override, else ignore
    const isValid = this.colorRule(value) === true;
    if (isValid) {
      Vue.set(this.localOverrides, channel, value);
    }
  }

  colorRule(value: string) {
    return (
      /^#[0-9A-F]{6}$/i.test(value) ||
      "Must be a valid hex color (e.g., #FF0000)"
    );
  }

  channelNameRule(value: string) {
    if (!value || value.trim() === "") {
      return "Channel name is required";
    }
    // Prevent duplicates against merged map (defaults + overrides)
    if (value.toUpperCase() in getChannelColors(this.localOverrides)) {
      return "Channel name already exists";
    }
    if (!/^[A-Z0-9_]+$/i.test(value)) {
      return "Channel name can only contain letters, numbers, and underscores";
    }
    return true;
  }

  get isNewChannelValid() {
    return (
      this.channelNameRule(this.newChannelName) === true &&
      this.colorRule(this.newChannelColor) === true
    );
  }

  openNewChannelColorPicker() {
    this.newChannelColorPicker = this.newChannelColor;
    this.newChannelColorPickerDialog = true;
  }

  applyNewChannelColor() {
    this.newChannelColor = this.newChannelColorPicker;
    this.newChannelColorPickerDialog = false;
  }

  cancelAddChannel() {
    this.showAddChannelDialog = false;
    this.newChannelName = "";
    this.newChannelColor = COLOR.RED;
  }

  addNewChannel() {
    if (!this.isNewChannelValid) {
      return;
    }

    const channelName = this.newChannelName.trim().toUpperCase();

    // Add override using Vue.set for reactivity
    Vue.set(this.localOverrides, channelName, this.newChannelColor);

    // Reset the form
    this.cancelAddChannel();
  }

  async saveAndClose() {
    await this.saveColors();
    if (!this.saving) {
      // Close dialog - store should already be updated
      this.$emit("close");
    }
  }

  resetAllColors() {
    // Clear all local overrides (reverts to defaults in UI)
    this.localOverrides = {};
  }

  cancelChanges() {
    // Reload from store to discard any unsaved changes
    this.loadColors();
    this.$emit("close");
  }
}
</script>

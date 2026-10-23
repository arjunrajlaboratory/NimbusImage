<template>
  <section class="settings-section">
    <h4 class="settings-section-title">Interface</h4>
    <div class="settings-section-body">
      <v-switch
        hide-details
        density="compact"
        v-model="darkMode"
        label="Dark mode"
        v-description="{
          section: 'Interface settings',
          title: 'Dark mode',
          description: 'Enable dark mode',
        }"
      />
      <v-divider class="settings-divider" />

      <v-expansion-panels v-model="advancedOpen" flat class="advanced-panels">
        <v-expansion-panel value="advanced">
          <v-expansion-panel-title class="advanced-title">
            Advanced settings for large numbers of annotations
          </v-expansion-panel-title>
          <v-expansion-panel-text>
            <VisibilitySettings />
          </v-expansion-panel-text>
        </v-expansion-panel>
      </v-expansion-panels>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useTheme } from "vuetify";
import Persister from "@/store/Persister";
import VisibilitySettings from "@/components/VisibilitySettings.vue";
import { useCommand } from "@/commands/registry";

const theme = useTheme();

const darkMode = computed({
  get: () => theme.global.name.value === "dark",
  set: (value: boolean) => {
    // theme.change(), not assigning theme.global.name: Vuetify 4 deprecates
    // the assignment (a [Vuetify UPGRADE] warning on every toggle).
    theme.change(value ? "dark" : "light");
  },
});

// The theme applies on every route, so this command needs no viewer gate.
useCommand(() => ({
  id: "settings.darkMode",
  title: darkMode.value ? "Switch to light mode" : "Switch to dark mode",
  group: "Actions",
  // Only the theme it switches to.
  keywords: darkMode.value
    ? ["light", "theme", "appearance"]
    : ["dark", "theme", "appearance", "night"],
  icon: "mdi-theme-light-dark",
  run: () => {
    darkMode.value = !darkMode.value;
  },
}));

// Disclosure open state, persisted so a power user who opens it keeps it open.
const PERSIST_KEY = "uiSettingsAdvancedOpen";
const advancedOpen = ref<string | undefined>(
  Persister.get(PERSIST_KEY, false) ? "advanced" : undefined,
);
watch(advancedOpen, (value) => {
  Persister.set(PERSIST_KEY, value === "advanced");
});

defineExpose({ darkMode });
</script>

<style lang="scss" scoped>
.advanced-panels {
  // Strip the card chrome so the disclosure reads as part of the settings list.
  :deep(.v-expansion-panel) {
    background: transparent;
  }
  :deep(.v-expansion-panel-title) {
    min-height: 36px;
    padding: 6px 0;
    font-size: 13px;
  }
  :deep(.v-expansion-panel-text__wrapper) {
    padding: 4px 0 0;
  }
}

.advanced-title {
  font-weight: 500;
}
</style>

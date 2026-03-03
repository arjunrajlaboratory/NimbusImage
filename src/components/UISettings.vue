<template>
  <v-expansion-panel>
    <v-expansion-panel-title> Interface settings </v-expansion-panel-title>
    <v-expansion-panel-text>
      <v-container>
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
      </v-container>
    </v-expansion-panel-text>
  </v-expansion-panel>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useTheme } from "vuetify";

const theme = useTheme();

const darkMode = computed({
  get: () => theme.global.name.value === "dark",
  set: (value: boolean) => {
    theme.global.name.value = value ? "dark" : "light";
  },
});

defineExpose({ darkMode });
</script>

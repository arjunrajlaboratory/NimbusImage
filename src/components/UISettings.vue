<template>
  <v-expansion-panel>
    <v-expansion-panel-header> Interface settings </v-expansion-panel-header>
    <v-expansion-panel-content>
      <v-container>
        <v-switch
          hide-details
          dense
          v-model="darkMode"
          label="Dark mode"
          v-description="{
            section: 'Interface settings',
            title: 'Dark mode',
            description: 'Enable dark mode',
          }"
        />
      </v-container>
    </v-expansion-panel-content>
  </v-expansion-panel>
</template>

<script setup lang="ts">
import { computed, getCurrentInstance } from "vue";

const vuetify = getCurrentInstance()?.proxy?.$vuetify;

const darkMode = computed({
  get: () => vuetify?.theme.dark ?? false,
  set: (value: boolean) => {
    if (vuetify) {
      vuetify.theme.dark = value;
    }
  },
});

defineExpose({ darkMode });
</script>

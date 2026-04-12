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
        <div class="text-subtitle-2 mt-4 mb-2">Annotation rendering</div>
        <v-text-field
          v-model.number="maxVisible"
          label="Max visible annotations"
          type="number"
          density="compact"
          hide-details
          class="mb-2"
          v-description="{
            section: 'Interface settings',
            title: 'Max visible',
            description:
              'Maximum annotations to render (as stubs or shapes) per frame',
          }"
        />
        <v-text-field
          v-model.number="maxHydrated"
          label="Max hydrated annotations"
          type="number"
          density="compact"
          hide-details
          class="mb-2"
          v-description="{
            section: 'Interface settings',
            title: 'Max hydrated',
            description:
              'Maximum annotations to render as full shapes (rest shown as dots)',
          }"
        />
        <v-switch
          hide-details
          density="compact"
          v-model="globalThreshold"
          label="Global threshold (all layers)"
          v-description="{
            section: 'Interface settings',
            title: 'Global threshold',
            description:
              'When on, the visibility threshold applies to total annotations across all layers. When off, each layer is checked independently.',
          }"
        />
      </v-container>
    </v-expansion-panel-text>
  </v-expansion-panel>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useTheme } from "vuetify";
import annotationStore from "@/store/annotation";

const theme = useTheme();

const darkMode = computed({
  get: () => theme.global.name.value === "dark",
  set: (value: boolean) => {
    theme.global.name.value = value ? "dark" : "light";
  },
});

const maxVisible = computed({
  get: () => annotationStore.visibilityConfig.maxVisible,
  set: (value: number) => {
    if (value > 0) annotationStore.setVisibilityConfig({ maxVisible: value });
  },
});

const maxHydrated = computed({
  get: () => annotationStore.visibilityConfig.maxHydrated,
  set: (value: number) => {
    if (value > 0) annotationStore.setVisibilityConfig({ maxHydrated: value });
  },
});

const globalThreshold = computed({
  get: () => annotationStore.visibilityConfig.globalThreshold,
  set: (value: boolean) => {
    annotationStore.setVisibilityConfig({ globalThreshold: value });
  },
});

defineExpose({ darkMode });
</script>

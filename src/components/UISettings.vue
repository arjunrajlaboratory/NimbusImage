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
      <div class="text-subtitle-2 mb-2">Annotation rendering</div>
      <v-text-field
        v-model.number="stubThreshold"
        label="Stub mode threshold"
        type="number"
        density="compact"
        hide-details
        class="mb-2"
        v-description="{
          section: 'Interface settings',
          title: 'Stub mode threshold',
          description:
            'Dataset annotation count above which stub-only (lazy) mode activates: stubs load first and coordinates/property values load on demand. Independent of the render budget below.',
        }"
      />
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
      <v-text-field
        v-model.number="zoomedOutFraction"
        label="Zoomed-out budget fraction"
        type="number"
        step="0.05"
        min="0.01"
        max="1"
        density="compact"
        hide-details
        class="mb-2"
        v-description="{
          section: 'Interface settings',
          title: 'Zoomed-out budget fraction',
          description:
            'Fraction of the render/hydration budget used when fully zoomed out (where dense fields collapse into noise). The budget doubles per zoom level up to the full cap. Set to 1 to disable zoom scaling.',
        }"
      />
      <v-text-field
        v-model.number="hydrationCacheCap"
        label="Hydration cache cap"
        type="number"
        density="compact"
        hide-details
        class="mb-2"
        v-description="{
          section: 'Interface settings',
          title: 'Hydration cache cap',
          description:
            'Total cap on cached hydrated annotations. Accumulates across pans/zooms; LRU-evicts when over cap (selected never evicted).',
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
    </div>
  </section>
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

const stubThreshold = computed({
  get: () => annotationStore.visibilityConfig.stubThreshold,
  set: (value: number) => {
    if (value > 0)
      annotationStore.setVisibilityConfig({ stubThreshold: value });
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

const hydrationCacheCap = computed({
  get: () => annotationStore.visibilityConfig.hydrationCacheCap,
  set: (value: number) => {
    if (value > 0)
      annotationStore.setVisibilityConfig({ hydrationCacheCap: value });
  },
});

const zoomedOutFraction = computed({
  get: () => annotationStore.visibilityConfig.zoomedOutFraction,
  set: (value: number) => {
    if (value > 0 && value <= 1)
      annotationStore.setVisibilityConfig({ zoomedOutFraction: value });
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

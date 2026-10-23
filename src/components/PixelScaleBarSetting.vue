<template>
  <v-switch
    hide-details
    density="compact"
    v-model="showPixelScalebar"
    label="Show pixel scalebar"
    title="Show the scalebarwidget on top of the image for the number of pixels"
    v-description="{
      section: 'Scale settings',
      title: 'Show pixel scalebar',
      description:
        'Show the scalebar widget at the bottom right of the image for the number of pixels; click scalebar to edit settings',
    }"
  />
</template>

<script setup lang="ts">
import { computed } from "vue";
import store from "@/store/index";
import { useCommand } from "@/commands/registry";
import { toggleCommands } from "@/commands/toggles";
import { useInViewer } from "@/commands/context";

const showPixelScalebar = computed({
  get: () => store.showPixelScalebar,
  set: (value: boolean) => store.setShowPixelScalebar(value),
});

// Mounted in two places (Settings, the scale-bar menu); the registry keeps
// one copy of the id. Settings stays mounted on every route, so gate it.
const inViewer = useInViewer();
useCommand(() =>
  toggleCommands(
    [
      {
        id: "settings.pixelScalebar",
        setting: showPixelScalebar,
        turnOn: "Show pixel scale bar",
        turnOff: "Hide pixel scale bar",
        keywords: ["scalebar", "pixels", "ruler"],
        icon: "mdi-ruler",
      },
    ],
    { when: inViewer },
  ),
);

defineExpose({ showPixelScalebar });
</script>

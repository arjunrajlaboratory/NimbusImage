<template>
  <section class="settings-section">
    <h4 class="settings-section-title">Viewer</h4>
    <div class="settings-section-body">
      <v-switch
        hide-details
        density="compact"
        v-model="showXYLabels"
        label="Show XY position labels"
        title="Display coordinate labels for XY positions"
      />
      <v-switch
        hide-details
        density="compact"
        v-model="showZLabels"
        label="Show Z position labels"
        title="Display coordinate labels for Z positions"
      />
      <v-switch
        hide-details
        density="compact"
        v-model="showTimeLabels"
        label="Show time labels"
        title="Display time labels"
      />
      <v-divider class="settings-divider" />
      <v-switch
        hide-details
        density="compact"
        v-model="valueOnHover"
        label="Show channel values on hover"
        title="Show pixel intensity values when hovering cursor over image"
        v-description="{
          section: 'Viewer settings',
          title: 'Show channel values on hover',
          description:
            'Show pixel values for each layer when hovering over the image',
        }"
      />
      <v-switch
        hide-details
        density="compact"
        v-model="overview"
        label="Show minimap"
        v-description="{
          section: 'Viewer settings',
          title: 'Show minimap',
          description: 'Show the overview panel',
        }"
      />
      <v-switch
        hide-details
        density="compact"
        v-model="showScalebar"
        label="Show scalebar"
        title="Show the scalebar on top of the image"
        v-description="{
          section: 'Viewer settings',
          title: 'Show scalebar',
          description:
            'Show the scalebar widget at the bottom right of the image; click scalebar to edit settings',
        }"
      />
      <pixel-scale-bar-setting />
      <div class="settings-inline">
        <span class="settings-inline-label">Scale bar style</span>
        <color-picker-menu
          v-model="scalebarColor"
          class="scale-bar-color-picker"
        />
      </div>
      <v-divider class="settings-divider" />
      <v-switch
        hide-details
        density="compact"
        v-model="scaleAnnotationsWithZoom"
        label="Scale points with zoom"
        title="Make point annotations scale with zoom level or stay a fixed size"
        v-description="{
          section: 'Viewer settings',
          title: 'Scale points with zoom',
          description:
            'Set size of the point annotations and allow to scale with zoom level or stay a fixed size',
        }"
      />
      <v-slider
        v-model="annotationsRadius"
        :thumb-label="true"
        min="1"
        max="100"
        label="Point annotations radius"
        density="compact"
        hide-details
        class="settings-slider"
      />
      <v-slider
        v-model="annotationOpacity"
        :thumb-label="true"
        min="0"
        max="1"
        step="0.1"
        label="Annotation opacity"
        density="compact"
        hide-details
        class="settings-slider"
      />
      <v-select
        hide-details
        label="Compositing mode"
        v-model="compositionMode"
        :items="compositionItemsList"
        item-title="text"
        item-value="value"
        density="compact"
        variant="outlined"
        class="mt-2"
      >
        <template #item="{ item: listItem }">
          <div style="width: 100%">
            <strong>
              {{ (listItem as any).text }}
            </strong>
            <div class="body-2 text-medium-emphasis">
              {{ (listItem as any).help }}
            </div>
            <v-divider />
          </div>
        </template>
      </v-select>
      <v-select
        label="Background color"
        v-model="backgroundColor"
        :items="backgroundItems"
        item-title="text"
        item-value="value"
        density="compact"
        variant="outlined"
        hide-details
        class="mt-2"
      />
      <v-btn
        variant="flat"
        color="primary"
        size="small"
        block
        class="mt-3"
        @click="showColorDialog = true"
      >
        <v-icon start size="16">mdi-palette</v-icon>
        Customize default channel colors
      </v-btn>
    </div>

    <!-- Channel Color Customization Dialog -->
    <v-dialog v-model="showColorDialog" max-width="800">
      <user-color-settings
        :visible="showColorDialog"
        @close="showColorDialog = false"
      />
    </v-dialog>
  </section>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { debounce } from "lodash";
import store from "@/store/index";
import {
  TCompositionMode,
  compositionItems,
  advancedCompositionItems,
} from "@/utils/compositionModes";
import ColorPickerMenu from "@/components/ColorPickerMenu.vue";
import PixelScaleBarSetting from "@/components/PixelScaleBarSetting.vue";
import UserColorSettings from "@/components/UserColorSettings.vue";
import { useCommand } from "@/commands/registry";
import { toggleCommands } from "@/commands/toggles";
import { useInViewer } from "@/commands/context";

const showColorDialog = ref(false);

const compositionItemsList = [
  { header: "Base Composition Modes" },
  ...compositionItems,
  { header: "Advanced Composition Modes" },
  ...advancedCompositionItems,
];
const backgroundItems = [
  { value: "white", text: "White" },
  { value: "black", text: "Black" },
];

const valueOnHover = computed({
  get: () => store.valueOnHover,
  set: (value: boolean) => {
    store.setValueOnHover(value);
  },
});

const overview = computed({
  get: () => store.overview,
  set: (value: boolean) => {
    store.setOverview(value);
  },
});

const showScalebar = computed({
  get: () => store.showScalebar,
  set: (value: boolean) => {
    store.setShowScalebar(value);
  },
});

const scalebarColor = computed({
  get: () => store.scalebarColor,
  set: (color: string) => {
    store.setScalebarColor(color);
  },
});

const scaleAnnotationsWithZoom = computed({
  get: () => store.scaleAnnotationsWithZoom,
  set: (value: boolean) => {
    store.setScaleAnnotationsWithZoom(value);
  },
});

const setOpacityDebounced = debounce(
  (value: number) => {
    const opacity = typeof value === "string" ? parseFloat(value) : value;
    store.setAnnotationOpacity(opacity);
  },
  250,
  { leading: false, trailing: true },
);

const annotationOpacity = computed({
  get: () => store.annotationOpacity,
  set: (value: number) => {
    setOpacityDebounced(value);
  },
});

const annotationsRadius = computed({
  get: () => store.annotationsRadius,
  set: (value: number) => {
    const zoom = typeof value === "string" ? parseFloat(value) : value;
    store.setAnnotationsRadius(zoom);
  },
});

const compositionMode = computed({
  get: () => store.compositionMode,
  set: (value: TCompositionMode) => {
    store.setCompositionMode(value);
  },
});

const backgroundColor = computed({
  get: () => store.backgroundColor,
  set: (value: string) => {
    store.setBackgroundColor(value);
  },
});

const showXYLabels = computed({
  get: () => store.showXYLabels,
  set: (value: boolean) => {
    store.setShowXYLabels(value);
  },
});

const showZLabels = computed({
  get: () => store.showZLabels,
  set: (value: boolean) => {
    store.setShowZLabels(value);
  },
});

const showTimeLabels = computed({
  get: () => store.showTimeLabels,
  set: (value: boolean) => {
    store.setShowTimeLabels(value);
  },
});

// The Settings palette stays mounted on every route; these act on the viewer.
const inViewer = useInViewer();

useCommand(() => [
  ...toggleCommands(
    [
      {
        id: "settings.scalebar",
        setting: showScalebar,
        turnOn: "Show scale bar",
        turnOff: "Hide scale bar",
        keywords: ["scalebar", "microns", "ruler"],
        icon: "mdi-ruler",
      },
      {
        id: "settings.minimap",
        setting: overview,
        turnOn: "Show minimap",
        turnOff: "Hide minimap",
        keywords: ["overview", "thumbnail", "navigation"],
        icon: "mdi-map-outline",
      },
      {
        id: "settings.valueOnHover",
        setting: valueOnHover,
        turnOn: "Show channel values on hover",
        turnOff: "Hide channel values on hover",
        keywords: ["pixel", "intensity", "readout", "mouse"],
        icon: "mdi-cursor-default-outline",
      },
      {
        id: "settings.scalePointsWithZoom",
        setting: scaleAnnotationsWithZoom,
        turnOn: "Scale points with zoom",
        turnOff: "Keep points a fixed size",
        keywords: ["annotations", "radius", "dots", "size"],
        icon: "mdi-resize",
      },
      {
        id: "settings.xyLabels",
        setting: showXYLabels,
        turnOn: "Show XY position labels",
        turnOff: "Hide XY position labels",
        keywords: ["dimension", "names"],
        icon: "mdi-label-outline",
      },
      {
        id: "settings.zLabels",
        setting: showZLabels,
        turnOn: "Show Z position labels",
        turnOff: "Hide Z position labels",
        keywords: ["dimension", "names", "slice"],
        icon: "mdi-label-outline",
      },
      {
        id: "settings.timeLabels",
        setting: showTimeLabels,
        turnOn: "Show time labels",
        turnOff: "Hide time labels",
        keywords: ["dimension", "names", "timepoint"],
        icon: "mdi-label-outline",
      },
    ],
    { when: inViewer },
  ),
  {
    id: "settings.backgroundColor",
    title:
      backgroundColor.value === "white"
        ? "Use a black background"
        : "Use a white background",
    group: "Actions",
    // Only the color it applies: "light background" must not find the
    // command that turns a white background black.
    keywords:
      backgroundColor.value === "white"
        ? ["background", "color", "dark", "setting"]
        : ["background", "color", "light", "setting"],
    icon: "mdi-invert-colors",
    enabled: inViewer,
    run: () => {
      backgroundColor.value =
        backgroundColor.value === "white" ? "black" : "white";
    },
  },
]);

defineExpose({
  showColorDialog,
  valueOnHover,
  overview,
  showScalebar,
  scalebarColor,
  scaleAnnotationsWithZoom,
  annotationOpacity,
  annotationsRadius,
  compositionMode,
  backgroundColor,
  showXYLabels,
  showZLabels,
  showTimeLabels,
  setOpacityDebounced,
});
</script>

<style lang="scss">
.v-select-list .v-list-subheader {
  justify-content: center;
  font-weight: bold;
  border-top: solid 2px;
}
</style>

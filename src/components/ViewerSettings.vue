<template>
  <div>
    <v-expansion-panel>
      <v-expansion-panel-header> Viewer settings </v-expansion-panel-header>
      <v-expansion-panel-content>
        <v-container>
          <v-switch
            hide-details
            dense
            v-model="showXYLabels"
            label="Show XY position labels"
            title="Display coordinate labels for XY positions"
          />
          <v-switch
            hide-details
            dense
            v-model="showZLabels"
            label="Show Z position labels"
            title="Display coordinate labels for Z positions"
          />
          <v-switch
            hide-details
            dense
            v-model="showTimeLabels"
            label="Show time labels"
            title="Display time labels"
          />
          <v-divider class="my-2" />
          <v-switch
            hide-details
            dense
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
            dense
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
            dense
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
          <span class="d-flex align-center">
            Scale bar style:
            <color-picker-menu
              v-model="scalebarColor"
              class="mx-2 scale-bar-color-picker"
              style="min-width: 200px"
            />
          </span>
          <v-switch
            hide-details
            dense
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
          />
          <v-slider
            v-model="annotationOpacity"
            :thumb-label="true"
            min="0"
            max="1"
            step="0.1"
            label="Annotation opacity"
          />
          <v-select
            hide-details
            label="Compositing mode"
            v-model="compositionMode"
            :items="compositionItemsList"
          >
            <template #item="{ item }">
              <div style="width: 100%">
                <strong>
                  {{ item.text }}
                </strong>
                <div class="body-2 text--secondary">
                  {{ item.help }}
                </div>
                <v-divider />
              </div>
            </template>
          </v-select>
          <v-select
            label="Background color"
            v-model="backgroundColor"
            :items="backgroundItems"
          />

          <v-divider class="my-4" />

          <v-btn color="primary" @click="showColorDialog = true" block>
            <v-icon left>mdi-palette</v-icon>
            Customize Default Channel Colors
          </v-btn>
        </v-container>
      </v-expansion-panel-content>
    </v-expansion-panel>

    <!-- Channel Color Customization Dialog -->
    <v-dialog v-model="showColorDialog" max-width="800">
      <user-color-settings
        :visible="showColorDialog"
        @close="showColorDialog = false"
      />
    </v-dialog>
  </div>
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
import PixelScaleBarSetting from "@/components/PixelScaleBarSetting.vue";
import UserColorSettings from "@/components/UserColorSettings.vue";

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
.v-select-list .v-subheader {
  justify-content: center;
  font-weight: bold;
  border-top: solid 2px;
}
</style>

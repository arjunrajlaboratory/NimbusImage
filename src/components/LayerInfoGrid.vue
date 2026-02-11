<template>
  <v-container fluid class="overflow-auto pa-2">
    <v-row v-if="layers.length > 0" no-gutters class="flex-nowrap">
      <v-col v-for="layer in layers" :key="layer.id" cols="auto" class="mr-2">
        <v-card outlined width="300">
          <v-card-title class="text-subtitle-2">
            <v-icon :color="layer.color" small left>mdi-circle</v-icon>
            {{ layer.name }}
            <v-spacer></v-spacer>
            <v-switch
              v-model="layer.visible"
              @change="toggleVisibility(layer.id)"
              dense
              hide-details
              class="mt-0"
            />
          </v-card-title>
          <v-card-text>
            <contrast-histogram
              :configurationContrast="getConfigurationContrast(layer.id)"
              :viewContrast="layer.contrast"
              @change="changeContrast(layer.id, $event, false)"
              @commit="changeContrast(layer.id, $event, true)"
              @revert="resetContrastInView(layer.id)"
              :histogram="getLayerHistogram(layer)"
            />
            <color-picker-menu
              :value="layer.color"
              @input="changeLayerColor(layer.id, $event)"
            />
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>
    <v-row v-else>
      <v-col>
        <v-alert type="info">No layers available.</v-alert>
      </v-col>
    </v-row>
  </v-container>
</template>

<script setup lang="ts">
import { IDisplayLayer, IContrast } from "@/store/model";
import store from "@/store";
import ContrastHistogram from "./ContrastHistogram.vue";
import ColorPickerMenu from "./ColorPickerMenu.vue";

defineProps<{
  layers: IDisplayLayer[];
}>();

function toggleVisibility(layerId: string) {
  store.toggleLayerVisibility(layerId);
}

function getConfigurationContrast(layerId: string) {
  if (!store.configuration) {
    return null;
  }
  const configurationLayer = store.getConfigurationLayerFromId(layerId);
  if (!configurationLayer) {
    return null;
  }
  return configurationLayer.contrast;
}

function getLayerHistogram(layer: IDisplayLayer) {
  return store.getLayerHistogram(layer);
}

function changeContrast(
  layerId: string,
  contrast: IContrast,
  syncConfiguration: boolean,
) {
  if (syncConfiguration) {
    store.saveContrastInConfiguration({ layerId, contrast });
  } else {
    store.saveContrastInView({ layerId, contrast });
  }
}

function resetContrastInView(layerId: string) {
  store.resetContrastInView(layerId);
}

function changeLayerColor(layerId: string, color: string) {
  store.changeLayer({
    layerId,
    delta: { color },
  });
}

defineExpose({
  toggleVisibility,
  getConfigurationContrast,
  getLayerHistogram,
  changeContrast,
  resetContrastInView,
  changeLayerColor,
});
</script>

<style lang="scss" scoped>
.layer-info-grid {
  background-color: rgb(0, 0, 0);
  max-width: 100vw;
}
</style>

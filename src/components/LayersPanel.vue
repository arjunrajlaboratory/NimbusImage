<template>
  <div class="layers-panel">
    <div class="layer-mode-wrapper">
      <v-radio-group
        v-model="layerMode"
        mandatory
        density="compact"
        inline
        hide-details
        class="layer-mode-controls"
      >
        <v-radio value="single" label="Single" class="smaller" />
        <v-radio value="multiple" label="Multiple" class="smaller" />
        <v-radio value="unroll" label="Unroll" class="smaller" />
      </v-radio-group>
      <v-btn
        class="add-layer-btn"
        variant="outlined"
        color="primary"
        size="x-small"
        @click="store.addLayer"
      >
        Add layer
      </v-btn>
    </div>
    <display-layers />
  </div>
</template>

<style lang="scss" scoped>
.layers-panel {
  padding: 8px 12px 12px;
}
.layer-mode-controls {
  margin: 4px 0 10px;
  :deep(.v-radio) {
    margin-right: 10px;
    > .v-input--selection-controls__input {
      margin-right: 0;
    }
  }
}
.layer-mode-wrapper {
  position: relative;
}
.add-layer-btn {
  position: absolute;
  top: 6px;
  right: 0;
  text-transform: none;
  letter-spacing: normal;
}

/* Let the palette's frosted glass show through the layer rows — the default
   Vuetify card / expansion-panel surfaces are opaque and look stamped against
   the translucent container. */
.layers-panel :deep(.v-card),
.layers-panel :deep(.v-card__overlay),
.layers-panel :deep(.v-expansion-panels),
.layers-panel :deep(.v-expansion-panel),
.layers-panel :deep(.v-expansion-panel::after),
.layers-panel :deep(.v-expansion-panel__shadow),
.layers-panel :deep(.v-expansion-panel-title),
.layers-panel :deep(.v-expansion-panel-text),
.layers-panel :deep(.v-expansion-panel-text__wrapper) {
  background: transparent !important;
  background-color: transparent !important;
  box-shadow: none !important;
}
</style>

<script setup lang="ts">
import { computed } from "vue";
import DisplayLayers from "@/components/DisplayLayers.vue";
import store from "@/store";
import { TLayerMode } from "@/store/model";

const layerMode = computed({
  get: () => store.layerMode,
  set: (value: TLayerMode) => store.setLayerMode(value),
});
</script>

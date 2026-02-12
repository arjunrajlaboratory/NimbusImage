<template>
  <div class="contrast-panel">
    <v-expansion-panels class="panel-flex">
      <v-expansion-panel v-for="(layer, index) in layers" :key="index">
        <display-layer :value="layer" />
      </v-expansion-panel>
    </v-expansion-panels>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import DisplayLayer from "./DisplayLayer.vue";
import store from "@/store";

const layers = computed(() => store.layers);

defineExpose({ layers });
</script>

<style scoped>
.contrast-panel {
  display: flex;
  overflow-x: auto; /* allows for horizontal scrolling */
  white-space: nowrap; /* prevents line break, so items stay in a single line */
}

.panel-image {
  width: 100%;
  height: auto;
  object-fit: cover;
  min-width: 200px; /* min-width can be adjusted as per requirement */
  margin-right: 10px; /* add some space between images */
}
.panel-flex {
  display: flex;
  flex-direction: row;
  flex-wrap: nowrap;
}
</style>

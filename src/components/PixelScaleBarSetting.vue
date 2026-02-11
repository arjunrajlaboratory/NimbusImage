<template>
  <v-switch
    hide-details
    dense
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

const showPixelScalebar = computed({
  get: () => store.showPixelScalebar,
  set: (value: boolean) => store.setShowPixelScalebar(value),
});

defineExpose({ showPixelScalebar });
</script>

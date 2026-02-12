<template>
  <v-card class="ma-1">
    <v-card-title> NimbusImage settings </v-card-title>
    <v-card-text class="pa-1">
      <v-expansion-panels hover multiple v-model="panels">
        <annotation-toggles />
        <viewer-settings />
        <ui-settings />
        <jobs-logs />
      </v-expansion-panels>
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import { ref } from "vue";
import AnnotationToggles from "@/components/AnnotationBrowser/AnnotationToggles.vue";
import ViewerSettings from "@/components/ViewerSettings.vue";
import UiSettings from "@/components/UISettings.vue";
import JobsLogs from "@/components/JobsLogs.vue";

const panels = ref<number[]>([0, 1, 2, 3]);

defineExpose({ panels });
</script>

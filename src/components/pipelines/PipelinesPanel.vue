<template>
  <v-container class="pa-2">
    <v-list v-if="pipelines.length > 0" density="compact" class="py-0">
      <v-list-item
        v-for="pipeline in pipelines"
        :key="pipeline.id"
        class="px-2"
        @click="openPipelines"
      >
        <template v-slot:prepend>
          <v-progress-circular
            v-if="runningPipelineId === pipeline.id"
            indeterminate
            size="18"
            width="2"
            color="primary"
          />
          <v-icon v-else size="18">mdi-transit-connection-variant</v-icon>
        </template>
        <v-list-item-title class="text-body-2">
          {{ pipeline.name }}
          <v-chip
            v-if="pipeline.origin === 'ai'"
            size="x-small"
            class="ml-1"
            variant="outlined"
          >
            ai
          </v-chip>
        </v-list-item-title>
        <v-list-item-subtitle class="text-caption">
          {{ pipeline.steps.length }}
          step{{ pipeline.steps.length === 1 ? "" : "s" }}
          <span v-if="runningPipelineId === pipeline.id" class="text-primary">
            — running…
          </span>
        </v-list-item-subtitle>
      </v-list-item>
    </v-list>
    <div v-else class="text-caption text-medium-emphasis px-2 py-1">
      No pipelines yet. Chain worker steps and run them in sequence.
    </div>

    <div class="d-flex justify-end mt-1">
      <v-btn
        variant="outlined"
        color="primary"
        size="small"
        @click="openPipelines"
      >
        <v-icon start>mdi-open-in-app</v-icon>
        Open pipelines
      </v-btn>
    </div>
  </v-container>
</template>

<script setup lang="ts">
import { computed } from "vue";
import store from "@/store";
import pipelinesStore from "@/store/pipelines";

// Compact, always-cheap summary of the configuration's pipelines for the left
// palette column: name, step count, and a live running indicator. All detail
// work (build, run, suggest) happens in the full PipelineDialog.
const pipelines = computed(() => pipelinesStore.pipelines);
const runningPipelineId = computed(() => pipelinesStore.runningPipelineId);

function openPipelines() {
  store.setIsPipelineDialogOpen(true);
}

defineExpose({ pipelines, openPipelines });
</script>

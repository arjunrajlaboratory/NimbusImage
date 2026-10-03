<template>
  <div v-if="visible" class="pipeline-run-status px-3 py-2 mb-2">
    <div class="d-flex align-center ga-2">
      <v-progress-circular
        v-if="controller.isRunning.value"
        indeterminate
        size="18"
        width="2"
        color="primary"
      />
      <v-icon v-else :color="resultColor" size="18">{{ resultIcon }}</v-icon>

      <div class="flex-grow-1 min-width-0">
        <div class="text-body-2 text-truncate">{{ headline }}</div>
        <div class="text-caption text-medium-emphasis text-truncate">
          {{ detail }}
        </div>
      </div>

      <v-btn
        v-if="controller.isRunning.value"
        variant="text"
        color="warning"
        size="small"
        @click="controller.cancel"
      >
        Cancel
      </v-btn>
    </div>

    <v-progress-linear
      v-if="controller.isRunning.value"
      :model-value="percent"
      :indeterminate="percent === 0"
      color="primary"
      height="6"
      class="mt-2"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, inject } from "vue";
import pipelinesStore from "@/store/pipelines";
import {
  PipelineRunController,
  PipelineRunControllerKey,
} from "@/components/pipelines/usePipelineRun";

// Compact, always-visible summary of the single in-flight (or just-finished)
// pipeline run. Rendered above the content in every Pipelines dialog view so a
// run is never out of sight. The full per-step detail lives in the editor and
// the overall progress bar lives in the app's global progress widget.
const controller = inject<PipelineRunController>(PipelineRunControllerKey)!;

// The pipeline the status describes: the running one, or the last one run.
const pipeline = computed(() => {
  const id =
    controller.runningPipelineId.value ?? controller.activePipelineId.value;
  return id ? pipelinesStore.getPipelineById(id) : null;
});

const visible = computed(
  () =>
    controller.isRunning.value ||
    !!controller.batchProgress.value ||
    !!controller.result.value,
);

const batch = computed(() => controller.batchProgress.value);

const runningStepIndex = computed(() => {
  if (
    !pipeline.value ||
    controller.activePipelineId.value !== pipeline.value.id
  )
    return -1;
  return controller
    .statusesFor(pipeline.value)
    .findIndex((s) => s.status === "running");
});

const enabledCount = computed(
  () => pipeline.value?.steps.filter((s) => s.enabled).length ?? 0,
);

const doneCount = computed(() => {
  if (!pipeline.value) return 0;
  return controller
    .statusesFor(pipeline.value)
    .filter((s) => ["success", "error", "cancelled"].includes(s.status)).length;
});

const headline = computed(() => {
  const name = pipeline.value?.name ?? "Pipeline";
  if (!controller.isRunning.value && controller.result.value) {
    const r = controller.result.value;
    // Lead with the unit label so the counts read correctly at any value
    // ("Steps: 1 succeeded" rather than "1 steps succeeded").
    const unit = controller.lastRunWasBatch.value ? "Datasets" : "Steps";
    return `${name} — ${unit}: ${r.succeeded} succeeded, ${r.failed} failed, ${r.cancelled} cancelled`;
  }
  return name;
});

const detail = computed(() => {
  if (batch.value) {
    const b = batch.value;
    return `Dataset ${b.completed + b.failed + b.cancelled} / ${b.total} · ${b.currentDatasetName}`;
  }
  if (controller.isRunning.value) {
    const i = runningStepIndex.value;
    if (i >= 0 && pipeline.value) {
      const step = pipeline.value.steps[i];
      return `Step ${i + 1} / ${enabledCount.value}: ${step.name || step.image}`;
    }
    return "Starting…";
  }
  return "";
});

const percent = computed(() => {
  if (batch.value) {
    const b = batch.value;
    return b.total === 0
      ? 0
      : ((b.completed + b.failed + b.cancelled) / b.total) * 100;
  }
  return enabledCount.value === 0
    ? 0
    : (doneCount.value / enabledCount.value) * 100;
});

const resultIcon = computed(() => {
  const r = controller.result.value;
  if (!r) return "mdi-information-outline";
  if (r.failed > 0) return "mdi-close-circle";
  if (r.cancelled > 0) return "mdi-cancel";
  return "mdi-check-circle";
});

const resultColor = computed(() => {
  const r = controller.result.value;
  if (!r) return undefined;
  if (r.failed > 0) return "error";
  if (r.cancelled > 0) return "warning";
  return "success";
});

defineExpose({ visible, headline, detail, percent });
</script>

<style scoped>
.pipeline-run-status {
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 6px;
  background-color: rgba(var(--v-theme-primary), 0.06);
}
.min-width-0 {
  min-width: 0;
}
</style>

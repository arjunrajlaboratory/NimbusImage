<template>
  <v-container class="pa-0">
    <v-row class="my-0" density="comfortable">
      <v-col class="d-flex ga-2 py-1 justify-end">
        <v-btn
          variant="flat"
          color="primary"
          size="small"
          @click="createPipeline"
        >
          <v-icon start>mdi-plus</v-icon>
          New pipeline
        </v-btn>
      </v-col>
    </v-row>

    <v-alert v-if="actionError" type="error" density="compact" class="my-2">
      {{ actionError }}
    </v-alert>

    <v-list v-if="pipelines.length > 0" density="compact" class="my-2">
      <!-- Row body opens the editor (where you both edit and run); a quick Run
           and an overflow menu keep common actions one click away. -->
      <v-list-item
        v-for="pipeline in pipelines"
        :key="pipeline.id"
        @click="emit('open', pipeline)"
      >
        <template v-slot:prepend>
          <v-progress-circular
            v-if="pipelinesStore.runningPipelineId === pipeline.id"
            indeterminate
            size="20"
            width="2"
            color="primary"
          />
          <v-icon v-else>mdi-sitemap</v-icon>
        </template>

        <v-list-item-title>
          {{ pipeline.name }}
          <v-chip v-if="pipeline.origin" size="x-small" class="ml-2">
            {{ pipeline.origin }}
          </v-chip>
        </v-list-item-title>
        <v-list-item-subtitle>
          {{ pipeline.steps.length }}
          step{{ pipeline.steps.length === 1 ? "" : "s" }}
          <span v-if="pipelinesStore.runningPipelineId === pipeline.id">
            — running…
          </span>
          <span v-else-if="pipeline.description">
            — {{ pipeline.description }}
          </span>
        </v-list-item-subtitle>

        <template v-slot:append>
          <div class="d-flex align-center ga-1">
            <v-btn
              variant="text"
              color="success"
              size="small"
              :disabled="!canRun(pipeline)"
              aria-label="Run pipeline"
              @click.stop="runPipeline(pipeline)"
            >
              <v-icon start>mdi-play</v-icon>
              Run
            </v-btn>
            <v-menu location="bottom end">
              <template v-slot:activator="{ props: menuProps }">
                <v-btn
                  v-bind="menuProps"
                  variant="text"
                  icon="mdi-dots-vertical"
                  size="small"
                  aria-label="Pipeline actions"
                  @click.stop
                />
              </template>
              <v-list density="compact">
                <v-list-item
                  :disabled="
                    duplicatingId === pipeline.id || controller.isRunning.value
                  "
                  @click="duplicate(pipeline.id)"
                >
                  <template v-slot:prepend>
                    <v-icon size="small">mdi-content-copy</v-icon>
                  </template>
                  <v-list-item-title>Duplicate</v-list-item-title>
                </v-list-item>
                <v-list-item
                  base-color="error"
                  :disabled="controller.isRunning.value"
                  @click="askDelete(pipeline)"
                >
                  <template v-slot:prepend>
                    <v-icon size="small">mdi-delete</v-icon>
                  </template>
                  <v-list-item-title>Delete</v-list-item-title>
                </v-list-item>
              </v-list>
            </v-menu>
          </div>
        </template>
      </v-list-item>
    </v-list>
    <v-row v-else class="my-2" density="comfortable">
      <v-col class="text-caption text-medium-emphasis">
        No pipelines yet. Create one to get started.
      </v-col>
    </v-row>

    <!-- Delete confirmation -->
    <v-dialog v-model="showDeleteDialog" max-width="400">
      <v-card>
        <v-card-title>Delete pipeline</v-card-title>
        <v-card-text>
          Are you sure you want to delete "{{ pipelineToDelete?.name }}"? This
          cannot be undone.
          <v-checkbox
            v-model="removeMaterializedProperties"
            label="Also remove computed properties created by this pipeline"
            density="compact"
            hide-details
            class="mt-2"
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" size="small" @click="showDeleteDialog = false">
            Cancel
          </v-btn>
          <v-btn
            variant="flat"
            color="error"
            size="small"
            :loading="deleting"
            :disabled="controller.isRunning.value"
            @click="confirmDelete"
          >
            Delete
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { computed, inject, ref } from "vue";
import pipelinesStore from "@/store/pipelines";
import { logError } from "@/utils/log";
import { IPipeline } from "@/store/model";
import {
  PipelineRunController,
  PipelineRunControllerKey,
} from "@/components/pipelines/usePipelineRun";

const emit = defineEmits<{
  (e: "open", pipeline: IPipeline): void;
}>();

const controller = inject<PipelineRunController>(PipelineRunControllerKey)!;

const pipelines = computed(() => pipelinesStore.pipelines);

const actionError = ref<string | null>(null);
const duplicatingId = ref<string | null>(null);
const showDeleteDialog = ref(false);
const pipelineToDelete = ref<IPipeline | null>(null);
const deleting = ref(false);
const removeMaterializedProperties = ref(true);

function createPipeline() {
  emit("open", pipelinesStore.createEmptyPipeline());
}

function canRun(pipeline: IPipeline): boolean {
  return controller.canRunPipeline(pipeline);
}

// Quick-run straight from the list. Editing/running the same pipeline in the
// editor uses save-then-run; from the list the saved pipeline runs as-is.
function runPipeline(pipeline: IPipeline) {
  controller.run(pipeline, { allowBatch: false });
}

async function duplicate(pipelineId: string) {
  if (controller.isRunning.value) {
    return;
  }
  duplicatingId.value = pipelineId;
  actionError.value = null;
  try {
    await pipelinesStore.duplicatePipeline(pipelineId);
  } catch (error) {
    logError("Failed to duplicate pipeline:", error);
    actionError.value =
      "Failed to duplicate pipeline. See the console for details.";
  } finally {
    duplicatingId.value = null;
  }
}

function askDelete(pipeline: IPipeline) {
  if (controller.isRunning.value) {
    return;
  }
  pipelineToDelete.value = pipeline;
  removeMaterializedProperties.value = true;
  showDeleteDialog.value = true;
}

async function confirmDelete() {
  if (!pipelineToDelete.value || controller.isRunning.value) {
    return;
  }
  deleting.value = true;
  actionError.value = null;
  try {
    await pipelinesStore.deletePipeline({
      pipelineId: pipelineToDelete.value.id,
      removeMaterializedProperties: removeMaterializedProperties.value,
    });
    showDeleteDialog.value = false;
  } catch (error) {
    logError("Failed to delete pipeline:", error);
    actionError.value =
      "Failed to delete pipeline. See the console for details.";
  } finally {
    deleting.value = false;
  }
}

defineExpose({
  pipelines,
  createPipeline,
  canRun,
  runPipeline,
  duplicate,
  askDelete,
  confirmDelete,
  removeMaterializedProperties,
});
</script>

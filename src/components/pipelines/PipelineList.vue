<template>
  <v-container class="pa-0">
    <v-row class="my-0" dense>
      <v-col class="d-flex ga-2 py-1 justify-end">
        <v-btn
          variant="outlined"
          color="primary"
          size="small"
          @click="emit('open-suggest')"
        >
          <v-icon start>mdi-creation</v-icon>
          Suggest with AI
        </v-btn>
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
      <v-list-item v-for="pipeline in pipelines" :key="pipeline.id">
        <template v-slot:prepend>
          <v-progress-circular
            v-if="pipelinesStore.runningPipelineId === pipeline.id"
            indeterminate
            size="20"
            width="2"
            color="primary"
          />
          <v-icon v-else>mdi-sitemap-outline</v-icon>
        </template>

        <v-list-item-title>
          {{ pipeline.name }}
          <v-chip
            v-if="pipeline.origin"
            size="x-small"
            class="ml-2"
            :color="pipeline.origin === 'ai' ? 'info' : undefined"
          >
            {{ pipeline.origin }}
          </v-chip>
        </v-list-item-title>
        <v-list-item-subtitle>
          {{ pipeline.steps.length }}
          step{{ pipeline.steps.length === 1 ? "" : "s" }}
          <span v-if="pipeline.description"> — {{ pipeline.description }}</span>
        </v-list-item-subtitle>

        <template v-slot:append>
          <div class="d-flex ga-2">
            <v-btn
              variant="flat"
              color="success"
              size="small"
              :disabled="!!pipelinesStore.runningPipelineId"
              @click="emit('open-run', pipeline)"
            >
              <v-icon start>mdi-play</v-icon>
              Run
            </v-btn>
            <v-btn
              variant="outlined"
              color="primary"
              size="small"
              @click="emit('open-builder', pipeline)"
            >
              <v-icon start>mdi-pencil</v-icon>
              Edit
            </v-btn>
            <v-btn
              variant="outlined"
              color="primary"
              size="small"
              :loading="duplicatingId === pipeline.id"
              @click="duplicate(pipeline.id)"
            >
              <v-icon start>mdi-content-copy</v-icon>
              Duplicate
            </v-btn>
            <v-btn
              variant="outlined"
              color="error"
              size="small"
              @click="askDelete(pipeline)"
            >
              <v-icon start>mdi-delete</v-icon>
              Delete
            </v-btn>
          </div>
        </template>
      </v-list-item>
    </v-list>
    <v-row v-else class="my-2" dense>
      <v-col class="text-caption text-medium-emphasis">
        No pipelines yet. Create one, or ask the AI for suggestions.
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
import { computed, ref } from "vue";
import pipelinesStore from "@/store/pipelines";
import { logError } from "@/utils/log";
import { IPipeline } from "@/store/model";

const emit = defineEmits<{
  (e: "open-builder", pipeline: IPipeline): void;
  (e: "open-run", pipeline: IPipeline): void;
  (e: "open-suggest"): void;
}>();

const pipelines = computed(() => pipelinesStore.pipelines);

const actionError = ref<string | null>(null);
const duplicatingId = ref<string | null>(null);
const showDeleteDialog = ref(false);
const pipelineToDelete = ref<IPipeline | null>(null);
const deleting = ref(false);
const removeMaterializedProperties = ref(true);

function createPipeline() {
  emit("open-builder", pipelinesStore.createEmptyPipeline());
}

async function duplicate(pipelineId: string) {
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
  pipelineToDelete.value = pipeline;
  removeMaterializedProperties.value = true;
  showDeleteDialog.value = true;
}

async function confirmDelete() {
  if (!pipelineToDelete.value) {
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
  duplicate,
  askDelete,
  confirmDelete,
  removeMaterializedProperties,
});
</script>

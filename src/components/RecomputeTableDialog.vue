<template>
  <v-dialog v-model="dialog" max-width="520">
    <template #activator="{ props: activatorProps }">
      <v-btn
        v-bind="activatorProps"
        size="small"
        variant="tonal"
        color="primary"
        prepend-icon="mdi-refresh"
      >
        Recompute counts…
      </v-btn>
    </template>
    <v-card>
      <v-card-title>Recompute the expression table</v-card-title>
      <v-card-text>
        <p class="text-body-2 mb-3">
          Assigns every molecule of the transcript store to the cell polygon it
          falls in (smallest polygon wins) and writes a new table. The current
          table is kept as a version. Edited-cell rebuilds also update
          neighbours in the cells' previous locations. Older tables without
          saved cell footprints require a full rebuild once.
        </p>
        <v-text-field
          v-model="label"
          label="Version label"
          density="compact"
          variant="outlined"
          :maxlength="80"
          hide-details
          class="mb-3"
        />
        <v-radio-group v-model="scope" hide-details class="mb-2">
          <v-radio value="dirty" :disabled="!canDirty">
            <template #label>
              <span>
                Edited cells only
                <span class="text-caption text-medium-emphasis">
                  — {{ dirtyHint }}
                </span>
              </span>
            </template>
          </v-radio>
          <v-radio value="all" label="Every cell (full rebuild)" />
        </v-radio-group>
        <div class="text-caption">Quality ≥ {{ minQv }}</div>
        <v-slider
          v-model="minQv"
          :min="0"
          :max="40"
          :step="1"
          density="compact"
          hide-details
          class="mb-2"
        />
        <v-text-field
          v-model="tagsText"
          label="Only cells tagged (comma-separated, blank = every polygon)"
          density="compact"
          variant="outlined"
          hide-details
          class="mb-2"
        />
        <v-checkbox
          v-model="embeddings"
          label="Also recompute PCA / UMAP / k-means (minutes on large sections)"
          density="compact"
          hide-details
        />
        <v-alert v-if="error" type="error" variant="tonal" class="mt-3">
          {{ error }}
        </v-alert>
        <v-alert v-if="done" type="success" variant="tonal" class="mt-3">
          {{ done }}
        </v-alert>
        <v-progress-linear
          v-if="running"
          indeterminate
          color="primary"
          class="mt-3"
        />
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="dialog = false">Close</v-btn>
        <v-btn
          color="primary"
          variant="flat"
          :disabled="!canSubmit"
          :loading="running"
          @click="run"
        >
          Recompute
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import store from "@/store";
import spatialStore from "@/store/spatial";
import { ISpatialStaleness, TSpatialRecomputeScope } from "@/store/model";
import { jobStates } from "@/store/jobConstants";
import { logError } from "@/utils/log";
import { extractErrorMessage } from "@/utils/errors";

/**
 * Rebuild the expression table from the current cell polygons (plan §13).
 * The work is a server job; the dialog polls it and, on success, tells the
 * spatial store to re-read the (now different) active table.
 */

const props = defineProps<{ staleness: ISpatialStaleness | null }>();
const emit = defineEmits<{ (event: "recomputed"): void }>();

const POLL_MS = 2000;

const dialog = ref(false);
const label = ref("Recomputed");
const scope = ref<TSpatialRecomputeScope>("dirty");
const minQv = ref(20);
const tagsText = ref("cell");
const embeddings = ref(false);
const running = ref(false);
const error = ref<string | null>(null);
const done = ref<string | null>(null);
let pollTimer: ReturnType<typeof setTimeout> | null = null;

// "Edited cells only" needs a table to carry rows from and something dirty.
const canDirty = computed(
  () => spatialStore.hasTable && !!props.staleness && !props.staleness.upToDate,
);

const dirtyHint = computed(() => {
  if (!spatialStore.hasTable) {
    return "needs an existing table";
  }
  if (!props.staleness) {
    return "checking…";
  }
  if (props.staleness.upToDate) {
    return "nothing has changed";
  }
  const parts = [];
  if (props.staleness.added) parts.push(`${props.staleness.added} added`);
  if (props.staleness.changed) parts.push(`${props.staleness.changed} edited`);
  if (props.staleness.removed) parts.push(`${props.staleness.removed} removed`);
  return parts.join(", ");
});

const canSubmit = computed(
  () => !running.value && label.value.trim().length > 0,
);

watch(canDirty, (value) => {
  if (!value && scope.value === "dirty") {
    scope.value = "all";
  }
});

watch(dialog, (open) => {
  if (!open) {
    stopPolling();
    running.value = false;
  } else {
    error.value = null;
    done.value = null;
    scope.value = canDirty.value ? "dirty" : "all";
  }
});

function stopPolling() {
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function tags(): string[] | null {
  const list = tagsText.value
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
  return list.length ? list : null;
}

async function run() {
  const datasetId = store.dataset?.id;
  if (!datasetId || !canSubmit.value) {
    return;
  }
  running.value = true;
  error.value = null;
  done.value = null;
  try {
    const { jobId } = await store.spatialAPI.recompute(datasetId, {
      label: label.value.trim(),
      scope: scope.value,
      minQv: minQv.value,
      tags: tags(),
      recomputeEmbeddings: embeddings.value,
    });
    poll(jobId);
  } catch (caught) {
    logError("Recompute request failed:", caught);
    error.value = extractErrorMessage(caught);
    running.value = false;
  }
}

function poll(jobId: string) {
  stopPolling();
  pollTimer = setTimeout(async () => {
    pollTimer = null;
    if (!dialog.value) {
      return;
    }
    try {
      const job = await store.spatialAPI.fetchJob(jobId);
      if (job.status === jobStates.success) {
        const result = job.spatialResult as
          | { nObs: number; assigned: number; seconds: number }
          | undefined;
        done.value = result
          ? `Wrote ${result.nObs.toLocaleString()} cells, ${result.assigned.toLocaleString()} molecules assigned, in ${result.seconds}s.`
          : "Done.";
        running.value = false;
        await spatialStore.refreshInfo();
        emit("recomputed");
        return;
      }
      if (
        job.status === jobStates.error ||
        job.status === jobStates.cancelled
      ) {
        error.value = "The recompute job failed; see the job log.";
        running.value = false;
        return;
      }
      poll(jobId);
    } catch (caught) {
      logError("Recompute job poll failed:", caught);
      error.value = extractErrorMessage(caught);
      running.value = false;
    }
  }, POLL_MS);
}

defineExpose({ run, dirtyHint, canDirty, canSubmit, tags });
</script>

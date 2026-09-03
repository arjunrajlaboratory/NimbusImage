<template>
  <v-dialog v-model="dialog" max-width="600px">
    <template v-slot:activator="activatorBinding">
      <slot name="activator" v-bind="activatorBinding">
        <v-btn
          variant="outlined"
          color="primary"
          size="small"
          v-bind="{ ...activatorBinding.props, ...$attrs }"
          prepend-icon="mdi-dna"
        >
          Genes from spatial table
        </v-btn>
      </slot>
    </template>
    <v-card>
      <v-card-title>Genes from the spatial table</v-card-title>
      <v-card-subtitle>
        {{ tableFacts }}
      </v-card-subtitle>
      <v-card-text>
        <spatial-feature-picker v-model="symbols" class="mb-3" />

        <v-radio-group v-model="mode" class="mt-0 mb-1" hide-details>
          <v-radio value="live">
            <template #label>
              <div>
                <div>Add as live columns</div>
                <div class="mode-hint">
                  Read straight from the table, instantly. Works in filters,
                  plots, color-by and the object list; not sortable, not
                  exported to CSV.
                </div>
              </div>
            </template>
          </v-radio>
          <v-radio value="copy">
            <template #label>
              <div>
                <div>Copy into a measurement</div>
                <div class="mode-hint">
                  Writes each gene's count for every cell as a stored value (a
                  server job on large datasets). Sortable and exportable.
                </div>
              </div>
            </template>
          </v-radio>
          <v-radio value="score">
            <template #label>
              <div>
                <div>Gene-set score</div>
                <div class="mode-hint">
                  One stored value per cell: the mean (or sum) of the picked
                  genes.
                </div>
              </div>
            </template>
          </v-radio>
        </v-radio-group>

        <template v-if="mode !== 'live'">
          <v-text-field
            v-model="propertyName"
            label="Measurement name"
            density="compact"
            variant="outlined"
            hide-details
            class="mb-3"
          />
          <div v-if="mode === 'score'" class="d-flex score-row mb-3">
            <v-text-field
              v-model="scoreName"
              label="Score name"
              density="compact"
              variant="outlined"
              hide-details
              class="mr-2"
            />
            <v-select
              v-model="scoreMethod"
              :items="SCORE_METHODS"
              label="Method"
              density="compact"
              variant="outlined"
              hide-details
              style="max-width: 140px"
            />
          </div>
        </template>

        <v-alert v-if="error" type="error" variant="tonal" class="mb-2">
          {{ error }}
        </v-alert>
        <v-alert
          v-else-if="done"
          type="success"
          variant="tonal"
          density="compact"
          class="mb-2"
        >
          {{ done }}
        </v-alert>
        <div v-if="running" class="d-flex align-center running">
          <v-progress-circular indeterminate size="18" width="2" class="mr-2" />
          {{ runningMessage }}
        </div>
      </v-card-text>
      <v-card-actions class="button-bar">
        <v-spacer />
        <v-btn variant="text" size="small" @click="dialog = false">
          Close
        </v-btn>
        <v-btn
          variant="flat"
          color="primary"
          size="small"
          :disabled="!canSubmit"
          :loading="running"
          @click="submit"
        >
          <v-icon start>mdi-plus</v-icon>
          {{ submitLabel }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import store from "@/store";
import propertyStore, { SPATIAL_PROPERTY_ID } from "@/store/properties";
import spatialStore from "@/store/spatial";
import jobsStore from "@/store/jobs";
import SpatialFeaturePicker from "@/components/AnnotationBrowser/SpatialFeaturePicker.vue";
import { extractErrorMessage } from "@/utils/errors";
import { jobStates } from "@/store/jobConstants";

type TMode = "live" | "copy" | "score";

const DEFAULT_PROPERTY_NAME = "Gene Expression";
const DEFAULT_SCORE_PROPERTY_NAME = "Gene set scores";
const SCORE_METHODS = ["mean", "sum"] as const;
const JOB_POLL_MS = 2000;

const dialog = ref(false);
const symbols = ref<string[]>([]);
const mode = ref<TMode>("live");
const propertyName = ref(DEFAULT_PROPERTY_NAME);
const scoreName = ref("");
const scoreMethod = ref<"mean" | "sum">("mean");
const running = ref(false);
const runningMessage = ref("");
const error = ref("");
const done = ref("");

const tableFacts = computed(() => {
  const info = spatialStore.info;
  if (!info) {
    return "No spatial table is registered for this dataset.";
  }
  return `${info.nObs.toLocaleString()} cells × ${info.nVar.toLocaleString()} genes in the table`;
});

const genesLabel = computed(
  () =>
    `${symbols.value.length || ""} ${symbols.value.length === 1 ? "gene" : "genes"}`,
);

const submitLabel = computed(() => {
  if (mode.value === "live") {
    return `Add ${genesLabel.value} as columns`;
  }
  if (mode.value === "score") {
    return `Score ${genesLabel.value}`;
  }
  return `Copy ${genesLabel.value}`;
});

const canSubmit = computed(() => {
  if (symbols.value.length === 0 || running.value) {
    return false;
  }
  if (mode.value === "live") {
    return true;
  }
  if (!propertyName.value.trim()) {
    return false;
  }
  return mode.value !== "score" || scoreName.value.trim().length > 0;
});

// The default measurement name follows the mode until the user edits it.
watch(mode, (next, previous) => {
  const defaults: Record<TMode, string> = {
    live: propertyName.value,
    copy: DEFAULT_PROPERTY_NAME,
    score: DEFAULT_SCORE_PROPERTY_NAME,
  };
  if (propertyName.value === defaults[previous] || !propertyName.value) {
    propertyName.value = defaults[next];
  }
});

let pollTimer: ReturnType<typeof setTimeout> | null = null;

function stopPolling() {
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

async function afterWrite(written: number, what: string) {
  // The new sub-values are ordinary property values: reload the property
  // list and value sample so they show up in the Measurements tab.
  await propertyStore.fetchProperties();
  await propertyStore.fetchPropertyPathsSample();
  done.value = `Wrote ${what} for ${written.toLocaleString()} cells into “${propertyName.value.trim()}”.`;
  running.value = false;
}

function pollJob(jobId: string, total: number, what: string) {
  pollTimer = setTimeout(async () => {
    pollTimer = null;
    const status = await jobsStore.fetchJobStatus(jobId);
    if (!dialog.value) {
      return;
    }
    if (status === jobStates.success) {
      await afterWrite(total, what);
      return;
    }
    if (status === jobStates.error || status === jobStates.cancelled) {
      error.value = "The server job failed; see the job log.";
      running.value = false;
      return;
    }
    pollJob(jobId, total, what);
  }, JOB_POLL_MS);
}

async function addLiveColumns() {
  const paths = symbols.value.map((symbol) => [SPATIAL_PROPERTY_ID, symbol]);
  await propertyStore.addVirtualPropertyPaths(paths);
  done.value = `Added ${genesLabel.value} as live columns. They are listed under “Spatial table” and offered wherever a measurement is.`;
  running.value = false;
}

async function submit() {
  const datasetId = store.dataset?.id;
  if (!datasetId || !canSubmit.value) {
    return;
  }
  running.value = true;
  error.value = "";
  done.value = "";
  runningMessage.value = "Writing values…";
  try {
    if (mode.value === "live") {
      await addLiveColumns();
      return;
    }
    const what =
      mode.value === "score"
        ? `the ${scoreMethod.value} of ${genesLabel.value}`
        : genesLabel.value;
    const result =
      mode.value === "score"
        ? await store.spatialAPI.score(
            datasetId,
            symbols.value,
            scoreName.value.trim(),
            scoreMethod.value,
            propertyName.value.trim(),
          )
        : await store.spatialAPI.materialize(
            datasetId,
            symbols.value,
            propertyName.value.trim(),
          );
    if (result.jobId) {
      runningMessage.value = "Writing values in a server job…";
      pollJob(result.jobId, spatialStore.info?.nObs ?? 0, what);
      return;
    }
    await afterWrite(result.written, what);
  } catch (err) {
    error.value = extractErrorMessage(err);
    running.value = false;
  }
}

// Kept for tests and callers of the Phase 1 name.
const materialize = submit;

watch(dialog, (open) => {
  if (open) {
    error.value = "";
    done.value = "";
    spatialStore.ensureInfo();
  } else {
    stopPolling();
    running.value = false;
  }
});

onBeforeUnmount(stopPolling);

defineExpose({
  dialog,
  symbols,
  mode,
  propertyName,
  scoreName,
  scoreMethod,
  running,
  error,
  done,
  submit,
  materialize,
  canSubmit,
  tableFacts,
});
</script>

<style lang="scss" scoped>
.running,
.mode-hint {
  font-size: 12px;
  opacity: 0.7;
}

.score-row {
  gap: 4px;
}
</style>

<template>
  <v-dialog v-model="dialog" max-width="560px">
    <template v-slot:activator="activatorBinding">
      <slot name="activator" v-bind="activatorBinding">
        <v-btn
          variant="outlined"
          color="primary"
          size="small"
          v-bind="{ ...activatorBinding.props, ...$attrs }"
          prepend-icon="mdi-dna"
        >
          Add genes from spatial table
        </v-btn>
      </slot>
    </template>
    <v-card>
      <v-card-title>Add genes from the spatial table</v-card-title>
      <v-card-subtitle>
        Writes each gene's count for every cell as a value of a measurement, so
        it can be filtered, plotted and colored like any other
      </v-card-subtitle>
      <v-card-text>
        <div class="table-facts mb-3">
          {{ tableFacts }}
        </div>
        <spatial-feature-picker v-model="symbols" class="mb-3" />
        <v-text-field
          v-model="propertyName"
          label="Measurement name"
          density="compact"
          variant="outlined"
          hide-details
          class="mb-3"
        />
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
          :disabled="symbols.length === 0 || !propertyName.trim() || running"
          :loading="running"
          @click="materialize"
        >
          <v-icon start>mdi-plus</v-icon>
          Add {{ symbols.length || "" }}
          {{ symbols.length === 1 ? "gene" : "genes" }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import store from "@/store";
import propertyStore from "@/store/properties";
import spatialStore from "@/store/spatial";
import jobsStore from "@/store/jobs";
import SpatialFeaturePicker from "@/components/AnnotationBrowser/SpatialFeaturePicker.vue";
import { extractErrorMessage } from "@/utils/errors";
import { jobStates } from "@/store/jobConstants";

const DEFAULT_PROPERTY_NAME = "Gene Expression";
const JOB_POLL_MS = 2000;

const dialog = ref(false);
const symbols = ref<string[]>([]);
const propertyName = ref(DEFAULT_PROPERTY_NAME);
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

let pollTimer: ReturnType<typeof setTimeout> | null = null;

function stopPolling() {
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

async function afterWrite(written: number) {
  // The new sub-values are ordinary property values: reload the property
  // list and value sample so they show up in the Measurements tab.
  await propertyStore.fetchProperties();
  await propertyStore.fetchPropertyPathsSample();
  done.value = `Wrote ${symbols.value.length} gene${
    symbols.value.length === 1 ? "" : "s"
  } for ${written.toLocaleString()} cells into “${propertyName.value}”.`;
  running.value = false;
}

function pollJob(jobId: string, total: number) {
  pollTimer = setTimeout(async () => {
    pollTimer = null;
    const status = await jobsStore.fetchJobStatus(jobId);
    if (!dialog.value) {
      return;
    }
    if (status === jobStates.success) {
      await afterWrite(total);
      return;
    }
    if (status === jobStates.error || status === jobStates.cancelled) {
      error.value = "The server job failed; see the job log.";
      running.value = false;
      return;
    }
    pollJob(jobId, total);
  }, JOB_POLL_MS);
}

async function materialize() {
  const datasetId = store.dataset?.id;
  if (!datasetId || symbols.value.length === 0) {
    return;
  }
  running.value = true;
  error.value = "";
  done.value = "";
  runningMessage.value = "Writing values…";
  try {
    const result = await store.spatialAPI.materialize(
      datasetId,
      symbols.value,
      propertyName.value.trim(),
    );
    if (result.jobId) {
      runningMessage.value = "Writing values in a server job…";
      pollJob(result.jobId, spatialStore.info?.nObs ?? 0);
      return;
    }
    await afterWrite(result.written);
  } catch (err) {
    error.value = extractErrorMessage(err);
    running.value = false;
  }
}

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
  propertyName,
  running,
  error,
  done,
  materialize,
  tableFacts,
});
</script>

<style lang="scss" scoped>
.table-facts,
.running {
  font-size: 13px;
  opacity: 0.8;
}
</style>

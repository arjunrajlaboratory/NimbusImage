<template>
  <v-dialog v-model="dialog" max-width="760">
    <template #activator="{ props: activatorProps }">
      <slot name="activator" :props="activatorProps" />
    </template>
    <v-card>
      <v-card-title>Neighborhood enrichment</v-card-title>
      <v-card-text>
        <p class="text-body-2 mb-3">
          Which cell types sit next to which. Every cell's neighbors within the
          radius are counted by type (the cells' tags); the matrix is log<sub
            >2</sub
          >
          of observed over expected pairs, and each cell's neighbor fractions
          are written as a measurement.
        </p>
        <v-row align="center" class="mb-1">
          <v-col cols="4">
            <v-text-field
              v-model.number="radiusMicrons"
              type="number"
              label="Radius (µm)"
              density="compact"
              variant="outlined"
              hide-details
              :min="1"
            />
          </v-col>
          <v-col cols="4">
            <v-text-field
              v-model="excludeTagsText"
              label="Tags that are not types"
              density="compact"
              variant="outlined"
              hide-details
            />
          </v-col>
          <v-col cols="4" class="text-right">
            <v-btn
              color="primary"
              variant="flat"
              size="small"
              :loading="running"
              :disabled="!canRun"
              @click="run"
            >
              Compute
            </v-btn>
          </v-col>
        </v-row>
        <div class="text-caption text-medium-emphasis mb-2">
          {{ radiusHint }}
        </div>
        <v-alert v-if="error" type="error" variant="tonal" density="compact">
          {{ error }}
        </v-alert>
        <v-progress-linear v-if="running" indeterminate color="primary" />
        <template v-if="result">
          <div class="text-caption mb-1">
            {{ result.typed.toLocaleString() }} typed cells of
            {{ result.cells.toLocaleString() }}, radius {{ result.radius }} px,
            computed {{ new Date(result.computed).toLocaleString() }}.
          </div>
          <div class="matrix-scroll">
            <table class="matrix">
              <thead>
                <tr>
                  <th></th>
                  <th v-for="type in result.types" :key="type" class="col">
                    <span>{{ type }}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(row, i) in result.matrix" :key="result.types[i]">
                  <th class="row">
                    {{ result.types[i] }}
                    <span class="text-medium-emphasis">
                      ({{ result.counts[i].toLocaleString() }})
                    </span>
                  </th>
                  <td
                    v-for="(value, j) in row"
                    :key="j"
                    :style="cellStyle(value)"
                    :title="`${result.types[i]} around ${result.types[j]}: ${format(value)}`"
                  >
                    {{ format(value) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
        <div v-else-if="!running && loaded" class="text-caption">
          Not computed yet for this dataset.
        </div>
      </v-card-text>
      <v-card-actions>
        <v-btn
          v-if="result"
          variant="text"
          size="small"
          prepend-icon="mdi-download"
          @click="download"
        >
          CSV
        </v-btn>
        <v-spacer />
        <v-btn variant="text" @click="dialog = false">Close</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import Papa from "papaparse";
import store from "@/store";
import propertyStore from "@/store/properties";
import { ISpatialNeighborhood } from "@/store/model";
import { jobStates } from "@/store/jobConstants";
import { convertLength } from "@/utils/conversion";
import { downloadToClient } from "@/utils/download";
import { logError } from "@/utils/log";
import { extractErrorMessage } from "@/utils/errors";

/**
 * Neighborhood composition and enrichment (SPATIAL_PLUGIN.md "Phase 6").
 * The server works in image pixels; the dialog takes microns and converts
 * with the configuration's pixel size.
 */

const POLL_MS = 2000;
const DEFAULT_RADIUS_MICRONS = 30;

const dialog = ref(false);
const radiusMicrons = ref(DEFAULT_RADIUS_MICRONS);
const excludeTagsText = ref("cell");
const running = ref(false);
const loaded = ref(false);
const error = ref<string | null>(null);
const result = ref<ISpatialNeighborhood | null>(null);
let pollTimer: ReturnType<typeof setTimeout> | null = null;

/** Image pixels per micron from the configuration's scale, or null when
 * the dataset has no physical scale. */
const pixelsPerMicron = computed(() => {
  const pixelSize = store.scales?.pixelSize;
  if (!pixelSize || !pixelSize.value) {
    return null;
  }
  const micronsPerPixel = convertLength(pixelSize.value, pixelSize.unit, "µm");
  return micronsPerPixel > 0 ? 1 / micronsPerPixel : null;
});

const radiusPixels = computed(() =>
  pixelsPerMicron.value === null
    ? null
    : radiusMicrons.value * pixelsPerMicron.value,
);

const radiusHint = computed(() =>
  radiusPixels.value === null
    ? "The dataset has no pixel size; set one in the scale settings first."
    : `${radiusMicrons.value} µm is ${radiusPixels.value.toFixed(0)} image pixels.`,
);

const canRun = computed(
  () =>
    !running.value &&
    radiusPixels.value !== null &&
    radiusPixels.value > 0 &&
    !!store.dataset,
);

function excludeTags(): string[] {
  return excludeTagsText.value
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

function format(value: number | null): string {
  return value === null ? "—" : value.toFixed(2);
}

/** Blue below zero, red above, saturating at |2|. */
function cellStyle(value: number | null) {
  if (value === null) {
    return {};
  }
  const strength = Math.min(1, Math.abs(value) / 2);
  const color = value >= 0 ? "244, 67, 54" : "33, 150, 243";
  return { background: `rgba(${color}, ${0.15 + 0.6 * strength})` };
}

async function load() {
  const datasetId = store.dataset?.id;
  if (!datasetId) {
    return;
  }
  try {
    result.value = await store.spatialAPI.fetchNeighborhood(datasetId);
  } catch (caught) {
    logError("Failed to read the neighborhood enrichment:", caught);
    error.value = extractErrorMessage(caught);
  } finally {
    loaded.value = true;
  }
}

async function run() {
  const datasetId = store.dataset?.id;
  if (!datasetId || radiusPixels.value === null || !canRun.value) {
    return;
  }
  running.value = true;
  error.value = null;
  try {
    const { jobId } = await store.spatialAPI.computeNeighborhood(
      datasetId,
      radiusPixels.value,
      excludeTags(),
      "Neighborhood",
    );
    poll(jobId);
  } catch (caught) {
    logError("Neighborhood request failed:", caught);
    error.value = extractErrorMessage(caught);
    running.value = false;
  }
}

function stopPolling() {
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
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
        result.value = (job.spatialResult as ISpatialNeighborhood) ?? null;
        running.value = false;
        // The fractions are a new measurement: make it show up.
        await propertyStore.fetchProperties();
        await propertyStore.fetchPropertyPathsSample();
        return;
      }
      if (
        job.status === jobStates.error ||
        job.status === jobStates.cancelled
      ) {
        error.value = "The neighborhood job failed; see the job log.";
        running.value = false;
        return;
      }
      poll(jobId);
    } catch (caught) {
      logError("Neighborhood job poll failed:", caught);
      error.value = extractErrorMessage(caught);
      running.value = false;
    }
  }, POLL_MS);
}

function buildCsv(summary: ISpatialNeighborhood): string {
  return Papa.unparse({
    fields: ["type", "cells", ...summary.types],
    data: summary.types.map((type, i) => [
      type,
      summary.counts[i],
      ...summary.matrix[i].map((value) => (value === null ? "" : value)),
    ]),
  });
}

function download() {
  if (!result.value) {
    return;
  }
  downloadToClient({
    href:
      "data:text/csv;charset=utf-8," +
      encodeURIComponent(buildCsv(result.value)),
    download: `${store.dataset?.name ?? "dataset"}-neighborhood.csv`,
  });
}

watch(dialog, (open) => {
  if (open) {
    error.value = null;
    load();
  } else {
    stopPolling();
    running.value = false;
  }
});

defineExpose({
  dialog,
  radiusMicrons,
  radiusPixels,
  canRun,
  run,
  result,
  error,
  running,
  buildCsv,
  download,
  excludeTags,
});
</script>

<style lang="scss" scoped>
.matrix-scroll {
  overflow-x: auto;
}

.matrix {
  border-collapse: collapse;
  font-size: 0.75rem;

  th,
  td {
    padding: 2px 6px;
    text-align: right;
    white-space: nowrap;
  }

  th.row {
    text-align: left;
  }

  th.col span {
    display: inline-block;
    max-width: 90px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
}
</style>

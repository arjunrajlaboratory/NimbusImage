<template>
  <v-dialog v-model="dialog">
    <template v-slot:activator="{ on, attrs }">
      <v-btn
        v-bind="{ ...attrs, ...$attrs }"
        v-on="on"
        v-description="{
          section: 'Object list actions',
          title: 'Download Index Conversions',
          description:
            'Download CSV files that map dimension indices (UI and JSON) to their string labels',
        }"
      >
        <v-icon>mdi-table-arrow-down</v-icon>
        Download Index Conversions
      </v-btn>
    </template>
    <v-card>
      <v-card-title> Download Index Conversion CSVs </v-card-title>
      <v-card-subtitle>
        Export dimension index mappings for XY, Z, and Time
      </v-card-subtitle>

      <v-card-text>
        <v-alert type="info" text class="mb-4">
          These CSV files map dimension indices to their labels. Each file
          contains three columns:
          <ul class="mt-2">
            <li><strong>UI Index</strong>: 1-based index shown in the UI</li>
            <li>
              <strong>JSON Index</strong>: 0-based index used in JSON exports
            </li>
            <li>
              <strong>Label</strong>: String label from metadata (e.g., "5 min",
              "H10", "2 µm")
            </li>
          </ul>
        </v-alert>

        <template v-if="!dataset">
          <v-alert type="warning" text>
            No dataset loaded. Please select a dataset first.
          </v-alert>
        </template>

        <template v-else>
          <!-- XY Dimension -->
          <v-card outlined class="mb-3" v-if="hasXYDimension">
            <v-card-title class="text-h6">XY Positions</v-card-title>
            <v-card-text>
              <div class="d-flex align-center">
                <div class="flex-grow-1">
                  <div>{{ xyCount }} positions</div>
                  <div v-if="!hasXYLabels" class="text--secondary caption">
                    No labels detected; index only
                  </div>
                </div>
                <v-btn color="primary" @click="downloadXY">
                  <v-icon left>mdi-download</v-icon>
                  Download XY CSV
                </v-btn>
              </div>
            </v-card-text>
          </v-card>

          <!-- Z Dimension -->
          <v-card outlined class="mb-3" v-if="hasZDimension">
            <v-card-title class="text-h6">Z Slices</v-card-title>
            <v-card-text>
              <div class="d-flex align-center">
                <div class="flex-grow-1">
                  <div>{{ zCount }} slices</div>
                  <div v-if="!hasZLabels" class="text--secondary caption">
                    No labels detected; index only
                  </div>
                </div>
                <v-btn color="primary" @click="downloadZ">
                  <v-icon left>mdi-download</v-icon>
                  Download Z CSV
                </v-btn>
              </div>
            </v-card-text>
          </v-card>

          <!-- Time Dimension -->
          <v-card outlined class="mb-3" v-if="hasTimeDimension">
            <v-card-title class="text-h6">Time Points</v-card-title>
            <v-card-text>
              <div class="d-flex align-center">
                <div class="flex-grow-1">
                  <div>{{ timeCount }} time points</div>
                  <div v-if="!hasTimeLabels" class="text--secondary caption">
                    No labels detected; index only
                  </div>
                </div>
                <v-btn color="primary" @click="downloadTime">
                  <v-icon left>mdi-download</v-icon>
                  Download Time CSV
                </v-btn>
              </div>
            </v-card-text>
          </v-card>

          <v-alert v-if="!hasAnyDimension" type="info" text>
            No multi-dimensional data available for this dataset.
          </v-alert>
        </template>
      </v-card-text>

      <v-card-actions>
        <v-spacer></v-spacer>
        <v-btn @click="dialog = false" text>Close</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from "vue";
import store from "@/store";
import Papa from "papaparse";
import { downloadToClient } from "@/utils/download";
import { logError } from "@/utils/log";

const dialog = ref(false);
const dimensionLabels = ref<{
  xy: string[] | null;
  z: string[] | null;
  t: string[] | null;
} | null>(null);

const dataset = computed(() => store.dataset);

watch(dialog, async (open) => {
  if (open) {
    await loadDimensionLabels();
  }
});

async function loadDimensionLabels() {
  if (!store.selectedDatasetId) {
    dimensionLabels.value = null;
    return;
  }

  try {
    const folder = await store.girderResources.getFolder(
      store.selectedDatasetId,
    );
    if (folder && folder.meta && folder.meta.dimensionLabels) {
      dimensionLabels.value = folder.meta.dimensionLabels;
    } else {
      dimensionLabels.value = null;
    }
  } catch (error) {
    logError("Failed to load dimension labels:", error);
    dimensionLabels.value = null;
  }
}

const xyCount = computed(() => dataset.value?.xy.length ?? 0);
const zCount = computed(() => dataset.value?.z.length ?? 0);
const timeCount = computed(() => dataset.value?.time.length ?? 0);

const hasXYDimension = computed(() => xyCount.value > 1);
const hasZDimension = computed(() => zCount.value > 1);
const hasTimeDimension = computed(() => timeCount.value > 1);
const hasAnyDimension = computed(
  () => hasXYDimension.value || hasZDimension.value || hasTimeDimension.value,
);

const hasXYLabels = computed(
  () =>
    dimensionLabels.value?.xy &&
    dimensionLabels.value.xy.length === xyCount.value,
);
const hasZLabels = computed(
  () =>
    dimensionLabels.value?.z && dimensionLabels.value.z.length === zCount.value,
);
const hasTimeLabels = computed(
  () =>
    dimensionLabels.value?.t &&
    dimensionLabels.value.t.length === timeCount.value,
);

function generateCSV(count: number, labels: string[] | null): string {
  const fields = ["UI Index", "JSON Index", "Label"];
  const data: (string | number)[][] = [];

  for (let i = 0; i < count; i++) {
    const uiIndex = i + 1;
    const jsonIndex = i;
    const label = labels && labels[i] ? labels[i] : "";
    data.push([uiIndex, jsonIndex, label]);
  }

  return Papa.unparse({ fields, data }, { quotes: [false, false, true] });
}

function downloadDimension(
  suffix: string,
  count: number,
  labels: string[] | null,
) {
  const csv = generateCSV(count, labels);
  const datasetName = dataset.value?.name ?? "dataset";
  downloadToClient({
    href: "data:text/csv;charset=utf-8," + encodeURIComponent(csv),
    download: `${datasetName}_${suffix}_index_conversion.csv`,
  });
}

function downloadXY() {
  downloadDimension("xy", xyCount.value, dimensionLabels.value?.xy ?? null);
}

function downloadZ() {
  downloadDimension("z", zCount.value, dimensionLabels.value?.z ?? null);
}

function downloadTime() {
  downloadDimension("time", timeCount.value, dimensionLabels.value?.t ?? null);
}

defineExpose({
  dataset,
  xyCount,
  zCount,
  timeCount,
  hasXYDimension,
  generateCSV,
  dimensionLabels,
  downloadXY,
  dialog,
});
</script>

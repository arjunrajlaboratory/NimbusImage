<template>
  <v-dialog v-model="dialog">
    <template v-slot:activator="{ on, attrs }">
      <v-btn
        v-bind="{ ...attrs, ...$attrs }"
        v-on="on"
        v-description="{
          section: 'Object list actions',
          title: 'Export to JSON',
          description:
            'Export annotations, connections, properties, and property values to a JSON file',
        }"
      >
        <v-icon>mdi-export</v-icon>
        Export to JSON
      </v-btn>
    </template>
    <v-card class="pa-2" :disabled="!canExport">
      <v-card-title>Export to JSON</v-card-title>
      <v-card-subtitle>
        Export your annotations and related data as JSON
      </v-card-subtitle>

      <v-card-text class="pt-2 pb-0">
        <v-alert type="info" text class="mb-4">
          An exported JSON file contains a complete specification of your
          annotation data. That includes coordinates of points and polygons,
          color, property values, connections between annotations, and more. The
          exported JSON file can be used for backup purposes or to transfer
          annotations between datasets. You can also parse the JSON file for
          sophisticated analyses using other tools.
        </v-alert>

        <v-radio-group v-model="exportScope" class="mt-0 mb-2" hide-details>
          <v-radio label="Current dataset only" value="current" />
          <v-radio
            :label="allDatasetsLabel"
            value="all"
            :disabled="!configuration"
          />
        </v-radio-group>

        <template v-if="exportScope === 'all'">
          <template v-if="loadingDatasets">
            <v-progress-linear indeterminate class="my-4" />
            <div class="text-center mb-4">
              Loading datasets in collection...
            </div>
          </template>
          <v-alert
            v-else-if="collectionDatasets.length === 0"
            type="warning"
            text
            class="my-4"
          >
            No datasets found in this collection.
          </v-alert>
          <v-alert v-else type="success" text dense class="my-4">
            Found {{ collectionDatasets.length }} dataset{{
              collectionDatasets.length === 1 ? "" : "s"
            }}
            in this collection.
          </v-alert>
        </template>

        <v-divider class="mb-4" />

        <v-checkbox v-model="exportAnnotations" label="Export annotations" />
        <v-checkbox
          v-model="exportConnections"
          :disabled="!exportAnnotations"
          label="Export annotation connections"
        />
        <v-checkbox v-model="exportProperties" label="Export properties" />
        <v-radio-group
          v-model="propertyScope"
          :disabled="!exportProperties"
          class="ml-8 mt-0"
          hide-details
        >
          <v-radio label="All configurations" value="all" />
          <v-radio label="Current configuration only" value="current" />
        </v-radio-group>
        <v-checkbox
          v-model="exportValues"
          :disabled="!exportProperties || !exportAnnotations"
          label="Export property values"
        />

        <v-textarea
          v-if="exportScope === 'current'"
          v-model="filename"
          class="my-2"
          label="File name"
          rows="1"
          no-resize
          hide-details
        />

        <template v-if="exporting">
          <v-divider class="my-4" />
          <div class="text-subtitle-2 mb-2">
            Exporting {{ exportProgress }} of {{ collectionDatasets.length }}...
          </div>
          <v-progress-linear
            :value="(exportProgress / collectionDatasets.length) * 100"
            class="mb-2"
          />
        </template>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="dialog = false" :disabled="exporting"> Cancel </v-btn>
        <v-btn
          @click="submit"
          color="primary"
          :disabled="!canSubmit"
          :loading="exporting"
        >
          {{ submitButtonText }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import store from "@/store";
import { IBulkJsonExportDataset } from "@/store/ExportAPI";
import { IDatasetView } from "@/store/model";

const dialog = ref(false);
const loadingDatasets = ref(false);
const exporting = ref(false);
const exportProgress = ref(0);

const exportScope = ref<"current" | "all">("current");
const exportAnnotations = ref(true);
const exportConnections = ref(true);
const exportProperties = ref(true);
const exportValues = ref(true);
const propertyScope = ref<"all" | "current">("all");

const filename = ref("");
const collectionDatasets = ref<IBulkJsonExportDataset[]>([]);

const dataset = computed(() => store.dataset);
const configuration = computed(() => store.configuration);
const canExport = computed(() => !!store.dataset);

const canSubmit = computed(() => {
  if (exporting.value) return false;
  if (exportScope.value === "current") {
    return !!dataset.value;
  }
  return collectionDatasets.value.length > 0 && !loadingDatasets.value;
});

const allDatasetsLabel = computed(() => {
  if (loadingDatasets.value) {
    return "All datasets in collection (loading...)";
  }
  if (collectionDatasets.value.length > 0) {
    return `All datasets in collection (${collectionDatasets.value.length})`;
  }
  return "All datasets in collection";
});

const submitButtonText = computed(() => {
  if (exportScope.value === "current") {
    return "Export";
  }
  const count = collectionDatasets.value.length;
  return `Export ${count} dataset${count === 1 ? "" : "s"}`;
});

function resetFilename() {
  filename.value = (dataset.value?.name ?? "unknown") + ".json";
}

onMounted(resetFilename);

watch(dataset, resetFilename);

watch(dialog, (open) => {
  if (open && exportScope.value === "all") {
    loadCollectionDatasets();
  }
});

watch(exportScope, (scope) => {
  if (
    scope === "all" &&
    dialog.value &&
    collectionDatasets.value.length === 0
  ) {
    loadCollectionDatasets();
  }
});

async function loadCollectionDatasets() {
  if (!configuration.value) return;

  loadingDatasets.value = true;
  collectionDatasets.value = [];

  try {
    const datasetViews = await store.api.findDatasetViews({
      configurationId: configuration.value.id,
    });

    const datasetIds = datasetViews.map((dv: IDatasetView) => dv.datasetId);

    if (datasetIds.length > 0) {
      await store.girderResources.batchFetchResources({
        folderIds: datasetIds,
      });

      collectionDatasets.value = datasetViews.map((dv: IDatasetView) => {
        const folder = store.girderResources.watchFolder(dv.datasetId);
        return {
          datasetId: dv.datasetId,
          datasetName: folder?.name || dv.datasetId,
        };
      });
    }
  } finally {
    loadingDatasets.value = false;
  }
}

async function submit() {
  if (exportScope.value === "current") {
    submitSingleDataset();
  } else {
    await submitAllDatasets();
  }
}

function submitSingleDataset() {
  store.exportAPI.exportJson({
    datasetId: dataset.value!.id,
    configurationId:
      propertyScope.value === "current" ? store.configuration?.id : undefined,
    includeAnnotations: exportAnnotations.value,
    includeConnections: exportConnections.value,
    includeProperties: exportProperties.value,
    includePropertyValues: exportValues.value,
    filename: filename.value,
  });
  dialog.value = false;
}

async function submitAllDatasets() {
  if (collectionDatasets.value.length === 0) return;

  exporting.value = true;
  exportProgress.value = 0;

  try {
    await store.exportAPI.exportBulkJson({
      datasets: collectionDatasets.value,
      configurationId:
        propertyScope.value === "current" ? configuration.value?.id : undefined,
      includeAnnotations: exportAnnotations.value,
      includeConnections: exportConnections.value,
      includeProperties: exportProperties.value,
      includePropertyValues: exportValues.value,
      onProgress: (completed) => {
        exportProgress.value = completed;
      },
    });

    dialog.value = false;
  } finally {
    exporting.value = false;
  }
}

defineExpose({
  canExport,
  exportScope,
  exporting,
  filename,
  resetFilename,
  canSubmit,
  submitSingleDataset,
  collectionDatasets,
  submitAllDatasets,
  submitButtonText,
});
</script>

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

<script lang="ts">
import { Vue, Component, Watch } from "vue-property-decorator";
import store from "@/store";
import { IBulkJsonExportDataset } from "@/store/ExportAPI";
import { IDatasetView } from "@/store/model";

@Component({})
export default class AnnotationExport extends Vue {
  readonly store = store;

  dialog = false;
  loadingDatasets = false;
  exporting = false;
  exportProgress = 0;

  exportScope: "current" | "all" = "current";
  exportAnnotations = true;
  exportConnections = true;
  exportProperties = true;
  exportValues = true;
  propertyScope: "all" | "current" = "all";

  filename: string = "";
  collectionDatasets: IBulkJsonExportDataset[] = [];

  get dataset() {
    return this.store.dataset;
  }

  get configuration() {
    return this.store.configuration;
  }

  get canExport() {
    return !!this.store.dataset;
  }

  get canSubmit() {
    if (this.exporting) return false;
    if (this.exportScope === "current") {
      return !!this.dataset;
    } else {
      return this.collectionDatasets.length > 0 && !this.loadingDatasets;
    }
  }

  get allDatasetsLabel() {
    if (this.loadingDatasets) {
      return "All datasets in collection (loading...)";
    }
    if (this.collectionDatasets.length > 0) {
      return `All datasets in collection (${this.collectionDatasets.length})`;
    }
    return "All datasets in collection";
  }

  get submitButtonText() {
    if (this.exportScope === "current") {
      return "Export";
    }
    const count = this.collectionDatasets.length;
    return `Export ${count} dataset${count === 1 ? "" : "s"}`;
  }

  mounted() {
    this.resetFilename();
  }

  @Watch("dataset")
  resetFilename() {
    this.filename = (this.dataset?.name ?? "unknown") + ".json";
  }

  @Watch("dialog")
  onDialogChange(open: boolean) {
    if (open && this.exportScope === "all") {
      this.loadCollectionDatasets();
    }
  }

  @Watch("exportScope")
  onExportScopeChange(scope: "current" | "all") {
    if (
      scope === "all" &&
      this.dialog &&
      this.collectionDatasets.length === 0
    ) {
      this.loadCollectionDatasets();
    }
  }

  async loadCollectionDatasets() {
    if (!this.configuration) return;

    this.loadingDatasets = true;
    this.collectionDatasets = [];

    try {
      const datasetViews = await this.store.api.findDatasetViews({
        configurationId: this.configuration.id,
      });

      const datasetIds = datasetViews.map((dv: IDatasetView) => dv.datasetId);

      if (datasetIds.length > 0) {
        await this.store.girderResources.batchFetchResources({
          folderIds: datasetIds,
        });

        this.collectionDatasets = datasetViews.map((dv: IDatasetView) => {
          const folder = this.store.girderResources.watchFolder(dv.datasetId);
          return {
            datasetId: dv.datasetId,
            datasetName: folder?.name || dv.datasetId,
          };
        });
      }
    } finally {
      this.loadingDatasets = false;
    }
  }

  async submit() {
    if (this.exportScope === "current") {
      this.submitSingleDataset();
    } else {
      await this.submitAllDatasets();
    }
  }

  submitSingleDataset() {
    this.store.exportAPI.exportJson({
      datasetId: this.dataset!.id,
      configurationId:
        this.propertyScope === "current"
          ? this.store.configuration?.id
          : undefined,
      includeAnnotations: this.exportAnnotations,
      includeConnections: this.exportConnections,
      includeProperties: this.exportProperties,
      includePropertyValues: this.exportValues,
      filename: this.filename,
    });
    this.dialog = false;
  }

  async submitAllDatasets() {
    if (this.collectionDatasets.length === 0) return;

    this.exporting = true;
    this.exportProgress = 0;

    try {
      await this.store.exportAPI.exportBulkJson({
        datasets: this.collectionDatasets,
        configurationId:
          this.propertyScope === "current" ? this.configuration?.id : undefined,
        includeAnnotations: this.exportAnnotations,
        includeConnections: this.exportConnections,
        includeProperties: this.exportProperties,
        includePropertyValues: this.exportValues,
        onProgress: (completed) => {
          this.exportProgress = completed;
        },
      });

      this.dialog = false;
    } finally {
      this.exporting = false;
    }
  }
}
</script>

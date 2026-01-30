<template>
  <v-dialog v-model="dialog" max-width="600">
    <template v-slot:activator="{ on, attrs }">
      <v-btn
        v-bind="{ ...attrs, ...$attrs }"
        v-on="on"
        :disabled="!canExport"
        v-description="{
          section: 'Object list actions',
          title: 'Export Collection to JSON',
          description:
            'Export annotations from all datasets in this collection to individual JSON files',
        }"
      >
        <v-icon>mdi-export-variant</v-icon>
        Export Collection
      </v-btn>
    </template>
    <v-card class="pa-2">
      <v-card-title>Export Collection to JSON</v-card-title>
      <v-card-subtitle>
        Export annotations from all datasets in this collection as separate JSON
        files
      </v-card-subtitle>

      <v-card-text class="pt-2 pb-0">
        <v-alert type="info" text class="mb-4">
          This will download one JSON file per dataset in the current
          collection. Each file will contain the annotations, connections,
          properties, and property values for that dataset.
        </v-alert>

        <template v-if="loading">
          <v-progress-linear indeterminate class="mb-4" />
          <div class="text-center">Loading datasets in collection...</div>
        </template>

        <template v-else-if="datasets.length === 0">
          <v-alert type="warning" text>
            No datasets found in this collection.
          </v-alert>
        </template>

        <template v-else>
          <v-alert type="success" text dense class="mb-4">
            Found {{ datasets.length }} dataset{{
              datasets.length === 1 ? "" : "s"
            }}
            in this collection.
          </v-alert>

          <v-checkbox v-model="exportAnnotations" label="Export annotations" />
          <v-checkbox
            v-model="exportConnections"
            :disabled="!exportAnnotations"
            label="Export annotation connections"
          />
          <v-checkbox v-model="exportProperties" label="Export properties" />
          <v-checkbox
            v-model="exportValues"
            :disabled="!exportProperties || !exportAnnotations"
            label="Export property values"
          />

          <template v-if="exporting">
            <v-divider class="my-4" />
            <div class="text-subtitle-2 mb-2">
              Exporting {{ exportProgress }} of {{ datasets.length }}...
            </div>
            <v-progress-linear
              :value="(exportProgress / datasets.length) * 100"
              class="mb-2"
            />
          </template>
        </template>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="dialog = false" :disabled="exporting"> Cancel </v-btn>
        <v-btn
          @click="submit"
          color="primary"
          :disabled="datasets.length === 0 || exporting"
          :loading="exporting"
        >
          Export {{ datasets.length }} dataset{{
            datasets.length === 1 ? "" : "s"
          }}
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
export default class CollectionJsonExport extends Vue {
  readonly store = store;

  dialog = false;
  loading = false;
  exporting = false;
  exportProgress = 0;

  exportAnnotations = true;
  exportConnections = true;
  exportProperties = true;
  exportValues = true;

  datasets: IBulkJsonExportDataset[] = [];

  get configuration() {
    return this.store.configuration;
  }

  get canExport() {
    return !!this.configuration;
  }

  @Watch("dialog")
  async onDialogChange(open: boolean) {
    if (open && this.configuration) {
      await this.loadDatasets();
    }
  }

  async loadDatasets() {
    if (!this.configuration) return;

    this.loading = true;
    this.datasets = [];

    try {
      // Get all dataset views for this configuration
      const datasetViews = await this.store.api.findDatasetViews({
        configurationId: this.configuration.id,
      });

      // Get dataset names via batch resource fetch
      const datasetIds = datasetViews.map((dv: IDatasetView) => dv.datasetId);

      if (datasetIds.length > 0) {
        await this.store.girderResources.batchFetchResources({
          folderIds: datasetIds,
        });

        // Build the dataset list with names
        this.datasets = datasetViews.map((dv: IDatasetView) => {
          const folder = this.store.girderResources.watchFolder(dv.datasetId);
          return {
            datasetId: dv.datasetId,
            datasetName: folder?.name || dv.datasetId,
          };
        });
      }
    } finally {
      this.loading = false;
    }
  }

  async submit() {
    if (this.datasets.length === 0) return;

    this.exporting = true;
    this.exportProgress = 0;

    try {
      await this.store.exportAPI.exportBulkJson({
        datasets: this.datasets,
        configurationId: this.configuration?.id,
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

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

<script lang="ts">
import { Vue, Component, Watch } from "vue-property-decorator";
import store from "@/store";
import Papa from "papaparse";
import { downloadToClient } from "@/utils/download";
import { logError } from "@/utils/log";

@Component({
  components: {},
})
export default class IndexConversionDialog extends Vue {
  readonly store = store;

  dialog: boolean = false;

  dimensionLabels: {
    xy: string[] | null;
    z: string[] | null;
    t: string[] | null;
  } | null = null;

  get dataset() {
    return this.store.dataset;
  }

  @Watch("dialog")
  async onDialogOpen() {
    if (this.dialog) {
      await this.loadDimensionLabels();
    }
  }

  async loadDimensionLabels() {
    if (!this.store.selectedDatasetId) {
      this.dimensionLabels = null;
      return;
    }

    try {
      const folder = await this.store.girderResources.getFolder(
        this.store.selectedDatasetId,
      );
      if (folder && folder.meta && folder.meta.dimensionLabels) {
        this.dimensionLabels = folder.meta.dimensionLabels;
      } else {
        this.dimensionLabels = null;
      }
    } catch (error) {
      logError("Failed to load dimension labels:", error);
      this.dimensionLabels = null;
    }
  }

  get xyCount() {
    return this.dataset?.xy.length ?? 0;
  }

  get zCount() {
    return this.dataset?.z.length ?? 0;
  }

  get timeCount() {
    return this.dataset?.time.length ?? 0;
  }

  get hasXYDimension() {
    return this.xyCount > 1;
  }

  get hasZDimension() {
    return this.zCount > 1;
  }

  get hasTimeDimension() {
    return this.timeCount > 1;
  }

  get hasAnyDimension() {
    return this.hasXYDimension || this.hasZDimension || this.hasTimeDimension;
  }

  get hasXYLabels() {
    return (
      this.dimensionLabels?.xy &&
      this.dimensionLabels.xy.length === this.xyCount
    );
  }

  get hasZLabels() {
    return (
      this.dimensionLabels?.z && this.dimensionLabels.z.length === this.zCount
    );
  }

  get hasTimeLabels() {
    return (
      this.dimensionLabels?.t &&
      this.dimensionLabels.t.length === this.timeCount
    );
  }

  generateCSV(count: number, labels: string[] | null): string {
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

  downloadXY() {
    const csv = this.generateCSV(
      this.xyCount,
      this.dimensionLabels?.xy ?? null,
    );
    const datasetName = this.dataset?.name ?? "dataset";
    const params = {
      href: "data:text/csv;charset=utf-8," + encodeURIComponent(csv),
      download: `${datasetName}_xy_index_conversion.csv`,
    };
    downloadToClient(params);
  }

  downloadZ() {
    const csv = this.generateCSV(this.zCount, this.dimensionLabels?.z ?? null);
    const datasetName = this.dataset?.name ?? "dataset";
    const params = {
      href: "data:text/csv;charset=utf-8," + encodeURIComponent(csv),
      download: `${datasetName}_z_index_conversion.csv`,
    };
    downloadToClient(params);
  }

  downloadTime() {
    const csv = this.generateCSV(
      this.timeCount,
      this.dimensionLabels?.t ?? null,
    );
    const datasetName = this.dataset?.name ?? "dataset";
    const params = {
      href: "data:text/csv;charset=utf-8," + encodeURIComponent(csv),
      download: `${datasetName}_time_index_conversion.csv`,
    };
    downloadToClient(params);
  }
}
</script>

<template>
  <v-container>
    <v-progress-circular v-if="loading" indeterminate />
    <v-data-table
      v-else-if="compatibleConfigurations.length > 0"
      show-select
      v-model="selectedConfigurations"
      :items="compatibleConfigurations"
      :headers="headers"
      :search="search"
    >
      <template v-slot:top>
        <v-card>
          <v-card-title>
            {{ title }}
            <v-spacer></v-spacer>
            <v-text-field
              v-model="search"
              append-icon="mdi-magnify"
              label="Search"
              single-line
              hide-details
            ></v-text-field>
          </v-card-title>
        </v-card>
      </template>
    </v-data-table>
    <v-alert v-else color="orange darken-2" dark>
      No compatible collection were found for this dataset.
    </v-alert>
    <div class="button-bar">
      <v-btn color="warning" class="mr-4" @click="cancel">Cancel</v-btn>
      <v-btn
        :disabled="selectedConfigurations.length <= 0"
        color="primary"
        class="mr-4"
        @click="submit"
      >
        Submit
      </v-btn>
    </div>
  </v-container>
</template>
<script lang="ts">
import { Component, Prop, Watch } from "vue-property-decorator";
import store from "@/store";
import { IDatasetConfiguration, IDatasetView } from "@/store/model";
import routeMapper from "@/utils/routeMapper";
import { logError } from "@/utils/log";

const Mapper = routeMapper(
  {},
  {
    datasetId: {
      parse: String,
      get: () => store.selectedDatasetId,
      set: (value: string) => store.setSelectedDataset(value),
    },
  },
);

@Component
export default class ConfigurationSelect extends Mapper {
  readonly store = store;

  @Prop({ default: "Select collections" })
  title!: string;

  compatibleConfigurations: IDatasetConfiguration[] = [];
  selectedConfigurations: IDatasetConfiguration[] = [];
  loading: boolean = false;
  search: string = "";

  readonly headers = [
    { text: "Collection Name", value: "name" },
    { text: "Collection Description", value: "description" },
  ];

  get dataset() {
    return this.store.dataset;
  }

  @Watch("dataset")
  async updateCompatibleConfigurations() {
    if (!this.dataset) {
      this.compatibleConfigurations = [];
      return;
    }
    this.loading = true;
    try {
      // Find all configurations that can be linked to the dataset but are not linked yet
      const views = await this.store.api.findDatasetViews({
        datasetId: this.dataset.id,
      });
      const linkedConfigurationIds = new Set(
        views.map((v: IDatasetView) => v.configurationId),
      );
      const compatibleConfigurations =
        await this.store.api.getCompatibleConfigurations(this.dataset);
      this.compatibleConfigurations = compatibleConfigurations.filter(
        (conf) => !linkedConfigurationIds.has(conf.id),
      );

      // Get all collections using the new endpoint (like CollectionList.vue does)
      const allConfigurations = await this.store.api.getAllConfigurations();

      // Filter for compatible configurations using client-side logic
      const datasetCompatibility = getDatasetCompatibility(this.dataset);
      const compatibleConfigurations = allConfigurations.filter((conf) => {
        // Skip if already linked
        if (linkedConfigurationIds.has(conf.id)) {
          return false;
        }
        // Check compatibility using the same logic as AddDatasetToCollection
        return areCompatibles(conf.compatibility, datasetCompatibility);
      });

      this.compatibleConfigurations = compatibleConfigurations;
    } catch (error) {
      logError("Failed to fetch compatible configurations:", error);
      this.compatibleConfigurations = [];
    } finally {
      this.loading = false;
    }
  }

  mounted() {
    this.updateCompatibleConfigurations();
  }

  submit() {
    this.$emit("submit", this.selectedConfigurations);
  }

  cancel() {
    this.$emit("cancel");
  }
}
</script>

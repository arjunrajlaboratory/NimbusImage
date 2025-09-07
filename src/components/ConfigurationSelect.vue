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
import { IDatasetConfiguration, areCompatibles } from "@/store/model";
import {
  getDatasetCompatibility,
  setBaseCollectionValues,
} from "@/store/GirderAPI";
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
        views.map((v: any) => v.configurationId),
      );

      // Get all collections using the new endpoint (like CollectionList.vue does)
      const allConfigurations = await this.getAllConfigurations();

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

  async getAllConfigurations(): Promise<IDatasetConfiguration[]> {
    try {
      // Get the current folder location from the store
      const currentFolder = this.store.folderLocation;

      // Check if currentFolder is a full folder object with _id, or fallback to user's private folder
      let folderId = null;
      if (currentFolder && "_id" in currentFolder) {
        folderId = currentFolder._id;
      } else {
        // If no current folder with _id, try to get user's private folder
        const privateFolder = await this.store.api.getUserPrivateFolder();
        if (privateFolder) {
          folderId = privateFolder._id;
        }
      }

      if (!folderId) {
        logError("No folderId found");
        return [];
      }

      // First attempt: Try fetching collections with folderId (as per backend API)
      let response;

      try {
        response = await this.store.api.client.get("upenn_collection", {
          params: {
            folderId: folderId,
            limit: 0, // Get all collections
            sort: "updated",
            sortdir: -1,
          },
        });
      } catch (folderError) {
        // Second attempt: Try without folderId
        try {
          response = await this.store.api.client.get("upenn_collection", {
            params: {
              limit: 0, // Get all collections
              sort: "updated",
              sortdir: -1,
            },
          });
        } catch (noFolderError) {
          throw noFolderError;
        }
      }

      // Convert to IDatasetConfiguration format using the same logic as setBaseCollectionValues
      return response.data.map((item: any) => setBaseCollectionValues(item));
    } catch (error) {
      logError("Failed to fetch all configurations:", error);
      return [];
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

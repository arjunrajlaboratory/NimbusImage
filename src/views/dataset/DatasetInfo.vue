<template>
  <v-container flex>
    <v-row>
      <v-col cols="6">
        <v-card class="my-3">
          <v-toolbar>
            <v-toolbar-title> Dataset </v-toolbar-title>
            <v-spacer></v-spacer>
            <v-btn
              color="green"
              @click="goToDefaultView"
              :disabled="!dataset"
              class="pulse-btn"
              id="view-dataset-button-tourstep"
              v-tour-trigger="'view-dataset-button-tourtrigger'"
            >
              <v-icon left>mdi-eye</v-icon>
              View
            </v-btn>
          </v-toolbar>
          <v-card-text>
            <v-simple-table class="elevation-3 ma-2">
              <tbody>
                <tr v-for="item in report" :key="item.name">
                  <td class="text-right" width="30%">{{ item.name }}</td>
                  <td width="70%">{{ item.value }}</td>
                </tr>
              </tbody>
            </v-simple-table>
            <div class="text-right mt-4 mr-2">
              <v-dialog v-model="removeDatasetConfirm" max-width="33vw">
                <template #activator="{ on }">
                  <v-btn color="error" small outlined v-on="on">
                    <v-icon left>mdi-close</v-icon>
                    Remove Dataset
                  </v-btn>
                </template>
                <v-card>
                  <v-card-title>
                    Are you sure to remove "{{ datasetName }}"?
                  </v-card-title>
                  <v-card-actions class="button-bar">
                    <v-btn @click="removeDatasetConfirm = false">
                      Cancel
                    </v-btn>
                    <v-btn @click="removeDataset" color="warning">Remove</v-btn>
                  </v-card-actions>
                </v-card>
              </v-dialog>
            </div>
          </v-card-text>
        </v-card>
      </v-col>
      <v-col cols="6">
        <v-card class="my-3">
          <v-toolbar>
            <v-toolbar-title>Select a collection</v-toolbar-title>
          </v-toolbar>
          <v-alert type="info" text class="mb-4">
            Collections are a way to organize your datasets. Every dataset
            belongs to one or more collections. You can create a new collection
            (default), or add your dataset to an existing collection, or "copy"
            an existing collection to put your dataset into (useful if you want
            to copy in existing tools and layers). The collection also includes
            the layers and tools that you use to visualize the dataset.
          </v-alert>
          <v-card-text>
            <v-dialog
              v-model="removeDatasetViewConfirm"
              max-width="33vw"
              v-if="viewToRemove"
            >
              <v-card>
                <v-card-title>
                  Are you sure you want to remove the dataset from the
                  collection "{{
                    configInfo[viewToRemove.configurationId]
                      ? configInfo[viewToRemove.configurationId].name
                      : "Unnamed configuration"
                  }}"?
                </v-card-title>
                <v-card-actions class="button-bar">
                  <v-btn @click="closeRemoveConfigurationDialog()">
                    Cancel
                  </v-btn>
                  <v-btn @click="removeDatasetView()" color="warning">
                    Remove
                  </v-btn>
                </v-card-actions>
              </v-card>
            </v-dialog>
            <v-card class="ma-3">
              <v-card-title class="title">
                {{
                  datasetViewItems.length > 0
                    ? "Select a collection"
                    : "Create new collection"
                }}
              </v-card-title>
              <v-card-text>
                <div v-if="dataset && datasetViewItems.length <= 0">
                  <v-text-field
                    v-tooltip
                    v-model="defaultConfigurationName"
                    label="New collection name"
                    dense
                    hide-details
                    class="ma-1 pb-2 important-field"
                  />
                  <v-divider class="my-4" />
                </div>

                <!-- <div>
                  <v-tooltip top max-width="50vh">
                    <template v-slot:activator="{ on, attrs }">
                      <v-btn
                        v-on="on"
                        v-bind="attrs"
                        class="ma-1"
                        small
                        color="primary"
                        :to="{
                          name: 'newconfiguration',
                          params: {},
                          query: { datasetId: dataset ? dataset.id : '' }
                        }"
                      >
                        Create New Configuration…
                      </v-btn>
                    </template>
                    Create a new collection and add the current dataset to it
                  </v-tooltip>
                </div> -->
              </v-card-text>
            </v-card>
            <v-list two-line>
              <v-radio-group v-model="selectedDatasetViewId">
                <v-list-item
                  v-for="d in datasetViewItems"
                  :key="d.datasetView.id"
                  @click.stop="selectedDatasetViewId = d.datasetView.id"
                  class="selectable-list-item"
                >
                  <v-list-item-action class="mr-2">
                    <v-radio
                      :value="d.datasetView.id"
                      color="primary"
                    ></v-radio>
                  </v-list-item-action>
                  <v-list-item-content>
                    <v-list-item-title>
                      {{
                        d.configInfo
                          ? d.configInfo.name
                          : "Unnamed configuration"
                      }}
                    </v-list-item-title>
                    <v-list-item-subtitle>
                      {{
                        d.configInfo
                          ? d.configInfo.description
                          : "No description"
                      }}
                    </v-list-item-subtitle>
                  </v-list-item-content>
                  <v-list-item-action @click.stop>
                    <span class="button-bar">
                      <girder-location-chooser
                        @input="duplicateView(d.datasetView, $event)"
                        title="Select a folder for duplicated configuration"
                      >
                        <template v-slot:activator="{ on }">
                          <v-icon
                            class="action-icon mr-2"
                            color="primary"
                            v-on="on"
                          >
                            mdi-content-duplicate
                          </v-icon>
                        </template>
                      </girder-location-chooser>
                      <v-icon
                        class="action-icon"
                        color="warning"
                        v-on:click.stop="
                          openRemoveConfigurationDialog(d.datasetView)
                        "
                      >
                        mdi-close
                      </v-icon>
                    </span>
                  </v-list-item-action>
                </v-list-item>
              </v-radio-group>
            </v-list>
            <div>
              <v-tooltip top max-width="50vh">
                <template v-slot:activator="{ on, attrs }">
                  <v-btn
                    v-on="on"
                    v-bind="attrs"
                    class="ma-1"
                    small
                    color="primary"
                    :to="{
                      name: 'importconfiguration',
                      query: { datasetId, folderId: datasetParentId },
                    }"
                  >
                    Add to an existing collection…
                  </v-btn>
                </template>
                Add this dataset to an existing collection. Shows a list of all
                collections that are compatible with the current dataset.
              </v-tooltip>
            </div>
            <div>
              <v-tooltip top max-width="50vh">
                <template v-slot:activator="{ on, attrs }">
                  <v-btn
                    v-on="on"
                    v-bind="attrs"
                    class="ma-1"
                    small
                    color="primary"
                    :to="{
                      name: 'duplicateimportconfiguration',
                      query: { datasetId },
                    }"
                  >
                    Copy existing collection…
                  </v-btn>
                </template>
                Make a copy of an existing collection and apply it to the
                current dataset, leaving the original collection unchanged.
              </v-tooltip>
            </div>
            <div v-if="dataset && datasetViewItems.length > 0">
              <v-tooltip top max-width="50vh">
                <template v-slot:activator="{ on, attrs }">
                  <v-btn
                    v-on="on"
                    v-bind="attrs"
                    class="ma-1"
                    small
                    color="primary"
                    @click="showNewCollectionDialog = true"
                  >
                    Add a new collection…
                  </v-btn>
                </template>
                Create a new collection with a custom name and location for this
                dataset.
              </v-tooltip>
            </div>

            <!-- New Collection Location Dialog -->
            <v-dialog v-model="showNewCollectionDialog" max-width="500px">
              <v-card>
                <v-card-title>Select Location for New Collection</v-card-title>
                <v-card-text>
                  <p>Choose where to store the new collection:</p>
                  <girder-location-chooser
                    @input="handleLocationSelected"
                    title="Select a folder for the new collection"
                  />
                </v-card-text>
                <v-card-actions>
                  <v-spacer></v-spacer>
                  <v-btn text @click="showNewCollectionDialog = false"
                    >Cancel</v-btn
                  >
                </v-card-actions>
              </v-card>
            </v-dialog>

            <!-- New Collection Name Dialog -->
            <v-dialog v-model="showNewCollectionNameDialog" max-width="500px">
              <v-card>
                <v-card-title>Name Your New Collection</v-card-title>
                <v-card-text>
                  <v-text-field
                    v-model="newCollectionName"
                    label="Collection Name"
                    dense
                    autofocus
                    :rules="nameRules"
                  />
                </v-card-text>
                <v-card-actions>
                  <v-spacer></v-spacer>
                  <v-btn text @click="showNewCollectionNameDialog = false"
                    >Cancel</v-btn
                  >
                  <v-btn color="success" @click="createNewCollection"
                    >Create</v-btn
                  >
                </v-card-actions>
              </v-card>
            </v-dialog>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>
  </v-container>
</template>
<script lang="ts">
import { Vue, Component, Watch } from "vue-property-decorator";
import store from "@/store";
import girderResources from "@/store/girderResources";
import { IDatasetView } from "@/store/model";
import { IGirderItem, IGirderSelectAble } from "@/girder";
import { logError } from "@/utils/log";
import datasetMetadataImport from "@/store/datasetMetadataImport";

@Component({
  components: {
    GirderLocationChooser: () =>
      import("@/components/GirderLocationChooser.vue").then((mod) => mod),
  },
})
export default class DatasetInfo extends Vue {
  readonly store = store;
  readonly girderResources = girderResources;

  removeDatasetConfirm = false;

  removeDatasetViewConfirm = false;
  viewToRemove: IDatasetView | null = null;

  datasetViews: IDatasetView[] = [];
  configInfo: { [configurationId: string]: IGirderItem } = {};
  selectedDatasetViewId: string | null = null;

  defaultConfigurationName: string = "";

  showNewCollectionDialog = false;
  showNewCollectionNameDialog = false;
  newCollectionName: string = "";
  selectedFolderId: string | null = null;
  datasetParentId: string | null = null;

  readonly headers = [
    {
      text: "Field",
      sortable: false,
      value: "name",
    },
    {
      text: "Value",
      sortable: false,
      value: "value",
    },
  ];

  get datasetViewItems(): {
    datasetView: IDatasetView;
    configInfo: IGirderItem | undefined;
  }[] {
    return this.datasetViews.map((datasetView) => ({
      datasetView,
      configInfo: this.configInfo[datasetView.configurationId],
    }));
  }

  @Watch("datasetViews")
  fetchConfigurationsInfo() {
    for (const datasetView of this.datasetViews) {
      if (!(datasetView.configurationId in this.configInfo)) {
        this.girderResources
          .getCollection(datasetView.configurationId)
          .then((item: IGirderItem | null) =>
            Vue.set(this.configInfo, datasetView.configurationId, item),
          )
          .catch((error: unknown) => {
            logError(
              `Failed to fetch collection info for ${datasetView.configurationId}:`,
              error,
            );
            // Set to null to prevent retry loops
            Vue.set(this.configInfo, datasetView.configurationId, null);
          });
      }
    }

    // Check if the selected view still exists in the dataset views
    if (this.selectedDatasetViewId) {
      const selectedViewExists = this.datasetViews.some(
        (view) => view.id === this.selectedDatasetViewId,
      );

      // If the selected view no longer exists but there are other views, select the first one
      if (!selectedViewExists && this.datasetViews.length > 0) {
        this.selectedDatasetViewId = this.datasetViews[0].id;
      }
    }
    // Set the first dataset view as selected if none is selected yet
    else if (this.datasetViews.length > 0 && !this.selectedDatasetViewId) {
      this.selectedDatasetViewId = this.datasetViews[0].id;
    }
  }

  get dataset() {
    return this.store.dataset;
  }

  get datasetName() {
    return this.dataset?.name || "";
  }

  get datasetId() {
    return this.dataset?.id || "";
  }

  get report() {
    return [
      {
        name: "Dataset Name",
        value: this.datasetName,
      },
      {
        name: "Dataset Description",
        value: this.dataset?.description || "",
      },
      {
        name: "Timepoints",
        value: this.dataset?.time?.length || "?",
      },
      {
        name: "XY Slices",
        value: this.dataset?.xy?.length || "?",
      },
      {
        name: "Z Slices",
        value: this.dataset?.z?.length || "?",
      },
      {
        name: "Channels",
        value: this.dataset?.channels?.length || "?",
      },
    ];
  }

  mounted() {
    this.updateDatasetViews();
    this.updateDefaultConfigurationName();
    this.fetchDatasetParentFolder();
  }

  @Watch("dataset")
  async updateDatasetViews() {
    if (this.dataset) {
      try {
        this.datasetViews = await this.store.api.findDatasetViews({
          datasetId: this.dataset.id,
        });
      } catch (error) {
        logError("Failed to fetch dataset views:", error);
        this.datasetViews = [];
      }
    } else {
      this.datasetViews = [];
    }
    return this.datasetViews;
  }

  @Watch("datasetName")
  updateDefaultConfigurationName() {
    this.defaultConfigurationName =
      (this.datasetName || "Default") + " collection";
  }

  @Watch("dataset")
  async fetchDatasetParentFolder() {
    if (this.dataset) {
      const folder = await this.girderResources.getFolder(this.dataset.id);
      this.datasetParentId = folder?.parentId || null;
    } else {
      this.datasetParentId = null;
    }
  }

  toRoute(datasetView: IDatasetView) {
    return {
      name: "datasetview",
      params: Object.assign({}, this.$route.params, {
        datasetViewId: datasetView.id,
        datasetId: datasetView.datasetId,
        configurationId: datasetView.configurationId,
      }),
    };
  }

  removeDataset() {
    this.store.deleteDataset(this.dataset!).then(() => {
      this.removeDatasetConfirm = false;
      this.$router.push({
        name: "root",
      });
    });
  }

  openRemoveConfigurationDialog(datasetView: IDatasetView) {
    this.removeDatasetViewConfirm = true;
    this.viewToRemove = datasetView;
  }

  closeRemoveConfigurationDialog() {
    this.removeDatasetViewConfirm = false;
    this.viewToRemove = null;
  }

  removeDatasetView() {
    if (!this.viewToRemove) {
      return;
    }
    // Store whether we're removing the currently selected view
    const isRemovingSelected =
      this.viewToRemove.id === this.selectedDatasetViewId;

    const promise = this.store.deleteDatasetView(this.viewToRemove);
    if (promise) {
      promise.then(() => {
        this.removeDatasetViewConfirm = false;
        this.viewToRemove = null;

        // Update the dataset views
        this.updateDatasetViews().then(() => {
          // If we removed the selected view and there are still views left, select the first one
          if (isRemovingSelected && this.datasetViews.length > 0) {
            this.selectedDatasetViewId = this.datasetViews[0].id;
          } else if (this.datasetViews.length === 0) {
            // If no views left, clear the selection
            this.selectedDatasetViewId = null;
          }
        });
      });
    }
  }

  async duplicateView(
    datasetView: IDatasetView,
    configurationFolder: IGirderSelectAble | null,
  ) {
    if (!this.dataset || configurationFolder?._modelType !== "folder") {
      return;
    }
    const baseConfig = await this.girderResources.getConfiguration(
      datasetView.configurationId,
    );
    if (!baseConfig) {
      return;
    }
    const config = await store.api.duplicateConfiguration(
      baseConfig,
      configurationFolder._id,
    );
    await this.store.createDatasetView({
      configurationId: config.id,
      datasetId: this.dataset.id,
    });

    this.$router.push({
      name: "configuration",
      params: Object.assign({ configurationId: config.id }, this.$route.params),
    });
  }

  async goToDefaultView() {
    // If we already have dataset views, use the selected one
    if (this.datasetViews.length > 0) {
      const selectedView = this.selectedDatasetViewId
        ? this.datasetViews.find((v) => v.id === this.selectedDatasetViewId)
        : this.datasetViews[0];

      if (selectedView) {
        this.$router.push(this.toRoute(selectedView));
        return;
      }
    }

    // Otherwise create a new view
    const defaultView = await this.createDefaultView();
    if (defaultView) {
      this.$router.push(this.toRoute(defaultView));
    }
  }

  async createDefaultView() {
    if (!this.dataset) {
      return;
    }

    const datasetFolder = await this.girderResources.getFolder(this.dataset.id);
    if (!datasetFolder?.parentId) {
      return;
    }

    // Check if we have collection data to use
    if (
      datasetMetadataImport.hasCollectionData &&
      datasetMetadataImport.collectionData
    ) {
      try {
        // Use the collection data as the configuration base
        const config = await this.store.api.createConfigurationFromBase(
          this.defaultConfigurationName,
          "",
          datasetFolder.parentId,
          datasetMetadataImport.collectionData,
        );

        // Clear the collection data after using it
        datasetMetadataImport.clearCollectionFile();

        const view = await this.store.createDatasetView({
          configurationId: config.id,
          datasetId: this.dataset.id,
        });

        return view;
      } catch (error) {
        logError("Failed to use downloadedcollection data:", error);
        // Fall back to default configuration if collection data fails
      }
    }

    // Default configuration creation (existing code)
    const config = await this.store.createConfiguration({
      name: this.defaultConfigurationName,
      description: "",
      folderId: datasetFolder.parentId,
    });

    if (!config) {
      return;
    }

    const view = await this.store.createDatasetView({
      configurationId: config.id,
      datasetId: this.dataset.id,
    });

    return view;
  }

  handleLocationSelected(location: IGirderSelectAble | null) {
    this.showNewCollectionDialog = false;

    if (location && location._modelType === "folder") {
      this.selectedFolderId = location._id;
      this.newCollectionName = this.defaultConfigurationName;
      this.showNewCollectionNameDialog = true;
    }
  }

  async createNewCollection() {
    if (!this.newCollectionName || !this.selectedFolderId || !this.dataset) {
      return;
    }

    try {
      // Create the configuration
      const config = await this.store.createConfiguration({
        name: this.newCollectionName,
        description: "",
        folderId: this.selectedFolderId,
      });

      if (config) {
        // Create the dataset view
        const view = await this.store.createDatasetView({
          configurationId: config.id,
          datasetId: this.dataset.id,
        });

        // Update the dataset views
        await this.updateDatasetViews();

        // Select the new view
        if (view) {
          this.selectedDatasetViewId = view.id;
        }
      }
    } catch (error) {
      logError("Error creating new collection:", error);
    } finally {
      // Reset the dialog state
      this.showNewCollectionNameDialog = false;
      this.selectedFolderId = null;
    }
  }

  get nameRules() {
    return [(v: string) => !!v || "Name is required"];
  }
}
</script>

<style lang="scss" scoped>
.important-field ::v-deep .v-label {
  font-size: 22px;
  font-weight: bold;
}

.button-bar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
}

.action-icon {
  cursor: pointer;
  font-size: 20px;
  padding: 4px;
  border-radius: 50%;
  transition: all 0.2s ease;

  &:hover {
    background-color: rgba(0, 0, 0, 0.05);
    transform: scale(1.1);
  }
}

.pulse-btn {
  animation: subtle-pulse 3s infinite ease-in-out;
  transition: all 0.3s ease;
  position: relative; /* Needed for the pseudo-element */
}

/* Use a pseudo-element for the pulsing effect to avoid affecting the button content */
.pulse-btn::after {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  border-radius: inherit;
  box-shadow: 0 0 0 0 rgba(76, 175, 80, 0.5);
  animation: subtle-pulse-shadow 3s infinite ease-in-out;
}

@keyframes subtle-pulse {
  0% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.03);
  }
  100% {
    transform: scale(1);
  }
}

@keyframes subtle-pulse-shadow {
  0% {
    box-shadow: 0 0 0 0 rgba(76, 175, 80, 0.5);
  }
  70% {
    box-shadow: 0 0 0 8px rgba(76, 175, 80, 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(76, 175, 80, 0);
  }
}

.selectable-list-item {
  cursor: pointer;

  &:hover {
    background-color: rgba(0, 0, 0, 0.05);
  }
}
</style>

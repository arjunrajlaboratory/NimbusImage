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
              <v-btn
                color="primary"
                small
                outlined
                class="mr-2"
                @click="showAddToProjectDialog = true"
                :disabled="!dataset"
              >
                <v-icon left>mdi-folder-star</v-icon>
                Add Dataset to Project...
              </v-btn>
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

    <!-- Add to Project Dialog -->
    <add-to-project-dialog
      v-if="dataset"
      v-model="showAddToProjectDialog"
      :dataset-id="dataset.id"
      :dataset-name="datasetName"
      @added="onAddedToProject"
    />
  </v-container>
</template>
<script setup lang="ts">
import { ref, computed, watch, onMounted, getCurrentInstance } from "vue";
import store from "@/store";
import girderResources from "@/store/girderResources";
import { IDatasetView } from "@/store/model";
import { IGirderItem, IGirderSelectAble } from "@/girder";
import { logError } from "@/utils/log";
import datasetMetadataImport from "@/store/datasetMetadataImport";
import GirderLocationChooser from "@/components/GirderLocationChooser.vue";
import AddToProjectDialog from "@/components/AddToProjectDialog.vue";

// Suppress unused import warnings — auto-registered in <script setup>
void GirderLocationChooser;
void AddToProjectDialog;

const vm = getCurrentInstance()!.proxy;

// Local state
const removeDatasetConfirm = ref(false);
const removeDatasetViewConfirm = ref(false);
const viewToRemove = ref<IDatasetView | null>(null);
const datasetViews = ref<IDatasetView[]>([]);
const configInfo = ref<{ [configurationId: string]: IGirderItem }>({});
const selectedDatasetViewId = ref<string | null>(null);
const defaultConfigurationName = ref("");
const showNewCollectionDialog = ref(false);
const showNewCollectionNameDialog = ref(false);
const showAddToProjectDialog = ref(false);
const newCollectionName = ref("");
const selectedFolderId = ref<string | null>(null);
const datasetParentId = ref<string | null>(null);
const annotationCount = ref<number | null>(null);
const connectionCount = ref<number | null>(null);
const propertyCount = ref<number | null>(null);
const propertyValueCount = ref<number | null>(null);

// Computed
const dataset = computed(() => store.dataset);
const datasetName = computed(() => dataset.value?.name || "");
const datasetId = computed(() => dataset.value?.id || "");

const datasetViewItems = computed(
  (): { datasetView: IDatasetView; configInfo: IGirderItem | undefined }[] =>
    datasetViews.value.map((datasetView) => ({
      datasetView,
      configInfo: configInfo.value[datasetView.configurationId],
    })),
);

const report = computed(() => [
  { name: "Dataset Name", value: datasetName.value },
  { name: "Dataset Description", value: dataset.value?.description || "" },
  { name: "Timepoints", value: dataset.value?.time?.length || "?" },
  { name: "XY Slices", value: dataset.value?.xy?.length || "?" },
  { name: "Z Slices", value: dataset.value?.z?.length || "?" },
  { name: "Channels", value: dataset.value?.channels?.length || "?" },
  { name: "Annotations", value: annotationCount.value ?? "Loading..." },
  { name: "Connections", value: connectionCount.value ?? "Loading..." },
  { name: "Properties", value: propertyCount.value ?? "Loading..." },
  { name: "Property Values", value: propertyValueCount.value ?? "Loading..." },
]);

const nameRules = computed(() => [(v: string) => !!v || "Name is required"]);

// Methods
function fetchConfigurationsInfo() {
  for (const datasetView of datasetViews.value) {
    if (!(datasetView.configurationId in configInfo.value)) {
      girderResources
        .getCollection(datasetView.configurationId)
        .then((item: IGirderItem | null) => {
          if (item) {
            configInfo.value[datasetView.configurationId] = item;
          }
        })
        .catch((error: unknown) => {
          logError(
            `Failed to fetch collection info for ${datasetView.configurationId}:`,
            error,
          );
          configInfo.value[datasetView.configurationId] = null as any;
        });
    }
  }

  if (selectedDatasetViewId.value) {
    const selectedViewExists = datasetViews.value.some(
      (view) => view.id === selectedDatasetViewId.value,
    );
    if (!selectedViewExists && datasetViews.value.length > 0) {
      selectedDatasetViewId.value = datasetViews.value[0].id;
    }
  } else if (datasetViews.value.length > 0 && !selectedDatasetViewId.value) {
    selectedDatasetViewId.value = datasetViews.value[0].id;
  }
}

async function fetchCounts() {
  if (!dataset.value) {
    annotationCount.value = null;
    connectionCount.value = null;
    propertyCount.value = null;
    propertyValueCount.value = null;
    return;
  }

  const dsId = dataset.value.id;

  const [ac, cc, pvc] = await Promise.all([
    store.annotationsAPI.getAnnotationCount(dsId),
    store.annotationsAPI.getConnectionCount(dsId),
    store.annotationsAPI.getPropertyValueCount(dsId),
  ]);

  annotationCount.value = ac;
  connectionCount.value = cc;
  propertyValueCount.value = pvc;

  await fetchPropertyCount();
}

async function fetchPropertyCount() {
  if (!selectedDatasetViewId.value) {
    propertyCount.value = null;
    return;
  }

  const selectedView = datasetViews.value.find(
    (v) => v.id === selectedDatasetViewId.value,
  );
  if (selectedView) {
    propertyCount.value = await store.propertiesAPI.getPropertyCount(
      selectedView.configurationId,
    );
  } else {
    propertyCount.value = null;
  }
}

async function updateDatasetViews() {
  if (dataset.value) {
    try {
      datasetViews.value = await store.api.findDatasetViews({
        datasetId: dataset.value.id,
      });
    } catch (error) {
      logError("Failed to fetch dataset views:", error);
      datasetViews.value = [];
    }
  } else {
    datasetViews.value = [];
  }
  return datasetViews.value;
}

function updateDefaultConfigurationName() {
  defaultConfigurationName.value =
    (datasetName.value || "Default") + " collection";
}

async function fetchDatasetParentFolder() {
  if (dataset.value) {
    const folder = await girderResources.getFolder(dataset.value.id);
    datasetParentId.value = folder?.parentId || null;
  } else {
    datasetParentId.value = null;
  }
}

function toRoute(datasetView: IDatasetView) {
  return {
    name: "datasetview",
    params: Object.assign({}, vm.$route.params, {
      datasetViewId: datasetView.id,
      datasetId: datasetView.datasetId,
      configurationId: datasetView.configurationId,
    }),
  };
}

function removeDataset() {
  store.deleteDataset(dataset.value!).then(() => {
    removeDatasetConfirm.value = false;
    vm.$router.push({ name: "root" });
  });
}

function openRemoveConfigurationDialog(datasetView: IDatasetView) {
  removeDatasetViewConfirm.value = true;
  viewToRemove.value = datasetView;
}

function closeRemoveConfigurationDialog() {
  removeDatasetViewConfirm.value = false;
  viewToRemove.value = null;
}

function removeDatasetView() {
  if (!viewToRemove.value) {
    return;
  }
  const isRemovingSelected =
    viewToRemove.value.id === selectedDatasetViewId.value;

  const promise = store.deleteDatasetView(viewToRemove.value);
  if (promise) {
    promise.then(() => {
      removeDatasetViewConfirm.value = false;
      viewToRemove.value = null;

      updateDatasetViews().then(() => {
        if (isRemovingSelected && datasetViews.value.length > 0) {
          selectedDatasetViewId.value = datasetViews.value[0].id;
        } else if (datasetViews.value.length === 0) {
          selectedDatasetViewId.value = null;
        }
      });
    });
  }
}

async function duplicateView(
  datasetView: IDatasetView,
  configurationFolder: IGirderSelectAble | null,
) {
  if (!dataset.value || configurationFolder?._modelType !== "folder") {
    return;
  }
  const baseConfig = await girderResources.getConfiguration(
    datasetView.configurationId,
  );
  if (!baseConfig) {
    return;
  }
  const config = await store.api.duplicateConfiguration(
    baseConfig,
    configurationFolder._id,
  );
  await store.createDatasetView({
    configurationId: config.id,
    datasetId: dataset.value.id,
  });

  vm.$router.push({
    name: "configuration",
    params: Object.assign({ configurationId: config.id }, vm.$route.params),
  });
}

async function goToDefaultView() {
  if (datasetViews.value.length > 0) {
    const selectedView = selectedDatasetViewId.value
      ? datasetViews.value.find((v) => v.id === selectedDatasetViewId.value)
      : datasetViews.value[0];

    if (selectedView) {
      vm.$router.push(toRoute(selectedView));
      return;
    }
  }

  const defaultView = await createDefaultView();
  if (defaultView) {
    vm.$router.push(toRoute(defaultView));
  }
}

async function createDefaultView() {
  if (!dataset.value) {
    return;
  }

  const datasetFolder = await girderResources.getFolder(dataset.value.id);
  if (!datasetFolder?.parentId) {
    return;
  }

  if (
    datasetMetadataImport.hasCollectionData &&
    datasetMetadataImport.collectionData
  ) {
    try {
      const config = await store.api.createConfigurationFromBase(
        defaultConfigurationName.value,
        "",
        datasetFolder.parentId,
        datasetMetadataImport.collectionData,
      );

      datasetMetadataImport.clearCollectionFile();

      const view = await store.createDatasetView({
        configurationId: config.id,
        datasetId: dataset.value.id,
      });

      return view;
    } catch (error) {
      logError("Failed to use downloadedcollection data:", error);
    }
  }

  const config = await store.createConfiguration({
    name: defaultConfigurationName.value,
    description: "",
    folderId: datasetFolder.parentId,
  });

  if (!config) {
    return;
  }

  const view = await store.createDatasetView({
    configurationId: config.id,
    datasetId: dataset.value.id,
  });

  return view;
}

function handleLocationSelected(location: IGirderSelectAble | null) {
  showNewCollectionDialog.value = false;

  if (location && location._modelType === "folder") {
    selectedFolderId.value = location._id;
    newCollectionName.value = defaultConfigurationName.value;
    showNewCollectionNameDialog.value = true;
  }
}

async function createNewCollection() {
  if (!newCollectionName.value || !selectedFolderId.value || !dataset.value) {
    return;
  }

  try {
    const config = await store.createConfiguration({
      name: newCollectionName.value,
      description: "",
      folderId: selectedFolderId.value,
    });

    if (config) {
      const view = await store.createDatasetView({
        configurationId: config.id,
        datasetId: dataset.value.id,
      });

      await updateDatasetViews();

      if (view) {
        selectedDatasetViewId.value = view.id;
      }
    }
  } catch (error) {
    logError("Error creating new collection:", error);
  } finally {
    showNewCollectionNameDialog.value = false;
    selectedFolderId.value = null;
  }
}

function onAddedToProject() {
  showAddToProjectDialog.value = false;
}

// Watchers
watch(dataset, () => {
  fetchCounts();
});

watch(dataset, () => {
  updateDatasetViews();
});

watch(dataset, () => {
  fetchDatasetParentFolder();
});

watch(datasetName, () => {
  updateDefaultConfigurationName();
});

watch(selectedDatasetViewId, () => {
  fetchPropertyCount();
});

watch(datasetViews, () => {
  fetchConfigurationsInfo();
});

// Lifecycle
onMounted(() => {
  updateDatasetViews();
  updateDefaultConfigurationName();
  fetchDatasetParentFolder();
  fetchCounts();
});

defineExpose({
  dataset,
  datasetName,
  datasetId,
  datasetViewItems,
  report,
  nameRules,
  removeDatasetConfirm,
  removeDatasetViewConfirm,
  viewToRemove,
  datasetViews,
  configInfo,
  selectedDatasetViewId,
  defaultConfigurationName,
  showNewCollectionDialog,
  showNewCollectionNameDialog,
  showAddToProjectDialog,
  newCollectionName,
  selectedFolderId,
  datasetParentId,
  annotationCount,
  connectionCount,
  propertyCount,
  propertyValueCount,
  fetchConfigurationsInfo,
  fetchCounts,
  fetchPropertyCount,
  updateDatasetViews,
  updateDefaultConfigurationName,
  fetchDatasetParentFolder,
  toRoute,
  removeDataset,
  openRemoveConfigurationDialog,
  closeRemoveConfigurationDialog,
  removeDatasetView,
  duplicateView,
  goToDefaultView,
  createDefaultView,
  handleLocationSelected,
  createNewCollection,
  onAddedToProject,
});
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

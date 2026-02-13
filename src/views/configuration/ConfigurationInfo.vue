<template>
  <v-container>
    <alert-dialog ref="alert" />
    <v-container class="d-flex">
      <v-spacer />
      <v-btn
        color="primary"
        class="mr-2"
        @click="showAddToProjectDialog = true"
        :disabled="!configuration"
      >
        <v-icon left>mdi-folder-star</v-icon>
        Add Collection to Project...
      </v-btn>
      <v-dialog v-model="removeConfirm" max-width="33vw">
        <template #activator="{ on }">
          <v-btn color="red" v-on="on" :disabled="!configuration">
            <v-icon left>mdi-close</v-icon>
            Delete Collection
          </v-btn>
        </template>
        <v-card>
          <v-card-title>
            Are you sure you want to delete "{{ name }}" forever?
          </v-card-title>
          <v-card-actions class="button-bar">
            <v-btn @click="removeConfirm = false">Cancel</v-btn>
            <v-btn @click="remove" color="warning">Remove</v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>
    </v-container>
    <v-text-field
      v-model="nameInput"
      label="Name"
      :disabled="!configuration"
      @blur="onNameBlur"
      @keyup.enter="onNameEnter"
    />
    <v-textarea :value="description" label="Description" readonly />
    <v-card class="mb-4">
      <v-card-title> Datasets </v-card-title>
      <v-card-text>
        <v-dialog
          v-model="removeDatasetViewConfirm"
          max-width="33vw"
          v-if="viewToRemove"
        >
          <v-card>
            <v-card-title>
              Are you sure you want to remove the view for dataset "{{
                datasetInfoCache[viewToRemove.datasetId]
                  ? datasetInfoCache[viewToRemove.datasetId].name
                  : "Unnamed dataset"
              }}"?
            </v-card-title>
            <v-card-actions class="button-bar">
              <v-btn @click="closeRemoveDatasetDialog()"> Cancel </v-btn>
              <v-btn @click="removeDatasetView()" color="warning">
                Remove
              </v-btn>
            </v-card-actions>
          </v-card>
        </v-dialog>
        <v-list>
          <v-list-item v-for="d in datasetViewItems" :key="d.datasetView.id">
            <v-list-item-content>
              <v-list-item-title>
                {{ d.datasetInfo ? d.datasetInfo.name : "Unnamed dataset" }}
              </v-list-item-title>
              <v-list-item-subtitle>
                {{
                  d.datasetInfo ? d.datasetInfo.description : "No description"
                }}
              </v-list-item-subtitle>
              <div
                v-if="
                  datasetCompatibilityWarnings[d.datasetView.datasetId] &&
                  datasetCompatibilityWarnings[d.datasetView.datasetId].length >
                    0
                "
                class="compatibility-warnings mt-1"
              >
                <v-chip
                  v-for="(warning, index) in datasetCompatibilityWarnings[
                    d.datasetView.datasetId
                  ]"
                  :key="index"
                  small
                  color="warning"
                  text-color="white"
                  class="mr-1 mb-1"
                >
                  <v-icon small left>mdi-alert</v-icon>
                  {{ warning }}
                </v-chip>
              </div>
            </v-list-item-content>
            <v-list-item-action>
              <span class="button-bar">
                <v-btn
                  color="warning"
                  v-on:click.stop="openRemoveDatasetDialog(d.datasetView)"
                >
                  <v-icon left>mdi-close</v-icon>remove
                </v-btn>
                <v-btn color="primary" :to="toRoute(d.datasetView)">
                  <v-icon left>mdi-eye</v-icon>
                  view
                </v-btn>
              </span>
            </v-list-item-action>
          </v-list-item>
        </v-list>
      </v-card-text>
      <v-card-actions class="d-block">
        <v-divider />
        <div class="clickable-flex pa-2 body" @click="addDatasetDialog = true">
          <v-icon class="pr-2" color="primary">mdi-plus-circle</v-icon>
          Add dataset to current collection
        </div>
        <v-dialog
          content-class="smart-overflow"
          v-model="addDatasetDialog"
          width="60%"
        >
          <add-dataset-to-collection
            v-if="configuration"
            :collection="configuration"
            @addedDatasets="addedDatasets"
            @done="addDatasetDialog = false"
            @warning="openAlert({ type: 'warning', message: $event })"
            @error="openAlert({ type: 'error', message: $event })"
          />
        </v-dialog>
      </v-card-actions>
    </v-card>
    <v-card class="mb-4">
      <v-card-title> Layers </v-card-title>
      <v-card-text>
        <v-list two-line>
          <v-list-item v-for="l in layers" :key="l.name">
            <v-list-item-avatar>
              <v-icon :color="l.color">mdi-circle</v-icon>
            </v-list-item-avatar>
            <v-list-item-content>
              <v-list-item-title>
                {{ l.name }}{{ !l.visible ? "(hidden)" : "" }}
              </v-list-item-title>
              <v-list-item-subtitle>
                Channel: <code class="code">{{ l.channel }}</code> Z-Slice:
                <code class="code">{{ toSlice(l.z) }}</code> Time-Slice:
                <code class="code">{{ toSlice(l.time) }}</code>
              </v-list-item-subtitle>
            </v-list-item-content>
          </v-list-item>
        </v-list>
      </v-card-text>
    </v-card>
    <v-card class="mb-4">
      <v-card-title> Scale </v-card-title>
      <v-card-text>
        <scale-settings :configuration-only="true" />
      </v-card-text>
    </v-card>

    <add-collection-to-project-dialog
      v-if="configuration"
      v-model="showAddToProjectDialog"
      :collection-id="configuration.id"
      :collection-name="name"
      @added="onAddedToProject"
    />
  </v-container>
</template>
<script setup lang="ts">
import { ref, computed, watch, onMounted, getCurrentInstance } from "vue";
import isEqual from "lodash/isEqual";
import store from "@/store";
import girderResources from "@/store/girderResources";
import { IDatasetView, IDisplaySlice, areCompatibles } from "@/store/model";
import { getDatasetCompatibility } from "@/store/GirderAPI";
import { IGirderFolder } from "@/girder";
import ScaleSettings from "@/components/ScaleSettings.vue";
import AddDatasetToCollection from "@/components/AddDatasetToCollection.vue";
import AlertDialog, { IAlert } from "@/components/AlertDialog.vue";
import AddCollectionToProjectDialog from "@/components/AddCollectionToProjectDialog.vue";

// Suppress unused import warnings — auto-registered in <script setup>
void ScaleSettings;
void AddDatasetToCollection;
void AlertDialog;
void AddCollectionToProjectDialog;

const vm = getCurrentInstance()!.proxy;

// Template ref
const alert = ref<any>(null);

// Local state
const removeConfirm = ref(false);
const removeDatasetViewConfirm = ref(false);
const viewToRemove = ref<IDatasetView | null>(null);
const datasetViews = ref<IDatasetView[]>([]);
const datasetInfoCache = ref<{ [datasetId: string]: IGirderFolder }>({});
const datasetCompatibilityWarnings = ref<{ [datasetId: string]: string[] }>({});
const addDatasetDialog = ref(false);
const showAddToProjectDialog = ref(false);
const nameInput = ref("");

// Computed
const name = computed(() => {
  if (!store.configuration) return "";
  const cached = girderResources.watchCollection(store.configuration.id);
  return cached?.name ?? store.configuration.name;
});

const description = computed(() => {
  return store.configuration ? store.configuration.description : "";
});

const layers = computed(() => {
  return store.layers;
});

const configuration = computed(() => {
  return store.configuration;
});

const datasetViewItems = computed(
  (): { datasetView: IDatasetView; datasetInfo: IGirderFolder | undefined }[] =>
    datasetViews.value.map((datasetView) => ({
      datasetView,
      datasetInfo: datasetInfoCache.value[datasetView.datasetId],
    })),
);

// Methods
function openAlert(alertData: IAlert) {
  addDatasetDialog.value = false;
  alert.value.openAlert(alertData);
}

function addedDatasets() {
  addDatasetDialog.value = false;
  updateConfigurationViews();
}

async function updateConfigurationViews() {
  if (configuration.value) {
    datasetViews.value = await store.api.findDatasetViews({
      configurationId: configuration.value.id,
    });
  } else {
    datasetViews.value = [];
  }
  return datasetViews.value;
}

function onNameBlur() {
  tryRename();
}

function onNameEnter() {
  tryRename();
}

function tryRename() {
  const trimmed = (nameInput.value || "").trim();
  if (!store.configuration) return;
  if (trimmed.length === 0 || trimmed === name.value) return;
  store.renameConfiguration(trimmed);
}

function fetchDatasetsInfo() {
  for (const datasetView of datasetViews.value) {
    girderResources.getFolder(datasetView.datasetId).then((folder) => {
      if (folder) {
        datasetInfoCache.value[datasetView.datasetId] = folder;
      }
    });
  }
  checkDatasetsCompatibility();
}

async function checkDatasetsCompatibility() {
  if (!configuration.value) {
    return;
  }
  const configCompat = configuration.value.compatibility;
  if (!configCompat) {
    return;
  }

  // Clear old warnings
  datasetCompatibilityWarnings.value = {};

  for (const datasetView of datasetViews.value) {
    try {
      const dataset = await girderResources.getDataset({
        id: datasetView.datasetId,
      });
      if (!dataset) {
        continue;
      }

      const datasetCompat = getDatasetCompatibility(dataset);
      if (!areCompatibles(configCompat, datasetCompat)) {
        const warnings: string[] = [];

        if (configCompat.xyDimensions !== datasetCompat.xyDimensions) {
          warnings.push(
            `XY: Dataset has ${datasetCompat.xyDimensions}, collection expects ${configCompat.xyDimensions}`,
          );
        }
        if (configCompat.zDimensions !== datasetCompat.zDimensions) {
          warnings.push(
            `Z: Dataset has ${datasetCompat.zDimensions}, collection expects ${configCompat.zDimensions}`,
          );
        }
        if (configCompat.tDimensions !== datasetCompat.tDimensions) {
          warnings.push(
            `T: Dataset has ${datasetCompat.tDimensions}, collection expects ${configCompat.tDimensions}`,
          );
        }

        // Check channel differences using isEqual (same as areCompatibles)
        if (!isEqual(configCompat.channels, datasetCompat.channels)) {
          const configChannelCount = Object.keys(configCompat.channels).length;
          const datasetChannelCount = Object.keys(
            datasetCompat.channels,
          ).length;

          if (configChannelCount !== datasetChannelCount) {
            warnings.push(
              `Channels: Dataset has ${datasetChannelCount}, collection expects ${configChannelCount}`,
            );
          } else {
            const datasetNames = Object.values(datasetCompat.channels).join(
              ", ",
            );
            const configNames = Object.values(configCompat.channels).join(", ");
            warnings.push(
              `Channels: Dataset has [${datasetNames}], collection expects [${configNames}]`,
            );
          }
        }

        if (warnings.length > 0) {
          datasetCompatibilityWarnings.value[datasetView.datasetId] = warnings;
        }
      }
    } catch (err) {
      // Silently skip datasets that fail to load
    }
  }
}

function toRoute(datasetView: IDatasetView) {
  return {
    name: "datasetview",
    params: Object.assign({}, vm.$route.params, {
      datasetViewId: datasetView.id,
    }),
  };
}

function openRemoveDatasetDialog(datasetView: IDatasetView) {
  removeDatasetViewConfirm.value = true;
  viewToRemove.value = datasetView;
}

function closeRemoveDatasetDialog() {
  removeDatasetViewConfirm.value = false;
  viewToRemove.value = null;
}

function removeDatasetView() {
  if (!viewToRemove.value) {
    return;
  }
  const promise = store.deleteDatasetView(viewToRemove.value);
  if (promise) {
    promise.then(() => {
      removeDatasetViewConfirm.value = false;
      viewToRemove.value = null;
      updateConfigurationViews();
    });
  }
}

function toSlice(slice: IDisplaySlice) {
  switch (slice.type) {
    case "constant":
      return String(slice.value);
    case "max-merge":
      return "Max Merge";
    case "offset":
      return `Offset by ${slice.value}`;
    default:
      return "Current";
  }
}

function remove() {
  store.deleteConfiguration(store.configuration!).then(() => {
    removeConfirm.value = false;
    vm.$router.back();
  });
}

function onAddedToProject() {
  showAddToProjectDialog.value = false;
}

// Watchers
watch(configuration, () => {
  updateConfigurationViews();
});

watch(name, () => {
  nameInput.value = name.value;
});

watch(datasetViews, () => {
  fetchDatasetsInfo();
});

// Lifecycle
onMounted(() => {
  updateConfigurationViews();
  nameInput.value = name.value;
});

defineExpose({
  name,
  description,
  layers,
  configuration,
  datasetViewItems,
  removeConfirm,
  removeDatasetViewConfirm,
  viewToRemove,
  datasetViews,
  datasetInfoCache,
  datasetCompatibilityWarnings,
  addDatasetDialog,
  showAddToProjectDialog,
  nameInput,
  openAlert,
  addedDatasets,
  updateConfigurationViews,
  tryRename,
  fetchDatasetsInfo,
  checkDatasetsCompatibility,
  toRoute,
  openRemoveDatasetDialog,
  closeRemoveDatasetDialog,
  removeDatasetView,
  toSlice,
  remove,
  onAddedToProject,
  onNameBlur,
  onNameEnter,
});
</script>

<style lang="scss" scoped>
.code {
  margin: 0 1em 0 0.5em;
}

.compatibility-warnings {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
}
</style>

<style lang="scss">
.clickable-flex {
  display: flex;
  align-items: center;
  cursor: pointer;
}
</style>

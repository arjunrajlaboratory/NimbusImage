<template>
  <v-card class="smart-overflow">
    <v-card-title class="mb-4">
      <span class="text--secondary">Adding dataset to collection:</span>
      <span class="text--primary">{{ collection.name }}</span>
    </v-card-title>
    <v-card-text class="smart-overflow">
      <v-radio-group v-model="addDatasetOptionType">
        <v-radio
          label="Add an existing dataset to the current collection"
          value="add"
        />
        <v-radio
          label="Upload new dataset and add to current collection"
          value="upload"
        />
      </v-radio-group>
      <template v-if="option.type == 'add'">
        <custom-file-manager
          title="Choose a dataset or a folder of datasets to add in the current collection"
          class="smart-overflow"
          :breadcrumb="true"
          :selectable="true"
          @selected="selectAddDatasetFolder"
          :location.sync="option.datasetSelectLocation"
          :initial-items-per-page="-1"
          :items-per-page-options="[-1]"
          :menu-enabled="false"
          :more-chips="false"
          :clickable-chips="false"
        />
        <v-alert
          v-for="(warning, iWarning) in option.warnings"
          :key="iWarning + '-warning'"
          type="warning"
          class="my-2"
          dense
        >
          {{ warning }}
        </v-alert>
        <v-alert
          v-if="option.datasets.length > 0"
          type="success"
          class="my-2"
          dense
        >
          Selected {{ option.datasets.length }} dataset(s):
          <v-divider />
          <div
            v-for="dataset in option.datasets"
            :key="'selected-' + dataset.id"
          >
            {{ dataset.name }}
            <v-divider />
          </div>
        </v-alert>
        <v-card-actions class="ma-2">
          <v-spacer />
          <v-btn
            color="green"
            :disabled="!canAddDatasetToCollection"
            @click="addDatasetToCollection"
          >
            Add dataset
          </v-btn>
        </v-card-actions>
      </template>
      <template v-if="option.type == 'upload'">
        <new-dataset
          v-if="uploadLocation"
          @datasetUploaded="addDatasetToCollectionUploaded"
          :autoMultiConfig="false"
          :initialUploadLocation="uploadLocation"
        />
        <div v-else class="text-center my-4">
          <v-progress-circular indeterminate />
          <div class="mt-2">Loading upload location...</div>
        </div>
        <div class="d-flex justify-end mt-2">
          <v-simple-checkbox v-model="option.editVariables" dense />
          Review variables
        </div>
        <template v-if="option.configuring && option.uploadedDatasetId">
          <multi-source-configuration
            ref="configurationRef"
            :datasetId="option.uploadedDatasetId"
            :autoDatasetRoute="false"
            @log="option.configurationLogs = $event"
            @generatedJson="addDatasetConfigurationDone"
            :class="{ 'd-none': !option.editVariables }"
          />
          <div class="title mb-2">Configuring the dataset</div>
          <v-progress-circular indeterminate />
          <div class="code-container" v-if="option.configurationLogs">
            <code class="code-block">
              {{ option.configurationLogs }}
            </code>
          </div>
        </template>
      </template>
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, nextTick } from "vue";

import { getDatasetCompatibility } from "@/store/GirderAPI";
import {
  IDataset,
  IDatasetConfiguration,
  IDatasetView,
  areCompatibles,
} from "@/store/model";
import girderResources from "@/store/girderResources";
import store from "@/store";

import { isDatasetFolder } from "@/utils/girderSelectable";
import { logError } from "@/utils/log";
import { IGirderSelectAble, IGirderLocation } from "@/girder";

import CustomFileManager from "@/components/CustomFileManager.vue";
import MultiSourceConfiguration from "@/views/dataset/MultiSourceConfiguration.vue";
import NewDataset from "@/views/dataset/NewDataset.vue";

type TAddDatasetOption =
  | {
      type: "upload";
      editVariables: boolean;
      configuring: boolean;
      configurationLogs: string;
      uploadedDatasetId: string | null;
    }
  | {
      type: "add";
      datasets: IDataset[];
      warnings: string[];
      datasetSelectLocation: IGirderLocation | null;
    };

function defaultDatasetUploadOption(): TAddDatasetOption {
  return {
    type: "upload",
    editVariables: false,
    configuring: false,
    configurationLogs: "",
    uploadedDatasetId: null,
  };
}

function defaultDatasetAddOption(): TAddDatasetOption {
  return {
    type: "add",
    datasets: [],
    warnings: [],
    datasetSelectLocation: null,
  };
}

const props = defineProps<{
  collection: IDatasetConfiguration;
}>();

const emit = defineEmits<{
  (e: "error", msg: string): void;
  (e: "done"): void;
  (e: "warning", msg: string): void;
  (e: "addedDatasets", datasetIds: string[], datasetViews: any[]): void;
}>();

const option = ref<TAddDatasetOption>(defaultDatasetUploadOption());
const uploadLocation = ref<IGirderLocation | null>(null);
const configurationRef = ref<InstanceType<
  typeof MultiSourceConfiguration
> | null>(null);

onMounted(async () => {
  try {
    uploadLocation.value = await store.api.getUserPrivateFolder();
  } catch (error) {
    uploadLocation.value = store.girderUser as IGirderLocation | null;
  }
});

const addDatasetOptionType = computed({
  get: (): TAddDatasetOption["type"] => option.value.type,
  set: (type: TAddDatasetOption["type"]) => {
    switch (type) {
      case "add":
        option.value = defaultDatasetAddOption();
        break;
      case "upload":
        option.value = defaultDatasetUploadOption();
        break;
    }
  },
});

watch(
  () => props.collection,
  () => {
    option.value = defaultDatasetUploadOption();
  },
);

async function selectAddDatasetFolder(selectedLocations: IGirderSelectAble[]) {
  const opt = option.value;
  if (opt.type !== "add") {
    return;
  }
  if (selectedLocations.length === 0 || !props.collection) {
    opt.datasets = [];
    opt.warnings = [];
    return;
  }

  const currentWarnings: string[] = [];

  const selectedDatasets: IDataset[] = [];
  await Promise.all(
    selectedLocations.map(async (location) => {
      if (!isDatasetFolder(location)) {
        return;
      }
      const dataset = await girderResources.getDataset({
        id: location._id,
      });
      if (!dataset) {
        return;
      }
      selectedDatasets.push(dataset);
    }),
  );

  if (selectedDatasets.length !== selectedLocations.length) {
    const nNotDataset = selectedLocations.length - selectedDatasets.length;
    currentWarnings.push(nNotDataset + " selected items are not datasests");
  }

  if (selectedDatasets.length === 0) {
    opt.datasets = [];
    opt.warnings = currentWarnings;
    return;
  }

  const configCompat = props.collection.compatibility;
  const configViews = await store.api.findDatasetViews({
    configurationId: props.collection.id,
  });
  const excludeDatasetIds = new Set(
    configViews.map((view: IDatasetView) => view.datasetId),
  );
  const compatibleDatasets = selectedDatasets.filter(
    (dataset) =>
      !excludeDatasetIds.has(dataset.id) &&
      areCompatibles(configCompat, getDatasetCompatibility(dataset)),
  );

  if (compatibleDatasets.length !== selectedDatasets.length) {
    const nNotCompatible = selectedDatasets.length - compatibleDatasets.length;
    currentWarnings.push(
      nNotCompatible +
        " selected items are not compatible with the current configuration",
    );
  }

  opt.datasets = compatibleDatasets;
  opt.warnings = currentWarnings;
}

const canAddDatasetToCollection = computed<boolean>(() => {
  if (props.collection === null) {
    return false;
  }
  switch (option.value.type) {
    case "add":
      return option.value.datasets.length > 0;
    case "upload":
      return false;
  }
});

async function addDatasetToCollectionUploaded(datasetId: string) {
  if (option.value.type !== "upload") {
    return;
  }
  option.value.uploadedDatasetId = datasetId;
  option.value.configurationLogs = "";
  option.value.configuring = true;

  if (!option.value.editVariables) {
    await nextTick();
    const config = configurationRef.value;
    if (!config) {
      logError(
        "MultiSourceConfiguration component not mounted during configuration of new dataset",
      );
      option.value.editVariables = true;
      return;
    }
    await (config.initialized || config.initialize());
    await config.submit();
  }
}

async function addDatasetConfigurationDone(jsonId: string | null) {
  if (option.value.type !== "upload" || !option.value.uploadedDatasetId) {
    return;
  }
  option.value.configuring = false;
  const datasetId = option.value.uploadedDatasetId;
  if (!jsonId) {
    logError("Failed to generate JSON during configuration of new dataset");
    option.value.editVariables = true;
    return;
  }
  const configCompat = props.collection?.compatibility;
  if (!configCompat) {
    emit(
      "error",
      "DatasetConfiguration missing after multi source configuration of dataset",
    );
    emit("done");
    return;
  }
  const dataset = await girderResources.getDataset({ id: datasetId });
  if (!dataset) {
    emit(
      "error",
      "Dataset missing after multi source configuration of dataset",
    );
    emit("done");
    return;
  }
  const datasetCompat = getDatasetCompatibility(dataset);
  if (!areCompatibles(configCompat, datasetCompat)) {
    emit("warning", "Incompatible dataset uploaded");
    emit("done");
    return;
  }
  await store.setSelectedDataset(datasetId);
  addDatasetToCollection();
}

async function addDatasetToCollection() {
  if (!props.collection) {
    return;
  }
  const configurationId = props.collection.id;
  const datasetIds: string[] = [];

  switch (option.value.type) {
    case "add":
      option.value.datasets.forEach((d) => datasetIds.push(d.id));
      break;
    case "upload":
      datasetIds.push(option.value.uploadedDatasetId!);
      break;
  }

  const promises = datasetIds.map((datasetId) =>
    store.createDatasetView({
      datasetId,
      configurationId,
    }),
  );
  const datasetViews = await Promise.all(promises);

  emit("addedDatasets", datasetIds, datasetViews);

  option.value = defaultDatasetUploadOption();
}

defineExpose({
  option,
  uploadLocation,
  configurationRef,
  addDatasetOptionType,
  canAddDatasetToCollection,
  selectAddDatasetFolder,
  addDatasetToCollectionUploaded,
  addDatasetConfigurationDone,
  addDatasetToCollection,
});
</script>

<style lang="scss">
.smart-overflow {
  display: flex;
  flex-direction: column;
  overflow: auto;
  min-height: 0;
  flex: 1;
}
</style>

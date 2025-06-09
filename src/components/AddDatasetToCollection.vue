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
        <template v-if="option.configuring">
          <multi-source-configuration
            ref="configuration"
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

<script lang="ts">
import { Vue, Component, Prop, Watch } from "vue-property-decorator";

import { getDatasetCompatibility } from "@/store/GirderAPI";
import { IDataset, IDatasetConfiguration, areCompatibles } from "@/store/model";
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
      // Enable navigation in the component
      datasetSelectLocation: IGirderSelectAble | null;
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

@Component({
  components: { CustomFileManager, MultiSourceConfiguration, NewDataset },
})
export default class AddDatasetToCollection extends Vue {
  readonly girderResources = girderResources;
  readonly store = store;

  @Prop({ required: true })
  collection!: IDatasetConfiguration;

  option: TAddDatasetOption = defaultDatasetUploadOption();
  uploadLocation: IGirderLocation | null = null;

  $refs!: {
    configuration?: MultiSourceConfiguration;
  };

  async mounted() {
    try {
      this.uploadLocation = await this.store.api.getUserPrivateFolder();
    } catch (error) {
      this.uploadLocation = this.store.girderUser;
    }
  }

  get addDatasetOptionType(): TAddDatasetOption["type"] {
    return this.option.type;
  }

  set addDatasetOptionType(type: TAddDatasetOption["type"]) {
    switch (type) {
      case "add":
        this.option = defaultDatasetAddOption();
        break;
      case "upload":
        this.option = defaultDatasetUploadOption();
        break;
    }
  }

  @Watch("collection")
  async collectionUpdated() {
    this.option = defaultDatasetUploadOption();
  }

  async selectAddDatasetFolder(selectedLocations: IGirderSelectAble[]) {
    const option = this.option;
    if (option.type !== "add") {
      return;
    }
    if (selectedLocations.length === 0 || !this.collection) {
      option.datasets = [];
      option.warnings = [];
      return;
    }

    const currentWarnings: string[] = [];

    // Find selected items that are datasets
    const selectedDatasets: IDataset[] = [];
    await Promise.all(
      selectedLocations.map(async (location) => {
        if (!isDatasetFolder(location)) {
          return;
        }
        const dataset = await this.girderResources.getDataset({
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

    // Early return if no selected dataset
    if (selectedDatasets.length === 0) {
      option.datasets = [];
      option.warnings = currentWarnings;
      return;
    }

    // Filter compatible datasets
    const configCompat = this.collection.compatibility;
    const configViews = await this.store.api.findDatasetViews({
      configurationId: this.collection.id,
    });
    const excludeDatasetIds = new Set(
      configViews.map((view) => view.datasetId),
    );
    const compatibleDatasets = selectedDatasets.filter(
      (dataset) =>
        !excludeDatasetIds.has(dataset.id) &&
        areCompatibles(configCompat, getDatasetCompatibility(dataset)),
    );

    if (compatibleDatasets.length !== selectedDatasets.length) {
      const nNotCompatible =
        selectedDatasets.length - compatibleDatasets.length;
      currentWarnings.push(
        nNotCompatible +
          " selected items are not compatible with the current configuration",
      );
    }

    // Return the dataset and warnings
    option.datasets = compatibleDatasets;
    option.warnings = currentWarnings;
  }

  get canAddDatasetToCollection(): boolean {
    if (this.collection === null) {
      return false;
    }
    switch (this.option.type) {
      case "add":
        return this.option.datasets.length > 0;
      case "upload":
        return false;
    }
  }

  async addDatasetToCollectionUploaded(datasetId: string) {
    if (this.option.type !== "upload") {
      return;
    }
    this.option.uploadedDatasetId = datasetId;
    this.option.configurationLogs = "";
    this.option.configuring = true;

    // Automatic generation of the JSON
    if (!this.option.editVariables) {
      await Vue.nextTick();
      const config = this.$refs.configuration;
      if (!config) {
        logError(
          "MultiSourceConfiguration component not mounted during configuration of new dataset",
        );
        this.option.editVariables = true;
        return;
      }
      // Ensure that the component is initialized
      await (config.initialized || config.initialize());
      await config.submit();
    }
  }

  async addDatasetConfigurationDone(jsonId: string | null) {
    if (this.option.type !== "upload" || !this.option.uploadedDatasetId) {
      return;
    }
    this.option.configuring = false;
    const datasetId = this.option.uploadedDatasetId;
    if (!jsonId) {
      logError("Failed to generate JSON during configuration of new dataset");
      this.option.editVariables = true;
      return;
    }
    // Check if dataset is compatible with configuration
    const configCompat = this.collection?.compatibility;
    if (!configCompat) {
      this.$emit(
        "error",
        "DatasetConfiguration missing after multi source configuration of dataset",
      );
      this.$emit("done");
      return;
    }
    const dataset = await this.girderResources.getDataset({ id: datasetId });
    if (!dataset) {
      this.$emit(
        "error",
        "Dataset missing after multi source configuration of dataset",
      );
      this.$emit("done");
      return;
    }
    const datasetCompat = getDatasetCompatibility(dataset);
    if (!areCompatibles(configCompat, datasetCompat)) {
      this.$emit("warning", "Incompatible dataset uploaded");
      this.$emit("done");
      return;
    }
    // Set the dataset now that multi-source is available
    await this.store.setSelectedDataset(datasetId);
    this.addDatasetToCollection();
  }

  async addDatasetToCollection() {
    if (!this.collection) {
      return;
    }
    const configurationId = this.collection.id;
    const datasetIds: string[] = [];

    switch (this.option.type) {
      case "add":
        this.option.datasets.forEach((d) => datasetIds.push(d.id));
        break;
      case "upload":
        datasetIds.push(this.option.uploadedDatasetId!);
        break;
    }

    const promises = datasetIds.map((datasetId) =>
      this.store.createDatasetView({
        datasetId,
        configurationId,
      }),
    );
    const datasetViews = await Promise.all(promises);

    this.$emit("addedDatasets", datasetIds, datasetViews);

    this.option = defaultDatasetUploadOption();
  }
}
</script>

<style lang="scss">
.smart-overflow {
  display: flex;
  flex-direction: column;
  overflow: auto;
}
</style>

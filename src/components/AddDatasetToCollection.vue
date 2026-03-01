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
        <v-radio
          label="Upload multiple files as separate datasets"
          value="batch"
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
      <template v-if="option.type == 'batch'">
        <!-- File selection -->
        <v-card
          outlined
          class="mb-4 batch-file-card"
          @click="openBatchFileSelector"
          @dragenter.prevent="batchDragging = true"
          @dragleave.prevent="batchDragging = false"
          @dragover.prevent
          @drop.prevent="handleBatchDrop"
        >
          <v-card-text
            class="d-flex flex-column align-center justify-center"
            style="min-height: 120px"
          >
            <v-icon size="48" color="primary" class="mb-2">
              {{ batchDragging ? "mdi-file-move" : "mdi-file-multiple" }}
            </v-icon>
            <div class="text-body-2">
              {{
                option.pendingFiles.length > 0
                  ? option.pendingFiles.length +
                    " file(s) selected - click to change"
                  : "Click or drag files here to select"
              }}
            </div>
          </v-card-text>
        </v-card>
        <input
          type="file"
          ref="batchFileInput"
          multiple
          style="display: none"
          @change="handleBatchFileSelect"
        />

        <!-- Per-file dataset names -->
        <v-card v-if="option.pendingFiles.length > 0" outlined class="mb-4">
          <v-card-subtitle>
            Each file will become a separate dataset ({{
              option.pendingFiles.length
            }}
            files):
            <v-progress-circular
              v-if="option.validatingNames"
              indeterminate
              size="16"
              width="2"
              class="ml-2"
            />
          </v-card-subtitle>
          <v-list dense>
            <v-list-item v-for="(file, idx) in option.pendingFiles" :key="idx">
              <v-list-item-icon>
                <v-icon
                  small
                  :color="option.nameConflicts.includes(idx) ? 'error' : ''"
                >
                  {{
                    option.nameConflicts.includes(idx)
                      ? "mdi-alert-circle"
                      : "mdi-file"
                  }}
                </v-icon>
              </v-list-item-icon>
              <v-list-item-content>
                <v-text-field
                  v-model="option.datasetNames[idx]"
                  :error="option.nameConflicts.includes(idx)"
                  :error-messages="getBatchNameError(idx)"
                  dense
                  hide-details="auto"
                  @input="validateBatchNamesDebounced"
                />
                <v-list-item-subtitle class="text--secondary mt-1">
                  {{ file.name }}
                </v-list-item-subtitle>
              </v-list-item-content>
            </v-list-item>
          </v-list>
        </v-card>

        <!-- Location chooser -->
        <v-card v-if="option.pendingFiles.length > 0" class="mb-4">
          <v-card-title class="text-subtitle-1 pa-3">
            Upload location:
          </v-card-title>
          <v-card-text class="pt-0">
            <girder-location-chooser
              v-model="batchLocation"
              :breadcrumb="true"
              title="Select a folder for uploaded datasets"
            />
          </v-card-text>
        </v-card>

        <div
          v-if="option.pendingFiles.length > 0"
          class="mb-4 text-body-2 text--secondary"
        >
          {{ option.pendingFiles.length }}
          {{ option.pendingFiles.length === 1 ? "file" : "files" }}
          selected &rarr; {{ option.pendingFiles.length }} datasets
        </div>

        <!-- Action buttons -->
        <v-card-actions v-if="option.pendingFiles.length > 0" class="ma-2">
          <v-spacer />
          <v-btn
            outlined
            color="primary"
            :disabled="!canBatchUpload"
            @click="startBatchUpload(false)"
            class="mr-2"
          >
            Advanced Import
          </v-btn>
          <v-btn
            color="primary"
            :disabled="!canBatchUpload"
            @click="startBatchUpload(true)"
          >
            Quick Import
          </v-btn>
        </v-card-actions>
      </template>
    </v-card-text>
  </v-card>
</template>

<script lang="ts">
import { Vue, Component, Prop, Watch } from "vue-property-decorator";

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
import GirderLocationChooser from "@/components/GirderLocationChooser.vue";
import MultiSourceConfiguration from "@/views/dataset/MultiSourceConfiguration.vue";
import NewDataset from "@/views/dataset/NewDataset.vue";

function basename(filename: string): string {
  const components = filename.split(".");
  return components.length > 1
    ? components.slice(0, -1).join(".")
    : components[0];
}

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
    }
  | {
      type: "batch";
      pendingFiles: File[];
      datasetNames: string[];
      nameConflicts: number[];
      validatingNames: boolean;
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

function defaultDatasetBatchOption(): TAddDatasetOption {
  return {
    type: "batch",
    pendingFiles: [],
    datasetNames: [],
    nameConflicts: [],
    validatingNames: false,
  };
}

@Component({
  components: {
    CustomFileManager,
    GirderLocationChooser,
    MultiSourceConfiguration,
    NewDataset,
  },
})
export default class AddDatasetToCollection extends Vue {
  readonly girderResources = girderResources;
  readonly store = store;

  @Prop({ required: true })
  collection!: IDatasetConfiguration;

  option: TAddDatasetOption = defaultDatasetUploadOption();
  uploadLocation: IGirderLocation | null = null;
  batchLocation: IGirderLocation | null = null;
  batchDragging: boolean = false;
  validateNamesDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  $refs!: {
    configuration?: MultiSourceConfiguration;
    batchFileInput?: HTMLInputElement;
  };

  async mounted() {
    try {
      this.uploadLocation = await this.store.api.getUserPrivateFolder();
    } catch (error) {
      this.uploadLocation = this.store.girderUser;
    }
    this.batchLocation = this.uploadLocation;
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
      case "batch":
        this.option = defaultDatasetBatchOption();
        break;
    }
  }

  @Watch("collection")
  async collectionUpdated() {
    this.option = defaultDatasetUploadOption();
  }

  // --- "Add existing" option methods ---

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
      configViews.map((view: IDatasetView) => view.datasetId),
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
      case "batch":
        return false;
    }
  }

  // --- "Upload single" option methods ---

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

  // --- "Batch upload" option methods ---

  openBatchFileSelector() {
    this.$refs.batchFileInput?.click();
  }

  handleBatchFileSelect(event: Event) {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files || []);
    if (files.length > 0) {
      this.setBatchFiles(files);
    }
    input.value = "";
  }

  handleBatchDrop(event: DragEvent) {
    this.batchDragging = false;
    const files = Array.from(event.dataTransfer?.files || []);
    if (files.length > 0) {
      this.setBatchFiles(files);
    }
  }

  setBatchFiles(files: File[]) {
    if (this.option.type !== "batch") return;
    this.option.pendingFiles = files;
    this.option.datasetNames = files.map((f) => basename(f.name));
    this.option.nameConflicts = [];
    this.validateBatchNamesDebounced();
  }

  validateBatchNamesDebounced() {
    if (this.validateNamesDebounceTimer) {
      clearTimeout(this.validateNamesDebounceTimer);
    }
    this.validateNamesDebounceTimer = setTimeout(() => {
      this.validateBatchNames();
    }, 300);
  }

  async validateBatchNames() {
    if (this.option.type !== "batch") return;
    if (!this.batchLocation || !("_id" in this.batchLocation)) {
      return;
    }

    this.option.validatingNames = true;
    const conflicts: number[] = [];

    try {
      // Check for internal duplicates
      const nameCounts = new Map<string, number[]>();
      this.option.datasetNames.forEach((name, idx) => {
        const lower = name.trim().toLowerCase();
        if (!nameCounts.has(lower)) {
          nameCounts.set(lower, []);
        }
        nameCounts.get(lower)!.push(idx);
      });

      nameCounts.forEach((indices) => {
        if (indices.length > 1) {
          indices.forEach((idx) => {
            if (!conflicts.includes(idx)) {
              conflicts.push(idx);
            }
          });
        }
      });

      // Check each unique name against existing datasets
      const uniqueNames = [
        ...new Set(this.option.datasetNames.map((n) => n.trim())),
      ];
      for (const name of uniqueNames) {
        if (!name) continue;
        const exists = await this.store.api.checkDatasetNameExists(
          name,
          this.batchLocation,
        );
        if (exists) {
          this.option.datasetNames.forEach((n, idx) => {
            if (n.trim().toLowerCase() === name.toLowerCase()) {
              if (!conflicts.includes(idx)) {
                conflicts.push(idx);
              }
            }
          });
        }
      }
    } finally {
      if (this.option.type === "batch") {
        this.option.nameConflicts = conflicts;
        this.option.validatingNames = false;
      }
    }
  }

  getBatchNameError(idx: number): string {
    if (this.option.type !== "batch") return "";
    if (!this.option.nameConflicts.includes(idx)) return "";
    const name = this.option.datasetNames[idx]?.trim().toLowerCase();

    const duplicateCount = this.option.datasetNames.filter(
      (n) => n.trim().toLowerCase() === name,
    ).length;

    if (duplicateCount > 1) {
      return "Duplicate name in batch";
    }
    return "Dataset already exists in this location";
  }

  get canBatchUpload(): boolean {
    if (this.option.type !== "batch") return false;
    return (
      this.option.pendingFiles.length > 0 &&
      this.option.datasetNames.every((n) => n?.trim().length > 0) &&
      this.option.nameConflicts.length === 0 &&
      !this.option.validatingNames &&
      this.batchLocation !== null &&
      (!("_id" in this.batchLocation) || true)
    );
  }

  startBatchUpload(quickupload: boolean) {
    if (this.option.type !== "batch" || !this.batchLocation) return;

    const fileGroups = this.option.pendingFiles.map((f) => [f]);

    this.store.initializeUploadWorkflow({
      quickupload,
      batchMode: true,
      batchName: "",
      fileGroups,
      datasetNames: [...this.option.datasetNames],
      initialUploadLocation: this.batchLocation,
      initialName: "",
      initialDescription: "",
    });

    // Pre-set the existing collection so NewDataset doesn't create a new one
    this.store.setUploadCollection(this.collection);

    this.$router.push({ name: "newdataset" });
  }

  beforeDestroy() {
    if (this.validateNamesDebounceTimer) {
      clearTimeout(this.validateNamesDebounceTimer);
    }
  }
}
</script>

<style lang="scss">
.smart-overflow {
  display: flex;
  flex-direction: column;
  overflow: auto;
  min-height: 0;
  flex: 1;
}

.batch-file-card {
  cursor: pointer;
  border: 2px dashed rgba(255, 255, 255, 0.3) !important;
  transition: border-color 0.2s ease;

  &:hover {
    border-color: rgba(255, 255, 255, 0.5) !important;
  }
}
</style>

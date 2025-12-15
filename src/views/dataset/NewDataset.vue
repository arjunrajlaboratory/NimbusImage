<template>
  <v-container>
    <v-card v-if="quickupload" class="mb-2">
      <v-card-title>Quick Import in Progess</v-card-title>
      <v-card-text>
        <v-progress-linear
          class="text-progress"
          :value="totalProgressPercentage"
        />
      </v-card-text>
    </v-card>
    <v-form
      ref="form"
      v-model="valid"
      :disabled="
        quickupload && !pipelineError && valid && filesSelected && !uploading
      "
      @submit.prevent="submit()"
    >
      <girder-upload
        v-if="path && !hideUploader"
        ref="uploader"
        class="mb-2 new-dataset-upload"
        :dest="path"
        :uploadCls="uploadCls"
        hideStartButton
        hideHeadline
        @filesChanged="filesChanged"
        @done="nextStep"
        @error="interruptedUpload"
        @hook:mounted="uploadMounted"
      >
        <template #files="{ files }" v-if="quickupload && !pipelineError">
          <v-card>
            <v-card-text>
              Uploading {{ files ? files.length : 0 }} file(s)...
            </v-card-text>
          </v-card>
        </template>
      </girder-upload>

      <file-dropzone
        v-if="(!quickupload || pipelineError) && files.length > 0"
        @input="addMoreFiles"
        style="height: 150px"
        class="mb-2"
      >
        <template #default>
          <v-icon size="50px">$vuetify.icons.fileUpload</v-icon>
          <div class="title mt-3">Add more files to this dataset</div>
        </template>
      </file-dropzone>

      <v-text-field
        id="dataset-name-input-tourstep"
        v-model="name"
        label="Name"
        required
        :rules="rules"
        :readonly="pageTwo"
      />

      <v-textarea
        id="dataset-description-input-tourstep"
        v-model="description"
        label="Description"
        :readonly="pageTwo"
        rows="2"
      />

      <v-card class="mb-2">
        <v-card-title>Location:</v-card-title>
        <v-card-text>
          <v-container>
            <v-row>
              <girder-location-chooser
                v-model="path"
                :breadcrumb="true"
                title="Select a Folder to Import the New Dataset"
                :disabled="effectiveQuickupload && !pipelineError"
              />
            </v-row>
          </v-container>
        </v-card-text>
      </v-card>

      <v-alert v-if="failedDataset" text type="error">
        Could not create dataset <strong>{{ failedDataset }}</strong
        >. This might happen, for instance, if a dataset by that name already
        exists. Please update the dataset name field and try again.
      </v-alert>
      <v-alert v-if="fileSizeExceeded" text type="error">
        Total file size ({{ totalSizeString }}) exceeds the maximum allowed size
        of
        {{
          maxTotalFileSize === Infinity
            ? "No file size limit"
            : maxTotalFileSizeString
        }}
      </v-alert>
      <v-alert v-if="invalidLocation" text type="error">
        Cannot create datasets in this location. Please select a subfolder
        within your user directory or group folder.
      </v-alert>

      <div
        class="button-bar d-flex justify-space-between align-center"
        v-if="!effectiveQuickupload || pipelineError"
      >
        <div>
          <span class="mr-2"
            >File size limit: {{ maxTotalFileSizeString }}</span
          >
          <span v-if="maxApiKeyFileSize" class="mr-2">
            (using special permission code)</span
          >
        </div>
        <div>
          <v-btn
            id="upload-button-tourstep"
            v-tour-trigger="'upload-button-tourtrigger'"
            :disabled="
              !valid ||
              !filesSelected ||
              uploading ||
              fileSizeExceeded ||
              invalidLocation
            "
            color="success"
            @click="submit"
          >
            Upload
          </v-btn>
        </div>
      </div>
    </v-form>

    <!-- Collection mode progress header -->
    <v-card v-if="effectiveCollectionMode && !pipelineError" class="mb-4">
      <v-card-title>
        <v-icon left>mdi-folder-multiple</v-icon>
        Creating Collection: {{ effectiveCollectionName }}
      </v-card-title>
      <v-card-subtitle>
        Dataset
        {{ store.uploadWorkflow.currentDatasetIndex + 1 }} of
        {{ totalDatasets }}:
        <strong>{{ currentDatasetName }}</strong>
      </v-card-subtitle>
      <v-card-text>
        <v-progress-linear
          :value="
            ((store.uploadWorkflow.currentDatasetIndex +
              (uploading || configuring ? 0.5 : 1)) /
              totalDatasets) *
            100
          "
          height="8"
          rounded
        />
        <div class="mt-2 d-flex">
          <v-chip
            v-for="(files, idx) in store.uploadWorkflow.filesPerDataset"
            :key="idx"
            :color="
              idx < store.uploadWorkflow.currentDatasetIndex
                ? 'success'
                : idx === store.uploadWorkflow.currentDatasetIndex
                  ? 'primary'
                  : 'grey'
            "
            small
            class="mr-1"
          >
            {{ idx + 1 }}
          </v-chip>
        </div>
      </v-card-text>
    </v-card>

    <template v-if="effectiveQuickupload || effectiveCollectionMode">
      <template v-if="configuring && datasetId">
        <!-- Always mount MultiSourceConfiguration, but only show UI for first dataset -->
        <multi-source-configuration
          ref="configuration"
          :datasetId="datasetId"
          :autoDatasetRoute="false"
          @log="configurationLogs = $event"
          @generatedJson="generationDone"
          @configData="onConfigDataReceived"
          :class="{
            'd-none':
              !pipelineError &&
              effectiveCollectionMode &&
              !isProcessingFirstDataset,
          }"
        />
        <div class="title mb-2">
          {{
            effectiveCollectionMode && !isProcessingFirstDataset
              ? "Applying configuration to dataset"
              : "Configuring the dataset"
          }}
        </div>
        <v-progress-circular indeterminate />

        <!-- Transcoding progress bar and status for the quickupload path -->
        <v-card class="mt-4" v-if="configurationLogs && !pipelineError">
          <v-card-text>
            <div class="d-flex align-center mb-2">
              <div class="text-subtitle-1 mr-3">{{ progressStatusText }}</div>
              <v-spacer></v-spacer>
              <v-btn
                small
                text
                color="info"
                @click="showLogDialog = true"
                class="ml-2"
              >
                <v-icon small left>mdi-text-box-outline</v-icon>
                View Log
              </v-btn>
            </div>
            <v-progress-linear
              v-if="transcodeProgress !== undefined"
              :value="transcodeProgress"
              height="20"
              striped
              color="primary"
            >
              <template v-slot:default>
                <span class="white--text"
                  >{{ Math.ceil(transcodeProgress) }}%</span
                >
              </template>
            </v-progress-linear>
          </v-card-text>
        </v-card>
      </template>
      <template v-if="creatingView">
        <div class="title mb-2">Configuring the dataset</div>
        <v-progress-circular indeterminate />
        <dataset-info
          ref="viewCreation"
          :class="{ 'd-none': !pipelineError }"
        />
      </template>
    </template>

    <!-- Log Dialog -->
    <v-dialog v-model="showLogDialog" max-width="800px">
      <v-card>
        <v-card-title class="headline">
          Transcoding Log
          <v-spacer></v-spacer>
          <v-tooltip bottom>
            <template v-slot:activator="{ on, attrs }">
              <v-btn icon v-bind="attrs" v-on="on" @click="copyLogToClipboard">
                <v-icon>mdi-content-copy</v-icon>
              </v-btn>
            </template>
            <span>Copy to clipboard</span>
          </v-tooltip>
          <v-btn icon @click="showLogDialog = false">
            <v-icon>mdi-close</v-icon>
          </v-btn>
        </v-card-title>
        <v-card-text>
          <pre class="job-log">{{ configurationLogs }}</pre>
        </v-card-text>
        <v-card-actions>
          <v-spacer></v-spacer>
          <v-btn color="primary" text @click="showLogDialog = false"
            >Close</v-btn
          >
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Snackbar for copy notification -->
    <v-snackbar v-model="showCopySnackbar" :timeout="2000" color="success" top>
      Log copied to clipboard
    </v-snackbar>
  </v-container>
</template>
<script lang="ts">
import { Vue, Component, Prop, Watch } from "vue-property-decorator";
import store from "@/store";
import girderResources from "@/store/girderResources";
import { IGirderApiKey, IGirderLocation } from "@/girder";
import GirderLocationChooser from "@/components/GirderLocationChooser.vue";
import UploadManager from "@girder/components/src/utils/upload";
import FileDropzone from "@/components/Files/FileDropzone.vue";
import { IDataset, IDatasetConfiguration, IJobEventData } from "@/store/model";
import { triggersPerCategory } from "@/utils/parsing";
import { formatDate } from "@/utils/date";
import MultiSourceConfiguration from "./MultiSourceConfiguration.vue";
import DatasetInfo from "./DatasetInfo.vue";
import { logError } from "@/utils/log";
import { unselectableLocations } from "@/utils/girderSelectable";
import datasetMetadataImport from "@/store/datasetMetadataImport";
import { importAnnotationsFromData } from "@/utils/annotationImport";
import { formatSize } from "@/utils/conversion";
import { parseTranscodeOutput } from "@/utils/strings";

const allTriggers = Object.values(triggersPerCategory).flat();

interface FileUpload {
  file: File;
}

type GWCUpload = Vue & {
  inputFilesChanged(files: File[]): void;
  startUpload(): any;
  totalProgressPercent: number;
};

// Custom Girder upload manager that allows us to set the option `use_S3_transfer_acceleration`
// This has no effect if the assetstore is not an S3 assetstore
class GirderUploadManager extends UploadManager {
  constructor(file: File, options: any = {} as any) {
    options.params = options.params || {};
    options.params.uploadExtraParameters = JSON.stringify({
      use_S3_transfer_acceleration: true,
    });
    super(file, options);
  }
}

function basename(filename: string): string {
  const components = filename.split(".");
  return components.length > 1
    ? components.slice(0, -1).join(".")
    : components[0];
}

function findCommonPrefix(strings: string[]): string {
  // Handle special cases
  if (strings.length === 0) {
    return "";
  } else if (strings.length === 1) {
    return strings[0];
  }

  // For filenames that are purely numeric at the start, use first filename + "_multi"
  if (strings.every((s) => /^\d+/.test(s))) {
    return basename(strings[0]) + "_multi";
  }

  // For non-numeric prefixes:
  // Extract the non-metadata prefix of each filename. Note that because of the
  // way the regex is constructed, the first match group will never be `null`.
  const triggerAndDigit = allTriggers.map(
    (trigger) => `\\d${trigger}|${trigger}\\d`,
  );
  const re = new RegExp(`(.*?)(?:_|-|${triggerAndDigit.join("|")})`);
  const matches = strings.map((s) => s.match(re)![1]);

  // Get the minimum length of all the strings; the common prefix cannot be
  // longer than this.
  const minLength = matches.reduce(
    (acc, cur) => Math.min(acc, cur.length),
    Infinity,
  );

  // Sweep through the first string, and compare the letter found in each
  // position with the letter at that position for all the strings. Stop when an
  // inequality occurs.
  let result = [];
  for (let i = 0; i < minLength; i++) {
    const ch = matches[0].charAt(i);

    if (!matches.map((s) => s.charAt(i)).every((c) => c === ch)) {
      break;
    }
    result.push(ch);
  }

  return result.join("");
}

@Component({
  components: {
    GirderLocationChooser,
    FileDropzone,
    MultiSourceConfiguration,
    DatasetInfo,
    GirderUpload: () => import("@/girder/components").then((mod) => mod.Upload),
  },
})
export default class NewDataset extends Vue {
  readonly store = store;
  readonly girderResources = girderResources;

  @Prop({ type: Array, default: () => [] })
  readonly defaultFiles!: File[];

  @Prop({ default: false })
  readonly quickupload!: boolean;

  @Prop({ default: true })
  readonly autoMultiConfig!: boolean;

  @Prop()
  readonly initialUploadLocation!: IGirderLocation;

  @Prop()
  readonly initialName?: string;

  @Prop()
  readonly initialDescription?: string;

  @Prop({ type: Array, default: () => [] })
  readonly filesPerDataset!: File[][];

  @Prop({ default: false })
  readonly collectionMode!: boolean;

  @Prop()
  readonly collectionName?: string;

  uploadedFiles: File[] | null = null;

  configuring = false;
  creatingView = false;

  valid = false;
  failedDataset = "";
  uploading = false;
  hideUploader = false;
  name = "";
  description = "";

  uploadCls = GirderUploadManager;

  path: IGirderLocation | null = null;
  // originalPath is now in store.uploadWorkflow.originalPath

  dataset: IDataset | null = null;

  $refs!: {
    uploader?: GWCUpload;
    form: HTMLFormElement;
    configuration?: MultiSourceConfiguration;
    viewCreation?: DatasetInfo;
  };

  configurationLogs = "";

  // For progress tracking of the transcoding
  transcodeProgress: number | undefined = undefined;
  progressStatusText: string = "";
  totalFrames: number = 0;
  currentFrame: number = 0;

  // For the transcoding log dialog
  showLogDialog: boolean = false;
  showCopySnackbar: boolean = false;

  pipelineError = false;

  fileSizeExceeded = false;
  fileSizeExceededMessage = "";

  maxApiKeyFileSize: number | null = null;

  allFiles: File[] = [];

  // Collection mode state is now in store.uploadWorkflow
  // Keep currentDatasetIndex for backwards compatibility with non-store flows
  currentDatasetIndex: number = 0;

  get maxTotalFileSize() {
    // If the maxApiKeyFileSize is set, use that
    if (this.maxApiKeyFileSize) {
      return this.maxApiKeyFileSize;
    }
    // Otherwise, use the default max total file size
    return Number(import.meta.env.VITE_MAX_TOTAL_FILE_SIZE) || Infinity;
  }

  get invalidLocation() {
    if (!this.path) return false;
    return (
      ("_modelType" in this.path &&
        unselectableLocations.includes(this.path._modelType)) ||
      ("type" in this.path && unselectableLocations.includes(this.path.type))
    );
  }

  get datasetId() {
    return this.dataset?.id || null;
  }

  get totalProgressPercentage() {
    const stepWeights = [3, 3, 1];
    let iStep = 0;
    const totalPercentage = (localPercentage: number): number => {
      // Sum of the weight of the steps that are completed
      let completedStepsWeight = 0;
      for (let i = 0; i < iStep; ++i) {
        completedStepsWeight += stepWeights[i];
      }
      // Total sum of the weight of all steps
      let totalStepsWeight = completedStepsWeight;
      for (let i = iStep; i < stepWeights.length; ++i) {
        totalStepsWeight += stepWeights[i];
      }
      // Return the percentage of completion
      return (
        (100 * completedStepsWeight + localPercentage * stepWeights[iStep]) /
        totalStepsWeight
      );
    };

    // First step: uploading
    if (this.uploading) {
      const uploader = this.$refs.uploader;
      if (!uploader) {
        return totalPercentage(0);
      }
      return totalPercentage(uploader.totalProgressPercent);
    }
    iStep += 1;

    // Second step: configuring
    if (this.configuring) {
      const nLines = this.configurationLogs.split("\n").length;
      const exponent = -0.01 * nLines;
      return totalPercentage(100 - 100 * Math.exp(exponent));
    }
    iStep += 1;

    // Third step: create view
    if (this.creatingView) {
      return totalPercentage(50);
    }
    iStep += 1;

    return totalPercentage(0);
  }

  get pageTwo() {
    return this.dataset != null;
  }

  get rules() {
    return [(v: string) => v.trim().length > 0 || `value is required`];
  }

  get filesSelected() {
    return this.files.length > 0;
  }

  get recommendedName() {
    const { files } = this;

    // If there aren't any files selected yet, return a blank string.
    if (files.length === 0) {
      return "";
    }

    // If there is only one file, return its name with the extension struck off.
    if (files.length === 1) {
      return basename(files[0].name);
    }

    // For more than one file, search for the longest prefix common to all, and
    // use that as the name if it's nonblank; otherwise use the name of the
    // first file.
    const prefix = findCommonPrefix(files.map((d) => d.name));
    if (prefix.length > 0) {
      return prefix;
    } else {
      return basename(files[0].name);
    }
  }

  get totalSizeString() {
    if (!this.uploadedFiles) return 0;
    const totalBytes = this.uploadedFiles.reduce(
      (sum, file) => sum + file.size,
      0,
    );
    return formatSize(totalBytes);
  }

  get maxTotalFileSizeString() {
    return formatSize(this.maxTotalFileSize);
  }

  // Computed properties that use store when upload workflow is active
  get effectiveQuickupload(): boolean {
    return this.store.uploadWorkflow.active
      ? this.store.uploadWorkflow.quickupload
      : this.quickupload;
  }

  get effectiveCollectionMode(): boolean {
    return this.store.uploadWorkflow.active
      ? this.store.uploadWorkflow.collectionMode
      : this.collectionMode;
  }

  get effectiveCollectionName(): string {
    return (
      this.store.uploadWorkflow.collectionName || this.collectionName || ""
    );
  }

  get totalDatasets(): number {
    if (this.store.uploadWorkflow.active) {
      return this.store.uploadTotalDatasets || 1;
    }
    return (
      this.filesPerDataset.length || (this.defaultFiles.length > 0 ? 1 : 0)
    );
  }

  get isFirstDataset(): boolean {
    if (this.store.uploadWorkflow.active) {
      return this.store.uploadIsFirstDataset;
    }
    return this.currentDatasetIndex === 0;
  }

  get isLastDataset(): boolean {
    if (this.store.uploadWorkflow.active) {
      return this.store.uploadIsLastDataset;
    }
    return this.currentDatasetIndex >= this.filesPerDataset.length - 1;
  }

  get isProcessingFirstDataset(): boolean {
    return this.isFirstDataset;
  }

  get currentFiles(): File[] {
    if (
      this.store.uploadWorkflow.active &&
      this.store.uploadWorkflow.collectionMode
    ) {
      return this.store.uploadCurrentFiles;
    }
    if (this.effectiveCollectionMode && this.filesPerDataset.length > 0) {
      return this.filesPerDataset[this.currentDatasetIndex] || [];
    }
    return this.uploadedFiles || this.defaultFiles;
  }

  get currentDatasetName(): string {
    if (
      this.store.uploadWorkflow.active &&
      this.store.uploadWorkflow.collectionMode
    ) {
      return this.store.uploadCurrentDatasetName;
    }
    const files = this.currentFiles;
    if (files.length === 0) return "Dataset";
    return basename(files[0].name);
  }

  // Override existing `files` getter to use currentFiles in collection mode
  get files() {
    if (this.effectiveCollectionMode) {
      return this.currentFiles;
    }
    return this.uploadedFiles || this.defaultFiles;
  }

  async mounted() {
    // Read from store if upload workflow is active
    if (this.store.uploadWorkflow.active) {
      this.path = this.store.uploadWorkflow.initialUploadLocation;
      // originalPath is already set in store, no need to track locally

      if (this.store.uploadWorkflow.initialName) {
        this.name = this.store.uploadWorkflow.initialName;
      }
      if (this.store.uploadWorkflow.initialDescription) {
        this.description = this.store.uploadWorkflow.initialDescription;
      }
    } else {
      // Fallback to props
      this.path = this.initialUploadLocation;
      if (this.initialName) this.name = this.initialName;
      if (this.initialDescription) this.description = this.initialDescription;
    }

    this.maxApiKeyFileSize = await this.getMaxUploadSize();
  }

  async getMaxUploadSize() {
    const apiKeys = await this.store.api.getUserApiKeys();
    // First filter by all active keys, then find the maximum upload size
    // Else, return none
    const activeKeys = apiKeys.filter((key: IGirderApiKey) => key.active);
    const maxUploadSize = activeKeys.reduce(
      (max: number | null, key: IGirderApiKey) => {
        const size = this.convertScopeToBytes(key.scope);
        return size ? Math.max(max || 0, size) : max;
      },
      null,
    );
    return maxUploadSize;
  }

  convertScopeToBytes(scope: string[] | null): number | null {
    if (!scope) {
      return null;
    }

    // Note that the maxTotalFileSize is expected to be in bytes,
    // so we need to convert the scope to bytes
    const sizeMap: Record<string, number> = {
      "nimbus.upload.limit.500mb": 500 * 1024 * 1024,
      "nimbus.upload.limit.1gb": 1 * 1024 * 1024 * 1024,
      "nimbus.upload.limit.2gb": 2 * 1024 * 1024 * 1024,
      "nimbus.upload.limit.5gb": 5 * 1024 * 1024 * 1024,
      "nimbus.upload.limit.10gb": 10 * 1024 * 1024 * 1024,
      "nimbus.upload.limit.20gb": 20 * 1024 * 1024 * 1024,
      "nimbus.upload.limit.50gb": 50 * 1024 * 1024 * 1024,
      "nimbus.upload.limit.100gb": 100 * 1024 * 1024 * 1024,
      "nimbus.upload.limit.200gb": 200 * 1024 * 1024 * 1024,
      "nimbus.upload.limit.500gb": 500 * 1024 * 1024 * 1024,
      "nimbus.upload.limit.1tb": 1 * 1024 * 1024 * 1024 * 1024,
      "nimbus.upload.limit.2tb": 2 * 1024 * 1024 * 1024 * 1024,
    };

    // Find the first matching scope and return its byte value
    for (const key of scope) {
      if (key in sizeMap) {
        return sizeMap[key];
      }
    }

    return null;
  }

  async createCollection() {
    const collection = await this.store.createUploadCollection();
    if (!collection) {
      this.pipelineError = true;
      return;
    }
    // Collection is now stored in this.store.uploadWorkflow.collection
    logError(
      `[Collection Mode] createCollection completed. Collection in store: ${!!this.store.uploadWorkflow.collection}, collection.id: ${this.store.uploadWorkflow.collection?.id}`,
    );
  }

  async uploadMounted() {
    // Store original path on first dataset only (if not already in store)
    if (
      this.effectiveCollectionMode &&
      this.isFirstDataset &&
      !this.store.uploadWorkflow.originalPath
    ) {
      this.store.setUploadOriginalPath(this.path);
    }

    // Set files for current dataset
    const filesToUpload = this.effectiveCollectionMode
      ? this.currentFiles
      : this.files;
    this.$refs.uploader?.inputFilesChanged(filesToUpload);

    if (this.effectiveQuickupload || this.effectiveCollectionMode) {
      // Set name based on mode
      if (this.effectiveCollectionMode) {
        this.name = this.currentDatasetName;
      } else if (this.initialName) {
        this.name = this.initialName + " - " + formatDate(new Date());
      } else {
        this.name = this.recommendedName + " - " + formatDate(new Date());
      }

      const initialDescription = this.store.uploadWorkflow.active
        ? this.store.uploadWorkflow.initialDescription
        : this.initialDescription;
      if (initialDescription && this.isFirstDataset) {
        this.description = initialDescription;
      }

      await Vue.nextTick();
      await Vue.nextTick();

      if (this.invalidLocation) {
        this.pipelineError = true;
        logError("Invalid location for dataset creation");
        return;
      }

      // Don't submit if there was a previous error
      if (this.pipelineError) {
        return;
      }

      this.submit();
    }
  }

  async submit() {
    // Don't proceed if there's already an error
    if (this.pipelineError) {
      logError("submit() called but pipelineError is set, aborting");
      return;
    }

    if (!this.valid || !this.path || !("_id" in this.path)) {
      return;
    }

    if (this.fileSizeExceeded || this.invalidLocation) {
      this.pipelineError = true;
      return;
    }

    // In collection mode, use originalPath from store for dataset creation
    // In single dataset mode, use current path
    const pathForCreation = this.effectiveCollectionMode
      ? this.store.uploadWorkflow.originalPath
      : this.path;

    if (
      !pathForCreation ||
      !("_id" in pathForCreation) ||
      pathForCreation._modelType !== "folder"
    ) {
      logError("Invalid path for dataset creation");
      this.pipelineError = true;
      return;
    }

    const datasetName = this.effectiveCollectionMode
      ? this.currentDatasetName
      : this.name;

    this.dataset = await this.store.createDataset({
      name: datasetName,
      description: this.description,
      path: pathForCreation,
    });

    if (this.dataset === null) {
      this.failedDataset = datasetName;
      return;
    }

    // Track datasets in store for collection mode
    if (this.effectiveCollectionMode) {
      this.store.addUploadedDataset(this.dataset);
    }

    this.failedDataset = "";
    this.path = await this.girderResources.getFolder(this.dataset.id);
    await Vue.nextTick();

    this.uploading = true;
    this.$refs.uploader!.startUpload();
  }

  async submitSingleDataset() {
    // Extract existing submit() logic here
    this.dataset = await this.store.createDataset({
      name: this.name,
      description: this.description,
      path: this.path!,
    });

    if (this.dataset === null) {
      this.failedDataset = this.name;
      return;
    }

    this.failedDataset = "";
    this.path = await this.girderResources.getFolder(this.dataset.id);
    await Vue.nextTick();

    this.uploading = true;
    this.$refs.uploader!.startUpload();
  }

  async configureDatasetWithStrategy() {
    logError(
      `[Collection Mode] configureDatasetWithStrategy called. datasetId: ${this.datasetId}, dataset: ${!!this.dataset}`,
    );
    this.configuring = true;
    await Vue.nextTick();

    const config = this.$refs.configuration;
    if (!config) {
      logError("MultiSourceConfiguration not mounted for subsequent dataset");
      this.pipelineError = true;
      return;
    }

    const strategy = this.store.uploadWorkflow.assignmentStrategy;
    if (!strategy) {
      logError("No assignment strategy saved");
      this.pipelineError = true;
      return;
    }

    logError(
      `[Collection Mode] Strategy found: transcode=${strategy.transcode}, XY=${!!strategy.XY}, Z=${!!strategy.Z}, T=${!!strategy.T}, C=${!!strategy.C}`,
    );

    this.progressStatusText = "Detecting file structure...";

    // Use the new method that properly handles async state
    await config.reinitializeAndApplyStrategy(strategy);

    this.progressStatusText = strategy.transcode
      ? "Transcoding..."
      : "Generating configuration...";
    logError(`[Collection Mode] Calling config.submit()...`);
    config.submit();
  }

  async advanceToNextDataset() {
    logError(
      `[Collection Mode] advanceToNextDataset called. isLastDataset: ${this.isLastDataset}, currentIndex: ${this.store.uploadWorkflow.currentDatasetIndex}, totalDatasets: ${this.totalDatasets}`,
    );

    if (this.isLastDataset) {
      // All datasets processed - navigate to collection
      logError(
        "[Collection Mode] All datasets processed, navigating to collection",
      );
      this.navigateToCollection();
      return;
    }

    // Advance index in store
    this.store.advanceUploadDatasetIndex();
    logError(
      `[Collection Mode] Advanced to dataset index: ${this.store.uploadWorkflow.currentDatasetIndex}`,
    );

    // Reset local component state
    this.dataset = null;
    this.configuring = false;
    this.configurationLogs = "";
    this.transcodeProgress = undefined;

    // Reset path from store's originalPath
    if (!this.store.uploadWorkflow.originalPath) {
      logError(
        "[Collection Mode] ERROR: originalPath is not set in store, cannot continue",
      );
      this.pipelineError = true;
      return;
    }
    this.path = this.store.uploadWorkflow.originalPath;

    // Show uploader - this will trigger uploadMounted which calls submit()
    this.hideUploader = false;
  }

  navigateToCollection() {
    // Capture collection and datasets BEFORE calling completeUploadWorkflow
    // because completeUploadWorkflow resets the state
    logError(
      `[Collection Mode] navigateToCollection called. Store state - collection: ${!!this.store.uploadWorkflow.collection}, collectionId: ${this.store.uploadWorkflow.collection?.id}, datasets.length: ${this.store.uploadWorkflow.datasets.length}`,
    );

    const collection = this.store.uploadWorkflow.collection;
    const datasets = [...this.store.uploadWorkflow.datasets]; // Copy array

    logError(
      `[Collection Mode] Captured values. collection: ${!!collection}, collectionId: ${collection?.id}, datasets: ${datasets.length}`,
    );

    // Now reset the workflow state
    this.store.completeUploadWorkflow();

    if (collection) {
      // Set the collection in the store so ConfigurationInfo can load it
      this.store.setSelectedConfiguration(collection.id);
      logError(
        `[Collection Mode] Navigating to configuration view: ${collection.id}`,
      );
      this.$router.push({
        name: "configuration",
        params: { configurationId: collection.id },
      });
    } else if (datasets && datasets.length > 0) {
      logError(
        `[Collection Mode] No collection found, falling back to first dataset: ${datasets[0].id}`,
      );
      this.$router.push({
        name: "dataset",
        params: { datasetId: datasets[0].id },
      });
    } else {
      logError(
        `[Collection Mode] No collection or datasets found, navigating to root`,
      );
      this.$router.push({
        name: "root",
      });
    }
  }

  filesChanged(files: FileUpload[] | File[]) {
    // Convert to FileUpload[] format if necessary
    const fileUploads: FileUpload[] = Array.isArray(files)
      ? files.map((file) => {
          return typeof file === "object" && "file" in file
            ? (file as FileUpload)
            : { file: file as File };
        })
      : [];

    const totalSize = fileUploads.reduce((sum, { file }) => sum + file.size, 0);
    const maxSizeBytes = this.maxTotalFileSize;

    if (totalSize > maxSizeBytes) {
      this.fileSizeExceeded = true;
      this.uploadedFiles = null;
      if (this.effectiveQuickupload) {
        this.pipelineError = true;
        return;
      }
      return;
    }

    this.fileSizeExceeded = false;
    this.uploadedFiles = fileUploads.map(({ file }) => file);
    this.allFiles = this.uploadedFiles;

    if (this.name === "" && fileUploads.length > 0) {
      this.name = this.recommendedName;
    }
  }

  addMoreFiles(newFiles: File[]) {
    const merged = [...this.allFiles, ...newFiles];
    this.allFiles = merged;

    // Update girder-upload's internal state
    if (this.$refs.uploader) {
      this.$refs.uploader.inputFilesChanged(merged);
    }
  }

  interruptedUpload() {
    this.uploading = false;
    this.hideUploader = false;
  }

  nextStep() {
    this.hideUploader = true;
    this.uploading = false;

    if (!this.dataset) {
      logError("nextStep called but dataset is null");
      this.pipelineError = true;
      return;
    }

    const datasetId = this.dataset.id;

    if (this.effectiveCollectionMode) {
      if (this.isFirstDataset) {
        // First dataset: run full interactive configuration
        this.configureDataset();
      } else {
        // Subsequent datasets: configure with saved strategy
        this.configureDatasetWithStrategy();
      }
    } else if (this.effectiveQuickupload) {
      this.configureDataset();
    } else if (this.autoMultiConfig) {
      this.$router.push({
        name: "multi",
        params: { datasetId },
      });
    }

    this.$emit("datasetUploaded", datasetId);
  }

  async configureDataset() {
    // Don't set dataset yet because the only large image files are the upload files
    // If dataset is set now, it will not use the multi-source file later

    // Configure the dataset with default variables
    this.configuring = true;
    await Vue.nextTick();
    const config = this.$refs.configuration;
    if (!config) {
      logError(
        "MultiSourceConfiguration component not mounted during quickupload",
      );
      this.pipelineError = true;
      return;
    }
    // Ensure that the component is initialized
    await (config.initialized || config.initialize());
    config.submit();
  }

  generationDone(jsonId: string | null) {
    logError(
      `[Collection Mode] generationDone called. jsonId: ${jsonId}, effectiveCollectionMode: ${this.effectiveCollectionMode}, effectiveQuickupload: ${this.effectiveQuickupload}`,
    );
    if (this.effectiveCollectionMode) {
      // For collection mode, handle specially
      this.handleCollectionGenerationDone(jsonId);
    } else if (this.effectiveQuickupload) {
      // Existing single-dataset flow
      this.createView(jsonId);
    } else {
      logError(
        "[Collection Mode] generationDone called but neither collectionMode nor quickupload is active",
      );
    }
  }

  async handleCollectionGenerationDone(jsonId: string | null) {
    logError(
      `[Collection Mode] handleCollectionGenerationDone called with jsonId: ${jsonId}`,
    );
    if (!jsonId) {
      logError("Failed to generate JSON");
      this.pipelineError = true;
      return;
    }

    // Save assignment STRATEGY from first dataset (not the JSON config)
    if (this.isFirstDataset && this.$refs.configuration) {
      logError(
        `[Collection Mode] Saving assignment strategy from first dataset`,
      );
      const strategy = this.$refs.configuration.getAssignmentStrategy();
      this.store.setUploadAssignmentStrategy(strategy);

      // CRITICAL: Load the full dataset (with tile metadata) before creating collection
      // The dataset in uploadWorkflow.datasets[] is just the basic folder info,
      // but createConfigurationFromDataset needs the full tile/frame metadata
      logError(`[Collection Mode] Loading full dataset: ${this.dataset!.id}`);
      await this.store.setSelectedDataset(this.dataset!.id);

      // Create the collection using store action
      logError("[Collection Mode] Creating collection...");
      await this.createCollection();

      if (this.pipelineError || !this.store.uploadWorkflow.collection) {
        logError(
          `[Collection Mode] Collection creation failed. pipelineError: ${this.pipelineError}, collection: ${!!this.store.uploadWorkflow.collection}`,
        );
        return;
      }
      logError(
        `[Collection Mode] Collection created successfully: ${this.store.uploadWorkflow.collection.id}`,
      );
    }

    // Create dataset view for current dataset
    const collection = this.store.uploadWorkflow.collection;
    if (collection && this.dataset) {
      logError(
        `[Collection Mode] Creating dataset view for dataset ${this.dataset.id} in collection ${collection.id}`,
      );
      try {
        const datasetView = await this.store.createDatasetView({
          configurationId: collection.id,
          datasetId: this.dataset.id,
        });
        if (!datasetView) {
          logError(
            `[Collection Mode] Failed to create dataset view - API returned null`,
          );
        } else {
          logError(
            `[Collection Mode] Dataset view created successfully: ${datasetView.id}`,
          );
        }
      } catch (error) {
        logError(`[Collection Mode] Error creating dataset view:`, error);
        // Don't fail the whole process if dataset view creation fails
      }
    } else {
      logError(
        `[Collection Mode] Cannot create dataset view. collection: ${!!collection}, dataset: ${!!this.dataset}`,
      );
    }

    this.configuring = false;

    // Move to next dataset or finish
    logError(
      `[Collection Mode] Advancing to next dataset. isLastDataset: ${this.isLastDataset}`,
    );
    this.advanceToNextDataset();
  }

  async createView(jsonId: string | null) {
    if (!jsonId) {
      logError("Failed to generate JSON during quick upload");
      this.pipelineError = true;
      return;
    }
    // Set the dataset now that multi-source is available
    await this.store.setSelectedDataset(this.dataset!.id);
    this.configuring = false;

    // Check if we have annotation data to import
    if (
      datasetMetadataImport.hasAnnotationData &&
      datasetMetadataImport.annotationData
    ) {
      try {
        // Import annotations using the default import options
        await importAnnotationsFromData(datasetMetadataImport.annotationData);
        // Clear the annotation data after successful import
        datasetMetadataImport.clearAnnotationFile();
      } catch (error) {
        logError("Failed to import annotations:", error);
        // Continue with view creation even if annotation import fails
      }
    }

    // Create a default dataset view for this dataset
    this.creatingView = true;
    await Vue.nextTick();
    const viewCreation = this.$refs.viewCreation;
    if (!viewCreation) {
      logError("DatasetInfo component not mounted during quickupload");
      this.pipelineError = true;
      return;
    }
    const defaultView = await viewCreation.createDefaultView();
    if (!defaultView) {
      logError("Failed to create default view during quick upload");
      this.pipelineError = true;
      return;
    }
    this.store.setDatasetViewId(defaultView.id);
    const route = viewCreation.toRoute(defaultView);
    this.creatingView = false;

    // Go to the viewer
    this.$router.push(route);
  }

  // Watch for changes in the logs and parse them to update progress
  @Watch("configurationLogs")
  onConfigurationLogsChange() {
    if (this.configuring && this.configurationLogs) {
      const progress = parseTranscodeOutput(this.configurationLogs);
      this.progressStatusText = progress.progressStatusText;
      if (progress.transcodeProgress !== undefined)
        this.transcodeProgress = progress.transcodeProgress;
      if (progress.currentFrame !== undefined)
        this.currentFrame = progress.currentFrame;
      if (progress.totalFrames !== undefined)
        this.totalFrames = progress.totalFrames;
    }
  }

  // Copy log to clipboard
  copyLogToClipboard() {
    if (navigator.clipboard && this.configurationLogs) {
      navigator.clipboard.writeText(this.configurationLogs);
      this.showCopySnackbar = true;
    }
  }

  onConfigDataReceived(_configData: any) {
    // This handler is kept for backward compatibility but is no longer used
    // The assignment strategy is now saved directly in handleCollectionGenerationDone
  }
}
</script>

<style lang="scss">
.new-dataset-upload .files-list {
  max-height: 260px;
}

.job-log {
  max-height: 400px;
  min-height: 200px;
  overflow-y: auto;
  white-space: pre-wrap;
  font-family: monospace;
  font-size: 12px;
  background-color: rgba(0, 0, 0, 0.05);
  padding: 12px;
  border-radius: 4px;
  width: 100%;
  color: rgba(255, 255, 255, 0.85);
}
</style>

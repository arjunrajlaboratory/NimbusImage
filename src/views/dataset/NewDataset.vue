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
                :disabled="quickupload && !pipelineError"
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
        v-if="!quickupload || pipelineError"
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

    <template v-if="quickupload">
      <template v-if="configuring">
        <multi-source-configuration
          ref="configuration"
          :datasetId="datasetId"
          :autoDatasetRoute="false"
          @log="configurationLogs = $event"
          @generatedJson="generationDone"
          :class="{ 'd-none': !pipelineError }"
        />
        <div class="title mb-2">Configuring the dataset</div>
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
import FileDropzone from "@/components/Files/FileDropzone.vue";
import { IDataset } from "@/store/model";
import { triggersPerCategory } from "@/utils/parsing";
import { formatDate } from "@/utils/date";
import MultiSourceConfiguration from "./MultiSourceConfiguration.vue";
import DatasetInfo from "./DatasetInfo.vue";
import { logError } from "@/utils/log";
import { unselectableLocations } from "@/utils/girderSelectable";
import datasetMetadataImport from "@/store/datasetMetadataImport";
import { importAnnotationsFromData } from "@/utils/annotationImport";
import { formatSize } from "@/utils/conversion";

const allTriggers = Object.values(triggersPerCategory).flat();

interface FileUpload {
  file: File;
}

type GWCUpload = Vue & {
  inputFilesChanged(files: File[]): void;
  startUpload(): any;
  totalProgressPercent: number;
};

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

  uploadedFiles: File[] | null = null;

  configuring = false;
  creatingView = false;

  valid = false;
  failedDataset = "";
  uploading = false;
  hideUploader = false;
  name = "";
  description = "";

  path: IGirderLocation | null = null;

  dataset: IDataset | null = null;

  $refs!: {
    uploader?: GWCUpload;
    form: HTMLFormElement;
    configuration?: MultiSourceConfiguration;
    viewCreation?: DatasetInfo;
  };

  configurationLogs = "";

  // For progress tracking of the transcoding
  transcodeProgress: number = 0;
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

  get files() {
    return this.uploadedFiles || this.defaultFiles;
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

  async mounted() {
    this.path = this.initialUploadLocation;
    this.maxApiKeyFileSize = await this.getMaxUploadSize();

    // Use initial name and description from props if provided
    // Currently used for Zenodo imports
    if (this.initialName) {
      this.name = this.initialName;
    }

    if (this.initialDescription) {
      this.description = this.initialDescription;
    }
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

  async uploadMounted() {
    this.$refs.uploader?.inputFilesChanged(this.files);
    if (this.quickupload) {
      if (this.initialName) {
        this.name = this.initialName + " - " + formatDate(new Date());
      } else {
        this.name = this.recommendedName + " - " + formatDate(new Date());
      }

      if (this.initialDescription) {
        this.description = this.initialDescription;
      }

      await Vue.nextTick(); // "name" prop is set in the form
      await Vue.nextTick(); // this.valid is updated

      // Check for invalid location before proceeding with quickupload
      if (this.invalidLocation) {
        this.pipelineError = true;
        logError("Invalid location for dataset creation during quickupload");
        return;
      }

      this.submit();
    }
  }

  async submit() {
    if (!this.valid || !this.path || !("_id" in this.path)) {
      return;
    }

    if (this.fileSizeExceeded) {
      logError("Maximum total file size exceeded");
      this.pipelineError = true;
      return;
    }

    if (this.invalidLocation) {
      logError("Invalid location for dataset creation");
      this.pipelineError = true;
      return;
    }

    this.dataset = await this.store.createDataset({
      name: this.name,
      description: this.description,
      path: this.path,
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
      if (this.quickupload) {
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

    const datasetId = this.dataset!.id;

    if (this.quickupload) {
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
    if (this.quickupload) {
      this.createView(jsonId);
    }
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
      this.parseTranscodeOutput(this.configurationLogs);
    }
  }

  // Parse transcoding output to update progress bar
  parseTranscodeOutput(text: string) {
    // Look for "Processing frame x/y" pattern
    const frameRegex = /Processing frame (\d+)\/(\d+)/;
    const fileCreatedRegex = /Created a file of size (\d+)/;
    const startingRegex = /Started large image conversion/;

    // Check for "Started large image conversion"
    if (startingRegex.test(text)) {
      this.progressStatusText = "Starting transcoding";
      this.transcodeProgress = 5; // Small initial progress
      return;
    }

    // Check for frame processing
    const frameMatch = text.match(frameRegex);
    if (frameMatch) {
      const currentFrame = parseInt(frameMatch[1], 10);
      const totalFrames = parseInt(frameMatch[2], 10);

      this.currentFrame = currentFrame;
      this.totalFrames = totalFrames;
      this.transcodeProgress = (currentFrame / totalFrames) * 90; // Use 90% of progress bar for processing
      this.progressStatusText = `Processing frame ${currentFrame}/${totalFrames}`;
      return;
    }

    // Check for file creation
    const fileCreatedMatch = text.match(fileCreatedRegex);
    if (fileCreatedMatch) {
      const fileSize = parseInt(fileCreatedMatch[1], 10);
      const formattedSize = this.formatFileSize(fileSize);
      this.transcodeProgress = 99; // Almost complete
      this.progressStatusText = `Uploading file of size ${formattedSize}`;
      return;
    }

    // Check for "Storing result"
    if (text.includes("Storing result")) {
      this.transcodeProgress = 100; // Complete
      this.progressStatusText = "Completing transcoding";
    }
  }

  // Format file size in a human-readable way
  formatFileSize(bytes: number): string {
    if (bytes === 0) return "0 Bytes";

    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }

  // Copy log to clipboard
  copyLogToClipboard() {
    if (navigator.clipboard && this.configurationLogs) {
      navigator.clipboard.writeText(this.configurationLogs);
      this.showCopySnackbar = true;
    }
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

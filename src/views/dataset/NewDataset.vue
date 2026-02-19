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
      v-show="!showConfigAtTop"
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
                :disabled="isQuickImport && !pipelineError"
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
        v-if="!isQuickImport || pipelineError"
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
              invalidLocation ||
              configuring
            "
            color="success"
            @click="submit"
          >
            Upload
          </v-btn>
        </div>
      </div>
    </v-form>

    <!-- Batch mode progress header -->
    <v-card v-if="isBatchMode && !pipelineError" class="mb-4">
      <v-card-title>
        <v-icon left>mdi-folder-multiple</v-icon>
        Creating Collection: {{ effectiveBatchName }}
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
            v-for="(files, idx) in store.uploadWorkflow.fileGroups"
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

    <!-- Advanced batch mode: Show config UI prominently for first dataset -->
    <template v-if="showConfigAtTop && datasetId">
      <v-alert type="info" text class="mb-4">
        Configure the dimension assignments for the first dataset. These
        settings will be applied to all subsequent datasets.
      </v-alert>
      <multi-source-configuration
        ref="configuration"
        :datasetId="datasetId"
        :autoDatasetRoute="false"
        @log="configurationLogs = $event"
        @generatedJson="generationDone"
      />
    </template>

    <!-- Quick import and auto-processing batch mode -->
    <template v-if="(isQuickImport || isBatchMode) && !showConfigAtTop">
      <template v-if="configuring && datasetId">
        <!-- Mount MultiSourceConfiguration for auto-processing -->
        <multi-source-configuration
          ref="configuration"
          :datasetId="datasetId"
          :autoDatasetRoute="false"
          @log="configurationLogs = $event"
          @generatedJson="generationDone"
          class="d-none"
        />
        <!-- Show status text and spinner when auto-processing -->
        <div class="title mb-2">
          {{
            isBatchMode && !isProcessingFirstDataset
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

    <!-- Batch mode error dialog -->
    <v-dialog v-model="showBatchErrorDialog" persistent max-width="500">
      <v-card>
        <v-card-title class="headline error--text">
          <v-icon left color="error">mdi-alert-circle</v-icon>
          Dataset Failed
        </v-card-title>
        <v-card-text>
          <p>
            Failed to process dataset
            {{ store.uploadWorkflow.currentDatasetIndex + 1 }} of
            {{ totalDatasets }}:
            <strong>{{ currentDatasetName }}</strong>
          </p>
          <v-alert type="error" text dense class="mt-3">
            {{ batchErrorMessage }}
          </v-alert>
          <p class="mt-3">
            {{ totalDatasets - store.uploadWorkflow.currentDatasetIndex - 1 }}
            dataset(s) remaining. Would you like to continue with the remaining
            datasets or stop?
          </p>
        </v-card-text>
        <v-card-actions>
          <v-btn text @click="handleStopBatch">
            <v-icon left>mdi-stop</v-icon>
            Stop and Review
          </v-btn>
          <v-spacer></v-spacer>
          <v-btn color="primary" @click="handleContinueBatch">
            <v-icon left>mdi-skip-next</v-icon>
            Skip and Continue
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>
<script setup lang="ts">
import {
  ref,
  computed,
  watch,
  onMounted,
  nextTick,
  getCurrentInstance,
} from "vue";
import store from "@/store";
import girderResources from "@/store/girderResources";
import { IGirderApiKey, IGirderLocation } from "@/girder";
import GirderLocationChooser from "@/components/GirderLocationChooser.vue";
import UploadManager from "@girder/components/src/utils/upload";
import FileDropzone from "@/components/Files/FileDropzone.vue";
import { Upload as GirderUpload } from "@/girder/components";
import { IDataset } from "@/store/model";
import { triggersPerCategory } from "@/utils/parsing";
import { formatDate } from "@/utils/date";
import MultiSourceConfiguration from "./MultiSourceConfiguration.vue";
import DatasetInfo from "./DatasetInfo.vue";
import { logError, logWarning } from "@/utils/log";
import { unselectableLocations } from "@/utils/girderSelectable";
import datasetMetadataImport from "@/store/datasetMetadataImport";
import { importAnnotationsFromData } from "@/utils/annotationImport";
import { formatSize } from "@/utils/conversion";
import { parseTranscodeOutput } from "@/utils/strings";
import Vue from "vue";

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
  if (strings.length === 0) {
    return "";
  } else if (strings.length === 1) {
    return strings[0];
  }

  if (strings.every((s) => /^\d+/.test(s))) {
    return basename(strings[0]) + "_multi";
  }

  const triggerAndDigit = allTriggers.map(
    (trigger) => `\\d${trigger}|${trigger}\\d`,
  );
  const re = new RegExp(`(.*?)(?:_|-|${triggerAndDigit.join("|")})`);
  const matches = strings.map((s) => s.match(re)![1]);

  const minLength = matches.reduce(
    (acc, cur) => Math.min(acc, cur.length),
    Infinity,
  );

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

// --- Props ---
interface Props {
  defaultFiles?: File[];
  quickupload?: boolean;
  autoMultiConfig?: boolean;
  initialUploadLocation?: IGirderLocation;
  initialName?: string;
  initialDescription?: string;
  fileGroups?: File[][];
  batchMode?: boolean;
  batchName?: string;
}

const props = withDefaults(defineProps<Props>(), {
  defaultFiles: () => [],
  quickupload: false,
  autoMultiConfig: true,
  fileGroups: () => [],
  batchMode: false,
});

const emit = defineEmits<{
  (e: "datasetUploaded", id: string): void;
}>();

const vm = getCurrentInstance()!.proxy;

// --- Template refs ---
const form = ref<HTMLFormElement>();
// In Vue 2.7 <script setup>, template refs for child components may not expose
// methods directly via ref(). Use $refs for child component method access.
const uploader = ref<GWCUpload>();
const configuration = ref<InstanceType<typeof MultiSourceConfiguration>>();
const viewCreation = ref<any>();

// --- Reactive data ---
const uploadedFiles = ref<File[] | null>(null);
const configuring = ref(false);
const creatingView = ref(false);
const valid = ref(false);
const failedDataset = ref("");
const uploading = ref(false);
const hideUploader = ref(false);
const name = ref("");
const description = ref("");
const uploadCls = GirderUploadManager;
const path = ref<IGirderLocation | null>(null);
const dataset = ref<IDataset | null>(null);
const configurationLogs = ref("");
const transcodeProgress = ref<number | undefined>(undefined);
const progressStatusText = ref("");
const totalFrames = ref(0);
const currentFrame = ref(0);
const showLogDialog = ref(false);
const showCopySnackbar = ref(false);
const pipelineError = ref(false);
const showBatchErrorDialog = ref(false);
const batchErrorMessage = ref("");
const skippedDatasets = ref<number[]>([]);
const fileSizeExceeded = ref(false);
const fileSizeExceededMessage = ref("");
const maxApiKeyFileSize = ref<number | null>(null);
const allFiles = ref<File[]>([]);
const currentDatasetIndex = ref(0);

// --- Computed ---
const maxTotalFileSize = computed(() => {
  if (maxApiKeyFileSize.value) {
    return maxApiKeyFileSize.value;
  }
  return Number(import.meta.env.VITE_MAX_TOTAL_FILE_SIZE) || Infinity;
});

const invalidLocation = computed(() => {
  if (!path.value) return false;
  return (
    ("_modelType" in path.value &&
      unselectableLocations.includes(path.value._modelType)) ||
    ("type" in path.value && unselectableLocations.includes(path.value.type))
  );
});

const datasetId = computed(() => dataset.value?.id || null);

const totalProgressPercentage = computed(() => {
  const stepWeights = [3, 3, 1];
  let iStep = 0;
  const totalPercentage = (localPercentage: number): number => {
    let completedStepsWeight = 0;
    for (let i = 0; i < iStep; ++i) {
      completedStepsWeight += stepWeights[i];
    }
    let totalStepsWeight = completedStepsWeight;
    for (let i = iStep; i < stepWeights.length; ++i) {
      totalStepsWeight += stepWeights[i];
    }
    return (
      (100 * completedStepsWeight + localPercentage * stepWeights[iStep]) /
      totalStepsWeight
    );
  };

  if (uploading.value) {
    if (!uploader.value) {
      return totalPercentage(0);
    }
    return totalPercentage(uploader.value.totalProgressPercent);
  }
  iStep += 1;

  if (configuring.value) {
    const nLines = configurationLogs.value.split("\n").length;
    const exponent = -0.01 * nLines;
    return totalPercentage(100 - 100 * Math.exp(exponent));
  }
  iStep += 1;

  if (creatingView.value) {
    return totalPercentage(50);
  }
  iStep += 1;

  return totalPercentage(0);
});

const pageTwo = computed(() => dataset.value != null);

const rules = computed(() => [
  (v: string) => v.trim().length > 0 || `value is required`,
]);

const filesSelected = computed(() => files.value.length > 0);

const recommendedName = computed(() => {
  const f = files.value;
  if (f.length === 0) return "";
  if (f.length === 1) return basename(f[0].name);
  const prefix = findCommonPrefix(f.map((d) => d.name));
  return prefix.length > 0 ? prefix : basename(f[0].name);
});

const totalSizeString = computed(() => {
  if (!uploadedFiles.value) return 0;
  const totalBytes = uploadedFiles.value.reduce(
    (sum, file) => sum + file.size,
    0,
  );
  return formatSize(totalBytes);
});

const maxTotalFileSizeString = computed(() =>
  formatSize(maxTotalFileSize.value),
);

const isQuickImport = computed((): boolean =>
  store.uploadWorkflow.active
    ? store.uploadWorkflow.quickupload
    : props.quickupload,
);

const isBatchMode = computed((): boolean =>
  store.uploadWorkflow.active
    ? store.uploadWorkflow.batchMode
    : props.batchMode,
);

const effectiveBatchName = computed(
  (): string => store.uploadWorkflow.batchName || props.batchName || "",
);

const totalDatasets = computed((): number => {
  if (store.uploadWorkflow.active) {
    return store.uploadTotalDatasets || 1;
  }
  return props.fileGroups.length || (props.defaultFiles.length > 0 ? 1 : 0);
});

const isFirstDataset = computed((): boolean => {
  if (store.uploadWorkflow.active) {
    return store.uploadIsFirstDataset;
  }
  return currentDatasetIndex.value === 0;
});

const isLastDataset = computed((): boolean => {
  if (store.uploadWorkflow.active) {
    return store.uploadIsLastDataset;
  }
  return currentDatasetIndex.value >= props.fileGroups.length - 1;
});

const isProcessingFirstDataset = computed((): boolean => isFirstDataset.value);

const showConfigAtTop = computed(
  (): boolean =>
    isBatchMode.value &&
    !isQuickImport.value &&
    isProcessingFirstDataset.value &&
    configuring.value,
);

const currentFiles = computed((): File[] => {
  if (store.uploadWorkflow.active && store.uploadWorkflow.batchMode) {
    return store.uploadCurrentFiles;
  }
  if (isBatchMode.value && props.fileGroups.length > 0) {
    return props.fileGroups[currentDatasetIndex.value] || [];
  }
  return uploadedFiles.value || props.defaultFiles;
});

const currentDatasetName = computed((): string => {
  if (store.uploadWorkflow.active && store.uploadWorkflow.batchMode) {
    return store.uploadCurrentDatasetName;
  }
  const f = currentFiles.value;
  if (f.length === 0) return "Dataset";
  return basename(f[0].name);
});

const files = computed(() => {
  if (isBatchMode.value) {
    return currentFiles.value;
  }
  if (uploadedFiles.value) {
    return uploadedFiles.value;
  }
  if (store.uploadWorkflow.active) {
    return store.uploadCurrentFiles;
  }
  return props.defaultFiles;
});

// --- Methods ---
function convertScopeToBytes(scope: string[] | null): number | null {
  if (!scope) return null;

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

  for (const key of scope) {
    if (key in sizeMap) {
      return sizeMap[key];
    }
  }

  return null;
}

async function getMaxUploadSize() {
  const apiKeys = await store.api.getUserApiKeys();
  const activeKeys = apiKeys.filter((key: IGirderApiKey) => key.active);
  return activeKeys.reduce((max: number | null, key: IGirderApiKey) => {
    const size = convertScopeToBytes(key.scope);
    return size ? Math.max(max || 0, size) : max;
  }, null);
}

async function createCollection() {
  const collection = await store.createUploadCollection();
  if (!collection) {
    pipelineError.value = true;
    return;
  }
}

async function uploadMounted() {
  if (
    isBatchMode.value &&
    isFirstDataset.value &&
    !store.uploadWorkflow.originalPath
  ) {
    store.setUploadOriginalPath(path.value);
  }

  const filesToUpload = isBatchMode.value ? currentFiles.value : files.value;
  uploader.value?.inputFilesChanged(filesToUpload);

  if (isQuickImport.value || isBatchMode.value) {
    const initialNameValue = store.uploadWorkflow.active
      ? store.uploadWorkflow.initialName
      : props.initialName;

    if (isBatchMode.value) {
      name.value = currentDatasetName.value;
    } else if (initialNameValue) {
      name.value = initialNameValue;
    } else {
      name.value = recommendedName.value + " - " + formatDate(new Date());
    }

    const initialDescriptionValue = store.uploadWorkflow.active
      ? store.uploadWorkflow.initialDescription
      : props.initialDescription;
    if (initialDescriptionValue && isFirstDataset.value) {
      description.value = initialDescriptionValue;
    }

    await nextTick();
    await nextTick();

    if (invalidLocation.value) {
      pipelineError.value = true;
      logError("Invalid location for dataset creation");
      return;
    }

    if (pipelineError.value) {
      return;
    }

    submit();
  }
}

async function submit() {
  if (pipelineError.value) {
    logError("submit() called but pipelineError is set, aborting");
    return;
  }

  if (!valid.value || !path.value || !("_id" in path.value)) {
    return;
  }

  if (fileSizeExceeded.value || invalidLocation.value) {
    pipelineError.value = true;
    return;
  }

  const pathForCreation = isBatchMode.value
    ? store.uploadWorkflow.originalPath
    : path.value;

  if (
    !pathForCreation ||
    !("_id" in pathForCreation) ||
    pathForCreation._modelType !== "folder"
  ) {
    logError("Invalid path for dataset creation");
    pipelineError.value = true;
    return;
  }

  const datasetName = isBatchMode.value ? currentDatasetName.value : name.value;

  dataset.value = await store.createDataset({
    name: datasetName,
    description: description.value,
    path: pathForCreation,
  });

  if (dataset.value === null) {
    failedDataset.value = datasetName;
    return;
  }

  if (isBatchMode.value) {
    store.addUploadedDataset(dataset.value);
  }

  failedDataset.value = "";
  path.value = await girderResources.getFolder(dataset.value.id);
  await nextTick();

  if (!uploader.value) {
    logError("Uploader component not available after dataset creation");
    pipelineError.value = true;
    return;
  }
  uploading.value = true;
  uploader.value.startUpload();
}

async function submitSingleDataset() {
  dataset.value = await store.createDataset({
    name: name.value,
    description: description.value,
    path: path.value as any,
  });

  if (dataset.value === null) {
    failedDataset.value = name.value;
    return;
  }

  failedDataset.value = "";
  path.value = await girderResources.getFolder(dataset.value.id);
  await nextTick();

  if (!uploader.value) {
    logError("Uploader component not available after dataset creation");
    pipelineError.value = true;
    return;
  }
  uploading.value = true;
  uploader.value.startUpload();
}

async function configureDatasetWithStrategy() {
  configuring.value = true;
  await nextTick();

  const config = configuration.value;
  if (!config) {
    logError("MultiSourceConfiguration not mounted for subsequent dataset");
    handleBatchError("Configuration component not ready");
    return;
  }

  const strategy = store.uploadWorkflow.dimensionStrategy;
  if (!strategy) {
    logError("No dimension strategy saved from first dataset");
    handleBatchError("No dimension strategy saved from first dataset");
    return;
  }

  progressStatusText.value = "Detecting file structure...";
  await config.reinitializeAndApplyStrategy(strategy);
  progressStatusText.value = strategy.transcode
    ? "Transcoding..."
    : "Generating configuration...";
  config.submit();
}

async function advanceToNextDataset() {
  if (isLastDataset.value) {
    navigateToCollection();
    return;
  }

  store.advanceUploadDatasetIndex();

  dataset.value = null;
  configuring.value = false;
  configurationLogs.value = "";
  transcodeProgress.value = undefined;

  if (!store.uploadWorkflow.originalPath) {
    logError(
      "[Batch Mode] ERROR: originalPath is not set in store, cannot continue",
    );
    pipelineError.value = true;
    return;
  }
  path.value = store.uploadWorkflow.originalPath;

  hideUploader.value = false;
}

function navigateToCollection() {
  const collection = store.uploadWorkflow.collection;
  const datasets = [...store.uploadWorkflow.datasets];

  store.completeUploadWorkflow();

  if (collection) {
    store.setSelectedConfiguration(collection.id);
    vm.$router.push({
      name: "configuration",
      params: { configurationId: collection.id },
    });
  } else if (datasets && datasets.length > 0) {
    vm.$router.push({
      name: "dataset",
      params: { datasetId: datasets[0].id },
    });
  } else {
    vm.$router.push({
      name: "root",
    });
  }
}

function handleBatchError(message: string) {
  if (!isBatchMode.value) {
    pipelineError.value = true;
    return;
  }

  batchErrorMessage.value = message;
  showBatchErrorDialog.value = true;
}

function handleStopBatch() {
  showBatchErrorDialog.value = false;
  pipelineError.value = true;

  const collection = store.uploadWorkflow.collection;
  const datasets = [...store.uploadWorkflow.datasets];

  store.completeUploadWorkflow();

  if (collection && datasets.length > 0) {
    vm.$router.push({
      name: "configuration",
      params: { configurationId: collection.id },
    });
  } else if (datasets.length > 0) {
    vm.$router.push({
      name: "dataset",
      params: { datasetId: datasets[0].id },
    });
  } else {
    vm.$router.push({ name: "root" });
  }
}

function handleContinueBatch() {
  showBatchErrorDialog.value = false;
  skippedDatasets.value.push(store.uploadWorkflow.currentDatasetIndex);

  pipelineError.value = false;
  batchErrorMessage.value = "";

  advanceToNextDataset();
}

function filesChanged(inputFiles: FileUpload[] | File[]) {
  const fileUploads: FileUpload[] = Array.isArray(inputFiles)
    ? inputFiles.map((file) => {
        return typeof file === "object" && "file" in file
          ? (file as FileUpload)
          : { file: file as File };
      })
    : [];

  const totalSize = fileUploads.reduce((sum, { file }) => sum + file.size, 0);
  const maxSizeBytes = maxTotalFileSize.value;

  if (totalSize > maxSizeBytes) {
    fileSizeExceeded.value = true;
    uploadedFiles.value = null;
    if (isQuickImport.value) {
      pipelineError.value = true;
      return;
    }
    return;
  }

  fileSizeExceeded.value = false;
  uploadedFiles.value = fileUploads.map(({ file }) => file);
  allFiles.value = uploadedFiles.value;

  if (name.value === "" && fileUploads.length > 0) {
    name.value = recommendedName.value;
  }
}

function addMoreFiles(newFiles: File[]) {
  const merged = [...allFiles.value, ...newFiles];
  allFiles.value = merged;

  if (uploader.value) {
    uploader.value.inputFilesChanged(merged);
  }
}

function interruptedUpload() {
  uploading.value = false;
  hideUploader.value = false;
}

function nextStep() {
  hideUploader.value = true;
  uploading.value = false;

  if (!dataset.value) {
    logError("nextStep called but dataset is null");
    pipelineError.value = true;
    return;
  }

  const dsId = dataset.value.id;

  if (isBatchMode.value) {
    if (isFirstDataset.value) {
      configureDataset();
    } else {
      configureDatasetWithStrategy();
    }
  } else if (isQuickImport.value) {
    configureDataset();
  } else if (props.autoMultiConfig) {
    vm.$router.push({
      name: "multi",
      params: { datasetId: dsId },
    });
  }

  emit("datasetUploaded", dsId);
}

async function configureDataset() {
  configuring.value = true;
  await nextTick();
  const config = configuration.value;
  if (!config) {
    logError(
      "MultiSourceConfiguration component not mounted during quickupload",
    );
    pipelineError.value = true;
    return;
  }
  await (config.initialized || config.initialize());

  if (isQuickImport.value) {
    config.submit();
  }
}

function generationDone(jsonId: string | null) {
  if (isBatchMode.value) {
    handleCollectionGenerationDone(jsonId);
  } else if (isQuickImport.value) {
    createView(jsonId);
  } else {
    return;
  }
}

async function handleCollectionGenerationDone(jsonId: string | null) {
  if (!jsonId) {
    logError("Failed to generate JSON");
    pipelineError.value = true;
    return;
  }

  if (isFirstDataset.value) {
    await store.setSelectedDataset(dataset.value!.id);
    await createCollection();

    if (pipelineError.value || !store.uploadWorkflow.collection) {
      logWarning("Failed to create collection");
      return;
    }
  }

  const collection = store.uploadWorkflow.collection;
  if (collection && dataset.value) {
    try {
      const datasetView = await store.createDatasetView({
        configurationId: collection.id,
        datasetId: dataset.value.id,
      });
      if (!datasetView) {
        logError(
          `[Batch Mode] Failed to create dataset view - API returned null`,
        );
      }
    } catch (error) {
      logError(`[Batch Mode] Error creating dataset view:`, error);
    }
  } else {
    logError(
      `[Batch Mode] Cannot create dataset view. collection: ${!!collection}, dataset: ${!!dataset.value}`,
    );
  }

  configuring.value = false;
  advanceToNextDataset();
}

async function createView(jsonId: string | null) {
  if (!jsonId) {
    logError("Failed to generate JSON during quick upload");
    pipelineError.value = true;
    return;
  }
  await store.setSelectedDataset(dataset.value!.id);
  configuring.value = false;

  if (
    datasetMetadataImport.hasAnnotationData &&
    datasetMetadataImport.annotationData
  ) {
    try {
      await importAnnotationsFromData(datasetMetadataImport.annotationData);
      datasetMetadataImport.clearAnnotationFile();
    } catch (error) {
      logError("Failed to import annotations:", error);
    }
  }

  creatingView.value = true;
  await nextTick();
  const vc = viewCreation.value;
  if (!vc) {
    logError("DatasetInfo component not mounted during quickupload");
    pipelineError.value = true;
    return;
  }
  const defaultView = await vc.createDefaultView();
  if (!defaultView) {
    logError("Failed to create default view during quick upload");
    pipelineError.value = true;
    return;
  }
  store.setDatasetViewId(defaultView.id);
  const route = vc.toRoute(defaultView);
  creatingView.value = false;

  vm.$router.push(route);
}

function copyLogToClipboard() {
  if (navigator.clipboard && configurationLogs.value) {
    navigator.clipboard.writeText(configurationLogs.value);
    showCopySnackbar.value = true;
  }
}

// --- Watcher ---
watch(configurationLogs, () => {
  if (configuring.value && configurationLogs.value) {
    const progress = parseTranscodeOutput(configurationLogs.value);
    progressStatusText.value = progress.progressStatusText;
    if (progress.transcodeProgress !== undefined)
      transcodeProgress.value = progress.transcodeProgress;
    if (progress.currentFrame !== undefined)
      currentFrame.value = progress.currentFrame;
    if (progress.totalFrames !== undefined)
      totalFrames.value = progress.totalFrames;
  }
});

// --- Lifecycle ---
onMounted(async () => {
  if (store.uploadWorkflow.active) {
    path.value = store.uploadWorkflow.initialUploadLocation;
    if (store.uploadWorkflow.initialName) {
      name.value = store.uploadWorkflow.initialName;
    }
    if (store.uploadWorkflow.initialDescription) {
      description.value = store.uploadWorkflow.initialDescription;
    }
  } else {
    path.value = props.initialUploadLocation ?? null;
    if (props.initialName) name.value = props.initialName;
    if (props.initialDescription) description.value = props.initialDescription;
  }

  maxApiKeyFileSize.value = await getMaxUploadSize();
});

// --- Expose for tests and external access ---
defineExpose({
  store,
  girderResources,
  uploader,
  form,
  configuration,
  viewCreation,
  uploadedFiles,
  configuring,
  creatingView,
  valid,
  failedDataset,
  uploading,
  hideUploader,
  name,
  description,
  uploadCls,
  path,
  dataset,
  configurationLogs,
  transcodeProgress,
  progressStatusText,
  totalFrames,
  currentFrame,
  showLogDialog,
  showCopySnackbar,
  pipelineError,
  showBatchErrorDialog,
  batchErrorMessage,
  skippedDatasets,
  fileSizeExceeded,
  fileSizeExceededMessage,
  maxApiKeyFileSize,
  allFiles,
  currentDatasetIndex,
  maxTotalFileSize,
  invalidLocation,
  datasetId,
  totalProgressPercentage,
  pageTwo,
  rules,
  filesSelected,
  recommendedName,
  totalSizeString,
  maxTotalFileSizeString,
  isQuickImport,
  isBatchMode,
  effectiveBatchName,
  totalDatasets,
  isFirstDataset,
  isLastDataset,
  isProcessingFirstDataset,
  showConfigAtTop,
  currentFiles,
  currentDatasetName,
  files,
  convertScopeToBytes,
  getMaxUploadSize,
  createCollection,
  uploadMounted,
  submit,
  submitSingleDataset,
  configureDatasetWithStrategy,
  advanceToNextDataset,
  navigateToCollection,
  handleBatchError,
  handleStopBatch,
  handleContinueBatch,
  filesChanged,
  addMoreFiles,
  interruptedUpload,
  nextStep,
  configureDataset,
  generationDone,
  handleCollectionGenerationDone,
  createView,
  copyLogToClipboard,
});
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

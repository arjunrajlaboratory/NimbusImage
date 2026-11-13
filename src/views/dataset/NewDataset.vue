<template>
  <v-container>
    <v-card v-if="isQuickImport" class="mb-2">
      <template v-if="pipelineError">
        <v-card-title>Quick Import Failed</v-card-title>
        <v-card-actions class="button-bar">
          <v-btn variant="text" size="small" @click="goHome">
            Back to home
          </v-btn>
          <v-btn
            v-if="canRetryReadingFiles"
            variant="flat"
            color="primary"
            size="small"
            @click="retryReadingFiles"
          >
            Try again
          </v-btn>
        </v-card-actions>
      </template>
      <template v-else>
        <v-card-title>Quick Import in Progress</v-card-title>
        <v-card-text>
          <v-progress-linear
            class="text-progress"
            :model-value="totalProgressPercentage"
          />
        </v-card-text>
      </template>
    </v-card>
    <v-form
      v-show="!showConfigAtTop"
      ref="form"
      v-model="valid"
      :disabled="
        isQuickImport && !pipelineError && valid && filesSelected && !uploading
      "
      @submit.prevent="submit()"
    >
      <girder-upload
        v-if="path && !hideUploader"
        :key="store.uploadWorkflow.currentDatasetIndex"
        ref="uploader"
        class="mb-2 new-dataset-upload"
        :dest="path"
        :uploadCls="uploadCls"
        hideStartButton
        hideHeadline
        @filesChanged="filesChanged"
        @done="nextStep"
        @error="interruptedUpload"
        @vue:mounted="uploadMounted"
      >
        <template
          #dropzone="{
            files: uploadFiles,
            dropzoneMessage,
            multiple,
            accept,
            inputFilesChanged,
          }"
        >
          <file-dropzone
            v-if="!uploadFiles.length"
            :multiple="multiple"
            :accept="accept"
            class="new-dataset-primary-dropzone"
            @update:model-value="inputFilesChanged"
          >
            <template #default>
              <v-icon size="50px">mdi-file-upload</v-icon>
              <div class="text-body-1 font-weight-medium mt-3">
                {{ dropzoneMessage }}
              </div>
            </template>
          </file-dropzone>
        </template>

        <template #files="{ files }" v-if="isQuickImport && !pipelineError">
          <v-card>
            <v-card-text>
              Uploading {{ files ? files.length : 0 }} file(s)...
            </v-card-text>
          </v-card>
        </template>
      </girder-upload>

      <file-dropzone
        v-if="(!isQuickImport || pipelineError) && !pageTwo && files.length > 0"
        @update:model-value="addMoreFiles"
        style="height: 150px"
        class="mb-2"
      >
        <template #default>
          <v-icon size="50px">mdi-file-upload</v-icon>
          <div class="text-body-1 font-weight-medium mt-3">
            Add more files to this dataset
          </div>
        </template>
      </file-dropzone>

      <v-text-field
        :data-tour="TOUR_ANCHORS.datasetNameInput"
        v-model="name"
        label="Name"
        required
        :rules="rules"
        :readonly="pageTwo"
      />

      <v-textarea
        :data-tour="TOUR_ANCHORS.datasetDescriptionInput"
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
                :disabled="(isQuickImport && !pipelineError) || pageTwo"
              />
            </v-row>
          </v-container>
        </v-card-text>
      </v-card>

      <v-alert v-if="failedDataset" variant="tonal" type="error">
        Could not create dataset <strong>{{ failedDataset }}</strong
        >. This might happen, for instance, if a dataset by that name already
        exists. Please update the dataset name field and try again.
      </v-alert>
      <v-alert v-if="fileSizeExceeded" variant="tonal" type="error">
        Total file size ({{ totalSizeString }}) exceeds the maximum allowed size
        of
        {{
          maxTotalFileSize === Infinity
            ? "No file size limit"
            : maxTotalFileSizeString
        }}
      </v-alert>
      <v-alert v-if="invalidLocation" variant="tonal" type="error">
        Cannot create datasets in this location. Please select a subfolder
        within your user directory or group folder.
      </v-alert>
      <v-alert v-if="storageWarningMessage" variant="tonal" type="warning">
        {{ storageWarningMessage }}
      </v-alert>

      <!-- A failed quick import whose files are all uploaded cannot upload
        again; its exits are on the card above. -->
      <div
        class="button-bar d-flex justify-space-between align-center"
        v-if="!isQuickImport || (pipelineError && !hideUploader)"
      >
        <div>
          <span class="mr-2"
            >File size limit: {{ maxTotalFileSizeString }}</span
          >
          <span v-if="maxApiKeyFileSize" class="mr-2">
            (using special permission code)</span
          >
          <span v-if="storageUsageString" class="mr-2">
            {{ storageUsageString }}</span
          >
        </div>
        <div>
          <v-btn
            :data-tour="TOUR_ANCHORS.uploadButton"
            v-tour-trigger="TOUR_TRIGGERS.uploadButton"
            variant="flat"
            color="success"
            size="small"
            :disabled="uploadDisabled"
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
        <v-icon start>mdi-folder-multiple</v-icon>
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
          :model-value="
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
                  : 'secondary'
            "
            size="small"
            class="mr-1"
          >
            {{ idx + 1 }}
          </v-chip>
        </div>
      </v-card-text>
    </v-card>

    <!-- Advanced batch mode: Show config UI prominently for first dataset -->
    <template v-if="showConfigAtTop && datasetId">
      <v-alert type="info" variant="tonal" class="mb-4">
        Configure the dimension assignments for the first dataset. These
        settings will be applied to all subsequent datasets.
      </v-alert>
      <multi-source-configuration
        ref="configuration"
        :datasetId="datasetId"
        :autoDatasetRoute="false"
        @log="configurationLogs = $event"
        @generatedJson="generationDone"
        @generationError="generationFailed"
      />
    </template>

    <!-- Quick import and auto-processing batch mode -->
    <template v-if="(isQuickImport || isBatchMode) && !showConfigAtTop">
      <v-alert v-if="processingError" type="error" variant="tonal" class="mb-4">
        <div class="mb-2">{{ processingError }}</div>
        <v-btn
          v-if="configurationLogs"
          size="small"
          variant="text"
          color="info"
          @click="showLogDialog = true"
        >
          <v-icon size="small" start>mdi-text-box-outline</v-icon>
          View Log
        </v-btn>
      </v-alert>
      <template v-if="configuring && datasetId">
        <!-- Mount MultiSourceConfiguration for auto-processing -->
        <multi-source-configuration
          ref="configuration"
          :datasetId="datasetId"
          :autoDatasetRoute="false"
          @log="configurationLogs = $event"
          @generatedJson="generationDone"
          @generationError="generationFailed"
          class="d-none"
        />
        <!-- Show status text and spinner when auto-processing -->
        <div class="text-body-1 font-weight-medium mb-2">
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
              <div class="text-body-2 text-medium-emphasis mr-3">
                {{ progressStatusText }}
              </div>
              <v-spacer></v-spacer>
              <v-btn
                size="small"
                variant="text"
                color="info"
                @click="showLogDialog = true"
                class="ml-2"
              >
                <v-icon size="small" start>mdi-text-box-outline</v-icon>
                View Log
              </v-btn>
            </div>
            <v-progress-linear
              v-if="transcodeProgress !== undefined"
              :model-value="transcodeProgress"
              height="20"
              striped
              color="primary"
            >
              <template v-slot:default>
                <span class="font-mono"
                  >{{ Math.ceil(transcodeProgress) }}%</span
                >
              </template>
            </v-progress-linear>
          </v-card-text>
        </v-card>
      </template>
      <template v-if="creatingView || failedPhase === 'creatingView'">
        <template v-if="creatingView">
          <div class="text-body-1 font-weight-medium mb-2">
            Configuring the dataset
          </div>
          <v-progress-circular indeterminate />
        </template>
        <dataset-info
          ref="viewCreation"
          :class="{ 'd-none': !pipelineError }"
        />
      </template>
    </template>

    <!-- Log Dialog -->
    <v-dialog v-model="showLogDialog" max-width="800px">
      <v-card>
        <v-card-title>
          Transcoding Log
          <v-spacer></v-spacer>
          <v-tooltip location="bottom">
            <template v-slot:activator="{ props: activatorProps }">
              <v-btn
                v-bind="activatorProps"
                variant="text"
                icon
                size="small"
                @click="copyLogToClipboard"
              >
                <v-icon>mdi-content-copy</v-icon>
              </v-btn>
            </template>
            <span>Copy to clipboard</span>
          </v-tooltip>
          <v-btn
            variant="text"
            icon
            size="small"
            @click="showLogDialog = false"
          >
            <v-icon>mdi-close</v-icon>
          </v-btn>
        </v-card-title>
        <v-card-text>
          <pre class="job-log">{{ configurationLogs }}</pre>
        </v-card-text>
        <v-card-actions>
          <v-spacer></v-spacer>
          <v-btn variant="text" size="small" @click="showLogDialog = false"
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
        <v-card-title class="text-error">
          <v-icon start color="error">mdi-alert-circle</v-icon>
          Dataset Failed
        </v-card-title>
        <v-card-text>
          <p>
            Failed to process dataset
            {{ store.uploadWorkflow.currentDatasetIndex + 1 }} of
            {{ totalDatasets }}:
            <strong>{{ currentDatasetName }}</strong>
          </p>
          <v-alert type="error" variant="tonal" density="compact" class="mt-3">
            {{ batchErrorMessage }}
          </v-alert>
          <p v-if="canSkipFailedDataset" class="mt-3">
            {{ totalDatasets - store.uploadWorkflow.currentDatasetIndex - 1 }}
            dataset(s) remaining. Would you like to continue with the remaining
            datasets or stop?
          </p>
          <p v-else class="mt-3">
            The first dataset sets up the configuration and collection the other
            datasets reuse, so the batch cannot continue without it.
          </p>
        </v-card-text>
        <v-card-actions>
          <v-btn variant="text" size="small" @click="handleStopBatch">
            <v-icon start>mdi-stop</v-icon>
            Stop and Review
          </v-btn>
          <v-spacer></v-spacer>
          <v-btn
            v-if="canSkipFailedDataset"
            variant="flat"
            color="primary"
            size="small"
            @click="handleContinueBatch"
          >
            <v-icon start>mdi-skip-next</v-icon>
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
  onBeforeUnmount,
  nextTick,
} from "vue";
import { useRouter } from "vue-router";
import store from "@/store";
import girderResources from "@/store/girderResources";
import { IGirderApiKey, IGirderLocation } from "@/girder";
import GirderLocationChooser from "@/components/GirderLocationChooser.vue";
import { UploadManager } from "@girder/components";
import FileDropzone from "@/components/Files/FileDropzone.vue";
import { Upload as GirderUpload } from "@/girder/components";
import { IDataset, IUserStorageQuota } from "@/store/model";
import { triggersPerCategory } from "@/utils/parsing";
import { formatDate } from "@/utils/date";
import MultiSourceConfiguration from "./MultiSourceConfiguration.vue";
import DatasetInfo from "./DatasetInfo.vue";
import { TOUR_ANCHORS, TOUR_TRIGGERS } from "@/tours/anchors";
import { logError, logWarning } from "@/utils/log";
import { unselectableLocations } from "@/utils/girderSelectable";
import datasetMetadataImport from "@/store/datasetMetadataImport";
import { importAnnotationsFromData } from "@/utils/annotationImport";
import { formatSize } from "@/utils/conversion";
import { parseTranscodeOutput } from "@/utils/strings";
import type { ComponentPublicInstance } from "vue";

const allTriggers = Object.values(triggersPerCategory).flat();

interface FileUpload {
  file: File;
}

type GWCUpload = ComponentPublicInstance & {
  inputFilesChanged(files: File[]): void;
  startUpload(): any;
  totalProgressPercent: number;
  uploading: boolean;
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
  const matches = strings.map((s) => s.match(re)?.[1] ?? s);

  const minLength = matches.reduce(
    (acc, cur) => Math.min(acc, cur.length),
    Infinity,
  );

  const result = [];
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

const router = useRouter();

// --- Template refs ---
const form = ref<HTMLFormElement>();
// In Vue 2.7 <script setup>, template refs for child components may not expose
// methods directly via ref(). Use $refs for child component method access.
const uploader = ref<GWCUpload>();
const configuration = ref<InstanceType<typeof MultiSourceConfiguration>>();
const viewCreation = ref<any>();

// --- Reactive data ---
const uploadedFiles = ref<File[] | null>(null);
// What the pipeline is doing for the current dataset. A failure returns it
// to "idle" and records where it stopped in failedPhase, so no phase is
// ever left running beside an error.
// Configuring has two phases: "readingFiles" (MultiSourceConfiguration
// loads the uploaded files' metadata, which changes nothing on the server)
// and "configuring" (it generates the configuration, which does).
type TPipelinePhase =
  | "idle"
  | "creatingDataset"
  | "uploading"
  | "readingFiles"
  | "configuring"
  | "creatingView";
const phase = ref<TPipelinePhase>("idle");
const failedPhase = ref<TPipelinePhase | null>(null);
const uploading = computed(() => phase.value === "uploading");
const configuring = computed(
  () => phase.value === "readingFiles" || phase.value === "configuring",
);
const creatingView = computed(() => phase.value === "creatingView");
const pipelineError = computed(() => failedPhase.value !== null);
// Reading the files can run again on the dataset that already holds them;
// a failed generation may have left a half-written configuration behind.
const canRetryReadingFiles = computed(
  () =>
    failedPhase.value === "readingFiles" &&
    dataset.value !== null &&
    hideUploader.value &&
    !isBatchMode.value,
);
const valid = ref(false);
const failedDataset = ref("");
// Set once the current dataset's files have all been uploaded.
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
const showBatchErrorDialog = ref(false);
// Later datasets reuse the first one's dimension strategy and collection
const canSkipFailedDataset = computed(
  () => store.uploadWorkflow.currentDatasetIndex > 0,
);
const batchErrorMessage = ref("");
const skippedDatasets = ref<number[]>([]);
const fileSizeExceeded = ref(false);
const fileSizeExceededMessage = ref("");
const maxApiKeyFileSize = ref<number | null>(null);
const processingError = ref<string | null>(null);
const storageQuota = ref<IUserStorageQuota | null>(null);
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

// Upload stays usable after a failure (the form and button bar reappear for
// a retry), except once the files are all uploaded: a retry can then only
// create a second dataset. A quick import that fails then hides the button
// and offers retryReadingFiles instead.
const uploadDisabled = computed(
  () =>
    !valid.value ||
    !filesSelected.value ||
    phase.value !== "idle" ||
    hideUploader.value ||
    fileSizeExceeded.value ||
    invalidLocation.value,
);

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

const storageUsageString = computed(() => {
  const quotaInfo = storageQuota.value;
  if (!quotaInfo || quotaInfo.quota == null) {
    return null;
  }
  return `Storage used: ${formatSize(quotaInfo.used)} of ${formatSize(
    quotaInfo.quota,
  )}`;
});

// Warn ahead of the upload when the selected files won't fit in the user's
// remaining storage quota (or when transcoding might not fit, since it
// creates an additional optimized copy of the dataset). The actual
// enforcement happens on the backend; this is advance feedback only.
const storageWarningMessage = computed(() => {
  const quotaInfo = storageQuota.value;
  if (!quotaInfo || quotaInfo.quota == null || files.value.length === 0) {
    return null;
  }
  const totalBytes = files.value.reduce((sum, file) => sum + file.size, 0);
  const remaining = Math.max(0, quotaInfo.quota - quotaInfo.used);
  if (totalBytes > remaining) {
    return (
      `The selected files (${formatSize(totalBytes)}) are larger than your ` +
      `remaining storage (${formatSize(remaining)} of ` +
      `${formatSize(quotaInfo.quota)}). The upload will fail unless you ` +
      `free up space by deleting datasets you no longer need, or upgrade ` +
      `your account for more storage.`
    );
  }
  if (2 * totalBytes > remaining) {
    return (
      `The selected files (${formatSize(totalBytes)}) fit in your ` +
      `remaining storage (${formatSize(remaining)}), but transcoding ` +
      `creates an additional optimized copy of the dataset, which may ` +
      `exceed your storage quota. If the import fails, free up space or ` +
      `turn off the transcode option.`
    );
  }
  return null;
});

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
    handleBatchError("Could not create the collection");
  }
  return collection;
}

// Stop the pipeline at a failure, remembering where it stopped.
function failPipeline() {
  if (failedPhase.value === null) {
    failedPhase.value = phase.value;
  }
  phase.value = "idle";
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
      failPipeline();
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
  // The form's Enter key reaches here even while Upload is disabled.
  if (phase.value !== "idle" || hideUploader.value) {
    return;
  }

  if (!valid.value || !path.value || !("_id" in path.value)) {
    return;
  }

  if (fileSizeExceeded.value || invalidLocation.value) {
    failPipeline();
    return;
  }

  // A submit after a failure is a retry.
  failedPhase.value = null;

  if (dataset.value) {
    // The dataset exists but its upload was interrupted: resume it into the
    // dataset's folder rather than creating another dataset inside it. path
    // points there already, unless reading the folder is what failed.
    phase.value = "creatingDataset";
    if (await enterDatasetFolder(dataset.value)) {
      startUpload();
    }
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
    failPipeline();
    return;
  }

  const datasetName = isBatchMode.value ? currentDatasetName.value : name.value;

  phase.value = "creatingDataset";
  try {
    dataset.value = await store.createDataset({
      name: datasetName,
      description: description.value,
      path: pathForCreation,
    });

    if (dataset.value === null) {
      failedDataset.value = datasetName;
      handleBatchError(`Could not create dataset ${datasetName}`);
      return;
    }

    if (isBatchMode.value) {
      store.addUploadedDataset(dataset.value);
    }

    failedDataset.value = "";
  } catch (error) {
    logError("Failed to create the dataset:", error);
    handleBatchError(`Could not create dataset ${datasetName}`);
    return;
  }

  if (await enterDatasetFolder(dataset.value)) {
    startUpload();
  }
}

// Point the uploader at the dataset's folder. A failed read returns null
// rather than rejecting: path keeps its value, so the uploader stays mounted
// and Upload reads the folder again (see submit). Assigning the null used to
// unmount the uploader and leave Upload enabled with nothing to do.
async function enterDatasetFolder(created: IDataset) {
  const folder = await girderResources.getFolder(created.id);
  if (!folder) {
    logError(`Failed to read the folder of dataset ${created.id}`);
    handleBatchError("Could not open the new dataset's folder");
    return false;
  }
  path.value = folder;
  await nextTick();
  return true;
}

// Upload the selected files into the dataset's folder (path). Files a
// previous attempt already uploaded are skipped and interrupted ones resume.
function startUpload() {
  if (!uploader.value) {
    logError("Uploader component not available after dataset creation");
    failPipeline();
    return;
  }
  phase.value = "uploading";
  uploader.value.startUpload();
}

async function configureDatasetWithStrategy() {
  phase.value = "readingFiles";
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
  try {
    await config.reinitializeAndApplyStrategy(strategy);
  } catch (error) {
    logError("Failed to read the dataset's files:", error);
    generationFailed(initFailureMessage(config, error));
    return;
  }
  phase.value = "configuring";
  progressStatusText.value = strategy.transcode
    ? "Transcoding..."
    : "Generating configuration...";
  config.submit();
}

// What to show when MultiSourceConfiguration could not read the files.
function initFailureMessage(
  config: InstanceType<typeof MultiSourceConfiguration>,
  error: unknown,
): string {
  const initError = config.initError;
  const reason = initError
    ? `${initError.name}: ${initError.message}`
    : error instanceof Error
      ? error.message
      : String(error);
  return `Could not read the dataset's files (${reason})`;
}

async function advanceToNextDataset() {
  if (isLastDataset.value) {
    navigateToCollection();
    return;
  }

  store.advanceUploadDatasetIndex();

  // Everything the pipeline sets for one dataset.
  phase.value = "idle";
  failedPhase.value = null;
  dataset.value = null;
  failedDataset.value = "";
  configurationLogs.value = "";
  transcodeProgress.value = undefined;
  progressStatusText.value = "";
  totalFrames.value = 0;
  currentFrame.value = 0;
  processingError.value = null;

  if (!store.uploadWorkflow.originalPath) {
    logError(
      "[Batch Mode] ERROR: originalPath is not set in store, cannot continue",
    );
    failPipeline();
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
    router.push({
      name: "configuration",
      params: { configurationId: collection.id },
    });
  } else if (datasets && datasets.length > 0) {
    router.push({
      name: "dataset",
      params: { datasetId: datasets[0].id },
    });
  } else {
    router.push({
      name: "root",
    });
  }
}

// Called when MultiSourceConfiguration fails to configure/transcode the
// dataset (e.g. the transcoding job failed because the storage quota was
// exceeded). Stops the spinner and surfaces the reason to the user.
function generationFailed(message: string) {
  processingError.value = message;
  handleBatchError(message);
}

// Every failure of the pipeline lands here. A single dataset stops with the
// form available for a retry; a batch asks whether to skip this dataset.
function handleBatchError(message: string) {
  if (!isBatchMode.value) {
    failPipeline();
    return;
  }

  phase.value = "idle";
  batchErrorMessage.value = message;
  showBatchErrorDialog.value = true;
}

function handleStopBatch() {
  showBatchErrorDialog.value = false;
  failPipeline();

  const collection = store.uploadWorkflow.collection;
  const datasets = [...store.uploadWorkflow.datasets];

  store.completeUploadWorkflow();

  if (collection && datasets.length > 0) {
    router.push({
      name: "configuration",
      params: { configurationId: collection.id },
    });
  } else if (datasets.length > 0) {
    router.push({
      name: "dataset",
      params: { datasetId: datasets[0].id },
    });
  } else {
    router.push({ name: "root" });
  }
}

function handleContinueBatch() {
  showBatchErrorDialog.value = false;
  skippedDatasets.value.push(store.uploadWorkflow.currentDatasetIndex);

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
      failPipeline();
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

// The uploader reports each file that fails. Upload then resumes into the
// same dataset (see submit).
function interruptedUpload() {
  handleBatchError("The upload was interrupted");
}

// The uploader's own "Resume Upload" button, shown beside its error, calls
// its startUpload directly, past submit(). Follow it into the uploading
// phase, or the failure it resumes from would outlive a successful upload:
// the import would go on under "Quick Import Failed", and a later failure
// would be recorded as this one.
watch(
  () => uploader.value?.uploading,
  (uploaderRunning) => {
    if (uploaderRunning && phase.value === "idle") {
      if (failedPhase.value === "uploading") {
        failedPhase.value = null;
      }
      phase.value = "uploading";
    }
  },
);

function nextStep() {
  hideUploader.value = true;
  phase.value = "idle";
  // Every file is uploaded, so no upload failure is current: one reported
  // late by a worker of the attempt this upload resumed from would
  // otherwise label the rest of the import as failed.
  if (failedPhase.value === "uploading") {
    failedPhase.value = null;
  }

  if (!dataset.value) {
    logError("nextStep called but dataset is null");
    failPipeline();
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
    router.push({
      name: "multi",
      params: { datasetId: dsId },
    });
  }

  emit("datasetUploaded", dsId);
}

async function configureDataset() {
  phase.value = "readingFiles";
  await nextTick();
  const config = configuration.value;
  if (!config) {
    logError(
      "MultiSourceConfiguration component not mounted during quickupload",
    );
    handleBatchError("Configuration component not ready");
    return;
  }
  try {
    await (config.initialized || config.initialize());
  } catch (error) {
    logError("Failed to read the dataset's files:", error);
    generationFailed(initFailureMessage(config, error));
    return;
  }
  phase.value = "configuring";

  if (isQuickImport.value) {
    config.submit();
  }
}

// Read the uploaded files again: a fresh MultiSourceConfiguration mounts
// for the dataset that already holds them, so nothing is uploaded or
// created twice.
function retryReadingFiles() {
  if (!canRetryReadingFiles.value) {
    return;
  }
  failedPhase.value = null;
  processingError.value = null;
  configurationLogs.value = "";
  configureDataset();
}

function goHome() {
  router.push({ name: "root" });
}

// MultiSourceConfiguration emits generatedJson only on success; a failure
// arrives as generationError (generationFailed).
function generationDone() {
  if (isBatchMode.value) {
    return handleCollectionGenerationDone();
  } else if (isQuickImport.value) {
    return createView();
  } else {
    return;
  }
}

async function handleCollectionGenerationDone() {
  if (isFirstDataset.value) {
    await store.setSelectedDataset(dataset.value!.id);
    if (!(await createCollection())) {
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

  advanceToNextDataset();
}

async function createView() {
  await store.setSelectedDataset(dataset.value!.id);

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

  phase.value = "creatingView";
  await nextTick();
  const vc = viewCreation.value;
  if (!vc) {
    logError("DatasetInfo component not mounted during quickupload");
    failPipeline();
    return;
  }
  const defaultView = await vc.createDefaultView();
  if (!defaultView) {
    // DatasetInfo stays on screen (failedPhase) to create a view by hand.
    logError("Failed to create default view during quick upload");
    failPipeline();
    return;
  }
  store.setDatasetViewId({ id: defaultView.id });
  const route = vc.toRoute(defaultView);
  phase.value = "idle";

  router.push(route);
}

function copyLogToClipboard() {
  if (navigator.clipboard && configurationLogs.value) {
    navigator.clipboard.writeText(configurationLogs.value);
    showCopySnackbar.value = true;
  }
}

// --- Watchers ---
watch(name, () => {
  failedDataset.value = "";
});

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

  if (!path.value) {
    try {
      const privateFolder = await store.api.getUserPrivateFolder();
      if (!path.value) {
        path.value = privateFolder;
      }
    } catch (error) {
      logError(error);
    }
  }

  maxApiKeyFileSize.value = await getMaxUploadSize();

  if (store.girderUser) {
    storageQuota.value = await store.api.getUserStorageQuota(
      store.girderUser._id,
    );
  }
});

// Leaving the page ends the upload workflow, whichever way it went: a later
// mount (Back to this route, or the uploader embedded in
// AddDatasetToCollection) must not pick up its files and mode.
onBeforeUnmount(() => {
  if (store.uploadWorkflow.active) {
    store.completeUploadWorkflow();
  }
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
  phase,
  failedPhase,
  canRetryReadingFiles,
  retryReadingFiles,
  goHome,
  uploadDisabled,
  startUpload,
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
  processingError,
  storageQuota,
  storageUsageString,
  storageWarningMessage,
  generationFailed,
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

.new-dataset-primary-dropzone {
  height: 100%;
}

.job-log {
  max-height: 400px;
  min-height: 200px;
  overflow-y: auto;
  white-space: pre-wrap;
  font-family: var(--nimbus-font-mono);
  font-size: 12px;
  background-color: var(--nimbus-glass);
  border: 1px solid var(--nimbus-border);
  padding: 12px;
  border-radius: var(--nimbus-radius-sm);
  width: 100%;
  color: var(--nimbus-text-secondary);
}
</style>

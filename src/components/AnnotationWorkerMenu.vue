<template>
  <v-card :class="{ menu: true, loaded: !fetchingWorkerInterface }" v-if="tool">
    <v-card-title class="subtitle-1">
      {{ tool.name || "Worker menu" }}
      <v-spacer />
      <v-btn small text class="mr-2" @click="resetInterfaceValues()">
        <v-icon small left>mdi-refresh</v-icon>
        Reset
      </v-btn>
      <v-icon
        @click="updateInterface(true)"
        v-tooltip="'Refresh worker interface from the server'"
      >
        mdi-sync
      </v-icon>
    </v-card-title>
    <v-card-subtitle v-if="tool.values.image.image" class="pt-0 pb-2">
      <small>Image: {{ tool.values.image.image }}</small>
    </v-card-subtitle>
    <v-card-text>
      <v-container v-if="fetchingWorkerInterface">
        <v-progress-circular indeterminate />
      </v-container>
      <v-container v-else>
        <v-row v-if="running">
          <v-progress-linear
            :indeterminate="!progressInfo.progress"
            :value="100 * (progressInfo.progress || 0)"
            class="text-progress"
          >
            <strong class="pr-4">
              {{ progressInfo.title }}
            </strong>
            {{ progressInfo.info }}
          </v-progress-linear>
        </v-row>
        <v-row
          v-for="(warning, index) in filteredWarnings"
          :key="'warning-' + index"
        >
          <v-alert type="warning" dense class="mb-2">
            <div class="error-main">
              {{ warning.title }}: {{ warning.warning }}
            </div>
            <div v-if="warning.info" class="error-info">{{ warning.info }}</div>
          </v-alert>
        </v-row>
        <v-row v-for="(error, index) in filteredErrors" :key="'error-' + index">
          <v-alert type="error" dense class="mb-2">
            <div class="error-main">{{ error.title }}: {{ error.error }}</div>
            <div v-if="error.info" class="error-info">{{ error.info }}</div>
          </v-alert>
        </v-row>
        <v-row>
          <worker-interface-values
            v-if="workerInterface"
            :workerInterface="workerInterface"
            :tool="tool"
            v-model="interfaceValues"
            tooltipPosition="right"
          />
        </v-row>
        <v-row>
          <v-btn @click="preview" v-if="hasPreview">Preview</v-btn>
          <v-spacer></v-spacer>
          <v-btn
            v-if="localJobLog"
            small
            text
            color="info"
            class="mr-2"
            @click="showLogDialog = true"
          >
            <v-icon small left>mdi-text-box-outline</v-icon>
            Log
          </v-btn>
          <v-btn @click="compute" v-if="!running">
            <v-icon v-if="previousRunStatus === false">mdi-close</v-icon>
            <v-icon v-if="previousRunStatus === true">mdi-check</v-icon>
            <span>Compute</span>
          </v-btn>
          <v-btn
            v-else
            @click="cancel"
            color="orange"
            :disabled="!currentJob && !batchCancelFunction"
          >
            <v-progress-circular size="16" indeterminate />
            <span>Cancel{{ batchCancelFunction ? " All" : "" }}</span>
          </v-btn>
        </v-row>
        <v-row>
          <v-checkbox
            v-if="hasPreview"
            v-model="displayWorkerPreview"
            label="Display Previews"
          ></v-checkbox>
        </v-row>
        <!-- Batch processing checkbox -->
        <v-row v-if="canApplyToAllDatasets || batchDisabledReason">
          <v-tooltip bottom :disabled="!batchDisabledReason">
            <template v-slot:activator="{ on, attrs }">
              <div v-bind="attrs" v-on="on" style="width: 100%">
                <v-checkbox
                  v-model="applyToAllDatasets"
                  :disabled="!canApplyToAllDatasets || running"
                  :label="`Apply to all datasets in collection (${collectionDatasetCount})`"
                  class="mt-0"
                ></v-checkbox>
              </div>
            </template>
            <span>{{ batchDisabledReason }}</span>
          </v-tooltip>
        </v-row>
        <!-- Batch progress display -->
        <v-row v-if="batchProgress">
          <v-col cols="12" class="pa-0">
            <div class="batch-progress-header mb-2">
              <strong>Batch Progress:</strong>
              {{
                batchProgress.completed +
                batchProgress.failed +
                batchProgress.cancelled
              }}
              / {{ batchProgress.total }} datasets
              <span v-if="batchProgress.failed > 0" class="error--text">
                ({{ batchProgress.failed }} failed)
              </span>
              <span v-if="batchProgress.cancelled > 0" class="warning--text">
                ({{ batchProgress.cancelled }} cancelled)
              </span>
            </div>
            <v-progress-linear
              :value="batchProgressPercent"
              color="primary"
              height="20"
              striped
            >
              <template v-slot:default>
                <strong>{{ Math.round(batchProgressPercent) }}%</strong>
              </template>
            </v-progress-linear>
            <div class="batch-current-dataset mt-1">
              <small>Current: {{ batchProgress.currentDatasetName }}</small>
            </div>
          </v-col>
        </v-row>
      </v-container>
    </v-card-text>

    <!-- Log Dialog -->
    <v-dialog v-model="showLogDialog" max-width="800px">
      <v-card>
        <v-card-title class="headline">
          Job Log
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
          <pre class="job-log">{{ jobLog }}</pre>
        </v-card-text>
        <v-card-actions>
          <v-spacer></v-spacer>
          <v-btn color="primary" text @click="showLogDialog = false"
            >Close</v-btn
          >
        </v-card-actions>
        <!-- Snackbar for copy notification -->
        <v-snackbar
          v-model="showCopySnackbar"
          :timeout="2000"
          color="success"
          top
        >
          Log copied to clipboard
        </v-snackbar>
      </v-card>
    </v-dialog>
  </v-card>
</template>

<script lang="ts" setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import store from "@/store";
import annotationsStore from "@/store/annotation";
import {
  IComputeJob,
  IProgressInfo,
  IToolConfiguration,
  IWorkerInterfaceValues,
  IErrorInfoList,
  MessageType,
} from "@/store/model";
import propertiesStore from "@/store/properties";
import jobsStore from "@/store/jobs";
import WorkerInterfaceValues from "@/components/WorkerInterfaceValues.vue";
import { getDefault } from "@/utils/workerInterface";
import { debounce } from "lodash";
import { logError } from "@/utils/log";

const props = defineProps<{
  tool: IToolConfiguration;
}>();

const emit = defineEmits<{
  (e: "loaded"): void;
}>();

// Create a debounced version of editToolInConfiguration
const debouncedEditTool = debounce((tool: IToolConfiguration) => {
  store.editToolInConfiguration(tool);
}, 300);

// Data
const fetchingWorkerInterface = ref(false);
const running = ref(false);
const currentJob = ref<IComputeJob | null>(null);
const previousRunStatus = ref<boolean | null>(null);
const progressInfo = ref<IProgressInfo>({});
const errorInfo = ref<IErrorInfoList>({ errors: [] });
const interfaceValues = ref<IWorkerInterfaceValues>({});
const showLogDialog = ref(false);
const localJobLog = ref("");
const showCopySnackbar = ref(false);

// Batch processing state
const applyToAllDatasets = ref(false);
const batchProgress = ref<{
  total: number;
  completed: number;
  failed: number;
  cancelled: number;
  currentDatasetName: string;
} | null>(null);
const batchCancelFunction = ref<(() => void) | null>(null);
const collectionDatasetCount = ref(0);
const loadingDatasetCount = ref(false);

const BATCH_DATASET_LIMIT = 10;

onBeforeUnmount(() => {
  debouncedEditTool.cancel();
});

// Computeds
const workerInterface = computed(() => {
  return propertiesStore.getWorkerInterface(image.value);
});

const image = computed(() => {
  return props.tool?.values?.image?.image;
});

const workerPreview = computed(() => {
  return (
    propertiesStore.getWorkerPreview(image.value) || {
      text: "null",
      image: "",
    }
  );
});

const displayWorkerPreview = computed({
  get: () => propertiesStore.displayWorkerPreview,
  set: (value: boolean) => {
    propertiesStore.setDisplayWorkerPreview(value);
  },
});

const currentJobId = computed(() => {
  return props.tool ? jobsStore.jobIdForToolId[props.tool.id] : null;
});

const canApplyToAllDatasets = computed(() => {
  return (
    store.selectedConfigurationId !== null &&
    collectionDatasetCount.value > 1 &&
    collectionDatasetCount.value <= BATCH_DATASET_LIMIT
  );
});

const batchDisabledReason = computed(() => {
  if (!store.selectedConfigurationId) {
    return null;
  }
  if (loadingDatasetCount.value) {
    return null;
  }
  if (collectionDatasetCount.value <= 1) {
    return null;
  }
  if (collectionDatasetCount.value > BATCH_DATASET_LIMIT) {
    return `Collection has more than ${BATCH_DATASET_LIMIT} datasets`;
  }
  return null;
});

const batchProgressPercent = computed(() => {
  if (!batchProgress.value || batchProgress.value.total === 0) {
    return 0;
  }
  const { completed, failed, cancelled, total } = batchProgress.value;
  return ((completed + failed + cancelled) / total) * 100;
});

// Refactored: jobLog side-effect extracted to watch
const jobLog = computed(() => {
  if (currentJobId.value) {
    return jobsStore.getJobLog(currentJobId.value);
  }
  return localJobLog.value;
});

// Watch for job log updates and sync to localJobLog
watch(
  [
    currentJobId,
    () => (currentJobId.value ? jobsStore.getJobLog(currentJobId.value) : null),
  ],
  ([jobId, storeLog]) => {
    if (jobId && storeLog && storeLog !== localJobLog.value) {
      if (!localJobLog.value) {
        const timestamp = new Date().toLocaleString();
        localJobLog.value = `=== Job started at ${timestamp} ===\n\n${storeLog}`;
      } else {
        localJobLog.value = storeLog;
      }
    }
  },
);

const hasPreview = computed(() => {
  return propertiesStore.hasPreview(image.value);
});

const filteredErrors = computed(() => {
  return errorInfo.value.errors.filter(
    (error) => error.error && error.type === MessageType.ERROR,
  );
});

const filteredWarnings = computed(() => {
  return errorInfo.value.errors.filter(
    (error) => error.warning && error.type === MessageType.WARNING,
  );
});

// Watchers
watch(
  () => store.selectedConfigurationId,
  () => {
    fetchCollectionDatasetCount();
  },
);

watch(
  interfaceValues,
  () => {
    let tool = props.tool;
    tool.values.workerInterfaceValues = interfaceValues.value;
    debouncedEditTool(tool);
  },
  { deep: true },
);

watch(
  () => props.tool,
  () => {
    updateInterface();
  },
);

// Methods
async function compute() {
  if (running.value) {
    return;
  }
  localJobLog.value = "";
  running.value = true;
  currentJob.value = null;
  previousRunStatus.value = null;

  if (applyToAllDatasets.value && store.selectedConfigurationId) {
    await computeBatch();
  } else {
    currentJob.value = await annotationsStore.computeAnnotationsWithWorker({
      tool: props.tool,
      workerInterface: interfaceValues.value,
      progress: progressInfo.value,
      error: errorInfo.value,
      callback: (success) => {
        running.value = false;
        previousRunStatus.value = success;
        progressInfo.value = {};
      },
    });
  }
}

async function computeBatch() {
  const configurationId = store.selectedConfigurationId;
  if (!configurationId) {
    running.value = false;
    return;
  }

  batchProgress.value = {
    total: collectionDatasetCount.value,
    completed: 0,
    failed: 0,
    cancelled: 0,
    currentDatasetName: "Starting...",
  };

  await annotationsStore.computeAnnotationsWithWorkerBatch({
    tool: props.tool,
    workerInterface: interfaceValues.value,
    configurationId,
    onBatchProgress: (status) => {
      batchProgress.value = status;
    },
    onJobProgress: (_datasetId, progressInfoUpdate) => {
      Object.assign(progressInfo.value, progressInfoUpdate);
    },
    onJobError: (_datasetId, errorInfoUpdate) => {
      errorInfo.value.errors.push(...errorInfoUpdate.errors);
    },
    onCancel: (cancel) => {
      batchCancelFunction.value = cancel;
    },
    onComplete: (results) => {
      running.value = false;
      batchCancelFunction.value = null;
      previousRunStatus.value = results.succeeded > 0 && results.failed === 0;
      progressInfo.value = {};
      setTimeout(() => {
        batchProgress.value = null;
      }, 3000);
    },
  });
}

function cancel() {
  if (batchCancelFunction.value) {
    batchCancelFunction.value();
    return;
  }

  const jobId = currentJob.value?.jobId;
  if (!jobId) {
    return;
  }
  store.api.cancelJob(jobId);
}

function preview() {
  propertiesStore.requestWorkerPreview({
    image: image.value,
    tool: props.tool,
    workerInterface: interfaceValues.value,
  });
}

async function fetchCollectionDatasetCount() {
  loadingDatasetCount.value = true;
  try {
    collectionDatasetCount.value = await store.getCollectionDatasetCount();
  } catch (error) {
    logError("Failed to fetch collection dataset count:", error);
    collectionDatasetCount.value = 0;
  } finally {
    loadingDatasetCount.value = false;
  }
}

function resetInterfaceValues() {
  const values: IWorkerInterfaceValues = {};
  if (workerInterface.value) {
    for (const id in workerInterface.value) {
      const interfaceTemplate = workerInterface.value[id];
      values[id] = getDefault(
        interfaceTemplate.type,
        interfaceTemplate.default,
      );
    }
  }
  interfaceValues.value = values;
}

async function updateInterface(force?: boolean) {
  propertiesStore.fetchWorkerImageList();
  if (
    (force || workerInterface.value === undefined) &&
    !fetchingWorkerInterface.value
  ) {
    fetchingWorkerInterface.value = true;
    await propertiesStore
      .fetchWorkerInterface({ image: image.value, force })
      .finally();
    fetchingWorkerInterface.value = false;
    emit("loaded");
  }
}

function copyLogToClipboard() {
  const log = jobLog.value;
  if (log) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard
        .writeText(log)
        .then(() => {
          showCopySnackbar.value = true;
        })
        .catch(() => {
          copyToClipboardFallback(log);
        });
    } else {
      copyToClipboardFallback(log);
    }
  }
}

function copyToClipboardFallback(text: string) {
  const tempTextArea = document.createElement("textarea");
  tempTextArea.value = text;
  tempTextArea.style.position = "fixed";
  document.body.appendChild(tempTextArea);
  tempTextArea.select();

  try {
    document.execCommand("copy");
    showCopySnackbar.value = true;
  } catch (err) {
    logError("Failed to copy text: ", err);
  }

  document.body.removeChild(tempTextArea);
}

onMounted(() => {
  if (props.tool.values.workerInterfaceValues) {
    interfaceValues.value = props.tool.values.workerInterfaceValues;
  }
  updateInterface();
  fetchCollectionDatasetCount();
});

defineExpose({
  fetchingWorkerInterface,
  running,
  currentJob,
  previousRunStatus,
  progressInfo,
  errorInfo,
  interfaceValues,
  showLogDialog,
  localJobLog,
  showCopySnackbar,
  applyToAllDatasets,
  batchProgress,
  batchCancelFunction,
  collectionDatasetCount,
  loadingDatasetCount,
  workerInterface,
  image,
  workerPreview,
  displayWorkerPreview,
  currentJobId,
  canApplyToAllDatasets,
  batchDisabledReason,
  batchProgressPercent,
  jobLog,
  hasPreview,
  filteredErrors,
  filteredWarnings,
  compute,
  computeBatch,
  cancel,
  preview,
  fetchCollectionDatasetCount,
  resetInterfaceValues,
  updateInterface,
  copyLogToClipboard,
});
</script>

<style lang="scss" scoped>
.menu {
  border: solid 1px rgba(255, 255, 255, 0.8);
  box-shadow:
    0 12px 24px rgba(0, 0, 0, 0.8),
    0 4px 8px rgba(0, 0, 0, 0.6);
  min-height: 600px;

  :deep(.v-card__text) {
    max-height: 600px;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: rgba(255, 255, 255, 0.3) rgba(0, 0, 0, 0.2);

    &::-webkit-scrollbar {
      width: 8px;
    }

    &::-webkit-scrollbar-track {
      background: rgba(0, 0, 0, 0.2);
      border-radius: 4px;
    }

    &::-webkit-scrollbar-thumb {
      background-color: rgba(255, 255, 255, 0.3);
      border-radius: 4px;

      &:hover {
        background-color: rgba(255, 255, 255, 0.4);
      }
    }
  }
}
// Set min-height to 0 when loaded
.loaded {
  min-height: 0;
}

.error-main {
  font-weight: 500;
  max-width: 300px;
}

.error-info {
  font-size: 0.875em;
  margin-top: 4px;
  max-width: 300px;
  word-wrap: break-word; /* Ensures long words don't overflow */
  opacity: 0.9;
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

.batch-progress-header {
  font-size: 0.875em;
}

.batch-current-dataset {
  opacity: 0.7;
}
</style>

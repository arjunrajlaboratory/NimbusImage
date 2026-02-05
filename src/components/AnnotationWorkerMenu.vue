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

<script lang="ts">
import { Vue, Component, Watch, Prop } from "vue-property-decorator";
import store from "@/store";
import annotationsStore from "@/store/annotation";
import {
  IComputeJob,
  IProgressInfo,
  IToolConfiguration,
  IWorkerInterfaceValues,
  IErrorInfoList,
  MessageType,
  IDatasetView,
} from "@/store/model";
import TagFilterEditor from "@/components/AnnotationBrowser/TagFilterEditor.vue";
import LayerSelect from "@/components/LayerSelect.vue";
import propertiesStore from "@/store/properties";
import jobsStore from "@/store/jobs";
import WorkerInterfaceValues from "@/components/WorkerInterfaceValues.vue";
import { getDefault } from "@/utils/workerInterface";
import { debounce } from "lodash";
import { logError } from "@/utils/log";
// Popup for new tool configuration
@Component({
  components: {
    LayerSelect,
    TagFilterEditor,
    WorkerInterfaceValues,
  },
})
export default class AnnotationWorkerMenu extends Vue {
  readonly store = store;
  readonly annotationsStore = annotationsStore;
  readonly propertyStore = propertiesStore;
  readonly jobsStore = jobsStore;

  // Create a debounced version of editToolInConfiguration
  debouncedEditTool = debounce((tool: IToolConfiguration) => {
    this.store.editToolInConfiguration(tool);
  }, 300);

  fetchingWorkerInterface: boolean = false;
  running: boolean = false;
  currentJob: IComputeJob | null = null;
  previousRunStatus: boolean | null = null;
  progressInfo: IProgressInfo = {};
  errorInfo: IErrorInfoList = { errors: [] };
  interfaceValues: IWorkerInterfaceValues = {};
  showLogDialog: boolean = false;
  localJobLog: string = "";
  showCopySnackbar: boolean = false;

  // Batch processing state
  applyToAllDatasets: boolean = false;
  batchProgress: {
    total: number;
    completed: number;
    failed: number;
    cancelled: number;
    currentDatasetName: string;
  } | null = null;
  batchCancelFunction: (() => void) | null = null;
  collectionDatasetCount: number = 0;
  loadingDatasetCount: boolean = false;

  // TODO: This limit can be increased or removed once batch processing is proven stable
  readonly BATCH_DATASET_LIMIT = 10;

  beforeDestroy() {
    // Cancel any pending debounced calls
    this.debouncedEditTool.cancel();
  }

  @Prop()
  readonly tool!: IToolConfiguration;

  get workerInterface() {
    return this.propertyStore.getWorkerInterface(this.image);
  }

  get image() {
    return this.tool?.values?.image?.image;
  }

  get workerPreview() {
    return (
      this.propertyStore.getWorkerPreview(this.image) || {
        text: "null",
        image: "",
      }
    );
  }

  get displayWorkerPreview() {
    return this.propertyStore.displayWorkerPreview;
  }

  set displayWorkerPreview(value: boolean) {
    this.propertyStore.setDisplayWorkerPreview(value);
  }

  get currentJobId() {
    return this.tool ? this.jobsStore.jobIdForToolId[this.tool.id] : null;
  }

  get canApplyToAllDatasets(): boolean {
    // Only show checkbox if there's a configuration and dataset count is loaded
    // and within the limit
    return (
      this.store.selectedConfigurationId !== null &&
      this.collectionDatasetCount > 1 &&
      this.collectionDatasetCount <= this.BATCH_DATASET_LIMIT
    );
  }

  get batchDisabledReason(): string | null {
    if (!this.store.selectedConfigurationId) {
      return "No collection selected";
    }
    if (this.collectionDatasetCount <= 1) {
      return "Collection has only one dataset";
    }
    if (this.collectionDatasetCount > this.BATCH_DATASET_LIMIT) {
      return `Collection has more than ${this.BATCH_DATASET_LIMIT} datasets`;
    }
    return null;
  }

  get batchProgressPercent(): number {
    if (!this.batchProgress || this.batchProgress.total === 0) {
      return 0;
    }
    const { completed, failed, cancelled, total } = this.batchProgress;
    return ((completed + failed + cancelled) / total) * 100;
  }

  get jobLog() {
    if (this.currentJobId) {
      // Update local log from store when a job is running
      const storeLog = this.jobsStore.getJobLog(this.currentJobId);
      if (storeLog && storeLog !== this.localJobLog) {
        // If the log is empty, add a header with timestamp
        if (!this.localJobLog) {
          const timestamp = new Date().toLocaleString();
          this.localJobLog = `=== Job started at ${timestamp} ===\n\n${storeLog}`;
        } else {
          this.localJobLog = storeLog;
        }
      }
      return storeLog;
    }
    // Return local log when no current job (job completed)
    return this.localJobLog;
  }

  @Watch("interfaceValues", { deep: true })
  onInterfaceValuesChanged() {
    let tool = this.tool; // Copy the tool object because it's a readonly prop
    tool.values.workerInterfaceValues = this.interfaceValues;
    this.debouncedEditTool(tool);
  }

  async compute() {
    if (this.running) {
      return;
    }
    this.localJobLog = "";
    this.running = true;
    this.currentJob = null;
    this.previousRunStatus = null;

    if (this.applyToAllDatasets && this.store.selectedConfigurationId) {
      // Batch mode
      await this.computeBatch();
    } else {
      // Single dataset mode
      this.currentJob =
        await this.annotationsStore.computeAnnotationsWithWorker({
          tool: this.tool,
          workerInterface: this.interfaceValues,
          progress: this.progressInfo,
          error: this.errorInfo,
          callback: (success) => {
            this.running = false;
            this.previousRunStatus = success;
            this.progressInfo = {};
          },
        });
    }
  }

  async computeBatch() {
    const configurationId = this.store.selectedConfigurationId;
    if (!configurationId) {
      this.running = false;
      return;
    }

    this.batchProgress = {
      total: this.collectionDatasetCount,
      completed: 0,
      failed: 0,
      cancelled: 0,
      currentDatasetName: "Starting...",
    };

    const { cancel } =
      await this.annotationsStore.computeAnnotationsWithWorkerBatch({
        tool: this.tool,
        workerInterface: this.interfaceValues,
        configurationId,
        onBatchProgress: (status) => {
          this.batchProgress = status;
        },
        onJobProgress: (_datasetId, progressInfo) => {
          // Update progress info for current job display
          Object.assign(this.progressInfo, progressInfo);
        },
        onJobError: (_datasetId, errorInfo) => {
          // Accumulate errors from all jobs
          this.errorInfo.errors.push(...errorInfo.errors);
        },
        onComplete: (results) => {
          this.running = false;
          this.batchCancelFunction = null;
          // Consider it a success if at least one succeeded and none failed
          this.previousRunStatus =
            results.succeeded > 0 && results.failed === 0;
          this.progressInfo = {};
          // Keep batch progress visible for a moment so user can see final state
          setTimeout(() => {
            this.batchProgress = null;
          }, 3000);
        },
      });

    this.batchCancelFunction = cancel;
  }

  cancel() {
    // Handle batch cancellation
    if (this.batchCancelFunction) {
      this.batchCancelFunction();
      return;
    }

    // Handle single job cancellation
    const jobId = this.currentJob?.jobId;
    if (!jobId) {
      return;
    }
    this.store.api.cancelJob(jobId);
  }

  preview() {
    this.propertyStore.requestWorkerPreview({
      image: this.image,
      tool: this.tool,
      workerInterface: this.interfaceValues,
    });
  }

  mounted() {
    if (this.tool.values.workerInterfaceValues) {
      this.interfaceValues = this.tool.values.workerInterfaceValues;
    }
    this.updateInterface();
    this.fetchCollectionDatasetCount();
  }

  async fetchCollectionDatasetCount() {
    const configurationId = this.store.selectedConfigurationId;
    if (!configurationId) {
      this.collectionDatasetCount = 0;
      return;
    }

    this.loadingDatasetCount = true;
    try {
      const views: IDatasetView[] = await this.store.api.findDatasetViews({
        configurationId,
      });
      // Get unique dataset IDs
      const uniqueDatasetIds = new Set(views.map((v) => v.datasetId));
      this.collectionDatasetCount = uniqueDatasetIds.size;
    } catch (error) {
      logError("Failed to fetch collection dataset count:", error);
      this.collectionDatasetCount = 0;
    } finally {
      this.loadingDatasetCount = false;
    }
  }

  resetInterfaceValues() {
    const interfaceValues: IWorkerInterfaceValues = {};
    if (this.workerInterface) {
      for (const id in this.workerInterface) {
        const interfaceTemplate = this.workerInterface[id];
        interfaceValues[id] = getDefault(
          interfaceTemplate.type,
          interfaceTemplate.default,
        );
      }
    }
    this.interfaceValues = interfaceValues;
  }

  @Watch("tool")
  async updateInterface(force?: boolean) {
    this.propertyStore.fetchWorkerImageList(); // Required to update docker image labels
    if (
      (force || this.workerInterface === undefined) &&
      !this.fetchingWorkerInterface
    ) {
      this.fetchingWorkerInterface = true;
      await this.propertyStore
        .fetchWorkerInterface({ image: this.image, force })
        .finally();
      this.fetchingWorkerInterface = false;
      // This "loaded" event is used to trigger the updateDimensions method on the menu
      // That way, the menu will rescale appropriately once the elements are loaded
      this.$emit("loaded");
    }
  }

  get hasPreview() {
    return this.propertyStore.hasPreview(this.image);
  }

  get filteredErrors() {
    return this.errorInfo.errors.filter(
      (error) => error.error && error.type === MessageType.ERROR,
    );
  }

  get filteredWarnings() {
    return this.errorInfo.errors.filter(
      (error) => error.warning && error.type === MessageType.WARNING,
    );
  }

  copyLogToClipboard() {
    const log = this.jobLog;
    if (log) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard
          .writeText(log)
          .then(() => {
            this.showCopySnackbar = true;
          })
          .catch(() => {
            // Fallback for browsers that don't support the Clipboard API
            this.copyToClipboardFallback(log);
          });
      } else {
        // Fallback for older browsers
        this.copyToClipboardFallback(log);
      }
    }
  }

  copyToClipboardFallback(text: string) {
    const tempTextArea = document.createElement("textarea");
    tempTextArea.value = text;
    tempTextArea.style.position = "fixed"; // Avoid scrolling to bottom
    document.body.appendChild(tempTextArea);
    tempTextArea.select();

    try {
      document.execCommand("copy");
      this.showCopySnackbar = true;
    } catch (err) {
      logError("Failed to copy text: ", err);
    }

    document.body.removeChild(tempTextArea);
  }
}
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

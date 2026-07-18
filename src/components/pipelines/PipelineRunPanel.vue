<template>
  <v-container class="pa-0">
    <v-alert
      v-for="(warning, index) in preRunWarnings"
      :key="'warning-' + index"
      type="warning"
      density="compact"
      class="mb-2"
    >
      {{ warning }}
    </v-alert>

    <v-row class="my-0" dense>
      <v-col class="py-1">
        <v-checkbox
          v-model="continueOnError"
          label="Continue running remaining steps if a step fails"
          density="compact"
          hide-details
          :disabled="isRunning"
        />
      </v-col>
    </v-row>

    <v-row
      v-if="canApplyToAllDatasets || batchDisabledReason"
      class="my-0"
      dense
    >
      <v-col class="py-1">
        <v-tooltip location="bottom" :disabled="!batchDisabledReason">
          <template v-slot:activator="{ props: activatorProps }">
            <div v-bind="activatorProps" class="d-inline-block">
              <v-checkbox
                v-model="applyToAllDatasets"
                :label="`Apply to all datasets in collection (${collectionDatasetCount})`"
                :disabled="
                  isRunning || !canApplyToAllDatasets || !!batchProgress
                "
                density="compact"
                hide-details
              />
            </div>
          </template>
          <span>{{ batchDisabledReason }}</span>
        </v-tooltip>
      </v-col>
    </v-row>

    <v-row v-if="batchProgress" class="my-2" dense>
      <v-col class="py-1">
        <div class="text-caption text-medium-emphasis mb-1">
          Datasets:
          {{
            batchProgress.completed +
            batchProgress.failed +
            batchProgress.cancelled
          }}
          / {{ batchProgress.total }}
          <span v-if="batchProgress.failed > 0" class="text-error">
            ({{ batchProgress.failed }} failed)
          </span>
          <span v-if="batchProgress.cancelled > 0" class="text-warning">
            ({{ batchProgress.cancelled }} cancelled)
          </span>
        </div>
        <v-progress-linear
          :model-value="batchPercent"
          color="primary"
          height="10"
          striped
        />
        <div class="text-caption mt-1">
          Current: {{ batchProgress.currentDatasetName }}
        </div>
      </v-col>
    </v-row>

    <v-row
      v-if="!applyToAllDatasets && stepStatuses.length > 0"
      class="my-2"
      dense
    >
      <v-col class="py-1">
        <div class="text-caption text-medium-emphasis mb-1">
          Overall progress: {{ doneCount }} / {{ totalEnabled }} steps
        </div>
        <v-progress-linear
          :model-value="overallPercent"
          color="primary"
          height="10"
        />
      </v-col>
    </v-row>

    <v-list v-if="!applyToAllDatasets" density="compact" class="my-2">
      <v-list-item v-for="(step, index) in pipeline.steps" :key="step.id">
        <template v-slot:prepend>
          <v-progress-circular
            v-if="stepStatuses[index]?.status === 'running'"
            indeterminate
            size="20"
            width="2"
            color="primary"
          />
          <v-icon v-else :color="statusColor(stepStatuses[index]?.status)">
            {{ statusIcon(stepStatuses[index]?.status) }}
          </v-icon>
        </template>
        <template v-slot:append>
          <v-btn
            v-if="stepJobIds[index]"
            variant="text"
            color="info"
            size="small"
            @click="openStepLog(index)"
          >
            <v-icon size="small" start>mdi-text-box-outline</v-icon>
            Logs
          </v-btn>
        </template>
        <v-list-item-title>
          {{ index + 1 }}. {{ step.name || step.image }}
        </v-list-item-title>
        <v-list-item-subtitle v-if="stepStatuses[index]?.status === 'running'">
          <v-progress-linear
            :indeterminate="!stepStatuses[index].progress.progress"
            :model-value="100 * (stepStatuses[index].progress.progress || 0)"
            color="primary"
            height="6"
            class="mt-1"
          />
          <span class="text-caption">
            {{ stepStatuses[index].progress.title }}
            {{ stepStatuses[index].progress.info }}
          </span>
        </v-list-item-subtitle>
        <v-list-item-subtitle
          v-else-if="stepStatuses[index]?.status === 'skipped'"
          class="text-medium-emphasis"
        >
          Skipped (disabled)
        </v-list-item-subtitle>
        <v-list-item-subtitle
          v-else-if="stepStatuses[index]?.status === 'cancelled'"
          class="text-warning"
        >
          Cancelled
        </v-list-item-subtitle>
        <template v-if="stepStatuses[index]?.errors.errors.length">
          <v-alert
            v-for="(err, errIndex) in stepStatuses[index].errors.errors"
            :key="'err-' + errIndex"
            :type="err.type === MessageType.WARNING ? 'warning' : 'error'"
            density="compact"
            class="mt-1"
          >
            {{ err.title ? err.title + ": " : ""
            }}{{ err.error || err.warning }}
          </v-alert>
        </template>
      </v-list-item>
    </v-list>

    <v-row class="my-2" dense>
      <v-col class="d-flex ga-2 py-1 justify-end">
        <v-btn
          v-if="isRunning"
          variant="text"
          color="warning"
          size="small"
          @click="cancel"
        >
          <v-progress-circular size="16" indeterminate class="mr-2" />
          Cancel
        </v-btn>
        <v-btn
          v-else
          variant="flat"
          color="primary"
          size="small"
          :disabled="!canRun"
          @click="run"
        >
          <v-icon start>mdi-play</v-icon>
          Run
        </v-btn>
      </v-col>
    </v-row>

    <v-alert
      v-if="result"
      :type="
        result.failed > 0
          ? 'error'
          : result.cancelled > 0
            ? 'warning'
            : 'success'
      "
      density="compact"
      class="mt-2"
    >
      {{ result.succeeded }}
      {{ lastRunWasBatch ? "datasets" : "steps" }} succeeded,
      {{ result.failed }} failed, {{ result.cancelled }} cancelled.
    </v-alert>

    <job-log-dialog
      v-model="showLogDialog"
      :job-id="logDialogJobId"
      :title="logDialogTitle"
    />
  </v-container>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import store from "@/store";
import pipelinesStore from "@/store/pipelines";
import annotationStore from "@/store/annotation";
import JobLogDialog from "@/components/JobLogDialog.vue";
import { useCollectionDatasetCount } from "@/utils/useCollectionDatasetCount";
import {
  IErrorInfoList,
  IPipeline,
  IPipelineRunResult,
  IProgressInfo,
  MessageType,
} from "@/store/model";

const props = defineProps<{
  pipeline: IPipeline;
}>();

type TStepStatus =
  | "pending"
  | "running"
  | "success"
  | "error"
  | "cancelled"
  | "skipped";

interface IStepRunState {
  status: TStepStatus;
  progress: IProgressInfo;
  errors: IErrorInfoList;
}

const continueOnError = ref(false);
const stepStatuses = ref<IStepRunState[]>([]);
// Backend job id per step (filled in as each step's job is created), so the
// Logs button can show why a worker is stuck or failed.
const stepJobIds = ref<(string | null)[]>([]);
const showLogDialog = ref(false);
const logDialogJobId = ref<string | null>(null);
const logDialogTitle = ref("");
const cancelFn = ref<(() => void) | null>(null);
const cancelledByUser = ref(false);
const result = ref<IPipelineRunResult | null>(null);
const lastRunWasBatch = ref(false);

// Batch (across all datasets in the collection) state.
const applyToAllDatasets = ref(false);
const {
  collectionDatasetCount,
  fetchCollectionDatasetCount,
  canApplyToAllDatasets,
  batchDisabledReason,
} = useCollectionDatasetCount();
const batchProgress = ref<{
  total: number;
  completed: number;
  failed: number;
  cancelled: number;
  currentDatasetName: string;
} | null>(null);

const isRunning = computed(
  () => pipelinesStore.runningPipelineId === props.pipeline.id,
);

const batchPercent = computed(() => {
  if (!batchProgress.value || batchProgress.value.total === 0) return 0;
  const { completed, failed, cancelled, total } = batchProgress.value;
  return ((completed + failed + cancelled) / total) * 100;
});

watch(() => store.selectedConfigurationId, fetchCollectionDatasetCount);
onMounted(fetchCollectionDatasetCount);

const canRun = computed(
  () =>
    pipelinesStore.runningPipelineId === null &&
    props.pipeline.steps.some((step) => step.enabled),
);

const totalEnabled = computed(
  () => props.pipeline.steps.filter((step) => step.enabled).length,
);

const doneCount = computed(
  () =>
    stepStatuses.value.filter((s) =>
      ["success", "error", "cancelled"].includes(s.status),
    ).length,
);

const overallPercent = computed(() =>
  totalEnabled.value === 0 ? 0 : (doneCount.value / totalEnabled.value) * 100,
);

// Non-blocking pre-run validation (WORKER_PIPELINES.md §5): flag property
// steps whose input tags match neither an upstream annotation step's output
// tags nor any tag already present on the dataset. "Upstream" is literal:
// only enabled annotation steps BEFORE the property step count — a disabled
// or later annotation step produces nothing this step could read.
const preRunWarnings = computed<string[]>(() => {
  const warnings: string[] = [];
  const knownTags = new Set<string>(annotationStore.annotationTags);
  props.pipeline.steps.forEach((step, index) => {
    if (step.kind === "annotation") {
      if (step.enabled) {
        step.annotation.tags.forEach((tag) => knownTags.add(tag));
      }
      return;
    }
    if (!step.enabled) {
      return;
    }
    const tags = step.inputTags.tags;
    if (tags.length === 0) {
      return;
    }
    if (!tags.some((tag) => knownTags.has(tag))) {
      warnings.push(
        `Step ${index + 1} (${step.name}): none of its input tags (${tags.join(", ")}) match any upstream output or existing annotation tags — it may compute on nothing.`,
      );
    }
  });
  return warnings;
});

function statusIcon(status?: TStepStatus) {
  switch (status) {
    case "success":
      return "mdi-check-circle";
    case "error":
      return "mdi-close-circle";
    case "cancelled":
      return "mdi-cancel";
    case "skipped":
      return "mdi-minus-circle-outline";
    default:
      return "mdi-circle-outline";
  }
}

function statusColor(status?: TStepStatus) {
  switch (status) {
    case "success":
      return "success";
    case "error":
      return "error";
    case "cancelled":
      return "warning";
    default:
      return undefined;
  }
}

function initStepStatuses() {
  stepStatuses.value = props.pipeline.steps.map((step) => ({
    status: step.enabled ? "pending" : "skipped",
    progress: {},
    errors: { errors: [] },
  }));
  stepJobIds.value = props.pipeline.steps.map(() => null);
}

function openStepLog(index: number) {
  logDialogJobId.value = stepJobIds.value[index];
  logDialogTitle.value = `Step log: ${props.pipeline.steps[index]?.name ?? ""}`;
  showLogDialog.value = true;
}

watch(
  () => props.pipeline.id,
  () => initStepStatuses(),
  { immediate: true },
);

function setStatus(index: number, status: TStepStatus) {
  if (stepStatuses.value[index]) {
    stepStatuses.value[index].status = status;
  }
}

async function run() {
  if (!canRun.value) {
    return;
  }
  result.value = null;
  cancelFn.value = null;
  cancelledByUser.value = false;
  lastRunWasBatch.value = applyToAllDatasets.value;
  initStepStatuses();

  if (applyToAllDatasets.value && store.selectedConfigurationId) {
    await runBatch();
    return;
  }

  await pipelinesStore.runPipeline({
    pipeline: props.pipeline,
    continueOnError: continueOnError.value,
    onStepStart: (index) => setStatus(index, "running"),
    onStepJob: (index, jobId) => {
      if (index < stepJobIds.value.length) {
        stepJobIds.value[index] = jobId;
      }
    },
    onStepProgress: (index, info) => {
      if (stepStatuses.value[index]) {
        stepStatuses.value[index].progress = info;
      }
    },
    onStepError: (index, errors) => {
      if (stepStatuses.value[index]) {
        stepStatuses.value[index].errors = errors;
      }
    },
    onStepComplete: (index, success) => {
      if (success) {
        setStatus(index, "success");
      } else if (cancelledByUser.value) {
        setStatus(index, "cancelled");
      } else {
        setStatus(index, "error");
      }
    },
    onCancel: (cancel) => {
      cancelFn.value = cancel;
    },
    onComplete: (runResult) => {
      result.value = runResult;
      cancelFn.value = null;
    },
  });
}

async function runBatch() {
  const configurationId = store.selectedConfigurationId;
  if (!configurationId) {
    return;
  }
  batchProgress.value = {
    total: collectionDatasetCount.value,
    completed: 0,
    failed: 0,
    cancelled: 0,
    currentDatasetName: "Starting…",
  };
  await pipelinesStore.runPipelineBatch({
    pipeline: props.pipeline,
    configurationId,
    continueOnError: continueOnError.value,
    onBatchProgress: (status) => {
      batchProgress.value = status;
    },
    onCancel: (cancel) => {
      cancelFn.value = cancel;
    },
    onComplete: (summary) => {
      cancelFn.value = null;
      // Reuse the result banner (datasets rather than steps).
      result.value = { ...summary, failedStepIndex: null };
      setTimeout(() => {
        batchProgress.value = null;
      }, 3000);
    },
  });
}

function cancel() {
  cancelledByUser.value = true;
  cancelFn.value?.();
}

defineExpose({
  continueOnError,
  stepStatuses,
  isRunning,
  canRun,
  result,
  run,
  cancel,
});
</script>

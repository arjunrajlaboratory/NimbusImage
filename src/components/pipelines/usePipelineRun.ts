import { computed, InjectionKey, ref } from "vue";
import store from "@/store";
import pipelinesStore from "@/store/pipelines";
import {
  IErrorInfoList,
  IPipeline,
  IPipelineRunResult,
  IProgressInfo,
} from "@/store/model";
import { useCollectionDatasetCount } from "@/utils/useCollectionDatasetCount";

export type TStepStatus =
  | "pending"
  | "running"
  | "success"
  | "error"
  | "cancelled"
  | "skipped";

export interface IStepRunState {
  status: TStepStatus;
  progress: IProgressInfo;
  errors: IErrorInfoList;
}

export interface IBatchRunProgress {
  total: number;
  completed: number;
  failed: number;
  cancelled: number;
  currentDatasetName: string;
}

export function stepStatusIcon(status?: TStepStatus): string {
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

export function stepStatusColor(status?: TStepStatus): string | undefined {
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

// A fresh per-step status baseline for a pipeline that isn't the live run:
// enabled steps are pending, disabled steps are skipped, no progress or errors.
function makeBaselineStatuses(pipeline: IPipeline): IStepRunState[] {
  return pipeline.steps.map((step) => ({
    status: step.enabled ? "pending" : "skipped",
    progress: {},
    errors: { errors: [] },
  }));
}

// Shared run controller for the Pipelines dialog. Instantiated ONCE (in
// PipelineDialog) and provided to the editor and the status strip so both read
// one source of truth for the single in-flight run — and it survives the dialog
// being closed and reopened (the dialog stays mounted). The actual worker
// orchestration + global progress bars live in the pipelines store; this only
// mirrors per-step status for the dialog UI.
export function createPipelineRunController() {
  // Which pipeline the status arrays below describe (the last one run).
  const activePipelineId = ref<string | null>(null);
  const stepStatuses = ref<IStepRunState[]>([]);
  // Backend job id per step, filled as each job is created (drives Logs).
  const stepJobIds = ref<(string | null)[]>([]);
  const result = ref<IPipelineRunResult | null>(null);
  const lastRunWasBatch = ref(false);
  const batchProgress = ref<IBatchRunProgress | null>(null);

  const continueOnError = ref(false);
  const applyToAllDatasets = ref(false);

  const cancelFn = ref<(() => void) | null>(null);
  const cancelledByUser = ref(false);

  const {
    collectionDatasetCount,
    fetchCollectionDatasetCount,
    canApplyToAllDatasets,
    batchDisabledReason,
  } = useCollectionDatasetCount();

  const runningPipelineId = computed(() => pipelinesStore.runningPipelineId);
  const isRunning = computed(() => runningPipelineId.value !== null);

  function isRunningPipeline(id: string): boolean {
    return runningPipelineId.value === id;
  }

  // A pipeline can run when nothing is running and it has an enabled step.
  function canRunPipeline(pipeline: IPipeline): boolean {
    return !isRunning.value && pipeline.steps.some((step) => step.enabled);
  }

  // Per-step status for a given pipeline: the live arrays when it is the active
  // run, otherwise a fresh pending/skipped baseline derived from the steps.
  function statusesFor(pipeline: IPipeline): IStepRunState[] {
    if (activePipelineId.value === pipeline.id && stepStatuses.value.length) {
      return stepStatuses.value;
    }
    return makeBaselineStatuses(pipeline);
  }

  function jobIdFor(pipeline: IPipeline, index: number): string | null {
    if (activePipelineId.value !== pipeline.id) {
      return null;
    }
    return stepJobIds.value[index] ?? null;
  }

  function resetRunState(pipeline: IPipeline) {
    activePipelineId.value = pipeline.id;
    result.value = null;
    cancelFn.value = null;
    cancelledByUser.value = false;
    stepStatuses.value = makeBaselineStatuses(pipeline);
    stepJobIds.value = pipeline.steps.map(() => null);
  }

  function setStatus(index: number, status: TStepStatus) {
    const entry = stepStatuses.value[index];
    if (entry) {
      entry.status = status;
    }
  }

  async function run(pipeline: IPipeline) {
    if (!canRunPipeline(pipeline)) {
      return;
    }
    lastRunWasBatch.value = applyToAllDatasets.value;
    resetRunState(pipeline);

    if (applyToAllDatasets.value && store.selectedConfigurationId) {
      await runBatch(pipeline);
      return;
    }

    await pipelinesStore.runPipeline({
      pipeline,
      continueOnError: continueOnError.value,
      onStepStart: (index) => setStatus(index, "running"),
      onStepJob: (index, jobId) => {
        if (index < stepJobIds.value.length) {
          stepJobIds.value[index] = jobId;
        }
      },
      onStepProgress: (index, info) => {
        const entry = stepStatuses.value[index];
        if (entry) {
          entry.progress = info;
        }
      },
      onStepError: (index, errors) => {
        const entry = stepStatuses.value[index];
        if (entry) {
          entry.errors = errors;
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

  async function runBatch(pipeline: IPipeline) {
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
      pipeline,
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

  // Drop the finished-run summary (and any lingering batch progress) so the
  // status strip stops describing a run that no longer matches what's on
  // screen — e.g. when the editor opens a different pipeline than the last run.
  function clearResult() {
    result.value = null;
    batchProgress.value = null;
  }

  return {
    activePipelineId,
    stepStatuses,
    result,
    lastRunWasBatch,
    batchProgress,
    continueOnError,
    applyToAllDatasets,
    collectionDatasetCount,
    canApplyToAllDatasets,
    batchDisabledReason,
    fetchCollectionDatasetCount,
    runningPipelineId,
    isRunning,
    isRunningPipeline,
    canRunPipeline,
    statusesFor,
    jobIdFor,
    run,
    cancel,
    clearResult,
  };
}

export type PipelineRunController = ReturnType<
  typeof createPipelineRunController
>;

export const PipelineRunControllerKey: InjectionKey<PipelineRunController> =
  Symbol("pipelineRunController");

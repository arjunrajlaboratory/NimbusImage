import {
  getModule,
  Action,
  Module,
  Mutation,
  VuexModule,
} from "vuex-module-decorators";
import { v4 as uuidv4 } from "uuid";
import { cloneDeep, isEqual } from "lodash";

import store from "./root";
import main from "./index";
import annotations from "./annotation";
import properties from "./properties";
import { createProgressEventCallback, createErrorEventCallback } from "./jobs";
import progress from "./progress";
import { BATCH_DATASET_LIMIT } from "./constants";
import { logError } from "@/utils/log";

import {
  AnnotationShape,
  IAnnotationComputeJob,
  IAnnotationPipelineStep,
  IAnnotationProperty,
  IDatasetView,
  IErrorInfoList,
  IJobEventData,
  IPipeline,
  IPipelineRunResult,
  IPropertyComputeJob,
  IPropertyPipelineStep,
  IProgressInfo,
  IToolConfiguration,
  IToolTemplate,
  MessageType,
  ProgressType,
  TPipelineStep,
} from "./model";

// Minimal template used for the transient tools the runner builds. The compute
// path never re-renders the creation UI, so an empty interface is sufficient.
const SEGMENTATION_TEMPLATE: IToolTemplate = {
  name: "Pipeline annotation step",
  type: "segmentation",
  description: "",
  interface: [],
};

// Runtime status for a single step during a run. Held by the UI (via run
// callbacks); not persisted.
export interface IPipelineStepRunStatus {
  status: "pending" | "running" | "success" | "error" | "cancelled" | "skipped";
  progress: IProgressInfo;
  errors: IErrorInfoList;
}

// The runner records `materializedPropertyId` on the *store* copy of a property
// step after a run (see ensureMaterializedProperty). An editor working on a
// separate clone never sees that write-back, so persisting the clone would drop
// the id and orphan the materialized property (a fresh one is created next run).
// Carry each property step's materialized id from `source` (the persisted copy)
// into `target` (the copy about to be saved) by step id. Mutates `target`.
export function mergeMaterializedPropertyIds(
  target: IPipeline,
  source: IPipeline | null | undefined,
): void {
  if (!source) {
    return;
  }
  const sourceStepById = new Map(source.steps.map((step) => [step.id, step]));
  for (const step of target.steps) {
    if (step.kind !== "property") {
      continue;
    }
    const sourceStep = sourceStepById.get(step.id);
    if (sourceStep?.kind === "property" && sourceStep.materializedPropertyId) {
      step.materializedPropertyId = sourceStep.materializedPropertyId;
    }
  }
}

function buildTransientTool(step: IAnnotationPipelineStep): IToolConfiguration {
  return {
    id: step.id,
    name: step.name,
    hotkey: null,
    type: "segmentation",
    values: {
      image: { image: step.image },
      workerInterfaceValues: step.workerInterfaceValues,
      annotation: step.annotation,
      connectTo: step.connectTo ?? {},
      jobDateTag: step.jobDateTag ?? false,
    },
    template: SEGMENTATION_TEMPLATE,
  };
}

@Module({ dynamic: true, store, name: "pipelines" })
export class Pipelines extends VuexModule {
  // Id of the pipeline currently running, or null. Used by the list UI to show
  // a running indicator and to prevent concurrent runs.
  runningPipelineId: string | null = null;

  get pipelines(): IPipeline[] {
    return main.configuration?.pipelines ?? [];
  }

  get getPipelineById() {
    return (id: string) => this.pipelines.find((p) => p.id === id) ?? null;
  }

  @Mutation
  setRunningPipelineId(id: string | null) {
    this.runningPipelineId = id;
  }

  // ---- Factory ----------------------------------------------------------
  // Exposed as getters returning functions so they are reachable both on the
  // module proxy (pipelinesStore.createEmptyPipeline(...)) and inside actions.

  get createEmptyPipeline() {
    return (name = "New pipeline"): IPipeline => ({
      id: uuidv4(),
      name,
      steps: [],
      origin: "user",
    });
  }

  get createStepId() {
    return (): string => uuidv4();
  }

  // ---- Persistence (source of truth is main.configuration.pipelines) ----

  // Upsert a pipeline by id and sync to the backend configuration.
  @Action
  async savePipeline(pipeline: IPipeline) {
    const current = this.pipelines;
    const idx = current.findIndex((p) => p.id === pipeline.id);
    const next =
      idx < 0
        ? [...current, pipeline]
        : current.map((p) => (p.id === pipeline.id ? pipeline : p));
    await main.updateConfigurationPipelines(next);
  }

  // True when some OTHER step (optionally excluding one pipeline / one step)
  // still points its materializedPropertyId at `propertyId`. Used to avoid
  // deleting a property that another pipeline (or another step) relies on.
  get isMaterializedPropertyReferenced() {
    return (
      propertyId: string,
      exclude: { pipelineId?: string; stepId?: string } = {},
    ): boolean =>
      this.pipelines.some(
        (p) =>
          p.id !== exclude.pipelineId &&
          p.steps.some(
            (s) =>
              s.kind === "property" &&
              s.materializedPropertyId === propertyId &&
              s.id !== exclude.stepId,
          ),
      );
  }

  // Delete a pipeline. By default also deletes the persisted properties its
  // property steps materialized (see ensureMaterializedProperty), unless
  // another pipeline's step still references the same property id.
  //
  // Takes a single object payload (rather than two positional parameters)
  // because vuex-module-decorators' dynamic-module action wrapper only
  // forwards ONE payload argument to the underlying method - calling
  // `pipelinesStore.deletePipeline(id, false)` would route through
  // `store.dispatch(type, id, false)`, where Vuex treats the third argument
  // as dispatch *options*, not a second payload, so `false` would never
  // reach this method and the default would always win.
  @Action
  async deletePipeline({
    pipelineId,
    removeMaterializedProperties = true,
  }: {
    pipelineId: string;
    removeMaterializedProperties?: boolean;
  }) {
    const removableIds: string[] = [];
    if (removeMaterializedProperties) {
      const target = this.getPipelineById(pipelineId);
      const materializedPropertyIds = new Set<string>();
      for (const step of target?.steps ?? []) {
        if (step.kind === "property" && step.materializedPropertyId) {
          materializedPropertyIds.add(step.materializedPropertyId);
        }
      }
      removableIds.push(
        ...[...materializedPropertyIds].filter(
          (propertyId) =>
            !this.isMaterializedPropertyReferenced(propertyId, { pipelineId }),
        ),
      );
    }
    await main.updateConfigurationPipelines(
      this.pipelines.filter((p) => p.id !== pipelineId),
    );
    if (removableIds.length > 0) {
      // Persist the pipeline deletion first, so a later cleanup failure can at
      // worst leave an orphan rather than a live step pointing at a property
      // that has already been removed. One batch call means one config sync.
      await properties.deleteProperties(removableIds);
    }
  }

  // Remove materialized properties from deleted property steps after the
  // updated pipeline has been persisted. Properties that another step still
  // references are deliberately retained.
  @Action
  async deleteUnreferencedMaterializedProperties(propertyIds: string[]) {
    const removableIds = [...new Set(propertyIds)].filter(
      (propertyId) => !this.isMaterializedPropertyReferenced(propertyId),
    );
    if (removableIds.length > 0) {
      await properties.deleteProperties(removableIds);
    }
  }

  @Action
  async duplicatePipeline(pipelineId: string): Promise<IPipeline | null> {
    const source = this.getPipelineById(pipelineId);
    if (!source) {
      return null;
    }
    // Fresh ids so the copy is independent; drop materialized property links so
    // the copy creates its own properties on first run.
    const copy: IPipeline = {
      ...cloneDeep(source),
      id: uuidv4(),
      name: `${source.name} (copy)`,
      steps: source.steps.map((s) => {
        const step = { ...cloneDeep(s), id: uuidv4() } as TPipelineStep;
        if (step.kind === "property") {
          delete step.materializedPropertyId;
        }
        return step;
      }),
    };
    await this.savePipeline(copy);
    return copy;
  }

  // ---- Materialized properties ------------------------------------------

  // A property step needs a persisted IAnnotationProperty (the compute endpoint
  // is annotation_property/:id/compute). Reuse the step's materialized property
  // when it still matches; otherwise create a fresh one and remember its id.
  @Action
  async ensureMaterializedProperty(
    step: IPropertyPipelineStep,
  ): Promise<IAnnotationProperty | null> {
    const existing = step.materializedPropertyId
      ? properties.properties.find((p) => p.id === step.materializedPropertyId)
      : undefined;
    const matches =
      !!existing &&
      existing.image === step.image &&
      existing.shape === step.shape &&
      isEqual(existing.tags, step.inputTags) &&
      isEqual(existing.workerInterface, step.workerInterfaceValues);
    if (existing && matches) {
      return existing;
    }
    // If the step pointed at a real, existing property that no longer
    // matches (drift: the step's config changed), remember its id so we can
    // remove it below once the replacement is created. Only ever set for a
    // property that actually existed - never for a stale/dangling id.
    const staleId = existing?.id;
    const created = await properties.createProperty({
      name: step.name,
      image: step.image,
      tags: {
        tags: [...step.inputTags.tags],
        exclusive: step.inputTags.exclusive,
      },
      shape: step.shape,
      workerInterface: step.workerInterfaceValues,
    });
    if (created) {
      step.materializedPropertyId = created.id;
      if (
        staleId &&
        staleId !== created.id &&
        !this.isMaterializedPropertyReferenced(staleId, { stepId: step.id })
      ) {
        await properties.deleteProperty(staleId);
      }
    }
    return created;
  }

  // ---- Runner -----------------------------------------------------------

  @Action
  async runPipeline({
    pipeline,
    datasetId,
    continueOnError = false,
    onStepStart,
    onStepJob,
    onStepProgress,
    onStepError,
    onStepComplete,
    onCancel,
    onComplete,
    skipRefresh = false,
    skipRunningState = false,
  }: {
    pipeline: IPipeline;
    datasetId?: string;
    continueOnError?: boolean;
    onStepStart?: (stepIndex: number, step: TPipelineStep) => void;
    // Fired as soon as a step's backend job is created, so the caller can
    // offer live job-log access (the job id is otherwise runner-internal).
    onStepJob?: (stepIndex: number, jobId: string) => void;
    onStepProgress?: (stepIndex: number, info: IProgressInfo) => void;
    onStepError?: (stepIndex: number, errors: IErrorInfoList) => void;
    onStepComplete?: (stepIndex: number, success: boolean) => void;
    onCancel?: (cancel: () => void) => void;
    onComplete?: (result: IPipelineRunResult) => void;
    // When run as a child of runPipelineBatch: the batch owns the "running"
    // indicator and does a single end-of-batch refresh, so per-dataset runs
    // skip both to avoid flicker and N redundant heavy refreshes.
    skipRunningState?: boolean;
    skipRefresh?: boolean;
  }): Promise<IPipelineRunResult> {
    const emptyResult: IPipelineRunResult = {
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      failedStepIndex: null,
    };

    if (!main.dataset || !main.configuration || !main.isLoggedIn) {
      onComplete?.(emptyResult);
      return emptyResult;
    }
    const targetDatasetId = datasetId ?? main.dataset.id;

    // Indices into pipeline.steps of the steps we will actually run.
    const enabledIndices = pipeline.steps
      .map((step, index) => ({ step, index }))
      .filter(({ step }) => step.enabled)
      .map(({ index }) => index);

    if (enabledIndices.length === 0) {
      onComplete?.(emptyResult);
      return emptyResult;
    }

    if (!skipRunningState) {
      this.setRunningPipelineId(pipeline.id);
    }

    let isCancelled = false;
    let currentJob: IAnnotationComputeJob | IPropertyComputeJob | null = null;
    const cancel = () => {
      isCancelled = true;
      if (currentJob) {
        main.api.cancelJob(currentJob.jobId);
      }
    };
    // Hand the cancel handle to the caller immediately (before the loop), so the
    // cancel button is wired up without waiting for the run to finish.
    onCancel?.(cancel);

    const topProgressId = await progress.create({
      type: ProgressType.PIPELINE_COMPUTE,
      title: `Pipeline: ${pipeline.name}`,
    });
    progress.update({
      id: topProgressId,
      progress: 0,
      total: enabledIndices.length,
    });

    let succeeded = 0;
    let failed = 0;
    let cancelled = 0;
    let failedStepIndex: number | null = null;
    let done = 0;
    // Set when ensureMaterializedProperty actually assigns/changes a step's
    // materializedPropertyId during this run. Only then is it worth PUTting
    // the config back - a run with no property steps (or only reused,
    // already-matching properties) shouldn't write the config at all.
    let materializedPropertyChanged = false;

    for (const stepIndex of enabledIndices) {
      const step = pipeline.steps[stepIndex];

      if (isCancelled) {
        cancelled++;
        onStepComplete?.(stepIndex, false);
        done++;
        progress.update({
          id: topProgressId,
          progress: done,
          total: enabledIndices.length,
        });
        continue;
      }

      onStepStart?.(stepIndex, step);

      const progressInfo: IProgressInfo = {};
      const errorInfo: IErrorInfoList = { errors: [] };

      const stepProgressId = await progress.create({
        type:
          step.kind === "annotation"
            ? ProgressType.ANNOTATION_COMPUTE
            : ProgressType.PROPERTY_COMPUTE,
        title: `${pipeline.name}: ${step.name}`,
      });

      const eventCallback = (jobData: IJobEventData) => {
        createProgressEventCallback(progressInfo)(jobData);
        onStepProgress?.(stepIndex, progressInfo);
        progress.handleJobProgress({
          jobData,
          progressId: stepProgressId,
          defaultTitle: `${pipeline.name}: ${step.name}`,
        });
      };
      const errorCallback = (jobData: IJobEventData) => {
        createErrorEventCallback(errorInfo)(jobData);
        onStepError?.(stepIndex, errorInfo);
      };

      let success = false;
      try {
        let submitted: {
          job: IAnnotationComputeJob | IPropertyComputeJob;
          completionPromise: Promise<boolean>;
        } | null = null;

        if (step.kind === "annotation") {
          const tool = buildTransientTool(step);
          submitted = await annotations.submitAnnotationWorkerJob({
            tool,
            datasetId: targetDatasetId,
            eventCallback,
            errorCallback,
          });
        } else {
          const previousMaterializedPropertyId = step.materializedPropertyId;
          const property = await this.ensureMaterializedProperty(step);
          if (step.materializedPropertyId !== previousMaterializedPropertyId) {
            materializedPropertyChanged = true;
          }
          if (property) {
            submitted = await properties.submitPropertyJob({
              property,
              datasetId: targetDatasetId,
              eventCallback,
              errorCallback,
            });
          }
        }

        if (submitted) {
          currentJob = submitted.job;
          onStepJob?.(stepIndex, submitted.job.jobId);
          success = await submitted.completionPromise;
          currentJob = null;
        } else {
          success = false;
        }
      } catch (error) {
        // The errorCallback only surfaces errors the worker prints to its job
        // log; a failed submission (HTTP error, property materialization
        // failure) never reaches it, so surface it here.
        logError(`Pipeline step "${step.name}" failed to submit:`, error);
        errorInfo.errors.push({
          title: step.name,
          error: `Failed to submit job: ${error}`,
          type: MessageType.ERROR,
        });
        onStepError?.(stepIndex, errorInfo);
        success = false;
      }

      progress.complete(stepProgressId);

      if (isCancelled) {
        cancelled++;
        onStepComplete?.(stepIndex, false);
      } else if (success) {
        succeeded++;
        onStepComplete?.(stepIndex, true);
      } else {
        failed++;
        if (failedStepIndex === null) {
          failedStepIndex = stepIndex;
        }
        onStepComplete?.(stepIndex, false);
      }

      done++;
      progress.update({
        id: topProgressId,
        progress: done,
        total: enabledIndices.length,
      });

      // Stop early on failure unless the caller opted into continuing.
      if (!success && !isCancelled && !continueOnError) {
        break;
      }
    }

    try {
      // Persist newly-materialized property ids captured during the run, but
      // only when something actually changed - an annotation-only run (or one
      // whose property steps all reused an already-matching property) has
      // nothing new to write back to the configuration.
      if (materializedPropertyChanged) {
        await main.updateConfigurationPipelines(cloneDeep(this.pipelines));
      }

      // Refresh derived state once for the whole run. Skipped for batch
      // children — runPipelineBatch refreshes once at the end for the
      // currently-viewed dataset.
      if (!skipRefresh) {
        await this.refreshAfterRun();
      }
    } finally {
      // A failed configuration sync or post-run refresh must not leave the
      // global run lock or its progress entry stuck indefinitely.
      progress.complete(topProgressId);
      if (!skipRunningState) {
        this.setRunningPipelineId(null);
      }
    }

    const result: IPipelineRunResult = {
      succeeded,
      failed,
      cancelled,
      failedStepIndex,
    };
    onComplete?.(result);
    return result;
  }

  // Refresh derived state for the currently-viewed dataset. Shared by the
  // single-run and batch-run completion paths.
  @Action
  async refreshAfterRun() {
    await annotations.fetchAnnotations();
    await properties.fetchPropertyValues();
    try {
      const filters = (await import("./filters")).default;
      await filters.updateHistograms();
    } catch {
      // filters module optional at this point; ignore
    }
    const currentDatasetId = main.dataset?.id;
    if (!currentDatasetId) {
      return;
    }
    const newLargeImage = await main.loadLargeImages(true);
    if (newLargeImage) {
      main.scheduleTileFramesComputation(currentDatasetId);
      main.scheduleMaxMergeCache(currentDatasetId);
      main.scheduleHistogramCache(currentDatasetId);
    }
  }

  // ---- Batch runner (one pipeline across every dataset in a collection) --

  // Runs the whole pipeline once per dataset in the configuration, awaiting
  // each before the next (the outer product of the batch pattern and the
  // pipeline runner). Mirrors computeAnnotationsWithWorkerBatch. The per-
  // dataset runs skip their own running-state + refresh; this action owns the
  // "running" indicator and does a single refresh at the end.
  @Action
  async runPipelineBatch({
    pipeline,
    configurationId,
    continueOnError = false,
    onBatchProgress,
    onCancel,
    onComplete,
  }: {
    pipeline: IPipeline;
    configurationId: string;
    continueOnError?: boolean;
    onBatchProgress?: (status: {
      total: number;
      completed: number;
      failed: number;
      cancelled: number;
      currentDatasetName: string;
    }) => void;
    onCancel?: (cancel: () => void) => void;
    onComplete?: (result: {
      succeeded: number;
      failed: number;
      cancelled: number;
    }) => void;
  }): Promise<{ succeeded: number; failed: number; cancelled: number }> {
    const emptyResult = { succeeded: 0, failed: 0, cancelled: 0 };
    if (!main.isLoggedIn) {
      onComplete?.(emptyResult);
      return emptyResult;
    }

    let isCancelled = false;
    let innerCancel: (() => void) | null = null;
    const cancel = () => {
      isCancelled = true;
      innerCancel?.();
    };
    // Wire the cancel handle up immediately, before any await.
    onCancel?.(cancel);

    const datasetViews: IDatasetView[] = await main.api.findDatasetViews({
      configurationId,
    });
    const datasetIds: string[] = [
      ...new Set(datasetViews.map((v) => v.datasetId)),
    ];
    const total = datasetIds.length;
    if (total === 0) {
      onComplete?.(emptyResult);
      return emptyResult;
    }
    if (total > BATCH_DATASET_LIMIT) {
      const rejectedResult = {
        succeeded: 0,
        failed: total,
        cancelled: 0,
      };
      onComplete?.(rejectedResult);
      return rejectedResult;
    }

    const datasetInfo = await main.api.batchResources({ folder: datasetIds });
    const datasetNames: { [id: string]: string } = {};
    for (const id of datasetIds) {
      datasetNames[id] = datasetInfo.folder?.[id]?.name || "Unknown dataset";
    }

    this.setRunningPipelineId(pipeline.id);
    const batchProgressId = await progress.create({
      type: ProgressType.BATCH_PIPELINE_COMPUTE,
      title: `Batch pipeline: ${pipeline.name}`,
    });
    progress.update({ id: batchProgressId, progress: 0, total });

    let completed = 0;
    let failed = 0;
    let cancelled = 0;

    try {
      for (const datasetId of datasetIds) {
        if (isCancelled) {
          cancelled++;
          onBatchProgress?.({
            total,
            completed,
            failed,
            cancelled,
            currentDatasetName: datasetNames[datasetId],
          });
          continue;
        }

        onBatchProgress?.({
          total,
          completed,
          failed,
          cancelled,
          currentDatasetName: datasetNames[datasetId],
        });

        const result = await this.runPipeline({
          pipeline,
          datasetId,
          continueOnError,
          skipRunningState: true,
          skipRefresh: true,
          onCancel: (c) => {
            innerCancel = c;
          },
        });

        if (isCancelled) {
          cancelled++;
        } else if (
          result.succeeded > 0 &&
          result.failed === 0 &&
          result.cancelled === 0
        ) {
          // A child run that bailed out entirely (empty result, e.g. login
          // expired mid-batch) must not count as a completed dataset.
          completed++;
        } else {
          failed++;
        }

        progress.update({
          id: batchProgressId,
          progress: completed + failed + cancelled,
          total,
        });
        onBatchProgress?.({
          total,
          completed,
          failed,
          cancelled,
          currentDatasetName: datasetNames[datasetId],
        });
      }

      // Single refresh for the currently-viewed dataset (the batch may have
      // touched many others, but only the current one is on screen).
      await this.refreshAfterRun();

      const summary = { succeeded: completed, failed, cancelled };
      onComplete?.(summary);
      return summary;
    } finally {
      progress.complete(batchProgressId);
      this.setRunningPipelineId(null);
    }
  }
}

export default getModule(Pipelines);

// Re-export the shape constant for UI defaulting.
export { AnnotationShape };

// Self-accept HMR to prevent vuex-module-decorators from re-registering
// the dynamic module.
if (import.meta.hot) {
  import.meta.hot.accept();
}

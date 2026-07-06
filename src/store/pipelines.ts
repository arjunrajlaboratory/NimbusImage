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

import {
  AnnotationShape,
  IAnnotationComputeJob,
  IAnnotationPipelineStep,
  IAnnotationProperty,
  IErrorInfoList,
  IJobEventData,
  IPipeline,
  IPipelineRunResult,
  IPropertyComputeJob,
  IPropertyPipelineStep,
  IProgressInfo,
  IToolConfiguration,
  IToolTemplate,
  IWorkerCatalogEntry,
  ISuggestedPipeline,
  ISuggestedPipelineStep,
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

// Convert one raw model suggestion into an IPipeline. Pure (no I/O), so it
// lives at module scope (non-decorated class methods are not exposed by
// vuex-module-decorators, neither on the module proxy nor on `this`).
function convertSuggestion(suggestion: ISuggestedPipeline): IPipeline | null {
  if (!suggestion || !Array.isArray(suggestion.steps)) {
    return null;
  }
  const toShape = (s: string | undefined): AnnotationShape => {
    const values = Object.values(AnnotationShape) as string[];
    return s && values.includes(s)
      ? (s as AnnotationShape)
      : AnnotationShape.Polygon;
  };
  const steps: TPipelineStep[] = suggestion.steps.map(
    (raw: ISuggestedPipelineStep) => {
      const base = {
        id: uuidv4(),
        name: raw.name || raw.image,
        image: raw.image,
        workerInterfaceValues: raw.workerInterfaceValues ?? {},
        enabled: true,
      };
      if (raw.kind === "property") {
        const step: IPropertyPipelineStep = {
          ...base,
          kind: "property",
          shape: toShape(raw.shape),
          inputTags: {
            tags: raw.inputTags ?? [],
            exclusive: false,
          },
          autoWired: true,
        };
        return step;
      }
      const step: IAnnotationPipelineStep = {
        ...base,
        kind: "annotation",
        annotation: {
          tags: raw.outputTags ?? [],
          shape: toShape(raw.shape),
          color: undefined,
          coordinateAssignments: {
            layer: null,
            Z: { type: "layer", value: 1, max: 1 },
            Time: { type: "layer", value: 1, max: 1 },
          },
        },
      };
      return step;
    },
  );
  return {
    id: uuidv4(),
    name: suggestion.name || "Suggested pipeline",
    description: suggestion.rationale,
    steps,
    origin: "ai",
  };
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

  @Action
  async deletePipeline(pipelineId: string) {
    await main.updateConfigurationPipelines(
      this.pipelines.filter((p) => p.id !== pipelineId),
    );
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
    onStepProgress,
    onStepError,
    onStepComplete,
    onCancel,
    onComplete,
  }: {
    pipeline: IPipeline;
    datasetId?: string;
    continueOnError?: boolean;
    onStepStart?: (stepIndex: number, step: TPipelineStep) => void;
    onStepProgress?: (stepIndex: number, info: IProgressInfo) => void;
    onStepError?: (stepIndex: number, errors: IErrorInfoList) => void;
    onStepComplete?: (stepIndex: number, success: boolean) => void;
    onCancel?: (cancel: () => void) => void;
    onComplete?: (result: IPipelineRunResult) => void;
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

    this.setRunningPipelineId(pipeline.id);

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
          const property = await this.ensureMaterializedProperty(step);
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
          success = await submitted.completionPromise;
          currentJob = null;
        } else {
          success = false;
        }
      } catch (error) {
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

    // Persist any newly-materialized property ids captured during the run.
    await main.updateConfigurationPipelines(cloneDeep(this.pipelines));

    // Refresh derived state once for the whole run (mirrors the single-step and
    // batch completion paths).
    await annotations.fetchAnnotations();
    await properties.fetchPropertyValues();
    try {
      const filters = (await import("./filters")).default;
      await filters.updateHistograms();
    } catch {
      // filters module optional at this point; ignore
    }
    const newLargeImage = await main.loadLargeImages(true);
    if (newLargeImage) {
      main.scheduleTileFramesComputation(targetDatasetId);
      main.scheduleMaxMergeCache(targetDatasetId);
      main.scheduleHistogramCache(targetDatasetId);
    }

    progress.complete(topProgressId);
    this.setRunningPipelineId(null);

    const result: IPipelineRunResult = {
      succeeded,
      failed,
      cancelled,
      failedStepIndex,
    };
    onComplete?.(result);
    return result;
  }

  // ---- AI suggestion ----------------------------------------------------

  // Assemble the worker catalog + dataset context, ask the backend (which
  // proxies Claude with forced tool-use), then validate and convert the raw
  // suggestions into ready-to-edit IPipeline objects. Suggestions referencing
  // images that are not installed are dropped.
  @Action
  async suggestPipelines(goal: string): Promise<IPipeline[]> {
    if (Object.keys(properties.workerImageList).length === 0) {
      await properties.fetchWorkerImageList();
    }

    const annotationWorkers: IWorkerCatalogEntry[] = [];
    const propertyWorkers: IWorkerCatalogEntry[] = [];
    for (const image of Object.keys(properties.workerImageList)) {
      const labels = properties.workerImageList[image];
      const isAnnotation = labels.isAnnotationWorker !== undefined;
      const isProperty = labels.isPropertyWorker !== undefined;
      if (!isAnnotation && !isProperty) {
        continue;
      }
      // Only include interfaces already cached. We deliberately do NOT
      // fetchWorkerInterface here: an uncached interface fetch can launch a
      // Docker container, and doing that for every installed image just to
      // build a suggestion prompt would be slow and surprising. Workers the
      // user has already configured are cached; the rest fall back to labels
      // only, which is enough for the model to propose a sensible pipeline.
      const iface = properties.getWorkerInterface(image) ?? null;
      const entry: IWorkerCatalogEntry = {
        image,
        name: labels.interfaceName || image,
        description: labels.description,
        annotationShape: labels.annotationShape,
        interface: iface,
      };
      if (isAnnotation) {
        annotationWorkers.push(entry);
      }
      if (isProperty) {
        propertyWorkers.push(entry);
      }
    }

    const channels = main.configuration
      ? Object.values(main.configuration.compatibility.channels)
      : [];
    const existingTags = [...annotations.annotationTags];
    const existingShapes = [
      ...new Set(annotations.annotations.map((a) => a.shape)),
    ];

    const suggestions = await main.chatAPI.suggestPipelines({
      goal,
      context: { channels, existingTags, existingShapes },
      annotationWorkers,
      propertyWorkers,
      maxSuggestions: 3,
    });

    const installed = properties.workerImageList;
    return suggestions
      .map((s) => convertSuggestion(s))
      .filter((p): p is IPipeline => p !== null && p.steps.length > 0)
      .map((p) => {
        // Drop steps whose image is not installed / not the right kind.
        p.steps = p.steps.filter((step) => {
          const labels = installed[step.image];
          if (!labels) {
            return false;
          }
          return step.kind === "annotation"
            ? labels.isAnnotationWorker !== undefined
            : labels.isPropertyWorker !== undefined;
        });
        return p;
      })
      .filter((p) => p.steps.length > 0);
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

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
import { findSourceProperty, resolveLinkedStep } from "@/utils/pipelineLinks";
import { computeAutoWiredSteps } from "@/utils/pipelineWiring";
import { getDefault } from "@/utils/workerInterface";

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
  IWorkerInterfaceValues,
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

// A pipeline step that uses a property, named for the user.
export interface IPipelineStepLink {
  pipelineId: string;
  pipelineName: string;
  stepId: string;
  stepName: string;
  // Off now, but it uses the property again once re-enabled.
  enabled: boolean;
  // How the step uses it: linked to it (sourcePropertyId), or it is the
  // property the step created (materializedPropertyId).
  use: "linked" | "created";
}

// Linked properties a reload found missing, as `${configurationId}:${id}`
// (see loadMissingLinkedProperties). Per configuration: one property can be
// registered in several (a duplicated configuration shares them), and
// removing it from one only unregisters it there.
const confirmedMissingProperties = new Set<string>();

export const CONFIGURATION_CHANGED_DURING_RUN =
  "Another configuration was opened during the run. Open a dataset of this " +
  "pipeline's configuration and run it again.";

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

// An annotation step's worker values as submitted: its parameters, with the
// worker interface's default for any it has no value for. Running a tool from
// its own menu does the same (AnnotationWorkerMenu.populateInterfaceValues),
// and a tool saved without values (an accepted AI suggestion) is shown with
// those defaults on a linked step, so the run must use them too. The step and
// its source are not modified. Without an interface (one that cannot be
// loaded) the step's values go as they are, as from the tool's menu.
async function withInterfaceDefaults(
  step: IAnnotationPipelineStep,
): Promise<IAnnotationPipelineStep> {
  if (!step.image) {
    return step;
  }
  // Only when never fetched: null means the worker has none, and asking again
  // would run a worker job for every step (the tool menu also fetches only
  // an undefined interface).
  if (properties.getWorkerInterface(step.image) === undefined) {
    try {
      await properties.fetchWorkerInterface({ image: step.image });
    } catch (error) {
      logError(`Failed to fetch worker interface for ${step.image}:`, error);
    }
  }
  const workerInterface = properties.getWorkerInterface(step.image);
  const missing = Object.keys(workerInterface ?? {}).filter(
    (id) => !(id in step.workerInterfaceValues),
  );
  if (!workerInterface || missing.length === 0) {
    return step;
  }
  const defaults: IWorkerInterfaceValues = {};
  for (const id of missing) {
    defaults[id] = getDefault(
      workerInterface[id].type,
      workerInterface[id].default,
    );
  }
  return {
    ...step,
    workerInterfaceValues: { ...defaults, ...step.workerInterfaceValues },
  };
}

// The loaded property list, if it is the given configuration's. After a
// switch it is the previous configuration's until the new one's fetch lands,
// and a property found there may not be registered in this configuration.
function propertiesOf(configurationId: string | undefined) {
  return properties.propertiesConfigurationId === configurationId
    ? properties.properties
    : [];
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
  // still uses `propertyId`, either as its materialized property or as the
  // existing property it is linked to (sourcePropertyId). Used to avoid
  // deleting a property that another pipeline (or another step) relies on.
  get isPropertyReferencedByPipelineStep() {
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
              (s.materializedPropertyId === propertyId ||
                s.sourcePropertyId === propertyId) &&
              s.id !== exclude.stepId,
          ),
      );
  }

  // The property steps that use `propertyId`, by pipeline: linked to it
  // (sourcePropertyId) or created it (materializedPropertyId), disabled ones
  // included (they use it again once re-enabled). Removing the property from
  // the configuration makes each of them create a new pipeline-owned
  // property on its next run, so the Properties panel names them first.
  get pipelineStepsLinkedToProperty() {
    return (propertyId: string): IPipelineStepLink[] =>
      this.pipelines.flatMap((pipeline) =>
        pipeline.steps.flatMap((step): IPipelineStepLink[] => {
          if (step.kind !== "property") {
            return [];
          }
          const use =
            step.sourcePropertyId === propertyId
              ? "linked"
              : step.materializedPropertyId === propertyId
                ? "created"
                : null;
          return use
            ? [
                {
                  pipelineId: pipeline.id,
                  pipelineName: pipeline.name,
                  stepId: step.id,
                  stepName: step.name,
                  enabled: step.enabled,
                  use,
                },
              ]
            : [];
        }),
      );
  }

  // The running pipeline (single run or batch), if one of its enabled
  // property steps computes `propertyId`: the property it is linked to, or
  // the one it materialized. Removing that property mid-run would split the
  // run's results between it and a fallback property the remaining steps or
  // datasets create. Read from the stored pipeline, which is what both run
  // entry points submit.
  get runningPipelineComputingProperty() {
    return (propertyId: string): IPipeline | null => {
      const running = this.runningPipelineId
        ? this.getPipelineById(this.runningPipelineId)
        : null;
      const computesProperty = running?.steps.some(
        (step) =>
          step.enabled &&
          step.kind === "property" &&
          (step.sourcePropertyId === propertyId ||
            step.materializedPropertyId === propertyId),
      );
      return computesProperty ? running : null;
    };
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
            !this.isPropertyReferencedByPipelineStep(propertyId, {
              pipelineId,
            }),
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
      (propertyId) => !this.isPropertyReferencedByPipelineStep(propertyId),
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
    // Not from another configuration's list (right after a switch, before
    // this one's properties load): a miss there would create a property
    // that setProperties then refuses to register, leaving it orphaned.
    if (properties.propertiesConfigurationId !== main.configuration?.id) {
      throw new Error(
        "The properties of this configuration have not loaded; try again.",
      );
    }
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
    const configurationId = main.configuration?.id;
    // A property it returns is registered in the configuration loaded when
    // the request went out (createProperty throws, registering nothing, if a
    // switch landed during the request), so its id is always recorded here.
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
      // Removing the stale property rewrites the loaded configuration's
      // propertyIds from the loaded list, which after a switch may be the
      // previous configuration's: leave it then.
      if (
        staleId &&
        staleId !== created.id &&
        main.configuration?.id === configurationId &&
        !this.isPropertyReferencedByPipelineStep(staleId, { stepId: step.id })
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
    linkedPropertiesChecked,
    resolvedSteps,
    configurationId,
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
    // Set by runPipelineBatch, which checks linked properties once for all
    // datasets (see loadMissingLinkedProperties).
    linkedPropertiesChecked?: boolean;
    // Set by runPipelineBatch, which resolves the steps once, so every
    // dataset runs the same settings even if a linked tool changes mid-batch.
    resolvedSteps?: TPipelineStep[];
    // Set by runPipelineBatch: the configuration the batch started on, so a
    // child that starts after a switch fails instead of running against it.
    configurationId?: string;
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
    // The steps read the loaded configuration's tools and properties and
    // write materialized property ids back to it. A switch mid-run (opening a
    // dataset of another configuration) replaces all of that, so later steps
    // would look up, create or record properties in the wrong configuration
    // while their jobs target this run's dataset. Captured before any await.
    const runConfigurationId = configurationId ?? main.configuration.id;
    const configurationChanged = () =>
      main.configuration?.id !== runConfigurationId;
    // The run's configuration object: the loaded one while it is still the
    // run's (a reload may replace the object), else the last one seen.
    let runConfiguration = main.configuration;
    const currentRunConfiguration = () => {
      if (!configurationChanged()) {
        runConfiguration = main.configuration!;
      }
      return runConfiguration;
    };

    // Indices into pipeline.steps of the steps we will actually run.
    const enabledIndices = pipeline.steps
      .map((step, index) => ({ step, index }))
      .filter(({ step }) => step.enabled)
      .map(({ index }) => index);

    if (enabledIndices.length === 0) {
      onComplete?.(emptyResult);
      return emptyResult;
    }

    // Take the run lock before any await, so a second run can't start in the
    // meantime.
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

    // A linked property missing from the loaded list may be gone, or may not
    // have loaded yet (properties load with the configuration). This check
    // never rejects, so it cannot leave the lock held.
    const linkedPropertiesKnown =
      linkedPropertiesChecked ??
      (await this.loadMissingLinkedProperties(pipeline));

    // The steps as they run (see stepsAsRun). A batch resolves them once for
    // all its datasets. Stored data this can't make sense of fails the run
    // here rather than leaving the lock held.
    let runSteps: TPipelineStep[];
    try {
      runSteps = resolvedSteps ?? this.stepsAsRun(pipeline);
    } catch (error) {
      logError(`Pipeline "${pipeline.name}" could not be prepared:`, error);
      if (!skipRunningState) {
        this.setRunningPipelineId(null);
      }
      const failedResult = {
        ...emptyResult,
        failed: enabledIndices.length,
      };
      onComplete?.(failedResult);
      return failedResult;
    }

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
    // The steps whose materializedPropertyId ensureMaterializedProperty
    // assigned or changed during this run. Only then is it worth PUTting the
    // config back - a run with no property steps (or only reused,
    // already-matching properties) shouldn't write the config at all. Kept
    // here as well as merged onto the stored pipeline at once, because a
    // switch away and back reloads the configuration from the server without
    // the ids merged so far.
    const materializedSteps: TPipelineStep[] = [];
    // Set when a step fails because the configuration switched: the run
    // stops, continueOnError or not, since every later step would fail the
    // same way.
    let configurationSwitched = false;

    for (const stepIndex of enabledIndices) {
      const step = pipeline.steps[stepIndex];
      const runStep = runSteps[stepIndex];

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
        if (configurationChanged()) {
          throw new Error(CONFIGURATION_CHANGED_DURING_RUN);
        }
        let submitted: {
          job: IAnnotationComputeJob | IPropertyComputeJob;
          completionPromise: Promise<boolean>;
        } | null = null;

        if (runStep.kind === "annotation") {
          const runValues = await withInterfaceDefaults(runStep);
          // The interface fetch is an await (it may wait for a worker job):
          // check again before submitting.
          if (configurationChanged()) {
            throw new Error(CONFIGURATION_CHANGED_DURING_RUN);
          }
          if (!isCancelled) {
            submitted = await annotations.submitAnnotationWorkerJob({
              tool: buildTransientTool(runValues),
              datasetId: targetDatasetId,
              eventCallback,
              errorCallback,
            });
          }
        } else {
          // Only from the run configuration's own list: with another's
          // loaded (a failed reload after a switch), the property is
          // unknown, not present.
          const linkedProperty = findSourceProperty(
            runStep,
            propertiesOf(runConfigurationId),
          );
          if (linkedProperty) {
            // Compute the user's own property directly: no materialized
            // copy, and nothing here may replace or delete it.
            submitted = await properties.submitPropertyJob({
              property: linkedProperty,
              datasetId: targetDatasetId,
              eventCallback,
              errorCallback,
            });
          } else if (
            runStep.sourcePropertyId &&
            !runStep.materializedPropertyId &&
            !linkedPropertiesKnown
          ) {
            // Unknown whether the linked property still exists: don't
            // materialize what may be a duplicate of it. (A step already on
            // its fallback was not part of the check and runs it.)
            throw new Error(
              "Could not check whether the linked property still exists; try again.",
            );
          } else {
            const previousMaterializedPropertyId =
              runStep.materializedPropertyId;
            const property = await this.ensureMaterializedProperty(runStep);
            if (
              runStep.materializedPropertyId !== previousMaterializedPropertyId
            ) {
              materializedSteps.push(runStep);
              // Onto the stored step now (runStep is a copy wherever resolving
              // or wiring changed it), so later steps' reference checks see it.
              // The run configuration's current copy: a config write (e.g. by
              // an earlier dataset of a batch) replaces the object the caller
              // passed, and after a switch only the captured one is left.
              mergeMaterializedPropertyIds(
                currentRunConfiguration().pipelines?.find(
                  (candidate) => candidate.id === pipeline.id,
                ) ?? pipeline,
                { ...pipeline, steps: [runStep] },
              );
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
        }

        if (submitted) {
          currentJob = submitted.job;
          // cancel() only reaches a job it knows of: one cancelled while its
          // submission was in flight is cancelled now.
          if (isCancelled) {
            main.api.cancelJob(submitted.job.jobId);
          }
          onStepJob?.(stepIndex, submitted.job.jobId);
          success = await submitted.completionPromise;
          currentJob = null;
        } else {
          success = false;
        }
      } catch (error) {
        // Found here or while materializing the step's property.
        configurationSwitched = configurationChanged();
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
      if (
        configurationSwitched ||
        (!success && !isCancelled && !continueOnError)
      ) {
        break;
      }
    }

    try {
      // Persist newly-materialized property ids captured during the run, but
      // only when something actually changed - an annotation-only run (or one
      // whose property steps all reused an already-matching property) has
      // nothing new to write back to the configuration.
      if (materializedSteps.length > 0) {
        const storedPipeline = currentRunConfiguration().pipelines?.find(
          (candidate) => candidate.id === pipeline.id,
        );
        if (storedPipeline) {
          mergeMaterializedPropertyIds(storedPipeline, {
            ...pipeline,
            steps: materializedSteps,
          });
        }
        if (!configurationChanged()) {
          await main.updateConfigurationPipelines(cloneDeep(this.pipelines));
        } else {
          // To the run's own configuration, not the one now loaded: losing
          // the ids would make its next run create the properties again.
          await main.api.updateConfigurationKey(
            currentRunConfiguration(),
            "pipelines",
          );
          store.dispatch("ressourceChanged", runConfigurationId);
        }
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

  // The steps as they run: linked steps take their source's current values,
  // then auto-wiring is re-applied so a property step reads the tags its
  // upstream step produces now (a linked tool's output tags may have changed
  // since the pipeline was saved). The runner writes materializedPropertyId to
  // these and copies it to the stored step as soon as it changes.
  get stepsAsRun() {
    return (pipeline: IPipeline): TPipelineStep[] =>
      computeAutoWiredSteps(
        pipeline.steps.map((step) =>
          resolveLinkedStep(
            step,
            main.tools,
            propertiesOf(main.configuration?.id),
          ),
        ),
      );
  }

  // Reload the configuration's properties when an enabled step is linked to a
  // property that is not in the loaded list, so one that simply had not loaded
  // yet is not treated as deleted (whose fallback would materialize a
  // duplicate of it). A step already running its fallback (it has a
  // materialized property) was found gone before and is not rechecked, so a
  // deleted source does not cost a fetch on every run. Returns false when the
  // reload failed or the configuration changed during it: whether the missing
  // ones exist is then unknown. A property a reload confirmed missing is not
  // rechecked in that configuration (opening the editor or running would
  // otherwise refetch every property each time). While the loaded list is
  // not this configuration's (its fetch has not landed), every linked step is
  // checked. Never rejects (the editor calls it without awaiting).
  @Action
  async loadMissingLinkedProperties(pipeline: IPipeline): Promise<boolean> {
    const configurationId = main.configuration?.id;
    const missingKey = (propertyId: string) =>
      `${configurationId}:${propertyId}`;
    // A list no fetch has loaded for this configuration yet (still loading,
    // or still the previous configuration's) says nothing about which of
    // its properties exist: check every linked step then.
    const listIsLoaded = () =>
      properties.propertiesConfigurationId === configurationId;
    const needsCheck = (step: TPipelineStep) =>
      step.enabled &&
      step.kind === "property" &&
      !!step.sourcePropertyId &&
      !step.materializedPropertyId &&
      !confirmedMissingProperties.has(missingKey(step.sourcePropertyId)) &&
      (!listIsLoaded() || !findSourceProperty(step, properties.properties));
    if (!pipeline.steps.some(needsCheck)) {
      return true;
    }
    try {
      await properties.fetchProperties();
      // A configuration switch during the reload means its result (if any)
      // says nothing about this pipeline's configuration: neither confirm
      // the property missing nor let the run treat it as deleted.
      if (main.configuration?.id !== configurationId) {
        return false;
      }
      for (const step of pipeline.steps.filter(needsCheck)) {
        if (step.kind === "property" && step.sourcePropertyId) {
          confirmedMissingProperties.add(missingKey(step.sourcePropertyId));
        }
      }
      return true;
    } catch (error) {
      logError("Failed to reload properties for linked pipeline steps:", error);
      return false;
    }
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
    onRejected,
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
    // Called (with the authoritative dataset count) when the batch is refused
    // because the collection is over BATCH_DATASET_LIMIT, so callers can
    // explain the rejection rather than reporting a bare "N failed".
    onRejected?: (datasetCount: number) => void;
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
    // The configuration whose tools and properties the steps resolve against
    // (see runPipeline). Captured before any await.
    const batchConfigurationId = main.configuration?.id;

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
      logError(
        `Refusing pipeline batch: ${total} datasets exceeds the limit of ` +
          `${BATCH_DATASET_LIMIT}.`,
      );
      const rejectedResult = {
        succeeded: 0,
        failed: total,
        cancelled: 0,
      };
      onRejected?.(total);
      onComplete?.(rejectedResult);
      return rejectedResult;
    }

    const datasetInfo = await main.api.batchResources({ folder: datasetIds });
    const datasetNames: { [id: string]: string } = {};
    for (const id of datasetIds) {
      datasetNames[id] = datasetInfo.folder?.[id]?.name || "Unknown dataset";
    }

    this.setRunningPipelineId(pipeline.id);
    // Never rejects, so it cannot leave the lock held. Only on the batch's
    // own configuration: after a switch during the awaits above, the reload
    // would check the other configuration's properties and record this
    // pipeline's sources as missing for the session. (The loop below then
    // runs no dataset.)
    const linkedPropertiesChecked =
      main.configuration?.id === batchConfigurationId &&
      (await this.loadMissingLinkedProperties(pipeline));
    const batchProgressId = await progress.create({
      type: ProgressType.BATCH_PIPELINE_COMPUTE,
      title: `Batch pipeline: ${pipeline.name}`,
    });
    progress.update({ id: batchProgressId, progress: 0, total });

    let completed = 0;
    let failed = 0;
    let cancelled = 0;
    let configurationSwitched = false;

    try {
      // Resolved once, so every dataset runs the same settings even if a
      // linked tool changes mid-batch (and auto-wired property steps don't
      // drift from their materialized property part-way through).
      const resolvedSteps = this.stepsAsRun(pipeline);
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

        // After a switch to another configuration, the remaining datasets
        // are not run: each would fail on its first step anyway.
        if (main.configuration?.id !== batchConfigurationId) {
          if (!configurationSwitched) {
            configurationSwitched = true;
            logError(
              `Batch pipeline "${pipeline.name}" stopped:`,
              CONFIGURATION_CHANGED_DURING_RUN,
            );
          }
          failed++;
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
          linkedPropertiesChecked,
          resolvedSteps,
          configurationId: batchConfigurationId,
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

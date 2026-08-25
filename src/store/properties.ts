import {
  getModule,
  Action,
  Module,
  Mutation,
  VuexModule,
} from "vuex-module-decorators";
import store from "./root";
import { markRaw } from "vue";

type TimeoutHandle = ReturnType<typeof setTimeout>;

import {
  IAnnotationProperty,
  IWorkerInterface,
  IToolConfiguration,
  IAnnotationPropertyValues,
  IWorkerImageList,
  IAnnotationPropertyConfiguration,
  IAnnotation,
  IWorkerInterfaceValues,
  IPropertyComputeJob,
  IProgressInfo,
  ProgressType,
  IJobEventData,
  IErrorInfoList,
  IDatasetView,
  MessageType,
  NotificationType,
} from "./model";

import main from "./index";

import { canComputeAnnotationProperty } from "@/utils/annotation";
import {
  collectLeafPaths,
  idsMissingPaths,
  scopedMergePropertyValues,
  selectUncomputedCount,
} from "@/utils/propertyValues";
import { createSequenceGuard } from "@/utils/sequenceGuard";
import annotations from "./annotation";
import jobs, {
  createProgressEventCallback,
  createErrorEventCallback,
} from "./jobs";
import { logError, logWarning } from "@/utils/log";
import { findIndexOfPath } from "@/utils/paths";
import progress from "./progress";
import {
  MAX_DISPLAYED_PROPERTY_PATHS,
  MAX_PROPERTY_COMPUTE_BATCH,
} from "./constants";

// In lazy (stub-only) mode, property structure is homogeneous across a dataset,
// so this many value docs are enough to discover every property path without
// loading the whole dataset's values.
const PROPERTY_PATH_SAMPLE_SIZE = 512;

export interface IPropertyStatus {
  running: boolean;
  previousRun: boolean | null;
  progressInfo: IProgressInfo;
  errorInfo?: IErrorInfoList;
}

const defaultStatus: () => IPropertyStatus = () => ({
  running: false,
  previousRun: null,
  progressInfo: {},
  errorInfo: { errors: [] },
});

function serializePropertyPath(path: string[]) {
  return path.join("\u0000");
}

function uniquePropertyPaths(paths: string[][]): string[][] {
  const pathsByKey = new Map<string, string[]>();
  for (const path of paths) {
    const key = serializePropertyPath(path);
    if (!pathsByKey.has(key)) {
      pathsByKey.set(key, path);
    }
    if (pathsByKey.size === MAX_DISPLAYED_PROPERTY_PATHS) {
      break;
    }
  }
  return [...pathsByKey.values()];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function addComputeError(
  errorInfo: IErrorInfoList,
  title: string,
  error: unknown,
  notify = true,
) {
  const message = errorMessage(error);
  errorInfo.errors.push({
    title,
    error: message,
    type: MessageType.ERROR,
  });
  if (notify) {
    progress.createNotification({
      type: NotificationType.ERROR,
      title,
      message,
      timeout: 0,
    });
  }
}

interface IPropertyRun {
  property: IAnnotationProperty;
  status: IPropertyStatus;
  errorInfo: IErrorInfoList;
  progressId: string;
}

function finishPropertyRun(
  run: IPropertyRun,
  success: boolean,
  error?: { title: string; value: unknown; notify?: boolean },
) {
  if (error) {
    addComputeError(
      run.errorInfo,
      error.title,
      error.value,
      error.notify ?? true,
    );
  } else if (!success && run.errorInfo.errors.length === 0) {
    addComputeError(
      run.errorInfo,
      "Property computation failed",
      "The worker job did not complete successfully.",
    );
  }
  progress.complete(run.progressId);
  run.status.running = false;
  run.status.previousRun = success && !error;
  run.status.progressInfo = {};
  run.status.errorInfo = run.errorInfo;
}

async function finishPropertyRuns(
  tracked: { run: IPropertyRun; completion: Promise<boolean> }[],
  refresh: () => Promise<void>,
) {
  const results = await Promise.all(
    tracked.map(async ({ run, completion }) => {
      try {
        return { run, success: await completion, trackingError: null };
      } catch (trackingError) {
        return { run, success: false, trackingError };
      }
    }),
  );

  let refreshError: unknown = null;
  if (results.some(({ success }) => success)) {
    try {
      await refresh();
    } catch (error) {
      refreshError = error;
    }
  }

  let refreshNotificationShown = false;
  for (const { run, success, trackingError } of results) {
    if (trackingError) {
      finishPropertyRun(run, false, {
        title: "Property job tracking failed",
        value: trackingError,
      });
    } else if (refreshError && success) {
      finishPropertyRun(run, false, {
        title: "Property refresh failed",
        value: refreshError,
        notify: !refreshNotificationShown,
      });
      refreshNotificationShown = true;
    } else {
      finishPropertyRun(run, success);
    }
  }
}

@Module({ dynamic: true, store, name: "properties" })
export class Properties extends VuexModule {
  propertiesAPI = main.propertiesAPI;

  properties: IAnnotationProperty[] = [];

  displayedPropertyPaths: string[][] = [];

  // Largest mutable structure in the app (annotations × properties). The
  // mutation that replaces it already wraps with markRaw, but the initial
  // empty object would still go through Vuex's reactive() at module init.
  // Mark it raw at declaration so first-load assignment doesn't proxy-walk
  // the whole tree.
  propertyValues: IAnnotationPropertyValues = markRaw({});

  // Lazy mode (stub-only) only: leaf paths discovered from a bounded sample of
  // value docs, since `propertyValues` then holds only the visible subset and
  // can't be walked for the full path set. Empty in wholesale mode.
  discoveredPropertyPaths: string[][] = markRaw([]);

  // Bumped whenever the dataset's property values are (re)loaded — after a
  // compute or an import, not on a viewport pan. Consumers that must re-derive
  // from property values (the analysis gates) watch this: values live
  // server-side, so there is nothing client-side for them to diff.
  propertyValuesRevision = 0;

  // Lazy mode (stub-only) only: server-computed count of annotations still
  // awaiting each property's computation ({propertyId: count}). In wholesale
  // mode the count is derived client-side from the resident annotation set
  // (uncomputedAnnotationsPerProperty) and this stays empty.
  uncomputedCounts: { [propertyId: string]: number } = {};

  propertyStatuses: {
    [propertyId: string]: IPropertyStatus;
  } = {};

  workerImageList: IWorkerImageList = {};
  workerInterfaces: { [image: string]: IWorkerInterface | null } = {};
  workerPreviews: { [image: string]: { text: string; image: string } } = {};
  displayWorkerPreview = true;

  // Pending fallback timers from requestWorkerPreview, keyed by image so a
  // new request supersedes the previous one. Held in markRaw to keep Vue
  // from making the timer handles reactive.
  pendingWorkerPreviewTimeouts: Map<string, TimeoutHandle> = markRaw(new Map());

  get getStatus() {
    return (propertyId: string) => {
      return this.propertyStatuses[propertyId] || defaultStatus();
    };
  }

  get getWorkerInterface(): (
    image: string,
  ) => IWorkerInterface | null | undefined {
    return (image: string) => this.workerInterfaces[image];
  }

  get getWorkerPreview() {
    return (image: string) => this.workerPreviews[image];
  }

  @Mutation
  setWorkerPreview({
    image,
    workerPreview,
  }: {
    image: string;
    workerPreview: { text: string; image: string };
  }) {
    this.workerPreviews = {
      ...this.workerPreviews,
      [image]: workerPreview,
    };
  }
  @Action
  async fetchWorkerPreview(image: string) {
    const workerPreview = await this.propertiesAPI.getWorkerPreview(image);
    this.setWorkerPreview({ image, workerPreview });
  }

  @Mutation
  setWorkerInterface({
    image,
    workerInterface,
  }: {
    image: string;
    workerInterface: IWorkerInterface | null;
  }) {
    this.workerInterfaces = {
      ...this.workerInterfaces,
      [image]: workerInterface,
    };
  }

  @Mutation
  deleteWorkerInterface(image: string) {
    delete this.workerInterfaces[image];
  }

  @Mutation
  setDisplayWorkerPreview(value: boolean) {
    this.displayWorkerPreview = value;
  }

  @Mutation
  setPendingWorkerPreviewTimeout({
    image,
    handle,
  }: {
    image: string;
    handle: TimeoutHandle;
  }) {
    const previous = this.pendingWorkerPreviewTimeouts.get(image);
    if (previous !== undefined) {
      clearTimeout(previous);
    }
    this.pendingWorkerPreviewTimeouts.set(image, handle);
  }

  @Mutation
  clearPendingWorkerPreviewTimeout(image: string) {
    const handle = this.pendingWorkerPreviewTimeouts.get(image);
    if (handle !== undefined) {
      clearTimeout(handle);
      this.pendingWorkerPreviewTimeouts.delete(image);
    }
  }

  @Mutation
  protected resetPropertyStateImpl() {
    this.propertyStatuses = {};
    this.workerPreviews = {};
    // Property paths reference the previous dataset's property IDs and are
    // not meaningful in the new dataset. updateDisplayedFromComputedProperties
    // would prune them once new property values arrive, but resetting here
    // releases the references immediately and avoids a UI flash.
    this.displayedPropertyPaths = [];
    // Sibling lazy-mode field: also references the previous dataset's property
    // ids and is meaningless in the new dataset, so reset it here too (it is
    // otherwise only refreshed on the next fetchPropertyPathsSample).
    this.discoveredPropertyPaths = markRaw([]);
    this.uncomputedCounts = {};
    for (const handle of this.pendingWorkerPreviewTimeouts.values()) {
      clearTimeout(handle);
    }
    this.pendingWorkerPreviewTimeouts.clear();
  }

  // Clear per-dataset property state. Worker interfaces and the worker
  // image list are intentionally preserved since they are not dataset-scoped.
  @Action
  public resetPropertyState() {
    this.resetPropertyStateImpl();
  }

  @Action
  async fetchWorkerInterface({
    image,
    force,
  }: {
    image: string;
    force?: boolean;
  }) {
    this.deleteWorkerInterface(image);
    // First request to see if girder already has the worker interface
    let workerInterface: IWorkerInterface | null = null;
    if (!force) {
      workerInterface = await this.propertiesAPI.getWorkerInterface(image);
    }
    if (
      !workerInterface ||
      Object.values(workerInterface).find(({ noCache }) => noCache)
    ) {
      // If girder didn't fetch the interface or the cache is disabled, make it ask the worker for its interface
      await this.requestWorkerInterface(image);
      // Then, getWorkerInterface: client asks girder for the interface it should have received
      workerInterface = await this.propertiesAPI.getWorkerInterface(image);
    }
    // Associate the worker interface with the image
    this.setWorkerInterface({ image, workerInterface });
  }

  @Mutation
  bumpPropertyValuesRevision() {
    this.propertyValuesRevision++;
  }

  @Mutation
  updatePropertyValues(values: IAnnotationPropertyValues) {
    this.propertyValues = markRaw(values);
  }

  @Mutation
  setDiscoveredPropertyPaths(paths: string[][]) {
    this.discoveredPropertyPaths = markRaw(paths);
  }

  @Mutation
  setUncomputedCounts(counts: { [propertyId: string]: number }) {
    this.uncomputedCounts = counts;
  }

  // Lazy mode: merge freshly-fetched values into the cache, scoped to the
  // currently-rendered set so the cache stays bounded (see scopedMerge docs).
  @Mutation
  mergeVisiblePropertyValues(payload: {
    newEntries: {
      annotationId: string;
      values: IAnnotationPropertyValues[string];
    }[];
    keepIds: Set<string>;
  }) {
    this.propertyValues = markRaw(
      scopedMergePropertyValues(
        this.propertyValues,
        payload.newEntries,
        payload.keepIds,
      ),
    );
  }

  @Mutation
  replaceProperty(property: IAnnotationProperty) {
    const find = (prop: IAnnotationProperty) => prop.id === property.id;
    const prev = this.properties.find(find);
    if (!prev) {
      return;
    }
    this.properties.splice(this.properties.indexOf(prev), 1, property);
  }

  get getPropertyById() {
    return (id: string) => {
      const find = (prop: IAnnotationProperty) => prop.id === id;
      return this.properties.find(find) || null;
    };
  }

  @Mutation
  private setPropertyPathsVisibilityImpl({
    paths,
    visible,
  }: {
    paths: string[][];
    visible: boolean;
  }) {
    const requestedKeys = new Set(paths.map(serializePropertyPath));
    if (requestedKeys.size === 0) {
      return;
    }
    if (!visible) {
      const filtered = this.displayedPropertyPaths.filter(
        (path) => !requestedKeys.has(serializePropertyPath(path)),
      );
      if (filtered.length !== this.displayedPropertyPaths.length) {
        this.displayedPropertyPaths = filtered;
      }
      return;
    }

    const displayedKeys = new Set(
      this.displayedPropertyPaths.map(serializePropertyPath),
    );
    const additions: string[][] = [];
    for (const path of paths) {
      if (
        this.displayedPropertyPaths.length + additions.length >=
        MAX_DISPLAYED_PROPERTY_PATHS
      ) {
        break;
      }
      const key = serializePropertyPath(path);
      if (!displayedKeys.has(key)) {
        displayedKeys.add(key);
        additions.push(path);
      }
    }
    if (additions.length > 0) {
      this.displayedPropertyPaths = [
        ...this.displayedPropertyPaths,
        ...additions,
      ];
    }
  }

  @Action
  togglePropertyPathVisibility(path: string[]) {
    const previous = this.displayedPropertyPaths;
    this.setPropertyPathsVisibilityImpl({
      paths: [path],
      visible: findIndexOfPath(path, previous) < 0,
    });
    if (previous !== this.displayedPropertyPaths) {
      main.scheduleAnnotationBrowserSave();
    }
  }

  @Action
  setPropertyPathsVisibility({
    paths,
    visible,
  }: {
    paths: string[][];
    visible: boolean;
  }) {
    const previous = this.displayedPropertyPaths;
    this.setPropertyPathsVisibilityImpl({ paths, visible });
    if (previous !== this.displayedPropertyPaths) {
      main.scheduleAnnotationBrowserSave();
    }
  }

  // Restore displayed columns persisted in the configuration. Uses the raw
  // mutation so hydration never schedules a save of its own.
  @Action
  hydrateDisplayedPropertyPaths(paths: string[][]) {
    this.setDisplayedPropertyPaths(paths);
  }

  get getFullNameFromPath() {
    return (propertyPath: string[]) => {
      const propertyId = propertyPath[0];
      if (!propertyId) {
        return null;
      }
      const property = this.getPropertyById(propertyId);
      if (!property) {
        return null;
      }
      const propertyName = property.name;
      const subIds = propertyPath.slice(1);
      const fullName = [propertyName, ...subIds].join(" / ");
      return fullName;
    };
  }

  get getSubIdsNameFromPath() {
    return (propertyPath: string[]) => {
      const propertyId = propertyPath[0];
      if (!propertyId) {
        return null;
      }
      const property = this.getPropertyById(propertyId);
      if (!property) {
        return null;
      }
      const propertyName = property.name;
      const subIds = propertyPath.slice(1);

      // Check if subIds array is empty
      if (subIds.length === 0) {
        // Return only the propertyName if there are no subIds
        return propertyName;
      } else {
        // Otherwise, return the subIds joined by " / "
        return subIds.join(" / ");
      }
    };
  }

  get uncomputedAnnotationsPerProperty() {
    const uncomputed: { [propertyId: string]: IAnnotation[] } = {};
    for (const property of this.properties) {
      uncomputed[property.id] = [];
    }
    for (const annotation of annotations.annotations) {
      for (const property of this.properties) {
        if (
          this.propertyValues[annotation.id]?.[property.id] === undefined &&
          canComputeAnnotationProperty(property, annotation)
        ) {
          uncomputed[property.id].push(annotation);
        }
      }
    }
    return uncomputed;
  }

  // Per-property count of annotations awaiting computation, for the panels'
  // badge / "Compute all" gating. In lazy (stub-only) mode the full annotation
  // set isn't resident, so the client count above is always 0; use the
  // server-computed `uncomputedCounts` instead. This is a plain map (not a
  // function-returning getter) so a `uncomputedCounts` change is tracked as a
  // reactive dependency by consuming computeds.
  get uncomputedCountByProperty(): { [propertyId: string]: number } {
    const lazy = annotations.stubOnlyMode;
    const serverCounts = this.uncomputedCounts;
    const clientCounts = this.uncomputedAnnotationsPerProperty;
    const result: { [propertyId: string]: number } = {};
    for (const property of this.properties) {
      result[property.id] = selectUncomputedCount(
        lazy,
        serverCounts[property.id],
        clientCounts[property.id]?.length ?? 0,
      );
    }
    return result;
  }

  get computedPropertyPaths() {
    // In lazy mode `propertyValues` holds only the visible subset, so the full
    // path set comes from the sampled `discoveredPropertyPaths` instead.
    const leafPaths = annotations.stubOnlyMode
      ? this.discoveredPropertyPaths
      : collectLeafPaths(Object.values(this.propertyValues));

    return leafPaths.filter((path) => {
      // Check that the values have a corresponding property
      if (path.length < 1) {
        return false;
      }
      return this.getPropertyById(path[0]) !== null;
    });
  }

  @Mutation
  private setDisplayedPropertyPaths(paths: string[][]) {
    const unique = uniquePropertyPaths(paths);
    if (unique.length < new Set(paths.map(serializePropertyPath)).size) {
      // A saved configuration can exceed the cap (or the cap may shrink);
      // clamping is the invariant, but a silent drop of saved columns should
      // at least be diagnosable.
      logWarning(
        `Displayed property columns clamped to ${MAX_DISPLAYED_PROPERTY_PATHS}; ` +
          "hide columns to make room for others.",
      );
    }
    this.displayedPropertyPaths = unique;
  }

  @Action
  updateDisplayedFromComputedProperties() {
    // This action is called in a global watcher (see "setupWatchers" in main store)
    // When propertyValues changes, some paths may be removed
    const availablePaths = new Set(
      this.computedPropertyPaths.map((path) => serializePropertyPath(path)),
    );
    // While properties or values haven't been fetched yet for the current
    // dataset, computedPropertyPaths is empty; pruning against it would wipe
    // the paths just hydrated from the configuration. Skip until data arrives.
    if (availablePaths.size === 0) {
      return;
    }
    const newPaths = this.displayedPropertyPaths.filter((displayedPath) =>
      availablePaths.has(serializePropertyPath(displayedPath)),
    );
    this.setDisplayedPropertyPaths(newPaths);
  }

  @Action
  async computeProperty({
    property,
    errorInfo,
  }: {
    property: IAnnotationProperty;
    errorInfo?: IErrorInfoList;
  }) {
    if (!main.dataset) {
      return null;
    }
    const propertyId = property.id;
    const datasetId = main.dataset.id;
    const scales = main.scales;

    const status =
      this.propertyStatuses[propertyId] ??
      (this.propertyStatuses[propertyId] = defaultStatus());
    status.running = true;
    status.previousRun = null;
    status.progressInfo = {};
    const activeErrorInfo = errorInfo ?? { errors: [] };
    activeErrorInfo.errors = [];
    status.errorInfo = activeErrorInfo;

    let progressId;
    try {
      progressId = await progress.create({
        type: ProgressType.PROPERTY_COMPUTE,
        title: `Computing ${property.name}`,
      });
    } catch (error) {
      addComputeError(
        activeErrorInfo,
        "Property progress tracking failed",
        error,
      );
      status.running = false;
      status.previousRun = false;
      return null;
    }
    const run: IPropertyRun = {
      property,
      status,
      errorInfo: activeErrorInfo,
      progressId,
    };

    let response;
    try {
      response = await this.propertiesAPI.computeProperty(
        propertyId,
        datasetId,
        property,
        scales,
      );
    } catch (error) {
      finishPropertyRun(run, false, {
        title: "Property submission failed",
        value: error,
      });
      return null;
    }

    // Keep track of running jobs
    const jobId = response.data[0]?._id;
    if (!jobId) {
      finishPropertyRun(run, false, {
        title: "Property submission failed",
        value: "The server did not return a compute job.",
      });
      return null;
    }

    const computeJob: IPropertyComputeJob = {
      propertyId,
      jobId,
      datasetId,
      eventCallback: (jobData: IJobEventData) => {
        // Handle old progress system
        createProgressEventCallback(status.progressInfo)(jobData);

        // Handle new progress system
        progress.handleJobProgress({
          jobData,
          progressId,
          defaultTitle: `Computing ${property.name}`,
        });
      },
      errorCallback: createErrorEventCallback(activeErrorInfo),
    };

    const completion = jobs.addJob(computeJob);
    void finishPropertyRuns([{ run, completion }], async () => {
      await this.fetchPropertyValues();
      await (await import("./filters")).default.updateHistograms();
    });

    return computeJob;
  }

  @Action
  async computeProperties(
    requestedProperties: IAnnotationProperty[],
  ): Promise<IPropertyComputeJob[]> {
    if (!main.dataset || requestedProperties.length === 0) {
      return [];
    }
    const datasetId = main.dataset.id;
    const eligibleProperties = requestedProperties
      .filter((property) => !this.propertyStatuses[property.id]?.running)
      .slice(0, MAX_PROPERTY_COMPUTE_BATCH);
    if (eligibleProperties.length === 0) {
      return [];
    }

    const runs: IPropertyRun[] = [];
    for (const property of eligibleProperties) {
      const errorInfo: IErrorInfoList = { errors: [] };
      const status =
        this.propertyStatuses[property.id] ??
        (this.propertyStatuses[property.id] = defaultStatus());
      status.running = true;
      status.previousRun = null;
      status.progressInfo = {};
      status.errorInfo = errorInfo;
      try {
        const progressId = await progress.create({
          type: ProgressType.PROPERTY_COMPUTE,
          title: `Computing ${property.name}`,
        });
        runs.push({ property, status, errorInfo, progressId });
      } catch (error) {
        addComputeError(errorInfo, "Property progress tracking failed", error);
        status.running = false;
        status.previousRun = false;
        status.progressInfo = {};
      }
    }
    if (runs.length === 0) {
      return [];
    }
    // Submit each property through the existing per-property endpoint. The
    // requests are sequential and small-N (bounded by the batch cap); a
    // batch submission endpoint is planned as a follow-up backend PR.
    const tracked: {
      run: (typeof runs)[number];
      job: IPropertyComputeJob;
      completion: Promise<boolean>;
    }[] = [];
    let submissionNotificationShown = false;
    for (const run of runs) {
      let jobId;
      try {
        const response = await this.propertiesAPI.computeProperty(
          run.property.id,
          datasetId,
          run.property,
          main.scales,
        );
        jobId = response.data[0]?._id;
      } catch (error) {
        finishPropertyRun(run, false, {
          title: "Property submission failed",
          value: error,
          notify: !submissionNotificationShown,
        });
        submissionNotificationShown = true;
        continue;
      }
      if (!jobId) {
        finishPropertyRun(run, false, {
          title: "Property submission failed",
          value: "The server did not return a compute job.",
          notify: !submissionNotificationShown,
        });
        submissionNotificationShown = true;
        continue;
      }
      const job: IPropertyComputeJob = {
        propertyId: run.property.id,
        jobId,
        datasetId,
        eventCallback: (jobData: IJobEventData) => {
          createProgressEventCallback(run.status.progressInfo)(jobData);
          progress.handleJobProgress({
            jobData,
            progressId: run.progressId,
            defaultTitle: `Computing ${run.property.name}`,
          });
        },
        errorCallback: createErrorEventCallback(run.errorInfo),
      };
      tracked.push({ run, job, completion: jobs.addJob(job) });
    }

    void finishPropertyRuns(tracked, async () => {
      await this.fetchPropertyValues();
      await (await import("./filters")).default.updateHistograms();
    });

    return tracked.map(({ job }) => job);
  }

  // Thin, promise-returning submitter for a single property-compute job.
  // Unlike computeProperty it does NOT own progress creation or the
  // post-completion fetchPropertyValues/updateHistograms — the caller (e.g. the
  // pipeline runner) drives those once for the whole run.
  @Action({ rawError: true })
  async submitPropertyJob({
    property,
    datasetId,
    eventCallback,
    errorCallback,
  }: {
    property: IAnnotationProperty;
    datasetId: string;
    eventCallback?: (data: IJobEventData) => void;
    errorCallback?: (data: IJobEventData) => void;
  }): Promise<{
    job: IPropertyComputeJob;
    completionPromise: Promise<boolean>;
  } | null> {
    if (!main.isLoggedIn) {
      return null;
    }
    const response = await this.propertiesAPI.computeProperty(
      property.id,
      datasetId,
      property,
      main.scales,
    );
    const jobId = response.data[0]?._id;
    if (!jobId) {
      return null;
    }
    const computeJob: IPropertyComputeJob = {
      propertyId: property.id,
      jobId,
      datasetId,
      eventCallback,
      errorCallback,
    };
    // Capture the completion promise immediately (a fast job can be removed
    // from the job map before we could look it up later).
    const completionPromise = jobs.addJob(computeJob);
    return { job: computeJob, completionPromise };
  }

  @Action({ rawError: true })
  async computePropertyBatch({
    property,
    configurationId,
    onBatchProgress,
    onCancel,
    onComplete,
  }: {
    property: IAnnotationProperty;
    configurationId: string;
    onBatchProgress: (status: {
      total: number;
      completed: number;
      failed: number;
      cancelled: number;
      currentDatasetName: string;
    }) => void;
    // Called immediately with the cancel function so the caller can wire up
    // cancellation UI before the batch loop starts (avoids timing issue where
    // awaiting the full batch would delay setting the cancel function).
    onCancel: (cancel: () => void) => void;
    onComplete: (results: {
      succeeded: number;
      failed: number;
      cancelled: number;
    }) => void;
  }): Promise<void> {
    const propertyId = property.id;
    const scales = main.scales;
    const submittedJobIds: string[] = [];
    let isCancelled = false;

    // Create the cancel function and notify the caller immediately
    const cancel = () => {
      isCancelled = true;
      for (const jobId of submittedJobIds) {
        main.api.cancelJob(jobId);
      }
    };
    onCancel(cancel);

    // Get all dataset views for this configuration
    const datasetViews: IDatasetView[] = await main.api.findDatasetViews({
      configurationId,
    });
    const datasetIds = [...new Set(datasetViews.map((v) => v.datasetId))];
    const total = datasetIds.length;

    if (total === 0) {
      onComplete({ succeeded: 0, failed: 0, cancelled: 0 });
      return;
    }

    // Get dataset names for progress display
    const datasetInfo = await main.api.batchResources({
      folder: datasetIds,
    });
    const datasetNames: { [id: string]: string } = {};
    for (const id of datasetIds) {
      datasetNames[id] = datasetInfo.folder?.[id]?.name || "Unknown dataset";
    }

    // Create overall batch progress entry
    const batchProgressId = await progress.create({
      type: ProgressType.BATCH_PROPERTY_COMPUTE,
      title: `Batch: ${property.name}`,
    });
    progress.update({
      id: batchProgressId,
      progress: 0,
      total,
    });

    // Set property status to running
    if (!this.propertyStatuses[propertyId]) {
      this.propertyStatuses[propertyId] = defaultStatus();
    }
    const status = this.propertyStatuses[propertyId];
    status.running = true;
    status.previousRun = null;

    let completed = 0;
    let failed = 0;
    let cancelled = 0;

    for (const datasetId of datasetIds) {
      if (isCancelled) {
        cancelled++;
        onBatchProgress({
          total,
          completed,
          failed,
          cancelled,
          currentDatasetName: datasetNames[datasetId],
        });
        continue;
      }

      const datasetName = datasetNames[datasetId];
      onBatchProgress({
        total,
        completed,
        failed,
        cancelled,
        currentDatasetName: datasetName,
      });

      // Create per-dataset progress entry
      const datasetProgressId = await progress.create({
        type: ProgressType.PROPERTY_COMPUTE,
        title: `${property.name}: ${datasetName}`,
      });

      try {
        const response = await this.propertiesAPI.computeProperty(
          propertyId,
          datasetId,
          property,
          scales,
        );

        const jobId = response.data[0]?._id;
        if (!jobId) {
          failed++;
          progress.complete(datasetProgressId);
        } else {
          submittedJobIds.push(jobId);

          const computeJob: IPropertyComputeJob = {
            propertyId,
            jobId,
            datasetId,
            eventCallback: (jobData: IJobEventData) => {
              progress.handleJobProgress({
                jobData,
                progressId: datasetProgressId,
                defaultTitle: `${property.name}: ${datasetName}`,
              });
            },
          };

          // Capture the completion promise immediately
          const completionPromise = jobs.addJob(computeJob);

          const success = await completionPromise;

          if (isCancelled) {
            cancelled++;
          } else if (success) {
            completed++;
          } else {
            failed++;
          }
          progress.complete(datasetProgressId);
        }
      } catch (error) {
        logError(`Failed to compute property for ${datasetName}: ${error}`);
        failed++;
        progress.complete(datasetProgressId);
      }

      // Update batch progress
      progress.update({
        id: batchProgressId,
        progress: completed + failed + cancelled,
        total,
      });
      onBatchProgress({
        total,
        completed,
        failed,
        cancelled,
        currentDatasetName: datasetName,
      });
    }

    // Complete batch progress
    progress.complete(batchProgressId);

    // Refresh property values for the current dataset. Job completion and
    // client refresh are separate success conditions: a failed refresh must
    // still release the running state and remain visible to the user.
    let refreshSucceeded = true;
    try {
      await this.fetchPropertyValues();
      await (await import("./filters")).default.updateHistograms();
    } catch (error) {
      refreshSucceeded = false;
      const errorInfo = status.errorInfo ?? { errors: [] };
      status.errorInfo = errorInfo;
      addComputeError(errorInfo, "Property refresh failed", error);
    }

    // Update property status
    status.running = false;
    status.previousRun = completed > 0 && failed === 0 && refreshSucceeded;
    status.progressInfo = {};

    onComplete({ succeeded: completed, failed, cancelled });
  }

  @Mutation
  protected setPropertiesImpl(properties: IAnnotationProperty[]) {
    this.properties = [...properties];
  }

  // rawError: true because this rolls back and rethrows so the caller can
  // report the real reason; a bare @Action would replace the message with
  // vuex-module-decorators' generic ERR_ACTION_ACCESS_UNDEFINED text. Part of
  // the create_property chain the AI panel reports on (#1239).
  @Action({ rawError: true })
  protected async setProperties(properties: IAnnotationProperty[]) {
    const previous = this.properties;
    this.setPropertiesImpl(properties);
    const propertyIds = this.properties.map((p) => p.id);
    try {
      await this.context.dispatch("updateConfigurationProperties", propertyIds);
    } catch (error) {
      this.setPropertiesImpl(previous);
      throw error;
    }
    // The persisted plot resolver drops axes whose property is unknown, but a
    // live deletion must do the same immediately. Reconcile only AFTER the
    // propertyIds write succeeds so a failed backend sync leaves both the
    // property list and every plot untouched. The plural action batches all
    // affected plots into one annotation-browser configuration save.
    await (
      await import("./filters")
    ).default.reconcileAnalysisPlotsForPropertyIds(propertyIds);
  }

  @Mutation
  setWorkerImageList(list: IWorkerImageList) {
    this.workerImageList = list;
  }

  @Action
  // Fetch properties corresponding of the configuration
  // This action should be called when changing configuration
  async fetchProperties() {
    if (main.configuration) {
      const properties = await this.propertiesAPI.getProperties(
        main.configuration.propertyIds,
      );
      this.setPropertiesImpl(properties);
      // Properties may load after fetchPropertyValues already ran (the stub
      // fetch can resolve first when cached), so trigger the count fetch here
      // too; the guard in fetchUncomputedCounts dedupes (no-op in wholesale
      // mode or before stub-only mode is known).
      this.fetchUncomputedCounts();
    }
  }

  // Smart entry used by callers (dataset mount, import, compute completion).
  // In lazy (stub-only) mode it avoids loading every value into memory: it
  // discovers paths from a sample and loads values only for the visible set.
  // Otherwise it loads everything as before. The property-filter case (which
  // still needs every value for client-side filtered drawing) is handled by
  // AnnotationViewer, which calls fetchAllPropertyValues while a filter is on.
  @Action({ rawError: true })
  async fetchPropertyValues() {
    if (!main.dataset?.id) {
      return;
    }
    this.bumpPropertyValuesRevision();
    if (annotations.stubOnlyMode) {
      await this.fetchPropertyPathsSample();
      this.ensureVisiblePropertyValues();
      this.fetchUncomputedCounts();
      return;
    }
    await this.fetchAllPropertyValues();
  }

  // Lazy mode: refresh the per-property uncomputed-annotation counts from the
  // server (counts only — never values). No-op in wholesale mode, where the
  // count is derived from the resident annotation set. Runs the fetch outside
  // the action proxy (vuex-module-decorators breaks state/mutation access
  // after await).
  @Action
  fetchUncomputedCounts() {
    // Needs both lazy mode AND a loaded property list. These are populated by
    // two independent async flows (fetchAnnotations sets stubOnlyMode;
    // fetchProperties loads properties) with no guaranteed order, so this is
    // called from both fetchPropertyValues and fetchProperties; the
    // properties-empty guard makes whichever fires first a no-op, so it runs
    // exactly once per open (when both are ready). No properties => nothing to
    // count.
    if (
      !annotations.stubOnlyMode ||
      !main.dataset?.id ||
      this.properties.length === 0
    ) {
      return;
    }
    _fetchUncomputedCounts(
      this.propertiesAPI,
      main.dataset.id,
      this.properties,
    );
  }

  @Action({ rawError: true })
  async fetchAllPropertyValues() {
    if (!main.dataset?.id) {
      return;
    }
    const values = await this.propertiesAPI.getPropertyValues(main.dataset.id);
    this.updatePropertyValues(values);
  }

  @Action({ rawError: true })
  async fetchPropertyPathsSample() {
    if (!main.dataset?.id) {
      return;
    }
    const sample = await this.propertiesAPI.getPropertyValuesSample(
      main.dataset.id,
      PROPERTY_PATH_SAMPLE_SIZE,
    );
    this.setDiscoveredPropertyPaths(
      collectLeafPaths(sample.map((entry) => entry.values)),
    );
  }

  // Lazy mode: ensure the rendered annotations have values for the displayed
  // columns, pruning the cache to that set. Runs the fetch outside the action
  // proxy (vuex-module-decorators breaks after await).
  @Action
  ensureVisiblePropertyValues() {
    if (!annotations.stubOnlyMode || !main.dataset?.id) {
      return;
    }
    // Claim the latest token up front so any in-flight fetch from a prior call
    // is superseded (and a synchronous prune below reflects the latest set).
    const token = visiblePropertyValuesGuard.next();
    const visibleIds = [...annotations.visibleAnnotationIds];
    const keepIds = new Set(visibleIds);
    const paths = this.displayedPropertyPaths;
    const idsToFetch = idsMissingPaths(visibleIds, this.propertyValues, paths);
    if (idsToFetch.length === 0) {
      // Nothing to fetch; only prune if the cache holds values outside the
      // visible set. Skipping the no-op rebuild avoids churning the tooltip /
      // path watchers on every pan when nothing actually changed.
      const hasStale = Object.keys(this.propertyValues).some(
        (id) => !keepIds.has(id),
      );
      if (hasStale) {
        this.mergeVisiblePropertyValues({ newEntries: [], keepIds });
      }
      return;
    }
    _fetchVisiblePropertyValues(
      this.propertiesAPI,
      main.dataset.id,
      idsToFetch,
      paths,
      keepIds,
      token,
    );
  }

  // rawError: true because both awaits here propagate on failure (the
  // annotation_property POST, and the propertyIds sync inside setProperties)
  // and the AI panel reports that reason to the user. See setProperties.
  @Action({ rawError: true })
  async createProperty(property: IAnnotationPropertyConfiguration) {
    const newProperty = await this.propertiesAPI.createProperty(property);
    if (newProperty) {
      await this.setProperties([...this.properties, newProperty]);
    }
    return newProperty;
  }

  // Both deletion actions propagate configuration-sync failures to callers;
  // rawError preserves the backend message across each decorator boundary.
  @Action({ rawError: true })
  async deleteProperty(propertyId: string) {
    await this.deleteProperties([propertyId]);
  }

  // Batch variant: removes all the given properties with a single
  // configuration sync instead of one per property.
  @Action({ rawError: true })
  async deleteProperties(propertyIds: string[]) {
    // TODO: temp another configuration could be using this property!
    // await this.propertiesAPI.deleteProperty(propertyId);
    const removedIds = new Set(propertyIds);
    await this.setProperties(
      this.properties.filter((p) => !removedIds.has(p.id)),
    );
  }

  @Action
  async deletePropertyValues(propertyId: string) {
    if (!main.dataset?.id) {
      return;
    }
    await this.propertiesAPI.deletePropertyValues(propertyId, main.dataset.id);
    await this.fetchPropertyValues();
  }

  @Action
  async fetchWorkerImageList() {
    if (!main.isLoggedIn) {
      return;
    }
    const list = await this.propertiesAPI.getWorkerImages();
    // Filter out test images (those with ":test" in their name)
    const filteredList: IWorkerImageList = {};
    for (const [imageName, imageData] of Object.entries(list)) {
      if (!imageName.includes(":test")) {
        // images with ":test" are used for unit tests and so should not be shown
        filteredList[imageName] = imageData;
      }
    }
    this.setWorkerImageList(filteredList);
  }

  @Action
  async requestWorkerInterface(image: string) {
    const response = await this.propertiesAPI.requestWorkerInterface(image);
    const jobId = response.data[0]?._id;
    if (!jobId) {
      return;
    }
    return jobs.addJob({ jobId: jobId, datasetId: main.dataset?.id || null });
  }

  @Action
  async requestWorkerPreview({
    image,
    tool,
    workerInterface,
  }: {
    image: string;
    tool: IToolConfiguration;
    workerInterface: IWorkerInterfaceValues;
  }) {
    if (!main.dataset || !main.configuration) {
      return;
    }
    const datasetId = main.dataset.id;
    const { location, channel } = await annotations.context.dispatch(
      "getAnnotationLocationFromTool",
      tool,
    );
    const tile = { ...location };
    this.propertiesAPI
      .requestWorkerPreview(
        image,
        tool,
        datasetId,
        workerInterface,
        {
          location,
          channel,
          tile,
        },
        main.layers,
      )
      .then((response: any) => {
        // Keep track of running jobs
        const job = response.data[0];
        if (!job) {
          return;
        }
        if (job && job._id) {
          jobs
            .addJob({
              jobId: job._id,
              datasetId: main.dataset?.id || "",
            })
            .then((success: boolean) => {
              if (success) {
                this.clearPendingWorkerPreviewTimeout(image);
                this.fetchWorkerPreview(image);
              }
            });
          const handle = setTimeout(() => {
            this.clearPendingWorkerPreviewTimeout(image);
            this.fetchWorkerPreview(image);
          }, 5000);
          this.setPendingWorkerPreviewTimeout({ image, handle });
        }
      });
  }

  get showAdvancedOptionsPanel() {
    return (image: string) => {
      const labels = this.workerImageList[image];
      return labels
        ? labels.advancedOptionsPanel?.toLowerCase() !== "false"
        : true;
    };
  }

  get showAnnotationConfigurationPanel() {
    return (image: string) => {
      const labels = this.workerImageList[image];
      return labels
        ? labels.annotationConfigurationPanel?.toLowerCase() !== "false"
        : true;
    };
  }

  get defaultToolName() {
    return (image: string) => {
      const labels = this.workerImageList[image];
      return labels ? labels.defaultToolName : null;
    };
  }

  get hasPreview() {
    return (image: string) => {
      const labels = this.workerImageList[image];
      return labels ? labels.hasPreview?.toLowerCase() === "true" : false;
    };
  }
}

const propertiesModule = getModule(Properties);
export default propertiesModule;

// Stale-response guard for the visible-property-value fetch: rapid pans can fire
// overlapping fetches scoped to different visible sets; only the latest may
// merge. Without it, a slow earlier fetch resolving last prunes freshly-fetched
// entries against its stale keepIds.
const visiblePropertyValuesGuard = createSequenceGuard();

/**
 * Fetch property values for the given ids (lazy mode) and merge them scoped to
 * `keepIds`. Runs outside the Vuex action proxy — vuex-module-decorators breaks
 * state/mutation access after `await`, so we commit via the module instance.
 *
 * `token` is the guard token captured when this fetch was scheduled; the result
 * is dropped if a newer fetch/prune superseded it while we were awaiting.
 */
async function _fetchVisiblePropertyValues(
  api: typeof main.propertiesAPI,
  datasetId: string,
  idsToFetch: string[],
  paths: string[][],
  keepIds: Set<string>,
  token: number,
) {
  try {
    const newEntries = await api.getPropertyValuesForIds(
      datasetId,
      idsToFetch,
      paths,
    );
    if (visiblePropertyValuesGuard.isCurrent(token)) {
      propertiesModule.mergeVisiblePropertyValues({ newEntries, keepIds });
    }
  } catch (error) {
    logError(`Property value fetch failed: ${(error as Error).message}`);
  }
}

/**
 * Fetch the per-property uncomputed-annotation counts (lazy mode) and store
 * them. Runs outside the Vuex action proxy — vuex-module-decorators breaks
 * state/mutation access after `await`, so we commit via the module instance.
 */
async function _fetchUncomputedCounts(
  api: typeof main.propertiesAPI,
  datasetId: string,
  properties: IAnnotationProperty[],
) {
  try {
    const counts = await api.getUncomputedCounts(datasetId, properties);
    propertiesModule.setUncomputedCounts(counts);
  } catch (error) {
    logError(`Uncomputed count fetch failed: ${(error as Error).message}`);
  }
}

// Self-accept HMR to prevent vuex-module-decorators from re-registering
// the dynamic module (which causes duplicate getters and state overwrites).
if (import.meta.hot) {
  import.meta.hot.accept();
}

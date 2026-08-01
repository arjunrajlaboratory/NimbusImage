import {
  getModule,
  Action,
  Module,
  Mutation,
  VuexModule,
} from "vuex-module-decorators";
import store from "./root";

import main from "./index";
import sync from "./sync";
import jobs, {
  createProgressEventCallback,
  createErrorEventCallback,
} from "./jobs";

import {
  IAnnotation,
  IAnnotationConnection,
  IGeoJSPosition,
  IToolConfiguration,
  IAnnotationBase,
  IAnnotationConnectionBase,
  IWorkerInterfaceValues,
  IAnnotationComputeJob,
  IProgressInfo,
  IErrorInfoList,
  ProgressType,
  IJobEventData,
  IDatasetView,
  IAnnotationLocation,
  type IAnnotationStub,
  type TAnnotationOrStub,
  type THydrationMode,
  type IVisibilityConfig,
  resolveVisibilityConfig,
  ANNOTATION_LIST_SERVER_THRESHOLD,
} from "./model";
import type AnnotationsAPI from "./AnnotationsAPI";

import { markRaw, toRaw } from "vue";
import {
  simpleCentroid,
  selectStableSubset,
  selectLargestBySize,
  stubFromAnnotation,
  idsNeedingHydration,
  planHydrationEvictions,
  idHasHydratableShape,
  materializeStubAnnotation,
} from "@/utils/annotation";
import { selectVisibleIds, clampVisibleBudget } from "@/utils/visibilityBudget";
import { annotationSpatialIndex } from "@/utils/spatialIndex";
import {
  createDebouncedAbortableTask,
  isAbortError,
} from "@/utils/debouncedAbortable";
import {
  buildStubUpdates,
  getAnnotationUpdatePatch,
  type AnnotationUpdatePatch,
  type IStubFieldUpdate,
} from "@/utils/annotationUpdate";
import { logError } from "@/utils/log";
import { TIMELAPSE_CONNECTION_TAG } from "./constants";
import { stubPerf } from "@/utils/stubPerf";
import { annotationLoadingTitle } from "@/utils/loadingLabels";
import progress from "./progress";
import { IAnnotationSetup } from "@/tools/creation/templates/AnnotationConfiguration.vue";

type IndexedAnnotationUpdate = {
  annotation: IAnnotation;
  index: number;
  updateCentroid?: boolean;
};

function cloneAnnotation(annotation: IAnnotation): IAnnotation {
  const rawAnnotation = toRaw(annotation);
  return markRaw({
    ...rawAnnotation,
    tags: [...rawAnnotation.tags],
    location: { ...rawAnnotation.location },
    coordinates: toRaw(rawAnnotation.coordinates),
  });
}

@Module({ dynamic: true, store, name: "annotation" })
export class Annotations extends VuexModule {
  annotationsAPI = main.annotationsAPI;

  // Annotations from the current dataset and configuration
  annotations: IAnnotation[] = [];
  // Connections from the current dataset and configuration
  annotationConnections: IAnnotationConnection[] = [];

  annotationCentroids: { [annotationId: string]: IGeoJSPosition } = {};
  annotationIdToIdx: { [annotationId: string]: number } = {};

  selectedAnnotationIds: Set<string> = markRaw(new Set());
  activeAnnotationIds: string[] = [];

  // Store copied annotations for paste operation
  copiedAnnotations: IAnnotation[] = [];

  pendingAnnotation: IAnnotation | null = null;
  submitPendingAnnotationTimeout: number = 1;
  submitPendingAnnotation: ((submit: boolean) => void) | null = null;

  isDeletingAnnotations: boolean = false;

  // When true, annotations[] is empty and all metadata lives in annotationStubs.
  stubOnlyMode: boolean = false;

  // Whether the annotation browser list should use the backend-paginated
  // (server) list instead of materializing a client-side v-data-table. True in
  // stub-only mode (the client has no full annotations to list) and for
  // fully-fetched datasets too large to sort/render as client table rows —
  // possible because stubThreshold (a data-loading knob) can sit well above
  // the table's materialization limit. Note: the server list cannot apply ROI
  // filters (a client-side polygon test); the list UI surfaces a warning.
  get isListServerMode() {
    return (
      this.stubOnlyMode ||
      this.annotations.length > ANNOTATION_LIST_SERVER_THRESHOLD
    );
  }

  get allAnnotationIds() {
    if (this.stubOnlyMode) {
      return Array.from(this.annotationStubs.keys());
    }
    return this.annotations.map((annotation: IAnnotation) => annotation.id);
  }

  get isAnnotationSelected() {
    const ids = this.selectedAnnotationIds;
    return (annotationId: string) => ids.has(annotationId);
  }

  get isDeleting() {
    return this.isDeletingAnnotations;
  }

  get inactiveAnnotationIds() {
    const activeIds = new Set(this.activeAnnotationIds);
    return this.allAnnotationIds.filter((id: string) => !activeIds.has(id));
  }

  get getAnnotationFromId() {
    // Resolved once per getter access (not per call) so the hot resolution path
    // — and callers that capture this function once and call it in a loop (e.g.
    // the connection-draw loop) — don't pay a cross-store `main.dataset` read on
    // every id. Only used to stamp materialized point stubs (below).
    const datasetId = main.dataset?.id ?? "";
    return (annotationId: string): IAnnotation | undefined => {
      const hydrated = this.hydratedAnnotations.get(annotationId);
      if (hydrated) {
        return hydrated;
      }
      const idx = this.annotationIdToIdx[annotationId];
      if (idx !== undefined) {
        return this.annotations[idx];
      }
      // A point never hydrates (its centroid IS its only coordinate), so resolve
      // a point stub to a materialized full annotation. This keeps connection
      // rendering, copy/paste, and timelapse linking — all of which resolve ids
      // through this getter — working for point annotations in stub-only mode.
      // Non-point stubs return undefined (they need real hydration).
      const stub = this.annotationStubs.get(annotationId);
      return stub ? materializeStubAnnotation(stub, datasetId) : undefined;
    };
  }

  /**
   * Resolve an id to whatever representation is loaded — hydrated, full, or
   * raw stub — without materializing the whole stub map. Unlike
   * `getAnnotationFromId`, this returns non-point stubs as-is (typed as the
   * honest union), so callers that only need stub fields can look ids up in
   * O(1) instead of scanning `annotationsForIteration`.
   */
  get getAnnotationOrStubFromId() {
    return (annotationId: string): TAnnotationOrStub | undefined => {
      const hydrated = this.hydratedAnnotations.get(annotationId);
      if (hydrated) {
        return hydrated;
      }
      const idx = this.annotationIdToIdx[annotationId];
      if (idx !== undefined) {
        return this.annotations[idx];
      }
      return this.annotationStubs.get(annotationId);
    };
  }

  get annotationTags() {
    const tagSet: Set<string> = new Set();
    if (this.stubOnlyMode) {
      for (const stub of this.annotationStubs.values()) {
        for (const tag of stub.tags) {
          tagSet.add(tag);
        }
      }
    } else {
      for (const { tags } of this.annotations) {
        for (const tag of tags) {
          tagSet.add(tag);
        }
      }
    }
    return tagSet;
  }

  /**
   * How many objects the dataset has, without allocating. Deliberately not
   * `annotationsForIteration.length`: that materializes an array from the stub
   * map, which is 700K+ entries on a large dataset — far too expensive for a
   * count rendered in a tab badge.
   */
  get annotationCount(): number {
    return this.stubOnlyMode
      ? this.annotationStubs.size
      : this.annotations.length;
  }

  get annotationsForIteration(): TAnnotationOrStub[] {
    if (!this.stubOnlyMode) {
      return this.annotations;
    }
    // In stub-only mode the full annotations[] array is empty; iterate the
    // stub map instead. Typed as the honest union so consumers must narrow via
    // isHydratedAnnotation before touching coordinates/name/shape (Finding 6).
    return Array.from(this.annotationStubs.values());
  }

  hoveredAnnotationId: string | null = null;

  annotationStubs: Map<string, IAnnotationStub> = markRaw(new Map());
  hydratedAnnotations: Map<string, IAnnotation> = markRaw(new Map());
  visibleAnnotationIds: Set<string> = markRaw(new Set());
  hydrationMode: THydrationMode = "dots";
  visibilityConfig: IVisibilityConfig = resolveVisibilityConfig();

  // Average annotation radius (world units) over the loaded stubs, computed once
  // when stubs are set. Feeds the density-derived zoomed-out render budget.
  averageStubRadius = 0;

  // Counts within the ACTUAL (unexpanded) viewport on the current frame, set by
  // each visibility update. The render-coverage indicator reads these to show
  // how much of what's in view is actually drawn.
  viewportAnnotationCount = 0;
  viewportRenderedCount = 0;

  @Mutation
  setVisibilityConfig(config: Partial<IVisibilityConfig>) {
    this.visibilityConfig = { ...this.visibilityConfig, ...config };
  }

  @Mutation
  replaceVisibilityConfig(config?: Partial<IVisibilityConfig>) {
    this.visibilityConfig = resolveVisibilityConfig(config);
  }

  // Load configuration metadata over the shipped defaults so configurations
  // created before persistence (and partial metadata from future migrations)
  // always get a complete, independent settings object.
  @Action
  loadVisibilityConfig(config?: Partial<IVisibilityConfig>) {
    this.replaceVisibilityConfig(config);
  }

  @Action
  async updateVisibilityConfig(config: Partial<IVisibilityConfig>) {
    this.setVisibilityConfig(config);
    await main.saveVisibilityConfig(this.visibilityConfig);
  }

  // Reset the shared configuration metadata as well as the live renderer.
  @Action
  async resetVisibilityConfig() {
    this.replaceVisibilityConfig();
    await main.saveVisibilityConfig(this.visibilityConfig);
  }

  @Mutation
  setAverageStubRadius(value: number) {
    this.averageStubRadius = value;
  }

  @Mutation
  setViewportCounts(counts: { total: number; rendered: number }) {
    this.viewportAnnotationCount = counts.total;
    this.viewportRenderedCount = counts.rendered;
  }

  get isHydrated() {
    return (id: string): boolean => this.hydratedAnnotations.has(id);
  }

  get getStub() {
    return (id: string): IAnnotationStub | undefined =>
      this.annotationStubs.get(id);
  }

  get getHydratedAnnotation() {
    return (id: string): IAnnotation | undefined =>
      this.hydratedAnnotations.get(id);
  }

  get isVisible() {
    return (id: string): boolean => this.visibleAnnotationIds.has(id);
  }

  get shouldRenderAsShape() {
    return (id: string): boolean => {
      if (this.selectedAnnotationIds.has(id)) {
        return this.hydratedAnnotations.has(id);
      }
      return (
        this.hydrationMode === "shapes" && this.hydratedAnnotations.has(id)
      );
    };
  }

  get getForRendering() {
    return (id: string): TAnnotationOrStub | undefined => {
      if (this.shouldRenderAsShape(id)) {
        return this.hydratedAnnotations.get(id);
      }
      return this.annotationStubs.get(id);
    };
  }

  @Mutation
  setCopiedAnnotations(annotations: IAnnotation[]) {
    this.copiedAnnotations = annotations;
  }

  @Action
  copySelectedAnnotations() {
    this.setCopiedAnnotations(
      [...this.selectedAnnotationIds]
        .map((id) => this.getAnnotationFromId(id))
        .filter((a): a is IAnnotation => a !== undefined),
    );
  }

  @Action
  async createMultipleAnnotations(
    annotationBases: IAnnotationBase[],
  ): Promise<IAnnotation[]> {
    if (annotationBases.length === 0 || !main.isLoggedIn) {
      return [];
    }

    sync.setSaving(true);
    try {
      const newAnnotations =
        await this.annotationsAPI.createMultipleAnnotations(annotationBases);

      // Add the new annotations to the store
      if (newAnnotations && newAnnotations.length > 0) {
        this.addAnnotationsImpl(newAnnotations);
      }

      return newAnnotations || [];
    } catch (error) {
      logError((error as Error).message);
      return [];
    } finally {
      sync.setSaving(false);
    }
  }

  @Action
  async pasteAnnotations() {
    if (!this.copiedAnnotations.length || !main.dataset) {
      return;
    }

    // Get current location
    const currentLocation = {
      XY: main.xy,
      Z: main.z,
      Time: main.time,
    };

    // Create new annotation bases from copied annotations with updated location
    const annotationBases: IAnnotationBase[] = this.copiedAnnotations.map(
      (annotation) => {
        // Create a deep clone of the annotation to avoid mutating the original
        return {
          tags: [...annotation.tags],
          shape: annotation.shape,
          location: { ...currentLocation },
          channel: annotation.channel,
          coordinates: [...annotation.coordinates],
          datasetId: main.dataset!.id,
          color: annotation.color,
        };
      },
    );

    // Create the new annotations
    await this.createMultipleAnnotations(annotationBases);
  }

  @Action
  async undoOrRedo(undo: boolean) {
    if (!main.isLoggedIn) {
      return;
    }
    // Undo the pending annotation if there is one
    if (undo && this.submitPendingAnnotation) {
      this.submitPendingAnnotation(false);
      return;
    }

    // Otherwise, call the undo/redo endpoint of the API and refetch annotations
    const datasetId = main.dataset?.id;
    if (!datasetId) {
      return;
    }
    try {
      sync.setSaving(true);
      // Add progress bar
      let progressId: string | null = null;
      if (undo) {
        progressId = await progress.create({
          type: ProgressType.ANNOTATION_UNDO,
          title: "Undoing",
        });
        await this.annotationsAPI.undo(datasetId);
      } else {
        progressId = await progress.create({
          type: ProgressType.ANNOTATION_REDO,
          title: "Redoing",
        });
        await this.annotationsAPI.redo(datasetId);
      }
      this.context.dispatch("fetchAnnotations");
      progress.complete(progressId);
      sync.setSaving(false);
    } catch (error) {
      sync.setSaving(error as Error);
    }
  }

  @Mutation
  public setHoveredAnnotationId(id: string | null) {
    this.hoveredAnnotationId = id;
  }

  @Mutation
  protected resetAnnotationStateImpl() {
    this.selectedAnnotationIds = markRaw(new Set());
    this.activeAnnotationIds = [];
    this.copiedAnnotations = [];
    this.hoveredAnnotationId = null;
    this.pendingAnnotation = null;
    this.submitPendingAnnotation = null;
    // Drop the previous dataset's annotations and connections. Without this,
    // navigating away from a viewer (e.g. on logout, or to a non-viewer
    // route) leaves the full array pinned on the heap until the next viewer
    // entry calls fetchAnnotations.
    this.annotations = [];
    this.annotationConnections = [];
    this.annotationCentroids = markRaw({});
    this.annotationIdToIdx = markRaw({});
    // Stub-only state. Without this, switching/clearing a large dataset (e.g.
    // 708K) leaves the stub map, hydration cache, and centroid spatial index
    // pinned on the heap until the next fetchAnnotations happens to call
    // setAnnotations([]) — a memory leak and a stale-state risk. Mirror the
    // empty-load clearing semantics here, and cancel any in-flight viewport
    // hydration so a late response can't repopulate the just-cleared cache.
    this.annotationStubs = markRaw(new Map());
    this.hydratedAnnotations = markRaw(new Map());
    this.visibleAnnotationIds = markRaw(new Set());
    this.viewportAnnotationCount = 0;
    this.viewportRenderedCount = 0;
    this.averageStubRadius = 0;
    this.stubOnlyMode = false;
    annotationSpatialIndex.clear();
    viewportHydrationTask.cancel();
  }

  // Clear per-dataset annotation state. Call when switching datasets so
  // stale references (selection, active set, copied annotations, hover,
  // pending) don't pin objects from the previous view.
  @Action
  public resetAnnotationState() {
    // If a submission is pending, cancel it so the awaiting Promise inside
    // getAnnotationSubmission resolves (with `false`) and its timer is
    // cleared. Otherwise nulling submitPendingAnnotation in the mutation
    // below would orphan the Promise — the timer's
    // `submitPendingAnnotation?.(true)` would no-op, and createAnnotation
    // would await indefinitely. The callback itself nulls
    // submitPendingAnnotation and pendingAnnotation via their setters.
    if (this.submitPendingAnnotation) {
      this.submitPendingAnnotation(false);
    }
    this.resetAnnotationStateImpl();
  }

  @Mutation
  public activateAnnotations(ids: string[]) {
    const activeIds = new Set(this.activeAnnotationIds);
    const idsToAdd = ids.filter((id: string) => !activeIds.has(id));
    if (idsToAdd.length > 0) {
      this.activeAnnotationIds.push(...idsToAdd);
    }
  }

  @Mutation
  public deactivateAnnotations(ids: string[]) {
    const idsToRemove = new Set(ids);
    this.activeAnnotationIds = this.activeAnnotationIds.filter(
      (id: string) => !idsToRemove.has(id),
    );
  }

  @Action
  public toggleActiveAnnotations(ids: string[]) {
    const activeIds = new Set(this.activeAnnotationIds);
    const toRemove = ids.filter((id: string) => activeIds.has(id));
    const toAdd = ids.filter((id: string) => !activeIds.has(id));
    this.activateAnnotations(toAdd);
    this.deactivateAnnotations(toRemove);
  }

  @Action
  public toggleActiveAnnotation(id: string) {
    this.toggleActiveAnnotations([id]);
  }

  @Mutation
  public setSelected(ids: string[]) {
    this.selectedAnnotationIds = markRaw(new Set(ids));
  }

  @Mutation
  public selectAnnotation(id: string) {
    if (this.selectedAnnotationIds.has(id)) {
      return;
    }
    this.selectedAnnotationIds = markRaw(
      new Set([...this.selectedAnnotationIds, id]),
    );
  }

  @Mutation
  public selectAnnotations(ids: string[]) {
    const current = this.selectedAnnotationIds;
    const toAdd = ids.filter((id) => !current.has(id));
    if (toAdd.length > 0) {
      this.selectedAnnotationIds = markRaw(new Set([...current, ...toAdd]));
    }
  }

  @Mutation
  public unselectAnnotation(id: string) {
    if (!this.selectedAnnotationIds.has(id)) {
      return;
    }
    const next = new Set(this.selectedAnnotationIds);
    next.delete(id);
    this.selectedAnnotationIds = markRaw(next);
  }

  @Mutation
  public unselectAnnotations(ids: string[]) {
    if (ids.length === 0) return;
    const toRemove = new Set(ids);
    this.selectedAnnotationIds = markRaw(
      new Set(
        [...this.selectedAnnotationIds].filter((id) => !toRemove.has(id)),
      ),
    );
  }

  @Action
  public toggleSelected(ids: string[]) {
    const toggledIds = new Set(ids);
    const current = this.selectedAnnotationIds;

    const next: string[] = [];
    for (const id of current) {
      if (!toggledIds.has(id)) {
        next.push(id);
      }
    }
    for (const id of ids) {
      if (!current.has(id)) {
        next.push(id);
      }
    }

    this.setSelected(next);
  }

  @Mutation
  setPendingAnnotation(annotationBase: IAnnotationBase | null) {
    if (!annotationBase) {
      this.pendingAnnotation = null;
    } else {
      this.pendingAnnotation = {
        ...annotationBase,
        id: "pendingAnnotation",
        name: null,
      };
    }
  }

  @Mutation
  setSubmitPendingAnnotationFunction(
    newSubmitFunction: ((x: boolean) => void) | null,
  ) {
    this.submitPendingAnnotation = newSubmitFunction;
  }

  @Action
  private getAnnotationSubmission(annotationBase: IAnnotationBase) {
    // If there is a pending annotation, submit it
    this.submitPendingAnnotation?.(true);

    // Set pending annotation for preview
    this.setPendingAnnotation(annotationBase);

    // Start a new timer to submit the annotation
    const timeoutId = setTimeout(() => {
      this.submitPendingAnnotation?.(true);
    }, 1000 * this.submitPendingAnnotationTimeout);

    // Create a new promise and get its "resolve" function
    let promiseResolve: (submit: boolean) => void;
    const outputPromise = new Promise<boolean>(
      (resolve) => (promiseResolve = resolve),
    );

    // This function will submit or cancel the annotation
    const newSubmitFunction = (x: boolean) => {
      this.setSubmitPendingAnnotationFunction(null);
      this.setPendingAnnotation(null);
      clearTimeout(timeoutId);
      promiseResolve(x);
    };

    this.setSubmitPendingAnnotationFunction(newSubmitFunction);

    return outputPromise;
  }

  @Action
  public async createAnnotation(
    annotationBase: IAnnotationBase,
  ): Promise<IAnnotation | null> {
    const submitted = await this.getAnnotationSubmission(annotationBase);
    if (!submitted || !main.isLoggedIn) {
      return null;
    }

    sync.setSaving(true);
    const newAnnotation =
      await this.annotationsAPI.createAnnotation(annotationBase);
    sync.setSaving(false);
    return newAnnotation;
  }

  @Action
  private async addConnectionsForNewAnnotation({
    annotation,
    toolConfiguration,
  }: {
    annotation: IAnnotation;
    toolConfiguration: IToolConfiguration;
  }): Promise<IAnnotationConnection[]> {
    // Find eligible annotations (matching tags and channel)
    const connectTo = toolConfiguration.values.connectTo;
    if (!connectTo?.tags?.length) {
      return [];
    }
    const connectToTags = connectTo.tags;
    const connectToLayer = main.getLayerFromId(connectTo.layer);
    const connectToChannel = connectToLayer?.channel ?? null;

    // API call, the server creates the annotation itself
    const connections =
      (await this.createConnections({
        annotationsIds: [annotation.id],
        tags: connectToTags,
        channelId: connectToChannel,
      })) ?? [];

    // Add the annotations to the store
    connections.forEach((connection: any) => {
      this.addConnectionImpl(connection);
    });

    return connections;
  }

  @Action
  public async addAnnotationFromTool({
    coordinates,
    toolConfiguration,
    datasetId,
  }: {
    coordinates: IGeoJSPosition[];
    toolConfiguration: IToolConfiguration;
    datasetId: string;
  }): Promise<IAnnotation | null> {
    // Create the new annotation on the server
    const { location, channel } =
      await this.getAnnotationLocationFromTool(toolConfiguration);
    const { tags, shape, color } = toolConfiguration.values.annotation;
    const annotationBase: IAnnotationBase = {
      tags,
      shape,
      location,
      channel,
      coordinates,
      datasetId,
      color: color ?? null, // Can be undefined because color was optional
    };
    const annotation = await this.createAnnotation(annotationBase);
    if (!annotation) {
      return null;
    }

    // Add to the store
    this.addAnnotationImpl(annotation);

    // Create the connections
    await this.addConnectionsForNewAnnotation({
      annotation,
      toolConfiguration,
    });

    return annotation;
  }

  // Single interactive add. Clones the whole stub/hydrated maps, so it is
  // O(stub count) per call and MUST NOT be looped (Finding 16) — bulk creation
  // goes through addAnnotationsImpl, which clones each map once for the batch.
  @Mutation
  private addAnnotationImpl(value: IAnnotation) {
    const annotation = markRaw(value);
    this.annotations = [...this.annotations, annotation];
    this.annotationCentroids[annotation.id] = markRaw(
      simpleCentroid(annotation.coordinates),
    );
    this.annotationIdToIdx[value.id] = this.annotations.length - 1;

    const centroid = this.annotationCentroids[value.id];
    this.annotationStubs = markRaw(
      new Map(this.annotationStubs).set(
        value.id,
        stubFromAnnotation(value, centroid),
      ),
    );

    // New annotations are always hydrated
    this.hydratedAnnotations = markRaw(
      new Map(this.hydratedAnnotations).set(value.id, value),
    );

    // Spatial index
    annotationSpatialIndex.insert(value.id, centroid.x, centroid.y);
  }

  @Mutation
  private addAnnotationsImpl(values: IAnnotation[]) {
    const startIndex = this.annotations.length;
    const annotations = values.map((annotation) => markRaw(annotation));
    this.annotations = [...this.annotations, ...annotations];

    const newStubs = new Map(this.annotationStubs);
    const newHydrated = new Map(this.hydratedAnnotations);
    for (let offset = 0; offset < annotations.length; ++offset) {
      const annotation = annotations[offset];
      const index = startIndex + offset;
      const centroid = markRaw(simpleCentroid(annotation.coordinates));
      this.annotationCentroids[annotation.id] = centroid;
      this.annotationIdToIdx[annotation.id] = index;

      newStubs.set(annotation.id, stubFromAnnotation(annotation, centroid));

      // New annotations are always hydrated
      newHydrated.set(annotation.id, annotation);

      // Spatial index
      annotationSpatialIndex.insert(annotation.id, centroid.x, centroid.y);
    }
    this.annotationStubs = markRaw(newStubs);
    this.hydratedAnnotations = markRaw(newHydrated);
  }

  @Mutation
  private setAnnotation({
    annotation,
    index,
  }: {
    annotation: IAnnotation;
    index: number;
  }) {
    // Remove old position from spatial index
    const oldStub = this.annotationStubs.get(annotation.id);
    if (oldStub) {
      annotationSpatialIndex.remove(annotation.id);
    }

    const nextAnnotations = [...this.annotations];
    nextAnnotations[index] = markRaw(annotation);
    this.annotations = nextAnnotations;
    this.annotationCentroids[annotation.id] = markRaw(
      simpleCentroid(annotation.coordinates),
    );
    this.annotationIdToIdx[annotation.id] = index;

    const centroid = this.annotationCentroids[annotation.id];
    const newStubs = new Map(this.annotationStubs);
    newStubs.set(annotation.id, stubFromAnnotation(annotation, centroid));
    this.annotationStubs = markRaw(newStubs);

    // Update hydrated if present
    if (this.hydratedAnnotations.has(annotation.id)) {
      this.hydratedAnnotations = markRaw(
        new Map(this.hydratedAnnotations).set(annotation.id, annotation),
      );
    }

    // Insert new position into spatial index
    annotationSpatialIndex.insert(annotation.id, centroid.x, centroid.y);
  }

  @Mutation
  private setAnnotationsAtIndices(values: IndexedAnnotationUpdate[]) {
    if (!values.length) {
      return;
    }

    const nextAnnotations = [...this.annotations];
    const nextStubs = new Map(this.annotationStubs);
    const nextHydrated = new Map(this.hydratedAnnotations);
    let hydratedChanged = false;
    for (const { annotation: value, index, updateCentroid = true } of values) {
      const annotation = markRaw(value);
      nextAnnotations[index] = annotation;
      if (updateCentroid) {
        this.annotationCentroids[annotation.id] = markRaw(
          simpleCentroid(annotation.coordinates),
        );
      }
      this.annotationIdToIdx[annotation.id] = index;

      // Keep the derived maps the canvas renders from in sync with the edit
      // (Finding 2): layerAnnotations resolves renderData from hydrated/stub
      // maps whenever the stub system is active, so an in-place edit that only
      // touched annotations[] would otherwise repaint stale color/tags/shape.
      const centroid = this.annotationCentroids[annotation.id];
      if (this.annotationStubs.has(annotation.id)) {
        nextStubs.set(annotation.id, stubFromAnnotation(annotation, centroid));
      }
      if (nextHydrated.has(annotation.id)) {
        nextHydrated.set(annotation.id, annotation);
        hydratedChanged = true;
      }
      if (updateCentroid && this.annotationStubs.has(annotation.id)) {
        // insert is upsert-safe, so this repositions the existing node.
        annotationSpatialIndex.insert(annotation.id, centroid.x, centroid.y);
      }
    }
    this.annotations = nextAnnotations;
    this.annotationStubs = markRaw(nextStubs);
    if (hydratedChanged) {
      this.hydratedAnnotations = markRaw(nextHydrated);
    }
  }

  @Mutation
  public setAnnotations(
    payload:
      | IAnnotation[]
      | { values: IAnnotation[]; serverStubsFollow?: boolean },
  ) {
    // Accept a bare array (the common case) or an options object. When
    // `serverStubsFollow` is set, a setStubsFromServer call follows
    // immediately and will (re)build the centroids, stub map, and spatial
    // index from server data — so skip the client-side build here instead of
    // doing the O(N) work twice (Finding 14).
    const values = Array.isArray(payload) ? payload : payload.values;
    const serverStubsFollow = Array.isArray(payload)
      ? false
      : !!payload.serverStubsFollow;

    this.annotations = values.map((annotation) => markRaw(annotation));
    this.annotationIdToIdx = markRaw({});
    for (let idx = 0; idx < this.annotations.length; ++idx) {
      this.annotationIdToIdx[this.annotations[idx].id] = idx;
    }

    if (!serverStubsFollow) {
      this.annotationCentroids = markRaw({});
      const newStubs = new Map<string, IAnnotationStub>();
      const spatialItems: { id: string; x: number; y: number }[] = new Array(
        this.annotations.length,
      );
      for (let idx = 0; idx < this.annotations.length; ++idx) {
        const annotation = this.annotations[idx];
        const centroid = markRaw(simpleCentroid(annotation.coordinates));
        this.annotationCentroids[annotation.id] = centroid;
        newStubs.set(annotation.id, stubFromAnnotation(annotation, centroid));
        spatialItems[idx] = {
          id: annotation.id,
          x: centroid.x,
          y: centroid.y,
        };
      }
      this.annotationStubs = markRaw(newStubs);
      annotationSpatialIndex.bulkLoad(spatialItems);
    }

    // Clear hydration cache — will be repopulated on demand by
    // updateVisibilityAndHydration
    this.hydratedAnnotations = markRaw(new Map());
    this.stubOnlyMode = false;
  }

  @Mutation
  public setStubsFromServer(stubs: IAnnotationStub[]) {
    const newStubs = new Map<string, IAnnotationStub>();
    const newCentroids: { [annotationId: string]: IGeoJSPosition } = {};
    const spatialItems: { id: string; x: number; y: number }[] = new Array(
      stubs.length,
    );
    let radiusSum = 0;
    let radiusCount = 0;
    for (let idx = 0; idx < stubs.length; ++idx) {
      const stub = stubs[idx];
      newStubs.set(stub.id, stub);
      newCentroids[stub.id] = markRaw(stub.centroid);
      spatialItems[idx] = {
        id: stub.id,
        x: stub.centroid.x,
        y: stub.centroid.y,
      };
      if (typeof stub.estimatedRadius === "number") {
        radiusSum += stub.estimatedRadius;
        radiusCount += 1;
      }
    }
    this.annotationStubs = markRaw(newStubs);
    this.annotationCentroids = markRaw(newCentroids);
    // Mean radius feeds the density-derived zoomed-out render budget.
    this.averageStubRadius = radiusCount > 0 ? radiusSum / radiusCount : 0;
    annotationSpatialIndex.bulkLoad(spatialItems);
  }

  @Mutation
  public removeAnnotationStubs(ids: string[]) {
    const newStubs = new Map(this.annotationStubs);
    const newHydrated = new Map(this.hydratedAnnotations);
    const newCentroids = { ...this.annotationCentroids };
    for (const id of ids) {
      newStubs.delete(id);
      newHydrated.delete(id);
      delete newCentroids[id];
      annotationSpatialIndex.remove(id);
    }
    this.annotationStubs = markRaw(newStubs);
    this.hydratedAnnotations = markRaw(newHydrated);
    this.annotationCentroids = markRaw(newCentroids);
  }

  @Mutation
  public setStubOnlyMode(mode: boolean) {
    this.stubOnlyMode = mode;
  }

  // Patch tags/color (and, for a moved point, centroid) on existing stubs (and
  // any hydrated copies) after a stub-only-mode edit, so the canvas reflects the
  // change without a reload.
  @Mutation
  public applyStubFieldUpdates(updates: IStubFieldUpdate[]) {
    if (!updates.length) {
      return;
    }
    const newStubs = new Map(this.annotationStubs);
    const newHydrated = new Map(this.hydratedAnnotations);
    for (const update of updates) {
      const stub = newStubs.get(update.id);
      if (stub) {
        newStubs.set(update.id, {
          ...stub,
          ...(update.tags !== undefined ? { tags: update.tags } : {}),
          ...(update.color !== undefined ? { color: update.color } : {}),
          ...(update.centroid !== undefined
            ? { centroid: update.centroid }
            : {}),
        });
      }
      const hydrated = newHydrated.get(update.id);
      if (hydrated) {
        newHydrated.set(
          update.id,
          markRaw({
            ...hydrated,
            ...(update.tags !== undefined ? { tags: update.tags } : {}),
            ...(update.color !== undefined ? { color: update.color } : {}),
            // A moved point can still be in hydratedAnnotations (newly-created
            // annotations are always hydrated), and getAnnotationFromId prefers
            // the hydrated copy over materializing from the updated stub — so the
            // hydrated copy's coordinate must follow the move too, or it resolves
            // to the stale position. A point's only coordinate IS its centroid.
            ...(update.centroid !== undefined
              ? { coordinates: [{ ...update.centroid }] }
              : {}),
          }),
        );
      }
      // A moved point stub: follow the move in the centroid index (mutated in
      // place — copying the up-to-1M-entry map per drag would be wasteful, and
      // it's markRaw/non-reactive so the redraw is driven by the annotationStubs
      // reassignment below) and the spatial index (clean upsert).
      if (update.centroid !== undefined) {
        this.annotationCentroids[update.id] = update.centroid;
        annotationSpatialIndex.insert(
          update.id,
          update.centroid.x,
          update.centroid.y,
        );
      }
    }
    this.annotationStubs = markRaw(newStubs);
    this.hydratedAnnotations = markRaw(newHydrated);
  }

  @Action
  public async createConnections({
    annotationsIds,
    tags,
    channelId,
  }: {
    annotationsIds: string[];
    tags: string[];
    channelId: number | null;
  }) {
    if (!main.isLoggedIn) {
      return [];
    }
    sync.setSaving(true);
    const connections = await this.annotationsAPI.createConnections(
      annotationsIds,
      tags,
      channelId,
    );
    sync.setSaving(false);
    return connections;
  }

  @Action
  public async createAllConnections({
    parentIds,
    childIds,
    label,
    tags,
  }: {
    parentIds: string[];
    childIds: string[];
    label: string;
    tags: string[];
  }) {
    if (!main.dataset || !main.isLoggedIn) {
      return [];
    }
    sync.setSaving(true);
    const connectionBases: IAnnotationConnectionBase[] = [];
    for (const parentId of parentIds) {
      for (const childId of childIds) {
        connectionBases.push({
          label,
          tags,
          parentId,
          childId,
          datasetId: main.dataset.id,
        });
      }
    }
    const connections =
      await this.annotationsAPI.createMultipleConnections(connectionBases);
    if (connections) {
      this.addMultipleConnections(connections);
    }
    sync.setSaving(false);
    return connections || [];
  }

  // Create connections from explicit parent/child pairs. Unlike
  // createAllConnections (which builds the full cross product of two id lists),
  // this persists exactly the pairs it is given — used by the connection list's
  // "Connect selected", which chains annotations in time order.
  // rawError: errors are re-wrapped at every @Action boundary they cross, so
  // connectionList's rawError alone would not preserve the message.
  @Action({ rawError: true })
  public async createConnectionsFromBases(
    connectionBases: IAnnotationConnectionBase[],
  ): Promise<IAnnotationConnection[]> {
    if (!main.isLoggedIn || connectionBases.length === 0) {
      return [];
    }
    sync.setSaving(true);
    // try/finally, because this action is rawError: a rejection propagates to
    // the caller, and without the finally the app-wide saving indicator would
    // stay on forever.
    try {
      const connections =
        await this.annotationsAPI.createMultipleConnections(connectionBases);
      if (connections) {
        this.addMultipleConnections(connections);
      }
      return connections || [];
    } finally {
      sync.setSaving(false);
    }
  }

  @Action
  public async deleteAllConnections({
    parentIds,
    childIds,
  }: {
    parentIds: string[];
    childIds: string[];
  }) {
    if (!main.isLoggedIn) {
      return;
    }
    const parentsSet = new Set(parentIds);
    const childrenSet = new Set(childIds);
    const connectionsToDelete = this.annotationConnections.filter(
      (connection) =>
        parentsSet.has(connection.parentId) &&
        childrenSet.has(connection.childId),
    );
    const connectionIds = connectionsToDelete.map(({ id }) => id);
    return await this.deleteConnections(connectionIds);
  }

  @Action
  public async deleteConnections(connectionIds: string[]) {
    if (!main.isLoggedIn) {
      return;
    }
    sync.setSaving(true);
    await this.annotationsAPI.deleteMultipleConnections(connectionIds);
    this.deleteMultipleConnections(connectionIds);
    sync.setSaving(false);
    return connectionIds;
  }

  @Action
  public async deleteAllTimelapseConnections() {
    if (!main.isLoggedIn) {
      return;
    }
    const connectionsToDelete = this.annotationConnections.filter(
      (connection) => connection.tags.includes(TIMELAPSE_CONNECTION_TAG),
    );
    await this.deleteConnections(connectionsToDelete.map(({ id }) => id));
  }

  @Action
  public async createConnection(
    annotationConnectionBase: IAnnotationConnectionBase,
  ): Promise<IAnnotationConnection | null> {
    if (!main.isLoggedIn) {
      return null;
    }
    sync.setSaving(true);
    const newConnection: IAnnotationConnection | null =
      await this.annotationsAPI.createConnection(annotationConnectionBase);
    if (newConnection) {
      this.addMultipleConnections([newConnection]);
    }
    sync.setSaving(false);
    return newConnection;
  }

  @Action
  public async createTimelapseConnection(
    annotationConnectionBase: IAnnotationConnectionBase,
  ): Promise<IAnnotationConnection | null> {
    if (!main.isLoggedIn) {
      return null;
    }
    sync.setSaving(true);
    const parentAnnotation = this.getAnnotationFromId(
      annotationConnectionBase.parentId,
    );
    const childAnnotation = this.getAnnotationFromId(
      annotationConnectionBase.childId,
    );
    // Make sure that the parentAnnotation.location.Time is less than the childAnnotation.location.Time
    if (parentAnnotation && childAnnotation) {
      if (parentAnnotation.location.Time > childAnnotation.location.Time) {
        [annotationConnectionBase.parentId, annotationConnectionBase.childId] =
          [annotationConnectionBase.childId, annotationConnectionBase.parentId];
      }
    }
    // TODO: Perhaps we want to delete any existing connections between these two annotations?
    const newConnection: IAnnotationConnection | null =
      await this.annotationsAPI.createConnection(annotationConnectionBase);
    if (newConnection) {
      this.addMultipleConnections([newConnection]);
    }
    sync.setSaving(false);
    return newConnection;
  }

  @Action
  public async createAllTimelapseConnections({
    parentIds,
    childIds,
    label,
    tags,
  }: {
    parentIds: string[];
    childIds: string[];
    label: string;
    tags: string[];
  }) {
    if (!main.dataset || !main.isLoggedIn) {
      return [];
    }
    sync.setSaving(true);

    // Helper functions to calculate distance between annotations
    const getDistanceBetweenAnnotations = (
      a1: IAnnotation,
      a2: IAnnotation,
    ): number => {
      const centroid1 = getAnnotationCentroid(a1);
      const centroid2 = getAnnotationCentroid(a2);

      if (!centroid1 || !centroid2) {
        return Infinity; // Return a large number if centroids can't be calculated
      }

      // Calculate Euclidean distance
      const dx = centroid1.x - centroid2.x;
      const dy = centroid1.y - centroid2.y;
      return Math.sqrt(dx * dx + dy * dy);
    };

    // This calculates the "centroid", but is not the actual centroid;
    // instead, it just averages the coordinates. Fine enough for our purposes for now.
    // TODO: Use the actual centroid instead.
    const getAnnotationCentroid = (
      annotation: IAnnotation,
    ): { x: number; y: number } | null => {
      if (annotation.coordinates.length === 0) {
        return null;
      }

      let sumX = 0;
      let sumY = 0;

      for (const coord of annotation.coordinates) {
        sumX += coord.x;
        sumY += coord.y;
      }

      return {
        x: sumX / annotation.coordinates.length,
        y: sumY / annotation.coordinates.length,
      };
    };

    // 0. Remove all existing connections between the parent and child annotations
    await this.deleteAllConnections({ parentIds, childIds });

    // 1. Collect all annotations into a single set
    const allIds = new Set([...parentIds, ...childIds]);
    const annotations = Array.from(allIds)
      .map((id) => this.getAnnotationFromId(id))
      .filter((a): a is IAnnotation => !!a);

    // 2. Find closest temporal parent for each annotation
    const connectionBases: IAnnotationConnectionBase[] = [];

    for (const annotation of annotations) {
      const potentialParents = annotations.filter(
        (a) => a.location.Time < annotation.location.Time,
      );

      if (potentialParents.length > 0) {
        // Find max time among potential parents
        const maxParentTime = Math.max(
          ...potentialParents.map((a) => a.location.Time),
        );
        const parentsAtMaxTime = potentialParents.filter(
          (a) => a.location.Time === maxParentTime,
        );

        if (parentsAtMaxTime.length > 0) {
          // Find closest parent by centroid distance
          const parent = parentsAtMaxTime.reduce((closest, current) => {
            const closestDist = getDistanceBetweenAnnotations(
              closest,
              annotation,
            );
            const currentDist = getDistanceBetweenAnnotations(
              current,
              annotation,
            );
            return currentDist < closestDist ? current : closest;
          }, parentsAtMaxTime[0]);

          connectionBases.push({
            label,
            tags,
            parentId: parent.id,
            childId: annotation.id,
            datasetId: main.dataset.id,
          });
        }
      }
    }
    const connections =
      await this.annotationsAPI.createMultipleConnections(connectionBases);
    if (connections) {
      this.addMultipleConnections(connections);
    }
    sync.setSaving(false);
    return connections || [];
  }

  @Mutation
  public addMultipleConnections(value: IAnnotationConnection[]) {
    if (value.length > 0) {
      this.annotationConnections = [...this.annotationConnections, ...value];
    }
  }

  @Mutation
  private deleteMultipleConnections(connectionIds: string[]) {
    const idsSet = new Set(connectionIds);
    this.annotationConnections = this.annotationConnections.filter(
      (connection) => !idsSet.has(connection.id),
    );
  }

  @Mutation
  private addConnectionImpl(value: IAnnotationConnection) {
    this.annotationConnections = [...this.annotationConnections, value];
  }

  @Mutation
  public setConnections(values: IAnnotationConnection[]) {
    this.annotationConnections = values;
  }

  @Action
  public async deleteAnnotations(ids: string[]) {
    if (ids.length === 0 || !main.isLoggedIn) {
      return;
    }

    this.setDeletingState(true);
    sync.setSaving(true);

    const progressId = await progress.create({
      type: ProgressType.ANNOTATION_DELETE,
      title: "Deleting annotations",
    });

    try {
      await this.annotationsAPI.deleteMultipleAnnotations(ids);

      if (this.stubOnlyMode) {
        this.removeAnnotationStubs(ids);
      } else {
        const idsSet = new Set(ids);
        this.setAnnotations(
          this.annotations.filter(
            (annotation: IAnnotation) => !idsSet.has(annotation.id),
          ),
        );
      }
      // Prune id-holding UI state so nothing keeps referencing the deleted
      // annotations (a stale selection id can widen a subset CSV export to
      // the whole dataset; a stale hover id dangles like the connection-list
      // case did).
      this.unselectAnnotations(ids);
      if (
        this.hoveredAnnotationId !== null &&
        ids.includes(this.hoveredAnnotationId)
      ) {
        this.setHoveredAnnotationId(null);
      }
    } finally {
      // Always set the state back to false, even if there's an error
      sync.setSaving(false);
      this.setDeletingState(false);
      progress.complete(progressId);
    }
  }

  @Action
  public deleteSelectedAnnotations() {
    this.deleteAnnotations([...this.selectedAnnotationIds]);
    this.setSelected([]);
  }

  @Action
  public async deleteUnselectedAnnotations() {
    // Use allAnnotationIds (stub-aware) rather than this.annotations: in
    // stub-only mode annotations[] is empty, so the old version computed an
    // empty unselected set and deleted nothing. This action is dataset-wide;
    // the AnnotationList toolbar handles filter/list-scoped deletion via the
    // server endpoint separately.
    const selectedIds = this.selectedAnnotationIds;
    const unselectedIds = this.allAnnotationIds.filter(
      (id) => !selectedIds.has(id),
    );

    await this.deleteAnnotations(unselectedIds);
  }

  /**
   * editFunction must reassign fields (e.g. `ann.coordinates = newArray`)
   * rather than mutate them in place. cloneAnnotation shares the original
   * `coordinates` array reference for performance, so an in-place mutation
   * would corrupt the stored annotation, defeat patch diffing in
   * getAnnotationUpdatePatch, and prevent rollback on error.
   */
  // rawError: true because both paths below rethrow after rolling back, so the
  // real reason reaches the caller (and the console/Sentry) instead of
  // vuex-module-decorators' generic ERR_ACTION_ACCESS_UNDEFINED text. The
  // sync indicator is unaffected either way: setSaving receives the error
  // caught inside this action, before any wrapping. See index.ts
  // syncConfiguration.
  @Action({ rawError: true })
  public async updateAnnotationsPerId({
    annotationIds,
    editFunction,
  }: {
    annotationIds: string[];
    editFunction: (annotation: IAnnotation) => void;
  }) {
    if (!main.isLoggedIn) {
      return;
    }
    if (this.stubOnlyMode) {
      // In stub-only mode annotations[] is empty, so the patch-from-full-
      // annotation path below would look up annotationIdToIdx[id] (undefined)
      // and skip every id — silently never calling the backend. Build patches
      // from the stubs instead, persist them, and sync tags/color back onto
      // local stubs so the canvas stays consistent.
      if (!annotationIds.length) {
        return;
      }
      sync.setSaving(true);
      try {
        const { patches, stubFieldUpdates } = buildStubUpdates(
          annotationIds,
          (id) => this.annotationStubs.get(id),
          editFunction,
        );
        if (patches.length) {
          await this.annotationsAPI.updateAnnotations(patches);
          this.applyStubFieldUpdates(stubFieldUpdates);
        }
        sync.setSaving(false);
      } catch (error) {
        logError(`Failed to update annotations: ${(error as Error).message}`);
        sync.setSaving(error as Error);
        throw error;
      }
      return;
    }
    sync.setSaving(true);
    const originalAnnotations: IndexedAnnotationUpdate[] = [];
    const localUpdates: IndexedAnnotationUpdate[] = [];
    const annotationUpdates: AnnotationUpdatePatch[] = [];
    try {
      for (const annotationId of annotationIds) {
        const annotationIndex = this.annotationIdToIdx[annotationId];
        if (annotationIndex === undefined) {
          continue;
        }
        const oldAnnotation = this.annotations[annotationIndex];
        const newAnnotation = cloneAnnotation(oldAnnotation);
        editFunction(newAnnotation);
        const update = getAnnotationUpdatePatch(oldAnnotation, newAnnotation);
        if (update) {
          const coordinatesChanged = update.coordinates !== undefined;
          originalAnnotations.push({
            annotation: oldAnnotation,
            index: annotationIndex,
            updateCentroid: coordinatesChanged,
          });
          localUpdates.push({
            annotation: newAnnotation,
            index: annotationIndex,
            updateCentroid: coordinatesChanged,
          });
          annotationUpdates.push(update);
        }
      }
      this.setAnnotationsAtIndices(localUpdates);
      if (annotationUpdates.length) {
        await this.annotationsAPI.updateAnnotations(annotationUpdates);
      }
      sync.setSaving(false);
    } catch (error) {
      this.setAnnotationsAtIndices(originalAnnotations);
      logError(`Failed to update annotations: ${(error as Error).message}`);
      sync.setSaving(error as Error);
      throw error;
    }
  }

  @Action
  public async addTagsByAnnotationIds({
    annotationIds,
    tags,
  }: {
    annotationIds: string[];
    tags: string[];
  }) {
    const editFunction = (annotation: IAnnotation): void => {
      const newTags = tags.reduce((newTags: string[], tag: string) => {
        if (!newTags.includes(tag)) {
          newTags.push(tag);
        }
        return newTags;
      }, annotation.tags);
      annotation.tags = newTags;
    };
    await this.updateAnnotationsPerId({ annotationIds, editFunction });
  }

  @Action
  public async replaceTagsByAnnotationIds({
    annotationIds,
    tags,
  }: {
    annotationIds: string[];
    tags: string[];
  }) {
    const editFunction = (annotation: IAnnotation): void => {
      annotation.tags = [...tags];
    };
    await this.updateAnnotationsPerId({ annotationIds, editFunction });
  }

  @Action
  public async removeTagsByAnnotationIds({
    annotationIds,
    tags,
  }: {
    annotationIds: string[];
    tags: string[];
  }) {
    const editFunction = (annotation: IAnnotation): void => {
      annotation.tags = annotation.tags.filter((tag) => !tags.includes(tag));
    };
    await this.updateAnnotationsPerId({ annotationIds, editFunction });
  }

  @Action
  public async tagSelectedAnnotations({
    tags,
    replace,
  }: {
    tags: string[];
    replace: boolean;
  }) {
    if (replace) {
      await this.replaceTagsByAnnotationIds({
        annotationIds: [...this.selectedAnnotationIds],
        tags,
      });
    } else {
      await this.addTagsByAnnotationIds({
        annotationIds: [...this.selectedAnnotationIds],
        tags,
      });
    }
  }

  @Action
  public async removeTagsFromSelectedAnnotations(tags: string[]) {
    await this.removeTagsByAnnotationIds({
      annotationIds: [...this.selectedAnnotationIds],
      tags,
    });
  }

  @Action
  public async addTagsToAllAnnotations(tags: string[]) {
    await this.addTagsByAnnotationIds({
      annotationIds: this.allAnnotationIds,
      tags,
    });
  }

  @Action
  public async removeTagsFromAllAnnotations(tags: string[]) {
    await this.removeTagsByAnnotationIds({
      annotationIds: this.allAnnotationIds,
      tags,
    });
  }

  @Action
  public async colorAnnotationIds({
    color,
    annotationIds,
    randomize = false,
  }: {
    color: string | null;
    annotationIds: string[];
    randomize?: boolean;
  }) {
    const editFunction = (annotation: IAnnotation): void => {
      if (randomize) {
        // Generate a random color if randomize is true
        const randomColor =
          "#" + Math.floor(Math.random() * 16777215).toString(16);
        annotation.color = randomColor;
      } else {
        annotation.color = color;
      }
    };
    await this.updateAnnotationsPerId({ annotationIds, editFunction });
  }

  @Action
  public async colorSelectedAnnotations({
    color,
    randomize = false,
  }: {
    color: string | null;
    randomize?: boolean;
  }) {
    await this.colorAnnotationIds({
      annotationIds: [...this.selectedAnnotationIds],
      color,
      randomize,
    });
  }

  @Action
  public async updateAnnotationName({
    name,
    id,
  }: {
    name: string;
    id: string;
  }) {
    const editFunction = (annotation: IAnnotation): void => {
      annotation.name = name;
    };
    await this.updateAnnotationsPerId({ annotationIds: [id], editFunction });
  }

  /**
   * Combine two polygon annotations into one by computing their union.
   * The first annotation is updated with the union shape, and the second
   * annotation is deleted. Connections referencing the second annotation
   * are transferred to the first annotation.
   *
   * @param firstAnnotationId - The ID of the annotation to keep (will be updated)
   * @param secondAnnotationId - The ID of the annotation to merge and delete
   * @returns true if successful, false otherwise
   */
  @Action
  public async combineAnnotations({
    firstAnnotationId,
    secondAnnotationId,
    tolerance = 2.0,
  }: {
    firstAnnotationId: string;
    secondAnnotationId: string;
    tolerance?: number;
  }): Promise<boolean> {
    if (!main.isLoggedIn || !main.dataset) {
      return false;
    }

    const firstAnnotation = this.getAnnotationFromId(firstAnnotationId);
    const secondAnnotation = this.getAnnotationFromId(secondAnnotationId);

    if (!firstAnnotation || !secondAnnotation) {
      logError("Cannot combine: one or both annotations not found");
      return false;
    }

    // Import dynamically to avoid issues if polygon-clipping isn't available
    const { computePolygonUnionWithTolerance } = await import(
      "@/utils/polygonUnion"
    );

    // Compute the union of the two polygons with tolerance for adjacent polygons
    const unionCoordinates = computePolygonUnionWithTolerance(
      firstAnnotation.coordinates,
      secondAnnotation.coordinates,
      tolerance,
    );

    if (!unionCoordinates) {
      logError(
        "Cannot combine: polygons are not overlapping and are beyond " +
          "tolerance distance. Move them closer together or ensure they overlap.",
      );
      return false;
    }

    sync.setSaving(true);

    try {
      // Step 1: Update the first annotation with the union coordinates
      await this.updateAnnotationsPerId({
        annotationIds: [firstAnnotationId],
        editFunction: (annotation: IAnnotation) => {
          annotation.coordinates = unionCoordinates;
        },
      });

      // Step 2: Transfer connections from the second annotation to the first
      // Find connections where secondAnnotation is involved
      const connectionsToUpdate = this.annotationConnections.filter(
        (conn) =>
          conn.parentId === secondAnnotationId ||
          conn.childId === secondAnnotationId,
      );

      if (connectionsToUpdate.length > 0) {
        // Create new connections with the updated references
        const newConnectionBases: IAnnotationConnectionBase[] = [];
        const connectionIdsToDelete: string[] = [];

        for (const conn of connectionsToUpdate) {
          const newParentId =
            conn.parentId === secondAnnotationId
              ? firstAnnotationId
              : conn.parentId;
          const newChildId =
            conn.childId === secondAnnotationId
              ? firstAnnotationId
              : conn.childId;

          // Skip self-connections (if both annotations had connections to each other)
          if (newParentId === newChildId) {
            connectionIdsToDelete.push(conn.id);
            continue;
          }

          // Check if this connection already exists (to avoid duplicates)
          const existingConnection = this.annotationConnections.find(
            (existing) =>
              existing.id !== conn.id &&
              existing.parentId === newParentId &&
              existing.childId === newChildId,
          );

          if (existingConnection) {
            // Connection already exists, just delete the old one
            connectionIdsToDelete.push(conn.id);
          } else {
            // Create new connection with updated IDs
            newConnectionBases.push({
              parentId: newParentId,
              childId: newChildId,
              datasetId: main.dataset!.id,
              label: conn.label,
              tags: conn.tags,
            });
            connectionIdsToDelete.push(conn.id);
          }
        }

        // Delete old connections
        if (connectionIdsToDelete.length > 0) {
          await this.annotationsAPI.deleteMultipleConnections(
            connectionIdsToDelete,
          );
          this.deleteMultipleConnections(connectionIdsToDelete);
        }

        // Create new connections
        if (newConnectionBases.length > 0) {
          const newConnections =
            await this.annotationsAPI.createMultipleConnections(
              newConnectionBases,
            );
          if (newConnections) {
            this.addMultipleConnections(newConnections);
          }
        }
      }

      // Step 3: Delete the second annotation
      // (Property values are automatically cleaned up by the backend)
      await this.deleteAnnotations([secondAnnotationId]);

      return true;
    } catch (error) {
      logError(`Failed to combine annotations: ${(error as Error).message}`);
      return false;
    } finally {
      sync.setSaving(false);
    }
  }

  @Action
  async fetchAnnotations() {
    this.setAnnotations([]);
    this.setConnections([]);
    if (!main.dataset || !main.configuration) {
      stubPerf.setDataset(null);
      return;
    }
    stubPerf.setDataset(main.dataset.id);
    try {
      const datasetId = main.dataset.id;
      const connectionsPromise =
        this.annotationsAPI.getConnectionsForDatasetId(datasetId);

      const { stubThreshold } = this.visibilityConfig;
      let count: number;
      try {
        count = await this.annotationsAPI.getAnnotationCount(datasetId);
      } catch (error) {
        // A transient count failure must NOT route a large dataset into the
        // full-fetch branch (the OOM path). Treat "unknown count" as
        // over-threshold so we take the safe stub-only path. Infinity also
        // gives the loading bar a count-less title.
        logError(
          `Annotation count failed; using stub-only mode: ${
            (error as Error).message
          }`,
        );
        count = Number.POSITIVE_INFINITY;
      }

      if (count <= stubThreshold) {
        // Under threshold: full fetch only. Full annotations are a superset of
        // the server stubs, and setAnnotations builds the centroids / stub map /
        // spatial index client-side — cheap at this size — so re-fetching stubs
        // separately is a redundant round-trip (Finding 8). Passing a bare array
        // leaves serverStubsFollow false, triggering that client-side build.
        const [annotations, connections] = await Promise.all([
          this.annotationsAPI.getAnnotationsForDatasetId(datasetId),
          connectionsPromise,
        ]);
        this.setConnections(connections?.length ? connections : []);
        this.setAnnotations(annotations?.length ? annotations : []);
      } else {
        // Over threshold: stubs only, hydrate on demand. The stub fetch is a
        // single streamed GET with no incremental progress, so surface an
        // indeterminate bar titled with the known count ("Loading N
        // annotations…") — otherwise the canvas sits empty for seconds with no
        // feedback. (The under-threshold branch already shows a "Fetching
        // annotations" bar via fetchAllPages, so no bar is added there.)
        const stubProgressId = await progress.create({
          type: ProgressType.ANNOTATION_FETCH,
          title: annotationLoadingTitle(count),
        });
        try {
          const [stubs, connections] = await Promise.all([
            this.annotationsAPI.getAnnotationStubs(datasetId),
            connectionsPromise,
          ]);
          this.setConnections(connections?.length ? connections : []);
          this.setAnnotations([]);
          if (stubs?.length) {
            this.setStubsFromServer(stubs);
            this.setStubOnlyMode(true);
          }
        } finally {
          progress.complete(stubProgressId);
        }
      }
    } catch (error) {
      this.setAnnotations([]);
      this.setConnections([]);
      logError((error as Error).message);
    }
  }

  @Action
  public async computeAnnotationsWithWorker({
    tool,
    workerInterface,
    progress: progressInfo,
    error,
    callback,
  }: {
    tool: IToolConfiguration;
    workerInterface: IWorkerInterfaceValues;
    progress: IProgressInfo;
    error: IErrorInfoList;
    callback: (success: boolean) => void;
  }) {
    if (!main.dataset || !main.configuration || !main.isLoggedIn) {
      callback(false);
      return null;
    }
    const datasetId = main.dataset.id;

    // Clear errors
    error.errors = [];

    // Create a progress entry using the new progress store
    const progressId = await progress.create({
      type: ProgressType.ANNOTATION_COMPUTE,
      title: `Computing ${tool.name}`,
    });

    const { location, channel } =
      await this.getAnnotationLocationFromTool(tool);
    const tile = { ...location };
    const response = await this.annotationsAPI.computeAnnotationWithWorker(
      tool,
      main.dataset,
      {
        location,
        channel,
        tile,
      },
      workerInterface,
      main.layers,
      main.scales,
    );

    // Keep track of running jobs
    const jobId = response.data[0]?._id;
    if (!jobId) {
      progress.complete(progressId);
      callback(false);
      return null;
    }

    const computeJob: IAnnotationComputeJob = {
      toolId: tool.id,
      jobId,
      datasetId,
      eventCallback: (jobData: IJobEventData) => {
        // Handle old progress system
        createProgressEventCallback(progressInfo)(jobData);

        // Handle new progress system
        progress.handleJobProgress({
          jobData,
          progressId,
          defaultTitle: `Computing ${tool.name}`,
        });
      },
      errorCallback: createErrorEventCallback(error),
    };

    jobs.addJob(computeJob).then(async (success: boolean) => {
      // Awaited: `callback` consumers (the AI panel's wait_for_job among them)
      // read annotation state as soon as they are told the worker finished, so
      // the refresh must complete before the callback fires. fetchAnnotations
      // handles its own errors and never rejects.
      await this.fetchAnnotations();
      // If this was a worker that makes a new large_image, this line will load it
      // I'm pretty sure this function won't reload the large image if it's already loaded
      const newLargeImage = await main.loadLargeImages(true); // true means switch to the new large image
      if (newLargeImage) {
        // If the computation resulted in at least one new large image, we need to compute the tile frames, max merge cache, and histogram cache
        main.scheduleTileFramesComputation(datasetId);
        main.scheduleMaxMergeCache(datasetId);
        main.scheduleHistogramCache(datasetId);
      }
      // TODO: We may also want to fetch connections and properties here, depending on flags set in the worker image
      progress.complete(progressId);
      callback(success);
    });

    return computeJob;
  }

  // Thin, promise-returning submitter for a single annotation-worker job.
  // Unlike computeAnnotationsWithWorker it does NOT own progress creation or
  // post-completion side effects (fetchAnnotations/loadLargeImages) — the
  // caller (e.g. the pipeline runner) drives those once for the whole run.
  // Reads the worker interface values from tool.values.workerInterfaceValues,
  // so transient tools built by the pipeline runner work without extra args.
  @Action
  public async submitAnnotationWorkerJob({
    tool,
    datasetId,
    eventCallback,
    errorCallback,
  }: {
    tool: IToolConfiguration;
    datasetId: string;
    eventCallback?: (data: IJobEventData) => void;
    errorCallback?: (data: IJobEventData) => void;
  }): Promise<{
    job: IAnnotationComputeJob;
    completionPromise: Promise<boolean>;
  } | null> {
    if (!main.isLoggedIn) {
      return null;
    }
    const workerInterface = (tool.values?.workerInterfaceValues ??
      {}) as IWorkerInterfaceValues;
    const { location, channel } =
      await this.getAnnotationLocationFromTool(tool);
    const tile = { ...location };
    const response = await this.annotationsAPI.computeAnnotationWithWorker(
      tool,
      { id: datasetId },
      { location, channel, tile },
      workerInterface,
      main.layers,
      main.scales,
    );
    const jobId = response.data[0]?._id;
    if (!jobId) {
      return null;
    }
    const computeJob: IAnnotationComputeJob = {
      toolId: tool.id,
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

  @Action
  public async computeAnnotationsWithWorkerBatch({
    tool,
    workerInterface,
    configurationId,
    onBatchProgress,
    onJobProgress,
    onJobError,
    onCancel,
    onComplete,
  }: {
    tool: IToolConfiguration;
    workerInterface: IWorkerInterfaceValues;
    configurationId: string;
    onBatchProgress: (status: {
      total: number;
      completed: number;
      failed: number;
      cancelled: number;
      currentDatasetName: string;
    }) => void;
    onJobProgress: (datasetId: string, progressInfo: IProgressInfo) => void;
    onJobError: (datasetId: string, errorInfo: IErrorInfoList) => void;
    // Called immediately with the cancel function so the caller can wire up
    // cancellation UI before the batch loop starts (avoids timing issue where
    // awaiting the full batch would delay setting the cancel function).
    onCancel: (cancel: () => void) => void;
    onComplete: (results: {
      succeeded: number;
      failed: number;
      cancelled: number;
    }) => void;
  }): Promise<{
    cancel: () => void;
    jobs: IAnnotationComputeJob[];
  }> {
    const submittedJobs: IAnnotationComputeJob[] = [];
    let isCancelled = false;

    // Create the cancel function and notify the caller immediately
    const cancel = () => {
      isCancelled = true;
      // Cancel all running jobs
      for (const job of submittedJobs) {
        main.api.cancelJob(job.jobId);
      }
    };
    onCancel(cancel);

    // Get all dataset views for this configuration
    const datasetViews: IDatasetView[] = await main.api.findDatasetViews({
      configurationId,
    });

    // Get unique dataset IDs
    const datasetIds = [...new Set(datasetViews.map((v) => v.datasetId))];
    const total = datasetIds.length;

    if (total === 0) {
      onComplete({ succeeded: 0, failed: 0, cancelled: 0 });
      return { cancel, jobs: [] };
    }

    // Get dataset names for progress display
    const datasetInfo = await main.api.batchResources({ folder: datasetIds });
    const datasetNames: { [id: string]: string } = {};
    for (const id of datasetIds) {
      datasetNames[id] = datasetInfo.folder?.[id]?.name || "Unknown dataset";
    }

    // Create overall batch progress entry
    const batchProgressId = await progress.create({
      type: ProgressType.BATCH_ANNOTATION_COMPUTE,
      title: `Batch: ${tool.name}`,
    });
    // Initialize the batch progress with total
    progress.update({
      id: batchProgressId,
      progress: 0,
      total,
    });

    let completed = 0;
    let failed = 0;
    let cancelled = 0;

    // Process each dataset
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

      // Create per-dataset progress tracking
      const datasetProgressInfo: IProgressInfo = {};
      const datasetErrorInfo: IErrorInfoList = { errors: [] };

      // Create a progress entry for this specific dataset
      const datasetProgressId = await progress.create({
        type: ProgressType.ANNOTATION_COMPUTE,
        title: `${tool.name}: ${datasetName}`,
      });

      try {
        // Submit the job for this dataset
        const result = await this.submitWorkerJobForDataset({
          tool,
          workerInterface,
          datasetId,
          progressInfo: datasetProgressInfo,
          errorInfo: datasetErrorInfo,
          onProgress: (info) => onJobProgress(datasetId, info),
          onError: (info) => onJobError(datasetId, info),
          progressId: datasetProgressId,
        });

        if (result) {
          submittedJobs.push(result.job);

          // Wait for the job to complete using the captured promise
          // (avoids race condition where job finishes before we look it up)
          const success = await result.completionPromise;

          if (isCancelled) {
            cancelled++;
          } else if (success) {
            completed++;
          } else {
            failed++;
          }
        } else {
          failed++;
        }
        progress.complete(datasetProgressId);
      } catch (error) {
        logError(`Failed to process dataset ${datasetName}: ${error}`);
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

    // Refresh annotations for the currently viewed dataset
    this.fetchAnnotations();

    // Handle any new large images created by the worker
    const currentDatasetId = main.dataset?.id;
    if (currentDatasetId) {
      const newLargeImage = await main.loadLargeImages(true);
      if (newLargeImage) {
        main.scheduleTileFramesComputation(currentDatasetId);
        main.scheduleMaxMergeCache(currentDatasetId);
        main.scheduleHistogramCache(currentDatasetId);
      }
    }

    onComplete({ succeeded: completed, failed, cancelled });

    return { cancel, jobs: submittedJobs };
  }

  @Action
  private async submitWorkerJobForDataset({
    tool,
    workerInterface,
    datasetId,
    progressInfo,
    errorInfo,
    onProgress,
    onError,
    progressId,
  }: {
    tool: IToolConfiguration;
    workerInterface: IWorkerInterfaceValues;
    datasetId: string;
    progressInfo: IProgressInfo;
    errorInfo: IErrorInfoList;
    onProgress: (info: IProgressInfo) => void;
    onError: (info: IErrorInfoList) => void;
    progressId: string;
  }): Promise<{
    job: IAnnotationComputeJob;
    completionPromise: Promise<boolean>;
  } | null> {
    if (!main.configuration || !main.isLoggedIn) {
      return null;
    }

    // Clear errors
    errorInfo.errors = [];

    // Get location and channel from tool configuration
    const { location, channel } =
      await this.getAnnotationLocationFromTool(tool);
    const tile = { ...location };

    const response = await this.annotationsAPI.computeAnnotationWithWorker(
      tool,
      { id: datasetId },
      {
        location,
        channel,
        tile,
      },
      workerInterface,
      main.layers,
      main.scales,
    );

    const jobId = response.data[0]?._id;
    if (!jobId) {
      progress.complete(progressId);
      return null;
    }

    const computeJob: IAnnotationComputeJob = {
      toolId: tool.id,
      jobId,
      datasetId,
      eventCallback: (jobData: IJobEventData) => {
        createProgressEventCallback(progressInfo)(jobData);
        onProgress(progressInfo);

        progress.handleJobProgress({
          jobData,
          progressId,
          defaultTitle: `Computing ${tool.name}`,
        });
      },
      errorCallback: (jobData: IJobEventData) => {
        createErrorEventCallback(errorInfo)(jobData);
        onError(errorInfo);
      },
    };

    // Capture the completion promise before the job can finish and
    // be removed from the job map (race condition fix)
    const completionPromise = jobs.addJob(computeJob);

    return { job: computeJob, completionPromise };
  }

  @Action
  public getAnnotationLocationFromTool(tool: IToolConfiguration) {
    const toolAnnotation = tool.values.annotation as IAnnotationSetup;
    // Find location in the assigned layer
    const location = {
      XY: main.xy,
      Z: main.z,
      Time: main.time,
    };

    const layerId = toolAnnotation?.coordinateAssignments?.layer;
    const layer = layerId ? main.getLayerFromId(layerId) : null;
    const channel = layer?.channel ?? 0;
    if (layer) {
      const indexes = main.layerSliceIndexes(layer);
      if (indexes) {
        const { xyIndex, zIndex, tIndex } = indexes;
        location.XY = xyIndex;
        const assign = toolAnnotation?.coordinateAssignments;
        // Values are 1 indexed, but the location uses 0 indexing
        location.Z =
          assign?.Z?.type === "layer" ? zIndex : (assign?.Z?.value ?? 1) - 1;
        location.Time =
          assign?.Time?.type === "layer"
            ? tIndex
            : (assign?.Time?.value ?? 1) - 1;
      }
    }
    return { channel, location };
  }

  @Action
  public clearSelectedAnnotations() {
    this.setSelected([]);
  }

  @Mutation
  private setDeletingState(isDeleting: boolean) {
    this.isDeletingAnnotations = isDeleting;
  }

  @Mutation
  setVisibleAnnotationIds(ids: string[]) {
    this.visibleAnnotationIds = markRaw(new Set(ids));
  }

  @Mutation
  setHydrationMode(mode: THydrationMode) {
    this.hydrationMode = mode;
  }

  /**
   * Accumulating LRU hydration cache.
   *
   * - Entries already in the cache whose ids appear in `touchedIds` are
   *   bumped to the tail (most-recently-used).
   * - `newEntries` (freshly fetched from the backend) are inserted at the
   *   tail, overwriting any prior value for their ids.
   * - If the total exceeds `hydrationCacheCap`, LRU entries (at the head)
   *   are evicted. Selected annotation ids are skipped during eviction, but
   *   `cap` is a HARD ceiling: if the selected set alone exceeds it (e.g.
   *   "select all" on a huge dataset), selected LRU entries are evicted too
   *   so the cache can't grow unbounded.
   *
   * JS Map preserves insertion order, so `delete(id); set(id, v)` moves an
   * entry to the tail — that's the touch operation.
   */
  @Mutation
  mergeHydratedAnnotations(payload: {
    newEntries: { id: string; annotation: IAnnotation }[];
    touchedIds: string[];
  }) {
    const newMap = new Map(this.hydratedAnnotations);
    for (const id of payload.touchedIds) {
      const existing = newMap.get(id);
      if (existing !== undefined) {
        newMap.delete(id);
        newMap.set(id, existing);
      }
    }
    for (const { id, annotation } of payload.newEntries) {
      newMap.delete(id);
      newMap.set(id, annotation);
    }
    const cap = this.visibilityConfig.hydrationCacheCap;
    if (cap > 0 && newMap.size > cap) {
      // Selected ids are protected from eviction, but `cap` is a HARD ceiling:
      // when (nearly) everything is selected — e.g. "select all" on a huge
      // dataset — selected LRU entries are evicted too so the cache can't grow
      // without bound (which would defeat lazy mode / risk OOM).
      const { evict, protectedSkipped } = planHydrationEvictions(
        Array.from(newMap.keys()),
        this.selectedAnnotationIds,
        cap,
      );
      for (const id of evict) {
        newMap.delete(id);
      }
      stubPerf.trackEviction(evict.length, protectedSkipped);
    }
    this.hydratedAnnotations = markRaw(newMap);
    stubPerf.trackCache(newMap.size, cap);
  }

  @Mutation
  clearHydrationCache() {
    this.hydratedAnnotations = markRaw(new Map());
  }

  @Action
  updateVisibilityAndHydration(params: {
    // The client-filtered id set. Omit it when no client filter is active: the
    // action then iterates its own stub map directly, avoiding a full-dataset
    // id array allocation in the component on every frame change (Finding 15).
    filteredIds?: string[];
    gcsBounds?: IGeoJSPosition[];
    currentFrameLocation: IAnnotationLocation;
    // Zoom-adaptive budget overrides (computed from the live map zoom in the
    // component). Fall back to the static config caps when not supplied.
    maxVisible?: number;
    maxHydrated?: number;
  }) {
    const { filteredIds, gcsBounds, currentFrameLocation } = params;
    const zoomVisibleBudget =
      params.maxVisible ?? this.visibilityConfig.maxVisible;
    const zoomHydrated =
      params.maxHydrated ?? this.visibilityConfig.maxHydrated;
    // Floor the VISIBLE budget at minimumVisible so at least that many are drawn
    // in the actual viewport (capped at the configured max).
    const { minimumVisible, maxVisible: configMaxVisible } =
      this.visibilityConfig;
    const visibleBudget = clampVisibleBudget(
      zoomVisibleBudget,
      minimumVisible,
      configMaxVisible,
    );
    // Never hydrate more than the drawn (visible) set — fetching coordinates for
    // annotations that aren't drawn is wasted work. The zoom-progress scaling
    // lives in the zoom budget; this just prevents over-hydration (notably in
    // coverage mode, where the visible budget can be well below maxHydrated).
    const hydrationBudget = Math.min(zoomHydrated, visibleBudget);

    // Capture the stub map once. `this.annotationStubs` resolves through the
    // vuex-module-decorators action proxy on every access; reading it inside the
    // hot loops below (~1.4M times at 700K) added hundreds of ms. The local
    // reference is a plain Map.
    const stubsMap = this.annotationStubs;

    const onCurrentFrame = (stub: IAnnotationStub | undefined): boolean =>
      !!stub &&
      stub.location.XY === currentFrameLocation.XY &&
      stub.location.Z === currentFrameLocation.Z &&
      stub.location.Time === currentFrameLocation.Time;

    // Step 1: Split by frame. With an explicit filtered set, walk it; otherwise
    // iterate the stub map directly (no per-frame id array allocated upstream).
    const currentFrameIds: string[] = [];
    if (filteredIds) {
      for (const id of filteredIds) {
        if (onCurrentFrame(stubsMap.get(id))) {
          currentFrameIds.push(id);
        }
      }
    } else {
      for (const [id, stub] of stubsMap) {
        if (onCurrentFrame(stub)) {
          currentFrameIds.push(id);
        }
      }
    }

    // Step 2: Classify current-frame IDs against two nested boxes in ONE pass
    // (C2): the UNEXPANDED viewport (what the user sees — drives hydration, the
    // render-coverage counts, and visibility tier 1), a RING out to the box
    // expanded 50% each side (the pan-preload margin — visibility tier 2), and
    // everything else OUTSIDE (visibility tier 3). Zooming in re-prioritizes the
    // newly-visible annotations. (When zoomed out, the box covers the whole
    // frame, so ranking hydration against it never tracks zoom.)
    let inViewport = currentFrameIds;
    let ring: string[] = [];
    let outside: string[] = [];

    if (gcsBounds && gcsBounds.length === 4) {
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (const pt of gcsBounds) {
        minX = Math.min(minX, pt.x);
        minY = Math.min(minY, pt.y);
        maxX = Math.max(maxX, pt.x);
        maxY = Math.max(maxY, pt.y);
      }
      const width = maxX - minX;
      const height = maxY - minY;
      ({ inViewport, ring, outside } =
        annotationSpatialIndex.partitionByViewports(
          currentFrameIds,
          { minX, minY, maxX, maxY },
          {
            minX: minX - width * 0.5,
            minY: minY - height * 0.5,
            maxX: maxX + width * 0.5,
            maxY: maxY + height * 0.5,
          },
        ));
    }

    // Step 3: Fill the visible budget in priority tiers — the actual
    // (unexpanded) viewport first, then the pan-preload ring, then off-screen.
    // Prioritizing the actual viewport is what makes the minimumVisible floor
    // (folded into visibleBudget) hold IN THE VISIBLE AREA rather than being
    // diluted across the larger pan-preload box.
    const visibleIds = selectVisibleIds({
      inViewportIds: inViewport,
      marginIds: ring,
      offViewportIds: outside,
      budget: visibleBudget,
      selectSubset: selectStableSubset,
    });
    const visibleSet = new Set(visibleIds);

    // Step 4: Fill hydration budget (two-tier, largest first, UNEXPANDED box).
    // Candidates are restricted to the DRAWN (visible) set: only visible
    // annotations are rendered, so hydrating anything else fetches coordinates
    // that never appear — and because visibility picks a stable-hash subset while
    // hydration picks the largest, an unrestricted candidate list could hydrate
    // mostly-undrawn annotations and leave drawn ones as dots. Points are
    // self-complete (centroid IS the only coordinate) so they never hydrate —
    // dropped here too. selectLargestBySize then picks the largest by
    // estimatedRadius via a bounded min-heap (not a full O(N log N) sort).
    const needsHydration = (id: string): boolean =>
      visibleSet.has(id) && idHasHydratableShape(id, stubsMap);
    const sizeOf = (id: string) => stubsMap.get(id)?.estimatedRadius ?? 0;
    const hydInViewport = inViewport.filter(needsHydration);
    let idsToHydrate: string[];
    if (hydInViewport.length >= hydrationBudget) {
      idsToHydrate = selectLargestBySize(
        hydInViewport,
        sizeOf,
        hydrationBudget,
      );
    } else {
      // Fill the rest from off the actual viewport (ring + outside) — still only
      // drawn ones. Built in a single filtered pass (no intermediate concat) and
      // only in this branch, where the in-viewport shapes don't fill the budget.
      const offHydratable: string[] = [];
      for (const id of ring) {
        if (needsHydration(id)) offHydratable.push(id);
      }
      for (const id of outside) {
        if (needsHydration(id)) offHydratable.push(id);
      }
      const remainingBudget = hydrationBudget - hydInViewport.length;
      idsToHydrate = [
        ...hydInViewport,
        ...selectLargestBySize(offHydratable, sizeOf, remainingBudget),
      ];
    }

    // Step 5: Apply visibility
    this.setVisibleAnnotationIds(visibleIds);

    // Step 5b: Render-coverage counts for the ACTUAL (unexpanded) viewport — how
    // many annotations are in view vs how many of those are drawn. Reuses the
    // partition's inViewport bucket. Drives the render-coverage indicator.
    let viewportRendered = 0;
    for (const id of inViewport) {
      if (visibleSet.has(id)) {
        viewportRendered += 1;
      }
    }
    this.setViewportCounts({
      total: inViewport.length,
      rendered: viewportRendered,
    });

    // Step 6: Determine hydration mode
    this.setHydrationMode(idsToHydrate.length > 0 ? "shapes" : "dots");

    // Step 7: Hydrate from backend API
    // Capture state synchronously, then fire async hydration outside
    // the Vuex action proxy (vuex-module-decorators breaks after await).
    const hydratedCache = this.hydratedAnnotations;
    const api = this.annotationsAPI;
    const idsToFetch: string[] = [];
    const idsToTouch: string[] = [];
    for (const id of idsToHydrate) {
      if (hydratedCache.has(id)) {
        idsToTouch.push(id);
      } else {
        idsToFetch.push(id);
      }
    }
    stubPerf.trackVisibilityUpdate();
    stubPerf.trackRequest(idsToFetch.length, idsToTouch.length);
    // Debounced + abortable so rapid viewport changes collapse to one fetch and
    // a superseded in-flight fetch can't overwrite newer cache state (C1).
    viewportHydrationTask.schedule({ api, idsToFetch, idsToTouch });
  }

  /**
   * Hydrate-on-demand for specific ids (C3): selecting or navigating to a stub
   * that isn't in the hydration cache otherwise renders it as a dot until the
   * viewport happens to hydrate it. This fetches the full coordinates for the
   * given ids (known stubs not already hydrated) so they render as real shapes
   * immediately. No-op outside stub-only mode (everything is already full).
   */
  @Action
  ensureHydrated(ids: Iterable<string>) {
    // Accept any iterable (Array or the live selection Set) so callers don't
    // have to spread a large selection into a throwaway array on every change
    // (Finding 14). idsNeedingHydration iterates it directly and returns []
    // for an empty input, which the idsToFetch guard below already handles.
    if (!this.stubOnlyMode) {
      return;
    }
    const stubs = this.annotationStubs;
    const idsToFetch = idsNeedingHydration(
      ids,
      this.hydratedAnnotations,
      stubs,
    ).filter((id) => idHasHydratableShape(id, stubs));
    if (idsToFetch.length === 0) {
      return;
    }
    // Cap the on-demand hydration so a "select all" on a huge dataset can't
    // post the entire id set to /hydrate (a giant request that defeats lazy
    // mode and risks OOM). Beyond the cap the extras stay stubs (dots) — you
    // can't meaningfully view more than this many shapes at once anyway, and
    // the hydration cache is itself hard-capped. maxHydrated is the natural
    // "how many shapes to hold" budget.
    const cap = this.visibilityConfig.maxHydrated;
    const capped =
      idsToFetch.length > cap ? idsToFetch.slice(0, cap) : idsToFetch;
    // Fire the fetch outside the action proxy (vuex-module-decorators breaks
    // after await). mergeHydratedAnnotations accumulates into the cache and
    // protects selected ids from LRU eviction (up to the hard cap).
    _hydrateFromBackend(this.annotationsAPI, capped, []);
  }
}

const annotationModule = getModule(Annotations);
export default annotationModule;

/**
 * Hydrate annotations from the backend, outside the Vuex action proxy.
 * vuex-module-decorators breaks this/state/mutation access after await,
 * so we run the async fetch as a plain function and commit directly
 * to the module instance.
 */
async function _hydrateFromBackend(
  api: AnnotationsAPI,
  idsToFetch: string[],
  idsToTouch: string[],
  signal?: AbortSignal,
) {
  if (idsToFetch.length > 0) {
    const start = performance.now();
    try {
      const fetched = await api.hydrateAnnotations(idsToFetch, signal);
      stubPerf.trackLatency(performance.now() - start);
      annotationModule.mergeHydratedAnnotations({
        newEntries: fetched.map((a) => ({ id: a.id, annotation: a })),
        touchedIds: idsToTouch,
      });
    } catch (error) {
      // Aborted requests are superseded by a newer hydration (C1), not real
      // failures — swallow them so they can't overwrite newer cache state and
      // don't spam the log.
      if (isAbortError(error)) {
        return;
      }
      logError(`Hydration fetch failed: ${(error as Error).message}`);
    }
  } else if (idsToTouch.length > 0) {
    annotationModule.mergeHydratedAnnotations({
      newEntries: [],
      touchedIds: idsToTouch,
    });
  }
}

// Viewport-driven hydration (C1): pan/zoom/frame changes call
// updateVisibilityAndHydration repeatedly, each computing a fresh fetch set.
// Debounce so rapid changes collapse to one fetch, and abort the previous
// in-flight fetch when a newer one fires so a stale response can't clobber the
// newer hydration cache. Selection-driven hydration (ensureHydrated) bypasses
// this and fires immediately so selected annotations always land.
const HYDRATION_FETCH_DEBOUNCE_MS = 200;
const viewportHydrationTask = createDebouncedAbortableTask<{
  api: AnnotationsAPI;
  idsToFetch: string[];
  idsToTouch: string[];
}>(
  ({ api, idsToFetch, idsToTouch }, signal) =>
    _hydrateFromBackend(api, idsToFetch, idsToTouch, signal),
  HYDRATION_FETCH_DEBOUNCE_MS,
);

// Self-accept HMR to prevent vuex-module-decorators from re-registering
// the dynamic module (which causes duplicate getters and state overwrites).
if (import.meta.hot) {
  import.meta.hot.accept();
}

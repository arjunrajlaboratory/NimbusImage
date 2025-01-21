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
} from "./model";

import Vue, { markRaw } from "vue";
import { simpleCentroid } from "@/utils/annotation";
import { logError } from "@/utils/log";
import progress from "./progress";
import { IAnnotationSetup } from "@/tools/creation/templates/AnnotationConfiguration.vue";

@Module({ dynamic: true, store, name: "annotation" })
export class Annotations extends VuexModule {
  annotationsAPI = main.annotationsAPI;

  // Annotations from the current dataset and configuration
  annotations: IAnnotation[] = [];
  // Connections from the current dataset and configuration
  annotationConnections: IAnnotationConnection[] = [];

  annotationCentroids: { [annotationId: string]: IGeoJSPosition } = {};
  annotationIdToIdx: { [annotationId: string]: number } = {};

  selectedAnnotations: IAnnotation[] = [];
  activeAnnotationIds: string[] = [];

  pendingAnnotation: IAnnotation | null = null;
  submitPendingAnnotationTimeout: number = 1;
  submitPendingAnnotation: ((submit: boolean) => void) | null = null;

  get selectedAnnotationIds() {
    return this.selectedAnnotations.map(
      (annotation: IAnnotation) => annotation.id,
    );
  }

  get allAnnotationIds() {
    return this.annotations.map((annotation: IAnnotation) => annotation.id);
  }

  get isAnnotationSelected() {
    const annotationIdsSet = new Set(this.selectedAnnotationIds);
    return (annotationId: string) => annotationIdsSet.has(annotationId);
  }

  get inactiveAnnotationIds() {
    return this.annotations
      .map((annotation: IAnnotation) => annotation.id)
      .filter((id: string) => !this.activeAnnotationIds.includes(id));
  }

  get getAnnotationFromId() {
    return (annotationId: string) => {
      const idx = this.annotationIdToIdx[annotationId];
      return idx === undefined ? undefined : this.annotations[idx];
    };
  }

  get annotationTags() {
    const tagSet: Set<string> = new Set();
    for (const { tags } of this.annotations) {
      for (const tag of tags) {
        tagSet.add(tag);
      }
    }
    return tagSet;
  }

  hoveredAnnotationId: string | null = null;

  @Action
  async undoOrRedo(undo: boolean) {
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
      if (undo) {
        await this.annotationsAPI.undo(datasetId);
      } else {
        await this.annotationsAPI.redo(datasetId);
      }
      this.context.dispatch("fetchAnnotations");
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
  public activateAnnotations(ids: string[]) {
    this.activeAnnotationIds = [
      ...this.activeAnnotationIds,
      ...ids.filter((id: string) => !this.activeAnnotationIds.includes(id)),
    ];
  }

  @Mutation
  public deactivateAnnotations(ids: string[]) {
    this.activeAnnotationIds = this.activeAnnotationIds.filter(
      (id: string) => !ids.includes(id),
    );
  }

  @Action
  public toggleActiveAnnotations(ids: string[]) {
    const toRemove = ids.filter((id: string) =>
      this.activeAnnotationIds.includes(id),
    );
    const toAdd = ids.filter(
      (id: string) => !this.activeAnnotationIds.includes(id),
    );
    this.activateAnnotations(toAdd);
    this.deactivateAnnotations(toRemove);
  }

  @Action
  public toggleActiveAnnotation(id: string) {
    this.toggleActiveAnnotations([id]);
  }

  @Mutation
  public setSelected(selected: IAnnotation[]) {
    this.selectedAnnotations = selected;
  }

  @Mutation
  public selectAnnotation(annotation: IAnnotation) {
    if (this.selectedAnnotations.find((a) => a.id === annotation.id)) {
      return;
    }
    this.selectedAnnotations = [...this.selectedAnnotations, annotation];
  }

  @Mutation
  public selectAnnotations(selected: IAnnotation[]) {
    const selectedAnnotationIds = this.selectedAnnotations.map(
      (annotation: IAnnotation) => annotation.id,
    );
    const annotationsToAdd = selected.filter(
      (annotation) => !selectedAnnotationIds.includes(annotation.id),
    );
    this.selectedAnnotations = [
      ...this.selectedAnnotations,
      ...annotationsToAdd,
    ];
  }

  @Mutation
  public unselectAnnotation(annotation: IAnnotation) {
    const index = this.selectedAnnotations.findIndex(
      (a: IAnnotation) => a.id === annotation.id,
    );
    if (index >= 0) {
      this.selectedAnnotations.splice(index, 1);
    }
  }

  @Mutation
  public unselectAnnotations(selected: IAnnotation[]) {
    const selectedAnnotationsIds = selected.map(
      (annotation: IAnnotation) => annotation.id,
    );
    const annotationsToSelect = this.selectedAnnotations.filter(
      (annotation: IAnnotation) =>
        !selectedAnnotationsIds.includes(annotation.id),
    );
    this.selectedAnnotations = [...annotationsToSelect];
  }

  @Action
  public toggleSelected(selected: IAnnotation[]) {
    selected.forEach((annotation) => {
      if (this.selectedAnnotations.find((a) => a.id === annotation.id)) {
        this.unselectAnnotation(annotation);
      } else {
        this.selectAnnotation(annotation);
      }
    });
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
  private getAnnotationSubmition(annotationBase: IAnnotationBase) {
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
    const submited = await this.getAnnotationSubmition(annotationBase);
    if (!submited) {
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

  @Mutation
  private addAnnotationImpl(value: IAnnotation) {
    this.annotations.push(value);
    Vue.set(
      this.annotationCentroids,
      value.id,
      simpleCentroid(value.coordinates),
    );
    Vue.set(this.annotationIdToIdx, value.id, this.annotations.length - 1);
  }

  @Mutation
  private setAnnotation({
    annotation,
    index,
  }: {
    annotation: IAnnotation;
    index: number;
  }) {
    Vue.set(this.annotations, index, annotation);
    Vue.set(
      this.annotationCentroids,
      annotation.id,
      simpleCentroid(annotation.coordinates),
    );
    Vue.set(this.annotationIdToIdx, annotation.id, index);
  }

  @Mutation
  public setAnnotations(values: IAnnotation[]) {
    const nAnnotations = values.length;
    // Check if annotations are the same
    if (nAnnotations === this.annotations.length) {
      let equals = true;
      for (let i = 0; i < nAnnotations; ++i) {
        if (values[i].id !== this.annotations[i].id) {
          equals = false;
          break;
        }
      }
      if (equals) {
        return;
      }
    }
    this.annotations = values;
    this.annotationCentroids = {};
    this.annotationIdToIdx = {};
    for (let idx = 0; idx < this.annotations.length; ++idx) {
      const annotation = this.annotations[idx];
      Vue.set(
        this.annotationCentroids,
        annotation.id,
        simpleCentroid(annotation.coordinates),
      );
      Vue.set(this.annotationIdToIdx, annotation.id, idx);
    }
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
    if (!main.dataset) {
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

  @Action
  public async deleteAllConnections({
    parentIds,
    childIds,
  }: {
    parentIds: string[];
    childIds: string[];
  }) {
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
    sync.setSaving(true);
    await this.annotationsAPI.deleteMultipleConnections(connectionIds);
    this.deleteMultipleConnections(connectionIds);
    sync.setSaving(false);
    return connectionIds;
  }

  @Action
  public async deleteAllTimelapseConnections() {
    const connectionsToDelete = this.annotationConnections.filter(
      (connection) => connection.tags.includes("Time lapse connection"),
    );
    await this.deleteConnections(connectionsToDelete.map(({ id }) => id));
  }

  @Action
  public async createConnection(
    annotationConnectionBase: IAnnotationConnectionBase,
  ): Promise<IAnnotationConnection | null> {
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
    if (!main.dataset) {
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
      .map((id) => this.annotations.find((a) => a.id === id))
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
    this.annotationConnections.push(...value);
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
    this.annotationConnections.push(value);
  }

  @Mutation
  public setConnections(values: IAnnotationConnection[]) {
    this.annotationConnections = values;
  }

  @Action
  public async deleteAnnotations(ids: string[]) {
    if (ids.length === 0) {
      return;
    }

    sync.setSaving(true);
    await this.annotationsAPI.deleteMultipleAnnotations(ids);
    sync.setSaving(false);

    this.setAnnotations(
      this.annotations.filter(
        (annotation: IAnnotation) => !ids.includes(annotation.id),
      ),
    );
  }

  @Action
  public deleteSelectedAnnotations() {
    this.deleteAnnotations(this.selectedAnnotationIds);
    this.setSelected([]);
  }

  @Action
  public async deleteUnselectedAnnotations() {
    const unselectedIds = this.annotations
      .filter(
        (annotation) =>
          !this.selectedAnnotations.some(
            (selected) => selected.id === annotation.id,
          ),
      )
      .map((annotation) => annotation.id);

    this.deleteAnnotations(unselectedIds);
  }

  @Action
  public async updateAnnotationsPerId({
    annotationIds,
    editFunction,
  }: {
    annotationIds: string[];
    editFunction: (annotation: IAnnotation) => void;
  }) {
    sync.setSaving(true);
    const newAnnotations = [];
    for (const annotationId of annotationIds) {
      const annotationIndex = this.annotations.findIndex(
        (annotation: IAnnotation) => annotation.id === annotationId,
      );
      if (annotationIndex === -1) {
        continue;
      }
      const oldAnnotation = this.annotations[annotationIndex];
      const newAnnotation = markRaw(structuredClone(oldAnnotation));
      editFunction(newAnnotation);
      this.setAnnotation({
        annotation: newAnnotation,
        index: annotationIndex,
      });
      newAnnotations.push(newAnnotation);
    }
    if (newAnnotations.length) {
      await this.annotationsAPI.updateAnnotations(newAnnotations);
    }
    sync.setSaving(false);
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
    this.updateAnnotationsPerId({ annotationIds, editFunction });
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
    this.updateAnnotationsPerId({ annotationIds, editFunction });
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
    this.updateAnnotationsPerId({ annotationIds, editFunction });
  }

  @Action
  public tagSelectedAnnotations({
    tags,
    replace,
  }: {
    tags: string[];
    replace: boolean;
  }) {
    if (replace) {
      this.replaceTagsByAnnotationIds({
        annotationIds: this.selectedAnnotationIds,
        tags,
      });
    } else {
      this.addTagsByAnnotationIds({
        annotationIds: this.selectedAnnotationIds,
        tags,
      });
    }
  }

  @Action
  public removeTagsFromSelectedAnnotations(tags: string[]) {
    this.removeTagsByAnnotationIds({
      annotationIds: this.selectedAnnotationIds,
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
  public colorAnnotationIds({
    color,
    annotationIds,
  }: {
    color: string | null;
    annotationIds: string[];
  }) {
    const editFunction = (annotation: IAnnotation): void => {
      annotation.color = color;
    };
    this.updateAnnotationsPerId({ annotationIds, editFunction });
  }

  @Action
  public colorSelectedAnnotations(color: string | null) {
    this.colorAnnotationIds({
      annotationIds: this.selectedAnnotationIds,
      color,
    });
  }

  @Action
  public updateAnnotationName({ name, id }: { name: string; id: string }) {
    const editFunction = (annotation: IAnnotation): void => {
      annotation.name = name;
    };
    this.updateAnnotationsPerId({ annotationIds: [id], editFunction });
  }

  @Action
  async fetchAnnotations() {
    this.setAnnotations([]);
    this.setConnections([]);
    if (!main.dataset || !main.configuration) {
      return;
    }
    try {
      const annotationsPromise = this.annotationsAPI.getAnnotationsForDatasetId(
        main.dataset.id,
      );
      const connectionsPromise = this.annotationsAPI.getConnectionsForDatasetId(
        main.dataset.id,
      );
      const promises: [
        Promise<IAnnotation[]>,
        Promise<IAnnotationConnection[]>,
      ] = [annotationsPromise, connectionsPromise];
      const [annotations, connections]: [
        IAnnotation[],
        IAnnotationConnection[],
      ] = await Promise.all(promises);
      if (connections?.length) {
        this.setConnections(connections);
      } else {
        this.setConnections([]);
      }
      if (annotations?.length) {
        this.setAnnotations(annotations);
      } else {
        this.setAnnotations([]);
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
    if (!main.dataset || !main.configuration) {
      return null;
    }
    const datasetId = main.dataset.id;

    // Clear errors while maintaining reactivity
    Vue.set(error, "errors", []);

    // Create a progress entry using the new progress store
    const progressId = await progress.create({
      type: ProgressType.ANNOTATION_COMPUTE,
      title: `Computing annotations with ${tool.name}`,
    });

    const { location, channel } =
      await this.getAnnotationLocationFromTool(tool);
    const tile = { XY: main.xy, Z: main.z, Time: main.time };
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
          defaultTitle: `Computing annotations with ${tool.name}`,
        });
      },
      errorCallback: createErrorEventCallback(error),
    };

    jobs.addJob(computeJob).then((success: boolean) => {
      this.fetchAnnotations();
      main.loadLargeImages(); // I'm pretty sure this function won't reload the large image if it's already loaded
      // TODO: We may also want to fetch connections and properties here, depending on flags set in the worker image
      progress.complete(progressId);
      callback(success);
    });

    return computeJob;
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
}

export default getModule(Annotations);

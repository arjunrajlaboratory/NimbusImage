import {
  getModule,
  Action,
  Module,
  Mutation,
  VuexModule,
} from "vuex-module-decorators";
import store from "./root";

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
  TPropertyValue,
  ProgressType,
  IJobEventData,
} from "./model";

import Vue from "vue";

import main from "./index";

import { canComputeAnnotationProperty } from "@/utils/annotation";
import filters from "./filters";
import annotations from "./annotation";
import jobs, { createProgressEventCallback } from "./jobs";
import { findIndexOfPath } from "@/utils/paths";
import { arePathEquals } from "@/utils/paths";
import progress from "./progress";

type TNestedObject = { [pathName: string]: TNestedObject };

export interface IPropertyStatus {
  running: boolean;
  previousRun: boolean | null;
  progressInfo: IProgressInfo;
}

const defaultStatus: () => IPropertyStatus = () => ({
  running: false,
  previousRun: null,
  progressInfo: {},
});

@Module({ dynamic: true, store, name: "properties" })
export class Properties extends VuexModule {
  propertiesAPI = main.propertiesAPI;

  properties: IAnnotationProperty[] = [];

  displayedPropertyPaths: string[][] = [];

  propertyValues: IAnnotationPropertyValues = {};

  propertyStatuses: {
    [propertyId: string]: IPropertyStatus;
  } = {};

  workerImageList: IWorkerImageList = {};
  workerInterfaces: { [image: string]: IWorkerInterface | null } = {};
  workerPreviews: { [image: string]: { text: string; image: string } } = {};
  displayWorkerPreview = true;

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
    Vue.delete(this.workerInterfaces, image);
  }

  @Mutation
  setDisplayWorkerPreview(value: boolean) {
    this.displayWorkerPreview = value;
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
  updatePropertyValues(values: IAnnotationPropertyValues) {
    // TODO(performance): merge instead
    this.propertyValues = values;
  }

  @Mutation
  replaceProperty(property: IAnnotationProperty) {
    const find = (prop: IAnnotationProperty) => prop.id === property.id;
    const prev = this.properties.find(find);
    if (!prev) {
      return;
    }
    Vue.set(this.properties, this.properties.indexOf(prev), property);
  }

  get getPropertyById() {
    return (id: string) => {
      const find = (prop: IAnnotationProperty) => prop.id === id;
      return this.properties.find(find) || null;
    };
  }

  @Mutation
  togglePropertyPathVisibility(path: string[]) {
    const pathIdx = findIndexOfPath(path, this.displayedPropertyPaths);
    if (pathIdx < 0) {
      this.displayedPropertyPaths.push(path);
    } else {
      this.displayedPropertyPaths.splice(pathIdx, 1);
    }
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

  get computedPropertyPaths() {
    // Combine all the property objects per annotation (e.g. {myPropertyId: { mySubId: 42 }} and {anotherPropertyId: 24} )
    // Into a single object (e.g. {myPropertyId: {mySubId: {}}, anotherPropertyId: {} })
    const valuesObjectPerAnnotationId = this.propertyValues;
    const nestedAggregationObject: TNestedObject = {};
    const aggregationStack: [TNestedObject, TPropertyValue][] = [];
    for (const annotationId in valuesObjectPerAnnotationId) {
      const valuesObject = valuesObjectPerAnnotationId[annotationId];
      aggregationStack.push([nestedAggregationObject, valuesObject]);
    }
    while (aggregationStack.length > 0) {
      const [currentLocation, valuesObject] = aggregationStack.pop()!;
      if (typeof valuesObject !== "object") {
        continue;
      }
      for (const key in valuesObject) {
        const newLocation = {};
        const newValues = valuesObject[key];
        currentLocation[key] = newLocation;
        aggregationStack.push([newLocation, newValues]);
      }
    }
    // Now compute each valid path to an empty object
    // For example with {myPropertyId: {mySubId: {}}, anotherPropertyId: {} }:
    // ["myPropertyId", "mySubId"] and ["anotherPropertyId"]
    const collectedPaths: string[][] = [];
    const collectionStack: [string[], TNestedObject][] = [
      [[], nestedAggregationObject],
    ];
    while (collectionStack.length > 0) {
      const [currentPath, nestedObject] = collectionStack.pop()!;
      let isNestedObjectEmpty = true;
      for (const pathName in nestedObject) {
        isNestedObjectEmpty = false;
        collectionStack.push([
          [...currentPath, pathName],
          nestedObject[pathName],
        ]);
      }
      if (isNestedObjectEmpty) {
        collectedPaths.push(currentPath);
      }
    }
    return collectedPaths.filter((path) => {
      // Check that the values have a corresponding path
      if (path.length < 1) {
        return false;
      }
      const property = this.getPropertyById(path[0]);
      return property !== null;
    });
  }

  @Mutation
  private setDisplayedPropertyPaths(paths: string[][]) {
    this.displayedPropertyPaths = paths;
  }

  @Action
  updateDisplayedFromComputedProperties() {
    // This action is called in a global watcher (see "setupWatchers" in main store)
    // When propertyValues changes, some paths may be removed
    const availablePaths = this.computedPropertyPaths;
    const newPaths = this.displayedPropertyPaths.filter((displayedPath) =>
      availablePaths.some((availablePath) =>
        arePathEquals(displayedPath, availablePath),
      ),
    );
    this.setDisplayedPropertyPaths(newPaths);
  }

  @Action
  async computeProperty(property: IAnnotationProperty) {
    if (!main.dataset) {
      return null;
    }
    const propertyId = property.id;
    const datasetId = main.dataset.id;
    const scales = main.scales;

    // Create a progress entry using the new progress store
    const progressId = await progress.create({
      type: ProgressType.PROPERTY_COMPUTE,
      title: `Computing ${property.name}`,
    });

    // Set up the old progress tracking
    if (!this.propertyStatuses[propertyId]) {
      Vue.set(this.propertyStatuses, propertyId, defaultStatus());
    }
    const status = this.propertyStatuses[propertyId];
    Vue.set(status, "running", true);
    Vue.set(status, "previousRun", null);

    const response = await this.propertiesAPI.computeProperty(
      propertyId,
      datasetId,
      property,
      scales,
    );

    // Keep track of running jobs
    const jobId = response.data[0]?._id;
    if (!jobId) {
      progress.complete(progressId); // Clean up progress if job creation fails
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
    };

    jobs.addJob(computeJob).then(async (success: boolean) => {
      await this.fetchPropertyValues();
      await filters.updateHistograms();
      // Update both progress systems
      progress.complete(progressId);
      Vue.set(status, "running", false);
      Vue.set(status, "previousRun", success);
      Vue.set(status, "progressInfo", {});
    });

    return computeJob;
  }

  @Mutation
  protected setPropertiesImpl(properties: IAnnotationProperty[]) {
    this.properties = [...properties];
  }

  @Action
  protected setProperties(properties: IAnnotationProperty[]) {
    this.setPropertiesImpl(properties);
    const propertyIds = this.properties.map((p) => p.id);
    this.context.dispatch("updateConfigurationProperties", propertyIds);
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
    }
  }

  @Action
  async fetchPropertyValues() {
    if (!main.dataset?.id) {
      return;
    }
    const values = await this.propertiesAPI.getPropertyValues(main.dataset.id);
    this.updatePropertyValues(values);
  }

  @Action
  async createProperty(property: IAnnotationPropertyConfiguration) {
    const newProperty = await this.propertiesAPI.createProperty(property);
    if (newProperty) {
      this.setProperties([...this.properties, newProperty]);
    }
    return newProperty;
  }

  @Action
  async deleteProperty(propertyId: string) {
    // TODO: temp another configuration could be using this property!
    // await this.propertiesAPI.deleteProperty(propertyId);
    this.setProperties(this.properties.filter((p) => p.id !== propertyId));
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
    const list = await this.propertiesAPI.getWorkerImages();
    this.setWorkerImageList(list);
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
    const tile = { XY: main.xy, Z: main.z, Time: main.time };
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
                this.fetchWorkerPreview(image);
              }
            });
          setTimeout(() => {
            this.fetchWorkerPreview(image);
          }, 5000);
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

export default getModule(Properties);

import {
  getModule,
  Action,
  Module,
  Mutation,
  VuexModule,
} from "vuex-module-decorators";
import store from "./root";

import main from "./index";
import annotation from "./annotation";
import properties from "./properties";

import { tagCloudFilterFunction } from "@/utils/annotation";

import {
  IAnnotation,
  ITagAnnotationFilter,
  IPropertyAnnotationFilter,
  IROIAnnotationFilter,
  IIdAnnotationFilter,
  IGeoJSPosition,
  TPropertyHistogram,
  IAnnotationLocation,
} from "./model";

import geo from "geojs";
import {
  arePathEquals,
  createPathStringFromPathArray,
  findIndexOfPath,
  getValueFromObjectAndPath,
} from "@/utils/paths";

type TFilterHistograms = {
  [joinedPropertyPath: string]: TPropertyHistogram;
};

@Module({ dynamic: true, store, name: "filters" })
export class Filters extends VuexModule {
  // Annotation browser filters
  tagFilter: ITagAnnotationFilter = {
    id: "tagFilter",
    exclusive: false,
    enabled: false,
    tags: [],
  };

  onlyCurrentFrame: boolean = false;

  propertyFilters: IPropertyAnnotationFilter[] = [];

  roiFilters: IROIAnnotationFilter[] = [];
  emptyROIFilter: IROIAnnotationFilter | null = null;

  selectionFilter: IIdAnnotationFilter = {
    enabled: false,
    exclusive: true,
    id: "selection",
    annotationIds: [],
  };

  filterPaths: string[][] = [];

  histograms: TFilterHistograms = {};

  annotationIdFilters: IIdAnnotationFilter[] = [];

  @Mutation
  togglePropertyPathFiltering(path: string[]) {
    const pathIdx = findIndexOfPath(path, this.filterPaths);
    if (pathIdx < 0) {
      this.filterPaths.push(path);
    } else {
      this.filterPaths.splice(pathIdx, 1);
    }
  }

  @Mutation
  addSelectionAsFilter() {
    const selection = annotation.selectedAnnotations.map(
      (value: IAnnotation) => value.id,
    );
    this.selectionFilter = {
      enabled: true,
      exclusive: true,
      id: "selection",
      annotationIds: selection,
    };
  }

  @Mutation
  clearSelection() {
    this.selectionFilter = {
      enabled: false,
      exclusive: true,
      id: "selection",
      annotationIds: [],
    };
  }

  @Mutation
  newROIFilter() {
    this.emptyROIFilter = {
      id: `Region Filter ${this.roiFilters.length}`,
      exclusive: true,
      enabled: true,
      roi: [],
    };
  }

  @Mutation
  removeROIFilter(id: string) {
    {
      this.roiFilters = this.roiFilters
        .filter((filter: IROIAnnotationFilter) => filter.id !== id)
        .map((filter: IROIAnnotationFilter, index) => ({
          ...filter,
          id: `Region Filter ${index}`,
        }));
    }
  }

  @Mutation
  validateNewROIFilter(roi: IGeoJSPosition[]) {
    if (!this.emptyROIFilter) {
      return;
    }
    this.roiFilters = [...this.roiFilters, { ...this.emptyROIFilter, roi }];
    this.emptyROIFilter = null;
  }

  @Mutation
  cancelROISelection() {
    this.emptyROIFilter = null;
  }

  @Mutation
  toggleRoiFilterEnabled(id: string) {
    const filter = this.roiFilters.find(
      (filter: IROIAnnotationFilter) => filter.id === id,
    );
    if (filter) {
      this.roiFilters = [
        ...this.roiFilters.filter(
          (value: IROIAnnotationFilter) => value.id !== id,
        ),
        { ...filter, enabled: !filter.enabled },
      ];
    }
  }

  @Mutation
  newAnnotationIdFilter(annotationIds: string[]) {
    this.annotationIdFilters.push({
      id: `Annotation List Filter ${this.annotationIdFilters.length}`,
      exclusive: true,
      enabled: true,
      annotationIds,
    });
  }

  @Mutation
  updateAnnotationIdFilter(filterIdAndAnnotationIds: {
    id: string;
    annotationIds: string[];
  }) {
    this.annotationIdFilters = this.annotationIdFilters.map((filter) =>
      filter.id === filterIdAndAnnotationIds.id
        ? {
            ...filter,
            annotationIds: filterIdAndAnnotationIds.annotationIds,
          }
        : filter,
    );
  }

  @Mutation
  removeAnnotationIdFilter(id: string) {
    this.annotationIdFilters = this.annotationIdFilters
      .filter((filter) => filter.id !== id)
      .map((filter, index) => ({
        ...filter,
        id: `Annotation List Filter ${index}`,
      }));
  }

  @Mutation
  toggleAnnotationIdFilterEnabled(id: string) {
    this.annotationIdFilters = this.annotationIdFilters.map((filter) =>
      filter.id === id ? { ...filter, enabled: !filter.enabled } : filter,
    );
  }

  get filteredAnnotations() {
    const selectionFilter = this.selectionFilter;
    const tagFilter = this.tagFilter;
    const propertyFilters = this.propertyFilters;
    const enabledPropertyFilters = propertyFilters.filter(
      (filter: IPropertyAnnotationFilter) => filter.enabled,
    );
    const roiFilters = this.roiFilters;
    const enabledRoiFilters = roiFilters.filter(
      (filter: IROIAnnotationFilter) => filter.enabled,
    );
    const onlyCurrentFrame = this.onlyCurrentFrame;
    const currentFrameLocation: IAnnotationLocation = {
      XY: main.xy,
      Z: main.z,
      Time: main.time,
    };
    const enabledAnnotationIdFilters = this.annotationIdFilters.filter(
      (filter: IIdAnnotationFilter) => filter.enabled,
    );
    return annotation.annotations.filter((annotation: IAnnotation) => {
      // Location filter
      if (
        onlyCurrentFrame &&
        (annotation.location.XY !== currentFrameLocation.XY ||
          annotation.location.Z !== currentFrameLocation.Z ||
          annotation.location.Time !== currentFrameLocation.Time)
      ) {
        return false;
      }

      // Selection filter
      if (
        selectionFilter.enabled &&
        !selectionFilter.annotationIds.includes(annotation.id)
      ) {
        return false;
      }

      // Tag filter
      if (
        tagFilter.enabled &&
        !tagCloudFilterFunction(
          annotation.tags,
          tagFilter.tags,
          tagFilter.exclusive,
        )
      ) {
        return false;
      }

      // Property filters
      const propertyValues = properties.propertyValues[annotation.id] || {};
      const matchesProperties = enabledPropertyFilters.every(
        (filter: IPropertyAnnotationFilter) => {
          const value = getValueFromObjectAndPath(
            propertyValues,
            filter.propertyPath,
          );
          if (filter.valuesOrRange === "values") {
            // If no values specified, don't filter
            if (!filter.values || filter.values.length === 0) {
              return true;
            }
            // Check if the value exists in the set of specified values
            return typeof value === "number" && filter.values.includes(value);
          } else {
            // Default "range" behavior for histograms
            return (
              typeof value === "number" &&
              value >= filter.range.min &&
              value <= filter.range.max
            );
          }
        },
      );
      if (!matchesProperties) {
        return false;
      }

      // Annotation ID filters
      const matchesAnnotationIds =
        enabledAnnotationIdFilters.length === 0 ||
        enabledAnnotationIdFilters.some((filter) =>
          filter.annotationIds.includes(annotation.id),
        );
      if (!matchesAnnotationIds) {
        return false;
      }

      // ROI filters
      const isInROI =
        enabledRoiFilters.length === 0 ||
        enabledRoiFilters.some((filter: IROIAnnotationFilter) =>
          annotation.coordinates.some((point: IGeoJSPosition) =>
            geo.util.pointInPolygon(point, filter.roi),
          ),
        );
      return isInROI;
    });
  }

  get filteredAnnotationIdToIdx() {
    const idToIdx: Map<string, number> = new Map();
    const annotations = this.filteredAnnotations;
    for (let i = 0; i < annotations.length; ++i) {
      idToIdx.set(annotations[i].id, i);
    }
    return idToIdx;
  }

  @Mutation
  public updatePropertyFilter(value: IPropertyAnnotationFilter) {
    this.propertyFilters = [
      ...this.propertyFilters.filter(
        (filter: IPropertyAnnotationFilter) =>
          !arePathEquals(filter.propertyPath, value.propertyPath),
      ),
      value,
    ];
  }

  @Mutation
  public setOnlyCurrentFrame(value: boolean) {
    this.onlyCurrentFrame = value;
  }

  @Mutation
  public setTagFilter(filter: ITagAnnotationFilter) {
    this.tagFilter = filter;
  }

  @Mutation
  public addTagToTagFilter(tag: string) {
    if (this.tagFilter.tags.includes(tag)) {
      return;
    }
    this.tagFilter = Object.assign({}, this.tagFilter, {
      tags: [...this.tagFilter.tags, tag],
    });
  }

  get getHistogram() {
    return (path: string[]): TPropertyHistogram | null => {
      const key = createPathStringFromPathArray(path);
      return this.histograms[key] || null;
    };
  }

  @Mutation
  public setPropertyHistograms(histograms: TFilterHistograms) {
    this.histograms = histograms;
  }

  @Action
  async updateHistograms() {
    const dataset = main.dataset;
    if (!dataset) {
      this.setPropertyHistograms({});
      return;
    }
    const histograms: TFilterHistograms = {};
    const promises = this.filterPaths.map((path: string[]) =>
      properties.propertiesAPI
        .getPropertyHistogram(dataset.id, path)
        .then((histogram: TPropertyHistogram) => {
          const key = createPathStringFromPathArray(path);
          histograms[key] = histogram;
        }),
    );
    Promise.all(promises).then(() => this.setPropertyHistograms(histograms));
  }
}

export default getModule(Filters);

// Self-accept HMR to prevent vuex-module-decorators from re-registering
// the dynamic module (which causes duplicate getters and state overwrites).
if (import.meta.hot) {
  import.meta.hot.accept();
}

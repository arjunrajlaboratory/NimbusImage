import {
  getModule,
  Action,
  Module,
  Mutation,
  VuexModule,
} from "vuex-module-decorators";
import { markRaw } from "vue";
import store from "./root";

import main from "./index";
import annotation from "./annotation";
import properties from "./properties";

import {
  tagCloudFilterFunction,
  annotationTestPoints,
} from "@/utils/annotation";
import { buildPropertyListFilters } from "@/utils/annotationListFilters";
import { createSequenceGuard } from "@/utils/sequenceGuard";

import {
  TAnnotationOrStub,
  IAnnotationFilter,
  ITagAnnotationFilter,
  IPropertyAnnotationFilter,
  IROIAnnotationFilter,
  IIdAnnotationFilter,
  IGeoJSPosition,
  TPropertyHistogram,
  IAnnotationLocation,
  IAnnotationListFilters,
} from "./model";

import geo from "geojs";
import {
  arePathEquals,
  createPathStringFromPathArray,
  findIndexOfPath,
  getValueFromObjectAndPath,
} from "@/utils/paths";

// Monotonic stale-response guard: only the latest refreshPropertyFilterPassingIds
// may apply its result. Module-level (not Vuex state) since it is an internal
// token never read by the UI.
const propertyFilterRequestGuard = createSequenceGuard();

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

  // Lazy (stub-only) mode only: the set of annotation ids passing the active
  // property filters, fetched server-side so client-side filtered drawing no
  // longer requires every annotation's property value in memory (D Stage 2).
  // null means "not in server-property-filter mode" (full mode or no active
  // property filter) or "not yet loaded" — filteredAnnotations passes all
  // annotations through the property predicate in that interim. markRaw so the
  // (potentially large) Set is not deep-proxied; the slot reference is replaced
  // wholesale to drive reactivity.
  propertyFilterPassingIds: Set<string> | null = null;

  @Mutation
  protected resetFilterStateImpl() {
    // Every field below is scoped to a single dataset: property filters and
    // filterPaths reference the previous dataset's property IDs, ROI filters
    // hold coordinates from the previous image, and selection/id filters and
    // histograms reference the previous dataset's annotations. Left in place,
    // they render as broken, uneditable filter chips in the next dataset (the
    // paths no longer resolve to any property). onlyCurrentFrame is a generic
    // view toggle rather than stale data, so it is intentionally preserved.
    this.tagFilter = {
      id: "tagFilter",
      exclusive: false,
      enabled: false,
      tags: [],
    };
    this.propertyFilters = [];
    this.roiFilters = [];
    this.emptyROIFilter = null;
    this.selectionFilter = {
      enabled: false,
      exclusive: true,
      id: "selection",
      annotationIds: [],
    };
    this.filterPaths = [];
    this.histograms = {};
    this.annotationIdFilters = [];
  }

  // Clear per-dataset filter state. Call when switching datasets so stale
  // filters (whose property paths / annotation IDs belong to the previous
  // dataset) don't leak into the next one as broken, uneditable chips.
  @Action
  public resetFilterState() {
    this.resetFilterStateImpl();
  }

  @Mutation
  private togglePropertyPathFilteringImpl(path: string[]) {
    const pathIdx = findIndexOfPath(path, this.filterPaths);
    if (pathIdx < 0) {
      this.filterPaths.push(path);
    } else {
      this.filterPaths.splice(pathIdx, 1);
      this.propertyFilters = this.propertyFilters.filter(
        (filter) => !arePathEquals(filter.propertyPath, path),
      );
    }
  }

  @Action
  togglePropertyPathFiltering(path: string[]) {
    this.togglePropertyPathFilteringImpl(path);
    main.scheduleAnnotationBrowserSave();
  }

  @Mutation
  private setAnnotationBrowserFilterState(payload: {
    filterPaths: string[][];
    propertyFilters: IPropertyAnnotationFilter[];
  }) {
    this.filterPaths = payload.filterPaths;
    this.propertyFilters = payload.propertyFilters;
  }

  // Restore filter rows and their ranges persisted in the configuration.
  // Uses the raw mutation so hydration never schedules a save of its own.
  @Action
  hydrateAnnotationBrowserFilters(payload: {
    filterPaths: string[][];
    propertyFilters: IPropertyAnnotationFilter[];
  }) {
    this.setAnnotationBrowserFilterState(payload);
  }

  @Mutation
  addSelectionAsFilter() {
    const selection = [...annotation.selectedAnnotationIds];
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

  get hasActivePropertyFilter() {
    return this.propertyFilters.some(
      (filter: IPropertyAnnotationFilter) => filter.enabled,
    );
  }

  // How many filters are currently narrowing the set of visible objects.
  // Drives the count badge on the app-bar Filters button, so active filters
  // stay discoverable while the panel is closed. Each enabled filter row
  // counts once; the boolean toggles count once when set away from their
  // permissive default (showAnnotationsFromHiddenLayers defaults to true, so
  // it only counts when off). `emptyROIFilter` is a region still being drawn
  // and filters nothing yet, so it is excluded.
  get activeFilterCount() {
    const countEnabled = (filterList: IAnnotationFilter[]) =>
      filterList.filter((filter: IAnnotationFilter) => filter.enabled).length;
    return (
      (this.tagFilter.enabled ? 1 : 0) +
      (this.onlyCurrentFrame ? 1 : 0) +
      (this.selectionFilter.enabled ? 1 : 0) +
      (main.showAnnotationsFromHiddenLayers ? 0 : 1) +
      countEnabled(this.propertyFilters) +
      countEnabled(this.roiFilters) +
      countEnabled(this.annotationIdFilters)
    );
  }

  @Mutation
  setPropertyFilterPassingIds(ids: string[] | null) {
    this.propertyFilterPassingIds = ids === null ? null : markRaw(new Set(ids));
  }

  // Lazy mode: fetch the ids passing the active property filters server-side
  // (property filters only — other filters stay client-side on stub fields, so
  // composing them is a clean AND in filteredAnnotations). No-op (clears the
  // set) outside lazy mode or when no property filter is active.
  @Action
  async refreshPropertyFilterPassingIds() {
    const datasetId = main.dataset?.id;
    if (
      !datasetId ||
      !annotation.stubOnlyMode ||
      !this.hasActivePropertyFilter
    ) {
      this.setPropertyFilterPassingIds(null);
      return;
    }
    const token = propertyFilterRequestGuard.next();
    const listFilters: IAnnotationListFilters = {
      propertyFilters: buildPropertyListFilters(this.propertyFilters),
    };
    const ids = await main.annotationsAPI.fetchAnnotationListIds(
      datasetId,
      listFilters,
    );
    // Drop the result if a newer refresh started while we were awaiting.
    if (propertyFilterRequestGuard.isCurrent(token)) {
      this.setPropertyFilterPassingIds(ids);
    }
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
    // Captured before the callback shadows `annotation` with the item. Stubs
    // carry no coordinates, so ROI filtering falls back to the centroid map
    // (populated for every annotation id in both full and stub-only modes).
    const centroidsById = annotation.annotationCentroids;
    // In lazy mode the full property-value map is not loaded, so property
    // filtering is driven by a server-fetched id set (D Stage 2) instead of
    // reading each annotation's value client-side.
    const useServerPropertyFilter =
      annotation.stubOnlyMode && enabledPropertyFilters.length > 0;
    const serverPassingIds = this.propertyFilterPassingIds;
    return annotation.annotationsForIteration.filter(
      (annotation: TAnnotationOrStub) => {
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
        if (enabledPropertyFilters.length > 0) {
          if (useServerPropertyFilter) {
            // Lazy mode: membership in the server-fetched passing set. Until it
            // loads (null), pass all so drawing doesn't flash empty.
            if (
              serverPassingIds !== null &&
              !serverPassingIds.has(annotation.id)
            ) {
              return false;
            }
          } else {
            const propertyValues =
              properties.propertyValues[annotation.id] || {};
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
                  return (
                    typeof value === "number" && filter.values.includes(value)
                  );
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
          }
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
        const roiTestPoints = annotationTestPoints(
          annotation,
          centroidsById[annotation.id],
        );
        const isInROI =
          enabledRoiFilters.length === 0 ||
          enabledRoiFilters.some((filter: IROIAnnotationFilter) =>
            roiTestPoints.some((point: IGeoJSPosition) =>
              geo.util.pointInPolygon(point, filter.roi),
            ),
          );
        return isInROI;
      },
    );
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
  private updatePropertyFilterImpl(value: IPropertyAnnotationFilter) {
    this.propertyFilters = [
      ...this.propertyFilters.filter(
        (filter: IPropertyAnnotationFilter) =>
          !arePathEquals(filter.propertyPath, value.propertyPath),
      ),
      value,
    ];
  }

  @Action
  public updatePropertyFilter(value: IPropertyAnnotationFilter) {
    this.updatePropertyFilterImpl(value);
    // Chat-created filters have no Annotation Browser row and remain
    // session-only. Once a row exists, its edits belong to the configuration.
    if (findIndexOfPath(value.propertyPath, this.filterPaths) >= 0) {
      main.scheduleAnnotationBrowserSave();
    }
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

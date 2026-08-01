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
import { idListSignature } from "@/utils/signatures";

import {
  TAnnotationOrStub,
  IAnalysisGate,
  IAnalysisPlot,
  IAnnotationFilter,
  ITagAnnotationFilter,
  IPropertyAnnotationFilter,
  IROIAnnotationFilter,
  IIdAnnotationFilter,
  IGeoJSPosition,
  IAnnotationPropertyValues,
  TPropertyHistogram,
  IAnnotationLocation,
  IAnnotationListFilters,
  TAnalysisAxis,
} from "./model";
import { MAX_ANALYSIS_PLOT_POINTS } from "./constants";
import {
  analysisPropertyPaths,
  buildPlotSeries,
  chainPlotInputs,
  populationSignature,
  resolveGateIds,
} from "@/utils/analysisGating";
import { logError } from "@/utils/log";

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

  // Analysis panel: ordered scatter plots whose gates narrow the filtered set
  // sequentially (see IAnalysisPlot in model.ts). Persisted in the
  // configuration's annotationBrowserConfig — the gate POLYGONS are, anyway;
  // the annotation ids they resolve to live in analysisGateIds below and are
  // never persisted, since they belong to one dataset while a configuration is
  // shared by all of them.
  analysisPlots: IAnalysisPlot[] = [];

  // Derived, session-only: the property values the analysis plots' axes need,
  // over the current population, projected to just those paths. Owned by the
  // store rather than fetched separately by the panel so the gate resolution
  // and the panel's display share ONE round trip — the population can run to
  // MAX_ANALYSIS_PLOT_POINTS ids, so fetching it twice doubled the wait on
  // exactly the path the feature exists for. markRaw: it is a large map that is
  // replaced wholesale.
  analysisValues: IAnnotationPropertyValues = markRaw({});

  // True while a refreshAnalysis fetch is in flight. Explicit rather than
  // inferred from `analysisValues` being empty: an empty result is a real
  // outcome (a property computed for only some objects, or one with no values
  // yet), and inferring left the panel spinning forever on it.
  analysisLoading = false;

  // True while the Analysis palette is showing. The panel needs values for
  // plots that have NO gate (to draw them), which nothing else needs, so the
  // fetch scope depends on whether anyone is looking.
  analysisPanelOpen = false;

  // Derived, session-only: {plotId: ids inside that plot's gate}, produced by
  // refreshAnalysisGateIds. A plot missing from this map has an unresolved gate
  // and contributes no constraint, so drawing never flashes empty while the
  // values needed to resolve it are still loading. markRaw: see
  // setAnalysisGateIds.
  analysisGateIds: { [plotId: string]: string[] } = markRaw({});

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
    this.analysisPlots = [];
    this.analysisGateIds = markRaw({});
    this.analysisValues = markRaw({});
    this.analysisLoading = false;
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

  @Mutation
  private setAnalysisPlotsImpl(plots: IAnalysisPlot[]) {
    this.analysisPlots = plots;
  }

  // Every plot edit funnels through here so exactly one place schedules the
  // configuration save. The gate ids are NOT touched: they are derived state,
  // refreshed by refreshAnalysisGateIds.
  @Action
  private applyAnalysisPlots(plots: IAnalysisPlot[]) {
    this.setAnalysisPlotsImpl(plots);
    main.scheduleAnnotationBrowserSave();
  }

  @Action
  addAnalysisPlot(id: string) {
    this.applyAnalysisPlots([
      ...this.analysisPlots,
      { id, xAxis: null, yAxis: null, gate: null, gateEnabled: true },
    ]);
  }

  @Action
  removeAnalysisPlot(id: string) {
    this.applyAnalysisPlots(
      this.analysisPlots.filter((plot) => plot.id !== id),
    );
    this.dropAnalysisGateIds(id);
  }

  @Action
  setAnalysisPlotAxes(payload: {
    id: string;
    xAxis?: TAnalysisAxis | null;
    yAxis?: TAnalysisAxis | null;
  }) {
    // Changing an axis invalidates the gate: its polygon lives in the old
    // axes' coordinate space, so keeping it would silently filter on criteria
    // the user can no longer see.
    this.applyAnalysisPlots(
      this.analysisPlots.map((plot) =>
        plot.id === payload.id
          ? {
              ...plot,
              xAxis: payload.xAxis !== undefined ? payload.xAxis : plot.xAxis,
              yAxis: payload.yAxis !== undefined ? payload.yAxis : plot.yAxis,
              gate: null,
            }
          : plot,
      ),
    );
    this.dropAnalysisGateIds(payload.id);
  }

  @Action
  setAnalysisPlotGate(payload: { id: string; gate: IAnalysisGate | null }) {
    this.applyAnalysisPlots(
      this.analysisPlots.map((plot) =>
        plot.id === payload.id ? { ...plot, gate: payload.gate } : plot,
      ),
    );
    if (payload.gate === null) {
      this.dropAnalysisGateIds(payload.id);
    }
  }

  @Action
  toggleAnalysisPlotGateEnabled(id: string) {
    this.applyAnalysisPlots(
      this.analysisPlots.map((plot) =>
        plot.id === id ? { ...plot, gateEnabled: !plot.gateEnabled } : plot,
      ),
    );
  }

  // Restore plots persisted in the configuration. Uses the raw mutation so
  // hydration never schedules a save of its own.
  @Action
  hydrateAnalysisPlots(plots: IAnalysisPlot[]) {
    this.setAnalysisPlotsImpl(plots);
    this.setAnalysisGateIds({});
  }

  @Mutation
  setAnalysisGateIds(gateIds: { [plotId: string]: string[] }) {
    // markRaw for the same reason as propertyFilterPassingIds: a gate can hold
    // up to MAX_ANALYSIS_PLOT_POINTS ids, and proxying it would make every
    // membership pass walk a reactive array. The slot reference is replaced
    // wholesale to drive reactivity.
    this.analysisGateIds = markRaw(gateIds);
  }

  @Mutation
  dropAnalysisGateIds(plotId: string) {
    if (this.analysisGateIds[plotId] === undefined) {
      return;
    }
    const next = { ...this.analysisGateIds };
    delete next[plotId];
    this.analysisGateIds = markRaw(next);
  }

  // How many gates are narrowing the filtered set. Counted from the plots
  // rather than from activeAnalysisGateSets so the badge never materializes a
  // Set per gate just to read its length.
  get activeAnalysisGateCount(): number {
    return this.analysisPlots.filter(
      (plot) =>
        plot.gateEnabled &&
        plot.gate !== null &&
        this.analysisGateIds[plot.id] !== undefined,
    ).length;
  }

  // The gates that actually narrow the filtered set right now, in plot order.
  // A plot contributes once it has a drawn, enabled gate whose ids have been
  // resolved (see refreshAnalysisGateIds). Raw id lists rather than Sets, so
  // callers that only forward them to the backend never build one.
  get activeAnalysisGateIdLists(): string[][] {
    return this.analysisPlots.reduce<string[][]>((lists, plot) => {
      const ids = this.analysisGateIds[plot.id];
      if (plot.gateEnabled && plot.gate !== null && ids !== undefined) {
        lists.push(ids);
      }
      return lists;
    }, []);
  }

  get activeAnalysisGateSets(): Set<string>[] {
    return this.activeAnalysisGateIdLists.map((ids) => new Set(ids));
  }

  // A cheap identity for the id-membership filters, for watchers that must
  // react when they change without serializing their id lists. See
  // @/utils/signatures — a select-all puts tens of thousands of ids in here.
  get membershipFilterSignature(): string {
    const describe = (filter: IIdAnnotationFilter) =>
      `${filter.id}:${filter.enabled}:${filter.exclusive}:${idListSignature(
        filter.annotationIds,
      )}`;
    return [this.selectionFilter, ...this.annotationIdFilters]
      .map(describe)
      .join("|");
  }

  // A cheap identity for the gate constraints, same reasoning. The ids are
  // SAMPLED, not just counted: moving a lasso to a different region that
  // happens to contain the same number of objects has to register, or the
  // server-mode list keeps the previous gate's rows.
  get analysisGateSignature(): string {
    return this.analysisPlots
      .map((plot) => {
        const ids = this.analysisGateIds[plot.id];
        return `${plot.id}:${plot.gateEnabled}:${
          ids ? idListSignature(ids) : "-"
        }`;
      })
      .join("|");
  }

  // A cheap identity for the population the analysis panel plots and gates
  // against. See populationSignature for why it samples rather than hashes.
  get analysisPopulationSignature(): string {
    return populationSignature(this.annotationsPassingNonGateFilters);
  }

  // What refreshAnalysis' result depends on: the plots (small — axes plus a
  // polygon), whether anyone is looking, and the population resolved against.
  get analysisInputSignature(): string {
    const wanted =
      this.analysisPanelOpen ||
      this.analysisPlots.some((plot) => plot.gate !== null);
    if (!wanted) {
      // Nothing to fetch or resolve: don't even look at the population, so a
      // dataset nobody is analysing never pays for this getter.
      return "idle";
    }
    return `${JSON.stringify(this.analysisPlots)}|${
      this.analysisPanelOpen
    }|${this.analysisPopulationSignature}`;
  }

  @Mutation
  setAnalysisPanelOpen(open: boolean) {
    this.analysisPanelOpen = open;
  }

  @Mutation
  setAnalysisLoading(loading: boolean) {
    this.analysisLoading = loading;
  }

  @Mutation
  setAnalysisValues(values: IAnnotationPropertyValues) {
    this.analysisValues = markRaw(values);
  }

  /**
   * Fetch the values the analysis plots need and resolve every drawn gate's
   * polygon into the annotation ids it contains.
   *
   * Owned by the store, not the panel, because a gate is a filter: it must
   * apply whether or not the Analysis palette is open, and a gate restored from
   * the configuration has to resolve on load. The panel reads `analysisValues`
   * rather than fetching its own copy, so this is the only round trip — the
   * population runs to MAX_ANALYSIS_PLOT_POINTS ids, and fetching it twice
   * doubled the wait on exactly the path the feature exists for.
   *
   * Fetches when a plot has a gate to resolve, or when the panel is open and
   * needs values to draw. Neither means no fetch, so a configuration that
   * carries plots costs nothing until someone looks at them.
   */
  @Action
  async refreshAnalysis() {
    // Invalidate any in-flight refresh FIRST, before any early return.
    // Advancing the token only on the non-bailout path left a running request
    // "current", so a bail-out could clear the gate and then have the older
    // request commit ids resolved against a population that no longer applies —
    // e.g. one captured below the cap, committed after the cap was crossed,
    // reactivating a gate that should be off. (properties.ts's
    // ensureVisiblePropertyValues claims its token up front for the same
    // reason.)
    const token = analysisGateGuard.next();
    const datasetId = main.dataset?.id;
    const plots = this.analysisPlots;
    const hasGate = plots.some(
      (plot) => plot.gate !== null && plot.xAxis && plot.yAxis,
    );
    const base = this.annotationsPassingNonGateFilters;
    if (
      !datasetId ||
      !(hasGate || this.analysisPanelOpen) ||
      // Matches the panel's refusal to plot: a gate is only meaningful against
      // the population it was drawn on, and above the cap we do not draw one.
      base.length > MAX_ANALYSIS_PLOT_POINTS
    ) {
      this.clearAnalysisDerivedState();
      return;
    }

    // "Nothing to FETCH" is not "nothing to DO". A gate on two categorical axes
    // needs no property values at all — categorical axes read annotation fields
    // — so bailing out here left such a gate drawn, persisted, and completely
    // inert: it plotted and lassoed normally and then filtered nothing.
    const paths = analysisPropertyPaths(plots);
    let values: IAnnotationPropertyValues = {};
    if (paths.length > 0) {
      this.setAnalysisLoading(true);
      const fetched = await fetchAnalysisValues(datasetId, paths, base);
      if (!analysisGateGuard.isCurrent(token)) {
        // A newer refresh owns the loading flag now; leave it alone.
        return;
      }
      if (fetched === null) {
        // The fetch FAILED. Leave the existing gate ids untouched rather than
        // resolving every property gate against an empty value map: that marks
        // each one resolved-with-zero-matches and hides every annotation in the
        // dataset after a transient network error.
        this.setAnalysisLoading(false);
        return;
      }
      values = fetched;
    }
    this.setAnalysisValues(values);
    this.setAnalysisGateIds(
      resolveAnalysisGateIds(plots, base, values, (channel) =>
        channelDisplayName(channel),
      ),
    );
    this.setAnalysisLoading(false);
  }

  @Action
  private clearAnalysisDerivedState() {
    if (this.analysisLoading) {
      this.setAnalysisLoading(false);
    }
    if (Object.keys(this.analysisGateIds).length > 0) {
      this.setAnalysisGateIds({});
    }
    if (Object.keys(this.analysisValues).length > 0) {
      this.setAnalysisValues({});
    }
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
      countEnabled(this.annotationIdFilters) +
      this.activeAnalysisGateCount
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
    // Claimed before the guards below, not after: a bail-out that left an
    // in-flight request current would let it commit ids for a filter the user
    // has since turned off. Same shape as refreshAnalysis above.
    const token = propertyFilterRequestGuard.next();
    const datasetId = main.dataset?.id;
    if (
      !datasetId ||
      !annotation.stubOnlyMode ||
      !this.hasActivePropertyFilter
    ) {
      this.setPropertyFilterPassingIds(null);
      return;
    }
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

  // Annotations passing every filter EXCEPT the analysis-plot gates. The
  // analysis panel plots populations from this base (plus upstream gates), so
  // a plot's own gate must not remove points from its own scatter.
  get annotationsPassingNonGateFilters() {
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

  get filteredAnnotations() {
    const gateSets = this.activeAnalysisGateSets;
    const base = this.annotationsPassingNonGateFilters;
    if (gateSets.length === 0) {
      return base;
    }
    return base.filter((annotation: TAnnotationOrStub) =>
      gateSets.every((gate) => gate.has(annotation.id)),
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

// Stale-response guard for the analysis gate refresh: filter edits can fire
// several refreshes in quick succession, and only the latest may commit.
const analysisGateGuard = createSequenceGuard();

function channelDisplayName(channel: number): string {
  return main.dataset?.channelNames.get(channel) ?? `Channel ${channel}`;
}

/**
 * Fetch the property values the analysis plots' axes need, for one population.
 * Returns null when the request fails — see the catch block.
 *
 * Projected to just those paths, which is what makes this affordable: the
 * shared `properties.propertyValues` map is projected to the Annotation
 * Browser's displayed columns (so an arbitrary axis is usually absent from it)
 * and, in lazy mode, holds only the viewport subset.
 */
async function fetchAnalysisValues(
  datasetId: string,
  paths: string[][],
  population: TAnnotationOrStub[],
): Promise<IAnnotationPropertyValues | null> {
  if (paths.length === 0 || population.length === 0) {
    return {};
  }
  try {
    const entries = await properties.propertiesAPI.getPropertyValuesForIds(
      datasetId,
      population.map((annotation) => annotation.id),
      paths,
    );
    const values: IAnnotationPropertyValues = {};
    for (const entry of entries) {
      values[entry.annotationId] = entry.values;
    }
    return values;
  } catch (error) {
    // null, NOT {}: an empty map is a legitimate response (a property computed
    // for no annotation yet), and conflating the two resolved every gate to
    // zero matches on a transient error. The caller leaves the gate alone.
    logError(`Analysis gate value fetch failed: ${(error as Error).message}`);
    return null;
  }
}

/**
 * Walk the plot chain and resolve each drawn gate's polygon into ids.
 *
 * Exported for tests: this is the whole of the gating semantics, and it is the
 * half that has no visible symptom when it breaks (a gate silently selects the
 * wrong objects rather than erroring).
 */
export function resolveAnalysisGateIds(
  plots: IAnalysisPlot[],
  base: TAnnotationOrStub[],
  values: IAnnotationPropertyValues,
  channelName: (channel: number) => string,
): { [plotId: string]: string[] } {
  const gateIds: { [plotId: string]: string[] } = {};
  for (let i = 0; i < plots.length; i++) {
    const plot = plots[i];
    if (!plot.xAxis || !plot.yAxis || plot.gate === null) {
      continue;
    }
    // Re-chain rather than threading a running population: plot i's input
    // depends only on gates 0..i-1, which are already resolved, so this walks
    // the SAME chainPlotInputs the panel displays. Keeping one implementation
    // is what stops the gate from selecting points other than the ones drawn
    // under it, and it is worth the cost — but the cost is not zero: this is
    // O(plots^2 x population), so ten chained plots over 50k objects is ~5M
    // filter operations per refresh. Revisit if plot counts ever grow.
    const input = chainPlotInputs(plots, gateIds, base)[i];
    const series = buildPlotSeries({
      annotations: input,
      values,
      xAxis: plot.xAxis,
      yAxis: plot.yAxis,
      channelName,
      xCategoryOrder: plot.gate.xCategories,
      yCategoryOrder: plot.gate.yCategories,
    });
    gateIds[plot.id] = resolveGateIds(series, plot.gate);
  }
  return gateIds;
}

// Self-accept HMR to prevent vuex-module-decorators from re-registering
// the dynamic module (which causes duplicate getters and state overwrites).
if (import.meta.hot) {
  import.meta.hot.accept();
}

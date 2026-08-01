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
import {
  buildListFilters,
  buildPropertyListFilters,
} from "@/utils/annotationListFilters";
import { createSequenceGuard } from "@/utils/sequenceGuard";
import { idListSignature } from "@/utils/signatures";

import {
  TAnnotationOrStub,
  IAnalysisGate,
  IAnalysisGatePlotRequest,
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
import {
  MAX_ANALYSIS_PLOT_POINTS,
  MAX_HISTOGRAM_ID_CONSTRAINT,
} from "./constants";
import {
  analysisCategoricalKeys,
  analysisPropertyPaths,
  buildPlotSeries,
  categoricalContentSignature,
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

  // Cache identity for analysisValues. A visibility change may widen or narrow
  // the requested property paths without changing the dataset, population, or
  // property revision; retaining the identity lets refreshAnalysis reuse a
  // cached superset rather than posting the same 50k ids again.
  analysisValuesSourceSignature: string | null = null;
  analysisValuePathKeys: string[] = markRaw([]);

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

  // The dataset/value inputs the enabled gate ids were resolved against. Plot
  // edits invalidate their affected suffix synchronously in the mutators; this
  // identity covers the other half of the dependency: the non-gate population
  // and the values/categories read from it.
  analysisGateDataSignature: string | null = null;

  // The corresponding input identity for every gate resolved while the panel
  // is visible, including disabled display-only gates. Kept separate from the
  // enabled-gate identity so merely opening the panel can invalidate stale
  // counts/highlights without temporarily dropping still-valid filters.
  analysisVisibleGateDataSignature: string | null = null;

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
    this.analysisValuesSourceSignature = null;
    this.analysisValuePathKeys = markRaw([]);
    this.analysisGateDataSignature = null;
    this.analysisVisibleGateDataSignature = null;
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
  // configuration save. Each mutator invalidates any affected derived gate ids
  // before entering this common persistence path.
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
    this.dropAnalysisGateIdsFromPlot({ id, includePlot: true });
    this.applyAnalysisPlots(
      this.analysisPlots.filter((plot) => plot.id !== id),
    );
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
    this.dropAnalysisGateIdsFromPlot({ id: payload.id, includePlot: true });
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
  }

  @Action
  setAnalysisPlotGate(payload: { id: string; gate: IAnalysisGate | null }) {
    // Drop the derived ids on EVERY change, not just on clear. Re-lassoing kept
    // the previous gate's ids active while the new polygon's request was in
    // flight — so the plot highlighted the new selection while the viewer and
    // the list still filtered by the old one — and if that request then failed
    // (refreshAnalysis deliberately leaves ids untouched on failure) the stale
    // constraint stuck permanently. Later plots are derived from the population
    // passing this gate, so their ids are stale too.
    this.dropAnalysisGateIdsFromPlot({ id: payload.id, includePlot: true });
    this.applyAnalysisPlots(
      this.analysisPlots.map((plot) =>
        plot.id === payload.id ? { ...plot, gate: payload.gate } : plot,
      ),
    );
  }

  @Action
  toggleAnalysisPlotGateEnabled(id: string) {
    // This plot's ids are still valid: enabling it changes whether they narrow
    // the population, not the population they were resolved against. Every
    // later plot was resolved against the old enable state and must be dropped.
    this.dropAnalysisGateIdsFromPlot({ id, includePlot: false });
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
    this.setAnalysisGateDataSignature(null);
    this.setAnalysisVisibleGateDataSignature(null);
  }

  /**
   * Reconcile live plots after the configuration's attached properties change.
   * Hydration already rejects unknown property axes, but property deletion used
   * to leave them (and their invisible gates) active until the next reload.
   *
   * This is plural because a batch property removal must update every affected
   * plot, invalidate the earliest dependent suffix, and persist once.
   */
  @Action
  reconcileAnalysisPlotsForPropertyIds(propertyIds: string[]) {
    const knownPropertyIds = new Set(propertyIds);
    let firstChangedPlotId: string | null = null;
    const nextPlots = this.analysisPlots.map((plot) => {
      const xAxis =
        plot.xAxis?.type === "property" &&
        !knownPropertyIds.has(plot.xAxis.path[0])
          ? null
          : plot.xAxis;
      const yAxis =
        plot.yAxis?.type === "property" &&
        !knownPropertyIds.has(plot.yAxis.path[0])
          ? null
          : plot.yAxis;
      if (xAxis === plot.xAxis && yAxis === plot.yAxis) {
        return plot;
      }
      firstChangedPlotId ??= plot.id;
      return { ...plot, xAxis, yAxis, gate: null };
    });
    if (firstChangedPlotId === null) {
      return;
    }
    this.dropAnalysisGateIdsFromPlot({
      id: firstChangedPlotId,
      includePlot: true,
    });
    this.applyAnalysisPlots(nextPlots);
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
  private dropAnalysisGateIdsFromPlot(payload: {
    id: string;
    includePlot: boolean;
  }) {
    const plotIndex = this.analysisPlots.findIndex(
      (plot) => plot.id === payload.id,
    );
    if (plotIndex < 0) {
      return;
    }
    const next = { ...this.analysisGateIds };
    let changed = false;
    for (const plot of this.analysisPlots.slice(
      plotIndex + (payload.includePlot ? 0 : 1),
    )) {
      if (next[plot.id] !== undefined) {
        delete next[plot.id];
        changed = true;
      }
    }
    if (changed) {
      // Unresolved contributes no constraint, so the interim shows MORE than
      // the final answer rather than filtering by a stale population.
      this.analysisGateIds = markRaw(next);
    }
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

  // A cheap identity for the gate constraints, same reasoning. Every id is
  // hashed, not just counted or sampled: moving a lasso to a different region
  // with the same number of objects has to register, or the server-mode list
  // keeps the previous gate's rows. Display-only plots are omitted because
  // they do not change the list query and must not schedule a server refetch.
  get analysisGateSignature(): string {
    return this.analysisPlots.reduce<string>((signature, plot) => {
      if (plot.gateEnabled && plot.gate !== null) {
        const ids = this.analysisGateIds[plot.id];
        if (ids !== undefined) {
          return `${signature}${signature ? "|" : ""}${
            plot.id
          }:${idListSignature(ids)}`;
        }
      }
      return signature;
    }, "");
  }

  // The exact identity for the population the analysis panel plots and gates
  // against. Above the plotting cap there is deliberately no exact identity:
  // analysisPopulation stops as soon as it proves the cap was crossed, so a
  // persisted gate on a 700k-object dataset does not hash or retain the rest of
  // that population just to decide that it cannot run.
  get analysisPopulationSignature(): string {
    const population = this.analysisPopulation;
    return population.length > MAX_ANALYSIS_PLOT_POINTS
      ? "over-cap"
      : populationSignature(population);
  }

  // What refreshAnalysis' result depends on.
  //
  // Membership alone is NOT enough. Editing an annotation's tags leaves the
  // population and its ids identical while moving that point to a different
  // column, so an id-only signature never re-ran the resolution: the panel
  // redrew the point under its new category while the gate kept filtering by
  // the old one. Property values have the same problem from the other side —
  // they live server-side, so a recompute changes nothing the client can diff.
  // Hence the content hash for the categorical axes in use, and the property
  // store's load revision for the property axes.
  get analysisInputSignature(): string {
    const { resolutionPlots, paths } = analysisRefreshScope(
      this.analysisPlots,
      this.analysisPanelOpen,
    );
    if (resolutionPlots.length === 0 && paths.length === 0) {
      // Nothing to fetch or resolve: don't even look at the population, so a
      // dataset nobody is analysing never pays for any of this.
      return "idle";
    }
    const base = this.analysisPopulation;
    if (base.length > MAX_ANALYSIS_PLOT_POINTS) {
      // Above the cap, resolution happens server-side against the whole
      // dataset (SERVER_GATING.md): the identity is the gate definitions
      // plus revision counters — never the population, which the bounded
      // walk above deliberately stopped collecting.
      const requestPlots = serverGateRequestPlots(resolutionPlots);
      return requestPlots.length === 0
        ? "server-idle"
        : serverGateInputSignature(main.dataset?.id ?? "", requestPlots);
    }
    return [
      // Ungated plots affect the store only through the property paths needed
      // to display them. Omitting the visibility boolean means opening a panel
      // whose gates already need the same paths does not trigger a duplicate
      // refresh; genuinely new display paths still change this identity.
      JSON.stringify(resolutionPlots),
      analysisPathKeys(paths).join(","),
      populationSignature(base),
      categoricalContentSignature(
        base,
        analysisCategoricalKeys(resolutionPlots),
      ),
      paths.length > 0 ? properties.propertyValuesRevision : "-",
    ].join("|");
  }

  // What the over-cap heatmaps can and cannot reflect (SERVER_GATING.md,
  // Phase 2). The serializable filters ride along in the histogram request;
  // filters the list schema cannot express — ROI polygons, the hidden-layer
  // rule, id lists past MAX_HISTOGRAM_ID_CONSTRAINT — are REPORTED in
  // `skipped` so the panel can say the distribution may over-include. The
  // direction is one-sided by construction: a skipped filter widens the
  // pictured population, never narrows it (id filters union, so one
  // oversized member drops the whole union). Gate RESOLUTION is
  // filter-independent and never degrades.
  get analysisHistogramFilterSpec(): {
    filters: IAnnotationListFilters;
    skipped: string[];
  } {
    const skipped: string[] = [];
    const selectionOversized =
      this.selectionFilter.enabled &&
      this.selectionFilter.annotationIds.length > MAX_HISTOGRAM_ID_CONSTRAINT;
    if (selectionOversized) {
      skipped.push("selection filter");
    }
    const idFiltersOversized = this.annotationIdFilters.some(
      (filter) =>
        filter.enabled &&
        filter.annotationIds.length > MAX_HISTOGRAM_ID_CONSTRAINT,
    );
    if (idFiltersOversized) {
      skipped.push("object-list filters");
    }
    const filters = buildListFilters({
      tagFilter: this.tagFilter,
      onlyCurrentFrame: this.onlyCurrentFrame,
      currentFrame: { XY: main.xy, Z: main.z, Time: main.time },
      idSubstring: "",
      propertyFilters: this.propertyFilters,
      selectionFilter: selectionOversized
        ? { ...this.selectionFilter, enabled: false }
        : this.selectionFilter,
      annotationIdFilters: idFiltersOversized ? [] : this.annotationIdFilters,
    });
    if (this.roiFilters.some((filter) => filter.enabled)) {
      skipped.push("region (ROI) filters");
    }
    if (!main.showAnnotationsFromHiddenLayers) {
      skipped.push("hidden-layer visibility");
    }
    return { filters, skipped };
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
  private setAnalysisValueCache(payload: {
    values: IAnnotationPropertyValues;
    sourceSignature: string;
    pathKeys: string[];
  }) {
    this.analysisValues = markRaw(payload.values);
    this.analysisValuesSourceSignature = payload.sourceSignature;
    this.analysisValuePathKeys = markRaw(payload.pathKeys);
  }

  @Mutation
  private clearAnalysisValueCache() {
    this.analysisValues = markRaw({});
    this.analysisValuesSourceSignature = null;
    this.analysisValuePathKeys = markRaw([]);
  }

  @Mutation
  private setAnalysisGateDataSignature(signature: string | null) {
    this.analysisGateDataSignature = signature;
  }

  @Mutation
  private setAnalysisVisibleGateDataSignature(signature: string | null) {
    this.analysisVisibleGateDataSignature = signature;
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
   * Hidden mode requests only paths belonging to gated plots. Visible mode may
   * widen that set for display-only plots; a cached superset for the same
   * dataset/population/revision is reused rather than fetched again.
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
    const panelOpen = this.analysisPanelOpen;
    const { gatedPlots, resolutionPlots, paths } = analysisRefreshScope(
      plots,
      panelOpen,
    );
    if (!datasetId || (resolutionPlots.length === 0 && paths.length === 0)) {
      this.clearAnalysisDerivedState();
      return;
    }
    const base = this.analysisPopulation;
    // Above the cap, gates resolve server-side as pure predicates over the
    // whole dataset (SERVER_GATING.md, Phase 1) — the cap bounds the client
    // work (plotting, hashing, value fetches), not the gating.
    if (base.length > MAX_ANALYSIS_PLOT_POINTS) {
      await this.refreshAnalysisAboveCap({
        token,
        datasetId,
        resolutionPlots,
      });
      return;
    }

    const population = populationSignature(base);
    const dataSignatureForPlots = (plotsToDescribe: IAnalysisPlot[]) =>
      plotsToDescribe.length > 0
        ? [
            datasetId,
            population,
            categoricalContentSignature(
              base,
              analysisCategoricalKeys(plotsToDescribe),
            ),
            analysisPropertyPaths(plotsToDescribe).length > 0
              ? properties.propertyValuesRevision
              : "-",
          ].join("|")
        : null;
    const gateDataSignature = dataSignatureForPlots(gatedPlots);
    const visibleGateDataSignature = panelOpen
      ? dataSignatureForPlots(resolutionPlots)
      : null;
    if (this.analysisGateDataSignature !== gateDataSignature) {
      // A fetch failure may retain ids only for an identical retry. When the
      // base population, categorical inputs, dataset, or property revision has
      // changed, every active gate was derived from obsolete data; drop every
      // id before awaiting because later gates depend on the enabled chain.
      if (Object.keys(this.analysisGateIds).length > 0) {
        this.setAnalysisGateIds({});
      }
      this.setAnalysisGateDataSignature(null);
      this.setAnalysisVisibleGateDataSignature(null);
    } else if (
      panelOpen &&
      this.analysisVisibleGateDataSignature !== visibleGateDataSignature
    ) {
      // Visible disabled gates have derived ids too, but they do not constrain
      // any later population. If only their input identity changed, preserve
      // the still-valid enabled constraints while making stale display-only
      // counts/highlights unresolved before a request that may fail.
      const activePlotIds = new Set(gatedPlots.map((plot) => plot.id));
      const activeGateIds = Object.fromEntries(
        Object.entries(this.analysisGateIds).filter(([plotId]) =>
          activePlotIds.has(plotId),
        ),
      );
      if (
        Object.keys(activeGateIds).length !==
        Object.keys(this.analysisGateIds).length
      ) {
        this.setAnalysisGateIds(activeGateIds);
      }
      this.setAnalysisVisibleGateDataSignature(null);
    } else if (!panelOpen && this.analysisVisibleGateDataSignature !== null) {
      this.setAnalysisVisibleGateDataSignature(null);
    }

    // "Nothing to FETCH" is not "nothing to DO". A gate on two categorical axes
    // needs no property values at all — categorical axes read annotation fields
    // — so bailing out here left such a gate drawn, persisted, and completely
    // inert: it plotted and lassoed normally and then filtered nothing.
    const valuesSourceSignature = [
      datasetId,
      population,
      properties.propertyValuesRevision,
    ].join("|");
    const pathKeys = analysisPathKeys(paths);
    const cachedPaths = new Set(this.analysisValuePathKeys);
    const cachedValuesMatchSource =
      this.analysisValuesSourceSignature === valuesSourceSignature;
    const canReuseValues =
      cachedValuesMatchSource &&
      pathKeys.every((path) => cachedPaths.has(path));
    const hasRetainedValuesForPlot = (plot: IAnalysisPlot) => {
      const plotPathKeys = analysisPathKeys(analysisPropertyPaths([plot]));
      return (
        plotPathKeys.length === 0 ||
        (cachedValuesMatchSource &&
          plotPathKeys.every((path) => cachedPaths.has(path)))
      );
    };
    const retainedResolutionPlots = resolutionPlots.filter(
      hasRetainedValuesForPlot,
    );
    const canResolveGatesFromRetainedValues =
      retainedResolutionPlots.length > 0 &&
      gatedPlots.every(hasRetainedValuesForPlot);
    const commitGateResolution = (
      plotsToResolve: IAnalysisPlot[],
      gateValues: IAnnotationPropertyValues,
    ) => {
      this.setAnalysisGateIds(
        resolveAnalysisGateIds(
          // Disabled gates are display-only. While hidden, omitting them avoids
          // resolving against the narrower value projection requested for the
          // enabled gates; opening the panel widens both paths and resolution.
          plotsToResolve,
          base,
          gateValues,
          (channel) => channelDisplayName(channel),
        ),
      );
      this.setAnalysisGateDataSignature(gateDataSignature);
      this.setAnalysisVisibleGateDataSignature(visibleGateDataSignature);
    };
    let values = canReuseValues ? this.analysisValues : {};
    if (!canReuseValues && paths.length > 0) {
      this.setAnalysisLoading(true);
      const fetched = await fetchAnalysisValues(datasetId, paths, base);
      if (!analysisGateGuard.isCurrent(token)) {
        // A newer refresh owns the loading flag now; leave it alone.
        return;
      }
      if (fetched === null) {
        // A display-only path can fail even though every value needed by the
        // gates is already retained (or the gates are categorical and need no
        // values). Resolve those gates instead of making their correctness
        // depend on an unrelated plot. Otherwise leave same-input ids intact;
        // changed-input ids were invalidated before the request above.
        if (canResolveGatesFromRetainedValues) {
          commitGateResolution(
            retainedResolutionPlots,
            cachedValuesMatchSource ? this.analysisValues : {},
          );
        }
        this.setAnalysisLoading(false);
        return;
      }
      values = fetched;
      this.setAnalysisValueCache({
        values,
        sourceSignature: valuesSourceSignature,
        pathKeys,
      });
    } else if (!canReuseValues) {
      // A categorical-only gate still needs a cache identity: on a later panel
      // open, display-only property paths can tell that no values were fetched
      // for them and widen the cache correctly.
      this.setAnalysisValueCache({
        values,
        sourceSignature: valuesSourceSignature,
        pathKeys,
      });
    }
    commitGateResolution(resolutionPlots, values);
    this.setAnalysisLoading(false);
  }

  /**
   * Over-cap half of refreshAnalysis: resolve drawn gates through the
   * gate_ids endpoint and commit the PURE id lists. The committed ids are
   * population-independent, so no filter change ever invalidates them —
   * only the inputs named by serverGateInputSignature do.
   *
   * `token` is the caller's already-claimed sequence token (claimed as the
   * first statement of refreshAnalysis, before any early return).
   */
  @Action
  private async refreshAnalysisAboveCap(payload: {
    token: number;
    datasetId: string;
    resolutionPlots: IAnalysisPlot[];
  }) {
    const { token, datasetId } = payload;
    const requestPlots = serverGateRequestPlots(payload.resolutionPlots);
    if (requestPlots.length === 0) {
      this.clearAnalysisDerivedState();
      return;
    }
    const serverSignature = serverGateInputSignature(datasetId, requestPlots);
    if (
      this.analysisGateDataSignature === serverSignature &&
      requestPlots.every((plot) => this.analysisGateIds[plot.id] !== undefined)
    ) {
      // Same inputs, everything resolved: palette toggles and unrelated
      // reactive touches must not refetch.
      return;
    }
    if (this.analysisGateDataSignature !== serverSignature) {
      // Changed inputs: every committed id was derived from obsolete data.
      // Drop BEFORE awaiting — a failure may retain ids only for an
      // identical retry, and unresolved shows MORE rather than stale.
      if (Object.keys(this.analysisGateIds).length > 0) {
        this.setAnalysisGateIds({});
      }
      this.setAnalysisGateDataSignature(null);
      this.setAnalysisVisibleGateDataSignature(null);
    }
    // The value cache serves the below-cap scatter; above the cap it pins up
    // to 50K values for nothing. It would self-invalidate by signature on
    // the way back down — clearing here just frees the memory sooner.
    if (
      this.analysisValuesSourceSignature !== null ||
      Object.keys(this.analysisValues).length > 0
    ) {
      this.clearAnalysisValueCache();
    }
    this.setAnalysisLoading(true);
    const gateIds = await main.annotationsAPI.fetchAnalysisGateIds(
      datasetId,
      requestPlots,
    );
    if (!analysisGateGuard.isCurrent(token)) {
      // A newer refresh owns the state (and the loading flag) now.
      return;
    }
    this.setAnalysisLoading(false);
    if (gateIds === null) {
      // Failure ≠ empty: same-input ids stayed in place above; changed-input
      // ids were dropped before the await. Either way, nothing to commit.
      return;
    }
    this.setAnalysisGateIds(gateIds);
    this.setAnalysisGateDataSignature(serverSignature);
  }

  @Action
  private clearAnalysisDerivedState() {
    if (this.analysisLoading) {
      this.setAnalysisLoading(false);
    }
    if (Object.keys(this.analysisGateIds).length > 0) {
      this.setAnalysisGateIds({});
    }
    if (this.analysisGateDataSignature !== null) {
      this.setAnalysisGateDataSignature(null);
    }
    if (this.analysisVisibleGateDataSignature !== null) {
      this.setAnalysisVisibleGateDataSignature(null);
    }
    if (
      this.analysisValuesSourceSignature !== null ||
      Object.keys(this.analysisValues).length > 0
    ) {
      this.clearAnalysisValueCache();
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
    return collectAnnotationsPassingNonGateFilters(this);
  }

  // The same population, but stop after cap + 1. At or below the cap this is
  // the complete population; above it the extra row is only an overflow bit.
  // Analysis rendering, hashing, fetching, and gate resolution must all use
  // this bounded view so the cap prevents the expensive work it promises to.
  get analysisPopulation() {
    return collectAnnotationsPassingNonGateFilters(
      this,
      MAX_ANALYSIS_PLOT_POINTS + 1,
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

/**
 * Apply every non-analysis filter, optionally stopping after enough matches to
 * prove an upper bound was crossed. Keeping the predicate here gives the full
 * viewer population and the bounded analysis population identical semantics;
 * only the amount collected differs.
 */
function collectAnnotationsPassingNonGateFilters(
  filters: Filters,
  limit = Number.POSITIVE_INFINITY,
): TAnnotationOrStub[] {
  const selectionFilter = filters.selectionFilter;
  const tagFilter = filters.tagFilter;
  const enabledPropertyFilters = filters.propertyFilters.filter(
    (filter: IPropertyAnnotationFilter) => filter.enabled,
  );
  const enabledRoiFilters = filters.roiFilters.filter(
    (filter: IROIAnnotationFilter) => filter.enabled,
  );
  const onlyCurrentFrame = filters.onlyCurrentFrame;
  // Read frame state only when the filter uses it. Previously these
  // unconditional reads made every frame scrub rebuild a whole-dataset
  // population even while the current-frame filter was off.
  const currentFrameLocation: IAnnotationLocation | null = onlyCurrentFrame
    ? { XY: main.xy, Z: main.z, Time: main.time }
    : null;
  const enabledAnnotationIdFilters = filters.annotationIdFilters.filter(
    (filter: IIdAnnotationFilter) => filter.enabled,
  );
  const centroidsById = annotation.annotationCentroids;
  // In lazy mode the full property-value map is not loaded, so property
  // filtering is driven by a server-fetched id set (D Stage 2) instead of
  // reading each annotation's value client-side.
  const useServerPropertyFilter =
    annotation.stubOnlyMode && enabledPropertyFilters.length > 0;
  const serverPassingIds = filters.propertyFilterPassingIds;
  const passing: TAnnotationOrStub[] = [];

  for (const candidate of annotation.annotationsForIteration) {
    if (
      currentFrameLocation !== null &&
      (candidate.location.XY !== currentFrameLocation.XY ||
        candidate.location.Z !== currentFrameLocation.Z ||
        candidate.location.Time !== currentFrameLocation.Time)
    ) {
      continue;
    }
    if (
      selectionFilter.enabled &&
      !selectionFilter.annotationIds.includes(candidate.id)
    ) {
      continue;
    }
    if (
      tagFilter.enabled &&
      !tagCloudFilterFunction(
        candidate.tags,
        tagFilter.tags,
        tagFilter.exclusive,
      )
    ) {
      continue;
    }

    if (enabledPropertyFilters.length > 0) {
      if (useServerPropertyFilter) {
        // Until the server result loads (null), pass all so drawing does not
        // flash empty.
        if (serverPassingIds !== null && !serverPassingIds.has(candidate.id)) {
          continue;
        }
      } else {
        const propertyValues = properties.propertyValues[candidate.id] || {};
        const matchesProperties = enabledPropertyFilters.every((filter) => {
          const value = getValueFromObjectAndPath(
            propertyValues,
            filter.propertyPath,
          );
          if (filter.valuesOrRange === "values") {
            // If no values are specified, this row does not narrow anything.
            return (
              !filter.values ||
              filter.values.length === 0 ||
              (typeof value === "number" && filter.values.includes(value))
            );
          }
          return (
            typeof value === "number" &&
            value >= filter.range.min &&
            value <= filter.range.max
          );
        });
        if (!matchesProperties) {
          continue;
        }
      }
    }

    if (
      enabledAnnotationIdFilters.length > 0 &&
      !enabledAnnotationIdFilters.some((filter) =>
        filter.annotationIds.includes(candidate.id),
      )
    ) {
      continue;
    }

    // Do not build geometry test points when no ROI filter exists. Besides
    // saving work on the common path, this keeps the cap walk proportional to
    // the filters that are actually active.
    if (enabledRoiFilters.length > 0) {
      const roiTestPoints = annotationTestPoints(
        candidate,
        centroidsById[candidate.id],
      );
      const isInROI = enabledRoiFilters.some((filter) =>
        roiTestPoints.some((point: IGeoJSPosition) =>
          geo.util.pointInPolygon(point, filter.roi),
        ),
      );
      if (!isInROI) {
        continue;
      }
    }

    passing.push(candidate);
    if (passing.length >= limit) {
      break;
    }
  }
  return passing;
}

function analysisRefreshScope(plots: IAnalysisPlot[], panelOpen: boolean) {
  const readyPlots = plots.filter(
    (plot) => plot.xAxis !== null && plot.yAxis !== null,
  );
  const drawnPlots = readyPlots.filter((plot) => plot.gate !== null);
  // A disabled gate is display-only until it is re-enabled. While hidden it
  // must cost the same as an ungated plot; opening the panel widens `paths` to
  // every ready plot, and re-enabling makes it active here again.
  const gatedPlots = drawnPlots.filter((plot) => plot.gateEnabled);
  return {
    gatedPlots,
    // A visible disabled gate still shows a resolved count/highlight, so its
    // polygon and categorical inputs must wake the same action that resolves
    // it. Hidden mode retains the enabled-only cost boundary.
    resolutionPlots: panelOpen ? drawnPlots : gatedPlots,
    paths: analysisPropertyPaths(panelOpen ? readyPlots : gatedPlots),
  };
}

function analysisPathKeys(paths: string[][]): string[] {
  return paths.map((path) => createPathStringFromPathArray(path)).sort();
}

/** The drawn plots of `plots`, shaped for the server gate_ids request. */
function serverGateRequestPlots(
  plots: IAnalysisPlot[],
): IAnalysisGatePlotRequest[] {
  return plots.reduce<IAnalysisGatePlotRequest[]>((request, plot) => {
    if (plot.xAxis !== null && plot.yAxis !== null && plot.gate !== null) {
      request.push({
        id: plot.id,
        xAxis: plot.xAxis,
        yAxis: plot.yAxis,
        gate: plot.gate,
      });
    }
    return request;
  }, []);
}

/**
 * Identity of everything server-side gate resolution depends on
 * (SERVER_GATING.md, Phase 1): the gate definitions plus the two revision
 * counters standing in for population content. Deliberately NO population
 * hash and no filter state — the pure predicate depends on neither, which is
 * what keeps the over-cap signature O(plots) instead of O(population) and
 * spares the invalidation matrix that population-derived gate ids need.
 * Serializing the definitions is fine here: vertices are bounded by the
 * lasso (hundreds), unlike the id lists signatures.ts exists to avoid.
 */
function serverGateInputSignature(
  datasetId: string,
  requestPlots: IAnalysisGatePlotRequest[],
): string {
  return [
    "server",
    datasetId,
    JSON.stringify(requestPlots),
    properties.propertyValuesRevision,
    annotation.contentRevision,
  ].join("|");
}

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

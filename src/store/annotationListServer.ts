import {
  getModule,
  Action,
  Module,
  Mutation,
  VuexModule,
} from "vuex-module-decorators";
import store from "./root";
import { markRaw } from "vue";

import main from "./index";
import filters from "./filters";
import properties from "./properties";
import {
  IAnnotationListRow,
  IAnnotationListSort,
  IAnnotationListFilters,
} from "./model";
import {
  buildListFilters,
  filtersMatchNothing,
} from "@/utils/annotationListFilters";
import { createSequenceGuard } from "@/utils/sequenceGuard";
import { MAX_HISTOGRAM_ID_CONSTRAINT } from "./constants";
import { idListSignature } from "@/utils/signatures";
import { logError } from "@/utils/log";
import { annotationRasterSelectorsForLayers } from "@/utils/annotationOverview";

// Monotonic stale-response guard: only the latest fetchPage may apply its
// result. Debounce reduces overlap but doesn't eliminate it (e.g. immediate
// pagination racing a trailing debounced filter fetch, or a fast page-1
// returning after a slow filtered request). Module-level (not Vuex state) since
// it is an internal token never read by the UI.
const pageRequestGuard = createSequenceGuard();
// Navigation has its own guard so a later hover can cancel an in-flight
// anchor lookup without interfering with an unrelated page request's loading
// cleanup. Every ordinary page fetch also invalidates pending navigation.
const navigationRequestGuard = createSequenceGuard();
// Resolved gate ids the overview filter carries inline rather than as gate
// definitions (see overviewFilters). The histogram's inline id cap.
const MAX_OVERVIEW_INLINE_GATE_IDS = MAX_HISTOGRAM_ID_CONSTRAINT;
// Only the latest overview-filter registration may apply its key.
const overviewFilterGuard = createSequenceGuard();

// buildListFilters moved to @/utils/annotationListFilters so the filters
// store can reuse it (importing it from here would be circular — this module
// imports the filters store). Re-exported for existing import sites.
export { buildListFilters } from "@/utils/annotationListFilters";

@Module({ dynamic: true, store, name: "annotationListServer" })
export class AnnotationListServer extends VuexModule {
  rows: IAnnotationListRow[] = markRaw([]);
  total = 0;
  loading = false;
  page = 1; // 1-based (Vuetify)
  // Matches the client list's default and Vuetify's default page size, so the
  // server table also shows 10 rows per page by default (the footer reflects
  // this via the :items-per-page binding).
  pageSize = 10;
  sort: IAnnotationListSort | null = null;
  idSubstring = "";
  // The overview raster's registered filter (null: draw every object) and
  // the overviewFiltersSignature it was registered for.
  overviewFilterKey: string | null = null;
  overviewFilterSignature: string | null = null;

  @Mutation
  setOverviewFilter(payload: { key: string | null; signature: string | null }) {
    this.overviewFilterKey = payload.key;
    this.overviewFilterSignature = payload.signature;
  }

  @Mutation
  setPageResult(payload: { rows: IAnnotationListRow[]; total: number }) {
    this.rows = markRaw(payload.rows);
    this.total = payload.total;
  }

  @Mutation
  setLoading(value: boolean) {
    this.loading = value;
  }

  @Mutation
  setOptions(payload: {
    page?: number;
    pageSize?: number;
    sort?: IAnnotationListSort | null;
  }) {
    if (payload.page !== undefined) {
      this.page = payload.page;
    }
    if (payload.pageSize !== undefined) {
      this.pageSize = payload.pageSize;
    }
    if (payload.sort !== undefined) {
      this.sort = payload.sort;
    }
  }

  @Mutation
  setIdSubstring(value: string) {
    this.idSubstring = value;
  }

  get currentFilters(): IAnnotationListFilters {
    return buildListFilters({
      tagFilter: filters.tagFilter,
      onlyCurrentFrame: filters.onlyCurrentFrame,
      // Read frame state only when the filter uses it — the twin of the same
      // rule in analysisHistogramFilterSpec and
      // collectAnnotationsPassingNonGateFilters. Unconditionally, this getter
      // depended on xy/z/time even when they are discarded, so every frame
      // scrub re-ran buildListFilters and rebuilt enabledIdFilters' flatMap
      // into a fresh array, missing idListSignature's identity-keyed memo and
      // re-hashing up to 50,000 ids for a signature that cannot have changed.
      currentFrame: filters.onlyCurrentFrame
        ? { XY: main.xy, Z: main.z, Time: main.time }
        : { XY: 0, Z: 0, Time: 0 },
      idSubstring: this.idSubstring,
      propertyFilters: filters.propertyFilters,
      selectionFilter: filters.selectionFilter,
      annotationIdFilters: filters.annotationIdFilters,
      analysisGateDefinitions: filters.activeAnalysisGateDefinitions,
      analysisGatesMatchNothing: filters.hasEmptyResolvedGate,
    });
  }

  /**
   * The filters the overview raster applies: what the viewer shows, i.e. the
   * server-list query WITHOUT the Objects tab's id search (that narrows the
   * list, not the image). Region (ROI) filters are not expressible
   * server-side, so under one the overview can over-include — the same
   * limitation as the server list.
   */
  get overviewFilters(): IAnnotationListFilters {
    // Gates the client has already resolved travel as their ids when small
    // enough: each is its own id set, exactly how the server applies a gate
    // (AND per gate), so the overview needs only an id lookup instead of
    // re-resolving the polygon over the whole dataset — seconds at 700K,
    // right after the gate_ids request did the same work. Larger gates go as
    // definitions.
    const gateIdLists = filters.activeAnalysisGateIdLists.filter(
      (ids) => ids.length > 0,
    );
    const inlineGates =
      gateIdLists.reduce((total, ids) => total + ids.length, 0) <=
      MAX_OVERVIEW_INLINE_GATE_IDS;
    // The overview's tiles are already per frame (its selectors), so the
    // current-frame filter only narrows it when some drawn layer is not
    // pinned to the current frame (a max-merge or offset layer). Otherwise
    // leaving the location out keeps the key valid across frame changes — a
    // key carrying the old frame would draw the new frame blank until a
    // re-registration, and force a whole-dataset rebuild server-side.
    const onlyCurrentFrame =
      filters.onlyCurrentFrame && !this.overviewSelectorsPinCurrentFrame;
    const built = buildListFilters({
      tagFilter: filters.tagFilter,
      onlyCurrentFrame,
      currentFrame: onlyCurrentFrame
        ? { XY: main.xy, Z: main.z, Time: main.time }
        : { XY: 0, Z: 0, Time: 0 },
      idSubstring: "",
      propertyFilters: filters.propertyFilters,
      selectionFilter: filters.selectionFilter,
      annotationIdFilters: filters.annotationIdFilters,
      analysisGateDefinitions: inlineGates
        ? []
        : filters.activeAnalysisGateDefinitions,
      analysisGatesMatchNothing: filters.hasEmptyResolvedGate,
    });
    if (inlineGates && gateIdLists.length > 0) {
      built.idConstraints = [...(built.idConstraints ?? []), ...gateIdLists];
    }
    return built;
  }

  // True when every layer the overview draws selects exactly the current
  // frame, so the raster selectors alone already restrict it to what the
  // current-frame filter would. A max-merge dimension (the selector omits it)
  // or an offset/constant slice (a different index) does not.
  get overviewSelectorsPinCurrentFrame(): boolean {
    return annotationRasterSelectorsForLayers({
      layers: main.layers,
      showHiddenLayers: main.showAnnotationsFromHiddenLayers,
      layerSliceIndexes: main.layerSliceIndexes,
    }).every(
      (selector) =>
        selector.XY === main.xy &&
        selector.Z === main.z &&
        selector.Time === main.time,
    );
  }

  // Identity of the overview's query, including what its gates currently
  // resolve to (so a recompute that moves a fixed gate's membership still
  // refreshes the tiles) and the dataset (a key belongs to one dataset).
  get overviewFiltersSignature(): string {
    const { idConstraints, ...rest } = this.overviewFilters;
    const constraints = (idConstraints ?? []).map(idListSignature).join(",");
    return `${main.dataset?.id ?? ""}|${JSON.stringify(rest)}|${constraints}|${
      filters.analysisGateSignature
    }`;
  }

  /**
   * The registered filter the overview's tiles should carry, or null to draw
   * unfiltered. Only while the committed key still describes the viewer's
   * current filters: while a new registration is pending (or after a dataset
   * switch, whose first tiles would 404 on the old dataset's key), drawing
   * unfiltered beats drawing the previous filters' passing set.
   *
   * `version` is the tiles' cache identity. The server caches a key's
   * passing ids per (dataset, raster version, key, version), and the raster
   * version only moves on annotation writes — so under a property filter the
   * version also carries propertyValuesRevision, which moves when values are
   * recomputed or imported (not on a viewport pan), or the overview would
   * keep the pre-recompute passing set. Gates need no revision: a recompute
   * that moves their membership moves analysisGateSignature, which is in the
   * signature.
   */
  get activeOverviewFilter(): { key: string; version: string } | null {
    const key = this.overviewFilterKey;
    const signature = this.overviewFilterSignature;
    if (key === null || signature !== this.overviewFiltersSignature) {
      return null;
    }
    const revision = this.overviewFilters.propertyFilters?.length
      ? `|${properties.propertyValuesRevision}`
      : "";
    return { key, version: `${signature}${revision}` };
  }

  /**
   * Register the overview's filters when they changed (ImageViewer triggers
   * this while the overview is on). No active filter: no key, every object
   * is drawn. A failed registration clears the key and the signature, so the
   * next change retries; meanwhile the overview draws every object.
   */
  @Action
  async refreshOverviewFilter(): Promise<void> {
    // Claimed before every early return, including the unchanged-filters one:
    // after A (committed) -> B (registering) -> back to A, this call returns
    // early, and B's late answer must not then commit B's key over A.
    const token = overviewFilterGuard.next();
    const signature = this.overviewFiltersSignature;
    if (signature === this.overviewFilterSignature) {
      return;
    }
    const datasetId = main.dataset?.id;
    const overviewFilters = this.overviewFilters;
    if (!datasetId || Object.keys(overviewFilters).length === 0) {
      this.setOverviewFilter({ key: null, signature });
      return;
    }
    try {
      const key = await main.annotationsAPI.registerRasterFilter(
        datasetId,
        overviewFilters,
      );
      if (overviewFilterGuard.isCurrent(token)) {
        this.setOverviewFilter({ key, signature });
      }
    } catch (error) {
      logError("Failed to apply the filters to the overview:", error);
      if (overviewFilterGuard.isCurrent(token)) {
        this.setOverviewFilter({ key: null, signature: null });
      }
    }
  }

  // A cheap identity for `currentFilters`, for watchers that need to react when
  // the query changes. Never serialize `currentFilters` itself — see
  // @/utils/signatures for why. Gate DEFINITIONS are small (a lasso's worth
  // of vertices) and serialize fine, but the ROWS a fixed definition matches
  // can change when values are recomputed or annotations edited — the
  // resolved-id hash appended here is what moves then.
  get currentFiltersSignature(): string {
    const { idConstraints, ...rest } = this.currentFilters;
    const constraints = (idConstraints ?? []).map(idListSignature).join(",");
    return `${JSON.stringify(rest)}|${constraints}|${
      filters.analysisGateSignature
    }`;
  }

  /**
   * True when the current query cannot match anything — see
   * `filtersMatchNothing`. The short-circuit itself lives in the API client so
   * every caller is covered; this getter exists for the UI and for the actions
   * below, which still skip their loading churn when there is nothing to ask.
   */
  get queryMatchesNothing(): boolean {
    return filtersMatchNothing(this.currentFilters);
  }

  // The query fields shared by every list fetch; each action adds its own
  // offset (and anchorId for navigation) plus the datasetId it guarded on.
  get listQueryBase() {
    return {
      filters: this.currentFilters,
      sort: this.sort,
      propertyPaths: properties.displayedPropertyPaths,
      limit: this.pageSize,
    };
  }

  @Action
  async fetchPage() {
    const datasetId = main.dataset?.id;
    if (!datasetId) {
      return;
    }
    navigationRequestGuard.next();
    const token = pageRequestGuard.next();
    if (this.queryMatchesNothing) {
      this.setPageResult({ rows: [], total: 0 });
      this.setLoading(false);
      return;
    }
    this.setLoading(true);
    try {
      const page = await main.annotationsAPI.fetchAnnotationListPage({
        datasetId,
        ...this.listQueryBase,
        offset: (this.page - 1) * this.pageSize,
      });
      // Drop the result if a newer fetchPage started while we were awaiting.
      if (pageRequestGuard.isCurrent(token)) {
        this.setPageResult(page);
      }
    } finally {
      if (pageRequestGuard.isCurrent(token)) {
        this.setLoading(false);
      }
    }
  }

  @Action
  cancelPendingNavigation() {
    navigationRequestGuard.next();
  }

  @Action
  async fetchPageContaining(annotationId: string): Promise<boolean> {
    const datasetId = main.dataset?.id;
    if (!datasetId) {
      return false;
    }
    const navigationToken = navigationRequestGuard.next();
    const pageToken = pageRequestGuard.next();
    if (this.queryMatchesNothing) {
      // Nothing matches, so no row can be navigated to.
      this.setPageResult({ rows: [], total: 0 });
      this.setLoading(false);
      return false;
    }
    this.setLoading(true);
    try {
      const page = await main.annotationsAPI.fetchAnnotationListPage({
        datasetId,
        ...this.listQueryBase,
        offset: 0,
        anchorId: annotationId,
      });
      if (
        !navigationRequestGuard.isCurrent(navigationToken) ||
        !pageRequestGuard.isCurrent(pageToken) ||
        page.offset === null ||
        page.offset === undefined
      ) {
        return false;
      }
      this.setOptions({ page: Math.floor(page.offset / this.pageSize) + 1 });
      this.setPageResult(page);
      return true;
    } finally {
      // A hover cancellation alone must still clear this request's loading
      // state. A newer page request owns loading when the page token changed.
      if (pageRequestGuard.isCurrent(pageToken)) {
        this.setLoading(false);
      }
    }
  }

  @Action
  async fetchMatchingIds(): Promise<string[]> {
    const datasetId = main.dataset?.id;
    if (!datasetId) {
      return [];
    }
    return main.annotationsAPI.fetchAnnotationListIds(
      datasetId,
      this.currentFilters,
    );
  }
}

export default getModule(AnnotationListServer);

// Self-accept HMR to prevent vuex-module-decorators from re-registering
// the dynamic module (which causes duplicate getters and state overwrites).
if (import.meta.hot) {
  import.meta.hot.accept();
}

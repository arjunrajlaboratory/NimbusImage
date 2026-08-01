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
import { idListSignature } from "@/utils/signatures";

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
      currentFrame: { XY: main.xy, Z: main.z, Time: main.time },
      idSubstring: this.idSubstring,
      propertyFilters: filters.propertyFilters,
      selectionFilter: filters.selectionFilter,
      annotationIdFilters: filters.annotationIdFilters,
      analysisGates: filters.activeAnalysisGateIdLists,
    });
  }

  // A cheap identity for `currentFilters`, for watchers that need to react when
  // the query changes. Never serialize `currentFilters` itself — see
  // @/utils/signatures for why.
  get currentFiltersSignature(): string {
    const { idConstraints, ...rest } = this.currentFilters;
    const constraints = (idConstraints ?? []).map(idListSignature).join(",");
    return `${JSON.stringify(rest)}|${constraints}`;
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

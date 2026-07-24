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
  ITagAnnotationFilter,
  IIdAnnotationFilter,
  IAnnotationLocation,
} from "./model";
import {
  IListPropertyFilterInput,
  buildPropertyListFilters,
} from "@/utils/annotationListFilters";
import { createSequenceGuard } from "@/utils/sequenceGuard";

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

// Pure: translate the client filter store into backend list filters.
export function buildListFilters(input: {
  tagFilter: Pick<ITagAnnotationFilter, "enabled" | "exclusive" | "tags">;
  onlyCurrentFrame: boolean;
  currentFrame: IAnnotationLocation;
  idSubstring: string;
  propertyFilters: IListPropertyFilterInput[];
  selectionFilter: IIdAnnotationFilter;
  annotationIdFilters: IIdAnnotationFilter[];
}): IAnnotationListFilters {
  const out: IAnnotationListFilters = {};
  if (input.tagFilter.enabled && input.tagFilter.tags.length > 0) {
    out.tags = {
      values: input.tagFilter.tags,
      exclusive: input.tagFilter.exclusive,
    };
  }
  if (input.onlyCurrentFrame) {
    out.location = { ...input.currentFrame };
  }
  if (input.idSubstring) {
    out.idSubstring = input.idSubstring;
  }
  // Build the id constraints (AND of membership sets), mirroring the
  // client filteredAnnotations semantics: the selection filter is one set,
  // and the enabled annotation-id filters are unioned into a second set.
  const idConstraints: string[][] = [];
  if (
    input.selectionFilter.enabled &&
    input.selectionFilter.annotationIds.length > 0
  ) {
    idConstraints.push(input.selectionFilter.annotationIds);
  }
  const enabledIdFilters = input.annotationIdFilters.filter((f) => f.enabled);
  if (enabledIdFilters.length > 0) {
    idConstraints.push(enabledIdFilters.flatMap((f) => f.annotationIds));
  }
  if (idConstraints.length > 0) {
    out.idConstraints = idConstraints;
  }
  const pfs = buildPropertyListFilters(input.propertyFilters);
  if (pfs.length > 0) {
    out.propertyFilters = pfs;
  }
  return out;
}

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
    });
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

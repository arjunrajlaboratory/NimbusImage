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
  IAnnotationListPropertyFilter,
  ITagAnnotationFilter,
  IIdAnnotationFilter,
  IAnnotationLocation,
} from "./model";

// The subset of an IPropertyAnnotationFilter that buildListFilters reads.
// valuesOrRange accepts the PropertyFilterMode enum or its string literals so
// callers (the filters store) and tests can pass either form.
interface IListPropertyFilterInput {
  propertyPath: string[];
  valuesOrRange: "values" | "range";
  range: { min: number; max: number };
  values?: number[];
  enabled?: boolean;
}

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
  const pfs: IAnnotationListPropertyFilter[] = input.propertyFilters
    .filter((f) => f.enabled !== false)
    .map((f) =>
      f.valuesOrRange === "values"
        ? {
            path: f.propertyPath,
            mode: "values" as const,
            values: f.values,
          }
        : {
            path: f.propertyPath,
            mode: "range" as const,
            min: f.range.min,
            max: f.range.max,
          },
    );
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
  pageSize = 50;
  sort: IAnnotationListSort | null = null;
  idSubstring = "";
  // Monotonic token guarding against out-of-order responses: only the latest
  // fetchPage may apply its result. Debounce reduces overlap but doesn't
  // eliminate it (e.g. immediate pagination racing a trailing debounced filter
  // fetch, or a fast page-1 returning after a slow filtered request).
  requestSeq = 0;

  @Mutation
  incrementRequestSeq() {
    this.requestSeq += 1;
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
      currentFrame: { XY: main.xy, Z: main.z, Time: main.time },
      idSubstring: this.idSubstring,
      propertyFilters: filters.propertyFilters,
      selectionFilter: filters.selectionFilter,
      annotationIdFilters: filters.annotationIdFilters,
    });
  }

  @Action
  async fetchPage() {
    const datasetId = main.dataset?.id;
    if (!datasetId) {
      return;
    }
    this.incrementRequestSeq();
    const seq = this.requestSeq;
    this.setLoading(true);
    try {
      const page = await main.annotationsAPI.fetchAnnotationListPage({
        datasetId,
        filters: this.currentFilters,
        sort: this.sort,
        propertyPaths: properties.displayedPropertyPaths,
        offset: (this.page - 1) * this.pageSize,
        limit: this.pageSize,
      });
      // Drop the result if a newer fetchPage started while we were awaiting.
      if (seq === this.requestSeq) {
        this.setPageResult(page);
      }
    } finally {
      if (seq === this.requestSeq) {
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

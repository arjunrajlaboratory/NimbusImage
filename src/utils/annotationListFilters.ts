import {
  IAnalysisGateFilterTerm,
  IAnnotationListFilters,
  IAnnotationListPropertyFilter,
  IAnnotationListSort,
  IAnnotationLocation,
  IIdAnnotationFilter,
  ITagAnnotationFilter,
} from "@/store/model";

// Structural equality for two list sorts (or nulls). Compares type, order, and
// key element-wise (key may be a string field name or a string[] property
// path). Used instead of JSON.stringify, which is key-order-sensitive and
// would treat a string key and a single-element array key as different shapes
// only by luck of serialization.
export function sortsEqual(
  a: IAnnotationListSort | null,
  b: IAnnotationListSort | null,
): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  if (a.type !== b.type || a.order !== b.order) {
    return false;
  }
  const aKey = a.key;
  const bKey = b.key;
  if (Array.isArray(aKey) || Array.isArray(bKey)) {
    if (!Array.isArray(aKey) || !Array.isArray(bKey)) {
      return false;
    }
    return (
      aKey.length === bKey.length && aKey.every((part, i) => part === bKey[i])
    );
  }
  return aKey === bKey;
}

// The subset of an IPropertyAnnotationFilter that the list-filter builders read.
// valuesOrRange accepts the PropertyFilterMode enum or its string literals so
// callers (the filters store) and tests can pass either form.
export interface IListPropertyFilterInput {
  propertyPath: string[];
  valuesOrRange: "values" | "range";
  range: { min: number; max: number };
  values?: number[];
  enabled?: boolean;
}

// Pure: translate client property filters into backend list property filters.
// Drops filters explicitly disabled (enabled === false); a filter with enabled
// left undefined is treated as active (matches buildListFilters semantics).
export function buildPropertyListFilters(
  propertyFilters: IListPropertyFilterInput[],
): IAnnotationListPropertyFilter[] {
  return propertyFilters
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
}

/**
 * True when these filters cannot match anything, so no request should be sent.
 *
 * An id-membership constraint that is present but EMPTY — an analysis gate
 * resolved to zero annotations, i.e. a lasso over empty space — is a real
 * constraint meaning "nothing". The list API deliberately rejects `[[]]` with a
 * 400 (`server/helpers/validation.py` wants match-none explicit rather than an
 * accidental `$in: []`), so sending it fails the request and leaves whatever
 * was on screen before.
 *
 * Lives here, and is applied in the API client rather than in each store
 * action, because the first fix guarded the two page fetches and missed
 * `fetchMatchingIds` — the action behind "Select all" and "Delete Unselected".
 * At the request boundary there is nothing left to miss.
 */
export function filtersMatchNothing(filters: {
  idConstraints?: string[][];
}): boolean {
  return (filters.idConstraints ?? []).some((ids) => ids.length === 0);
}

// Pure: translate the client filter store into backend list filters. Shared
// by the server-list query builder (annotationListServer.currentFilters) and
// the over-cap analysis histogram requests (filters store) — one
// serialization, so the two cannot drift.
export function buildListFilters(input: {
  tagFilter: Pick<ITagAnnotationFilter, "enabled" | "exclusive" | "tags">;
  onlyCurrentFrame: boolean;
  currentFrame: IAnnotationLocation;
  idSubstring: string;
  propertyFilters: IListPropertyFilterInput[];
  selectionFilter: IIdAnnotationFilter;
  annotationIdFilters: IIdAnnotationFilter[];
  // Active analysis gates as DEFINITIONS, resolved server-side per request
  // (SERVER_GATING.md, Phase 3) — id lists no longer ride on page fetches.
  analysisGateDefinitions?: IAnalysisGateFilterTerm[];
  // True when some active gate is known to match nothing. Expressed as an
  // empty idConstraints entry, which the AnnotationsAPI boundary answers
  // locally (filtersMatchNothing) — the wire never sees it, and no second
  // short-circuit path exists to miss.
  analysisGatesMatchNothing?: boolean;
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
  if (input.analysisGatesMatchNothing) {
    idConstraints.push([]);
  }
  if (idConstraints.length > 0) {
    out.idConstraints = idConstraints;
  }
  // Gates compose with AND (sequential gating), each as its own term —
  // unlike the annotation-id filters, which are unioned above.
  if (
    input.analysisGateDefinitions &&
    input.analysisGateDefinitions.length > 0
  ) {
    out.analysisGates = input.analysisGateDefinitions;
  }
  const pfs = buildPropertyListFilters(input.propertyFilters);
  if (pfs.length > 0) {
    out.propertyFilters = pfs;
  }
  return out;
}

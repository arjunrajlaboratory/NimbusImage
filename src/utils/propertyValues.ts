import type {
  IAnnotationProperty,
  IAnnotationPropertyValues,
  TPropertyValue,
  TPropertyHistogram,
} from "@/store/model";
import { createPathStringFromPathArray } from "@/utils/paths";

export interface IUncomputedCountRequestEntry {
  id: string;
  shape: string;
  tags: { tags: string[]; exclusive: boolean };
}

type TValuesObject = IAnnotationPropertyValues[string];

function valueAtPath(
  values: TValuesObject,
  path: string[],
): TPropertyValue | undefined {
  let current: TPropertyValue | undefined = values;
  for (const key of path) {
    // Arrays are leaves (Finding 12): collectLeafPaths stops at an array, so a
    // path that descends INTO one by index is not a real path — treat it as
    // missing rather than reading arr["0"]. Keeps both functions' "what is a
    // leaf" definition in sync.
    if (
      current === null ||
      typeof current !== "object" ||
      Array.isArray(current)
    ) {
      return undefined;
    }
    current = (current as Record<string, TPropertyValue>)[key];
  }
  return current;
}

/**
 * Union of leaf property paths across a set of per-annotation `values` objects.
 * Mirrors the tree walk in `computedPropertyPaths` but operates on a sample
 * rather than the whole dataset — property structure is homogeneous across a
 * dataset, so a bounded sample reveals all paths without loading every value.
 * Returned paths are NOT filtered against known properties; the caller does
 * that (it owns the property list).
 */
export function collectLeafPaths(
  valuesObjects: Iterable<TValuesObject>,
): string[][] {
  const collected = new Map<string, string[]>();
  const stack: [string[], TPropertyValue][] = [];
  for (const values of valuesObjects) {
    stack.push([[], values]);
  }
  while (stack.length > 0) {
    const [currentPath, currentValue] = stack.pop()!;
    const isBranch =
      currentValue !== null &&
      typeof currentValue === "object" &&
      !Array.isArray(currentValue);
    if (!isBranch) {
      if (currentPath.length > 0) {
        collected.set(createPathStringFromPathArray(currentPath), currentPath);
      }
      continue;
    }
    const branch = currentValue as Record<string, TPropertyValue>;
    const keys = Object.keys(branch);
    if (keys.length === 0) {
      if (currentPath.length > 0) {
        collected.set(createPathStringFromPathArray(currentPath), currentPath);
      }
      continue;
    }
    for (const key of keys) {
      stack.push([[...currentPath, key], branch[key]]);
    }
  }
  return Array.from(collected.values());
}

// Budget on resident property values (annotation count × leaf paths per
// annotation) above which stub-only (lazy) mode activates even when the
// annotation count alone is under stubThreshold. Without it, a wide dataset
// (thousands of values per annotation) sails under the count-based threshold
// and takes the wholesale value-load path. ~1M numeric leaves is on the order
// of 100 MB as a nested JS object map — already generous.
export const PROPERTY_VALUE_BUDGET = 1_000_000;

// Value docs sampled to estimate the per-annotation property width for the
// budget check. Structure is homogeneous across a dataset, so a handful of
// docs suffices; kept > 1 so a stray sparse doc (partial compute) doesn't
// under-estimate the width.
export const PROPERTY_WIDTH_SAMPLE_SIZE = 16;

/**
 * Whether a dataset should load in stub-only (lazy) mode: either the
 * annotation count alone exceeds the user-tunable stubThreshold, or the
 * estimated resident value count (annotations × per-annotation leaf paths)
 * exceeds PROPERTY_VALUE_BUDGET. Either input may be Infinity when its fetch
 * failed — unknown size must route to the safe (lazy) path, never wholesale.
 */
export function shouldUseStubOnlyMode(
  annotationCount: number,
  propertyWidth: number,
  stubThreshold: number,
): boolean {
  if (annotationCount > stubThreshold) {
    return true;
  }
  // 0 × Infinity is NaN; NaN > budget is false, so an empty dataset with an
  // unknown width still (correctly) loads wholesale.
  return annotationCount * propertyWidth > PROPERTY_VALUE_BUDGET;
}

/**
 * Of `ids`, those that lack a cached value for at least one of `paths` (and so
 * must be fetched). An id absent from the cache always counts as missing.
 */
export function idsMissingPaths(
  ids: string[],
  cache: IAnnotationPropertyValues,
  paths: string[][],
): string[] {
  if (paths.length === 0) {
    return [];
  }
  return ids.filter((id) => {
    const values = cache[id];
    if (!values) {
      return true;
    }
    return paths.some((path) => valueAtPath(values, path) === undefined);
  });
}

/**
 * Merge freshly-fetched values into the cache, scoped to `keepIds`: the result
 * contains only ids in `keepIds`, preserving previously-cached values and
 * overlaying the new ones (shallow per-id merge — fetches always request the
 * full current path set together, so each slice is internally consistent).
 * Scoping to the rendered set is what bounds memory in lazy mode.
 */
export function scopedMergePropertyValues(
  prev: IAnnotationPropertyValues,
  newEntries: { annotationId: string; values: TValuesObject }[],
  keepIds: Set<string>,
): IAnnotationPropertyValues {
  const result: IAnnotationPropertyValues = {};
  for (const id of keepIds) {
    if (prev[id]) {
      result[id] = prev[id];
    }
  }
  for (const { annotationId, values } of newEntries) {
    if (!keepIds.has(annotationId)) {
      continue;
    }
    result[annotationId] = { ...result[annotationId], ...values };
  }
  return result;
}

/**
 * The data range of a server-side property histogram: the first bin's min and
 * the last bin's max. Returns null for an empty/missing histogram.
 *
 * Used as the authoritative full-dataset range for the property filter slider.
 * In stub-only (lazy) mode `propertyValues` holds only the visible subset, so
 * deriving the range from it under-represents the data (and is degenerate when
 * empty); the server histogram is complete in both modes.
 */
export function histogramBounds(
  histogram: TPropertyHistogram | null | undefined,
): { min: number; max: number } | null {
  if (!histogram || histogram.length === 0) {
    return null;
  }
  return {
    min: histogram[0].min,
    max: histogram[histogram.length - 1].max,
  };
}

/**
 * Payload for the server-side uncomputed-count endpoint: each property reduced
 * to the fields the backend needs to reproduce canComputeAnnotationProperty
 * (id, shape, and the {tags, exclusive} tag rule). The tags object is passed
 * through unflattened — the backend reads `tags.tags` / `tags.exclusive`.
 */
export function uncomputedCountRequest(
  properties: IAnnotationProperty[],
): IUncomputedCountRequestEntry[] {
  return properties.map((property) => ({
    id: property.id,
    shape: property.shape,
    tags: property.tags,
  }));
}

/**
 * Coerce an uncomputed-counts API response into a clean { [propertyId]: number }
 * map at the trust boundary: a non-object response becomes {}, and any
 * non-numeric value is dropped. Keeps a malformed/partial response from
 * silently flowing into the store typed as numbers.
 */
export function coerceUncomputedCounts(data: unknown): {
  [propertyId: string]: number;
} {
  const result: { [propertyId: string]: number } = {};
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return result;
  }
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * The uncomputed-annotation count to display for a property. In lazy
 * (stub-only) mode the full annotation array isn't resident, so the
 * client-side count is always 0 and meaningless — use the server-computed
 * count instead. Otherwise use the client-side count.
 */
export function selectUncomputedCount(
  lazy: boolean,
  serverCount: number | undefined,
  clientCount: number,
): number {
  return lazy ? serverCount ?? 0 : clientCount;
}

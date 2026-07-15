import {
  IAnnotationListPropertyFilter,
  IAnnotationListSort,
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

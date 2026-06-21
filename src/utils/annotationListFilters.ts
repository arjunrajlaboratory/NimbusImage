import { IAnnotationListPropertyFilter } from "@/store/model";

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

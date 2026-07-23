import type {
  IAnnotationBrowserConfig,
  IPropertyAnnotationFilter,
} from "@/store/model";
import { createPathStringFromPathArray } from "@/utils/paths";

// Assemble the annotation-browser state to persist in the configuration.
// Only filters backing a visible row (path present in filterPaths) are kept:
// removing a filter drops its path from filterPaths but leaves a disabled
// orphan in propertyFilters (see PropertyFilterHistogram's onBeforeUnmount);
// persisting those would let them accumulate unboundedly across add/remove
// cycles. A removed filter's range is not part of the browser state to
// restore — re-adding it creates a fresh filter.
export function buildAnnotationBrowserConfig(
  displayedPropertyPaths: string[][],
  filterPaths: string[][],
  propertyFilters: IPropertyAnnotationFilter[],
): IAnnotationBrowserConfig {
  const visiblePaths = new Set(filterPaths.map(createPathStringFromPathArray));
  return {
    displayedPropertyPaths: [...displayedPropertyPaths],
    filterPaths: [...filterPaths],
    propertyFilters: propertyFilters.filter((filter) =>
      visiblePaths.has(createPathStringFromPathArray(filter.propertyPath)),
    ),
  };
}

// Validate a persisted annotation-browser config coming from the server: drop
// malformed entries, paths referencing properties no longer part of the
// configuration, and property filters that have no corresponding visible row
// (defense-in-depth against configs written before the save-side filtering, or
// hand-edited metadata).
export function resolveAnnotationBrowserConfig(
  config: Partial<IAnnotationBrowserConfig> | undefined,
  propertyIds: string[],
): IAnnotationBrowserConfig {
  const knownIds = new Set(propertyIds);
  const isKnownPath = (path: unknown): path is string[] =>
    Array.isArray(path) &&
    path.length > 0 &&
    path.every((segment) => typeof segment === "string") &&
    knownIds.has(path[0]);
  const asArray = <T>(value: T[] | undefined): T[] =>
    Array.isArray(value) ? value : [];

  const displayedPropertyPaths = asArray(config?.displayedPropertyPaths).filter(
    isKnownPath,
  );
  const filterPaths = asArray(config?.filterPaths).filter(isKnownPath);
  const visiblePaths = new Set(filterPaths.map(createPathStringFromPathArray));
  const propertyFilters = asArray(config?.propertyFilters).filter(
    (filter) =>
      isKnownPath(filter?.propertyPath) &&
      visiblePaths.has(createPathStringFromPathArray(filter.propertyPath)),
  );

  return { displayedPropertyPaths, filterPaths, propertyFilters };
}

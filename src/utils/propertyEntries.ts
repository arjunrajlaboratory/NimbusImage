import { computed, ComputedRef } from "vue";
import propertyStore from "@/store/properties";
import { IAnnotationProperty } from "@/store/model";
import { findIndexOfPath } from "@/utils/paths";

/**
 * One property with its computed value paths and how many of those are
 * currently displayed as columns in the object list.
 *
 * Shared by PropertyChipStrip (Objects tab) and MeasurementsTab so the two
 * surfaces can't drift apart on what counts as an entry or as "shown".
 */
export interface IPropertyEntry {
  property: IAnnotationProperty;
  paths: string[][];
  shownCount: number;
}

export function usePropertyEntries(options: {
  includeUncomputed: boolean;
}): ComputedRef<IPropertyEntry[]> {
  return computed((): IPropertyEntry[] => {
    const allPaths = propertyStore.computedPropertyPaths;
    const displayed = propertyStore.displayedPropertyPaths;
    const entries = propertyStore.properties.map((property) => {
      const paths = allPaths.filter((path) => path[0] === property.id);
      const shownCount = displayed.filter(
        (path) => path[0] === property.id,
      ).length;
      return { property, paths, shownCount };
    });
    return options.includeUncomputed
      ? entries
      : entries.filter((entry) => entry.paths.length > 0);
  });
}

export function isPathShown(path: string[]): boolean {
  return findIndexOfPath(path, propertyStore.displayedPropertyPaths) >= 0;
}

export function togglePathVisibility(path: string[]) {
  propertyStore.togglePropertyPathVisibility(path);
}

export function setPathsVisibility(paths: string[][], visible: boolean) {
  propertyStore.setPropertyPathsVisibility({ paths, visible });
}

/** Display name of a value path without its property prefix. */
export function propertyValueName(path: string[]): string {
  return propertyStore.getSubIdsNameFromPath(path) ?? path.slice(1).join(" / ");
}

export function propertyColumnActionLabel(path: string[]): string {
  return `${isPathShown(path) ? "Hide" : "Show"} ${propertyValueName(path)} column`;
}

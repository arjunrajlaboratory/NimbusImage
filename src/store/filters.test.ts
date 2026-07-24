/**
 * Regression test for the property-filter leak across dataset switches.
 *
 * Bug: switching datasets left the previous dataset's property filters (and
 * ROI / tag / selection / id filters) in the global `filters` module. In the
 * next dataset those chips referenced property IDs that no longer resolved, so
 * they rendered as broken, uneditable filters the user had to delete by hand.
 *
 * Fix: `setSelectedDataset` now dispatches `resetFilterState` alongside the
 * existing annotation/property resets. This test pins the reset behavior:
 * every dataset-scoped field is cleared, while the generic `onlyCurrentFrame`
 * view toggle is preserved.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// The filters module only touches these dependencies inside getters/actions
// that this test does not exercise, but they must be importable so the module
// evaluates. Mock them to avoid pulling in the full store/geojs graph.
vi.mock("./index", () => ({
  default: {
    xy: 0,
    z: 0,
    time: 0,
    dataset: null,
    scheduleAnnotationBrowserSave: () => {},
  },
}));
vi.mock("./annotation", () => ({
  default: { annotations: [], selectedAnnotationIds: ["a", "b"] },
}));
vi.mock("./properties", () => ({
  default: {
    propertyValues: {},
    propertiesAPI: { getPropertyHistogram: () => Promise.resolve([]) },
  },
}));
vi.mock("geojs", () => ({
  default: { util: { pointInPolygon: () => false } },
}));
vi.mock("@/utils/annotation", () => ({
  tagCloudFilterFunction: () => true,
}));

import filters from "./filters";
import {
  IGeoJSPosition,
  PropertyFilterMode,
  TPropertyHistogram,
} from "./model";

function populateEveryFilter() {
  filters.setTagFilter({
    id: "tagFilter",
    exclusive: true,
    enabled: true,
    tags: ["nucleus", "red blob"],
  });
  filters.togglePropertyPathFiltering(["prop-id-from-dataset-A", "Area"]);
  filters.updatePropertyFilter({
    range: { min: 400, max: 975 },
    id: "filter-A",
    propertyPath: ["prop-id-from-dataset-A", "Area"],
    exclusive: false,
    enabled: true,
    valuesOrRange: PropertyFilterMode.Range,
  });
  filters.newROIFilter();
  const roi: IGeoJSPosition[] = [{ x: 0, y: 0 }];
  filters.validateNewROIFilter(roi);
  filters.newROIFilter(); // leaves an in-progress emptyROIFilter set
  filters.newAnnotationIdFilter(["ann-1", "ann-2"]);
  filters.addSelectionAsFilter(); // reads annotation.selectedAnnotationIds
  const histogram: TPropertyHistogram = [];
  filters.setPropertyHistograms({ "prop-id-from-dataset-A###Area": histogram });
}

describe("filters.resetFilterState", () => {
  beforeEach(() => {
    filters.resetFilterState();
    filters.setOnlyCurrentFrame(false);
  });

  it("clears every dataset-scoped filter so nothing leaks into the next dataset", () => {
    populateEveryFilter();

    // Sanity: state is actually populated before the reset.
    expect(filters.propertyFilters.length).toBe(1);
    expect(filters.filterPaths.length).toBe(1);
    expect(filters.roiFilters.length).toBe(1);
    expect(filters.emptyROIFilter).not.toBeNull();
    expect(filters.annotationIdFilters.length).toBe(1);
    expect(filters.tagFilter.tags.length).toBe(2);
    expect(filters.selectionFilter.enabled).toBe(true);
    expect(Object.keys(filters.histograms).length).toBe(1);

    filters.resetFilterState();

    expect(filters.propertyFilters).toEqual([]);
    expect(filters.filterPaths).toEqual([]);
    expect(filters.roiFilters).toEqual([]);
    expect(filters.emptyROIFilter).toBeNull();
    expect(filters.annotationIdFilters).toEqual([]);
    expect(filters.histograms).toEqual({});
    expect(filters.tagFilter.enabled).toBe(false);
    expect(filters.tagFilter.tags).toEqual([]);
    expect(filters.selectionFilter.enabled).toBe(false);
    expect(filters.selectionFilter.annotationIds).toEqual([]);
  });

  it("preserves the generic onlyCurrentFrame view toggle across a reset", () => {
    filters.setOnlyCurrentFrame(true);

    filters.resetFilterState();

    expect(filters.onlyCurrentFrame).toBe(true);
  });
});

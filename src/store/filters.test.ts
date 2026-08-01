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
    showAnnotationsFromHiddenLayers: true,
    scheduleAnnotationBrowserSave: () => {},
  },
}));
vi.mock("./annotation", () => ({
  default: {
    annotations: [],
    selectedAnnotationIds: ["a", "b"],
    stubOnlyMode: false,
    annotationCentroids: {},
    // Minimal population for the filteredAnnotations / gate tests below.
    annotationsForIteration: [{ id: "a" }, { id: "b" }, { id: "c" }],
  },
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
  annotationTestPoints: () => [],
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

  it("clears analysis plots on reset", () => {
    filters.addAnalysisPlot("plot-1");

    filters.resetFilterState();

    expect(filters.analysisPlots).toEqual([]);
  });
});

describe("analysis plot gates", () => {
  beforeEach(() => {
    filters.resetFilterState();
  });

  const filteredIds = () =>
    filters.filteredAnnotations.map(
      (annotation: { id: string }) => annotation.id,
    );

  // A gate is a polygon; the ids inside it are derived by
  // refreshAnalysisGateIds. These tests drive the derived map directly so they
  // pin the COMPOSITION rules; resolveAnalysisGateIds (polygon -> ids) is
  // covered in analysisGating.test.ts.
  const GATE = {
    vertices: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
    ],
    xCategories: null,
    yCategories: null,
  };

  it("passes everything through while no gate is drawn", () => {
    filters.addAnalysisPlot("p1");
    expect(filteredIds()).toEqual(["a", "b", "c"]);
    expect(filters.activeFilterCount).toBe(0);
  });

  it("does not constrain a drawn gate until its ids have been resolved", () => {
    // The window between drawing a gate and the values needed to resolve it
    // arriving must not hide everything.
    filters.addAnalysisPlot("p1");
    filters.setAnalysisPlotGate({ id: "p1", gate: GATE });
    expect(filteredIds()).toEqual(["a", "b", "c"]);
    expect(filters.activeFilterCount).toBe(0);
  });

  it("ANDs the enabled resolved gates into filteredAnnotations", () => {
    filters.addAnalysisPlot("p1");
    filters.addAnalysisPlot("p2");
    filters.setAnalysisPlotGate({ id: "p1", gate: GATE });
    filters.setAnalysisPlotGate({ id: "p2", gate: GATE });

    filters.setAnalysisGateIds({ p1: ["a", "b"] });
    expect(filteredIds()).toEqual(["a", "b"]);
    expect(filters.activeFilterCount).toBe(1);

    filters.setAnalysisGateIds({ p1: ["a", "b"], p2: ["b", "c"] });
    expect(filteredIds()).toEqual(["b"]);
    expect(filters.activeFilterCount).toBe(2);

    // Disabling drops the constraint without losing the drawn polygon.
    filters.toggleAnalysisPlotGateEnabled("p2");
    expect(filteredIds()).toEqual(["a", "b"]);
    expect(
      filters.analysisPlots.find((plot) => plot.id === "p2")?.gate,
    ).toEqual(GATE);

    // Clearing the other gate restores the full population.
    filters.setAnalysisPlotGate({ id: "p1", gate: null });
    expect(filteredIds()).toEqual(["a", "b", "c"]);
  });

  it("treats an empty resolved gate as filtering everything out", () => {
    filters.addAnalysisPlot("p1");
    filters.setAnalysisPlotGate({ id: "p1", gate: GATE });
    filters.setAnalysisGateIds({ p1: [] });
    expect(filteredIds()).toEqual([]);
  });

  it("invalidates the gate and its ids when an axis changes", () => {
    filters.addAnalysisPlot("p1");
    filters.setAnalysisPlotGate({ id: "p1", gate: GATE });
    filters.setAnalysisGateIds({ p1: ["a"] });
    expect(filteredIds()).toEqual(["a"]);

    filters.setAnalysisPlotAxes({
      id: "p1",
      xAxis: { type: "categorical", key: "tags" },
    });

    expect(filters.analysisPlots[0].gate).toBeNull();
    expect(filters.analysisGateIds.p1).toBeUndefined();
    expect(filters.analysisPlots[0].xAxis).toEqual({
      type: "categorical",
      key: "tags",
    });
    expect(filteredIds()).toEqual(["a", "b", "c"]);
  });

  it("removing a plot removes its gate from the composition", () => {
    filters.addAnalysisPlot("p1");
    filters.setAnalysisPlotGate({ id: "p1", gate: GATE });
    filters.setAnalysisGateIds({ p1: ["a"] });
    expect(filteredIds()).toEqual(["a"]);

    filters.removeAnalysisPlot("p1");
    expect(filters.analysisPlots).toEqual([]);
    expect(filters.analysisGateIds.p1).toBeUndefined();
    expect(filteredIds()).toEqual(["a", "b", "c"]);
  });

  it("exposes active gates as raw id lists, not Sets", () => {
    // buildListFilters forwards these straight to the backend, so materializing
    // a Set per gate just to hand it back as an array would be pure waste.
    filters.addAnalysisPlot("p1");
    filters.setAnalysisPlotGate({ id: "p1", gate: GATE });
    filters.setAnalysisGateIds({ p1: ["a", "b"] });
    expect(filters.activeAnalysisGateIdLists).toEqual([["a", "b"]]);
    filters.toggleAnalysisPlotGateEnabled("p1");
    expect(filters.activeAnalysisGateIdLists).toEqual([]);
  });

  it("short-circuits the analysis signature when nothing needs resolving", () => {
    // Guards the cost: with no gate and nobody looking, this getter must not
    // touch the population.
    filters.addAnalysisPlot("p1");
    expect(filters.analysisInputSignature).toBe("idle");
    filters.setAnalysisPlotGate({ id: "p1", gate: GATE });
    expect(filters.analysisInputSignature).not.toBe("idle");
  });

  it("wakes the analysis signature when the panel opens with no gate", () => {
    // The panel needs values for ungated plots to draw them, so opening it has
    // to trigger the fetch even though no gate needs resolving.
    filters.addAnalysisPlot("p1");
    expect(filters.analysisInputSignature).toBe("idle");
    filters.setAnalysisPanelOpen(true);
    expect(filters.analysisInputSignature).not.toBe("idle");
    filters.setAnalysisPanelOpen(false);
  });

  it("signs the id-membership filters without serializing their ids", () => {
    // A select-all puts tens of thousands of ids in the selection filter, and
    // the watchers keyed off this re-evaluate on every frame scrub.
    filters.newAnnotationIdFilter(["a", "b", "c"]);
    const sig = filters.membershipFilterSignature;
    expect(sig).not.toContain('"a"');
    expect(sig).toContain("3:a,b,c");
    filters.newAnnotationIdFilter(["x", "y", "z"]);
    expect(filters.membershipFilterSignature).not.toBe(sig);
  });
});

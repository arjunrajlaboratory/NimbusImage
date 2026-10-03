/**
 * Tests for the `activeFilterCount` getter that drives the count badge on the
 * app-bar Filters button. The badge exists so a user can tell filters are
 * narrowing the object set even when the Filters panel is closed, so the count
 * must include every filter kind the panel exposes and nothing else.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { mainMock } = vi.hoisted(() => ({
  mainMock: {
    xy: 0,
    z: 0,
    time: 0,
    dataset: null as { id: string } | null,
    showAnnotationsFromHiddenLayers: true,
    scheduleAnnotationBrowserSave: () => {},
  },
}));

vi.mock("@/store/index", () => ({ default: mainMock }));
vi.mock("@/store/annotation", () => ({
  default: {
    annotations: [],
    selectedAnnotationIds: ["a", "b"],
    annotationsForIteration: [],
    annotationCentroids: {},
    stubOnlyMode: false,
  },
}));
vi.mock("@/store/properties", () => ({
  default: {
    propertyValues: {},
    propertiesAPI: { getPropertyHistogram: () => Promise.resolve([]) },
  },
}));
vi.mock("geojs", () => ({
  default: { util: { pointInPolygon: () => false } },
}));

import filters from "@/store/filters";
import { MAX_ANALYSIS_PLOTS } from "@/store/constants";
import { PropertyFilterMode } from "@/store/model";

function addAreaFilter(enabled: boolean) {
  filters.updatePropertyFilter({
    id: "pf-area",
    exclusive: false,
    enabled,
    propertyPath: ["p", "Area"],
    range: { min: 0, max: 5 },
    valuesOrRange: PropertyFilterMode.Range,
    values: [],
  });
}

describe("filters.activeFilterCount", () => {
  beforeEach(() => {
    filters.resetFilterState();
    filters.setOnlyCurrentFrame(false);
    mainMock.showAnnotationsFromHiddenLayers = true;
  });

  it("is 0 when no filter is active", () => {
    expect(filters.activeFilterCount).toBe(0);
  });

  it("counts an enabled tag filter once", () => {
    filters.setTagFilter({
      id: "tagFilter",
      exclusive: false,
      enabled: true,
      tags: ["nucleus"],
    });
    expect(filters.activeFilterCount).toBe(1);
  });

  it("does not count a disabled tag filter that still holds tags", () => {
    filters.setTagFilter({
      id: "tagFilter",
      exclusive: false,
      enabled: false,
      tags: ["nucleus"],
    });
    expect(filters.activeFilterCount).toBe(0);
  });

  it("counts the current-frame scope toggle", () => {
    filters.setOnlyCurrentFrame(true);
    expect(filters.activeFilterCount).toBe(1);
  });

  it("counts hiding objects from hidden layers (non-default toggle)", () => {
    mainMock.showAnnotationsFromHiddenLayers = false;
    expect(filters.activeFilterCount).toBe(1);
  });

  it("counts only enabled property filters", () => {
    addAreaFilter(true);
    expect(filters.activeFilterCount).toBe(1);
    addAreaFilter(false);
    expect(filters.activeFilterCount).toBe(0);
  });

  it("counts each enabled region filter and ignores one still being drawn", () => {
    filters.newROIFilter();
    // Only the pending (empty) filter exists so far — nothing filters yet.
    expect(filters.activeFilterCount).toBe(0);
    filters.validateNewROIFilter([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
    ]);
    expect(filters.activeFilterCount).toBe(1);
    filters.toggleRoiFilterEnabled("Region Filter 0");
    expect(filters.activeFilterCount).toBe(0);
  });

  it("counts each enabled annotation id filter", () => {
    filters.newAnnotationIdFilter(["a"]);
    filters.newAnnotationIdFilter(["b"]);
    expect(filters.activeFilterCount).toBe(2);
    filters.toggleAnnotationIdFilterEnabled("Annotation List Filter 0");
    expect(filters.activeFilterCount).toBe(1);
  });

  it("counts the selection filter", () => {
    filters.addSelectionAsFilter();
    expect(filters.activeFilterCount).toBe(1);
    filters.clearSelection();
    expect(filters.activeFilterCount).toBe(0);
  });

  it("sums filters of different kinds", () => {
    filters.setTagFilter({
      id: "tagFilter",
      exclusive: false,
      enabled: true,
      tags: ["nucleus"],
    });
    filters.setOnlyCurrentFrame(true);
    addAreaFilter(true);
    filters.addSelectionAsFilter();
    mainMock.showAnnotationsFromHiddenLayers = false;
    expect(filters.activeFilterCount).toBe(5);
  });

  it("returns to 0 after the per-dataset filter state is reset", () => {
    filters.setTagFilter({
      id: "tagFilter",
      exclusive: false,
      enabled: true,
      tags: ["nucleus"],
    });
    addAreaFilter(true);
    filters.addSelectionAsFilter();
    filters.resetFilterState();
    expect(filters.activeFilterCount).toBe(0);
  });
});

// Each badge counts what its own panel shows. Analysis gates used to add to
// this count, which meant a lone gate rendered "Filters: 1" on a button whose
// panel then showed nothing — the count pointed at a filter the user could not
// find. Gates are surfaced by the Analysis badge (activeAnalysisGateCount).
describe("filters.activeFilterCount excludes analysis gates", () => {
  beforeEach(() => {
    filters.resetFilterState();
    filters.setOnlyCurrentFrame(false);
    mainMock.showAnnotationsFromHiddenLayers = true;
  });

  it("stays 0 for a resolved, enabled gate", () => {
    filters.addAnalysisPlot("p1");
    filters.setAnalysisPlotGate({
      id: "p1",
      gate: {
        categoryKeyVersion: 1,
        vertices: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 1, y: 1 },
        ],
        xCategories: null,
        yCategories: null,
      },
    });
    filters.setAnalysisGateIds({ p1: ["a"] });
    expect(filters.activeAnalysisGateCount).toBe(1);
    expect(filters.activeFilterCount).toBe(0);
  });

  it("counts only the panel's own filters alongside a gate", () => {
    filters.addAnalysisPlot("p1");
    filters.setAnalysisPlotGate({
      id: "p1",
      gate: {
        categoryKeyVersion: 1,
        vertices: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 1, y: 1 },
        ],
        xCategories: null,
        yCategories: null,
      },
    });
    filters.setAnalysisGateIds({ p1: ["a"] });
    filters.setTagFilter({
      id: "tagFilter",
      exclusive: false,
      enabled: true,
      tags: ["nucleus"],
    });
    addAreaFilter(true);
    // Two rows in the Filters panel, one gate in the Analysis panel.
    expect(filters.activeFilterCount).toBe(2);
    expect(filters.activeAnalysisGateCount).toBe(1);
  });
});

// Codex round 2: the backend caps a gate-resolution request at
// MAX_ANALYSIS_PLOTS. Without a matching client limit, a 21st plot made
// every request 400, fetchAnalysisGateIds returned null, and — because the
// changed-input path clears resolved ids before awaiting — every gate
// stopped filtering with no way to recover. The cap belongs where plots are
// created, so the situation cannot arise.
describe("filters plot count is capped", () => {
  beforeEach(() => {
    filters.resetFilterState();
  });

  it("stops adding plots at MAX_ANALYSIS_PLOTS", () => {
    for (let i = 0; i < MAX_ANALYSIS_PLOTS + 5; i++) {
      filters.addAnalysisPlot(`p${i}`);
    }
    expect(filters.analysisPlots).toHaveLength(MAX_ANALYSIS_PLOTS);
    expect(filters.canAddAnalysisPlot).toBe(false);
  });

  it("allows adding again after one is removed", () => {
    for (let i = 0; i < MAX_ANALYSIS_PLOTS; i++) {
      filters.addAnalysisPlot(`p${i}`);
    }
    expect(filters.canAddAnalysisPlot).toBe(false);
    filters.removeAnalysisPlot("p0");
    expect(filters.canAddAnalysisPlot).toBe(true);
    filters.addAnalysisPlot("fresh");
    expect(filters.analysisPlots.map((p) => p.id)).toContain("fresh");
  });
});

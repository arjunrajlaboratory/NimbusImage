import { describe, it, expect, vi, beforeEach } from "vitest";

// Control the API call and the stores the filters module reads, so we can
// exercise the real refreshPropertyFilterPassingIds action and the
// filteredAnnotations getter in isolation. ./root stays real — the dynamic
// module registers on it.
const { fetchAnnotationListIds, annotationMock, propertiesMock } = vi.hoisted(
  () => ({
    fetchAnnotationListIds: vi.fn(),
    annotationMock: {
      stubOnlyMode: false,
      annotationsForIteration: [] as any[],
      annotationCentroids: {} as Record<string, { x: number; y: number }>,
    },
    propertiesMock: {
      propertyValues: {} as Record<string, any>,
      propertiesAPI: {
        getPropertyHistogram: vi.fn(),
        getPropertyValuesForIds: vi.fn(
          async (): Promise<
            { annotationId: string; values: Record<string, any> }[]
          > => [],
        ),
      },
    },
  }),
);

vi.mock("@/store/index", () => ({
  default: {
    dataset: { id: "ds1" },
    xy: 0,
    z: 0,
    time: 0,
    annotationsAPI: {
      fetchAnnotationListIds: (...a: any[]) => fetchAnnotationListIds(...a),
    },
    scheduleAnnotationBrowserSave: () => {},
    isLoggedIn: true,
  },
}));

vi.mock("@/store/annotation", () => ({
  default: annotationMock,
}));

vi.mock("@/store/properties", () => ({
  default: propertiesMock,
}));

vi.mock("geojs", () => ({
  default: { util: { pointInPolygon: vi.fn().mockReturnValue(false) } },
}));

import filters from "@/store/filters";
import { PropertyFilterMode } from "@/store/model";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeStub(id: string) {
  return { id, location: { XY: 0, Z: 0, Time: 0 }, tags: [] as string[] };
}

function addAreaRangeFilter(min: number, max: number) {
  filters.updatePropertyFilter({
    id: "pf-area",
    exclusive: false,
    enabled: true,
    propertyPath: ["p", "Area"],
    range: { min, max },
    valuesOrRange: PropertyFilterMode.Range,
    values: [],
  });
}

describe("filters property-filter server membership (D Stage 2)", () => {
  beforeEach(() => {
    fetchAnnotationListIds.mockReset();
    annotationMock.stubOnlyMode = false;
    annotationMock.annotationsForIteration = [];
    annotationMock.annotationCentroids = {};
    propertiesMock.propertyValues = {};
    // Reset the filters module state touched by these tests. updatePropertyFilter
    // replaces by path, so disabling the lone Area filter clears the active set.
    filters.updatePropertyFilter({
      id: "pf-area",
      exclusive: false,
      enabled: false,
      propertyPath: ["p", "Area"],
      range: { min: 0, max: 0 },
      valuesOrRange: PropertyFilterMode.Range,
      values: [],
    });
    (filters as any).setPropertyFilterPassingIds(null);
  });

  describe("refreshPropertyFilterPassingIds", () => {
    it("fetches property-only ids and stores them as a set in lazy mode", async () => {
      annotationMock.stubOnlyMode = true;
      addAreaRangeFilter(1, 5);
      fetchAnnotationListIds.mockResolvedValueOnce(["a", "b"]);

      await filters.refreshPropertyFilterPassingIds();

      expect(fetchAnnotationListIds).toHaveBeenCalledWith("ds1", {
        propertyFilters: [
          { path: ["p", "Area"], mode: "range", min: 1, max: 5 },
        ],
      });
      expect(filters.propertyFilterPassingIds).toBeInstanceOf(Set);
      expect([...(filters.propertyFilterPassingIds as Set<string>)]).toEqual([
        "a",
        "b",
      ]);
    });

    it("sets null and does not fetch when no property filter is active", async () => {
      annotationMock.stubOnlyMode = true;
      await filters.refreshPropertyFilterPassingIds();
      expect(fetchAnnotationListIds).not.toHaveBeenCalled();
      expect(filters.propertyFilterPassingIds).toBeNull();
    });

    it("sets null and does not fetch when not in lazy mode", async () => {
      annotationMock.stubOnlyMode = false;
      addAreaRangeFilter(1, 5);
      await filters.refreshPropertyFilterPassingIds();
      expect(fetchAnnotationListIds).not.toHaveBeenCalled();
      expect(filters.propertyFilterPassingIds).toBeNull();
    });

    it("ignores an older response that resolves after a newer one", async () => {
      annotationMock.stubOnlyMode = true;
      addAreaRangeFilter(1, 5);
      const d1 = deferred<string[]>();
      const d2 = deferred<string[]>();
      fetchAnnotationListIds
        .mockReturnValueOnce(d1.promise)
        .mockReturnValueOnce(d2.promise);

      const p1 = filters.refreshPropertyFilterPassingIds();
      const p2 = filters.refreshPropertyFilterPassingIds();

      d2.resolve(["new"]);
      await p2;
      d1.resolve(["old"]);
      await p1;

      expect([...(filters.propertyFilterPassingIds as Set<string>)]).toEqual([
        "new",
      ]);
    });
  });

  describe("filteredAnnotations property predicate", () => {
    it("keeps only annotations in the passing set (lazy mode, active filter)", () => {
      annotationMock.stubOnlyMode = true;
      annotationMock.annotationsForIteration = [makeStub("a"), makeStub("b")];
      addAreaRangeFilter(1, 5);
      (filters as any).setPropertyFilterPassingIds(["a"]);

      expect(filters.filteredAnnotations.map((a: any) => a.id)).toEqual(["a"]);
    });

    it("passes all while the passing set is not yet loaded (interim null)", () => {
      annotationMock.stubOnlyMode = true;
      annotationMock.annotationsForIteration = [makeStub("a"), makeStub("b")];
      addAreaRangeFilter(1, 5);
      (filters as any).setPropertyFilterPassingIds(null);

      expect(filters.filteredAnnotations.map((a: any) => a.id)).toEqual([
        "a",
        "b",
      ]);
    });

    it("filters by property values client-side in full (non-lazy) mode", () => {
      annotationMock.stubOnlyMode = false;
      annotationMock.annotationsForIteration = [makeStub("a"), makeStub("b")];
      propertiesMock.propertyValues = {
        a: { p: { Area: 3 } },
        b: { p: { Area: 99 } },
      };
      addAreaRangeFilter(0, 5);

      expect(filters.filteredAnnotations.map((a: any) => a.id)).toEqual(["a"]);
    });
  });
});

// The fetch decision lives in the store because a gate is a filter: it must
// resolve whether or not the Analysis palette is open. These pin its SCOPE —
// when a round trip happens at all — which is what regresses silently.
describe("filters.refreshAnalysis", () => {
  const getValues = propertiesMock.propertiesAPI.getPropertyValuesForIds;
  const AXIS = { type: "property" as const, path: ["prop", "Area"] };
  const GATE = {
    vertices: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ],
    xCategories: null,
    yCategories: null,
  };

  beforeEach(() => {
    filters.resetFilterState();
    filters.setAnalysisPanelOpen(false);
    getValues.mockClear();
    getValues.mockResolvedValue([]);
    annotationMock.annotationsForIteration = [makeStub("a"), makeStub("b")];
  });

  const addPlot = async (id: string, gate: any = null) => {
    await filters.addAnalysisPlot(id);
    await filters.setAnalysisPlotAxes({ id, xAxis: AXIS, yAxis: AXIS });
    if (gate) {
      await filters.setAnalysisPlotGate({ id, gate });
    }
  };

  it("does not fetch for an ungated plot while the panel is closed", async () => {
    // A configuration carrying plots must cost nothing until someone looks.
    await addPlot("p1");
    await filters.refreshAnalysis();
    expect(getValues).not.toHaveBeenCalled();
  });

  it("fetches for a gated plot even with the panel closed", async () => {
    // A gate is a filter; it has to apply without the palette being open.
    await addPlot("p1", GATE);
    await filters.refreshAnalysis();
    expect(getValues).toHaveBeenCalledTimes(1);
  });

  it("fetches for an ungated plot once the panel opens", async () => {
    await addPlot("p1");
    filters.setAnalysisPanelOpen(true);
    await filters.refreshAnalysis();
    expect(getValues).toHaveBeenCalledTimes(1);
  });

  it("requests only the axes' property paths, projected", async () => {
    await addPlot("p1", GATE);
    await filters.refreshAnalysis();
    const [datasetId, ids, paths] = getValues.mock.calls[0] as unknown as [
      string,
      string[],
      string[][],
    ];
    expect(datasetId).toBe("ds1");
    expect(ids).toEqual(["a", "b"]);
    expect(paths).toEqual([["prop", "Area"]]);
  });

  it("does not fetch when both axes are categorical", async () => {
    await filters.addAnalysisPlot("p1");
    await filters.setAnalysisPlotAxes({
      id: "p1",
      xAxis: { type: "categorical", key: "tags" },
      yAxis: { type: "categorical", key: "shape" },
    });
    await filters.setAnalysisPlotGate({ id: "p1", gate: GATE });
    await filters.refreshAnalysis();
    expect(getValues).not.toHaveBeenCalled();
  });

  it("refuses to fetch or gate above the point cap", async () => {
    annotationMock.annotationsForIteration = Array.from(
      { length: 50001 },
      (_, i) => makeStub(`id-${i}`),
    );
    await addPlot("p1", GATE);
    await filters.refreshAnalysis();
    expect(getValues).not.toHaveBeenCalled();
    expect(filters.analysisGateIds).toEqual({});
  });

  it("resolves the polygon into ids and publishes the values it fetched", async () => {
    getValues.mockResolvedValue([
      { annotationId: "a", values: { prop: { Area: 5 } } }, // inside
      { annotationId: "b", values: { prop: { Area: 99 } } }, // outside
    ]);
    await addPlot("p1", GATE);
    await filters.refreshAnalysis();
    expect(filters.analysisGateIds.p1).toEqual(["a"]);
    // Published so the panel can draw from the same fetch rather than repeating it.
    expect(Object.keys(filters.analysisValues)).toEqual(["a", "b"]);
    expect(filters.filteredAnnotations.map((x: any) => x.id)).toEqual(["a"]);
  });

  it("samples gate ids in the signature, not just their count", async () => {
    // A lasso moved to a different region with the SAME number of objects must
    // still register, or the server-mode list keeps the previous gate's rows.
    await addPlot("p1", GATE);
    filters.setAnalysisGateIds({ p1: ["a", "b"] });
    const before = filters.analysisGateSignature;
    filters.setAnalysisGateIds({ p1: ["c", "d"] });
    expect(filters.analysisGateSignature).not.toBe(before);
  });

  it("tracks loading explicitly so an empty result is not mistaken for pending", async () => {
    // An empty result is a real outcome (a property computed for only some
    // objects); inferring "loading" from emptiness spun the panel forever.
    getValues.mockResolvedValue([]);
    await addPlot("p1", GATE);
    expect(filters.analysisLoading).toBe(false);
    const pending = filters.refreshAnalysis();
    expect(filters.analysisLoading).toBe(true);
    await pending;
    expect(filters.analysisLoading).toBe(false);
    expect(filters.analysisValues).toEqual({});
  });

  it("clears the loading flag when it bails out early", async () => {
    getValues.mockResolvedValue([]);
    await addPlot("p1", GATE);
    await filters.refreshAnalysis();
    await filters.setAnalysisPlotGate({ id: "p1", gate: null });
    await filters.refreshAnalysis();
    expect(filters.analysisLoading).toBe(false);
  });

  it("clears derived state when the last gate goes away", async () => {
    getValues.mockResolvedValue([
      { annotationId: "a", values: { prop: { Area: 5 } } },
    ]);
    await addPlot("p1", GATE);
    await filters.refreshAnalysis();
    expect(filters.analysisGateIds.p1).toBeDefined();

    await filters.setAnalysisPlotGate({ id: "p1", gate: null });
    await filters.refreshAnalysis();
    expect(filters.analysisGateIds).toEqual({});
    expect(filters.analysisValues).toEqual({});
  });
});

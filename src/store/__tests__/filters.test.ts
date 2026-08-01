import { describe, it, expect, vi, beforeEach } from "vitest";

// Control the API call and the stores the filters module reads, so we can
// exercise the real refreshPropertyFilterPassingIds action and the
// filteredAnnotations getter in isolation. ./root stays real — the dynamic
// module registers on it.
const {
  fetchAnnotationListIds,
  fetchAnalysisGateIds,
  annotationMock,
  propertiesMock,
} = vi.hoisted(() => ({
  fetchAnnotationListIds: vi.fn(),
  fetchAnalysisGateIds: vi.fn(),
  annotationMock: {
    stubOnlyMode: false,
    annotationsForIteration: [] as any[],
    annotationCentroids: {} as Record<string, { x: number; y: number }>,
    contentRevision: 0,
  },
  propertiesMock: {
    propertyValues: {} as Record<string, any>,
    propertyValuesRevision: 0,
    propertiesAPI: {
      getPropertyHistogram: vi.fn(),
      getPropertyValuesForIds: vi.fn(
        async (): Promise<
          { annotationId: string; values: Record<string, any> }[]
        > => [],
      ),
    },
  },
}));

vi.mock("@/store/index", () => ({
  default: {
    dataset: { id: "ds1" },
    xy: 0,
    z: 0,
    time: 0,
    annotationsAPI: {
      fetchAnnotationListIds: (...a: any[]) => fetchAnnotationListIds(...a),
      fetchAnalysisGateIds: (...a: any[]) => fetchAnalysisGateIds(...a),
    },
    scheduleAnnotationBrowserSave: () => {},
    isLoggedIn: true,
    showAnnotationsFromHiddenLayers: true,
  },
}));

// Reactive proxies, so getter caches invalidate when tests mutate store
// members (e.g. contentRevision) — mutate through the imported proxy, not
// the raw hoisted object, or the getters won't see the change (see
// connectionList.test.ts for the same pattern).
vi.mock("@/store/annotation", async () => {
  const { reactive } = await import("vue");
  return { default: reactive(annotationMock) };
});

vi.mock("@/store/properties", async () => {
  const { reactive } = await import("vue");
  return { default: reactive(propertiesMock) };
});

vi.mock("geojs", () => ({
  default: { util: { pointInPolygon: vi.fn().mockReturnValue(false) } },
}));

import filters from "@/store/filters";
// The mocked (reactive) store proxies — mutations must go through these.
import annotationProxy from "@/store/annotation";
import propertiesProxy from "@/store/properties";
import {
  categoricalContentSignature,
  encodeAnalysisCategoryKey,
} from "@/utils/analysisGating";
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
  const OTHER_AXIS = {
    type: "property" as const,
    path: ["other", "Intensity"],
  };
  const GATE = {
    categoryKeyVersion: 1 as const,
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
    getValues.mockReset();
    getValues.mockResolvedValue([]);
    propertiesMock.propertyValuesRevision = 0;
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

  it("does not fetch for a disabled gate while the panel is closed", async () => {
    // A persisted disabled gate is display-only until it is re-enabled. It must
    // not wake the Viewer watcher and fetch a 50k-row property population on
    // every dataset load while the Analysis palette is hidden.
    await addPlot("p1", GATE);
    await filters.toggleAnalysisPlotGateEnabled("p1");

    expect(filters.analysisInputSignature).toBe("idle");
    await filters.refreshAnalysis();

    expect(getValues).not.toHaveBeenCalled();

    await filters.toggleAnalysisPlotGateEnabled("p1");
    expect(filters.analysisInputSignature).not.toBe("idle");
    await filters.refreshAnalysis();
    expect(getValues).toHaveBeenCalledTimes(1);
  });

  it("does not resolve a disabled gate during another hidden gate's refresh", async () => {
    // Once disabled paths are omitted, resolving that plot from the enabled
    // gate's narrower value projection would publish a bogus empty id list.
    // Re-enabling would then briefly filter everything until its own fetch won.
    await addPlot("disabled", GATE);
    await filters.toggleAnalysisPlotGateEnabled("disabled");
    await filters.addAnalysisPlot("active");
    await filters.setAnalysisPlotAxes({
      id: "active",
      xAxis: OTHER_AXIS,
      yAxis: OTHER_AXIS,
    });
    await filters.setAnalysisPlotGate({ id: "active", gate: GATE });
    getValues.mockResolvedValue([
      { annotationId: "a", values: { other: { Intensity: 5 } } },
    ]);

    await filters.refreshAnalysis();

    expect(getValues).toHaveBeenCalledTimes(1);
    const [, , paths] = getValues.mock.calls[0] as unknown as [
      string,
      string[],
      string[][],
    ];
    expect(paths).toEqual([["other", "Intensity"]]);
    expect(filters.analysisGateIds.disabled).toBeUndefined();
    expect(filters.analysisGateIds.active).toEqual(["a"]);
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

  it("requests only gated plot paths while the panel is closed", async () => {
    await addPlot("gated", GATE);
    await filters.addAnalysisPlot("display-only");
    await filters.setAnalysisPlotAxes({
      id: "display-only",
      xAxis: OTHER_AXIS,
      yAxis: OTHER_AXIS,
    });

    await filters.refreshAnalysis();

    expect(getValues).toHaveBeenCalledTimes(1);
    const [, , paths] = getValues.mock.calls[0] as unknown as [
      string,
      string[],
      string[][],
    ];
    expect(paths).toEqual([["prop", "Area"]]);
  });

  it("does not fetch hidden ungated paths for a categorical-only gate", async () => {
    annotationMock.annotationsForIteration = [
      { ...makeStub("a"), tags: ["keep"], shape: "point" },
      { ...makeStub("b"), tags: ["drop"], shape: "point" },
    ];
    await filters.addAnalysisPlot("gated");
    await filters.setAnalysisPlotAxes({
      id: "gated",
      xAxis: { type: "categorical", key: "tags" },
      yAxis: { type: "categorical", key: "shape" },
    });
    await filters.setAnalysisPlotGate({
      id: "gated",
      gate: {
        ...GATE,
        xCategories: [
          encodeAnalysisCategoryKey(["drop"]),
          encodeAnalysisCategoryKey(["keep"]),
        ],
        yCategories: [encodeAnalysisCategoryKey("point")],
      },
    });
    await filters.addAnalysisPlot("display-only");
    await filters.setAnalysisPlotAxes({
      id: "display-only",
      xAxis: OTHER_AXIS,
      yAxis: OTHER_AXIS,
    });

    await filters.refreshAnalysis();

    expect(getValues).not.toHaveBeenCalled();
  });

  it("resolves a categorical-only gate without fetching anything", async () => {
    // "Nothing to fetch" is not "nothing to do". Categorical axes read
    // annotation fields, so a Tags-vs-Shape gate needs no property values — and
    // bailing out on the empty path list left it drawn, persisted and totally
    // inert: it plotted and lassoed normally and filtered nothing.
    annotationMock.annotationsForIteration = [
      { ...makeStub("a"), tags: ["keep"], shape: "point" },
      { ...makeStub("b"), tags: ["drop"], shape: "point" },
    ];
    await filters.addAnalysisPlot("p1");
    await filters.setAnalysisPlotAxes({
      id: "p1",
      xAxis: { type: "categorical", key: "tags" },
      yAxis: { type: "categorical", key: "shape" },
    });
    // Category order pinned so the polygon's x range means "the 'drop' column".
    await filters.setAnalysisPlotGate({
      id: "p1",
      gate: {
        categoryKeyVersion: 1,
        vertices: [
          { x: -0.5, y: -0.5 },
          { x: 0.5, y: -0.5 },
          { x: 0.5, y: 0.5 },
          { x: -0.5, y: 0.5 },
        ],
        xCategories: [
          encodeAnalysisCategoryKey(["drop"]),
          encodeAnalysisCategoryKey(["keep"]),
        ],
        yCategories: [encodeAnalysisCategoryKey("point")],
      },
    });
    await filters.refreshAnalysis();

    expect(getValues).not.toHaveBeenCalled();
    expect(filters.analysisGateIds.p1).toEqual(["b"]);
    expect(filters.filteredAnnotations.map((x: any) => x.id)).toEqual(["b"]);
  });

  it("leaves gate ids untouched when the value fetch fails", async () => {
    // Resolving against an empty map marks every property gate
    // resolved-with-zero-matches, hiding the entire dataset after a blip.
    getValues.mockResolvedValue([
      { annotationId: "a", values: { prop: { Area: 5 } } },
    ]);
    await addPlot("p1", GATE);
    await filters.refreshAnalysis();
    expect(filters.analysisGateIds.p1).toEqual(["a"]);

    // Widen the visible display scope with an ungated property plot. That needs
    // another path fetch, but it does not change the population or values the
    // existing gate was resolved against.
    await filters.addAnalysisPlot("display-only");
    await filters.setAnalysisPlotAxes({
      id: "display-only",
      xAxis: OTHER_AXIS,
      yAxis: OTHER_AXIS,
    });
    filters.setAnalysisPanelOpen(true);
    getValues.mockRejectedValueOnce(new Error("network"));
    await filters.refreshAnalysis();

    expect(filters.analysisGateIds.p1).toEqual(["a"]); // not []
    expect(filters.filteredAnnotations.map((x: any) => x.id)).toEqual(["a"]);
    expect(filters.analysisLoading).toBe(false);
  });

  it("still resolves a categorical gate when a display-only fetch fails", async () => {
    annotationMock.annotationsForIteration = [
      { ...makeStub("a"), tags: ["keep"], shape: "point" },
      { ...makeStub("b"), tags: ["drop"], shape: "point" },
    ];
    await filters.addAnalysisPlot("gated");
    await filters.setAnalysisPlotAxes({
      id: "gated",
      xAxis: { type: "categorical", key: "tags" },
      yAxis: { type: "categorical", key: "shape" },
    });
    await filters.setAnalysisPlotGate({
      id: "gated",
      gate: {
        categoryKeyVersion: 1,
        vertices: [
          { x: -0.5, y: -0.5 },
          { x: 0.5, y: -0.5 },
          { x: 0.5, y: 0.5 },
          { x: -0.5, y: 0.5 },
        ],
        xCategories: [
          encodeAnalysisCategoryKey(["drop"]),
          encodeAnalysisCategoryKey(["keep"]),
        ],
        yCategories: [encodeAnalysisCategoryKey("point")],
      },
    });
    await filters.addAnalysisPlot("display-only");
    await filters.setAnalysisPlotAxes({
      id: "display-only",
      xAxis: OTHER_AXIS,
      yAxis: OTHER_AXIS,
    });
    filters.setAnalysisPanelOpen(true);
    getValues.mockRejectedValueOnce(new Error("network"));

    await filters.refreshAnalysis();

    expect(filters.analysisGateIds.gated).toEqual(["b"]);
    expect(filters.filteredAnnotations.map((x: any) => x.id)).toEqual(["b"]);
  });

  it("still resolves a visible disabled categorical gate after a display fetch fails", async () => {
    // Visible disabled gates have no filtering signature, but their count and
    // highlight are still derived UI state. A categorical gate needs no cache,
    // so an unrelated property request failure must not block that work.
    annotationMock.annotationsForIteration = [
      { ...makeStub("a"), tags: ["keep"], shape: "point" },
      { ...makeStub("b"), tags: ["drop"], shape: "point" },
    ];
    await filters.addAnalysisPlot("disabled");
    await filters.setAnalysisPlotAxes({
      id: "disabled",
      xAxis: { type: "categorical", key: "tags" },
      yAxis: { type: "categorical", key: "shape" },
    });
    await filters.setAnalysisPlotGate({
      id: "disabled",
      gate: {
        categoryKeyVersion: 1,
        vertices: [
          { x: -0.5, y: -0.5 },
          { x: 0.5, y: -0.5 },
          { x: 0.5, y: 0.5 },
          { x: -0.5, y: 0.5 },
        ],
        xCategories: [
          encodeAnalysisCategoryKey(["drop"]),
          encodeAnalysisCategoryKey(["keep"]),
        ],
        yCategories: [encodeAnalysisCategoryKey("point")],
      },
    });
    await filters.toggleAnalysisPlotGateEnabled("disabled");
    await filters.addAnalysisPlot("display-only");
    await filters.setAnalysisPlotAxes({
      id: "display-only",
      xAxis: OTHER_AXIS,
      yAxis: OTHER_AXIS,
    });
    filters.setAnalysisPanelOpen(true);
    getValues.mockRejectedValueOnce(new Error("network"));

    await filters.refreshAnalysis();

    expect(filters.analysisGateIds.disabled).toEqual(["b"]);
    expect(filters.filteredAnnotations).toHaveLength(2);
  });

  it("uses cached gate paths when a widened display fetch fails", async () => {
    getValues.mockResolvedValue([
      { annotationId: "a", values: { prop: { Area: 5 } } },
    ]);
    await addPlot("gated", GATE);
    await filters.refreshAnalysis();
    expect(filters.analysisGateIds.gated).toEqual(["a"]);

    await filters.addAnalysisPlot("display-only");
    await filters.setAnalysisPlotAxes({
      id: "display-only",
      xAxis: OTHER_AXIS,
      yAxis: OTHER_AXIS,
    });
    filters.setAnalysisPanelOpen(true);
    await filters.setAnalysisPlotGate({
      id: "gated",
      gate: { ...GATE, vertices: [...GATE.vertices] },
    });
    expect(filters.analysisGateIds.gated).toBeUndefined();
    getValues.mockRejectedValueOnce(new Error("network"));

    await filters.refreshAnalysis();

    expect(filters.analysisGateIds.gated).toEqual(["a"]);
    expect(filters.filteredAnnotations.map((x: any) => x.id)).toEqual(["a"]);
  });

  it("does not resolve a visible disabled gate from missing retained paths", async () => {
    // The enabled gate's values are retained from hidden mode. Opening the
    // panel widens the request to a disabled gate on another property; if that
    // request fails, the fallback may still resolve the enabled gate, but it
    // must not publish [] for the disabled gate from a map lacking its path.
    getValues.mockResolvedValueOnce([
      { annotationId: "a", values: { prop: { Area: 5 } } },
    ]);
    await addPlot("active", GATE);
    await filters.refreshAnalysis();
    expect(filters.analysisGateIds.active).toEqual(["a"]);

    await filters.addAnalysisPlot("disabled");
    await filters.setAnalysisPlotAxes({
      id: "disabled",
      xAxis: OTHER_AXIS,
      yAxis: OTHER_AXIS,
    });
    await filters.setAnalysisPlotGate({ id: "disabled", gate: GATE });
    await filters.toggleAnalysisPlotGateEnabled("disabled");
    filters.setAnalysisPanelOpen(true);
    getValues.mockRejectedValueOnce(new Error("network"));

    await filters.refreshAnalysis();

    expect(filters.analysisGateIds.active).toEqual(["a"]);
    expect(filters.analysisGateIds.disabled).toBeUndefined();
    expect(filters.filteredAnnotations.map((x: any) => x.id)).toEqual(["a"]);
  });

  it("invalidates a visible disabled property gate before a changed-value fetch can fail", async () => {
    // Disabled gates do not filter, but their visible count/highlight is still
    // derived state. Its validity must therefore follow the visible resolution
    // scope even when there is no enabled-gate signature at all.
    filters.setAnalysisPanelOpen(true);
    getValues.mockResolvedValueOnce([
      { annotationId: "a", values: { prop: { Area: 5 } } },
    ]);
    await addPlot("disabled", GATE);
    await filters.toggleAnalysisPlotGateEnabled("disabled");
    await filters.refreshAnalysis();
    expect(filters.analysisGateIds.disabled).toEqual(["a"]);

    propertiesMock.propertyValuesRevision += 1;
    getValues.mockRejectedValueOnce(new Error("network"));
    await filters.refreshAnalysis();

    expect(filters.analysisGateIds.disabled).toBeUndefined();
    expect(filters.filteredAnnotations).toHaveLength(2);
  });

  it("preserves active gate ids while a changed visible-only scope is loading", async () => {
    // The visible identity is deliberately separate from the enabled-gate
    // identity. Opening the panel may add a disabled plot to the fetch, but it
    // must not temporarily unfilter the viewer while that wider request runs.
    getValues.mockResolvedValueOnce([
      { annotationId: "a", values: { prop: { Area: 5 } } },
    ]);
    await addPlot("active", GATE);
    await filters.refreshAnalysis();
    expect(filters.analysisGateIds.active).toEqual(["a"]);

    await filters.addAnalysisPlot("disabled");
    await filters.setAnalysisPlotAxes({
      id: "disabled",
      xAxis: OTHER_AXIS,
      yAxis: OTHER_AXIS,
    });
    await filters.setAnalysisPlotGate({ id: "disabled", gate: GATE });
    await filters.toggleAnalysisPlotGateEnabled("disabled");
    filters.setAnalysisPanelOpen(true);
    const widenedValues = deferred<any[]>();
    getValues.mockReturnValueOnce(widenedValues.promise as any);

    const refresh = filters.refreshAnalysis();
    expect(filters.analysisGateIds.active).toEqual(["a"]);
    expect(filters.analysisGateIds.disabled).toBeUndefined();
    expect(filters.filteredAnnotations.map((x: any) => x.id)).toEqual(["a"]);

    widenedValues.resolve([
      {
        annotationId: "a",
        values: { prop: { Area: 5 }, other: { Intensity: 5 } },
      },
    ]);
    await refresh;
    expect(filters.analysisGateIds.active).toEqual(["a"]);
    expect(filters.analysisGateIds.disabled).toEqual(["a"]);
  });

  it("drops gate ids before a changed-population fetch can fail", async () => {
    annotationMock.annotationsForIteration = [
      makeStub("a"),
      makeStub("b"),
      makeStub("newly-eligible"),
    ];
    filters.newAnnotationIdFilter(["a", "b"]);
    getValues.mockResolvedValue([
      { annotationId: "a", values: { prop: { Area: 5 } } },
    ]);
    await addPlot("p1", GATE);
    await filters.refreshAnalysis();
    expect(filters.analysisGateIds.p1).toEqual(["a"]);

    // Removing a non-gate filter expands the reactive base population.
    filters.removeAnnotationIdFilter("Annotation List Filter 0");
    getValues.mockRejectedValueOnce(new Error("network"));
    await filters.refreshAnalysis();

    expect(filters.analysisGateIds.p1).toBeUndefined();
    expect(filters.filteredAnnotations).toHaveLength(3);
    expect(filters.analysisLoading).toBe(false);
  });

  it("reuses resolved values instead of refetching on palette toggles", async () => {
    getValues.mockResolvedValue([
      { annotationId: "a", values: { prop: { Area: 5 } } },
    ]);
    await addPlot("p1", GATE);
    await filters.refreshAnalysis();
    expect(getValues).toHaveBeenCalledTimes(1);
    const closedSignature = filters.analysisInputSignature;

    filters.setAnalysisPanelOpen(true);
    expect(filters.analysisInputSignature).toBe(closedSignature);
    await filters.refreshAnalysis();
    filters.setAnalysisPanelOpen(false);
    expect(filters.analysisInputSignature).toBe(closedSignature);
    await filters.refreshAnalysis();

    expect(getValues).toHaveBeenCalledTimes(1);
    expect(filters.analysisGateIds.p1).toEqual(["a"]);
  });

  it("invalidates an in-flight request before bailing out", async () => {
    // The token used to advance only on the non-bailout path, so a bail-out
    // could clear the gate and then let the older request commit ids resolved
    // against inputs that no longer apply, reactivating a filter that is off.
    const gateValues = deferred<any[]>();
    getValues.mockReturnValueOnce(gateValues.promise as any);
    await addPlot("p1", GATE);
    const inFlight = filters.refreshAnalysis();

    // Clear the gate while that request is pending: nothing left to resolve.
    await filters.setAnalysisPlotGate({ id: "p1", gate: null });
    await filters.refreshAnalysis();
    expect(filters.analysisGateIds).toEqual({});

    // The stale request resolves last and must NOT reinstate a gate.
    gateValues.resolve([{ annotationId: "a", values: { prop: { Area: 5 } } }]);
    await inFlight;
    expect(filters.analysisGateIds).toEqual({});
    expect(filters.filteredAnnotations).toHaveLength(2);
  });

  it("resolves via the server above the point cap, without fetching values", async () => {
    // SERVER_GATING.md Phase 1: the cap no longer disables gating — it
    // routes resolution to the gate_ids endpoint. Property values are
    // display data and are NOT fetched above the cap.
    annotationMock.annotationsForIteration = Array.from(
      { length: 50001 },
      (_, i) => makeStub(`id-${i}`),
    );
    fetchAnalysisGateIds.mockResolvedValueOnce({ p1: ["id-3", "id-7"] });
    await addPlot("p1", GATE);
    await filters.refreshAnalysis();
    expect(getValues).not.toHaveBeenCalled();
    expect(fetchAnalysisGateIds).toHaveBeenCalledWith("ds1", [
      { id: "p1", xAxis: AXIS, yAxis: AXIS, gate: GATE },
    ]);
    expect(filters.analysisGateIds).toEqual({ p1: ["id-3", "id-7"] });
    // Pure server ids compose client-side exactly like resolved gates.
    expect(filters.filteredAnnotations.map((a: any) => a.id)).toEqual([
      "id-3",
      "id-7",
    ]);
  });

  it("stops collecting an over-cap population before hashing its tail", async () => {
    const untouched = makeStub("must-not-touch");
    Object.defineProperty(untouched, "id", {
      get() {
        throw new Error("walked past the analysis point cap");
      },
    });
    annotationMock.annotationsForIteration = [
      ...Array.from({ length: 50001 }, (_, i) => makeStub(`id-${i}`)),
      untouched,
    ];
    fetchAnalysisGateIds.mockResolvedValueOnce({ p1: [] });
    await addPlot("p1", GATE);

    // The over-cap signature is built from definitions and revisions — it
    // must not hash (or even finish collecting) the population.
    expect(filters.analysisInputSignature.startsWith("server|")).toBe(true);
    await expect(filters.refreshAnalysis()).resolves.toBeUndefined();

    expect(getValues).not.toHaveBeenCalled();
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

  it("hashes every gate id in the signature", async () => {
    // A lasso moved to a different region with the SAME number of objects must
    // still register, or the server-mode list keeps the previous gate's rows.
    await addPlot("p1", GATE);
    filters.setAnalysisGateIds({ p1: ["a", "b"] });
    const before = filters.analysisGateSignature;
    filters.setAnalysisGateIds({ p1: ["c", "d"] });
    expect(filters.analysisGateSignature).not.toBe(before);
  });

  it("omits disabled and ungated plots from the server-list signature", async () => {
    // Only resolved constraints change the list query. Display-only plot edits
    // must not reset page 1 and schedule another server request.
    await addPlot("disabled", GATE);
    filters.setAnalysisGateIds({ disabled: ["a"] });
    await filters.toggleAnalysisPlotGateEnabled("disabled");
    const displayOnlySignature = filters.analysisGateSignature;

    filters.setAnalysisGateIds({ disabled: ["b"] });
    await addPlot("ungated");

    expect(filters.analysisGateSignature).toBe(displayOnlySignature);
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

  it("folds gated categorical content and property revision into its identity", () => {
    // Membership alone left a Tags-axis gate filtering by the old category
    // after a tag edit (ids unchanged), and left every gate stale after a
    // property recompute (values live server-side). Whether those hashes
    // CHANGE on an edit is covered purely in analysisGating.test.ts; what
    // matters here is that they are actually part of the identity — the Vuex
    // getter cache plus a non-reactive mock makes an in-test mutation
    // unobservable, so this asserts the ingredients rather than the reaction.
    const population = [
      { ...makeStub("a"), tags: ["red"], shape: "point" },
      { ...makeStub("b"), tags: ["blue"], shape: "point" },
    ];
    annotationMock.annotationsForIteration = population;
    propertiesMock.propertyValuesRevision = 4242;
    filters.addAnalysisPlot("p1");
    filters.setAnalysisPlotAxes({
      id: "p1",
      xAxis: { type: "categorical", key: "tags" },
      yAxis: AXIS,
    });
    filters.setAnalysisPlotGate({ id: "p1", gate: GATE });

    const signature = filters.analysisInputSignature;
    expect(signature).toContain(
      categoricalContentSignature(population as any, ["tags"]),
    );
    expect(signature).toContain("4242");
    // ...and a different tag really does produce a different ingredient.
    const edited = [{ ...population[0], tags: ["green"] }, population[1]];
    expect(signature).not.toContain(
      categoricalContentSignature(edited as any, ["tags"]),
    );
  });

  it("tracks a visible disabled gate's polygon and categorical inputs", async () => {
    // While visible, disabled gates still show a resolved count/highlight. The
    // scatter reads annotation content directly, so omitting these keys from
    // the watcher signature let the picture move while the gate stayed stale.
    const population = [
      { ...makeStub("a"), tags: ["red"], shape: "point" },
      { ...makeStub("b"), tags: ["blue"], shape: "point" },
    ];
    annotationMock.annotationsForIteration = population;
    await filters.addAnalysisPlot("p1");
    await filters.setAnalysisPlotAxes({
      id: "p1",
      xAxis: { type: "categorical", key: "tags" },
      yAxis: { type: "categorical", key: "shape" },
    });
    await filters.setAnalysisPlotGate({
      id: "p1",
      gate: {
        categoryKeyVersion: 1,
        vertices: [
          { x: -0.5, y: -0.5 },
          { x: 1.5, y: -0.5 },
          { x: 1.5, y: 0.5 },
          { x: -0.5, y: 0.5 },
        ],
        xCategories: [
          encodeAnalysisCategoryKey(["red"]),
          encodeAnalysisCategoryKey(["blue"]),
        ],
        yCategories: [encodeAnalysisCategoryKey("point")],
      },
    });
    await filters.toggleAnalysisPlotGateEnabled("p1");
    filters.setAnalysisPanelOpen(true);

    const before = filters.analysisInputSignature;
    expect(before).not.toBe("idle");
    expect(before).toContain(
      categoricalContentSignature(population as any, ["tags", "shape"]),
    );

    await filters.setAnalysisPlotGate({
      id: "p1",
      gate: {
        ...filters.analysisPlots[0].gate!,
        vertices: [
          ...filters.analysisPlots[0].gate!.vertices,
          { x: -0.25, y: -0.25 },
        ],
      },
    });
    expect(filters.analysisInputSignature).not.toBe(before);

    await filters.refreshAnalysis();
    expect(getValues).not.toHaveBeenCalled();
    expect(filters.analysisGateIds.p1).toBeDefined();
  });

  it("stays idle — and touches nothing — when no gate exists and nobody looks", () => {
    // The content hash and population walk must not run for a dataset with no
    // analysis, or every frame scrub would pay for a feature nobody opened.
    filters.addAnalysisPlot("p1");
    expect(filters.analysisInputSignature).toBe("idle");
  });

  it("drops previous ids on re-lasso and resolves from retained values", async () => {
    // Keeping them meant the plot highlighted the NEW selection while the
    // viewer and the server list still filtered by the old one — and because
    // refreshAnalysis deliberately leaves ids alone when its fetch fails, a
    // failure right after re-lassoing stranded the stale constraint for good.
    getValues.mockResolvedValue([
      { annotationId: "a", values: { prop: { Area: 5 } } },
    ]);
    await addPlot("p1", GATE);
    await filters.refreshAnalysis();
    expect(filters.analysisGateIds.p1).toEqual(["a"]);

    getValues.mockClear();
    // Re-lasso: the mutation must synchronously drop the old constraint.
    await filters.setAnalysisPlotGate({
      id: "p1",
      gate: { ...GATE, vertices: [...GATE.vertices] },
    });
    expect(filters.analysisGateIds.p1).toBeUndefined();

    // The population, property revision and requested paths are unchanged, so
    // the new polygon can resolve from retained values with no request window.
    await filters.refreshAnalysis();

    expect(getValues).not.toHaveBeenCalled();
    expect(filters.analysisGateIds.p1).toEqual(["a"]);
    expect(filters.filteredAnnotations).toHaveLength(1);
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

// Server-side gate resolution above the cap (SERVER_GATING.md, Phase 1).
// The gate is a pure predicate: no population hash, no filter state in the
// signature, invalidation only via the two revision counters.
describe("filters.refreshAnalysis above the cap (server resolution)", () => {
  const AXIS = { type: "property" as const, path: ["prop", "Area"] };
  const GATE = {
    categoryKeyVersion: 1 as const,
    vertices: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ],
    xCategories: null,
    yCategories: null,
  };
  const getValues = propertiesMock.propertiesAPI.getPropertyValuesForIds;

  beforeEach(() => {
    filters.resetFilterState();
    filters.setAnalysisPanelOpen(false);
    fetchAnalysisGateIds.mockReset();
    getValues.mockReset();
    getValues.mockResolvedValue([]);
    propertiesProxy.propertyValuesRevision = 0;
    annotationProxy.contentRevision = 0;
    annotationProxy.stubOnlyMode = false;
    (annotationProxy as any).annotationsForIteration = Array.from(
      { length: 50001 },
      (_, i) => makeStub(`id-${i}`),
    ) as any;
  });

  const addGatedPlot = async (id: string, gate: any = GATE) => {
    await filters.addAnalysisPlot(id);
    await filters.setAnalysisPlotAxes({ id, xAxis: AXIS, yAxis: AXIS });
    await filters.setAnalysisPlotGate({ id, gate });
  };

  it("keeps the signature free of population and filter state", async () => {
    await addGatedPlot("p1");
    const before = filters.analysisInputSignature;
    expect(before.startsWith("server|")).toBe(true);
    // Population content changes (same over-cap size) must not re-key the
    // signature — the pure predicate does not depend on the population.
    (annotationProxy as any).annotationsForIteration = Array.from(
      { length: 50002 },
      (_, i) => makeStub(`other-${i}`),
    ) as any;
    expect(filters.analysisInputSignature).toBe(before);
    // But the revision counters and the gate definition must re-key it.
    annotationProxy.contentRevision++;
    const afterContent = filters.analysisInputSignature;
    expect(afterContent).not.toBe(before);
    propertiesProxy.propertyValuesRevision++;
    const afterValues = filters.analysisInputSignature;
    expect(afterValues).not.toBe(afterContent);
    await filters.setAnalysisPlotGate({
      id: "p1",
      gate: {
        ...GATE,
        vertices: [...GATE.vertices, { x: 0, y: 10 }],
      },
    });
    expect(filters.analysisInputSignature).not.toBe(afterValues);
  });

  it("does not re-request when already resolved under the same inputs", async () => {
    fetchAnalysisGateIds.mockResolvedValue({ p1: ["id-1"] });
    await addGatedPlot("p1");
    await filters.refreshAnalysis();
    expect(fetchAnalysisGateIds).toHaveBeenCalledTimes(1);
    // Palette toggles and unrelated touches re-run the action; the resolved
    // signature short-circuits the request (round-6 lesson).
    await filters.refreshAnalysis();
    expect(fetchAnalysisGateIds).toHaveBeenCalledTimes(1);
  });

  it("keeps same-input ids on a failed retry", async () => {
    fetchAnalysisGateIds.mockResolvedValueOnce({ p1: ["id-1"] });
    await addGatedPlot("p1");
    await filters.refreshAnalysis();
    expect(filters.analysisGateIds).toEqual({ p1: ["id-1"] });
    // Force a re-request under identical inputs by clearing the resolved
    // signature marker via a failed changed-input cycle: instead, simulate
    // an identical-input retry after a transient failure by resetting the
    // resolved ids' signature is NOT possible from outside — so exercise
    // the real path: bump revision (drops ids), fail, then heal.
    annotationProxy.contentRevision++;
    fetchAnalysisGateIds.mockResolvedValueOnce(null);
    await filters.refreshAnalysis();
    // Changed-input failure: ids were dropped before the await and stay
    // dropped — unresolved shows MORE, never stale.
    expect(filters.analysisGateIds).toEqual({});
    // Identical retry (inputs unchanged since the failure) now succeeds.
    fetchAnalysisGateIds.mockResolvedValueOnce({ p1: ["id-2"] });
    await filters.refreshAnalysis();
    expect(filters.analysisGateIds).toEqual({ p1: ["id-2"] });
    // A failure under those SAME inputs must not clear the good ids.
    fetchAnalysisGateIds.mockResolvedValueOnce(null);
    await filters.refreshAnalysis();
    expect(filters.analysisGateIds).toEqual({ p1: ["id-2"] });
  });

  it("discards a stale response that resolves after a newer request", async () => {
    await addGatedPlot("p1");
    const first = deferred<any>();
    fetchAnalysisGateIds.mockReturnValueOnce(first.promise);
    const firstRun = filters.refreshAnalysis();
    // A newer refresh under changed inputs supersedes the in-flight one.
    annotationProxy.contentRevision++;
    fetchAnalysisGateIds.mockResolvedValueOnce({ p1: ["fresh"] });
    await filters.refreshAnalysis();
    expect(filters.analysisGateIds).toEqual({ p1: ["fresh"] });
    first.resolve({ p1: ["stale"] });
    await firstRun;
    expect(filters.analysisGateIds).toEqual({ p1: ["fresh"] });
  });

  it("skips disabled gates while the panel is closed", async () => {
    fetchAnalysisGateIds.mockResolvedValue({ p1: ["id-1"] });
    await addGatedPlot("p1");
    await filters.toggleAnalysisPlotGateEnabled("p1");
    fetchAnalysisGateIds.mockClear();
    await filters.refreshAnalysis();
    expect(fetchAnalysisGateIds).not.toHaveBeenCalled();
    expect(filters.analysisGateIds).toEqual({});
  });

  it("treats an empty server answer as a real match-none constraint", async () => {
    fetchAnalysisGateIds.mockResolvedValue({ p1: [] });
    await addGatedPlot("p1");
    await filters.refreshAnalysis();
    expect(filters.analysisGateIds).toEqual({ p1: [] });
    expect(filters.filteredAnnotations).toEqual([]);
    expect(filters.activeAnalysisGateIdLists).toEqual([[]]);
  });

  it("clears the retained value cache when crossing above the cap", async () => {
    // Below the cap first: values get cached for the scatter.
    (annotationProxy as any).annotationsForIteration = [makeStub("a")] as any;
    getValues.mockResolvedValue([
      { annotationId: "a", values: { prop: { Area: 5 } } },
    ]);
    await addGatedPlot("p1");
    await filters.refreshAnalysis();
    expect(Object.keys(filters.analysisValues)).toEqual(["a"]);
    // Crossing the cap: the cache pins up to 50K values for nothing.
    (annotationProxy as any).annotationsForIteration = Array.from(
      { length: 50001 },
      (_, i) => makeStub(`id-${i}`),
    ) as any;
    fetchAnalysisGateIds.mockResolvedValue({ p1: [] });
    await filters.refreshAnalysis();
    expect(filters.analysisValues).toEqual({});
  });
});

// What the over-cap heatmaps can and cannot reflect (SERVER_GATING.md,
// Phase 2): the serializable filters ride along; inexpressible ones are
// REPORTED, so the panel can say the distribution may over-include. Gate
// resolution is filter-independent and never degrades.
describe("filters.analysisHistogramFilterSpec", () => {
  beforeEach(() => {
    filters.resetFilterState();
    // resetFilterState deliberately preserves the frame toggle (a view
    // preference, not dataset-scoped state) — reset it here.
    filters.setOnlyCurrentFrame(false);
  });

  it("serializes tag, frame, and property filters", () => {
    filters.setTagFilter({
      id: "tagFilter",
      exclusive: true,
      enabled: true,
      tags: ["nucleus"],
    });
    filters.setOnlyCurrentFrame(true);
    addAreaRangeFilter(1, 5);
    const spec = filters.analysisHistogramFilterSpec;
    expect(spec.filters.tags).toEqual({
      values: ["nucleus"],
      exclusive: true,
    });
    expect(spec.filters.location).toEqual({ XY: 0, Z: 0, Time: 0 });
    expect(spec.filters.propertyFilters).toEqual([
      { path: ["p", "Area"], mode: "range", min: 1, max: 5 },
    ]);
    expect(spec.skipped).toEqual([]);
  });

  it("inlines bounded id lists and skips oversized ones with labels", () => {
    filters.newAnnotationIdFilter(["a", "b"]);
    expect(filters.analysisHistogramFilterSpec.filters.idConstraints).toEqual([
      ["a", "b"],
    ]);
    expect(filters.analysisHistogramFilterSpec.skipped).toEqual([]);
    filters.newAnnotationIdFilter(
      Array.from({ length: 50001 }, (_, i) => `big-${i}`),
    );
    const spec = filters.analysisHistogramFilterSpec;
    // Id filters are UNIONED into one constraint, so dropping only the
    // oversized member would shrink the set — under-including. The whole
    // union is dropped instead: the histogram may over-include, never
    // under-include.
    expect(spec.filters.idConstraints).toBeUndefined();
    expect(spec.skipped).toEqual(["object-list filters"]);
  });

  it("reports region filters and the hidden-layer rule as skipped", () => {
    filters.newROIFilter();
    filters.validateNewROIFilter([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
    ]);
    const spec = filters.analysisHistogramFilterSpec;
    expect(spec.skipped).toContain("region (ROI) filters");
    expect(spec.filters.idConstraints).toBeUndefined();
  });

  it("is empty when nothing is active", () => {
    const spec = filters.analysisHistogramFilterSpec;
    expect(spec.filters).toEqual({});
    expect(spec.skipped).toEqual([]);
  });
});

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

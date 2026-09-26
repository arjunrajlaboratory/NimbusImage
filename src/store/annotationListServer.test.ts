/**
 * The overview raster's filter registration (annotationListServer
 * refreshOverviewFilter): one registration per filter state, none without
 * filters, only the latest answer applies, and a failure leaves no key and
 * retries on the next change.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  makeLayer: (overrides: Record<string, unknown> = {}) => ({
    channel: 0,
    visible: true,
    xy: { type: "current", value: null },
    z: { type: "current", value: null },
    time: { type: "current", value: null },
    ...overrides,
  }),
  register: vi.fn(),
  filters: {
    tagFilter: { enabled: false, exclusive: false, tags: [] as string[] },
    onlyCurrentFrame: false,
    propertyFilters: [],
    selectionFilter: { enabled: false, annotationIds: [] as string[] },
    annotationIdFilters: [],
    activeAnalysisGateDefinitions: [] as any[],
    activeAnalysisGateIdLists: [] as string[][],
    hasEmptyResolvedGate: false,
    analysisGateSignature: "",
  },
}));

vi.mock("./index", async () => {
  const main: any = (await import("vue")).reactive({
    xy: 0,
    z: 0,
    time: 0,
    dataset: { id: "ds1" },
    layers: [mocks.makeLayer()],
    showAnnotationsFromHiddenLayers: false,
    annotationsAPI: { registerRasterFilter: mocks.register },
  });
  // The real getter's slice resolution for "current" / "max-merge" slices.
  main.layerSliceIndexes = () => ({
    xyIndex: main.xy,
    zIndex: main.z,
    tIndex: main.time,
  });
  return { default: main };
});
// Reactive, as the real store is: the getters under test are cached Vuex
// getters, which would otherwise never see the filters change.
vi.mock("./filters", async () => ({
  default: (await import("vue")).reactive(mocks.filters),
}));
vi.mock("./properties", async () => ({
  default: (await import("vue")).reactive({ propertyValuesRevision: 0 }),
}));
vi.mock("@/utils/log", () => ({ logError: vi.fn() }));

import annotationListServer from "./annotationListServer";
import filtersStore from "./filters";
import mainStore from "./index";
import propertiesStore from "./properties";

const main = mainStore as any;
const { makeLayer } = mocks;

const setTags = (tags: string[]) => {
  (filtersStore as any).tagFilter = {
    enabled: tags.length > 0,
    exclusive: false,
    tags,
  };
};

describe("overview filter registration", () => {
  beforeEach(() => {
    mocks.register.mockReset();
    setTags([]);
    (filtersStore as any).onlyCurrentFrame = false;
    (filtersStore as any).propertyFilters = [];
    main.xy = 0;
    main.z = 0;
    main.time = 0;
    main.dataset = { id: "ds1" };
    main.layers = [makeLayer()];
    annotationListServer.setOverviewFilter({ key: null, signature: null });
  });

  it("registers nothing without filters, and once per filter state", async () => {
    await annotationListServer.refreshOverviewFilter();
    expect(mocks.register).not.toHaveBeenCalled();
    expect(annotationListServer.overviewFilterKey).toBeNull();

    setTags(["B"]);
    mocks.register.mockResolvedValue("key-b");
    await annotationListServer.refreshOverviewFilter();
    expect(mocks.register).toHaveBeenCalledWith("ds1", {
      tags: { values: ["B"], exclusive: false },
    });
    expect(annotationListServer.overviewFilterKey).toBe("key-b");
    // Unchanged filters: no second registration.
    await annotationListServer.refreshOverviewFilter();
    expect(mocks.register).toHaveBeenCalledTimes(1);
  });

  it("sends small resolved gates as ids and large ones as definitions", async () => {
    const definition = { xAxis: {}, yAxis: {}, gate: {} };
    (filtersStore as any).activeAnalysisGateDefinitions = [definition];
    (filtersStore as any).activeAnalysisGateIdLists = [["a", "b"]];
    expect(annotationListServer.overviewFilters).toEqual({
      idConstraints: [["a", "b"]],
    });
    (filtersStore as any).activeAnalysisGateIdLists = [
      Array.from({ length: 50001 }, (_, i) => `id-${i}`),
    ];
    expect(annotationListServer.overviewFilters).toEqual({
      analysisGates: [definition],
    });
    (filtersStore as any).activeAnalysisGateDefinitions = [];
    (filtersStore as any).activeAnalysisGateIdLists = [];
  });

  it("applies only the latest registration", async () => {
    setTags(["B"]);
    let finishFirst!: (key: string) => void;
    mocks.register.mockReturnValueOnce(
      new Promise((resolve) => {
        finishFirst = resolve;
      }),
    );
    const first = annotationListServer.refreshOverviewFilter();
    setTags(["T"]);
    mocks.register.mockResolvedValueOnce("key-t");
    await annotationListServer.refreshOverviewFilter();
    finishFirst("key-b");
    await first;
    expect(annotationListServer.overviewFilterKey).toBe("key-t");
  });

  it("clears the key on failure so the next change retries", async () => {
    setTags(["B"]);
    mocks.register.mockRejectedValue(new Error("offline"));
    await annotationListServer.refreshOverviewFilter();
    expect(annotationListServer.overviewFilterKey).toBeNull();
    expect(annotationListServer.overviewFilterSignature).toBeNull();
    mocks.register.mockResolvedValue("key-b");
    await annotationListServer.refreshOverviewFilter();
    expect(annotationListServer.overviewFilterKey).toBe("key-b");
  });
  it("keeps the committed key when filters revert while another registers", async () => {
    setTags(["A"]);
    mocks.register.mockResolvedValueOnce("key-a");
    await annotationListServer.refreshOverviewFilter();
    setTags(["B"]);
    let finishB!: (key: string) => void;
    mocks.register.mockReturnValueOnce(
      new Promise((resolve) => {
        finishB = resolve;
      }),
    );
    const pendingB = annotationListServer.refreshOverviewFilter();
    // Back to A: unchanged from the committed state, so no registration...
    setTags(["A"]);
    await annotationListServer.refreshOverviewFilter();
    // ...and B's late answer must not replace A's key.
    finishB("key-b");
    await pendingB;
    expect(mocks.register).toHaveBeenCalledTimes(2);
    expect(annotationListServer.overviewFilterKey).toBe("key-a");
    expect(annotationListServer.activeOverviewFilter?.key).toBe("key-a");
  });

  it("offers no key while a new one is pending or after a dataset switch", async () => {
    setTags(["A"]);
    mocks.register.mockResolvedValueOnce("key-a");
    await annotationListServer.refreshOverviewFilter();
    expect(annotationListServer.activeOverviewFilter?.key).toBe("key-a");
    // Filters moved, registration not yet answered: draw unfiltered rather
    // than with A's passing set.
    setTags(["B"]);
    expect(annotationListServer.activeOverviewFilter).toBeNull();
    setTags(["A"]);
    expect(annotationListServer.activeOverviewFilter?.key).toBe("key-a");
    // A key belongs to one dataset: the new dataset's tiles must not carry
    // it (they would 404 and retry).
    main.dataset = { id: "ds2" };
    expect(annotationListServer.activeOverviewFilter).toBeNull();
  });

  it("versions the tiles by the property-value revision under a property filter", async () => {
    setTags(["A"]);
    mocks.register.mockResolvedValue("key-a");
    await annotationListServer.refreshOverviewFilter();
    const tagOnly = annotationListServer.activeOverviewFilter!.version;
    (propertiesStore as any).propertyValuesRevision += 1;
    // No property filter: a recompute cannot move the passing set.
    expect(annotationListServer.activeOverviewFilter!.version).toBe(tagOnly);

    (filtersStore as any).propertyFilters = [
      {
        propertyPath: ["p", "area"],
        valuesOrRange: "range",
        range: { min: 1, max: 5 },
        enabled: true,
      },
    ];
    await annotationListServer.refreshOverviewFilter();
    const before = annotationListServer.activeOverviewFilter!;
    (propertiesStore as any).propertyValuesRevision += 1;
    const after = annotationListServer.activeOverviewFilter!;
    // Same key (no re-registration), new tile version.
    expect(mocks.register).toHaveBeenCalledTimes(2);
    expect(after.key).toBe(before.key);
    expect(after.version).not.toBe(before.version);
  });

  it("leaves the frame out when every drawn layer pins the current frame", () => {
    (filtersStore as any).onlyCurrentFrame = true;
    main.z = 3;
    expect(annotationListServer.overviewFilters).toEqual({});
    const signature = annotationListServer.overviewFiltersSignature;
    main.z = 4;
    // A frame change keeps the committed key valid.
    expect(annotationListServer.overviewFiltersSignature).toBe(signature);

    // A projected (max-merge) layer draws every Z, so the filter must narrow.
    main.layers = [makeLayer({ z: { type: "max-merge", value: null } })];
    expect(annotationListServer.overviewFilters).toEqual({
      location: { XY: 0, Z: 4, Time: 0 },
    });
  });
});

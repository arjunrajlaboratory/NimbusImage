import { describe, it, expect, vi, beforeEach } from "vitest";

// Exercise the real properties module in isolation by mocking the stores and
// utilities it reaches. ./root stays real — the dynamic module registers on it.
const {
  getPropertyValuesForIds,
  getPropertyValues,
  getPropertyValuesSample,
  getUncomputedCounts,
  annotationMock,
} = vi.hoisted(() => ({
  getPropertyValuesForIds: vi.fn(),
  getPropertyValues: vi.fn(),
  getPropertyValuesSample: vi.fn(),
  getUncomputedCounts: vi.fn(),
  annotationMock: {
    stubOnlyMode: true,
    visibleAnnotationIds: new Set<string>(),
  },
}));

vi.mock("@/store/index", () => ({
  default: {
    dataset: { id: "ds1" },
    isLoggedIn: true,
    propertiesAPI: {
      getPropertyValuesForIds: (...a: any[]) => getPropertyValuesForIds(...a),
      getPropertyValues: (...a: any[]) => getPropertyValues(...a),
      getPropertyValuesSample: (...a: any[]) => getPropertyValuesSample(...a),
      getUncomputedCounts: (...a: any[]) => getUncomputedCounts(...a),
    },
    scheduleAnnotationBrowserSave: () => {},
  },
}));

vi.mock("@/store/annotation", () => ({
  default: annotationMock,
}));

vi.mock("@/store/jobs", () => ({
  default: {},
  createProgressEventCallback: vi.fn(),
  createErrorEventCallback: vi.fn(),
}));

vi.mock("@/store/progress", () => ({
  default: { create: vi.fn(), complete: vi.fn() },
}));

vi.mock("@/utils/log", () => ({
  logError: vi.fn(),
  logWarning: vi.fn(),
}));

vi.mock("geojs", () => ({
  default: { util: {} },
}));

import properties from "@/store/properties";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("resetPropertyState (Finding 7)", () => {
  it("clears discoveredPropertyPaths along with the other per-dataset paths", () => {
    properties.setDiscoveredPropertyPaths([["propA"], ["propB"]]);
    expect(properties.discoveredPropertyPaths.length).toBe(2);

    properties.resetPropertyState();

    expect(properties.discoveredPropertyPaths).toEqual([]);
  });
});

describe("ensureVisiblePropertyValues stale guard (Finding 6)", () => {
  beforeEach(() => {
    getPropertyValuesForIds.mockReset();
    properties.setDiscoveredPropertyPaths([]);
    properties.resetPropertyState();
    // resetPropertyState intentionally does not clear propertyValues; clear it
    // here so each case starts from an empty cache.
    properties.mergeVisiblePropertyValues({
      newEntries: [],
      keepIds: new Set(),
    });
    // Display one property path so visible ids count as "missing" and a fetch
    // is triggered.
    properties.togglePropertyPathVisibility(["propA"]);
    annotationMock.stubOnlyMode = true;
  });

  it("does not let a slow earlier fetch overwrite a newer fetch scoped to a different visible set", async () => {
    const first = deferred<any[]>();
    const second = deferred<any[]>();
    getPropertyValuesForIds
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    // Fetch A for visible set {a}.
    annotationMock.visibleAnnotationIds = new Set(["a"]);
    properties.ensureVisiblePropertyValues();

    // Visible set changes to {b}; fetch B starts while A is still in flight.
    annotationMock.visibleAnnotationIds = new Set(["b"]);
    properties.ensureVisiblePropertyValues();

    // The newer fetch (B) resolves first and merges its entry.
    second.resolve([{ annotationId: "b", values: { propA: 2 } }]);
    await flush();
    expect(properties.propertyValues).toEqual({ b: { propA: 2 } });

    // The stale earlier fetch (A) resolves last. Without the guard it would
    // merge scoped to {a}, pruning b. With the guard it is dropped.
    first.resolve([{ annotationId: "a", values: { propA: 1 } }]);
    await flush();
    expect(properties.propertyValues).toEqual({ b: { propA: 2 } });
  });

  it("applies the latest fetch result", async () => {
    const only = deferred<any[]>();
    getPropertyValuesForIds.mockReturnValueOnce(only.promise);
    annotationMock.visibleAnnotationIds = new Set(["a"]);
    properties.ensureVisiblePropertyValues();
    only.resolve([{ annotationId: "a", values: { propA: 9 } }]);
    await flush();
    expect(properties.propertyValues).toEqual({ a: { propA: 9 } });
  });
});

// Phase 2 invariant (see codebaseDocumentation/PROPERTY_VALUE_SCALING.md):
// in lazy mode nothing may pull the whole dataset's property values into
// memory. fetchPropertyValues is the single entry every caller uses (dataset
// mount, import, compute completion, agent tools), so pinning it here pins the
// invariant for all of them. The wholesale loader must remain reachable only
// from the non-lazy branch.
describe("fetchPropertyValues never loads wholesale in lazy mode", () => {
  beforeEach(() => {
    getPropertyValues.mockReset();
    getPropertyValuesSample.mockReset();
    getPropertyValuesForIds.mockReset();
    getUncomputedCounts.mockReset();
    getPropertyValuesSample.mockResolvedValue([]);
    getPropertyValues.mockResolvedValue({});
    getPropertyValuesForIds.mockResolvedValue([]);
    getUncomputedCounts.mockResolvedValue({});
    properties.resetPropertyState();
  });

  it("samples paths instead of loading every value in lazy mode", async () => {
    annotationMock.stubOnlyMode = true;
    annotationMock.visibleAnnotationIds = new Set(["a"]);

    await properties.fetchPropertyValues();
    await flush();

    expect(getPropertyValues).not.toHaveBeenCalled();
    expect(getPropertyValuesSample).toHaveBeenCalled();
  });

  it("still loads every value in wholesale mode", async () => {
    annotationMock.stubOnlyMode = false;

    await properties.fetchPropertyValues();

    expect(getPropertyValues).toHaveBeenCalledWith("ds1");
    expect(getPropertyValuesSample).not.toHaveBeenCalled();
  });

  it("fetches only the visible ids' values in lazy mode", async () => {
    annotationMock.stubOnlyMode = true;
    annotationMock.visibleAnnotationIds = new Set(["a", "b"]);
    properties.togglePropertyPathVisibility(["propA"]);

    await properties.fetchPropertyValues();
    await flush();

    expect(getPropertyValues).not.toHaveBeenCalled();
    expect(getPropertyValuesForIds).toHaveBeenCalledWith(
      "ds1",
      ["a", "b"],
      [["propA"]],
    );
  });
});

// Values for a bounded id set other than the viewport's (3D segmentation
// coloring, agent analysis). Must not disturb the visible-set cache, and must
// reuse what the cache already holds.
describe("fetchValuesForIds", () => {
  beforeEach(() => {
    getPropertyValuesForIds.mockReset();
    getPropertyValuesForIds.mockResolvedValue([]);
    properties.resetPropertyState();
    properties.mergeVisiblePropertyValues({
      newEntries: [],
      keepIds: new Set(),
    });
    annotationMock.stubOnlyMode = true;
  });

  it("fetches the requested ids and returns them as a map", async () => {
    getPropertyValuesForIds.mockResolvedValue([
      { annotationId: "x", values: { propA: 1 } },
      { annotationId: "y", values: { propA: 2 } },
    ]);

    const result = await properties.fetchValuesForIds({
      ids: ["x", "y"],
      paths: [["propA"]],
    });

    expect(getPropertyValuesForIds).toHaveBeenCalledWith(
      "ds1",
      ["x", "y"],
      [["propA"]],
    );
    expect(result).toEqual({ x: { propA: 1 }, y: { propA: 2 } });
  });

  it("does not write the fetched values into the visible-set cache", async () => {
    getPropertyValuesForIds.mockResolvedValue([
      { annotationId: "x", values: { propA: 1 } },
    ]);

    await properties.fetchValuesForIds({ ids: ["x"], paths: [["propA"]] });

    expect(properties.propertyValues).toEqual({});
  });

  it("reuses cached values and requests only the missing ids", async () => {
    // Seed the visible cache with one of the two requested ids.
    properties.mergeVisiblePropertyValues({
      newEntries: [{ annotationId: "cached", values: { propA: 7 } }],
      keepIds: new Set(["cached"]),
    });
    getPropertyValuesForIds.mockResolvedValue([
      { annotationId: "missing", values: { propA: 8 } },
    ]);

    const result = await properties.fetchValuesForIds({
      ids: ["cached", "missing"],
      paths: [["propA"]],
    });

    expect(getPropertyValuesForIds).toHaveBeenCalledWith(
      "ds1",
      ["missing"],
      [["propA"]],
    );
    expect(result).toEqual({
      cached: { propA: 7 },
      missing: { propA: 8 },
    });
  });

  it("returns the resident map without a request in wholesale mode", async () => {
    annotationMock.stubOnlyMode = false;
    properties.updatePropertyValues({ all: { propA: 3 } });

    const result = await properties.fetchValuesForIds({
      ids: ["all"],
      paths: [["propA"]],
    });

    expect(getPropertyValuesForIds).not.toHaveBeenCalled();
    expect(result).toEqual({ all: { propA: 3 } });
  });

  it("makes no request for an empty id or path set", async () => {
    expect(
      await properties.fetchValuesForIds({ ids: [], paths: [["propA"]] }),
    ).toEqual({});
    expect(
      await properties.fetchValuesForIds({ ids: ["x"], paths: [] }),
    ).toEqual({});
    expect(getPropertyValuesForIds).not.toHaveBeenCalled();
  });
});

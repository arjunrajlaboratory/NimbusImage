import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Exercise the real properties module in isolation by mocking the stores and
// utilities it reaches. ./root stays real — the dynamic module registers on it.
const {
  getPropertyValuesForIds,
  getPropertyValues,
  annotationMock,
  scheduleBrowserSave,
} = vi.hoisted(() => ({
  getPropertyValuesForIds: vi.fn(),
  getPropertyValues: vi.fn(),
  scheduleBrowserSave: vi.fn(),
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
      getPropertyValuesSample: async () => [],
    },
    scheduleAnnotationBrowserSave: scheduleBrowserSave,
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
import main from "@/store/index";

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

describe("displayed property path batching", () => {
  beforeEach(() => {
    scheduleBrowserSave.mockReset();
    properties.hydrateDisplayedPropertyPaths([]);
  });

  it("shows many paths with one mutation/save and caps the result at 100", async () => {
    const paths = Array.from({ length: 150 }, (_, index) => [
      "genes",
      `value-${index}`,
    ]);

    await properties.setPropertyPathsVisibility({ paths, visible: true });

    expect(properties.displayedPropertyPaths).toEqual(paths.slice(0, 100));
    expect(scheduleBrowserSave).toHaveBeenCalledTimes(1);
  });

  it("hides a group with one save instead of one toggle per path", async () => {
    const paths = [["genes", "TCF7"], ["genes", "SELL"], ["area"]];
    properties.hydrateDisplayedPropertyPaths(paths);

    await properties.setPropertyPathsVisibility({
      paths: paths.slice(0, 2),
      visible: false,
    });

    expect(properties.displayedPropertyPaths).toEqual([["area"]]);
    expect(scheduleBrowserSave).toHaveBeenCalledTimes(1);
  });

  it("clamps over-limit paths restored from configuration", () => {
    const paths = Array.from({ length: 120 }, (_, index) => [
      "property",
      String(index),
    ]);

    properties.hydrateDisplayedPropertyPaths(paths);

    expect(properties.displayedPropertyPaths).toEqual(paths.slice(0, 100));
    expect(scheduleBrowserSave).not.toHaveBeenCalled();
  });

  it("rejects a singular addition when the column limit is already full", async () => {
    const paths = Array.from({ length: 100 }, (_, index) => [
      "property",
      String(index),
    ]);
    properties.hydrateDisplayedPropertyPaths(paths);

    await properties.togglePropertyPathVisibility(["property", "overflow"]);

    expect(properties.displayedPropertyPaths).toEqual(paths);
    expect(scheduleBrowserSave).not.toHaveBeenCalled();
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

// The Connections tab's lazy track-label fetcher gates on this readiness
// signal: without it, a stubOnlyMode flip during dataset load launches a
// batch that the revision bump (fetchPropertyValues' first operation)
// immediately supersedes — one duplicated large query per dataset open.
describe("fetchPropertyValues readiness signal", () => {
  it("records the dataset id alongside the revision bump", async () => {
    const before = properties.propertyValuesRevision;
    await properties.fetchPropertyValues();
    expect(properties.propertyValuesRevision).toBe(before + 1);
    expect(properties.propertyValuesDatasetId).toBe("ds1");
  });

  // refreshDataset() resets property state while the dataset id stays the
  // same, then re-runs fetchPropertyValues. If the reset left the readiness
  // id in place, the gate would already pass before the new revision bump —
  // reopening the duplicate-query window the signal exists to close.
  it("clears the readiness id on a property-state reset", async () => {
    await properties.fetchPropertyValues();
    expect(properties.propertyValuesDatasetId).toBe("ds1");
    properties.resetPropertyState();
    expect(properties.propertyValuesDatasetId).toBeNull();
  });
});

// Issue #1379 follow-up: a dataset switch can overlap two property-value
// loads. The old dataset's load must not commit over the new dataset's, in
// either load path (wholesale or visible-set), nor across the two.
describe("property value loads across a dataset switch", () => {
  const mainMock = main as any;

  beforeEach(() => {
    getPropertyValues.mockReset();
    getPropertyValuesForIds.mockReset();
    mainMock.dataset = { id: "ds1" };
    properties.updatePropertyValues({});
    properties.setDiscoveredPropertyPaths([]);
    properties.hydrateDisplayedPropertyPaths([["propA"]]);
  });

  afterEach(() => {
    mainMock.dataset = { id: "ds1" };
    annotationMock.stubOnlyMode = true;
  });

  it("drops a wholesale load for the old dataset that resolves last", async () => {
    annotationMock.stubOnlyMode = false;
    const oldLoad = deferred<any>();
    getPropertyValues.mockImplementation((datasetId: string) =>
      datasetId === "ds1"
        ? oldLoad.promise
        : Promise.resolve({ b: { propA: 2 } }),
    );

    const first = properties.fetchAllPropertyValues();
    mainMock.dataset = { id: "ds2" };
    await properties.fetchAllPropertyValues();
    oldLoad.resolve({ a: { propA: 1 } });
    await first;

    expect(properties.propertyValues).toEqual({ b: { propA: 2 } });
  });

  it("drops a wholesale load when the dataset changed with no newer load", async () => {
    annotationMock.stubOnlyMode = false;
    const oldLoad = deferred<any>();
    getPropertyValues.mockReturnValue(oldLoad.promise);

    const first = properties.fetchAllPropertyValues();
    mainMock.dataset = { id: "ds2" };
    oldLoad.resolve({ a: { propA: 1 } });
    await first;

    expect(properties.propertyValues).toEqual({});
  });

  it("drops a visible-set fetch for the old dataset after a switch to a wholesale one", async () => {
    // ds1 is lazy: a visible-set fetch starts.
    annotationMock.stubOnlyMode = true;
    annotationMock.visibleAnnotationIds = new Set(["a"]);
    const oldVisible = deferred<any[]>();
    getPropertyValuesForIds.mockReturnValueOnce(oldVisible.promise);
    properties.ensureVisiblePropertyValues();

    // ds2 is wholesale and loads first.
    mainMock.dataset = { id: "ds2" };
    annotationMock.stubOnlyMode = false;
    getPropertyValues.mockResolvedValue({ b: { propA: 2 } });
    await properties.fetchAllPropertyValues();

    // Without the guard this merges ds1's entry and prunes to {a}.
    oldVisible.resolve([{ annotationId: "a", values: { propA: 1 } }]);
    await flush();

    expect(properties.propertyValues).toEqual({ b: { propA: 2 } });
  });

  it("a newer wholesale load of the same dataset wins over an older one", async () => {
    annotationMock.stubOnlyMode = false;
    const older = deferred<any>();
    getPropertyValues
      .mockReturnValueOnce(older.promise)
      .mockResolvedValueOnce({ a: { propA: "new" } });

    const first = properties.fetchAllPropertyValues();
    await properties.fetchAllPropertyValues();
    older.resolve({ a: { propA: "old" } });
    await first;

    expect(properties.propertyValues).toEqual({ a: { propA: "new" } });
  });
});

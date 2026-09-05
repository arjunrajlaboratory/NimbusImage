import { describe, it, expect, vi, beforeEach } from "vitest";

// Exercise the real properties module in isolation by mocking the stores and
// utilities it reaches. ./root stays real — the dynamic module registers on it.
const { getPropertyValuesForIds, annotationMock, scheduleBrowserSave } =
  vi.hoisted(() => ({
    getPropertyValuesForIds: vi.fn(),
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

describe("virtual (spatial table) property paths", () => {
  beforeEach(() => {
    getPropertyValuesForIds.mockReset().mockResolvedValue([]);
    properties.resetPropertyState();
    properties.hydrateDisplayedPropertyPaths([]);
    properties.setVirtualPropertyPaths([]);
    annotationMock.stubOnlyMode = true;
    (annotationMock as any).allAnnotationIds = ["a1", "a2"];
  });

  it("answers for the spatial pseudo-property and names its paths", () => {
    const pseudo = properties.getPropertyById("spatial");
    expect(pseudo?.name).toBe("Spatial table");
    expect(properties.getFullNameFromPath(["spatial", "CD3E"])).toBe(
      "Spatial table / CD3E",
    );
    expect(properties.getPropertyById("nope")).toBeNull();
  });

  it("adds live columns: shown, listed among computed paths, and fetched below the stub threshold", async () => {
    annotationMock.stubOnlyMode = false;
    getPropertyValuesForIds.mockResolvedValue([
      { annotationId: "a1", values: { spatial: { CD3E: 3 } } },
    ]);
    await properties.addVirtualPropertyPaths([["spatial", "CD3E"]]);
    expect(properties.displayedPropertyPaths).toEqual([["spatial", "CD3E"]]);
    expect(properties.computedPropertyPaths).toContainEqual([
      "spatial",
      "CD3E",
    ]);
    expect(getPropertyValuesForIds).toHaveBeenCalledWith(
      "ds1",
      ["a1", "a2"],
      [["spatial", "CD3E"]],
    );
    expect(properties.propertyValues.a1).toEqual({ spatial: { CD3E: 3 } });
  });

  it("keeps earlier live columns when a sibling column is fetched later", async () => {
    annotationMock.stubOnlyMode = false;
    getPropertyValuesForIds
      .mockResolvedValueOnce([
        { annotationId: "a1", values: { spatial: { CD3E: 3 } } },
      ])
      .mockResolvedValueOnce([
        { annotationId: "a1", values: { spatial: { MS4A1: 5 } } },
      ]);

    await properties.addVirtualPropertyPaths([["spatial", "CD3E"]]);
    await properties.addVirtualPropertyPaths([["spatial", "MS4A1"]]);

    expect(properties.propertyValues.a1).toEqual({
      spatial: { CD3E: 3, MS4A1: 5 },
    });
  });

  it("does not fetch wholesale in stub-only mode (the visible fetch handles it)", async () => {
    await properties.addVirtualPropertyPaths([["spatial", "MS4A1"]]);
    expect(getPropertyValuesForIds).not.toHaveBeenCalled();
    expect(properties.allVirtualPropertyPaths).toEqual([["spatial", "MS4A1"]]);
  });

  it("keeps a displayed virtual column across a reload and can remove it", async () => {
    // A persisted configuration restores displayed paths; the virtual set
    // starts empty but the union still lists the column.
    properties.hydrateDisplayedPropertyPaths([["spatial", "CD19"]]);
    expect(properties.allVirtualPropertyPaths).toEqual([["spatial", "CD19"]]);
    expect(properties.computedPropertyPaths).toContainEqual([
      "spatial",
      "CD19",
    ]);
    properties.removeVirtualPropertyPath(["spatial", "CD19"]);
    expect(properties.displayedPropertyPaths).toEqual([]);
    expect(properties.allVirtualPropertyPaths).toEqual([]);
  });
});

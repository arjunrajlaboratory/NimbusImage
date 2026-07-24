import { describe, it, expect, vi, beforeEach } from "vitest";

// Exercise the real properties module in isolation by mocking the stores and
// utilities it reaches. ./root stays real — the dynamic module registers on it.
const { getPropertyValuesForIds, annotationMock } = vi.hoisted(() => ({
  getPropertyValuesForIds: vi.fn(),
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

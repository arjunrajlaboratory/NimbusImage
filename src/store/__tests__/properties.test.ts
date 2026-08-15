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

// The pruner runs from a global watcher on propertyValues, and any later
// annotation-browser change persists the pruned list into the configuration —
// so a wrong prune here silently and permanently drops saved columns (#1326).
describe("updateDisplayedFromComputedProperties in lazy mode", () => {
  const setProperties = (ids: string[]) =>
    (
      properties as unknown as {
        setPropertiesImpl: (props: { id: string; name: string }[]) => void;
      }
    ).setPropertiesImpl(ids.map((id) => ({ id, name: id })));

  beforeEach(() => {
    properties.resetPropertyState();
    setProperties([]);
    annotationMock.stubOnlyMode = true;
  });

  it("keeps a displayed path that the sampled discovery missed", () => {
    // Only propA appeared in the bounded value-doc sample; propB is computed
    // for the dataset but sits outside it.
    setProperties(["propA", "propB"]);
    properties.setDiscoveredPropertyPaths([["propA", "Area"]]);
    properties.hydrateDisplayedPropertyPaths([
      ["propA", "Area"],
      ["propB", "MeanIntensity"],
    ]);

    properties.updateDisplayedFromComputedProperties();

    expect(properties.displayedPropertyPaths).toEqual([
      ["propA", "Area"],
      ["propB", "MeanIntensity"],
    ]);
  });

  it("prunes a path whose property left the configuration", () => {
    setProperties(["propA"]);
    properties.setDiscoveredPropertyPaths([["propA", "Area"]]);
    properties.hydrateDisplayedPropertyPaths([
      ["propA", "Area"],
      ["deletedProp", "Area"],
    ]);

    properties.updateDisplayedFromComputedProperties();

    expect(properties.displayedPropertyPaths).toEqual([["propA", "Area"]]);
  });

  it("keeps hydrated paths while the property list has not loaded yet", () => {
    properties.hydrateDisplayedPropertyPaths([["propA", "Area"]]);

    properties.updateDisplayedFromComputedProperties();

    expect(properties.displayedPropertyPaths).toEqual([["propA", "Area"]]);
  });

  it("does not replace the array when nothing is pruned", () => {
    // The array identity is a reactive dependency (AnnotationViewer refetches
    // visible values on it), and this runs on every viewport value merge.
    setProperties(["propA"]);
    properties.setDiscoveredPropertyPaths([["propA", "Area"]]);
    properties.hydrateDisplayedPropertyPaths([["propA", "Area"]]);
    const before = properties.displayedPropertyPaths;

    properties.updateDisplayedFromComputedProperties();

    expect(properties.displayedPropertyPaths).toBe(before);
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

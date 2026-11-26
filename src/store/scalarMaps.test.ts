import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  listMaps: vi.fn(),
  deleteMap: vi.fn(),
  getColorByPropertyOptions: vi.fn(),
  logWarning: vi.fn(),
  main: null as any,
}));

// Reactive, like the real store: currentMaps is cached on main.dataset.
vi.mock("@/store/index", async () => {
  const { reactive } = await import("vue");
  mocks.main = reactive({
    dataset: { id: "ds1" } as { id: string } | null,
    scalarMapAPI: {
      listMaps: (...a: any[]) => mocks.listMaps(...a),
      deleteMap: (...a: any[]) => mocks.deleteMap(...a),
    },
    annotationsAPI: {
      getColorByPropertyOptions: (...a: any[]) =>
        mocks.getColorByPropertyOptions(...a),
    },
  });
  return { default: mocks.main };
});

vi.mock("@/utils/log", () => ({
  logError: vi.fn(),
  logWarning: (...a: any[]) => mocks.logWarning(...a),
}));

import scalarMapsStore, {
  DEFAULT_SCALAR_MAP_OPACITY,
  defaultScalarMapDisplay,
} from "./scalarMaps";

function scalarMap(
  itemId: string,
  valueRange: [number, number] = [0, 200],
  revision = "r1",
) {
  return {
    itemId,
    updated: "2026-11-01",
    revision,
    meta: {
      version: 1,
      toolId: "t",
      name: itemId,
      property: "Area",
      statistic: "Mean",
      cutoff: null,
      cellTags: ["cell"],
      radius: 50,
      radiusUnit: "µm",
      gridSpacingPx: 12.5,
      originPx: [0, 0] as [number, number],
      shape: [4, 4] as [number, number],
      locations: [{ XY: 0, Z: 0, Time: 0, key: "xy0_z0_t0" }],
      valueRange,
      percentiles: Array.from(
        { length: 101 },
        (_, i) => valueRange[0] + ((valueRange[1] - valueRange[0]) * i) / 100,
      ),
      units: "µm²",
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const ids = () => scalarMapsStore.currentMaps.map((map) => map.itemId);

describe("scalarMaps store", () => {
  beforeEach(async () => {
    mocks.main.dataset = { id: "ds1" };
    mocks.listMaps.mockReset().mockResolvedValue([scalarMap("a")]);
    mocks.deleteMap.mockReset().mockResolvedValue(undefined);
    mocks.logWarning.mockReset();
    // Settle and invalidate anything a previous test left in flight.
    mocks.main.dataset = null;
    await scalarMapsStore.refreshMaps();
    mocks.main.dataset = { id: "ds1" };
    scalarMapsStore.setError(null);
    scalarMapsStore.setLoading(false);
  });

  it("lists the dataset's maps with default display settings", async () => {
    await scalarMapsStore.refreshMaps();
    expect(mocks.listMaps).toHaveBeenCalledWith("ds1");
    expect(scalarMapsStore.hasMaps).toBe(true);
    expect(scalarMapsStore.display.a).toEqual({
      visible: false,
      opacity: DEFAULT_SCALAR_MAP_OPACITY,
      colormap: "viridis",
      min: 0,
      max: 200,
      thresholdEnabled: false,
      // The worker's default, top 20% of tissue.
      threshold: 160,
      thresholdPercent: 20,
      thresholdSide: "above",
    });
    expect(defaultScalarMapDisplay(scalarMap("b", [10, 20])).min).toBe(10);
  });

  it("widens a constant map's default range and its reset range", async () => {
    mocks.listMaps.mockResolvedValueOnce([scalarMap("flat", [4, 4])]);
    await scalarMapsStore.refreshMaps();
    expect(scalarMapsStore.display.flat).toMatchObject({ min: 3.5, max: 4.5 });
    scalarMapsStore.updateDisplay({
      itemId: "flat",
      changes: { min: 3.9, max: 4.1 },
    });
    scalarMapsStore.resetRange("flat");
    expect(scalarMapsStore.display.flat).toMatchObject({ min: 3.5, max: 4.5 });
  });

  it("skips a malformed map instead of losing the list", async () => {
    const broken = { ...scalarMap("bad"), meta: { name: "bad" } };
    mocks.listMaps.mockResolvedValueOnce([broken, scalarMap("good")]);
    await scalarMapsStore.refreshMaps();
    expect(ids()).toEqual(["good"]);
    expect(scalarMapsStore.display.bad).toBeUndefined();
    expect(mocks.logWarning).toHaveBeenCalledTimes(1);
  });

  it("keeps 'could not ask' distinct from 'no maps', and retries", async () => {
    mocks.listMaps.mockRejectedValueOnce(new Error("offline"));
    await scalarMapsStore.refreshMaps();
    expect(scalarMapsStore.error).toContain("Could not read");
    expect(scalarMapsStore.hasMaps).toBe(false);
    mocks.listMaps.mockResolvedValueOnce([]);
    await scalarMapsStore.refreshMaps();
    expect(scalarMapsStore.error).toBeNull();
    expect(scalarMapsStore.hasMaps).toBe(false);
    expect(scalarMapsStore.mapsDatasetId).toBe("ds1");
  });

  it("lists again for every call once the previous one finished", async () => {
    await scalarMapsStore.refreshMaps();
    mocks.listMaps.mockResolvedValueOnce([scalarMap("a"), scalarMap("new")]);
    await scalarMapsStore.refreshMaps();
    expect(mocks.listMaps).toHaveBeenCalledTimes(2);
    expect(ids()).toEqual(["a", "new"]);
  });

  it("shares a request in flight for the same dataset unless forced", async () => {
    const first = deferred<any[]>();
    mocks.listMaps.mockReturnValueOnce(first.promise);
    const opening = scalarMapsStore.refreshMaps();
    const panel = scalarMapsStore.refreshMaps();
    expect(mocks.listMaps).toHaveBeenCalledTimes(1);
    first.resolve([scalarMap("a")]);
    await Promise.all([opening, panel]);
    expect(ids()).toEqual(["a"]);

    // A dataset switch does not share the previous dataset's request.
    const pending = deferred<any[]>();
    mocks.listMaps.mockReturnValueOnce(pending.promise);
    const old = scalarMapsStore.refreshMaps();
    mocks.main.dataset = { id: "ds2" };
    mocks.listMaps.mockResolvedValueOnce([scalarMap("b")]);
    await scalarMapsStore.refreshMaps();
    expect(mocks.listMaps).toHaveBeenLastCalledWith("ds2");
    pending.resolve([scalarMap("a")]);
    await old;
    expect(ids()).toEqual(["b"]);
  });

  it("ignores an answer that lands after a newer (forced) request", async () => {
    const first = deferred<any[]>();
    mocks.listMaps.mockReturnValueOnce(first.promise);
    const stale = scalarMapsStore.refreshMaps();
    mocks.listMaps.mockResolvedValueOnce([scalarMap("new")]);
    await scalarMapsStore.refreshMaps(true);
    first.resolve([scalarMap("old")]);
    await stale;
    expect(ids()).toEqual(["new"]);
    expect(scalarMapsStore.loading).toBe(false);
  });

  it("does not let a request for the previous dataset land after the dataset is cleared", async () => {
    const first = deferred<any[]>();
    mocks.listMaps.mockReturnValueOnce(first.promise);
    const stale = scalarMapsStore.refreshMaps();
    mocks.main.dataset = null;
    // Early return without a dataset still claims the sequence token.
    await scalarMapsStore.refreshMaps();
    mocks.main.dataset = { id: "ds1" };
    first.resolve([scalarMap("old")]);
    await stale;
    expect(scalarMapsStore.maps).toEqual([]);
  });

  it("drops a failure for a request that was superseded", async () => {
    const first = deferred<any[]>();
    mocks.listMaps.mockReturnValueOnce(first.promise);
    const stale = scalarMapsStore.refreshMaps();
    await scalarMapsStore.refreshMaps(true);
    first.reject(new Error("late"));
    await stale;
    expect(scalarMapsStore.error).toBeNull();
  });

  it("resets with the dataset and keeps display settings across a re-list", async () => {
    await scalarMapsStore.refreshMaps();
    scalarMapsStore.updateDisplay({
      itemId: "a",
      changes: { visible: true, colormap: "magma", opacity: 5 },
    });
    expect(scalarMapsStore.display.a.opacity).toBe(1);
    mocks.listMaps.mockResolvedValueOnce([scalarMap("a"), scalarMap("b")]);
    await scalarMapsStore.refreshMaps();
    expect(scalarMapsStore.display.a.colormap).toBe("magma");
    expect(scalarMapsStore.display.b.visible).toBe(false);

    // Another dataset: the old list is not this dataset's.
    mocks.main.dataset = { id: "ds2" };
    expect(scalarMapsStore.currentMaps).toEqual([]);
    expect(scalarMapsStore.hasMaps).toBe(false);
    mocks.listMaps.mockResolvedValueOnce([scalarMap("a")]);
    await scalarMapsStore.refreshMaps();
    expect(mocks.listMaps).toHaveBeenLastCalledWith("ds2");
    // Same item id on the new dataset still starts from defaults.
    expect(scalarMapsStore.display.a.visible).toBe(false);
    expect(scalarMapsStore.display.a.colormap).toBe("viridis");
  });

  it("re-derives range and threshold when a map's file changes, keeping how it is shown", async () => {
    await scalarMapsStore.refreshMaps();
    scalarMapsStore.updateDisplay({
      itemId: "a",
      changes: { visible: true, colormap: "gray", min: 50, max: 60 },
    });
    mocks.listMaps.mockResolvedValueOnce([scalarMap("a", [0, 10], "r2")]);
    await scalarMapsStore.refreshMaps();
    expect(scalarMapsStore.display.a).toMatchObject({
      visible: true,
      colormap: "gray",
      min: 0,
      max: 10,
      threshold: 8,
    });
  });

  it("keeps the requested share and derives the value; setting a value clears it", async () => {
    await scalarMapsStore.refreshMaps();
    scalarMapsStore.setThresholdPercent({ itemId: "a", percent: 30 });
    expect(scalarMapsStore.display.a).toMatchObject({
      thresholdPercent: 30,
      threshold: 140,
    });
    scalarMapsStore.setThresholdSide({ itemId: "a", side: "below" });
    expect(scalarMapsStore.display.a).toMatchObject({
      thresholdPercent: 30,
      threshold: 60,
      thresholdSide: "below",
    });
    scalarMapsStore.setThresholdValue({ itemId: "a", value: 12 });
    expect(scalarMapsStore.display.a).toMatchObject({
      thresholdPercent: null,
      threshold: 12,
    });
    // Set by value, switching sides keeps the value.
    scalarMapsStore.setThresholdSide({ itemId: "a", side: "above" });
    expect(scalarMapsStore.display.a.threshold).toBe(12);
  });

  it("deletes a map and forgets its display; a failed delete keeps it", async () => {
    mocks.listMaps.mockResolvedValueOnce([scalarMap("a"), scalarMap("b")]);
    await scalarMapsStore.refreshMaps();
    await scalarMapsStore.deleteMap("a");
    expect(mocks.deleteMap).toHaveBeenCalledWith("a");
    expect(ids()).toEqual(["b"]);
    expect(scalarMapsStore.display.a).toBeUndefined();

    mocks.deleteMap.mockRejectedValueOnce(new Error("Write access denied"));
    await expect(scalarMapsStore.deleteMap("b")).rejects.toMatchObject({
      message: "Write access denied",
    });
    expect(scalarMapsStore.currentMaps).toHaveLength(1);
  });

  it("does not let a list captured before a delete bring the map back", async () => {
    mocks.listMaps.mockResolvedValueOnce([scalarMap("a"), scalarMap("b")]);
    await scalarMapsStore.refreshMaps();
    const before = deferred<any[]>();
    mocks.listMaps.mockReturnValueOnce(before.promise);
    const stale = scalarMapsStore.refreshMaps();
    // The list after the delete, which the store asks for again.
    mocks.listMaps.mockResolvedValueOnce([scalarMap("b"), scalarMap("c")]);
    await scalarMapsStore.deleteMap("a");
    before.resolve([scalarMap("a"), scalarMap("b")]);
    await stale;
    await vi.waitFor(() => expect(ids()).toEqual(["b", "c"]));
    expect(scalarMapsStore.loading).toBe(false);
  });

  it("loads the legend tables once and retries after a failure", async () => {
    mocks.getColorByPropertyOptions
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ colormaps: { viridis: ["#000", "#fff"] } });
    await scalarMapsStore.ensureColormapStops();
    expect(scalarMapsStore.colormapStops).toBeNull();
    await scalarMapsStore.ensureColormapStops();
    await scalarMapsStore.ensureColormapStops();
    expect(scalarMapsStore.colormapStops).toEqual({
      viridis: ["#000", "#fff"],
    });
    expect(mocks.getColorByPropertyOptions).toHaveBeenCalledTimes(2);
  });
});

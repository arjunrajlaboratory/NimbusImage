import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  listMaps: vi.fn(),
  deleteMap: vi.fn(),
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
  });
  return { default: mocks.main };
});

vi.mock("@/utils/log", () => ({ logError: vi.fn() }));

import scalarMapsStore, {
  DEFAULT_SCALAR_MAP_OPACITY,
  defaultScalarMapDisplay,
} from "./scalarMaps";

function scalarMap(itemId: string, valueRange: [number, number] = [0, 200]) {
  return {
    itemId,
    updated: "2026-11-01",
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

describe("scalarMaps store", () => {
  beforeEach(() => {
    mocks.main.dataset = { id: "ds1" };
    mocks.listMaps.mockReset().mockResolvedValue([scalarMap("a")]);
    mocks.deleteMap.mockReset().mockResolvedValue(undefined);
    scalarMapsStore.setMaps({ datasetId: "", maps: [] });
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
      thresholdSide: "above",
    });
    expect(defaultScalarMapDisplay(scalarMap("b", [10, 20])).min).toBe(10);
  });

  it("keeps 'could not ask' distinct from 'no maps', and retries", async () => {
    mocks.listMaps.mockRejectedValueOnce(new Error("offline"));
    await scalarMapsStore.refreshMaps();
    expect(scalarMapsStore.error).toContain("Could not read");
    expect(scalarMapsStore.hasMaps).toBe(false);
    // ensureMaps retries after a failure.
    mocks.listMaps.mockResolvedValueOnce([]);
    await scalarMapsStore.ensureMaps();
    expect(scalarMapsStore.error).toBeNull();
    expect(scalarMapsStore.hasMaps).toBe(false);
    expect(scalarMapsStore.mapsDatasetId).toBe("ds1");
    // Known and empty: no further request.
    await scalarMapsStore.ensureMaps();
    expect(mocks.listMaps).toHaveBeenCalledTimes(2);
  });

  it("ignores an answer that lands after a newer request", async () => {
    const first = deferred<any[]>();
    mocks.listMaps.mockReturnValueOnce(first.promise);
    const stale = scalarMapsStore.refreshMaps();
    mocks.listMaps.mockResolvedValueOnce([scalarMap("new")]);
    await scalarMapsStore.refreshMaps();
    first.resolve([scalarMap("old")]);
    await stale;
    expect(scalarMapsStore.currentMaps.map((map) => map.itemId)).toEqual([
      "new",
    ]);
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
    await scalarMapsStore.refreshMaps();
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
    await scalarMapsStore.ensureMaps();
    expect(mocks.listMaps).toHaveBeenLastCalledWith("ds2");
    // Same item id on the new dataset still starts from defaults.
    expect(scalarMapsStore.display.a.visible).toBe(false);
    expect(scalarMapsStore.display.a.colormap).toBe("viridis");
  });

  it("deletes a map and forgets its display; a failed delete keeps it", async () => {
    mocks.listMaps.mockResolvedValueOnce([scalarMap("a"), scalarMap("b")]);
    await scalarMapsStore.refreshMaps();
    await scalarMapsStore.deleteMap("a");
    expect(mocks.deleteMap).toHaveBeenCalledWith("a");
    expect(scalarMapsStore.currentMaps.map((map) => map.itemId)).toEqual(["b"]);
    expect(scalarMapsStore.display.a).toBeUndefined();

    mocks.deleteMap.mockRejectedValueOnce(new Error("Write access denied"));
    await expect(scalarMapsStore.deleteMap("b")).rejects.toMatchObject({
      message: "Write access denied",
    });
    expect(scalarMapsStore.currentMaps).toHaveLength(1);
  });

  it("resets a map's range to its value range", async () => {
    await scalarMapsStore.refreshMaps();
    scalarMapsStore.updateDisplay({
      itemId: "a",
      changes: { min: 50, max: 60 },
    });
    scalarMapsStore.resetRange("a");
    expect(scalarMapsStore.display.a.min).toBe(0);
    expect(scalarMapsStore.display.a.max).toBe(200);
  });
});

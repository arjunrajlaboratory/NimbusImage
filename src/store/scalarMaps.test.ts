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
  SCALAR_MAPS_JOB_REFRESH_DELAY_MS,
  defaultScalarMapDisplay,
  scheduleScalarMapsRefresh,
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
    await scalarMapsStore.refreshScalarMaps();
    mocks.main.dataset = { id: "ds1" };
    scalarMapsStore.setScalarMapsError({ datasetId: null, error: null });
    scalarMapsStore.setScalarMapsLoading(false);
  });

  it("lists the dataset's maps with default display settings", async () => {
    await scalarMapsStore.refreshScalarMaps();
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
    await scalarMapsStore.refreshScalarMaps();
    expect(scalarMapsStore.display.flat).toMatchObject({ min: 3.5, max: 4.5 });
    scalarMapsStore.updateScalarMapDisplay({
      itemId: "flat",
      changes: { min: 3.9, max: 4.1 },
    });
    scalarMapsStore.resetScalarMapRange("flat");
    expect(scalarMapsStore.display.flat).toMatchObject({ min: 3.5, max: 4.5 });
  });

  it("skips a malformed map instead of losing the list", async () => {
    const broken = { ...scalarMap("bad"), meta: { name: "bad" } };
    mocks.listMaps.mockResolvedValueOnce([broken, scalarMap("good")]);
    await scalarMapsStore.refreshScalarMaps();
    expect(ids()).toEqual(["good"]);
    expect(scalarMapsStore.display.bad).toBeUndefined();
    expect(mocks.logWarning).toHaveBeenCalledTimes(1);
  });

  it("keeps 'could not ask' distinct from 'no maps', and retries", async () => {
    mocks.listMaps.mockRejectedValueOnce(new Error("offline"));
    await scalarMapsStore.refreshScalarMaps();
    expect(scalarMapsStore.scalarMapsError).toContain("Could not read");
    expect(scalarMapsStore.hasMaps).toBe(false);
    mocks.listMaps.mockResolvedValueOnce([]);
    await scalarMapsStore.refreshScalarMaps();
    expect(scalarMapsStore.scalarMapsError).toBeNull();
    expect(scalarMapsStore.hasMaps).toBe(false);
    expect(scalarMapsStore.mapsDatasetId).toBe("ds1");
  });

  it("lists again for every call once the previous one finished", async () => {
    await scalarMapsStore.refreshScalarMaps();
    mocks.listMaps.mockResolvedValueOnce([scalarMap("a"), scalarMap("new")]);
    await scalarMapsStore.refreshScalarMaps();
    expect(mocks.listMaps).toHaveBeenCalledTimes(2);
    expect(ids()).toEqual(["a", "new"]);
  });

  it("shares a request in flight for the same dataset unless forced", async () => {
    const first = deferred<any[]>();
    mocks.listMaps.mockReturnValueOnce(first.promise);
    const opening = scalarMapsStore.refreshScalarMaps();
    const panel = scalarMapsStore.refreshScalarMaps();
    expect(mocks.listMaps).toHaveBeenCalledTimes(1);
    first.resolve([scalarMap("a")]);
    await Promise.all([opening, panel]);
    expect(ids()).toEqual(["a"]);

    // A dataset switch does not share the previous dataset's request.
    const pending = deferred<any[]>();
    mocks.listMaps.mockReturnValueOnce(pending.promise);
    const old = scalarMapsStore.refreshScalarMaps();
    mocks.main.dataset = { id: "ds2" };
    mocks.listMaps.mockResolvedValueOnce([scalarMap("b")]);
    await scalarMapsStore.refreshScalarMaps();
    expect(mocks.listMaps).toHaveBeenLastCalledWith("ds2");
    pending.resolve([scalarMap("a")]);
    await old;
    expect(ids()).toEqual(["b"]);
  });

  it("ignores an answer that lands after a newer (forced) request", async () => {
    const first = deferred<any[]>();
    mocks.listMaps.mockReturnValueOnce(first.promise);
    const stale = scalarMapsStore.refreshScalarMaps();
    mocks.listMaps.mockResolvedValueOnce([scalarMap("new")]);
    await scalarMapsStore.refreshScalarMaps(true);
    first.resolve([scalarMap("old")]);
    await stale;
    expect(ids()).toEqual(["new"]);
    expect(scalarMapsStore.loading).toBe(false);
  });

  it("does not let a request for the previous dataset land after the dataset is cleared", async () => {
    const first = deferred<any[]>();
    mocks.listMaps.mockReturnValueOnce(first.promise);
    const stale = scalarMapsStore.refreshScalarMaps();
    mocks.main.dataset = null;
    // Early return without a dataset still claims the sequence token.
    await scalarMapsStore.refreshScalarMaps();
    mocks.main.dataset = { id: "ds1" };
    first.resolve([scalarMap("old")]);
    await stale;
    expect(scalarMapsStore.maps).toEqual([]);
  });

  it("drops a failure for a request that was superseded", async () => {
    const first = deferred<any[]>();
    mocks.listMaps.mockReturnValueOnce(first.promise);
    const stale = scalarMapsStore.refreshScalarMaps();
    await scalarMapsStore.refreshScalarMaps(true);
    first.reject(new Error("late"));
    await stale;
    expect(scalarMapsStore.scalarMapsError).toBeNull();
  });

  it("resets with the dataset and keeps display settings across a re-list", async () => {
    await scalarMapsStore.refreshScalarMaps();
    scalarMapsStore.updateScalarMapDisplay({
      itemId: "a",
      changes: { visible: true, colormap: "magma", opacity: 5 },
    });
    expect(scalarMapsStore.display.a.opacity).toBe(1);
    mocks.listMaps.mockResolvedValueOnce([scalarMap("a"), scalarMap("b")]);
    await scalarMapsStore.refreshScalarMaps();
    expect(scalarMapsStore.display.a.colormap).toBe("magma");
    expect(scalarMapsStore.display.b.visible).toBe(false);

    // Another dataset: the old list is not this dataset's.
    mocks.main.dataset = { id: "ds2" };
    expect(scalarMapsStore.currentMaps).toEqual([]);
    expect(scalarMapsStore.hasMaps).toBe(false);
    mocks.listMaps.mockResolvedValueOnce([scalarMap("a")]);
    await scalarMapsStore.refreshScalarMaps();
    expect(mocks.listMaps).toHaveBeenLastCalledWith("ds2");
    // Same item id on the new dataset still starts from defaults.
    expect(scalarMapsStore.display.a.visible).toBe(false);
    expect(scalarMapsStore.display.a.colormap).toBe("viridis");
  });

  it("re-derives range and threshold when a map's file changes, keeping how it is shown", async () => {
    await scalarMapsStore.refreshScalarMaps();
    scalarMapsStore.updateScalarMapDisplay({
      itemId: "a",
      changes: { visible: true, colormap: "gray", min: 50, max: 60 },
    });
    mocks.listMaps.mockResolvedValueOnce([scalarMap("a", [0, 10], "r2")]);
    await scalarMapsStore.refreshScalarMaps();
    expect(scalarMapsStore.display.a).toMatchObject({
      visible: true,
      colormap: "gray",
      min: 0,
      max: 10,
      threshold: 8,
    });
  });

  it("keeps the requested share and derives the value; setting a value clears it", async () => {
    await scalarMapsStore.refreshScalarMaps();
    scalarMapsStore.setScalarMapThresholdPercent({ itemId: "a", percent: 30 });
    expect(scalarMapsStore.display.a).toMatchObject({
      thresholdPercent: 30,
      threshold: 140,
    });
    scalarMapsStore.setScalarMapThresholdSide({ itemId: "a", side: "below" });
    expect(scalarMapsStore.display.a).toMatchObject({
      thresholdPercent: 30,
      threshold: 60,
      thresholdSide: "below",
    });
    scalarMapsStore.setScalarMapThresholdValue({ itemId: "a", value: 12 });
    expect(scalarMapsStore.display.a).toMatchObject({
      thresholdPercent: null,
      threshold: 12,
    });
    // Set by value, switching sides keeps the value.
    scalarMapsStore.setScalarMapThresholdSide({ itemId: "a", side: "above" });
    expect(scalarMapsStore.display.a.threshold).toBe(12);
  });

  it("deletes a map and forgets its display; a failed delete keeps it", async () => {
    mocks.listMaps.mockResolvedValueOnce([scalarMap("a"), scalarMap("b")]);
    await scalarMapsStore.refreshScalarMaps();
    await scalarMapsStore.deleteScalarMap("a");
    expect(mocks.deleteMap).toHaveBeenCalledWith("a");
    expect(ids()).toEqual(["b"]);
    expect(scalarMapsStore.display.a).toBeUndefined();

    mocks.deleteMap.mockRejectedValueOnce(new Error("Write access denied"));
    await expect(scalarMapsStore.deleteScalarMap("b")).rejects.toMatchObject({
      message: "Write access denied",
    });
    expect(scalarMapsStore.currentMaps).toHaveLength(1);
  });

  it("sends one DELETE per map while it is in flight and tracks it until it settles", async () => {
    mocks.listMaps.mockResolvedValueOnce([scalarMap("a"), scalarMap("b")]);
    await scalarMapsStore.refreshScalarMaps();
    const first = deferred<void>();
    mocks.deleteMap.mockReturnValueOnce(first.promise);
    const deleteA = scalarMapsStore.deleteScalarMap("a");
    expect(scalarMapsStore.deletingMapIds).toEqual(["a"]);
    // A confirmation reopened before the first settled: joins it.
    const deleteAAgain = scalarMapsStore.deleteScalarMap("a");
    // Another map is independent.
    const deleteB = scalarMapsStore.deleteScalarMap("b");
    expect(mocks.deleteMap.mock.calls).toEqual([["a"], ["b"]]);
    expect([...scalarMapsStore.deletingMapIds].sort()).toEqual(["a", "b"]);
    await deleteB;
    expect(scalarMapsStore.deletingMapIds).toEqual(["a"]);
    first.resolve();
    await Promise.all([deleteA, deleteAAgain]);
    expect(scalarMapsStore.deletingMapIds).toEqual([]);
    expect(ids()).toEqual([]);

    // A failure ends the state too, and the next delete is a new request.
    mocks.listMaps.mockResolvedValueOnce([scalarMap("c")]);
    await scalarMapsStore.refreshScalarMaps(true);
    const failing = deferred<void>();
    mocks.deleteMap.mockReturnValueOnce(failing.promise);
    const deleteC = scalarMapsStore.deleteScalarMap("c");
    const deleteCAgain = scalarMapsStore.deleteScalarMap("c");
    failing.reject(new Error("Write access denied"));
    await expect(deleteC).rejects.toThrow("Write access denied");
    await expect(deleteCAgain).rejects.toThrow("Write access denied");
    expect(scalarMapsStore.deletingMapIds).toEqual([]);
    expect(ids()).toEqual(["c"]);
    await scalarMapsStore.deleteScalarMap("c");
    expect(
      mocks.deleteMap.mock.calls.filter(([id]) => id === "c"),
    ).toHaveLength(2);
  });

  it("does not let a list captured before a delete bring the map back", async () => {
    mocks.listMaps.mockResolvedValueOnce([scalarMap("a"), scalarMap("b")]);
    await scalarMapsStore.refreshScalarMaps();
    const before = deferred<any[]>();
    mocks.listMaps.mockReturnValueOnce(before.promise);
    const stale = scalarMapsStore.refreshScalarMaps();
    // The list after the delete, which the store asks for again.
    mocks.listMaps.mockResolvedValueOnce([scalarMap("b"), scalarMap("c")]);
    await scalarMapsStore.deleteScalarMap("a");
    before.resolve([scalarMap("a"), scalarMap("b")]);
    await stale;
    await vi.waitFor(() => expect(ids()).toEqual(["b", "c"]));
    expect(scalarMapsStore.loading).toBe(false);
  });

  it("loads the legend tables once and retries after a failure", async () => {
    mocks.getColorByPropertyOptions
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ colormaps: { viridis: ["#000", "#fff"] } });
    await scalarMapsStore.ensureScalarMapColormapStops();
    expect(scalarMapsStore.colormapStops).toBeNull();
    await scalarMapsStore.ensureScalarMapColormapStops();
    await scalarMapsStore.ensureScalarMapColormapStops();
    expect(scalarMapsStore.colormapStops).toEqual({
      viridis: ["#000", "#fff"],
    });
    expect(mocks.getColorByPropertyOptions).toHaveBeenCalledTimes(2);
  });

  it("offers the palette during the first list only, not on a re-list of a dataset with no maps", async () => {
    mocks.listMaps.mockResolvedValue([]);
    const first = deferred<any[]>();
    mocks.listMaps.mockReturnValueOnce(first.promise);
    const firstList = scalarMapsStore.refreshScalarMaps();
    // The first list for this dataset: offered while it loads.
    expect(scalarMapsStore.scalarMapsListed).toBe(false);
    expect(scalarMapsStore.scalarMapsAvailable).toBe(true);
    first.resolve([]);
    await firstList;
    expect(scalarMapsStore.scalarMapsAvailable).toBe(false);

    // A forced re-list (dataset reopened, job ended) of a dataset known to
    // have no maps: not offered while it loads, so the button never flashes.
    const again = deferred<any[]>();
    mocks.listMaps.mockReturnValueOnce(again.promise);
    const reList = scalarMapsStore.refreshScalarMaps(true);
    expect(scalarMapsStore.loading).toBe(true);
    expect(scalarMapsStore.scalarMapsAvailable).toBe(false);
    again.resolve([]);
    await reList;
    expect(scalarMapsStore.scalarMapsAvailable).toBe(false);
  });

  it("keeps the last good list and stays offered while a failed re-list is retried", async () => {
    await scalarMapsStore.refreshScalarMaps();
    mocks.listMaps.mockRejectedValueOnce(new Error("offline"));
    await scalarMapsStore.refreshScalarMaps(true);
    // A network blip does not wipe what was listed.
    expect(ids()).toEqual(["a"]);
    expect(scalarMapsStore.scalarMapsError).not.toBeNull();

    // Same with no maps listed: the error keeps the palette offered through
    // the retry, until the retry's answer lands.
    mocks.listMaps.mockResolvedValueOnce([]);
    await scalarMapsStore.refreshScalarMaps(true);
    mocks.listMaps.mockRejectedValueOnce(new Error("offline"));
    await scalarMapsStore.refreshScalarMaps(true);
    const retry = deferred<any[]>();
    mocks.listMaps.mockReturnValueOnce(retry.promise);
    const retrying = scalarMapsStore.refreshScalarMaps(true);
    expect(scalarMapsStore.scalarMapsAvailable).toBe(true);
    retry.resolve([]);
    await retrying;
    expect(scalarMapsStore.scalarMapsError).toBeNull();
    expect(scalarMapsStore.scalarMapsAvailable).toBe(false);
  });

  it("lists once for a burst of finished jobs", async () => {
    vi.useFakeTimers();
    try {
      await scalarMapsStore.refreshScalarMaps();
      mocks.listMaps.mockClear();
      for (let job = 0; job < 5; job++) {
        scheduleScalarMapsRefresh();
        await vi.advanceTimersByTimeAsync(SCALAR_MAPS_JOB_REFRESH_DELAY_MS / 4);
      }
      expect(mocks.listMaps).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(SCALAR_MAPS_JOB_REFRESH_DELAY_MS);
      expect(mocks.listMaps).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never shows another dataset's list error over this dataset's list", async () => {
    await scalarMapsStore.refreshScalarMaps();
    // Open B; its first list fails.
    mocks.main.dataset = { id: "ds2" };
    mocks.listMaps.mockRejectedValueOnce(new Error("offline"));
    await scalarMapsStore.refreshScalarMaps();
    expect(scalarMapsStore.scalarMapsError).toContain("Could not read");
    // Back to A, before (or without) its re-list landing.
    mocks.main.dataset = { id: "ds1" };
    expect(scalarMapsStore.scalarMapsError).toBeNull();
    // B's failure is still B's when it is opened again.
    mocks.main.dataset = { id: "ds2" };
    expect(scalarMapsStore.scalarMapsError).toContain("Could not read");
  });

  function withTool(itemId: string, toolId: string, revision = "r1") {
    const map = scalarMap(itemId, [0, 10], revision);
    return { ...map, meta: { ...map.meta, toolId } };
  }

  it("carries how a map is shown to its replacement from a worker re-run", async () => {
    mocks.listMaps.mockResolvedValueOnce([withTool("old", "tool1")]);
    await scalarMapsStore.refreshScalarMaps();
    scalarMapsStore.updateScalarMapDisplay({
      itemId: "old",
      changes: {
        visible: true,
        colormap: "magma",
        opacity: 0.3,
        min: 4,
        max: 5,
      },
    });
    // The worker deleted "old" and uploaded "new" for the same tool.
    mocks.listMaps.mockResolvedValueOnce([withTool("new", "tool1", "r9")]);
    await scalarMapsStore.refreshScalarMaps(true);
    expect(scalarMapsStore.display.new).toMatchObject({
      visible: true,
      colormap: "magma",
      opacity: 0.3,
      // Range and threshold are derived from the new map.
      min: 0,
      max: 10,
      threshold: 8,
    });
    expect(scalarMapsStore.display.old).toBeUndefined();
  });

  it("carries nothing over when the replacement is ambiguous or another tool's", async () => {
    mocks.listMaps.mockResolvedValueOnce([
      withTool("a1", "tool1"),
      withTool("a2", "tool1"),
      withTool("b1", "tool2"),
    ]);
    await scalarMapsStore.refreshScalarMaps();
    for (const itemId of ["a1", "a2", "b1"]) {
      scalarMapsStore.updateScalarMapDisplay({
        itemId,
        changes: { visible: true },
      });
    }
    mocks.listMaps.mockResolvedValueOnce([
      // Two tool1 items dropped, one added: ambiguous.
      withTool("a3", "tool1"),
      // tool2's item dropped, but the new item is a third tool's.
      withTool("c1", "tool3"),
    ]);
    await scalarMapsStore.refreshScalarMaps(true);
    expect(scalarMapsStore.display.a3.visible).toBe(false);
    expect(scalarMapsStore.display.c1.visible).toBe(false);
  });

  it("re-derives a map's settings after a metadata edit removes a location", async () => {
    await scalarMapsStore.refreshScalarMaps();
    scalarMapsStore.updateScalarMapDisplay({
      itemId: "a",
      changes: { visible: true, min: 50, max: 60 },
    });
    const edited = scalarMap("a", [0, 100], "r2");
    edited.meta.locations = [{ XY: 1, Z: 0, Time: 0, key: "xy1_z0_t0" }];
    mocks.listMaps.mockResolvedValueOnce([edited]);
    await scalarMapsStore.refreshScalarMaps(true);
    expect(scalarMapsStore.currentMaps[0].meta.locations).toEqual([
      { XY: 1, Z: 0, Time: 0, key: "xy1_z0_t0" },
    ]);
    expect(scalarMapsStore.display.a).toMatchObject({
      visible: true,
      min: 0,
      max: 100,
    });
  });
});

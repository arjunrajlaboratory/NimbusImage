/**
 * The current location must stay inside the loaded dataset (issue #1388).
 *
 * A ?xy=&z=&time= deep link, or a lastLocation saved from another dataset,
 * used to land unchecked, so `dataset.images(dataset.z[z], ...)` missed at
 * every later lookup (raw snapshot export failed with "Image not found").
 * These dispatch the REAL main-store actions; only the dataset/configuration
 * fetches and the view API are stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import main from "../index";
import sync from "../sync";
import rootStore from "../root";
import "../filters";
import "../properties";
import "../connectionList";
import { IDataset, IDatasetView } from "../model";

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

function makeDataset(id: string, xy: number, z: number, time: number) {
  return { id, xy: range(xy), z: range(z), time: range(time) } as IDataset;
}

function makeView(
  id: string,
  datasetId: string,
  lastLocation = { xy: 0, z: 0, time: 0 },
): IDatasetView {
  return {
    id,
    datasetId,
    configurationId: "config",
    layerContrasts: {},
    scales: {},
    lastViewed: 0,
    lastLocation,
    _accessLevel: 2,
  };
}

const state = () => (rootStore.state as any).main;
const actions = (rootStore as any)._actions as Record<string, any[]>;
let savedActions: Record<string, any[] | undefined>;
let datasets: Record<string, IDataset>;
let views: Record<string, IDatasetView>;
let updateDatasetView: ReturnType<typeof vi.fn>;

function stubAction(name: string, handler: (payload: any) => any) {
  if (!(name in savedActions)) {
    savedActions[name] = actions[name];
  }
  actions[name] = [async (payload: any) => handler(payload)];
}

function savedLocations() {
  return updateDatasetView.mock.calls.map(([view]) => ({
    id: view.id,
    lastLocation: { ...view.lastLocation },
  }));
}

beforeEach(() => {
  vi.useFakeTimers();
  savedActions = {};
  datasets = {};
  views = {};
  stubAction("getDataset", ({ id }) => datasets[id] ?? null);
  stubAction("getAllLargeImages", () => []);
  stubAction("getConfiguration", () => ({ id: "config" }));
  updateDatasetView = vi.fn(async () => undefined);
  vi.spyOn(main.api, "getDatasetView").mockImplementation(
    async (id: string) => ({
      ...views[id],
      lastLocation: { ...views[id].lastLocation },
    }),
  );
  vi.spyOn(main.api, "updateDatasetView").mockImplementation(
    updateDatasetView as any,
  );
  Object.assign(state(), {
    girderUser: { _id: "user", login: "user" },
    dataset: null,
    selectedDatasetId: null,
    configuration: { id: "config" },
    datasetView: null,
    xy: 0,
    z: 0,
    time: 0,
  });
  sync.setDatasetLoading(false);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const [name, handlers] of Object.entries(savedActions)) {
    if (handlers) actions[name] = handlers;
    else delete actions[name];
  }
  Object.assign(state(), {
    girderUser: null,
    dataset: null,
    datasetView: null,
  });
});

describe("dataset location clamp", () => {
  it("clamps a deep-linked location past the dataset's dimensions on load", async () => {
    datasets.small = makeDataset("small", 1, 1, 42);
    views.v = makeView("v", "small");

    await main.setDatasetViewId({
      id: "v",
      routeQuery: { xy: "12", z: "3", time: "50" },
    });

    expect(main.currentLocation).toEqual({ xy: 0, z: 0, time: 41 });
  });

  it("keeps a deep link that is valid for the incoming dataset but not the outgoing one", async () => {
    datasets.small = makeDataset("small", 1, 1, 1);
    datasets.big = makeDataset("big", 20, 5, 1);
    views.vSmall = makeView("vSmall", "small");
    views.vBig = makeView("vBig", "big");
    await main.setDatasetViewId({ id: "vSmall" });

    await main.setDatasetViewId({
      id: "vBig",
      routeQuery: { xy: "12", z: "3" },
    });

    expect(main.currentLocation).toEqual({ xy: 12, z: 3, time: 0 });
  });

  it("clamps a saved lastLocation when the dataset does not change", async () => {
    datasets.small = makeDataset("small", 1, 1, 42);
    views.v1 = makeView("v1", "small");
    views.v2 = makeView("v2", "small", { xy: 12, z: 3, time: 7 });
    await main.setDatasetViewId({ id: "v1" });

    await main.setDatasetViewId({ id: "v2" });

    expect(main.currentLocation).toEqual({ xy: 0, z: 0, time: 7 });
  });

  it("persists the clamped location, not the out-of-range one", async () => {
    datasets.small = makeDataset("small", 1, 1, 42);
    views.v = makeView("v", "small", { xy: 12, z: 3, time: 7 });

    await main.setDatasetViewId({ id: "v" });
    updateDatasetView.mockClear(); // drop the lastViewed write
    await vi.runAllTimersAsync();

    expect(savedLocations()).toEqual([
      { id: "v", lastLocation: { xy: 0, z: 0, time: 7 } },
    ]);
  });

  it("clamps setXY/setZ/setTime once the dataset is loaded", async () => {
    datasets.small = makeDataset("small", 3, 2, 5);
    views.v = makeView("v", "small");
    await main.setDatasetViewId({ id: "v" });

    await main.setXY(12);
    await main.setZ(-4);
    await main.setTime(NaN);

    expect(main.currentLocation).toEqual({ xy: 2, z: 0, time: 0 });
  });

  it("saves a pending location into the view being left, not the next one", async () => {
    datasets.a = makeDataset("a", 10, 1, 1);
    datasets.b = makeDataset("b", 10, 1, 1);
    views.vA = makeView("vA", "a");
    views.vB = makeView("vB", "b", { xy: 2, z: 0, time: 0 });
    await main.setDatasetViewId({ id: "vA" });
    await main.setXY(7);
    updateDatasetView.mockClear();

    // Switch within the 5 s save delay.
    await main.setDatasetViewId({ id: "vB" });
    await vi.runAllTimersAsync();

    const saves = savedLocations();
    expect(saves).toContainEqual({
      id: "vA",
      lastLocation: { xy: 7, z: 0, time: 0 },
    });
    expect(
      saves.filter((s) => s.id === "vB").map((s) => s.lastLocation.xy),
    ).not.toContain(7);
    expect(main.xy).toBe(2);
  });

  it("persists a location clamped by a dataset refresh outside a view load", async () => {
    datasets.ds = makeDataset("ds", 1, 10, 1);
    views.v = makeView("v", "ds", { xy: 0, z: 5, time: 0 });
    await main.setDatasetViewId({ id: "v" });
    expect(main.z).toBe(5);
    // Drain the load's own scheduled save so it can't stand in for the
    // refresh's.
    await vi.runAllTimersAsync();
    updateDatasetView.mockClear();

    // Unrolling Z collapses the axis to one entry and reloads the dataset.
    datasets.ds = makeDataset("ds", 1, 1, 1);
    await main.refreshDataset();
    await vi.runAllTimersAsync();

    expect(main.z).toBe(0);
    expect(savedLocations()).toEqual([
      { id: "v", lastLocation: { xy: 0, z: 0, time: 0 } },
    ]);
  });

  it("does not save a location while the dataset is still loading", async () => {
    // In range, so only the loading guard (not the save's clamp) can stop it.
    datasets.small = makeDataset("small", 20, 1, 1);
    views.v = makeView("v", "small");
    await main.setDatasetViewId({ id: "v" });
    updateDatasetView.mockClear();

    sync.setDatasetLoading(true);
    await main.setXY(12);
    await vi.runAllTimersAsync();

    expect(updateDatasetView).not.toHaveBeenCalled();
  });
});

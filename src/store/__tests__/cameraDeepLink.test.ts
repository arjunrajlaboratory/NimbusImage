/**
 * `?x=&y=&zoom=` camera deep links: setDatasetViewId records the target for
 * ImageViewer, tied to the view's dataset, and a new navigation replaces it.
 * Dispatches the REAL main-store actions; only fetches are stubbed (same
 * harness as datasetLocationClamp.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import main from "../index";
import sync from "../sync";
import rootStore from "../root";
import "../filters";
import "../properties";
import "../connectionList";
import { IDataset, IDatasetView } from "../model";

function makeView(id: string, datasetId: string): IDatasetView {
  return {
    id,
    datasetId,
    configurationId: "config",
    layerContrasts: {},
    scales: {},
    lastViewed: 0,
    lastLocation: { xy: 0, z: 0, time: 0 },
    _accessLevel: 2,
  };
}

const state = () => (rootStore.state as any).main;
const actions = (rootStore as any)._actions as Record<string, any[]>;
let savedActions: Record<string, any[] | undefined>;
let views: Record<string, IDatasetView>;

function stubAction(name: string, handler: (payload: any) => any) {
  if (!(name in savedActions)) {
    savedActions[name] = actions[name];
  }
  actions[name] = [async (payload: any) => handler(payload)];
}

beforeEach(() => {
  vi.useFakeTimers();
  savedActions = {};
  views = {};
  stubAction(
    "getDataset",
    ({ id }) => ({ id, xy: [0], z: [0], time: [0] }) as IDataset,
  );
  stubAction("getAllLargeImages", () => []);
  stubAction("getConfiguration", () => ({ id: "config" }));
  vi.spyOn(main.api, "getDatasetView").mockImplementation(async (id) => ({
    ...views[id],
  }));
  vi.spyOn(main.api, "updateDatasetView").mockResolvedValue(undefined as any);
  Object.assign(state(), {
    girderUser: { _id: "user", login: "user" },
    dataset: null,
    selectedDatasetId: null,
    configuration: { id: "config" },
    datasetView: null,
    pendingCameraDeepLink: null,
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
    pendingCameraDeepLink: null,
  });
});

describe("camera deep link", () => {
  it("records the target for the view's dataset", async () => {
    views.v = makeView("v", "ds1");

    await main.setDatasetViewId({
      id: "v",
      routeQuery: { x: "100", y: "200.5", zoom: "6" },
    });

    expect(main.pendingCameraDeepLink).toEqual({
      x: 100,
      y: 200.5,
      zoom: 6,
      datasetId: "ds1",
    });
  });

  it("ties the target to the incoming dataset while the outgoing one is still loaded", async () => {
    views.a = makeView("a", "dsA");
    views.b = makeView("b", "dsB");
    await main.setDatasetViewId({ id: "a" });

    let pendingWhileLoading: unknown = undefined;
    let datasetWhileLoading: string | undefined;
    stubAction("getDataset", ({ id }) => {
      // Mid-load: the view is set, the dataset is still the outgoing one.
      pendingWhileLoading = main.pendingCameraDeepLink;
      datasetWhileLoading = main.dataset?.id;
      return { id, xy: [0], z: [0], time: [0] } as IDataset;
    });
    await main.setDatasetViewId({
      id: "b",
      routeQuery: { x: "1", y: "2" },
    });

    expect(datasetWhileLoading).toBe("dsA");
    expect(pendingWhileLoading).toEqual({
      x: 1,
      y: 2,
      zoom: null,
      datasetId: "dsB",
    });
  });

  it("records nothing for missing or invalid coordinates", async () => {
    views.v = makeView("v", "ds1");

    await main.setDatasetViewId({ id: "v", routeQuery: { xy: "0" } });
    expect(main.pendingCameraDeepLink).toBeNull();

    await main.setDatasetViewId({
      id: "v",
      routeQuery: { x: "abc", y: "2", zoom: "3" },
    });
    expect(main.pendingCameraDeepLink).toBeNull();
  });

  it("clears an unapplied target when a new navigation has none", async () => {
    views.a = makeView("a", "dsA");
    views.b = makeView("b", "dsB");
    await main.setDatasetViewId({ id: "a", routeQuery: { x: "1", y: "2" } });
    expect(main.pendingCameraDeepLink).not.toBeNull();

    await main.setDatasetViewId({ id: "b" });

    expect(main.pendingCameraDeepLink).toBeNull();
  });

  it("a superseded navigation does not commit its target when its fetch resolves last", async () => {
    views.a = makeView("a", "ds1");
    views.b = makeView("b", "ds1");
    let resolveA: () => void = () => {};
    vi.spyOn(main.api, "getDatasetView").mockImplementation(
      (id: string) =>
        new Promise((resolve) => {
          const answer = () => resolve({ ...views[id] });
          if (id === "a") resolveA = answer;
          else answer();
        }),
    );

    const first = main.setDatasetViewId({
      id: "a",
      routeQuery: { x: "1", y: "2" },
    });
    await main.setDatasetViewId({ id: "b" });
    resolveA();
    await first;

    expect(main.pendingCameraDeepLink).toBeNull();
  });

  it("consuming a target clears it and counts the apply", async () => {
    views.v = makeView("v", "ds1");
    await main.setDatasetViewId({ id: "v", routeQuery: { x: "1", y: "2" } });
    const applied = main.appliedCameraDeepLinks;

    main.consumeCameraDeepLink();

    expect(main.pendingCameraDeepLink).toBeNull();
    expect(main.appliedCameraDeepLinks).toBe(applied + 1);
    // A navigation's reset is not an apply: the routes keep its keys.
    await main.setDatasetViewId({ id: "v", routeQuery: { x: "3", y: "4" } });
    await main.setDatasetViewId({ id: "v" });
    expect(main.appliedCameraDeepLinks).toBe(applied + 1);
  });

  it("requestCameraDeepLink re-targets the loaded view", async () => {
    views.v = makeView("v", "ds1");
    await main.setDatasetViewId({ id: "v" });

    await main.requestCameraDeepLink({ x: "7", y: "8", zoom: "2" });

    expect(main.pendingCameraDeepLink).toEqual({
      x: 7,
      y: 8,
      zoom: 2,
      datasetId: "ds1",
    });
  });

  it("requestCameraDeepLink ignores an invalid query and a missing view", async () => {
    await main.requestCameraDeepLink({ x: "7", y: "8" });
    expect(main.pendingCameraDeepLink).toBeNull();

    views.v = makeView("v", "ds1");
    await main.setDatasetViewId({ id: "v" });
    await main.requestCameraDeepLink({ x: "7" });
    expect(main.pendingCameraDeepLink).toBeNull();
  });
});

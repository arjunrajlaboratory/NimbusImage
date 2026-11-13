/**
 * Overlapping dataset/configuration loads (IMPLICIT_STATE_MACHINES.md J7).
 *
 * Only the latest setSelectedDataset / setSelectedConfiguration commits, and
 * datasetLoading stays set until the newest load settles. Dispatches the REAL
 * main-store actions; only fetches are stubbed (same harness as
 * datasetLocationClamp.test.ts), each held until the test answers it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import main, { shownDatasetId } from "../index";
import sync from "../sync";
import jobs from "../jobs";
import rootStore from "../root";
import { RestClient } from "@/girder";
import "../filters";
import "../properties";
import "../connectionList";
import { IDataset, IDatasetView } from "../model";

function makeView(
  id: string,
  datasetId: string,
  configurationId = "config",
): IDatasetView {
  return {
    id,
    datasetId,
    configurationId,
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
// Fetches waiting for the test to answer them, by id.
let heldDatasets: Map<string, Array<() => void>>;
let heldConfigurations: Map<string, Array<() => void>>;

function stubAction(name: string, handler: (payload: any) => any) {
  if (!(name in savedActions)) {
    savedActions[name] = actions[name];
  }
  actions[name] = [async (payload: any) => handler(payload)];
}

function hold<T>(held: Map<string, Array<() => void>>, id: string, value: T) {
  return new Promise<T>((resolve) => {
    held.set(id, [...(held.get(id) ?? []), () => resolve(value)]);
  });
}

async function answer(held: Map<string, Array<() => void>>, id: string) {
  await vi.waitFor(() => expect(held.get(id)?.length).toBeGreaterThan(0));
  held.get(id)!.shift()!();
}

beforeEach(() => {
  vi.useFakeTimers();
  savedActions = {};
  views = {};
  heldDatasets = new Map();
  heldConfigurations = new Map();
  stubAction("getDataset", ({ id }) =>
    hold(heldDatasets, id, { id, xy: [0], z: [0], time: [0] } as IDataset),
  );
  stubAction("getAllLargeImages", () => []);
  stubAction("getConfiguration", (id) =>
    hold(heldConfigurations, id, { id, propertyIds: [] }),
  );
  vi.spyOn(main.api, "getDatasetView").mockImplementation(async (id) => ({
    ...views[id],
  }));
  vi.spyOn(main.api, "updateDatasetView").mockResolvedValue(undefined as any);
  Object.assign(state(), {
    girderUser: { _id: "user", login: "user" },
    dataset: null,
    selectedDatasetId: null,
    configuration: { id: "config" },
    selectedConfigurationId: "config",
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
    selectedDatasetId: null,
    configuration: null,
    selectedConfigurationId: null,
    datasetView: null,
  });
});

describe("dataset load lifecycle", () => {
  it("an overtaken navigation's dataset does not land after the newer view's", async () => {
    views.a = makeView("a", "dsA");
    views.b = makeView("b", "dsB");

    const first = main.setDatasetViewId({ id: "a" });
    await vi.waitFor(() => expect(heldDatasets.get("dsA")).toHaveLength(1));
    const second = main.setDatasetViewId({ id: "b" });
    await answer(heldDatasets, "dsB");
    await second;
    await answer(heldDatasets, "dsA");
    await first;

    expect(main.datasetView?.id).toBe("b");
    expect(main.dataset?.id).toBe("dsB");
  });

  it("going back to the current view overtakes a navigation still fetching its view", async () => {
    views.v0 = makeView("v0", "ds0");
    views.t = makeView("t", "dsT");
    const opening = main.setDatasetViewId({ id: "v0" });
    await answer(heldDatasets, "ds0");
    await opening;

    // The next view's fetch is slow: the store still holds v0
    let releaseView!: () => void;
    vi.mocked(main.api.getDatasetView).mockImplementationOnce(
      (id) =>
        new Promise((resolve) => {
          releaseView = () => resolve({ ...views[id] });
        }),
    );
    const away = main.setDatasetViewId({ id: "t" });
    expect(main.datasetView?.id).toBe("v0");

    await main.setDatasetViewId({ id: "v0" });
    releaseView();
    await away;

    expect(main.datasetView?.id).toBe("v0");
    expect(main.dataset?.id).toBe("ds0");
    expect(heldDatasets.get("dsT") ?? []).toHaveLength(0);
    expect(sync.datasetLoading).toBe(false);
  });

  it("an overtaken switch does not replace a newer view of the dataset already loaded", async () => {
    views.v0 = makeView("v0", "ds0");
    views.a = makeView("a", "dsA");
    views.v0b = makeView("v0b", "ds0");
    const opening = main.setDatasetViewId({ id: "v0" });
    await answer(heldDatasets, "ds0");
    await opening;

    const first = main.setDatasetViewId({ id: "a" });
    await vi.waitFor(() => expect(heldDatasets.get("dsA")).toHaveLength(1));
    // Back to a view of the dataset that is still loaded.
    const second = main.setDatasetViewId({ id: "v0b" });
    await answer(heldDatasets, "ds0");
    await second;
    await answer(heldDatasets, "dsA");
    await first;

    expect(main.datasetView?.id).toBe("v0b");
    expect(main.dataset?.id).toBe("ds0");
    expect(sync.datasetLoading).toBe(false);
  });

  it("keeps datasetLoading set until the newest dataset load settles", async () => {
    const first = main.setSelectedDataset("dsA");
    await vi.waitFor(() => expect(heldDatasets.get("dsA")).toHaveLength(1));
    const second = main.setSelectedDataset("dsB");
    await answer(heldDatasets, "dsA");
    await first;

    expect(sync.datasetLoading).toBe(true);
    expect(main.dataset).toBeNull();

    await answer(heldDatasets, "dsB");
    await second;
    expect(sync.datasetLoading).toBe(false);
    expect(main.dataset?.id).toBe("dsB");
  });

  it("a dataset load that settles while a view is being fetched keeps datasetLoading set", async () => {
    views.v = makeView("v", "dsV");
    let answerView: () => void = () => {};
    vi.spyOn(main.api, "getDatasetView").mockImplementation(
      (id: string) =>
        new Promise((resolve) => {
          answerView = () => resolve({ ...views[id] });
        }),
    );
    const direct = main.setSelectedDataset("ds0");
    await vi.waitFor(() => expect(heldDatasets.get("ds0")).toHaveLength(1));
    const navigation = main.setDatasetViewId({ id: "v" });
    await answer(heldDatasets, "ds0");
    await direct;

    // The view, and the dataset load it starts, are still to come.
    expect(sync.datasetLoading).toBe(true);

    answerView();
    await answer(heldDatasets, "dsV");
    await navigation;
    expect(main.dataset?.id).toBe("dsV");
    expect(sync.datasetLoading).toBe(false);
  });

  it("an overtaken navigation's configuration does not land after the newer view's", async () => {
    views.a = makeView("a", "ds", "configA");
    views.b = makeView("b", "ds", "configB");

    const first = main.setDatasetViewId({ id: "a" });
    await vi.waitFor(() =>
      expect(heldConfigurations.get("configA")).toHaveLength(1),
    );
    const second = main.setDatasetViewId({ id: "b" });
    await answer(heldDatasets, "ds");
    await answer(heldConfigurations, "configB");
    await second;
    await answer(heldConfigurations, "configA");
    await first;

    expect(main.datasetView?.id).toBe("b");
    expect(main.configuration?.id).toBe("configB");
  });

  it("a navigation whose dataset is already loading resolves once it lands", async () => {
    views.v = makeView("v", "dsV");
    const direct = main.setSelectedDataset("dsV");
    await vi.waitFor(() => expect(heldDatasets.get("dsV")).toHaveLength(1));
    let navigated = false;
    const navigation = main
      .setDatasetViewId({ id: "v" })
      .then(() => (navigated = true));
    await vi.waitFor(() => expect(main.datasetView?.id).toBe("v"));
    await vi.advanceTimersByTimeAsync(10);

    // It started no load of its own, and waits for the one in flight.
    expect(heldDatasets.get("dsV")).toHaveLength(1);
    expect(navigated).toBe(false);

    await answer(heldDatasets, "dsV");
    await Promise.all([direct, navigation]);
    expect(main.dataset?.id).toBe("dsV");
  });

  it("a dataset load superseded by a reload of the same dataset resolves once the reload lands", async () => {
    let firstSettled = false;
    const first = main
      .setSelectedDataset("dsA")
      .then(() => (firstSettled = true));
    await vi.waitFor(() => expect(heldDatasets.get("dsA")).toHaveLength(1));
    // A reload of the same dataset (refreshDataset, a login restore).
    const second = main.setSelectedDataset("dsA");
    await vi.waitFor(() => expect(heldDatasets.get("dsA")).toHaveLength(2));
    await answer(heldDatasets, "dsA");
    await vi.advanceTimersByTimeAsync(10);

    expect(firstSettled).toBe(false);
    expect(main.dataset).toBeNull();

    await answer(heldDatasets, "dsA");
    await Promise.all([first, second]);
    expect(main.dataset?.id).toBe("dsA");
  });

  it("a dataset load superseded by another dataset resolves without waiting for it", async () => {
    const first = main.setSelectedDataset("dsA");
    await vi.waitFor(() => expect(heldDatasets.get("dsA")).toHaveLength(1));
    const second = main.setSelectedDataset("dsB");
    await answer(heldDatasets, "dsA");
    await first;

    expect(main.dataset).toBeNull();
    await answer(heldDatasets, "dsB");
    await second;
  });

  it("a dataset load whose browser save fails still settles a navigation waiting on it", async () => {
    let failSave!: () => void;
    stubAction(
      "flushAnnotationBrowserSave",
      () =>
        new Promise<void>((_resolve, reject) => {
          failSave = () => reject(new Error("save failed"));
        }),
    );
    views.v = makeView("v", "dsV");
    const direct = main.setSelectedDataset("dsV");
    // Waits on the pending load of its dataset instead of starting one
    let navigated = false;
    const navigation = main
      .setDatasetViewId({ id: "v" })
      .then(() => (navigated = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(navigated).toBe(false);

    failSave();
    await expect(direct).rejects.toThrow();
    await vi.waitFor(() => expect(navigated).toBe(true));
    await navigation;
  });

  it("a view that cannot be fetched clears datasetLoading", async () => {
    vi.spyOn(main.api, "getDatasetView").mockRejectedValue(
      new Error("forbidden"),
    );

    await main.setDatasetViewId({ id: "missing" });

    expect(sync.datasetLoading).toBe(false);
    expect(main.datasetView).toBeNull();
  });

  it("a navigation whose configuration is already loading resolves once it lands", async () => {
    views.v = makeView("v", "ds", "configV");
    Object.assign(state(), {
      dataset: { id: "ds", xy: [0], z: [0], time: [0] },
    });
    const direct = main.setSelectedConfiguration("configV");
    await vi.waitFor(() =>
      expect(heldConfigurations.get("configV")).toHaveLength(1),
    );
    let navigated = false;
    const navigation = main
      .setDatasetViewId({ id: "v" })
      .then(() => (navigated = true));
    await vi.waitFor(() => expect(main.datasetView?.id).toBe("v"));
    await vi.advanceTimersByTimeAsync(10);

    expect(heldConfigurations.get("configV")).toHaveLength(1);
    expect(navigated).toBe(false);

    await answer(heldConfigurations, "configV");
    await Promise.all([direct, navigation]);
    expect(main.configuration?.id).toBe("configV");
  });

  it("a configuration load superseded by a reload of the same one resolves once the reload lands", async () => {
    let firstSettled = false;
    const first = main
      .setSelectedConfiguration("configA")
      .then(() => (firstSettled = true));
    await vi.waitFor(() =>
      expect(heldConfigurations.get("configA")).toHaveLength(1),
    );
    const second = main.setSelectedConfiguration("configA");
    await vi.waitFor(() =>
      expect(heldConfigurations.get("configA")).toHaveLength(2),
    );
    await answer(heldConfigurations, "configA");
    await vi.advanceTimersByTimeAsync(10);

    expect(firstSettled).toBe(false);
    expect(main.configuration?.id).toBe("config");

    await answer(heldConfigurations, "configA");
    await Promise.all([first, second]);
    expect(main.configuration?.id).toBe("configA");
  });

  it("restoring a login reloads the selected dataset once", async () => {
    state().selectedDatasetId = "ds";
    const client = main.girderRest;
    const token = client.token;
    Object.assign(client, { token: "stored" });
    vi.spyOn(RestClient.prototype, "fetchUser").mockResolvedValue({
      _id: "user",
    } as any);
    vi.spyOn(main.api, "getRecentDatasetViews").mockResolvedValue([]);
    vi.spyOn(jobs, "initializeNotificationSubscription").mockResolvedValue();
    const loads: string[] = [];
    stubAction("getDataset", ({ id }) => {
      loads.push(id);
      return { id, xy: [0], z: [0], time: [0] } as IDataset;
    });
    stubAction("getConfiguration", (id) => ({ id, propertyIds: [] }));
    try {
      await main.initialize();
    } finally {
      Object.assign(client, { token });
    }

    expect(loads).toEqual(["ds"]);
    expect(main.dataset?.id).toBe("ds");
  });
});

describe("shownDatasetId", () => {
  it("is the dataset being loaded, then the loaded one", async () => {
    Object.assign(state(), { dataset: { id: "old" } });
    expect(shownDatasetId()).toBe("old");

    const load = main.setSelectedDataset("new");
    await vi.advanceTimersByTimeAsync(0);
    // main.dataset is still the one being left
    expect(main.dataset?.id).toBe("old");
    expect(shownDatasetId()).toBe("new");

    await answer(heldDatasets, "new");
    await vi.advanceTimersByTimeAsync(0);
    await load;
    expect(shownDatasetId()).toBe("new");
  });
});

describe("logout", () => {
  beforeEach(() => {
    vi.spyOn(main.girderRest, "logout").mockResolvedValue(undefined as any);
  });
  afterEach(() => {
    Object.assign(state(), { hasUserLoggedOut: false });
  });

  it("resets the previous session's view, image, tool and recent views", async () => {
    Object.assign(state(), {
      dataset: { id: "ds" },
      selectedDatasetId: "ds",
      datasetView: makeView("v", "ds"),
      currentLargeImage: { _id: "img", name: "img" },
      allLargeImages: [{ _id: "img", name: "img" }],
      selectedTool: { configuration: { id: "tool" }, state: {} },
      recentDatasetViews: [makeView("v", "ds")],
      folderLocation: { _id: "private", _modelType: "folder", name: "x" },
      history: [{ actionName: "edit" }],
    });

    await main.logout();

    expect(main.isLoggedIn).toBe(false);
    expect(main.dataset).toBeNull();
    expect(main.datasetView).toBeNull();
    expect(main.currentLargeImage).toBeNull();
    expect(main.allLargeImages).toEqual([]);
    expect(main.selectedTool).toBeNull();
    expect(main.recentDatasetViews).toEqual([]);
    expect(main.folderLocation).toEqual({ type: "users" });
    expect(main.history).toEqual([]);
  });

  it("drops the previous session's property run locks", async () => {
    // Kept across dataset navigation, but the next account can neither read
    // this job nor hear it finish.
    const propertyState = (rootStore.state as any).properties;
    propertyState.propertyStatuses = {
      "prop-1": { running: true, previousRun: null, progressInfo: {} },
    };
    Object.assign(state(), { dataset: { id: "ds" }, selectedDatasetId: "ds" });

    await main.setSelectedDataset(null);
    expect(Object.keys(propertyState.propertyStatuses)).toEqual(["prop-1"]);

    await main.logout();
    expect(propertyState.propertyStatuses).toEqual({});
  });

  it("stops tracking the previous session's jobs", async () => {
    // Looked up by dataset and tool alone, so on a shared dataset the next
    // account's tool would read as running for a job it cannot see.
    vi.spyOn(jobs, "initializeNotificationSubscription").mockResolvedValue();
    const completion = jobs.addJob({
      jobId: "job-a",
      toolId: "tool",
      datasetId: "shared-ds",
    } as any);
    await vi.waitFor(() =>
      expect(jobs.jobIdForToolInDataset("tool", "shared-ds")).toBe("job-a"),
    );

    await main.logout();

    expect(jobs.jobIdForToolInDataset("tool", "shared-ds")).toBeNull();
    await expect(completion).resolves.toBe(false);
  });

  it("a view load in flight at logout does not commit after it", async () => {
    views.a = makeView("a", "dsA", "configA");
    const navigation = main.setDatasetViewId({ id: "a" });
    await vi.waitFor(() => expect(heldDatasets.get("dsA")).toHaveLength(1));
    await vi.waitFor(() =>
      expect(heldConfigurations.get("configA")).toHaveLength(1),
    );

    await main.logout();
    await answer(heldDatasets, "dsA");
    await answer(heldConfigurations, "configA");
    await navigation;

    expect(main.datasetView).toBeNull();
    expect(main.dataset).toBeNull();
    expect(main.configuration).toBeNull();
    expect(sync.datasetLoading).toBe(false);
  });

  it("a view fetch in flight at logout does not commit after it", async () => {
    views.a = makeView("a", "dsA", "configA");
    let answerView: () => void = () => {};
    vi.spyOn(main.api, "getDatasetView").mockImplementation(
      (id: string) =>
        new Promise((resolve) => {
          answerView = () => resolve({ ...views[id] });
        }),
    );
    const navigation = main.setDatasetViewId({ id: "a" });
    expect(sync.datasetLoading).toBe(true);

    await main.logout();
    expect(sync.datasetLoading).toBe(false);
    answerView();
    await vi.advanceTimersByTimeAsync(0);

    expect(main.datasetView).toBeNull();
    expect(main.dataset).toBeNull();
    expect(heldDatasets.get("dsA")).toBeUndefined();
    expect(sync.datasetLoading).toBe(false);
    await navigation;
  });

  it("a history response that lands after logout is dropped", async () => {
    Object.assign(state(), { dataset: { id: "ds" }, selectedDatasetId: "ds" });
    let answerHistory: () => void = () => {};
    let request: Promise<unknown> = Promise.resolve();
    const getHistoryEntries = vi
      .spyOn(main.api, "getHistoryEntries")
      .mockImplementation(() => {
        request = new Promise((resolve) => {
          answerHistory = () => resolve([{ actionName: "edit" }] as any);
        });
        return request as any;
      });
    main.fetchHistory();
    // fetchHistory is debounced: let the request start before logging out.
    await vi.advanceTimersByTimeAsync(100);
    expect(getHistoryEntries).toHaveBeenCalledTimes(1);
    await main.logout();
    answerHistory();
    await request;
    await vi.advanceTimersByTimeAsync(0);

    expect(main.history).toEqual([]);
  });
});

describe("large images", () => {
  let heldImages: Map<string, Array<() => void>>;
  const image = (id: string) => ({ _id: id, name: id }) as any;

  beforeEach(() => {
    heldImages = new Map();
    stubAction("getAllLargeImages", (id) =>
      hold(heldImages, id, [image(`${id}-img`)]),
    );
    stubAction("getCurrentLargeImage", (id) => image(`${id}-img`));
  });
  afterEach(() => {
    Object.assign(state(), { currentLargeImage: null, allLargeImages: [] });
  });

  it("a previous dataset's images do not land after the next dataset's", async () => {
    const first = main.setSelectedDataset("dsA");
    await answer(heldDatasets, "dsA");
    await vi.waitFor(() => expect(heldImages.get("dsA")).toHaveLength(1));
    const second = main.setSelectedDataset("dsB");
    await answer(heldDatasets, "dsB");
    await answer(heldImages, "dsB");
    await second;
    await answer(heldImages, "dsA");
    await first;

    expect(main.dataset?.id).toBe("dsB");
    expect(main.allLargeImages.map((img) => img._id)).toEqual(["dsB-img"]);
    expect(main.currentLargeImage?._id).toBe("dsB-img");
  });

  it("the current large image follows a dataset switch", async () => {
    const first = main.setSelectedDataset("dsA");
    await answer(heldDatasets, "dsA");
    await answer(heldImages, "dsA");
    await first;
    expect(main.currentLargeImage?._id).toBe("dsA-img");

    const second = main.setSelectedDataset("dsB");
    await answer(heldDatasets, "dsB");
    await answer(heldImages, "dsB");
    await second;

    expect(main.currentLargeImage?._id).toBe("dsB-img");
  });
});

describe("dataset view requests", () => {
  it("concurrent reads of one view share a single request", async () => {
    views.a = makeView("a", "dsA");
    let answerView: () => void = () => {};
    const getDatasetView = vi
      .spyOn(main.api, "getDatasetView")
      .mockImplementation(
        (id: string) =>
          new Promise((resolve) => {
            answerView = () => resolve({ ...views[id] });
          }),
      );
    // The route mapper's navigation and BreadCrumbs, on a fresh page load.
    const navigation = main.setDatasetViewId({ id: "a" });
    const breadcrumbs = main.fetchDatasetView("a");
    answerView();
    const view = await breadcrumbs;
    await answer(heldDatasets, "dsA");
    await navigation;

    expect(getDatasetView).toHaveBeenCalledTimes(1);
    expect(view.datasetId).toBe("dsA");
    // Each caller has its own copy: the store's is its state.
    expect(view).not.toBe(main.datasetView);
    expect(main.datasetView?.id).toBe("a");
  });

  it("does not share a request across sessions", async () => {
    views.a = makeView("a", "dsA");
    const client = main.girderRest;
    const token = client.token;
    const getDatasetView = vi.spyOn(main.api, "getDatasetView");
    try {
      Object.assign(client, { token: "first" });
      const first = main.fetchDatasetView("a");
      Object.assign(client, { token: "second" });
      const second = main.fetchDatasetView("a");
      await Promise.all([first, second]);
    } finally {
      Object.assign(client, { token });
    }

    expect(getDatasetView).toHaveBeenCalledTimes(2);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// These tests dispatch the REAL Vuex actions (no "@/store" mock). Inside a
// vuex-module-decorators action `this` is the module accessor, which carries
// only state, getters, mutations and actions - a plain class method is not on
// it. The logged-out notification used to be such a method, so every action
// below rejected instead of warning the user: syncConfiguration (rawError)
// with "this.createNotLoggedInNotification is not a function", the others
// with the ERR_ACTION_ACCESS_UNDEFINED wrapper. A mocked store cannot see
// that.
import main from "./index";
import store from "./root";
import progress from "./progress";
import { exampleConfigurationBase, NotificationType } from "./model";

const notLoggedInNotification = {
  type: NotificationType.WARNING,
  title: "Authentication Required",
  message: "You must be logged in to perform this action.",
  timeout: 5,
};

// Every action that refuses a guest before changing anything, with the value
// it resolves to. A caller that reports success checks that value.
const guardedActions: [string, () => Promise<unknown>, unknown][] = [
  [
    "deleteLargeImage",
    () => main.deleteLargeImage({ _id: "li1" } as any),
    undefined,
  ],
  [
    "createDatasetView",
    async () =>
      main.createDatasetView({ datasetId: "ds1", configurationId: "config1" }),
    null,
  ],
  [
    "deleteDatasetView",
    () => main.deleteDatasetView({ id: "view1" } as any),
    false,
  ],
  [
    "createDataset",
    () => main.createDataset({ name: "n", description: "d", path: {} as any }),
    null,
  ],
  [
    "createConfiguration",
    () =>
      main.createConfiguration({
        name: "n",
        description: "d",
        folderId: "f1",
      }),
    null,
  ],
  [
    "deleteConfiguration",
    () => main.deleteConfiguration({ id: "config1" } as any),
    false,
  ],
  ["deleteDataset", () => main.deleteDataset({ id: "ds1" } as any), false],
  ["renameConfiguration", () => main.renameConfiguration("new"), undefined],
  ["addLayer", () => main.addLayer(), undefined],
];

describe("actions refused while logged out", () => {
  let createNotification: ReturnType<typeof vi.spyOn>;
  let apiCalls: ReturnType<typeof vi.spyOn>[];

  beforeEach(() => {
    const state = (store.state as any).main;
    state.girderUser = null;
    // A configuration and dataset are present so that only the login guard
    // can stop these actions.
    state.configuration = {
      id: "config1",
      name: "config",
      description: "",
      ...exampleConfigurationBase(),
    };
    state.dataset = { id: "ds1" };
    createNotification = vi
      .spyOn(progress, "createNotification")
      .mockResolvedValue(undefined as any);
    apiCalls = (
      [
        "updateConfigurationKey",
        "deleteLargeImage",
        "createDatasetView",
        "deleteDatasetView",
        "createDataset",
        "createConfigurationFromDataset",
        "deleteConfiguration",
        "deleteDataset",
        "findDatasetViews",
        "renameConfiguration",
      ] as const
    ).map((method) =>
      vi.spyOn(main.api as any, method).mockResolvedValue(undefined),
    );
  });

  afterEach(() => {
    const state = (store.state as any).main;
    state.configuration = null;
    state.dataset = null;
    vi.restoreAllMocks();
  });

  it.each(guardedActions)(
    "%s warns once, resolves, and makes no request",
    async (_name, dispatch, resolved) => {
      await expect(dispatch()).resolves.toBe(resolved);
      expect(createNotification).toHaveBeenCalledTimes(1);
      expect(createNotification).toHaveBeenCalledWith(notLoggedInNotification);
      for (const apiCall of apiCalls) {
        expect(apiCall).not.toHaveBeenCalled();
      }
    },
  );

  it("warns once when one submission is refused several times", async () => {
    // Adding five datasets to a collection calls createDatasetView five
    // times; the user should see one warning, not five. This needs the real
    // notification list, so the spy is lifted.
    createNotification.mockRestore();
    const before = progress.notifications.length;
    await Promise.all(
      ["ds1", "ds2", "ds3"].map((datasetId) =>
        main.createDatasetView({ datasetId, configurationId: "config1" }),
      ),
    );
    const added = progress.notifications.slice(before);
    expect(added.map((notification) => notification.title)).toEqual([
      "Authentication Required",
    ]);
    added.forEach((notification) =>
      progress.dismissNotification(notification.id),
    );
  });

  it("addLayer leaves the layers untouched", async () => {
    const layersBefore = main.layers.length;
    await main.addLayer();
    expect(main.layers).toHaveLength(layersBefore);
  });

  it("syncConfiguration with throwOnError warns, then throws its own error", async () => {
    // Exact message: with rawError the caller (the AI panel) shows it as is.
    let thrown: unknown;
    try {
      await main.syncConfiguration({ key: "layers", throwOnError: true });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toBe(
      "Authentication is required to save configuration",
    );
    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(createNotification).toHaveBeenCalledWith(notLoggedInNotification);
    for (const apiCall of apiCalls) {
      expect(apiCall).not.toHaveBeenCalled();
    }
  });
});

// A guest may change the configuration they are looking at; the change lasts
// for the session and is not saved. Every action below applies it locally and
// then calls syncConfiguration, so warning that the user "must be logged in to
// perform this action" would be wrong, and loading a snapshot would warn
// twice. The rule lives in syncConfiguration, not at each call site.
describe("view changes kept for the session while logged out", () => {
  let createNotification: ReturnType<typeof vi.spyOn>;
  let updateConfigurationKey: ReturnType<typeof vi.spyOn>;
  const layer = (id: string, visible: boolean) =>
    ({ id, name: id, visible, channel: 0 }) as any;

  beforeEach(() => {
    const state = (store.state as any).main;
    state.girderUser = null;
    state.configuration = {
      id: "config1",
      name: "config",
      description: "",
      ...exampleConfigurationBase(),
      layers: [layer("l1", true), layer("l2", true)],
    };
    state.dataset = { id: "ds1" };
    createNotification = vi
      .spyOn(progress, "createNotification")
      .mockResolvedValue(undefined as any);
    updateConfigurationKey = vi
      .spyOn(main.api as any, "updateConfigurationKey")
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    const state = (store.state as any).main;
    state.configuration = null;
    state.dataset = null;
    vi.restoreAllMocks();
  });

  it("syncConfiguration skips the save without warning", async () => {
    await expect(main.syncConfiguration("layers")).resolves.toBeUndefined();
    await expect(
      main.syncConfiguration({ key: "layers" }),
    ).resolves.toBeUndefined();
    expectSilentAndUnsaved();
  });

  it("removeLayer removes the layer without warning or saving", async () => {
    await main.removeLayer("l1");
    expect(main.layers.map((l) => l.id)).toEqual(["l2"]);
    expectSilentAndUnsaved();
  });

  function expectSilentAndUnsaved() {
    expect(createNotification).not.toHaveBeenCalled();
    expect(updateConfigurationKey).not.toHaveBeenCalled();
  }

  it("saveVisibilityConfig applies the settings without warning or saving", async () => {
    const config = { marker: "visibility" } as any;
    await main.saveVisibilityConfig(config);
    expect((store.state as any).main.configuration.visibilityConfig).toEqual(
      config,
    );
    expectSilentAndUnsaved();
  });

  it("saveOverviewConfig applies the settings without warning or saving", async () => {
    const config = { marker: "overview" } as any;
    await main.saveOverviewConfig(config);
    expect((store.state as any).main.configuration.overviewConfig).toEqual(
      config,
    );
    expectSilentAndUnsaved();
  });

  it("setConfigurationLayers replaces the layers without warning or saving", async () => {
    await main.setConfigurationLayers([layer("l2", true), layer("l1", true)]);
    expect(main.layers.map((l) => l.id)).toEqual(["l2", "l1"]);
    expectSilentAndUnsaved();
  });

  it("loadLayersVisibilityInConfiguration applies visibility without warning or saving", async () => {
    await main.loadLayersVisibilityInConfiguration([
      layer("l1", false),
      layer("l2", true),
    ]);
    expect(main.layers.map((l) => l.visible)).toEqual([false, true]);
    expectSilentAndUnsaved();
  });

  it("saveColorByProperty applies the legend without warning or saving", async () => {
    const legend = {
      type: "continuous",
      propertyPath: ["prop1"],
      propertyName: "Prop 1",
      colormap: "viridis",
      stops: ["#440154", "#fde725"],
      min: 0,
      max: 10,
      showLegend: false,
    } as any;
    await main.saveColorByProperty(legend);
    expect(main.colorByPropertyForCurrentDataset).toEqual(legend);
    expectSilentAndUnsaved();
  });
});

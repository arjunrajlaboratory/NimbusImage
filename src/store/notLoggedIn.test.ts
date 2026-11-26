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

// Every action that guards on isLoggedIn, with the value it resolves to when
// the guard trips.
const guardedActions: [string, () => Promise<unknown>, unknown][] = [
  ["syncConfiguration", () => main.syncConfiguration("layers"), undefined],
  [
    "syncConfiguration (object payload)",
    () => main.syncConfiguration({ key: "layers" }),
    undefined,
  ],
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
    async () => main.deleteDatasetView({ id: "view1" } as any),
    undefined,
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

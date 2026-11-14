import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Dispatches the REAL Vuex action (no "@/store" mock): the collection default
// panel layout is the only part of the panel layout that reaches the server,
// and it must do so as exactly one configuration write per explicit request.
import main from "./index";
import store from "./root";
import { setBaseCollectionValues } from "./GirderAPI";
import {
  configurationBaseKeys,
  exampleConfigurationBase,
  IDatasetConfigurationBase,
} from "./model";
import { layoutWithOpenSet, validateLayout } from "@/utils/panelLayout";

function setLoggedIn(loggedIn: boolean) {
  (store.state as any).main.girderUser = loggedIn ? { _id: "u1" } : null;
}

function setConfiguration(present: boolean) {
  (store.state as any).main.configuration = present
    ? {
        id: "config1",
        name: "config",
        description: "",
        ...exampleConfigurationBase(),
      }
    : null;
}

describe("collection default panel layout", () => {
  let updateConfigurationKey: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setLoggedIn(true);
    setConfiguration(true);
    updateConfigurationKey = vi.fn(async () => ({}));
    (main as any).api.updateConfigurationKey = updateConfigurationKey;
  });

  afterEach(() => {
    setConfiguration(false);
    setLoggedIn(false);
    vi.restoreAllMocks();
  });

  it("saving stores the layout and writes that one key once", async () => {
    const layout = layoutWithOpenSet(["layersPanel", "annotationPanel"]);
    await main.saveDefaultPanelLayout(layout);
    expect((store.state as any).main.configuration.defaultPanelLayout).toEqual(
      layout,
    );
    expect(updateConfigurationKey).toHaveBeenCalledTimes(1);
    expect(updateConfigurationKey.mock.calls[0][1]).toBe("defaultPanelLayout");
  });

  it("clearing writes null, which the server drops from the metadata", async () => {
    await main.saveDefaultPanelLayout(layoutWithOpenSet(["toolsPanel"]));
    await main.saveDefaultPanelLayout(null);
    expect(
      (store.state as any).main.configuration.defaultPanelLayout,
    ).toBeNull();
    expect(updateConfigurationKey).toHaveBeenCalledTimes(2);
    // What is sent is read from the configuration at call time.
    expect(
      updateConfigurationKey.mock.calls[1][0].defaultPanelLayout,
    ).toBeNull();
  });

  it("writes nothing with no configuration open", async () => {
    setConfiguration(false);
    await main.saveDefaultPanelLayout(layoutWithOpenSet(["toolsPanel"]));
    expect(updateConfigurationKey).not.toHaveBeenCalled();
  });

  it("is a configuration key, so it is sent and read back", () => {
    expect(configurationBaseKeys.has("defaultPanelLayout")).toBe(true);
    const meta = {
      ...exampleConfigurationBase(),
      defaultPanelLayout: { version: 1, open: ["snapshotPanel"] },
    };
    const configuration = setBaseCollectionValues({
      _id: "config1",
      name: "config",
      description: "",
      meta,
    } as any);
    expect(validateLayout(configuration.defaultPanelLayout)?.open).toEqual([
      "snapshotPanel",
    ]);
  });

  it("a configuration saved before this existed has no default", () => {
    const meta: Partial<IDatasetConfigurationBase> = exampleConfigurationBase();
    delete meta.defaultPanelLayout;
    const configuration = setBaseCollectionValues({
      _id: "config1",
      name: "config",
      description: "",
      meta,
    } as any);
    expect(validateLayout(configuration.defaultPanelLayout)).toBeNull();
  });
});

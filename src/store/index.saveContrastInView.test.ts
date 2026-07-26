import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import main from "./index";
import store from "./root";

// The generated module accessor exposes state as non-configurable getters, so
// login state has to be set on the underlying Vuex state directly.
function setLoggedIn(loggedIn: boolean) {
  (store.state as any).main.girderUser = loggedIn ? { _id: "u1" } : null;
}

// Regression test for issue #1239 / Codex review on PR #1262:
// saveContrastInView must NOT silently succeed when the personal dataset view
// cannot be persisted. Only callers opting into throwOnError (the AI panel)
// see the rejection; interactive UI callers keep the silent local-override
// behavior.
//
// These tests dispatch the REAL Vuex actions (no "./index" mock) on purpose:
// vuex-module-decorators replaces any error thrown from an @Action with a
// generic "ERR_ACTION_ACCESS_UNDEFINED" message unless the action declares
// { rawError: true }. That quirk silently defeats this whole feature - the AI
// panel would still report a failure, but with a cryptic message plus stack
// traces instead of the real reason. See the matching note in index.test.ts.

const contrast = {
  mode: "percentile",
  blackPoint: 5,
  whitePoint: 95,
} as any;

// `.rejects.toThrow(/regex/)` only checks that the message CONTAINS the
// pattern, and the ERR_ACTION_ACCESS_UNDEFINED wrapper embeds the original
// error's `.stack` (which includes its message) inside its own message. So a
// substring match passes even when rawError is missing. Assert on the exact
// message instead so a regression is actually caught.
async function messageOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("Expected the promise to reject, but it resolved");
}

describe("saveContrastInView throwOnError", () => {
  beforeEach(() => {
    // Make updateDatasetView observable/benign for the editable path.
    (main as any).api.updateDatasetView = vi.fn(async () => ({}));
  });

  it("throws when there is no dataset view", async () => {
    main.setDatasetViewImpl(null);
    expect(
      await messageOf(
        main.saveContrastInView({
          layerId: "l1",
          contrast,
          throwOnError: true,
        }),
      ),
    ).toBe("Cannot save the contrast: no dataset view is open");
  });

  it("throws when the dataset view is not editable", async () => {
    // _accessLevel 0 => canEditDatasetView is false regardless of login.
    main.setDatasetViewImpl({ layerContrasts: {}, _accessLevel: 0 } as any);
    expect(
      await messageOf(
        main.saveContrastInView({
          layerId: "l1",
          contrast,
          throwOnError: true,
        }),
      ),
    ).toBe(
      "Cannot save the contrast: you do not have permission to edit this " +
        "dataset view",
    );
    // The local override is still applied (it just can't be persisted).
    expect(main.datasetView?.layerContrasts.l1).toEqual(contrast);
  });

  it("does not throw for non-AI callers even when not editable", async () => {
    main.setDatasetViewImpl({ layerContrasts: {}, _accessLevel: 0 } as any);
    // No throwOnError: interactive UI behavior is unchanged (silent).
    await expect(
      main.saveContrastInView({ layerId: "l1", contrast }),
    ).resolves.toBeUndefined();
    expect(main.datasetView?.layerContrasts.l1).toEqual(contrast);
  });

  it("propagates the backend's own message when persisting the view fails", async () => {
    main.setDatasetViewImpl({ layerContrasts: {}, _accessLevel: 2 } as any);
    setLoggedIn(true);
    (main as any).api.updateDatasetView = vi.fn(async () => {
      throw new Error("Storage quota exceeded");
    });

    expect(
      await messageOf(
        main.saveContrastInView({
          layerId: "l1",
          contrast,
          throwOnError: true,
        }),
      ),
    ).toBe("Storage quota exceeded");
  });
});

// The configuration-scoped mutators reach the backend through
// syncConfiguration, which rethrows the API error when throwOnError is set.
// That error crosses two @Action boundaries (e.g. changeLayer ->
// syncConfiguration), so BOTH must declare rawError: true for the original
// message to survive.
describe("configuration mutators propagate the backend error unmangled", () => {
  beforeEach(() => {
    setLoggedIn(true);
    (main as any).setConfigurationImpl({
      id: "c1",
      data: {
        id: "c1",
        name: "config",
        layers: [{ id: "l1", name: "DAPI", visible: true }],
        tools: [],
        scales: {},
      } as any,
    });
    (main as any).api.updateConfigurationKey = vi.fn(async () => {
      throw new Error("Backend rejected the write");
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("syncConfiguration surfaces the API error", async () => {
    expect(
      await messageOf(
        main.syncConfiguration({ key: "layers", throwOnError: true }),
      ),
    ).toBe("Backend rejected the write");
  });

  it("changeLayer surfaces the API error through syncConfiguration", async () => {
    expect(
      await messageOf(
        main.changeLayer({
          layerId: "l1",
          delta: { color: "#ff0000" },
          throwOnError: true,
        }),
      ),
    ).toBe("Backend rejected the write");
  });

  it("saveScaleInConfiguration surfaces the API error", async () => {
    expect(
      await messageOf(
        main.saveScaleInConfiguration({
          itemId: "pixelSize",
          scale: { value: 1, unit: "µm" } as any,
          throwOnError: true,
        }),
      ),
    ).toBe("Backend rejected the write");
  });

  it("addToolToConfiguration surfaces the API error", async () => {
    expect(
      await messageOf(
        main.addToolToConfiguration({
          tool: { id: "t1", name: "tool", type: "create" } as any,
          throwOnError: true,
        }),
      ),
    ).toBe("Backend rejected the write");
  });

  it("still swallows the error for callers that do not opt in", async () => {
    await expect(main.syncConfiguration("layers")).resolves.toBeUndefined();
  });

  // addToolToConfiguration accepts either a bare tool (interactive callers) or
  // {tool, throwOnError} (the AI panel). The executors test mocks the action,
  // so only a real dispatch exercises which branch a payload takes. The
  // `tool: "future-field"` below stands in for IToolConfiguration one day
  // gaining a "tool" key, which would silently misroute a bare payload if the
  // discrimination keyed off "tool" in payload instead of "template".
  it("adds the tool for both the bare and wrapped payload forms", async () => {
    (main as any).api.updateConfigurationKey = vi.fn(async () => ({}));
    const bare = {
      id: "bare",
      name: "bare tool",
      type: "create",
      template: { name: "t", interface: [] },
      values: {},
      hotkey: null,
      tool: "future-field",
    } as any;
    await main.addToolToConfiguration(bare);
    expect(main.configuration?.tools.map((t) => t.id)).toContain("bare");

    await main.addToolToConfiguration({
      tool: { ...bare, id: "wrapped" },
      throwOnError: true,
    });
    expect(main.configuration?.tools.map((t) => t.id)).toContain("wrapped");
  });
});

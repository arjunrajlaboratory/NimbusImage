/**
 * The dataset_view PUTs for lastViewed and lastLocation are bookkeeping: a
 * failed one must not keep a view from loading or go unhandled. Dispatches the
 * REAL main-store actions; only fetches are stubbed (same harness as
 * datasetLocationClamp.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import main from "../index";
import sync from "../sync";
import rootStore from "../root";
import "../filters";
import "../properties";
import "../connectionList";
import { IDataset, IDatasetView } from "../model";
import { logError } from "@/utils/log";

vi.mock("@/utils/log", () => ({ logError: vi.fn(), logWarning: vi.fn() }));

const state = () => (rootStore.state as any).main;
const actions = (rootStore as any)._actions as Record<string, any[]>;
let savedActions: Record<string, any[] | undefined>;

function stubAction(name: string, handler: (payload: any) => any) {
  if (!(name in savedActions)) {
    savedActions[name] = actions[name];
  }
  actions[name] = [async (payload: any) => handler(payload)];
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(logError).mockClear();
  savedActions = {};
  stubAction(
    "getDataset",
    ({ id }) => ({ id, xy: [0, 1], z: [0, 1, 2], time: [0] }) as IDataset,
  );
  stubAction("getAllLargeImages", () => []);
  stubAction("getConfiguration", () => ({ id: "config" }));
  vi.spyOn(main.api, "getDatasetView").mockImplementation(
    async (id) =>
      ({
        id,
        datasetId: "ds1",
        configurationId: "config",
        layerContrasts: {},
        scales: {},
        lastViewed: 0,
        lastLocation: { xy: 1, z: 2, time: 0 },
        _accessLevel: 2,
      }) as IDatasetView,
  );
  vi.spyOn(main.api, "updateDatasetView").mockResolvedValue(undefined as any);
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

describe("dataset view bookkeeping saves", () => {
  it("a failed lastViewed PUT still ends loading and applies the view", async () => {
    const updateDatasetView = vi
      .spyOn(main.api, "updateDatasetView")
      .mockRejectedValue(new Error("PUT failed"));

    await main.setDatasetViewId({ id: "v" });

    expect(updateDatasetView).toHaveBeenCalled();
    expect(logError).toHaveBeenCalled();
    expect(sync.datasetLoading).toBe(false);
    expect(main.datasetView?.id).toBe("v");
    expect(main.dataset?.id).toBe("ds1");
    expect([main.xy, main.z, main.time]).toEqual([1, 2, 0]);
  });

  it("a failed lastViewed PUT still ends loading when the dataset is already loaded", async () => {
    await main.setDatasetViewId({ id: "v" });
    vi.spyOn(main.api, "updateDatasetView").mockRejectedValue(
      new Error("PUT failed"),
    );
    const getDataset = vi.fn(
      ({ id }) => ({ id, xy: [0, 1], z: [0, 1, 2], time: [0] }) as IDataset,
    );
    stubAction("getDataset", getDataset);

    // Same dataset: setSelectedDataset is skipped, so only setDatasetViewId
    // can end the loading it started.
    await main.setDatasetViewId({ id: "w" });

    expect(getDataset).not.toHaveBeenCalled();
    expect(sync.datasetLoading).toBe(false);
    expect(main.datasetView?.id).toBe("w");
  });

  it("a failed lastLocation save is logged, not left unhandled", async () => {
    await main.setDatasetViewId({ id: "v" });
    vi.spyOn(main.api, "updateDatasetView").mockRejectedValue(
      new Error("PUT failed"),
    );

    await main.setXY(0);
    await expect(main.flushLastLocationInDatasetView()).resolves.toBe(
      undefined,
    );

    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining("lastLocation"),
      expect.any(Error),
    );
  });
});

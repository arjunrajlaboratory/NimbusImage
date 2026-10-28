import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ store: null as any }));

vi.mock("@/store", () => {
  mocks.store = {
    dataset: { xy: [0, 1], z: [0, 1, 2, 3, 4], time: [0, 1, 2] },
    xy: 0,
    z: 0,
    time: 0,
    layers: [] as any[],
    setXY: vi.fn(async (v: number) => void (mocks.store.xy = v)),
    setZ: vi.fn(async (v: number) => void (mocks.store.z = v)),
    setTime: vi.fn(async (v: number) => void (mocks.store.time = v)),
    changeLayer: vi.fn(),
    syncConfiguration: vi.fn(),
    setSelectedToolId: vi.fn(),
  };
  return { default: mocks.store };
});

import { goToLocation, selectTool, setVisibleLayers } from "./operations";

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(mocks.store, { xy: 0, z: 0, time: 0 });
});

describe("goToLocation", () => {
  it("clamps each index into the dataset's range", async () => {
    expect(await goToLocation({ xy: 9, z: -3, time: 2 })).toEqual({
      xy: 1,
      z: 0,
      time: 2,
    });
    expect(mocks.store.setXY).toHaveBeenCalledWith(1);
    expect(mocks.store.setZ).toHaveBeenCalledWith(0);
  });

  it("leaves omitted axes alone", async () => {
    await goToLocation({ z: 3 });
    expect(mocks.store.setXY).not.toHaveBeenCalled();
    expect(mocks.store.setTime).not.toHaveBeenCalled();
    expect(mocks.store.z).toBe(3);
  });

  it("moves nothing without a dataset", async () => {
    const dataset = mocks.store.dataset;
    mocks.store.dataset = null;
    await goToLocation({ z: 3 });
    mocks.store.dataset = dataset;
    expect(mocks.store.setZ).not.toHaveBeenCalled();
  });
});

describe("setVisibleLayers", () => {
  it("changes only layers whose visibility differs, without syncing", async () => {
    mocks.store.layers = [
      { id: "a", visible: true },
      { id: "b", visible: true },
      { id: "c", visible: false },
    ];
    await setVisibleLayers(["a", "c"]);
    expect(mocks.store.changeLayer).toHaveBeenCalledTimes(2);
    expect(mocks.store.changeLayer).toHaveBeenCalledWith({
      layerId: "b",
      delta: { visible: false },
      sync: false,
    });
    expect(mocks.store.changeLayer).toHaveBeenCalledWith({
      layerId: "c",
      delta: { visible: true },
      sync: false,
    });
    expect(mocks.store.syncConfiguration).not.toHaveBeenCalled();
  });
});

describe("selectTool", () => {
  it("selects by id, or deselects with null", async () => {
    await selectTool("t1");
    await selectTool(null);
    expect(mocks.store.setSelectedToolId).toHaveBeenNthCalledWith(1, "t1");
    expect(mocks.store.setSelectedToolId).toHaveBeenNthCalledWith(2, null);
  });
});

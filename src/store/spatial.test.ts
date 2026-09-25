import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchInfo: vi.fn(),
  saveScalesInConfiguration: vi.fn(),
  main: null as any,
}));

vi.mock("@/store/index", async () => {
  const { reactive } = await import("vue");
  mocks.main = reactive({
    dataset: { id: "ds1" } as { id: string } | null,
    configuration: {
      id: "cfg1",
      scales: { pixelSize: { value: 0, unit: "mm" } },
    } as any,
    canEditDatasetView: true,
    spatialAPI: { fetchInfo: (...a: any[]) => mocks.fetchInfo(...a) },
    // Mirrors the real action: it assigns into configuration.scales before
    // syncing, and the "write once" guard reads that value back.
    saveScalesInConfiguration: (payload: any) => {
      mocks.saveScalesInConfiguration(payload);
      Object.assign(mocks.main.configuration.scales, payload.scales);
      return Promise.resolve();
    },
  });
  return { default: mocks.main };
});

vi.mock("@/utils/log", () => ({ logError: vi.fn() }));

import spatialStore from "./spatial";

const INFO = {
  datasetId: "ds1",
  itemId: "i",
  fileId: "f",
  schemaVersion: 1,
  nObs: 10,
  nVar: 4,
  obsColumns: [],
  pixelSize: 0.2125,
};

describe("spatial store: the configuration scale pulls from the registry", () => {
  beforeEach(() => {
    mocks.fetchInfo.mockReset().mockResolvedValue(INFO);
    mocks.saveScalesInConfiguration.mockReset();
    mocks.main.dataset = { id: "ds1" };
    mocks.main.canEditDatasetView = true;
    mocks.main.configuration = {
      id: "cfg1",
      scales: { pixelSize: { value: 0, unit: "mm" } },
    };
    spatialStore.setInfo({ datasetId: "", info: null });
  });

  it("writes the registry's microns per pixel when the scale is unset", async () => {
    await spatialStore.refreshInfo();
    expect(mocks.saveScalesInConfiguration).toHaveBeenCalledWith({
      scales: { pixelSize: { value: 0.2125, unit: "µm" } },
    });
  });

  it("never overwrites a pixel size someone already set", async () => {
    mocks.main.configuration.scales.pixelSize = { value: 0.5, unit: "µm" };
    await spatialStore.refreshInfo();
    expect(mocks.saveScalesInConfiguration).not.toHaveBeenCalled();
  });

  it("does not write for a read-only viewer or a share link", async () => {
    mocks.main.canEditDatasetView = false;
    await spatialStore.refreshInfo();
    expect(mocks.saveScalesInConfiguration).not.toHaveBeenCalled();
  });

  it("does nothing when the table has no pixel size", async () => {
    mocks.fetchInfo.mockResolvedValue({ ...INFO, pixelSize: null });
    await spatialStore.refreshInfo();
    expect(mocks.saveScalesInConfiguration).not.toHaveBeenCalled();
  });

  it("writes once, not on every refresh", async () => {
    await spatialStore.refreshInfo();
    expect(mocks.saveScalesInConfiguration).toHaveBeenCalledTimes(1);
    await spatialStore.refreshInfo();
    expect(mocks.saveScalesInConfiguration).toHaveBeenCalledTimes(1);
  });
});

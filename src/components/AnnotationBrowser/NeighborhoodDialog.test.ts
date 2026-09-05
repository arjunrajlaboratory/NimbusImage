import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { nextTick } from "vue";
import { shallowMount } from "@vue/test-utils";

const mocks = vi.hoisted(() => ({
  fetchNeighborhood: vi.fn(),
  computeNeighborhood: vi.fn(),
  fetchJob: vi.fn(),
  fetchProperties: vi.fn(),
  fetchPropertyPathsSample: vi.fn(),
  downloadToClient: vi.fn(),
  scales: { pixelSize: { value: 0.5, unit: "µm" } } as any,
}));

// Reactive: the dialog's pixel conversion is a computed over store.scales.
vi.mock("@/store", async () => {
  const { reactive } = await import("vue");
  return {
    default: reactive({
      dataset: { id: "ds1", name: "Lymph" },
      scales: mocks.scales,
      spatialAPI: {
        fetchNeighborhood: mocks.fetchNeighborhood,
        computeNeighborhood: mocks.computeNeighborhood,
        fetchJob: mocks.fetchJob,
      },
    }),
  };
});
vi.mock("@/store/properties", () => ({
  default: {
    fetchProperties: mocks.fetchProperties,
    fetchPropertyPathsSample: mocks.fetchPropertyPathsSample,
  },
}));
vi.mock("@/utils/download", () => ({
  downloadToClient: mocks.downloadToClient,
}));
vi.mock("@/utils/log", () => ({ logError: vi.fn() }));
vi.mock("@/utils/errors", () => ({
  extractErrorMessage: (error: any) => error?.message ?? String(error),
}));
vi.mock("papaparse", () => ({
  default: {
    unparse: ({ fields, data }: any) =>
      [fields.join(","), ...data.map((row: any[]) => row.join(","))].join("\n"),
  },
}));

import NeighborhoodDialog from "./NeighborhoodDialog.vue";
import store from "@/store";

const RESULT = {
  radius: 60,
  excludeTags: ["cell"],
  types: ["B", "T"],
  counts: [3, 2],
  pairs: [
    [4, 2],
    [2, 0],
  ],
  matrix: [
    [0.5, -0.3],
    [-0.3, null],
  ],
  cells: 5,
  typed: 5,
  written: 5,
  propertyId: "p1",
  computed: "2026-09-03T00:00:00Z",
};

async function open() {
  const wrapper = shallowMount(NeighborhoodDialog);
  (wrapper.vm as any).dialog = true;
  // Fake timers are on: flush the load() promise chain with ticks, not a
  // setTimeout that would never fire.
  await nextTick();
  await vi.advanceTimersByTimeAsync(0);
  await nextTick();
  return wrapper;
}

describe("NeighborhoodDialog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.fetchNeighborhood.mockReset().mockResolvedValue(null);
    mocks.computeNeighborhood.mockReset().mockResolvedValue({
      jobId: "j1",
      propertyId: "p1",
    });
    mocks.fetchJob.mockReset();
    mocks.fetchProperties.mockReset().mockResolvedValue(undefined);
    mocks.fetchPropertyPathsSample.mockReset().mockResolvedValue(undefined);
    mocks.downloadToClient.mockReset();
    (store as any).scales = { pixelSize: { value: 0.5, unit: "µm" } };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("converts microns to pixels with the dataset scale and refuses without one", async () => {
    const wrapper = await open();
    const vm = wrapper.vm as any;
    expect(vm.radiusPixels).toBe(60);
    expect(vm.canRun).toBe(true);
    (store as any).scales = {};
    await nextTick();
    expect(vm.radiusPixels).toBeNull();
    expect(vm.canRun).toBe(false);
  });

  it("loads the stored enrichment when opened", async () => {
    mocks.fetchNeighborhood.mockResolvedValue(RESULT);
    const wrapper = await open();
    expect(mocks.fetchNeighborhood).toHaveBeenCalledWith("ds1");
    expect((wrapper.vm as any).result).toEqual(RESULT);
  });

  it("schedules the job in pixels, polls it, and reloads the properties", async () => {
    mocks.fetchJob
      .mockResolvedValueOnce({ _id: "j1", status: 2 })
      .mockResolvedValueOnce({ _id: "j1", status: 3, spatialResult: RESULT });
    const wrapper = await open();
    const vm = wrapper.vm as any;
    vm.radiusMicrons = 30;
    await vm.run();
    expect(mocks.computeNeighborhood).toHaveBeenCalledWith(
      "ds1",
      60,
      ["cell"],
      "Neighborhood",
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(vm.running).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(vm.running).toBe(false);
    expect(vm.result).toEqual(RESULT);
    expect(mocks.fetchProperties).toHaveBeenCalledTimes(1);
  });

  it("reports failures and exports the matrix as CSV", async () => {
    mocks.fetchJob.mockResolvedValue({ _id: "j1", status: 4 });
    const wrapper = await open();
    const vm = wrapper.vm as any;
    await vm.run();
    await vi.advanceTimersByTimeAsync(2000);
    expect(vm.error).toContain("job failed");
    expect(vm.buildCsv(RESULT).split("\n")).toEqual([
      "type,cells,B,T",
      "B,3,0.5,-0.3",
      "T,2,-0.3,",
    ]);
    vm.result = RESULT;
    vm.download();
    expect(mocks.downloadToClient).toHaveBeenCalledWith(
      expect.objectContaining({ download: "Lymph-neighborhood.csv" }),
    );
  });
});

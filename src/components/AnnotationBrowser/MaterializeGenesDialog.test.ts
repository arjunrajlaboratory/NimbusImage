import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { nextTick } from "vue";
import { shallowMount } from "@vue/test-utils";

const mocks = vi.hoisted(() => ({
  materialize: vi.fn(),
  fetchProperties: vi.fn(),
  fetchPropertyPathsSample: vi.fn(),
  fetchJobStatus: vi.fn(),
  ensureInfo: vi.fn(),
}));

vi.mock("@/store", () => ({
  default: {
    dataset: { id: "ds1", name: "Lymph" },
    spatialAPI: { materialize: mocks.materialize },
  },
}));

vi.mock("@/store/properties", () => ({
  default: {
    fetchProperties: mocks.fetchProperties,
    fetchPropertyPathsSample: mocks.fetchPropertyPathsSample,
  },
}));

vi.mock("@/store/spatial", async () => {
  const { reactive } = await import("vue");
  return {
    default: reactive({
      hasTable: true,
      info: { nObs: 708983, nVar: 4624 },
      ensureInfo: mocks.ensureInfo,
    }),
  };
});

vi.mock("@/store/jobs", () => ({
  default: { fetchJobStatus: mocks.fetchJobStatus },
}));

vi.mock("@/utils/errors", () => ({
  extractErrorMessage: (error: any) =>
    error?.response?.data?.message ?? error?.message ?? String(error),
}));

import MaterializeGenesDialog from "./MaterializeGenesDialog.vue";

async function openDialog() {
  const wrapper = shallowMount(MaterializeGenesDialog);
  (wrapper.vm as any).dialog = true;
  await nextTick();
  return wrapper;
}

describe("MaterializeGenesDialog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.materialize.mockReset();
    mocks.fetchProperties.mockReset().mockResolvedValue(undefined);
    mocks.fetchPropertyPathsSample.mockReset().mockResolvedValue(undefined);
    mocks.fetchJobStatus.mockReset();
    mocks.ensureInfo.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("describes the table and looks up the registration when opened", async () => {
    const wrapper = await openDialog();
    expect((wrapper.vm as any).tableFacts).toBe(
      "708,983 cells × 4,624 genes in the table",
    );
    expect(mocks.ensureInfo).toHaveBeenCalledTimes(1);
  });

  it("writes inline results and reloads the property list", async () => {
    mocks.materialize.mockResolvedValue({
      propertyId: "p1",
      written: 6,
      jobId: null,
    });
    const wrapper = await openDialog();
    const vm = wrapper.vm as any;
    vm.symbols = ["CD3E", "MS4A1"];
    vm.propertyName = " Panel ";
    await vm.materialize();
    expect(mocks.materialize).toHaveBeenCalledWith(
      "ds1",
      ["CD3E", "MS4A1"],
      "Panel",
    );
    expect(mocks.fetchProperties).toHaveBeenCalledTimes(1);
    expect(mocks.fetchPropertyPathsSample).toHaveBeenCalledTimes(1);
    expect(vm.done).toContain("Wrote 2 genes for 6 cells");
    expect(vm.running).toBe(false);
  });

  it("polls a scheduled job until it succeeds", async () => {
    mocks.materialize.mockResolvedValue({
      propertyId: "p1",
      written: 0,
      jobId: "job1",
    });
    mocks.fetchJobStatus.mockResolvedValueOnce(2).mockResolvedValueOnce(3);
    const wrapper = await openDialog();
    const vm = wrapper.vm as any;
    vm.symbols = ["CD3E"];
    await vm.materialize();
    expect(vm.running).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(mocks.fetchJobStatus).toHaveBeenCalledTimes(1);
    expect(vm.running).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(mocks.fetchJobStatus).toHaveBeenCalledTimes(2);
    expect(vm.running).toBe(false);
    expect(vm.done).toContain("708,983 cells");
  });

  it("reports a failed job and a rejected request", async () => {
    mocks.materialize.mockResolvedValue({
      propertyId: "p1",
      written: 0,
      jobId: "job1",
    });
    mocks.fetchJobStatus.mockResolvedValue(4);
    const wrapper = await openDialog();
    const vm = wrapper.vm as any;
    vm.symbols = ["CD3E"];
    await vm.materialize();
    await vi.advanceTimersByTimeAsync(2000);
    expect(vm.error).toContain("job failed");
    expect(vm.running).toBe(false);

    mocks.materialize.mockRejectedValue({
      response: { data: { message: "features exceeds 64" } },
    });
    await vm.materialize();
    expect(vm.error).toBe("features exceeds 64");
  });

  it("stops polling when the dialog closes", async () => {
    mocks.materialize.mockResolvedValue({
      propertyId: "p1",
      written: 0,
      jobId: "job1",
    });
    const wrapper = await openDialog();
    const vm = wrapper.vm as any;
    vm.symbols = ["CD3E"];
    await vm.materialize();
    vm.dialog = false;
    await nextTick();
    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.fetchJobStatus).not.toHaveBeenCalled();
    expect(vm.running).toBe(false);
  });
});

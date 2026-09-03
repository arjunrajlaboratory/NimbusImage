import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { nextTick } from "vue";
import { shallowMount } from "@vue/test-utils";

const mocks = vi.hoisted(() => ({
  differential: vi.fn(),
  fetchJob: vi.fn(),
  downloadToClient: vi.fn(),
}));

vi.mock("@/store", () => ({
  default: {
    dataset: { id: "ds1", name: "Lymph" },
    spatialAPI: { differential: mocks.differential, fetchJob: mocks.fetchJob },
  },
}));

vi.mock("@/utils/download", () => ({
  downloadToClient: mocks.downloadToClient,
}));

vi.mock("@/utils/log", () => ({ logError: vi.fn() }));

vi.mock("@/utils/errors", () => ({
  extractErrorMessage: (error: any) =>
    error?.response?.data?.message ?? error?.message ?? String(error),
}));

vi.mock("papaparse", () => ({
  default: {
    unparse: ({ fields, data }: any) =>
      [fields.join(","), ...data.map((row: any[]) => row.join(","))].join("\n"),
  },
}));

import DifferentialExpressionDialog from "./DifferentialExpressionDialog.vue";

const FILTERS_A = { tags: { values: ["Memory B Cell"], exclusive: false } };
const RESULT = {
  nA: 3,
  nB: 3,
  featuresTested: 4,
  features: [
    {
      symbol: "MS4A1",
      meanA: 2,
      meanB: 0,
      fractionA: 0.5,
      fractionB: 0,
      log2FoldChange: 7.6,
      t: 3.1,
      pValue: 0.01,
    },
  ],
};

async function openDialog() {
  const wrapper = shallowMount(DifferentialExpressionDialog, {
    props: { filtersA: FILTERS_A, groupALabel: "the filtered objects" },
  });
  (wrapper.vm as any).dialog = true;
  await nextTick();
  return wrapper;
}

describe("DifferentialExpressionDialog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.differential.mockReset().mockResolvedValue({ jobId: "j1", nA: 3 });
    mocks.fetchJob.mockReset();
    mocks.downloadToClient.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("compares A against everything else and polls the job for the table", async () => {
    mocks.fetchJob
      .mockResolvedValueOnce({ _id: "j1", status: 2 })
      .mockResolvedValueOnce({ _id: "j1", status: 3, spatialResult: RESULT });
    const wrapper = await openDialog();
    const vm = wrapper.vm as any;
    await vm.run();
    expect(mocks.differential).toHaveBeenCalledWith(
      "ds1",
      FILTERS_A,
      null,
      50,
      "welch",
    );
    expect(vm.running).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(vm.result).toBeNull();
    await vi.advanceTimersByTimeAsync(2000);
    expect(vm.result).toEqual(RESULT);
    expect(vm.running).toBe(false);
  });

  it("sends the picked tags as group B and refuses to run without any", async () => {
    const wrapper = await openDialog();
    const vm = wrapper.vm as any;
    vm.groupB = "tag";
    await nextTick();
    expect(vm.filtersB()).toEqual({ tags: { values: [], exclusive: false } });
    await vm.run();
    expect(mocks.differential).not.toHaveBeenCalled();
    vm.groupBTags = ["Endothelial Cell"];
    vm.maxFeatures = 900;
    vm.method = "wilcoxon";
    await vm.run();
    expect(mocks.differential).toHaveBeenCalledWith(
      "ds1",
      FILTERS_A,
      { tags: { values: ["Endothelial Cell"], exclusive: false } },
      500,
      "wilcoxon",
    );
  });

  it("reports a failed job and a rejected request, and stops polling on close", async () => {
    mocks.fetchJob.mockResolvedValue({ _id: "j1", status: 4 });
    const wrapper = await openDialog();
    const vm = wrapper.vm as any;
    await vm.run();
    await vi.advanceTimersByTimeAsync(2000);
    expect(vm.error).toContain("job failed");
    expect(vm.running).toBe(false);

    mocks.differential.mockRejectedValue({
      response: { data: { message: "filtersA must narrow the dataset" } },
    });
    await vm.run();
    expect(vm.error).toBe("filtersA must narrow the dataset");

    mocks.differential.mockResolvedValue({ jobId: "j2", nA: 3 });
    mocks.fetchJob.mockClear();
    await vm.run();
    vm.dialog = false;
    await nextTick();
    await vi.advanceTimersByTimeAsync(6000);
    expect(mocks.fetchJob).not.toHaveBeenCalled();
  });

  it("downloads the ranked table as CSV", async () => {
    const wrapper = await openDialog();
    const vm = wrapper.vm as any;
    vm.result = RESULT;
    await nextTick();
    const csv = vm.buildCsv(RESULT);
    expect(csv.split("\n")).toEqual([
      "Gene,log2FoldChange,MeanA,MeanB,FractionA,FractionB,t,pValue",
      "MS4A1,7.6,2,0,0.5,0,3.1,0.01",
    ]);
    vm.download();
    expect(mocks.downloadToClient).toHaveBeenCalledWith({
      href: "data:text/csv;charset=utf-8," + encodeURIComponent(csv),
      download: "Lymph-differential-expression.csv",
    });
  });
});

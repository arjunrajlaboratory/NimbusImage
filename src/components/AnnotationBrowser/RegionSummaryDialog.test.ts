import { describe, it, expect, vi, beforeEach } from "vitest";
import { nextTick } from "vue";
import { shallowMount } from "@vue/test-utils";

const mocks = vi.hoisted(() => ({
  regionSummary: vi.fn(),
  downloadToClient: vi.fn(),
}));

vi.mock("@/store", () => ({
  default: {
    dataset: { id: "ds1", name: "Lymph" },
    spatialAPI: { regionSummary: mocks.regionSummary },
  },
}));
vi.mock("@/store/spatial", async () => {
  const { reactive } = await import("vue");
  return { default: reactive({ hasTable: true }) };
});
vi.mock("@/store/annotation", () => ({
  default: {
    annotationTags: ["cell", "T", "region", "B"],
    selectedAnnotationIds: new Set(["r1", "r2"]),
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

import RegionSummaryDialog from "./RegionSummaryDialog.vue";
import spatialStore from "@/store/spatial";

const ROWS = [
  {
    id: "r1",
    name: "follicle",
    tags: ["region"],
    cells: 6,
    composition: [
      { type: "B", count: 4 },
      { type: "T", count: 2 },
    ],
    expression: [
      { symbol: "CD3E", mean: 1.25, fractionExpressing: 0.5, expressing: 3 },
    ],
    rows: 6,
  },
  {
    id: "r2",
    name: "medulla",
    tags: ["region"],
    cells: 1,
    composition: [{ type: "T", count: 1 }],
    expression: [
      { symbol: "CD3E", mean: null, fractionExpressing: 0, expressing: 0 },
    ],
    rows: 0,
  },
];

describe("RegionSummaryDialog", () => {
  beforeEach(() => {
    mocks.regionSummary.mockReset().mockResolvedValue(ROWS);
    mocks.downloadToClient.mockReset();
    (spatialStore as any).hasTable = true;
  });

  it("offers the dataset's tags and summarizes the chosen one with genes", async () => {
    const wrapper = shallowMount(RegionSummaryDialog);
    const vm = wrapper.vm as any;
    expect(vm.tagOptions).toEqual(["B", "T", "cell", "region"]);
    await vm.refresh(); // no tag yet: nothing happens
    expect(mocks.regionSummary).not.toHaveBeenCalled();
    vm.regionTag = "region";
    vm.symbols = ["CD3E"];
    await vm.refresh();
    expect(mocks.regionSummary).toHaveBeenCalledWith(
      "ds1",
      { regionTag: "region" },
      ["CD3E"],
    );
    expect(vm.rows).toEqual(ROWS);
    expect(vm.buildCsv().split("\n")).toEqual([
      "region,cells,B,T,CD3E",
      "follicle,6,4,2,1.25",
      "medulla,1,0,1,",
    ]);
  });

  it("asks for no genes without a table and surfaces errors", async () => {
    (spatialStore as any).hasTable = false;
    const wrapper = shallowMount(RegionSummaryDialog);
    const vm = wrapper.vm as any;
    vm.regionTag = "region";
    vm.symbols = ["CD3E"];
    await nextTick();
    await vm.refresh();
    expect(mocks.regionSummary).toHaveBeenCalledWith(
      "ds1",
      { regionTag: "region" },
      [],
    );
    // The current selection can be the regions instead of a tag.
    vm.source = "selection";
    await nextTick();
    expect(vm.canSummarize).toBe(true);
    await vm.refresh();
    expect(mocks.regionSummary).toHaveBeenLastCalledWith(
      "ds1",
      { regionIds: ["r1", "r2"] },
      [],
    );
    mocks.regionSummary.mockRejectedValue(new Error("offline"));
    await vm.refresh();
    expect(vm.error).toBe("offline");
  });
});

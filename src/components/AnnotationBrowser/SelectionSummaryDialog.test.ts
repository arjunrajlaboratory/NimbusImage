import { describe, it, expect, vi, beforeEach } from "vitest";
import { nextTick } from "vue";
import { shallowMount } from "@vue/test-utils";

const mocks = vi.hoisted(() => ({
  fetchAnnotationSummary: vi.fn(),
  aggregate: vi.fn(),
  downloadToClient: vi.fn(),
}));

vi.mock("@/store", () => ({
  default: {
    dataset: { id: "ds1", name: "Lymph" },
    annotationsAPI: { fetchAnnotationSummary: mocks.fetchAnnotationSummary },
    spatialAPI: { aggregate: mocks.aggregate },
  },
}));

vi.mock("@/store/annotation", async () => {
  const { reactive } = await import("vue");
  return {
    default: reactive({
      annotationCount: 10,
      selectedAnnotationIds: new Set<string>(),
      // Mirrors the real getter: stale ids are dropped.
      get resolvedSelectedAnnotationIds(): string[] {
        return Array.from(this.selectedAnnotationIds as Set<string>).filter(
          (id) => id !== "stale",
        );
      },
    }),
  };
});

vi.mock("@/store/filters", async () => {
  const { reactive } = await import("vue");
  return { default: reactive({ filteredAnnotations: [] as any[] }) };
});

vi.mock("@/store/properties", () => ({
  default: {
    displayedPropertyPaths: [["p", "Area"]],
    computedPropertyPaths: [
      ["p", "Area"],
      ["p", "Mean"],
    ],
    getFullNameFromPath: (path: string[]) =>
      ({ "p.Area": "Blob / Area", "p.Mean": "Blob / Mean" })[path.join(".")] ??
      null,
  },
}));

vi.mock("@/store/annotationListServer", async () => {
  const { reactive } = await import("vue");
  return {
    default: reactive({
      currentFilters: { tags: { values: ["A"], exclusive: false } },
      currentFiltersSignature: "sig-1",
    }),
  };
});

vi.mock("@/store/spatial", async () => {
  const { reactive } = await import("vue");
  return {
    default: reactive({ hasTable: false, info: null, ensureInfo: vi.fn() }),
  };
});

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

import SelectionSummaryDialog from "./SelectionSummaryDialog.vue";
import annotationStore from "@/store/annotation";
import filterStore from "@/store/filters";
import annotationListServer from "@/store/annotationListServer";
import spatialStore from "@/store/spatial";
import store from "@/store";
import { serializePropertyPath } from "@/utils/paths";

const SUMMARY = {
  total: 4,
  tags: [
    { tag: "A", count: 3 },
    { tag: "B", count: 1 },
  ],
  properties: [
    {
      path: ["p", "Area"],
      count: 2,
      mean: 10,
      std: 7.0710678,
      min: 5,
      max: 15,
    },
  ],
};

async function openDialog() {
  const wrapper = shallowMount(SelectionSummaryDialog);
  (wrapper.vm as any).dialog = true;
  await nextTick();
  await nextTick();
  return wrapper;
}

describe("SelectionSummaryDialog", () => {
  beforeEach(() => {
    mocks.fetchAnnotationSummary.mockReset();
    mocks.fetchAnnotationSummary.mockResolvedValue(SUMMARY);
    mocks.downloadToClient.mockReset();
    (annotationStore as any).selectedAnnotationIds = new Set<string>();
    (annotationStore as any).annotationCount = 10;
    (filterStore as any).filteredAnnotations = [];
  });

  it("opens on the whole dataset with the displayed columns when nothing is selected or filtered", async () => {
    (filterStore as any).filteredAnnotations = new Array(10).fill({});
    const wrapper = await openDialog();
    const vm = wrapper.vm as any;
    expect(vm.scope).toBe("all");
    expect(mocks.fetchAnnotationSummary).toHaveBeenCalledWith("ds1", {}, [
      ["p", "Area"],
    ]);
    expect(vm.summary).toEqual(SUMMARY);
    expect(vm.loading).toBe(false);
    // Opening sets scope and paths and fires the request watcher exactly once.
    expect(mocks.fetchAnnotationSummary).toHaveBeenCalledTimes(1);
  });

  it("prefers the selection, dropping ids that no longer resolve", async () => {
    (annotationStore as any).selectedAnnotationIds = new Set(["a1", "stale"]);
    const wrapper = await openDialog();
    expect((wrapper.vm as any).scope).toBe("selected");
    expect(mocks.fetchAnnotationSummary).toHaveBeenCalledWith(
      "ds1",
      { idConstraints: [["a1"]] },
      [["p", "Area"]],
    );
  });

  it("uses the server list filters for the filtered scope and refetches when they change", async () => {
    (filterStore as any).filteredAnnotations = [{}, {}];
    const wrapper = await openDialog();
    expect((wrapper.vm as any).scope).toBe("filtered");
    expect(mocks.fetchAnnotationSummary).toHaveBeenLastCalledWith(
      "ds1",
      annotationListServer.currentFilters,
      [["p", "Area"]],
    );
    (annotationListServer as any).currentFiltersSignature = "sig-2";
    await nextTick();
    expect(mocks.fetchAnnotationSummary).toHaveBeenCalledTimes(2);
  });

  it("refetches when the property picker changes", async () => {
    (filterStore as any).filteredAnnotations = new Array(10).fill({});
    const wrapper = await openDialog();
    (wrapper.vm as any).selectedPathStrings = [
      serializePropertyPath(["p", "Area"]),
      serializePropertyPath(["p", "Mean"]),
    ];
    await nextTick();
    expect(mocks.fetchAnnotationSummary).toHaveBeenLastCalledWith("ds1", {}, [
      ["p", "Area"],
      ["p", "Mean"],
    ]);
  });

  it("keeps the latest request's answer when an earlier one resolves late", async () => {
    (filterStore as any).filteredAnnotations = new Array(10).fill({});
    let resolveFirst: (value: any) => void = () => {};
    mocks.fetchAnnotationSummary.mockImplementationOnce(
      () => new Promise((resolve) => (resolveFirst = resolve)),
    );
    const wrapper = await openDialog();
    const vm = wrapper.vm as any;
    vm.selectedPathStrings = [serializePropertyPath(["p", "Mean"])];
    await nextTick();
    await nextTick();
    expect(vm.summary).toEqual(SUMMARY);
    resolveFirst({ ...SUMMARY, total: 999 });
    await nextTick();
    expect(vm.summary.total).toBe(4);
    expect(vm.loading).toBe(false);
  });

  it("retires an in-flight request when a bail-out clears the summary", async () => {
    (filterStore as any).filteredAnnotations = new Array(10).fill({});
    let resolveFirst: (value: any) => void = () => {};
    mocks.fetchAnnotationSummary.mockImplementationOnce(
      () => new Promise((resolve) => (resolveFirst = resolve)),
    );
    const wrapper = await openDialog();
    const vm = wrapper.vm as any;
    (store as any).dataset = null;
    await vm.refresh();
    expect(vm.summary).toBeNull();
    resolveFirst(SUMMARY);
    await nextTick();
    // The late answer belongs to a retired request and must not come back.
    expect(vm.summary).toBeNull();
    expect(vm.loading).toBe(false);
    (store as any).dataset = { id: "ds1", name: "Lymph" };
  });

  it("shows the server's message when the request fails", async () => {
    (filterStore as any).filteredAnnotations = new Array(10).fill({});
    mocks.fetchAnnotationSummary.mockRejectedValue({
      response: { data: { message: "propertyPaths exceeds 200" } },
    });
    const wrapper = await openDialog();
    const vm = wrapper.vm as any;
    expect(vm.error).toBe("propertyPaths exceeds 200");
    expect(vm.summary).toBeNull();
  });

  it("downloads a CSV with total, tag and property sections", async () => {
    (filterStore as any).filteredAnnotations = new Array(10).fill({});
    const wrapper = await openDialog();
    const vm = wrapper.vm as any;
    const csv = vm.buildCsv(SUMMARY);
    expect(csv.split("\n")).toEqual([
      "Section,Name,Count,Fraction,Mean,SD,Min,Max",
      "total,,4,1,,,,",
      "tag,A,3,0.75,,,,",
      "tag,B,1,0.25,,,,",
      "property,Blob / Area,2,0.5,10,7.0710678,5,15",
    ]);
    vm.download();
    expect(mocks.downloadToClient).toHaveBeenCalledWith({
      href: "data:text/csv;charset=utf-8," + encodeURIComponent(csv),
      download: "Lymph-all-summary.csv",
    });
  });

  it("aggregates expression over the same scope only when a table exists and genes are picked", async () => {
    (filterStore as any).filteredAnnotations = [{}, {}];
    mocks.aggregate.mockReset();
    mocks.aggregate.mockResolvedValue({
      total: 2,
      unmatched: 0,
      features: [
        { symbol: "CD3E", mean: 1.5, fractionExpressing: 0.5, expressing: 1 },
      ],
    });
    (spatialStore as any).hasTable = false;
    const wrapper = await openDialog();
    const vm = wrapper.vm as any;
    vm.expressionSymbols = ["CD3E"];
    await nextTick();
    await nextTick();
    expect(mocks.aggregate).not.toHaveBeenCalled();

    (spatialStore as any).hasTable = true;
    await nextTick();
    await nextTick();
    expect(mocks.aggregate).toHaveBeenCalledWith(
      "ds1",
      annotationListServer.currentFilters,
      ["CD3E"],
    );
    expect(vm.expression.features[0].symbol).toBe("CD3E");
    // The CSV carries the expression rows too.
    expect(vm.buildCsv(SUMMARY).split("\n").at(-1)).toBe(
      "expression,CD3E,1,0.5,1.5,,,",
    );
    (spatialStore as any).hasTable = false;
  });

  it("formats statistics compactly and marks missing ones", async () => {
    const wrapper = shallowMount(SelectionSummaryDialog);
    const vm = wrapper.vm as any;
    expect(vm.formatNumber(null)).toBe("–");
    expect(vm.formatNumber(15)).toBe("15");
    expect(vm.formatNumber(7.0710678)).toBe("7.071");
  });
});

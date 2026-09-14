import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { nextTick } from "vue";
import { shallowMount, enableAutoUnmount } from "@vue/test-utils";

enableAutoUnmount(afterEach);

const mocks = vi.hoisted(() => ({ searchFeatures: vi.fn() }));

vi.mock("@/store", async () => ({
  default: (await import("vue")).reactive({
    dataset: { id: "ds1" },
    spatialAPI: { searchFeatures: mocks.searchFeatures },
  }),
}));

vi.mock("@/utils/log", () => ({ logError: vi.fn() }));

import SpatialFeaturePicker from "./SpatialFeaturePicker.vue";
import store from "@/store";

describe("SpatialFeaturePicker", () => {
  beforeEach(() => {
    (store as any).dataset = { id: "ds1" };
    vi.useFakeTimers();
    mocks.searchFeatures.mockReset().mockResolvedValue([
      { symbol: "CD3E", featureType: "gene" },
      { symbol: "CD19", featureType: "gene" },
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("cancels queued searches and clears query and feature types on dataset change", async () => {
    const wrapper = shallowMount(SpatialFeaturePicker, {
      props: { modelValue: [] },
    });
    await nextTick();
    const vm = wrapper.vm as any;
    expect(vm.featureTypeOf("CD3E")).toBe("gene");
    vm.onSearch("old-query");
    mocks.searchFeatures.mockResolvedValue([
      { symbol: "NEW", featureType: "new-type" },
    ]);
    (store as any).dataset = { id: "ds2" };
    await nextTick();
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.searchFeatures).toHaveBeenLastCalledWith("ds2", "");
    expect(vm.search).toBe("");
    expect(vm.featureTypeOf("CD3E")).toBe("");
    expect(vm.items).toEqual(["NEW"]);
  });

  it("discards pending results when the dataset is cleared", async () => {
    let finish!: (features: any[]) => void;
    mocks.searchFeatures.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const wrapper = shallowMount(SpatialFeaturePicker, {
      props: { modelValue: [] },
    });
    (store as any).dataset = null;
    await nextTick();
    finish([{ symbol: "OLD", featureType: "old-type" }]);
    await nextTick();
    expect((wrapper.vm as any).results).toEqual([]);
    expect((wrapper.vm as any).searching).toBe(false);
  });

  it("lists picked symbols alongside search results and debounces typing", async () => {
    const wrapper = shallowMount(SpatialFeaturePicker, {
      props: { modelValue: ["MS4A1"] },
    });
    await nextTick();
    // Mount populates the list with an empty search.
    expect(mocks.searchFeatures).toHaveBeenCalledWith("ds1", "");
    await vi.advanceTimersByTimeAsync(0);
    const vm = wrapper.vm as any;
    expect(vm.items).toEqual(["MS4A1", "CD3E", "CD19"]);

    vm.onSearch("c");
    vm.onSearch("cd");
    await vi.advanceTimersByTimeAsync(250);
    // Two keystrokes, one request.
    expect(mocks.searchFeatures).toHaveBeenCalledTimes(2);
    expect(mocks.searchFeatures).toHaveBeenLastCalledWith("ds1", "cd");
  });

  it("caps the selection at max", async () => {
    const wrapper = shallowMount(SpatialFeaturePicker, {
      props: { modelValue: [], max: 2 },
    });
    (wrapper.vm as any).onUpdate(["A", "B", "C"]);
    expect(wrapper.emitted("update:modelValue")?.[0]).toEqual([["A", "B"]]);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { nextTick } from "vue";
import { shallowMount } from "@vue/test-utils";

const mocks = vi.hoisted(() => ({ searchFeatures: vi.fn() }));

vi.mock("@/store", () => ({
  default: {
    dataset: { id: "ds1" },
    spatialAPI: { searchFeatures: mocks.searchFeatures },
  },
}));

vi.mock("@/utils/log", () => ({ logError: vi.fn() }));

import SpatialFeaturePicker from "./SpatialFeaturePicker.vue";

describe("SpatialFeaturePicker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.searchFeatures.mockReset().mockResolvedValue([
      { symbol: "CD3E", featureType: "gene" },
      { symbol: "CD19", featureType: "gene" },
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
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

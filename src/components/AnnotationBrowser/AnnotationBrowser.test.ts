import { describe, it, expect, vi } from "vitest";
import { shallowMount } from "@vue/test-utils";

vi.mock("@/store/filters", () => ({
  default: {
    addTagToTagFilter: vi.fn(),
  },
}));

vi.mock("@/store", () => ({
  default: {},
}));

vi.mock("@/store/annotation", () => ({
  default: {},
}));

vi.mock("@/store/properties", () => ({
  default: {},
}));

import AnnotationBrowser from "./AnnotationBrowser.vue";
import filterStore from "@/store/filters";

function mountComponent() {
  return shallowMount(AnnotationBrowser, {});
}

describe("AnnotationBrowser", () => {
  it("default expanded is [1] (properties)", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.expanded).toEqual([1]);
  });

  it("clickedTag calls filterStore.addTagToTagFilter", () => {
    const wrapper = mountComponent();
    wrapper.vm.clickedTag("myTag");
    expect(filterStore.addTagToTagFilter).toHaveBeenCalledWith("myTag");
  });

  it("expandProperties adds panel index 0 (actions) if not present", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.expanded).toEqual([1]);
    wrapper.vm.expandProperties();
    expect(wrapper.vm.expanded).toContain(0);
  });

  it("expandProperties does not duplicate panel index 0", () => {
    const wrapper = mountComponent();
    wrapper.vm.expandProperties();
    wrapper.vm.expandProperties();
    expect(wrapper.vm.expanded.filter((i: number) => i === 0)).toHaveLength(1);
  });
});

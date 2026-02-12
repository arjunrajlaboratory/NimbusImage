import { describe, it, expect, vi } from "vitest";
import { shallowMount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

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

Vue.use(Vuetify);

function mountComponent() {
  return shallowMount(AnnotationBrowser, {
    vuetify: new Vuetify(),
  });
}

describe("AnnotationBrowser", () => {
  it("default expanded is [2]", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.expanded).toEqual([2]);
  });

  it("clickedTag calls filterStore.addTagToTagFilter", () => {
    const wrapper = mountComponent();
    wrapper.vm.clickedTag("myTag");
    expect(filterStore.addTagToTagFilter).toHaveBeenCalledWith("myTag");
  });

  it("expandProperties adds panel index 1 if not present", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.expanded).toEqual([2]);
    wrapper.vm.expandProperties();
    expect(wrapper.vm.expanded).toContain(1);
  });

  it("expandProperties does not duplicate panel index 1", () => {
    const wrapper = mountComponent();
    wrapper.vm.expandProperties();
    wrapper.vm.expandProperties();
    expect(wrapper.vm.expanded.filter((i: number) => i === 1)).toHaveLength(1);
  });
});

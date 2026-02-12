import { describe, it, expect, vi } from "vitest";
import { shallowMount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

vi.mock("@/store/filters", () => ({
  default: {
    tagFilter: {
      id: "tagFilter",
      exclusive: false,
      enabled: false,
      tags: [],
    },
    onlyCurrentFrame: false,
    filterPaths: [["prop", "area"]],
    propertyFilters: [],
    setTagFilter: vi.fn(),
    setOnlyCurrentFrame: vi.fn(),
  },
}));

vi.mock("@/store", () => ({
  default: {
    showAnnotationsFromHiddenLayers: false,
    setShowAnnotationsFromHiddenLayers: vi.fn(),
  },
}));

vi.mock("@/store/annotation", () => ({
  default: {},
}));

vi.mock("@/store/properties", () => ({
  default: {},
}));

import AnnotationFilters from "./AnnotationFilters.vue";
import filterStore from "@/store/filters";
import store from "@/store";

Vue.use(Vuetify);

function mountComponent(props = {}) {
  return shallowMount(AnnotationFilters, {
    vuetify: new Vuetify(),
    propsData: {
      ...props,
    },
  });
}

describe("AnnotationFilters", () => {
  it("tagFilter getter reads from filterStore", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.tagFilter).toBe(filterStore.tagFilter);
  });

  it("tagFilter setter calls filterStore.setTagFilter", () => {
    const wrapper = mountComponent();
    const newFilter = {
      id: "tagFilter",
      exclusive: true,
      enabled: true,
      tags: ["t"],
    };
    wrapper.vm.tagFilter = newFilter;
    expect(filterStore.setTagFilter).toHaveBeenCalledWith(newFilter);
  });

  it("onlyCurrentFrame getter reads from filterStore", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.onlyCurrentFrame).toBe(false);
  });

  it("onlyCurrentFrame setter calls filterStore.setOnlyCurrentFrame", () => {
    const wrapper = mountComponent();
    wrapper.vm.onlyCurrentFrame = true;
    expect(filterStore.setOnlyCurrentFrame).toHaveBeenCalledWith(true);
  });

  it("showAnnotationsFromHiddenLayers getter reads from main store", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.showAnnotationsFromHiddenLayers).toBe(false);
  });

  it("showAnnotationsFromHiddenLayers setter calls store method", () => {
    const wrapper = mountComponent();
    wrapper.vm.showAnnotationsFromHiddenLayers = true;
    expect(store.setShowAnnotationsFromHiddenLayers).toHaveBeenCalledWith(true);
  });

  it("propertyPaths reads from filterStore.filterPaths", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.propertyPaths).toEqual([["prop", "area"]]);
  });
});

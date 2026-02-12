import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

vi.mock("@/store/filters", () => ({
  default: {
    filterPaths: [["prop", "area"]],
    togglePropertyPathFiltering: vi.fn(),
  },
}));

vi.mock("@/store/properties", () => ({
  default: {
    computedPropertyPaths: [
      ["prop", "area"],
      ["prop", "perimeter"],
      ["other", "mean"],
    ],
    getFullNameFromPath: vi.fn((path: string[]) => path.join(" > ")),
  },
}));

import PropertyFilterSelector from "./PropertyFilterSelector.vue";
import filterStore from "@/store/filters";
import propertyStore from "@/store/properties";

Vue.use(Vuetify);

function mountComponent() {
  return mount(PropertyFilterSelector, {
    vuetify: new Vuetify(),
  });
}

describe("PropertyFilterSelector", () => {
  it("allPropertyPaths reads from propertyStore.computedPropertyPaths", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.allPropertyPaths).toHaveLength(3);
  });

  it("filteredPropertyPaths returns all when no search query", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.filteredPropertyPaths).toHaveLength(3);
  });

  it("filteredPropertyPaths filters by search query", () => {
    const wrapper = mountComponent();
    wrapper.vm.searchQuery = "area";
    expect(wrapper.vm.filteredPropertyPaths).toHaveLength(1);
    expect(wrapper.vm.filteredPropertyPaths[0]).toEqual(["prop", "area"]);
  });

  it("isPropertyPathFiltered checks filterStore.filterPaths", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.isPropertyPathFiltered(["prop", "area"])).toBe(true);
    expect(wrapper.vm.isPropertyPathFiltered(["other", "mean"])).toBe(false);
  });

  it("togglePropertyPathFiltering delegates to filterStore", () => {
    const wrapper = mountComponent();
    wrapper.vm.togglePropertyPathFiltering(["prop", "area"]);
    expect(filterStore.togglePropertyPathFiltering).toHaveBeenCalledWith([
      "prop",
      "area",
    ]);
  });

  it("getPropertyFullName delegates to propertyStore", () => {
    const wrapper = mountComponent();
    wrapper.vm.getPropertyFullName(["prop", "area"]);
    expect(propertyStore.getFullNameFromPath).toHaveBeenCalledWith([
      "prop",
      "area",
    ]);
  });
});

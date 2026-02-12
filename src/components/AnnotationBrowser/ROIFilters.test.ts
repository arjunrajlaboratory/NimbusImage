import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

vi.mock("@/store/filters", () => ({
  default: {
    roiFilters: [
      { id: "Region Filter 0", enabled: true, exclusive: true, roi: [] },
    ],
    newROIFilter: vi.fn(),
    removeROIFilter: vi.fn(),
    toggleRoiFilterEnabled: vi.fn(),
  },
}));

import ROIFilters from "./ROIFilters.vue";
import filterStore from "@/store/filters";

Vue.use(Vuetify);

function mountComponent() {
  return mount(ROIFilters, {
    vuetify: new Vuetify(),
  });
}

describe("ROIFilters", () => {
  it("filters returns filterStore.roiFilters", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.filters).toHaveLength(1);
    expect(wrapper.vm.filters[0].id).toBe("Region Filter 0");
  });

  it("addNewFilter calls filterStore.newROIFilter", () => {
    const wrapper = mountComponent();
    wrapper.vm.addNewFilter();
    expect(filterStore.newROIFilter).toHaveBeenCalled();
  });

  it("removeFilter calls filterStore.removeROIFilter with id", () => {
    const wrapper = mountComponent();
    wrapper.vm.removeFilter("Region Filter 0");
    expect(filterStore.removeROIFilter).toHaveBeenCalledWith("Region Filter 0");
  });

  it("toggleEnabled calls filterStore.toggleRoiFilterEnabled with id", () => {
    const wrapper = mountComponent();
    wrapper.vm.toggleEnabled("Region Filter 0");
    expect(filterStore.toggleRoiFilterEnabled).toHaveBeenCalledWith(
      "Region Filter 0",
    );
  });
});

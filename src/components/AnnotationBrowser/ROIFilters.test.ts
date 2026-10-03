import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";

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

vi.mock("@/store/annotation", () => ({
  default: {
    isListServerMode: false,
  },
}));

import ROIFilters from "./ROIFilters.vue";
import filterStore from "@/store/filters";
import annotationStore from "@/store/annotation";

function mountComponent() {
  return mount(ROIFilters, {});
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

  it("hides the server-list warning when the list is client-side", () => {
    (annotationStore as any).isListServerMode = false;
    const wrapper = mountComponent();
    expect(wrapper.text()).not.toContain("region filters will not be applied");
  });

  it("shows the server-list warning when the list is server-paginated", () => {
    (annotationStore as any).isListServerMode = true;
    const wrapper = mountComponent();
    expect(wrapper.text()).toContain("region filters will not be applied");
    (annotationStore as any).isListServerMode = false;
  });

  it("toggleEnabled calls filterStore.toggleRoiFilterEnabled with id", () => {
    const wrapper = mountComponent();
    wrapper.vm.toggleEnabled("Region Filter 0");
    expect(filterStore.toggleRoiFilterEnabled).toHaveBeenCalledWith(
      "Region Filter 0",
    );
  });
});

import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

vi.mock("@/store/filters", () => ({
  default: {
    annotationIdFilters: [
      {
        id: "Annotation List Filter 0",
        enabled: true,
        exclusive: true,
        annotationIds: ["a1", "a2"],
      },
    ],
    newAnnotationIdFilter: vi.fn(),
    updateAnnotationIdFilter: vi.fn(),
    removeAnnotationIdFilter: vi.fn(),
    toggleAnnotationIdFilterEnabled: vi.fn(),
  },
}));

import AnnotationIdFilters from "./AnnotationIdFilters.vue";
import filterStore from "@/store/filters";

Vue.use(Vuetify);

function mountComponent() {
  return mount(AnnotationIdFilters, {
    vuetify: new Vuetify(),
  });
}

describe("AnnotationIdFilters", () => {
  it("filters returns filterStore.annotationIdFilters", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.filters).toHaveLength(1);
    expect(wrapper.vm.filters[0].id).toBe("Annotation List Filter 0");
  });

  it("openNewFilterDialog resets state and opens dialog", () => {
    const wrapper = mountComponent();
    wrapper.vm.openNewFilterDialog();
    expect(wrapper.vm.dialog).toBe(true);
    expect(wrapper.vm.editingFilter).toBeNull();
    expect(wrapper.vm.annotationIdsInput).toBe("");
  });

  it("editFilter populates state from existing filter", () => {
    const wrapper = mountComponent();
    const filter = {
      id: "Annotation List Filter 0",
      enabled: true,
      exclusive: true,
      annotationIds: ["a1", "a2"],
    };
    wrapper.vm.editFilter(filter);
    expect(wrapper.vm.dialog).toBe(true);
    expect(wrapper.vm.editingFilter).toBe(filter);
    expect(wrapper.vm.annotationIdsInput).toBe("a1\na2");
  });

  it("saveFilter parses IDs from comma/space/semicolon-separated input", () => {
    const wrapper = mountComponent();
    wrapper.vm.openNewFilterDialog();
    wrapper.vm.annotationIdsInput = "id1, id2; id3\nid4";
    wrapper.vm.saveFilter();
    expect(filterStore.newAnnotationIdFilter).toHaveBeenCalledWith([
      "id1",
      "id2",
      "id3",
      "id4",
    ]);
    expect(wrapper.vm.dialog).toBe(false);
  });

  it("saveFilter updates existing filter when editing", () => {
    const wrapper = mountComponent();
    const filter = {
      id: "Annotation List Filter 0",
      enabled: true,
      exclusive: true,
      annotationIds: ["a1"],
    };
    wrapper.vm.editFilter(filter);
    wrapper.vm.annotationIdsInput = "b1 b2";
    wrapper.vm.saveFilter();
    expect(filterStore.updateAnnotationIdFilter).toHaveBeenCalledWith({
      id: "Annotation List Filter 0",
      annotationIds: ["b1", "b2"],
    });
  });

  it("removeFilter delegates to filterStore", () => {
    const wrapper = mountComponent();
    wrapper.vm.removeFilter("Annotation List Filter 0");
    expect(filterStore.removeAnnotationIdFilter).toHaveBeenCalledWith(
      "Annotation List Filter 0",
    );
  });

  it("toggleEnabled delegates to filterStore", () => {
    const wrapper = mountComponent();
    wrapper.vm.toggleEnabled("Annotation List Filter 0");
    expect(filterStore.toggleAnnotationIdFilterEnabled).toHaveBeenCalledWith(
      "Annotation List Filter 0",
    );
  });
});

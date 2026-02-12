import { describe, it, expect, vi } from "vitest";
import { shallowMount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

vi.mock("@/store", () => ({
  default: {
    annotationSelectionType: "ADD",
    setAnnotationSelectionType: vi.fn(),
    drawAnnotations: true,
    setDrawAnnotations: vi.fn(),
    showTooltips: false,
    setShowTooltips: vi.fn(),
    filteredAnnotationTooltips: false,
    setFilteredAnnotationTooltips: vi.fn(),
    filteredDraw: false,
    setFilteredDraw: vi.fn(),
    drawAnnotationConnections: true,
    setDrawAnnotationConnections: vi.fn(),
  },
}));

import AnnotationToggles from "./AnnotationToggles.vue";
import store from "@/store";

Vue.use(Vuetify);

function mountComponent() {
  return shallowMount(AnnotationToggles, {
    vuetify: new Vuetify(),
  });
}

describe("AnnotationToggles", () => {
  it("annotationSelectionType getter reads from store", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.annotationSelectionType).toBe("ADD");
  });

  it("annotationSelectionType setter calls store", () => {
    const wrapper = mountComponent();
    wrapper.vm.annotationSelectionType = "TOGGLE";
    expect(store.setAnnotationSelectionType).toHaveBeenCalledWith("TOGGLE");
  });

  it("drawAnnotations getter reads from store", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.drawAnnotations).toBe(true);
  });

  it("drawAnnotations setter calls store", () => {
    const wrapper = mountComponent();
    wrapper.vm.drawAnnotations = false;
    expect(store.setDrawAnnotations).toHaveBeenCalledWith(false);
  });

  it("showTooltips getter reads from store", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.showTooltips).toBe(false);
  });

  it("showTooltips setter calls store", () => {
    const wrapper = mountComponent();
    wrapper.vm.showTooltips = true;
    expect(store.setShowTooltips).toHaveBeenCalledWith(true);
  });

  it("filteredAnnotationTooltips getter reads from store", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.filteredAnnotationTooltips).toBe(false);
  });

  it("filteredAnnotationTooltips setter calls store", () => {
    const wrapper = mountComponent();
    wrapper.vm.filteredAnnotationTooltips = true;
    expect(store.setFilteredAnnotationTooltips).toHaveBeenCalledWith(true);
  });

  it("filteredDraw getter reads from store", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.filteredDraw).toBe(false);
  });

  it("filteredDraw setter calls store", () => {
    const wrapper = mountComponent();
    wrapper.vm.filteredDraw = true;
    expect(store.setFilteredDraw).toHaveBeenCalledWith(true);
  });

  it("drawConnections getter reads from store", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.drawConnections).toBe(true);
  });

  it("drawConnections setter calls store", () => {
    const wrapper = mountComponent();
    wrapper.vm.drawConnections = false;
    expect(store.setDrawAnnotationConnections).toHaveBeenCalledWith(false);
  });

  it("annotationsSelectionTypeItems has 3 items", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.annotationsSelectionTypeItems).toHaveLength(3);
  });
});

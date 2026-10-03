import { describe, it, expect, vi } from "vitest";
import { shallowMount } from "@vue/test-utils";

vi.mock("@/store/filters", () => ({
  default: {
    addTagToTagFilter: vi.fn(),
  },
}));

const annotationMock = vi.hoisted(() => ({
  annotationCount: 0,
  annotationConnections: [] as unknown[],
}));

vi.mock("@/store/annotation", () => ({ default: annotationMock }));

import AnnotationBrowser from "./AnnotationBrowser.vue";
import filterStore from "@/store/filters";

function mountComponent() {
  return shallowMount(AnnotationBrowser, {});
}

describe("AnnotationBrowser", () => {
  // Both badges are dataset-wide totals. annotationCount must come from the
  // store getter, never annotationsForIteration.length, which materializes an
  // array from the 700K-entry stub map just to read a length.
  it("badges both tabs with dataset-wide totals", () => {
    annotationMock.annotationCount = 52282;
    annotationMock.annotationConnections = new Array(54);
    const wrapper = mountComponent();
    expect(wrapper.vm.objectCount).toBe(52282);
    expect(wrapper.vm.connectionCount).toBe(54);
  });

  it("hides a badge when the dataset has none", () => {
    annotationMock.annotationCount = 0;
    annotationMock.annotationConnections = [];
    const wrapper = mountComponent();
    expect(wrapper.vm.objectCount).toBe(0);
    expect(wrapper.vm.connectionCount).toBe(0);
  });

  it("clickedTag calls filterStore.addTagToTagFilter", () => {
    const wrapper = mountComponent();
    wrapper.vm.clickedTag("myTag");
    expect(filterStore.addTagToTagFilter).toHaveBeenCalledWith("myTag");
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

vi.mock("@/store", () => ({
  default: {
    selectedAnnotationIds: [],
    toolTags: [],
  },
}));

vi.mock("@/store/annotation", () => ({
  default: {
    annotations: [],
    annotationTags: [],
    colorAnnotationIds: vi.fn(),
    replaceTagsByAnnotationIds: vi.fn(),
    deleteAnnotations: vi.fn(),
  },
}));

vi.mock("@/utils/annotation", () => ({
  tagFilterFunction: vi.fn().mockReturnValue(false),
}));

vi.mock("@/utils/log", () => ({
  logError: vi.fn(),
}));

import AnnotationContextMenu from "./AnnotationContextMenu.vue";
import annotationStore from "@/store/annotation";

Vue.use(Vuetify);

const baseAnnotation = {
  id: "ann-1",
  name: "Test Annotation",
  color: "#FF0000",
  tags: ["tag1", "tag2"],
  shape: "point",
  location: { XY: 0, Z: 0, Time: 0 },
  coordinates: [{ x: 0, y: 0, z: 0 }],
  channel: 0,
};

function mountComponent(props = {}) {
  const div = document.createElement("div");
  div.setAttribute("data-app", "true");
  document.body.appendChild(div);

  return shallowMount(AnnotationContextMenu, {
    vuetify: new Vuetify(),
    attachTo: div,
    propsData: {
      show: false,
      x: 100,
      y: 200,
      annotation: null,
      ...props,
    },
  });
}

describe("AnnotationContextMenu", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    (annotationStore as any).annotations = [];
    (annotationStore.colorAnnotationIds as any) = vi.fn();
    (annotationStore.replaceTagsByAnnotationIds as any) = vi.fn();
    (annotationStore.deleteAnnotations as any) = vi.fn();
  });

  it("showMenu get returns prop value", () => {
    const wrapper = mountComponent({ show: true });
    expect((wrapper.vm as any).showMenu).toBe(true);
    wrapper.destroy();
  });

  it("showMenu get returns false when prop is false", () => {
    const wrapper = mountComponent({ show: false });
    expect((wrapper.vm as any).showMenu).toBe(false);
    wrapper.destroy();
  });

  it("showMenu set to false emits cancel", async () => {
    const wrapper = mountComponent({ show: true });
    (wrapper.vm as any).showMenu = false;
    await Vue.nextTick();
    expect(wrapper.emitted("cancel")).toBeTruthy();
    wrapper.destroy();
  });

  it("watch on annotation sets colorOption and selectedTags", async () => {
    const wrapper = mountComponent({ annotation: baseAnnotation });
    const vm = wrapper.vm as any;
    expect(vm.colorOption).toBe("defined");
    expect(vm.selectedColor).toBe("#FF0000");
    expect(vm.selectedTags).toEqual(["tag1", "tag2"]);
    wrapper.destroy();
  });

  it("watch on annotation with null color sets colorOption to layer", async () => {
    const annotation = { ...baseAnnotation, color: null };
    const wrapper = mountComponent({ annotation });
    const vm = wrapper.vm as any;
    expect(vm.colorOption).toBe("layer");
    expect(vm.selectedColor).toBe("#FFFFFF");
    wrapper.destroy();
  });

  it("save with single annotation calls colorAnnotationIds and replaceTagsByAnnotationIds", async () => {
    const wrapper = mountComponent({ annotation: baseAnnotation });
    const vm = wrapper.vm as any;
    // Change tags so tagsChanged is true
    vm.selectedTags = ["newTag"];
    // Change color option so color is different
    vm.colorOption = "layer";
    vm.save();
    expect(annotationStore.colorAnnotationIds).toHaveBeenCalledWith({
      annotationIds: ["ann-1"],
      color: null,
      randomize: false,
    });
    expect(annotationStore.replaceTagsByAnnotationIds).toHaveBeenCalledWith({
      annotationIds: ["ann-1"],
      tags: ["newTag"],
    });
    wrapper.destroy();
  });

  it("deleteAnnotation calls deleteAnnotations and emits cancel", async () => {
    const wrapper = mountComponent({ annotation: baseAnnotation });
    const vm = wrapper.vm as any;
    vm.deleteAnnotation();
    expect(annotationStore.deleteAnnotations).toHaveBeenCalledWith(["ann-1"]);
    expect(wrapper.emitted("cancel")).toBeTruthy();
    wrapper.destroy();
  });
});

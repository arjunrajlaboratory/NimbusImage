import { describe, it, expect, vi } from "vitest";
import { shallowMount } from "@vue/test-utils";

vi.mock("@/store", () => ({
  default: {
    dataset: { z: [0, 1, 2] },
  },
}));

vi.mock("@/store/annotation", () => ({
  default: {},
}));

vi.mock("@/store/properties", () => ({
  default: {},
}));

vi.mock("vuedraggable", () => ({
  default: {
    name: "draggable",
    template: "<div><slot /></div>",
    props: ["modelValue", "animation", "fallbackOnBody", "swapThreshold"],
  },
}));

vi.mock("./DisplayLayer.vue", () => ({
  default: {
    name: "DisplayLayer",
    template: "<div class='display-layer-stub' />",
    props: ["modelValue"],
  },
}));

import DisplayLayerGroup from "./DisplayLayerGroup.vue";

const sampleCombinedLayers = [
  {
    layer: {
      id: "l1",
      name: "DAPI",
      color: "#0000FF",
      channel: 0,
      visible: true,
      contrast: { mode: "percentile", blackPoint: 0, whitePoint: 100 },
      xy: { type: "current", value: 0 },
      z: { type: "current", value: 0 },
      time: { type: "current", value: 0 },
      layerGroup: null,
    },
    configurationLayer: {
      id: "l1",
      name: "DAPI",
      color: "#0000FF",
      channel: 0,
      visible: true,
      contrast: { mode: "percentile", blackPoint: 0, whitePoint: 100 },
      xy: { type: "current", value: 0 },
      z: { type: "current", value: 0 },
      time: { type: "current", value: 0 },
      layerGroup: null,
    },
  },
];

function mountComponent(props: Record<string, any> = {}) {
  return shallowMount(DisplayLayerGroup as any, {
    props: {
      singleLayer: true,
      combinedLayers: sampleCombinedLayers,
      ...props,
    },
    global: {
      stubs: {
        "transition-group": { template: "<div><slot /></div>" },
      },
    },
  });
}

describe("DisplayLayerGroup", () => {
  // Mount with singleLayer=true to avoid the group header with v-model
  // computed get/set that depends on $refs which don't work in test env
  it("hasMultipleZ returns true when dataset has multiple z values", () => {
    const wrapper = mountComponent();
    expect((wrapper.vm as any).hasMultipleZ).toBe(true);
  });

  it("emits update event", () => {
    const wrapper = mountComponent();
    (wrapper.vm as any).update(sampleCombinedLayers);
    expect(wrapper.emitted("update")).toBeTruthy();
    expect(wrapper.emitted("update")![0][0]).toEqual(sampleCombinedLayers);
  });

  it("emits start event", () => {
    const wrapper = mountComponent();
    const mockEvent = { oldIndex: 0 } as any;
    (wrapper.vm as any).startDragging(mockEvent);
    expect(wrapper.emitted("start")).toBeTruthy();
  });

  it("emits end event", () => {
    const wrapper = mountComponent();
    const mockEvent = { newIndex: 1 } as any;
    (wrapper.vm as any).endDragging(mockEvent);
    expect(wrapper.emitted("end")).toBeTruthy();
  });

  it("does not render background class when singleLayer is true", () => {
    const wrapper = mountComponent();
    expect(wrapper.classes()).not.toContain("background");
  });
});

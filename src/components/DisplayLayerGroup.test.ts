import { describe, it, expect, vi } from "vitest";

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
    props: ["value", "animation", "fallbackOnBody", "swapThreshold"],
  },
}));

vi.mock("./DisplayLayer.vue", () => ({
  default: {
    name: "DisplayLayer",
    template: "<div class='display-layer-stub' />",
    props: ["value"],
  },
}));

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

async function setup() {
  const Vue = (await import("vue")).default;
  const Vuetify = (await import("vuetify")).default;
  Vue.use(Vuetify);
  const { shallowMount } = await import("@vue/test-utils");
  const mod = await import("./DisplayLayerGroup.vue");
  return { shallowMount, Vuetify, Component: mod.default };
}

describe("DisplayLayerGroup", () => {
  // Mount with singleLayer=true to avoid the group header with v-model
  // computed get/set that depends on $refs which don't work in test env
  it("hasMultipleZ returns true when dataset has multiple z values", async () => {
    const { shallowMount, Vuetify, Component } = await setup();
    const wrapper = shallowMount(Component, {
      vuetify: new Vuetify(),
      propsData: {
        singleLayer: true,
        combinedLayers: sampleCombinedLayers,
      },
      stubs: {
        "transition-group": { template: "<div><slot /></div>" },
      },
    });
    expect(wrapper.vm.hasMultipleZ).toBe(true);
  });

  it("emits update event", async () => {
    const { shallowMount, Vuetify, Component } = await setup();
    const wrapper = shallowMount(Component, {
      vuetify: new Vuetify(),
      propsData: {
        singleLayer: true,
        combinedLayers: sampleCombinedLayers,
      },
      stubs: {
        "transition-group": { template: "<div><slot /></div>" },
      },
    });
    wrapper.vm.update(sampleCombinedLayers);
    expect(wrapper.emitted("update")).toBeTruthy();
    expect(wrapper.emitted("update")![0][0]).toEqual(sampleCombinedLayers);
  });

  it("emits start event", async () => {
    const { shallowMount, Vuetify, Component } = await setup();
    const wrapper = shallowMount(Component, {
      vuetify: new Vuetify(),
      propsData: {
        singleLayer: true,
        combinedLayers: sampleCombinedLayers,
      },
      stubs: {
        "transition-group": { template: "<div><slot /></div>" },
      },
    });
    const mockEvent = { oldIndex: 0 } as any;
    wrapper.vm.startDragging(mockEvent);
    expect(wrapper.emitted("start")).toBeTruthy();
  });

  it("emits end event", async () => {
    const { shallowMount, Vuetify, Component } = await setup();
    const wrapper = shallowMount(Component, {
      vuetify: new Vuetify(),
      propsData: {
        singleLayer: true,
        combinedLayers: sampleCombinedLayers,
      },
      stubs: {
        "transition-group": { template: "<div><slot /></div>" },
      },
    });
    const mockEvent = { newIndex: 1 } as any;
    wrapper.vm.endDragging(mockEvent);
    expect(wrapper.emitted("end")).toBeTruthy();
  });

  it("does not render background class when singleLayer is true", async () => {
    const { shallowMount, Vuetify, Component } = await setup();
    const wrapper = shallowMount(Component, {
      vuetify: new Vuetify(),
      propsData: {
        singleLayer: true,
        combinedLayers: sampleCombinedLayers,
      },
      stubs: {
        "transition-group": { template: "<div><slot /></div>" },
      },
    });
    expect(wrapper.classes()).not.toContain("background");
  });
});

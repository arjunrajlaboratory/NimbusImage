import { describe, it, expect, vi } from "vitest";

vi.mock("@/store", () => ({
  default: {
    dataset: {
      z: [0, 1, 2],
      xy: [0],
      time: [0],
      channels: [0, 1],
      channelNames: new Map([
        [0, "DAPI"],
        [1, "GFP"],
      ]),
    },
    configuration: { layers: [] },
    getLayerIndexFromId: vi.fn(() => 0),
    hoverValue: null,
    getLayerHistogram: vi.fn(() => null),
    getConfigurationLayerFromId: vi.fn(() => null),
    xy: 0,
    z: 0,
    time: 0,
    changeLayer: vi.fn(),
    toggleLayerVisibility: vi.fn(),
    saveContrastInConfiguration: vi.fn(),
    saveContrastInView: vi.fn(),
    resetContrastInView: vi.fn(),
    removeLayer: vi.fn(),
  },
}));

vi.mock("@/store/annotation", () => ({
  default: {},
}));

vi.mock("@/store/properties", () => ({
  default: {},
}));

vi.mock("./DisplaySlice.vue", () => ({
  default: {
    name: "DisplaySlice",
    template: "<div />",
    props: ["value", "label", "maxValue", "displayed", "offset"],
  },
}));

vi.mock("./ContrastHistogram.vue", () => ({
  default: {
    name: "ContrastHistogram",
    template: "<div />",
    props: ["configurationContrast", "viewContrast", "histogram"],
  },
}));

vi.mock("./ColorPickerMenu.vue", () => ({
  default: {
    name: "ColorPickerMenu",
    template: "<div />",
    props: ["value"],
  },
}));

const sampleLayer = {
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
};

async function setup(propsOverrides = {}) {
  const Vue = (await import("vue")).default;
  const Vuetify = (await import("vuetify")).default;
  Vue.use(Vuetify);
  Vue.directive("mousetrap", {});
  const { shallowMount } = await import("@vue/test-utils");
  const mod = await import("./DisplayLayer.vue");
  return { shallowMount, Vuetify, Component: mod.default, propsOverrides };
}

function mountComponent(
  shallowMount: any,
  Vuetify: any,
  Component: any,
  propsOverrides = {},
) {
  return shallowMount(Component, {
    vuetify: new Vuetify(),
    propsData: {
      value: { ...sampleLayer, ...propsOverrides },
    },
  });
}

describe("DisplayLayer", () => {
  it("index returns store layer index", async () => {
    const { shallowMount, Vuetify, Component } = await setup();
    const wrapper = mountComponent(shallowMount, Vuetify, Component);
    expect(wrapper.vm.index).toBe(0);
  });

  it("visible getter returns layer visibility", async () => {
    const { shallowMount, Vuetify, Component } = await setup();
    const wrapper = mountComponent(shallowMount, Vuetify, Component);
    expect(wrapper.vm.visible).toBe(true);
  });

  it("changeProp calls store.changeLayer", async () => {
    const store = (await import("@/store")).default;
    const { shallowMount, Vuetify, Component } = await setup();
    const wrapper = mountComponent(shallowMount, Vuetify, Component);
    wrapper.vm.changeProp("name", "NewName");
    expect(store.changeLayer).toHaveBeenCalledWith({
      layerId: "l1",
      delta: { name: "NewName" },
    });
  });

  it("changeProp does not call store when value is the same", async () => {
    const store = (await import("@/store")).default;
    (store.changeLayer as any).mockClear();
    const { shallowMount, Vuetify, Component } = await setup();
    const wrapper = mountComponent(shallowMount, Vuetify, Component);
    wrapper.vm.changeProp("name", "DAPI");
    expect(store.changeLayer).not.toHaveBeenCalled();
  });

  it("removeLayer calls store.removeLayer", async () => {
    const store = (await import("@/store")).default;
    const { shallowMount, Vuetify, Component } = await setup();
    const wrapper = mountComponent(shallowMount, Vuetify, Component);
    wrapper.vm.removeLayer();
    expect(store.removeLayer).toHaveBeenCalledWith("l1");
  });

  it("channelName returns name from dataset", async () => {
    const { shallowMount, Vuetify, Component } = await setup();
    const wrapper = mountComponent(shallowMount, Vuetify, Component);
    expect(wrapper.vm.channelName(0)).toBe("DAPI");
    expect(wrapper.vm.channelName(1)).toBe("GFP");
  });

  it("channelName falls back to channel number string", async () => {
    const { shallowMount, Vuetify, Component } = await setup();
    const wrapper = mountComponent(shallowMount, Vuetify, Component);
    expect(wrapper.vm.channelName(99)).toBe("99");
  });

  it("channels returns dataset channels", async () => {
    const { shallowMount, Vuetify, Component } = await setup();
    const wrapper = mountComponent(shallowMount, Vuetify, Component);
    expect(wrapper.vm.channels).toEqual([0, 1]);
  });

  it("currentContrast returns layer contrast", async () => {
    const { shallowMount, Vuetify, Component } = await setup();
    const wrapper = mountComponent(shallowMount, Vuetify, Component);
    expect(wrapper.vm.currentContrast).toEqual({
      mode: "percentile",
      blackPoint: 0,
      whitePoint: 100,
    });
  });

  it("hasMultipleZ returns true when dataset has multiple z values", async () => {
    const { shallowMount, Vuetify, Component } = await setup();
    const wrapper = mountComponent(shallowMount, Vuetify, Component);
    expect(wrapper.vm.hasMultipleZ).toBe(true);
  });

  it("maxZ returns dataset z length minus 1", async () => {
    const { shallowMount, Vuetify, Component } = await setup();
    const wrapper = mountComponent(shallowMount, Vuetify, Component);
    expect(wrapper.vm.maxZ).toBe(2);
  });

  it("isZMaxMerge returns false for current slice type", async () => {
    const { shallowMount, Vuetify, Component } = await setup();
    const wrapper = mountComponent(shallowMount, Vuetify, Component);
    expect(wrapper.vm.isZMaxMerge).toBe(false);
  });

  it("isZMaxMerge returns true for max-merge slice type", async () => {
    const { shallowMount, Vuetify, Component } = await setup();
    const wrapper = mountComponent(shallowMount, Vuetify, Component, {
      z: { type: "max-merge", value: null },
    });
    expect(wrapper.vm.isZMaxMerge).toBe(true);
  });

  it("changeContrast with syncConfiguration calls saveContrastInConfiguration", async () => {
    const store = (await import("@/store")).default;
    const { shallowMount, Vuetify, Component } = await setup();
    const wrapper = mountComponent(shallowMount, Vuetify, Component);
    const contrast = { mode: "absolute", blackPoint: 10, whitePoint: 200 };
    wrapper.vm.changeContrast(contrast, true);
    expect(store.saveContrastInConfiguration).toHaveBeenCalledWith({
      layerId: "l1",
      contrast,
    });
  });

  it("changeContrast without syncConfiguration calls saveContrastInView", async () => {
    const store = (await import("@/store")).default;
    const { shallowMount, Vuetify, Component } = await setup();
    const wrapper = mountComponent(shallowMount, Vuetify, Component);
    const contrast = { mode: "absolute", blackPoint: 10, whitePoint: 200 };
    wrapper.vm.changeContrast(contrast, false);
    expect(store.saveContrastInView).toHaveBeenCalledWith({
      layerId: "l1",
      contrast,
    });
  });

  it("resetContrastInView calls store.resetContrastInView", async () => {
    const store = (await import("@/store")).default;
    const { shallowMount, Vuetify, Component } = await setup();
    const wrapper = mountComponent(shallowMount, Vuetify, Component);
    wrapper.vm.resetContrastInView();
    expect(store.resetContrastInView).toHaveBeenCalledWith("l1");
  });

  it("zMaxMergeBinding includes the index", async () => {
    const { shallowMount, Vuetify, Component } = await setup();
    const wrapper = mountComponent(shallowMount, Vuetify, Component);
    expect(wrapper.vm.zMaxMergeBinding).toBe("shift+1");
  });
});

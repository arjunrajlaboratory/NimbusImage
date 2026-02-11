import { describe, it, expect, vi } from "vitest";
import { shallowMount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

vi.mock("@/store", () => ({
  default: {
    configuration: { id: "conf1" },
    toggleLayerVisibility: vi.fn(),
    getConfigurationLayerFromId: vi.fn(),
    getLayerHistogram: vi.fn(),
    saveContrastInConfiguration: vi.fn(),
    saveContrastInView: vi.fn(),
    resetContrastInView: vi.fn(),
    changeLayer: vi.fn(),
  },
}));

import LayerInfoGrid from "./LayerInfoGrid.vue";
import store from "@/store";

Vue.use(Vuetify);

const sampleLayers = [
  {
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
];

function mountComponent(props = {}) {
  return shallowMount(LayerInfoGrid, {
    vuetify: new Vuetify(),
    propsData: {
      layers: sampleLayers,
      ...props,
    },
    stubs: {
      ContrastHistogram: true,
      ColorPickerMenu: true,
    },
  });
}

describe("LayerInfoGrid", () => {
  it("delegates toggleVisibility to store", () => {
    const wrapper = mountComponent();
    wrapper.vm.toggleVisibility("l1");
    expect(store.toggleLayerVisibility).toHaveBeenCalledWith("l1");
  });

  it("delegates getLayerHistogram to store", () => {
    const wrapper = mountComponent();
    wrapper.vm.getLayerHistogram(sampleLayers[0]);
    expect(store.getLayerHistogram).toHaveBeenCalledWith(sampleLayers[0]);
  });

  it("getConfigurationContrast returns null when no configuration", () => {
    const origConfig = store.configuration;
    (store as any).configuration = null;
    const wrapper = mountComponent();
    expect(wrapper.vm.getConfigurationContrast("l1")).toBeNull();
    (store as any).configuration = origConfig;
  });

  it("getConfigurationContrast returns null when layer not found", () => {
    (store.getConfigurationLayerFromId as any).mockReturnValue(null);
    const wrapper = mountComponent();
    expect(wrapper.vm.getConfigurationContrast("l1")).toBeNull();
  });

  it("getConfigurationContrast returns contrast when layer found", () => {
    const contrast = { mode: "percentile", blackPoint: 0, whitePoint: 100 };
    (store.getConfigurationLayerFromId as any).mockReturnValue({ contrast });
    const wrapper = mountComponent();
    expect(wrapper.vm.getConfigurationContrast("l1")).toEqual(contrast);
  });

  it("changeContrast calls saveContrastInConfiguration when syncConfiguration is true", () => {
    const wrapper = mountComponent();
    const contrast = {
      mode: "absolute" as const,
      blackPoint: 10,
      whitePoint: 90,
    };
    wrapper.vm.changeContrast("l1", contrast, true);
    expect(store.saveContrastInConfiguration).toHaveBeenCalledWith({
      layerId: "l1",
      contrast,
    });
  });

  it("changeContrast calls saveContrastInView when syncConfiguration is false", () => {
    const wrapper = mountComponent();
    const contrast = {
      mode: "absolute" as const,
      blackPoint: 10,
      whitePoint: 90,
    };
    wrapper.vm.changeContrast("l1", contrast, false);
    expect(store.saveContrastInView).toHaveBeenCalledWith({
      layerId: "l1",
      contrast,
    });
  });

  it("delegates resetContrastInView to store", () => {
    const wrapper = mountComponent();
    wrapper.vm.resetContrastInView("l1");
    expect(store.resetContrastInView).toHaveBeenCalledWith("l1");
  });

  it("delegates changeLayerColor to store.changeLayer", () => {
    const wrapper = mountComponent();
    wrapper.vm.changeLayerColor("l1", "#FF0000");
    expect(store.changeLayer).toHaveBeenCalledWith({
      layerId: "l1",
      delta: { color: "#FF0000" },
    });
  });

  it("shows no layers alert when layers is empty", () => {
    const wrapper = mountComponent({ layers: [] });
    expect(wrapper.text()).toContain("No layers available");
  });
});

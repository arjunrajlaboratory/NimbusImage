import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

vi.mock("@/store/index", () => ({
  default: {
    configuration: {
      scales: {
        pixelSize: { value: 1, unit: "nm" },
        zStep: { value: 1, unit: "nm" },
        tStep: { value: 1, unit: "s" },
      },
    },
    configurationScales: {
      pixelSize: { value: 1, unit: "nm" },
      zStep: { value: 1, unit: "nm" },
      tStep: { value: 1, unit: "s" },
    },
    viewScales: {},
    dataset: null,
    scalebarColor: "#ffffff",
    setScalebarColor: vi.fn(),
    saveScaleInConfiguration: vi.fn(),
    saveScalesInView: vi.fn(),
    resetScalesInView: vi.fn(),
    showPixelScalebar: true,
    setShowPixelScalebar: vi.fn(),
  },
}));

vi.mock("@/store/GirderAPI", () => ({
  getDatasetScales: vi.fn().mockReturnValue({
    pixelSize: { value: 0.5, unit: "mm" },
    zStep: { value: 2, unit: "um" },
    tStep: { value: 10, unit: "s" },
  }),
}));

vi.mock("@/utils/conversion", () => ({
  convertLength: vi.fn().mockReturnValue(1000),
  convertTime: vi.fn().mockReturnValue(60),
}));

import ScaleSettings from "./ScaleSettings.vue";
import store from "@/store/index";
import { getDatasetScales } from "@/store/GirderAPI";

Vue.use(Vuetify);
Vue.directive("description", {});

function mountComponent(props = {}) {
  return mount(ScaleSettings, {
    vuetify: new Vuetify(),
    propsData: {
      ...props,
    },
    stubs: {
      PixelScaleBarSetting: true,
      ColorPickerMenu: true,
    },
  });
}

describe("ScaleSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (store.setScalebarColor as any) = vi.fn();
    (store.saveScaleInConfiguration as any) = vi.fn();
    (store.saveScalesInView as any) = vi.fn();
    (store.resetScalesInView as any) = vi.fn();
    (store as any).dataset = null;
    (store as any).viewScales = {};
    (store as any).configurationScales = {
      pixelSize: { value: 1, unit: "nm" },
      zStep: { value: 1, unit: "nm" },
      tStep: { value: 1, unit: "s" },
    };
    (store as any).scalebarColor = "#ffffff";
    (getDatasetScales as any).mockReturnValue({
      pixelSize: { value: 0.5, unit: "mm" },
      zStep: { value: 2, unit: "um" },
      tStep: { value: 10, unit: "s" },
    });
  });

  it("scaleItems returns 3 items (pixelSize, zStep, tStep)", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const items = vm.scaleItems;
    expect(items).toHaveLength(3);
    expect(items[0].key).toBe("pixelSize");
    expect(items[0].text).toBe("Pixel size");
    expect(items[1].key).toBe("zStep");
    expect(items[1].text).toBe("Z step");
    expect(items[2].key).toBe("tStep");
    expect(items[2].text).toBe("Time step");
  });

  it("scales merges configurationScales and viewScales when not configurationOnly", () => {
    (store as any).viewScales = {
      pixelSize: { value: 99, unit: "um" },
    };
    const wrapper = mountComponent({ configurationOnly: false });
    const vm = wrapper.vm as any;
    const scales = vm.scales;
    // viewScales should override configurationScales for pixelSize
    expect(scales.pixelSize.value).toBe(99);
    expect(scales.pixelSize.unit).toBe("um");
    // zStep should come from configurationScales
    expect(scales.zStep.value).toBe(1);
  });

  it("scales returns only configurationScales when configurationOnly is true", () => {
    (store as any).viewScales = {
      pixelSize: { value: 99, unit: "um" },
    };
    const wrapper = mountComponent({ configurationOnly: true });
    const vm = wrapper.vm as any;
    const scales = vm.scales;
    // Should use configurationScales, not merged with viewScales
    expect(scales.pixelSize.value).toBe(1);
    expect(scales.pixelSize.unit).toBe("nm");
  });

  it("scalebarColor get/set proxies store", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.scalebarColor).toBe("#ffffff");
    vm.scalebarColor = "#000000";
    expect(store.setScalebarColor).toHaveBeenCalledWith("#000000");
  });

  it("resetFromDataset calls getDatasetScales and defaultSaveScale", () => {
    const mockDataset = { anyImage: () => null };
    (store as any).dataset = mockDataset;
    const wrapper = mountComponent({ configurationOnly: false });
    const vm = wrapper.vm as any;
    vm.resetFromDataset("pixelSize");
    expect(getDatasetScales).toHaveBeenCalledWith(mockDataset);
    expect(store.saveScalesInView).toHaveBeenCalledWith({
      itemId: "pixelSize",
      scale: { value: 0.5, unit: "mm" },
    });
  });

  it("resetFromDataset is no-op when no dataset", () => {
    (store as any).dataset = null;
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.resetFromDataset("pixelSize");
    expect(getDatasetScales).not.toHaveBeenCalled();
  });
});

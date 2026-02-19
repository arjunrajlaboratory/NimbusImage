import { describe, it, expect, vi, beforeEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

const mockSetXY = vi.fn();
const mockSetZ = vi.fn();
const mockSetTime = vi.fn();
const mockSetUnrollXY = vi.fn();
const mockSetUnrollZ = vi.fn();
const mockSetUnrollT = vi.fn();
const mockRefreshDataset = vi.fn();
const mockSetLayerMode = vi.fn();
const mockSetShowTimelapseMode = vi.fn();
const mockSetTimelapseModeWindow = vi.fn();
const mockSetTimelapseTags = vi.fn();
const mockSetShowTimelapseLabels = vi.fn();
const mockGetFolder = vi.fn();

vi.mock("@/store", () => ({
  default: {
    xy: 2,
    z: 1,
    time: 3,
    setXY: (...args: any[]) => mockSetXY(...args),
    setZ: (...args: any[]) => mockSetZ(...args),
    setTime: (...args: any[]) => mockSetTime(...args),
    unrollXY: false,
    unrollZ: false,
    unrollT: false,
    setUnrollXY: (...args: any[]) => mockSetUnrollXY(...args),
    setUnrollZ: (...args: any[]) => mockSetUnrollZ(...args),
    setUnrollT: (...args: any[]) => mockSetUnrollT(...args),
    dataset: {
      xy: [0, 1, 2, 3, 4],
      z: [0, 1, 2],
      time: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    },
    layerMode: "multiple",
    setLayerMode: (...args: any[]) => mockSetLayerMode(...args),
    refreshDataset: (...args: any[]) => mockRefreshDataset(...args),
    showTimelapseMode: false,
    setShowTimelapseMode: (...args: any[]) => mockSetShowTimelapseMode(...args),
    timelapseModeWindow: 10,
    setTimelapseModeWindow: (...args: any[]) =>
      mockSetTimelapseModeWindow(...args),
    timelapseTags: [],
    setTimelapseTags: (...args: any[]) => mockSetTimelapseTags(...args),
    showTimelapseLabels: false,
    setShowTimelapseLabels: (...args: any[]) =>
      mockSetShowTimelapseLabels(...args),
    showXYLabels: false,
    showZLabels: false,
    showTimeLabels: false,
    selectedDatasetId: "ds1",
    girderResources: {
      getFolder: (...args: any[]) => mockGetFolder(...args),
    },
  },
}));

vi.mock("@/store/filters", () => ({
  default: {
    tagFilter: { id: "tag", exclusive: false, enabled: true, tags: [] },
    setTagFilter: vi.fn(),
  },
}));

vi.mock("@/store/annotation", () => ({
  default: {
    deleteAllTimelapseConnections: vi.fn(),
  },
}));

vi.mock("@/utils/v-mousetrap", () => ({}));

vi.mock("@/utils/log", () => ({
  logError: vi.fn(),
}));

import ViewerToolbar from "./ViewerToolbar.vue";
import store from "@/store";
import filterStore from "@/store/filters";

Vue.use(Vuetify);
Vue.directive("mousetrap", {});
Vue.directive("tour-trigger", {});

function mountComponent() {
  return shallowMount(ViewerToolbar, {
    vuetify: new Vuetify(),
    stubs: {
      ValueSlider: true,
      SwitchToggle: true,
      Toolset: true,
      LargeImageDropdown: true,
      TagPicker: true,
      TagFilterEditor: true,
    },
  });
}

describe("ViewerToolbar", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Reset store values after restoreAllMocks clears fns
    (store as any).xy = 2;
    (store as any).z = 1;
    (store as any).time = 3;
    (store as any).unrollXY = false;
    (store as any).unrollZ = false;
    (store as any).unrollT = false;
    (store as any).layerMode = "multiple";
    (store as any).showTimelapseMode = false;
    (store as any).showXYLabels = false;
    (store as any).showZLabels = false;
    (store as any).showTimeLabels = false;
    (store as any).setXY = (...args: any[]) => mockSetXY(...args);
    (store as any).setZ = (...args: any[]) => mockSetZ(...args);
    (store as any).setTime = (...args: any[]) => mockSetTime(...args);
    (store as any).setUnrollXY = (...args: any[]) => mockSetUnrollXY(...args);
    (store as any).setUnrollZ = (...args: any[]) => mockSetUnrollZ(...args);
    (store as any).setUnrollT = (...args: any[]) => mockSetUnrollT(...args);
    (store as any).setLayerMode = (...args: any[]) => mockSetLayerMode(...args);
    (store as any).refreshDataset = (...args: any[]) =>
      mockRefreshDataset(...args);
    mockGetFolder.mockResolvedValue(null);
  });

  it("xy getter returns store.xy", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.xy).toBe(2);
    wrapper.destroy();
  });

  it("xy setter calls store.setXY", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.xy = 3;
    expect(mockSetXY).toHaveBeenCalledWith(3);
    wrapper.destroy();
  });

  it("z getter returns store.z", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.z).toBe(1);
    wrapper.destroy();
  });

  it("z setter calls store.setZ", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.z = 0;
    expect(mockSetZ).toHaveBeenCalledWith(0);
    wrapper.destroy();
  });

  it("time getter returns store.time", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.time).toBe(3);
    wrapper.destroy();
  });

  it("time setter calls store.setTime", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.time = 5;
    expect(mockSetTime).toHaveBeenCalledWith(5);
    wrapper.destroy();
  });

  it("maxXY is computed from dataset.xy.length - 1", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.maxXY).toBe(4); // 5 items, index 0-4
    wrapper.destroy();
  });

  it("maxZ is computed from dataset.z.length - 1", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.maxZ).toBe(2); // 3 items, index 0-2
    wrapper.destroy();
  });

  it("maxTime is computed from dataset.time.length - 1", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.maxTime).toBe(9); // 10 items, index 0-9
    wrapper.destroy();
  });

  it("maxXY falls back to xy value when dataset is null", () => {
    (store as any).dataset = null;
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.maxXY).toBe(2); // falls back to store.xy
    (store as any).dataset = {
      xy: [0, 1, 2, 3, 4],
      z: [0, 1, 2],
      time: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    };
    wrapper.destroy();
  });

  it("unrollXY getter returns store.unrollXY", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.unrollXY).toBe(false);
    wrapper.destroy();
  });

  it("unrollXY setter calls store.setUnrollXY", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.unrollXY = true;
    expect(mockSetUnrollXY).toHaveBeenCalledWith(true);
    wrapper.destroy();
  });

  it("unrollZ setter calls store.setUnrollZ", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.unrollZ = true;
    expect(mockSetUnrollZ).toHaveBeenCalledWith(true);
    wrapper.destroy();
  });

  it("unrollT setter calls store.setUnrollT", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.unrollT = true;
    expect(mockSetUnrollT).toHaveBeenCalledWith(true);
    wrapper.destroy();
  });

  it("layerMode getter returns store.layerMode", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.layerMode).toBe("multiple");
    wrapper.destroy();
  });

  it("layerMode setter calls store.setLayerMode", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.layerMode = "single";
    expect(mockSetLayerMode).toHaveBeenCalledWith("single");
    wrapper.destroy();
  });

  it("tagFilter getter returns filterStore.tagFilter", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.tagFilter).toEqual(
      expect.objectContaining({ id: "tag", tags: [] }),
    );
    wrapper.destroy();
  });

  it("tagFilter setter calls filterStore.setTagFilter", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const newFilter = {
      id: "tag",
      exclusive: true,
      enabled: true,
      tags: ["A"],
    };
    vm.tagFilter = newFilter;
    expect(filterStore.setTagFilter).toHaveBeenCalledWith(newFilter);
    wrapper.destroy();
  });

  it("mousetrapSliders has 6 hotkey bindings", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.mousetrapSliders).toHaveLength(6);
    wrapper.destroy();
  });

  it("mousetrapSliders w decreases xy by 1 (clamped at 0)", () => {
    (store as any).xy = 2;
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const wBinding = vm.mousetrapSliders.find((h: any) => h.bind === "w");
    wBinding.handler();
    expect(mockSetXY).toHaveBeenCalledWith(1);
    wrapper.destroy();
  });

  it("mousetrapSliders w clamps xy to 0", () => {
    (store as any).xy = 0;
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const wBinding = vm.mousetrapSliders.find((h: any) => h.bind === "w");
    wBinding.handler();
    expect(mockSetXY).toHaveBeenCalledWith(0);
    wrapper.destroy();
  });

  it("mousetrapSliders r increases xy by 1 (clamped at maxXY)", () => {
    (store as any).xy = 2;
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const rBinding = vm.mousetrapSliders.find((h: any) => h.bind === "r");
    rBinding.handler();
    expect(mockSetXY).toHaveBeenCalledWith(3);
    wrapper.destroy();
  });

  it("mousetrapSliders d decreases z", () => {
    (store as any).z = 1;
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const dBinding = vm.mousetrapSliders.find((h: any) => h.bind === "d");
    dBinding.handler();
    expect(mockSetZ).toHaveBeenCalledWith(0);
    wrapper.destroy();
  });

  it("mousetrapSliders e increases z", () => {
    (store as any).z = 1;
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const eBinding = vm.mousetrapSliders.find((h: any) => h.bind === "e");
    eBinding.handler();
    expect(mockSetZ).toHaveBeenCalledWith(2);
    wrapper.destroy();
  });

  it("mousetrapSliders s decreases time", () => {
    (store as any).time = 3;
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const sBinding = vm.mousetrapSliders.find((h: any) => h.bind === "s");
    sBinding.handler();
    expect(mockSetTime).toHaveBeenCalledWith(2);
    wrapper.destroy();
  });

  it("mousetrapSliders f increases time", () => {
    (store as any).time = 3;
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const fBinding = vm.mousetrapSliders.find((h: any) => h.bind === "f");
    fBinding.handler();
    expect(mockSetTime).toHaveBeenCalledWith(4);
    wrapper.destroy();
  });

  it("xyLabel returns null when showXYLabels is false", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.xyLabel).toBeNull();
    wrapper.destroy();
  });

  it("zLabel returns null when showZLabels is false", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.zLabel).toBeNull();
    wrapper.destroy();
  });

  it("timeLabel returns null when showTimeLabels is false", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.timeLabel).toBeNull();
    wrapper.destroy();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

vi.mock("@/store/index", () => ({
  default: {
    valueOnHover: true,
    setValueOnHover: vi.fn(),
    overview: true,
    setOverview: vi.fn(),
    showScalebar: true,
    setShowScalebar: vi.fn(),
    scalebarColor: "#ffffff",
    setScalebarColor: vi.fn(),
    scaleAnnotationsWithZoom: false,
    setScaleAnnotationsWithZoom: vi.fn(),
    annotationOpacity: 0.5,
    setAnnotationOpacity: vi.fn(),
    annotationsRadius: 4,
    setAnnotationsRadius: vi.fn(),
    compositionMode: "lighten",
    setCompositionMode: vi.fn(),
    backgroundColor: "black",
    setBackgroundColor: vi.fn(),
    showXYLabels: true,
    setShowXYLabels: vi.fn(),
    showZLabels: true,
    setShowZLabels: vi.fn(),
    showTimeLabels: true,
    setShowTimeLabels: vi.fn(),
    showPixelScalebar: true,
    setShowPixelScalebar: vi.fn(),
  },
}));

vi.mock("lodash", () => ({
  debounce: (fn: any) => fn,
}));

vi.mock("@/utils/compositionModes", () => ({
  compositionItems: [
    { text: "Lighten", value: "lighten", help: "Lighten mode" },
  ],
  advancedCompositionItems: [
    { text: "Difference", value: "difference", help: "Difference mode" },
  ],
}));

import ViewerSettings from "./ViewerSettings.vue";
import store from "@/store/index";

Vue.use(Vuetify);
Vue.directive("description", {});

function mountComponent() {
  return mount(ViewerSettings, {
    vuetify: new Vuetify(),
    stubs: {
      PixelScaleBarSetting: true,
      UserColorSettings: true,
      ColorPickerMenu: true,
    },
  });
}

describe("ViewerSettings", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    (store.setValueOnHover as any) = vi.fn();
    (store.setOverview as any) = vi.fn();
    (store.setShowScalebar as any) = vi.fn();
    (store.setScalebarColor as any) = vi.fn();
    (store.setScaleAnnotationsWithZoom as any) = vi.fn();
    (store.setAnnotationOpacity as any) = vi.fn();
    (store.setAnnotationsRadius as any) = vi.fn();
    (store.setCompositionMode as any) = vi.fn();
    (store.setBackgroundColor as any) = vi.fn();
    (store.setShowXYLabels as any) = vi.fn();
    (store.setShowZLabels as any) = vi.fn();
    (store.setShowTimeLabels as any) = vi.fn();
    (store as any).valueOnHover = true;
    (store as any).overview = true;
    (store as any).showScalebar = true;
    (store as any).scalebarColor = "#ffffff";
    (store as any).scaleAnnotationsWithZoom = false;
    (store as any).annotationOpacity = 0.5;
    (store as any).annotationsRadius = 4;
    (store as any).compositionMode = "lighten";
    (store as any).backgroundColor = "black";
    (store as any).showXYLabels = true;
    (store as any).showZLabels = true;
    (store as any).showTimeLabels = true;
  });

  it("valueOnHover getter returns store value", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.valueOnHover).toBe(true);
  });

  it("valueOnHover setter calls setValueOnHover", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.valueOnHover = false;
    expect(store.setValueOnHover).toHaveBeenCalledWith(false);
  });

  it("overview getter returns store value", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.overview).toBe(true);
  });

  it("overview setter calls setOverview", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.overview = false;
    expect(store.setOverview).toHaveBeenCalledWith(false);
  });

  it("showScalebar getter returns store value", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.showScalebar).toBe(true);
  });

  it("showScalebar setter calls setShowScalebar", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.showScalebar = false;
    expect(store.setShowScalebar).toHaveBeenCalledWith(false);
  });

  it("scalebarColor getter returns store value", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.scalebarColor).toBe("#ffffff");
  });

  it("scalebarColor setter calls setScalebarColor", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.scalebarColor = "#000000";
    expect(store.setScalebarColor).toHaveBeenCalledWith("#000000");
  });

  it("scaleAnnotationsWithZoom getter returns store value", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.scaleAnnotationsWithZoom).toBe(false);
  });

  it("scaleAnnotationsWithZoom setter calls setScaleAnnotationsWithZoom", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.scaleAnnotationsWithZoom = true;
    expect(store.setScaleAnnotationsWithZoom).toHaveBeenCalledWith(true);
  });

  it("annotationOpacity setter calls setAnnotationOpacity", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.annotationOpacity = 0.8;
    expect(store.setAnnotationOpacity).toHaveBeenCalledWith(0.8);
  });

  it("annotationsRadius getter returns store value", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.annotationsRadius).toBe(4);
  });

  it("annotationsRadius setter calls setAnnotationsRadius", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.annotationsRadius = 10;
    expect(store.setAnnotationsRadius).toHaveBeenCalledWith(10);
  });

  it("compositionMode getter returns store value", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.compositionMode).toBe("lighten");
  });

  it("compositionMode setter calls setCompositionMode", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.compositionMode = "screen";
    expect(store.setCompositionMode).toHaveBeenCalledWith("screen");
  });

  it("backgroundColor getter returns store value", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.backgroundColor).toBe("black");
  });

  it("backgroundColor setter calls setBackgroundColor", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.backgroundColor = "white";
    expect(store.setBackgroundColor).toHaveBeenCalledWith("white");
  });

  it("showXYLabels getter returns store value", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.showXYLabels).toBe(true);
  });

  it("showXYLabels setter calls setShowXYLabels", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.showXYLabels = false;
    expect(store.setShowXYLabels).toHaveBeenCalledWith(false);
  });

  it("showZLabels getter returns store value", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.showZLabels).toBe(true);
  });

  it("showZLabels setter calls setShowZLabels", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.showZLabels = false;
    expect(store.setShowZLabels).toHaveBeenCalledWith(false);
  });

  it("showTimeLabels getter returns store value", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.showTimeLabels).toBe(true);
  });

  it("showTimeLabels setter calls setShowTimeLabels", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.showTimeLabels = false;
    expect(store.setShowTimeLabels).toHaveBeenCalledWith(false);
  });
});

import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";
import PixelScaleBarSetting from "./PixelScaleBarSetting.vue";

vi.mock("@/store/index", () => ({
  default: {
    showPixelScalebar: true,
    setShowPixelScalebar: vi.fn(),
  },
}));

Vue.use(Vuetify);
Vue.directive("description", {});

function mountComponent() {
  return mount(PixelScaleBarSetting, {
    vuetify: new Vuetify(),
  });
}

describe("PixelScaleBarSetting", () => {
  it("renders 'Show pixel scalebar' label", () => {
    const wrapper = mountComponent();
    expect(wrapper.text()).toContain("Show pixel scalebar");
  });

  it("renders a switch input", () => {
    const wrapper = mountComponent();
    expect(wrapper.find('input[type="checkbox"]').exists()).toBe(true);
  });

  it("reads showPixelScalebar from store", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.showPixelScalebar).toBe(true);
  });
});

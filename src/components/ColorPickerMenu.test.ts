import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";
import ColorPickerMenu from "./ColorPickerMenu.vue";

Vue.use(Vuetify);

function mountComponent(props = {}) {
  return mount(ColorPickerMenu, {
    vuetify: new Vuetify(),
    propsData: {
      value: "#FF0000",
      ...props,
    },
  });
}

describe("ColorPickerMenu", () => {
  it("renders the Color label", () => {
    const wrapper = mountComponent();
    expect(wrapper.text()).toContain("Color");
  });

  it("displays the color bar", () => {
    const wrapper = mountComponent({ value: "#00FF00" });
    const colorBar = wrapper.find(".color-bar");
    expect(colorBar.exists()).toBe(true);
  });

  it("has inheritAttrs set to false", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.$options.inheritAttrs).toBe(false);
  });

  it("renders the menu activator area", () => {
    const wrapper = mountComponent();
    expect(wrapper.find(".d-flex.align-center").exists()).toBe(true);
  });

  it("has a clickable activator with pointer cursor", () => {
    const wrapper = mountComponent();
    const activator = wrapper.find(".d-flex.align-center");
    expect(activator.attributes("style")).toContain("cursor: pointer");
  });
});

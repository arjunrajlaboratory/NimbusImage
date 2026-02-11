import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";
import NimbusTooltip from "./NimbusTooltip.vue";

Vue.use(Vuetify);

function mountComponent(props = {}) {
  return mount(NimbusTooltip, {
    vuetify: new Vuetify(),
    propsData: {
      activator: "#test-element",
      content: "Tooltip text",
      ...props,
    },
  });
}

describe("NimbusTooltip", () => {
  it("renders when enabled (default)", () => {
    const wrapper = mountComponent();
    expect(wrapper.find(".v-tooltip").exists()).toBe(true);
  });

  it("does not render when enabled is false", () => {
    const wrapper = mountComponent({ enabled: false });
    expect(wrapper.find(".v-tooltip").exists()).toBe(false);
  });

  it("uses bottom position by default", () => {
    const wrapper = mountComponent();
    const tooltip = wrapper.find(".v-tooltip");
    expect(tooltip.classes()).toContain("v-tooltip--bottom");
  });

  it("supports top position", () => {
    const wrapper = mountComponent({ position: "top" });
    const tooltip = wrapper.find(".v-tooltip");
    expect(tooltip.classes()).toContain("v-tooltip--top");
  });

  it("supports left position", () => {
    const wrapper = mountComponent({ position: "left" });
    const tooltip = wrapper.find(".v-tooltip");
    expect(tooltip.classes()).toContain("v-tooltip--left");
  });

  it("supports right position", () => {
    const wrapper = mountComponent({ position: "right" });
    const tooltip = wrapper.find(".v-tooltip");
    expect(tooltip.classes()).toContain("v-tooltip--right");
  });
});

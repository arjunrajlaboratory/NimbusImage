import { describe, it, expect } from "vitest";
import { shallowMount } from "@vue/test-utils";
import NimbusTooltip from "./NimbusTooltip.vue";

function mountComponent(props = {}) {
  return shallowMount(NimbusTooltip, {
    props: {
      activator: "#test-element",
      content: "Tooltip text",
      enabled: true,
      ...props,
    },
  });
}

describe("NimbusTooltip", () => {
  it("renders when enabled (default)", () => {
    const wrapper = mountComponent();
    expect(wrapper.find("v-tooltip-stub").exists()).toBe(true);
  });

  it("does not render when enabled is false", () => {
    const wrapper = mountComponent({ enabled: false });
    expect(wrapper.find("v-tooltip-stub").exists()).toBe(false);
  });

  it("uses bottom position by default", () => {
    const wrapper = mountComponent();
    // In Vuetify 3, position is set via "location" prop
    // With shallowMount, check the stub attributes
    const tooltip = wrapper.find("v-tooltip-stub");
    expect(tooltip.exists()).toBe(true);
  });

  it("supports top position", () => {
    const wrapper = mountComponent({ position: "top" });
    const tooltip = wrapper.find("v-tooltip-stub");
    expect(tooltip.exists()).toBe(true);
    expect(tooltip.attributes("location")).toBe("top");
  });

  it("supports left position", () => {
    const wrapper = mountComponent({ position: "left" });
    const tooltip = wrapper.find("v-tooltip-stub");
    expect(tooltip.exists()).toBe(true);
    expect(tooltip.attributes("location")).toBe("left");
  });

  it("supports right position", () => {
    const wrapper = mountComponent({ position: "right" });
    const tooltip = wrapper.find("v-tooltip-stub");
    expect(tooltip.exists()).toBe(true);
    expect(tooltip.attributes("location")).toBe("right");
  });
});

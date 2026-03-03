import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import SwitchToggle from "./SwitchToggle.vue";

function mountComponent(props = {}) {
  return mount(SwitchToggle, {
    props: {
      trueLabel: "On",
      falseLabel: "Off",
      trueValue: "on",
      falseValue: "off",
      label: "Toggle:",
      ...props,
    },
  });
}

describe("SwitchToggle", () => {
  it("renders the label text", () => {
    const wrapper = mountComponent();
    expect(wrapper.text()).toContain("Toggle:");
    expect(wrapper.text()).toContain("Off");
  });

  it("renders the true label on the switch", () => {
    const wrapper = mountComponent();
    expect(wrapper.text()).toContain("On");
  });

  it("renders a checkbox input", () => {
    const wrapper = mountComponent({ modelValue: "on" });
    const input = wrapper.find('input[type="checkbox"]');
    expect(input.exists()).toBe(true);
  });

  it("renders with custom id", () => {
    const wrapper = mountComponent({ id: "my-toggle" });
    const input = wrapper.find("#my-toggle");
    expect(input.exists()).toBe(true);
  });

  it("renders a v-switch component", () => {
    const wrapper = mountComponent({ modelValue: "off" });
    expect(wrapper.find(".v-switch").exists()).toBe(true);
  });
});

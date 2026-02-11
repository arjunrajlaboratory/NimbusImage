import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";
import SwitchToggle from "./SwitchToggle.vue";

Vue.use(Vuetify);

function mountComponent(props = {}) {
  return mount(SwitchToggle, {
    vuetify: new Vuetify(),
    propsData: {
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
    const wrapper = mountComponent({ value: "on" });
    const input = wrapper.find('input[type="checkbox"]');
    expect(input.exists()).toBe(true);
  });

  it("renders with custom id", () => {
    const wrapper = mountComponent({ id: "my-toggle" });
    const input = wrapper.find("#my-toggle");
    expect(input.exists()).toBe(true);
  });

  it("renders a v-switch component", () => {
    const wrapper = mountComponent({ value: "off" });
    expect(wrapper.find(".v-input--switch").exists()).toBe(true);
  });
});

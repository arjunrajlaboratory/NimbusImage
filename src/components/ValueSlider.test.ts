import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";
import ValueSlider from "./ValueSlider.vue";

Vue.use(Vuetify);

function mountComponent(props = {}) {
  return mount(ValueSlider, {
    vuetify: new Vuetify(),
    propsData: {
      value: 5,
      min: 0,
      max: 10,
      label: "Z",
      ...props,
    },
  });
}

describe("ValueSlider", () => {
  it("syncs internalValue from value prop immediately", () => {
    const wrapper = mountComponent({ value: 3, offset: 0 });
    expect(wrapper.vm.slider).toBe(3);
  });

  it("applies offset to internalValue", () => {
    const wrapper = mountComponent({ value: 3, offset: 1 });
    expect(wrapper.vm.slider).toBe(4);
  });

  it("emits input when slider is set", () => {
    const wrapper = mountComponent({ value: 5, offset: 1 });
    wrapper.vm.slider = 8;
    expect(wrapper.emitted("input")).toBeTruthy();
    expect(wrapper.emitted("input")![0][0]).toBe(7); // 8 - offset(1)
  });

  it("does not emit when slider value is unchanged", () => {
    const wrapper = mountComponent({ value: 5, offset: 1 });
    // internalValue should be 6 (5 + 1)
    wrapper.vm.slider = 6;
    expect(wrapper.emitted("input")).toBeFalsy();
  });

  it("displayValue shows value + offset as string", () => {
    const wrapper = mountComponent({ value: 5, offset: 1 });
    expect(wrapper.vm.displayValue).toBe("6");
  });

  it("displayValue uses valueLabel when provided", () => {
    const wrapper = mountComponent({ value: 5, offset: 1, valueLabel: "H10" });
    expect(wrapper.vm.displayValue).toBe("H10");
  });

  it("hides slider when min equals max and not unrolled", () => {
    const wrapper = mountComponent({ value: 0, min: 0, max: 0 });
    expect(wrapper.find(".value-slider").exists()).toBe(false);
  });

  it("shows unrolled message when isUnrolled is true", () => {
    const wrapper = mountComponent({ isUnrolled: true });
    expect(wrapper.vm.unrolledMessage).toBe("Z is unrolled");
  });

  it("increment emits input with value + 1", () => {
    const wrapper = mountComponent({ value: 5 });
    wrapper.vm.increment();
    expect(wrapper.emitted("input")![0][0]).toBe(6);
  });

  it("decrement emits input with value - 1", () => {
    const wrapper = mountComponent({ value: 5 });
    wrapper.vm.decrement();
    expect(wrapper.emitted("input")![0][0]).toBe(4);
  });

  it("increment does nothing at max", () => {
    const wrapper = mountComponent({ value: 10 });
    wrapper.vm.increment();
    expect(wrapper.emitted("input")).toBeFalsy();
  });

  it("decrement does nothing at min", () => {
    const wrapper = mountComponent({ value: 0 });
    wrapper.vm.decrement();
    expect(wrapper.emitted("input")).toBeFalsy();
  });

  it("watches value prop changes", async () => {
    const wrapper = mountComponent({ value: 5, offset: 0 });
    expect(wrapper.vm.slider).toBe(5);
    await wrapper.setProps({ value: 8 });
    expect(wrapper.vm.slider).toBe(8);
  });
});

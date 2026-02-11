import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

vi.mock("@/store", () => ({
  default: {},
}));

import DisplaySlice from "./DisplaySlice.vue";

Vue.use(Vuetify);

function mountComponent(props = {}) {
  return mount(DisplaySlice, {
    vuetify: new Vuetify(),
    propsData: {
      value: { type: "current", value: 0 },
      maxValue: 10,
      label: "Z",
      displayed: 5,
      offset: 0,
      ...props,
    },
  });
}

describe("DisplaySlice", () => {
  it("labelHint shows no slices message when maxValue is 0", () => {
    const wrapper = mountComponent({ maxValue: 0 });
    expect(wrapper.vm.labelHint).toBe("Z (no slices available)");
  });

  it("labelHint shows just label when maxValue > 0", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.labelHint).toBe("Z");
  });

  it("maxOffsetValue equals maxValue", () => {
    const wrapper = mountComponent({ maxValue: 10 });
    expect(wrapper.vm.maxOffsetValue).toBe(10);
  });

  it("minOffsetValue equals negative maxValue", () => {
    const wrapper = mountComponent({ maxValue: 10 });
    expect(wrapper.vm.minOffsetValue).toBe(-10);
  });

  it("changeSlice emits displayed value when type changes to constant", () => {
    const wrapper = mountComponent({ displayed: 7 });
    wrapper.vm.changeSlice("constant", 0);
    expect(wrapper.emitted("change")).toBeTruthy();
    const event = wrapper.emitted("change")![0][0];
    expect(event.type).toBe("constant");
    // When type changes, constant uses this.displayed
    expect(event.value).toBe(7);
  });

  it("changeSlice emits 0 when type changes to offset", () => {
    const wrapper = mountComponent();
    wrapper.vm.changeSlice("offset", "3");
    expect(wrapper.emitted("change")).toBeTruthy();
    const event = wrapper.emitted("change")![0][0];
    expect(event.type).toBe("offset");
    // When type changes, offset resets to 0
    expect(event.value).toBe(0);
  });

  it("changeSlice clamps constant value within range when type is same", () => {
    const wrapper = mountComponent({
      value: { type: "constant", value: 3 },
      maxValue: 5,
      offset: 1,
    });
    // Same type, inputValue = 100 - offset(1) = 99, clamped to maxValue(5)
    wrapper.vm.changeSlice("constant", "100");
    const event = wrapper.emitted("change")![0][0];
    expect(event.value).toBeLessThanOrEqual(5);
  });

  it("changeSlice clamps offset value within bounds when type is same", () => {
    const wrapper = mountComponent({
      value: { type: "offset", value: 0 },
      maxValue: 5,
    });
    wrapper.vm.changeSlice("offset", "100");
    const event = wrapper.emitted("change")![0][0];
    expect(event.value).toBeLessThanOrEqual(5);
  });

  it("changeSlice does not emit when value unchanged and type unchanged", () => {
    const wrapper = mountComponent({
      value: { type: "current", value: 0 },
    });
    wrapper.vm.changeSlice("current", 0);
    expect(wrapper.emitted("change")).toBeFalsy();
  });

  it("changeSlice emits 0 for default types", () => {
    const wrapper = mountComponent();
    wrapper.vm.changeSlice("max-merge", 0);
    expect(wrapper.emitted("change")).toBeTruthy();
    const event = wrapper.emitted("change")![0][0];
    expect(event.type).toBe("max-merge");
    expect(event.value).toBe(0);
  });
});

import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

vi.mock("@/store", () => ({
  default: {
    layers: [
      { id: "l1", name: "Layer 1" },
      { id: "l2", name: "Layer 2" },
    ],
  },
}));

import LayerSelect from "./LayerSelect.vue";

Vue.use(Vuetify);

function mountComponent(props = {}) {
  return mount(LayerSelect, {
    vuetify: new Vuetify(),
    propsData: {
      value: "l1",
      ...props,
    },
  });
}

describe("LayerSelect", () => {
  it("layerItems maps store.layers to label/value", () => {
    const wrapper = mountComponent();
    const items = wrapper.vm.layerItems;
    expect(items).toEqual([
      { label: "Layer 1", value: "l1" },
      { label: "Layer 2", value: "l2" },
    ]);
  });

  it("adds Any option when any prop is set", () => {
    const wrapper = mountComponent({ any: true });
    const items = wrapper.vm.layerItems;
    expect(items).toHaveLength(3);
    expect(items[2]).toEqual({ label: "Any", value: null });
  });

  it("does not add Any option by default", () => {
    const wrapper = mountComponent();
    const items = wrapper.vm.layerItems;
    expect(items.find((i: any) => i.label === "Any")).toBeUndefined();
  });

  it("ensureLayer sets first layer when value is null (no any)", () => {
    const wrapper = mountComponent({ value: null });
    // After mount, ensureLayer should have emitted input with first layer
    const emitted = wrapper.emitted("input");
    expect(emitted).toBeTruthy();
    expect(emitted![0][0]).toBe("l1");
  });

  it("ensureLayer sets null when value is undefined (with any)", () => {
    const wrapper = mountComponent({ value: undefined, any: true });
    const emitted = wrapper.emitted("input");
    expect(emitted).toBeTruthy();
    expect(emitted![0][0]).toBeNull();
  });
});

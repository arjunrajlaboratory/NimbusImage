import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";
import ChannelSelect from "./ChannelSelect.vue";

vi.mock("@/store", () => ({
  default: {
    dataset: {
      channels: [0, 1, 2],
      channelNames: new Map([
        [0, "DAPI"],
        [1, "GFP"],
      ]),
    },
  },
}));

Vue.use(Vuetify);

function mountComponent(props = {}) {
  return mount(ChannelSelect, {
    vuetify: new Vuetify(),
    propsData: {
      value: 0,
      ...props,
    },
  });
}

describe("ChannelSelect", () => {
  it("renders a v-select component", () => {
    const wrapper = mountComponent();
    expect(wrapper.find(".v-select").exists()).toBe(true);
  });

  it("has correct channel items with names", () => {
    const wrapper = mountComponent();
    const items = wrapper.vm.channelItems;
    expect(items).toEqual([
      { text: "DAPI", value: 0 },
      { text: "GFP", value: 1 },
      { text: "Channel 2", value: 2 },
    ]);
  });

  it("includes Any option when any prop is true", () => {
    const wrapper = mountComponent({ any: true });
    const items = wrapper.vm.channelItems;
    expect(items[0]).toEqual({ text: "Any", value: null });
    expect(items).toHaveLength(4);
  });

  it("does not include Any option by default", () => {
    const wrapper = mountComponent();
    const items = wrapper.vm.channelItems;
    expect(items.find((i: any) => i.text === "Any")).toBeUndefined();
  });

  it("falls back to Channel N for unnamed channels", () => {
    const wrapper = mountComponent();
    const items = wrapper.vm.channelItems;
    expect(items[2].text).toBe("Channel 2");
  });
});

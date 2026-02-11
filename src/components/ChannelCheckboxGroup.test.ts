import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";
import ChannelCheckboxGroup from "./ChannelCheckboxGroup.vue";

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
  return mount(ChannelCheckboxGroup, {
    vuetify: new Vuetify(),
    propsData: {
      value: {},
      ...props,
    },
  });
}

describe("ChannelCheckboxGroup", () => {
  it("renders channel items as checkboxes", () => {
    const wrapper = mountComponent();
    const checkboxes = wrapper.findAll(".v-input--checkbox");
    expect(checkboxes.length).toBe(3);
  });

  it("displays channel names", () => {
    const wrapper = mountComponent();
    expect(wrapper.text()).toContain("DAPI");
    expect(wrapper.text()).toContain("GFP");
    expect(wrapper.text()).toContain("Channel 2");
  });

  it("renders label when provided", () => {
    const wrapper = mountComponent({ label: "Select channels" });
    expect(wrapper.text()).toContain("Select channels");
  });

  it("does not render label when empty", () => {
    const wrapper = mountComponent({ label: "" });
    expect(wrapper.find(".v-subheader").exists()).toBe(false);
  });

  it("initializes missing channels on created", () => {
    const wrapper = mountComponent({ value: { 0: true } });
    // created() should add missing channels (1, 2) as false
    const emitted = wrapper.emitted("input");
    expect(emitted).toBeTruthy();
    const lastEmitted = emitted![emitted!.length - 1][0];
    expect(lastEmitted).toHaveProperty("0", true);
    expect(lastEmitted).toHaveProperty("1", false);
    expect(lastEmitted).toHaveProperty("2", false);
  });
});

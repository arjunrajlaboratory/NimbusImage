import { describe, it, expect, vi } from "vitest";
import { shallowMount } from "@vue/test-utils";
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

function mountComponent(props = {}) {
  return shallowMount(ChannelCheckboxGroup, {
    props: {
      modelValue: {},
      ...props,
    },
    global: {
      stubs: {
        VContainer: { template: "<div><slot /></div>" },
        VRow: { template: "<div><slot /></div>" },
        VCol: { template: "<div><slot /></div>" },
        VListSubheader: { template: "<div><slot /></div>" },
      },
    },
  });
}

describe("ChannelCheckboxGroup", () => {
  it("renders channel items as checkboxes", () => {
    const wrapper = mountComponent();
    const checkboxes = wrapper.findAll("v-checkbox-stub");
    expect(checkboxes.length).toBe(3);
  });

  it("displays channel names", () => {
    const wrapper = mountComponent();
    // With shallowMount, v-checkbox is stubbed; check attributes for labels
    const html = wrapper.html();
    expect(html).toContain("DAPI");
    expect(html).toContain("GFP");
    expect(html).toContain("Channel 2");
  });

  it("renders label when provided", () => {
    const wrapper = mountComponent({ label: "Select channels" });
    expect(wrapper.html()).toContain("Select channels");
  });

  it("does not render label when empty", () => {
    const wrapper = mountComponent({ label: "" });
    // v-list-subheader has v-if="label" which is falsy for empty string
    expect(wrapper.find("v-list-subheader-stub").exists()).toBe(false);
  });

  it("initializes missing channels on created", () => {
    const wrapper = mountComponent({ modelValue: { 0: true } });
    // created() should add missing channels (1, 2) as false
    const emitted = wrapper.emitted("update:modelValue");
    expect(emitted).toBeTruthy();
    const lastEmitted = emitted![emitted!.length - 1][0];
    expect(lastEmitted).toHaveProperty("0", true);
    expect(lastEmitted).toHaveProperty("1", false);
    expect(lastEmitted).toHaveProperty("2", false);
  });
});

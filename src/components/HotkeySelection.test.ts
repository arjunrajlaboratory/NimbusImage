import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";
import HotkeySelection from "./HotkeySelection.vue";

// Mock Mousetrap to avoid DOM key event dependencies
vi.mock("mousetrap", () => ({
  default: {
    record: vi.fn((callback: (sequence: string[]) => void) => {
      // Simulate recording "ctrl+s"
      callback(["ctrl+s"]);
    }),
  },
}));

Vue.use(Vuetify);

function mountComponent(props = {}) {
  return mount(HotkeySelection, {
    vuetify: new Vuetify(),
    propsData: {
      ...props,
    },
  });
}

describe("HotkeySelection", () => {
  it("shows 'No hotkey yet' when no value is set", () => {
    const wrapper = mountComponent();
    expect(wrapper.text()).toContain("No hotkey yet");
  });

  it("displays the current hotkey when value is provided", () => {
    const wrapper = mountComponent({ value: "ctrl+k" });
    expect(wrapper.text()).toContain("Current hotkey: ctrl+k");
  });

  it("renders Record and Clear buttons", () => {
    const wrapper = mountComponent();
    const buttons = wrapper.findAll(".v-btn");
    expect(buttons).toHaveLength(2);
    expect(wrapper.text()).toContain("Record hotkey");
    expect(wrapper.text()).toContain("Clear hotkey");
  });

  it("emits input with null when Clear hotkey is clicked", async () => {
    const wrapper = mountComponent({ value: "ctrl+k" });
    const clearButton = wrapper.findAll(".v-btn").at(1);
    await clearButton.trigger("click");
    expect(wrapper.emitted("input")).toBeTruthy();
    expect(wrapper.emitted("input")![0]).toEqual([null]);
  });

  it("emits recorded hotkey when Record is clicked (mocked)", async () => {
    const wrapper = mountComponent();
    const recordButton = wrapper.findAll(".v-btn").at(0);
    await recordButton.trigger("click");
    // Mousetrap.record is mocked to immediately call back with ["ctrl+s"]
    expect(wrapper.emitted("input")).toBeTruthy();
    expect(wrapper.emitted("input")![0]).toEqual(["ctrl+s"]);
  });
});

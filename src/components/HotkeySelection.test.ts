import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import HotkeySelection from "./HotkeySelection.vue";
import { boundKeys } from "@/utils/v-mousetrap";

// Mock Mousetrap to avoid DOM key event dependencies
vi.mock("mousetrap", () => ({
  default: {
    record: vi.fn((callback: (sequence: string[]) => void) => {
      // Simulate recording "ctrl+s"
      callback(["ctrl+s"]);
    }),
  },
}));

function mountComponent(props = {}) {
  return mount(HotkeySelection, {
    props: {
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
    const wrapper = mountComponent({ modelValue: "ctrl+k" });
    expect(wrapper.text()).toContain("Hotkey: ctrl+k");
  });

  it("renders Record and Clear buttons", () => {
    const wrapper = mountComponent();
    const buttons = wrapper.findAll(".v-btn");
    expect(buttons).toHaveLength(2);
    expect(wrapper.text()).toContain("Record");
    expect(wrapper.text()).toContain("Clear");
  });

  it("emits input with null when Clear hotkey is clicked", async () => {
    const wrapper = mountComponent({ modelValue: "ctrl+k" });
    const clearButton = wrapper.findAll(".v-btn").at(1)!;
    await clearButton.trigger("click");
    expect(wrapper.emitted("update:modelValue")).toBeTruthy();
    expect(wrapper.emitted("update:modelValue")![0]).toEqual([null]);
  });

  it("emits recorded hotkey when Record is clicked (mocked)", async () => {
    const wrapper = mountComponent();
    const recordButton = wrapper.findAll(".v-btn").at(0)!;
    await recordButton.trigger("click");
    // Mousetrap.record is mocked to immediately call back with ["ctrl+s"]
    expect(wrapper.emitted("update:modelValue")).toBeTruthy();
    expect(wrapper.emitted("update:modelValue")![0]).toEqual(["ctrl+s"]);
  });

  describe("conflict warning", () => {
    beforeEach(() => {
      boundKeys.value = {
        g: [{ section: "View", description: "Show/hide transcripts" }],
        p: [{ section: "Tools", description: "Toggle tool:  Spots" }],
      };
    });
    afterEach(() => {
      boundKeys.value = {};
    });

    it("warns when the hotkey is already bound", () => {
      const wrapper = mountComponent({ modelValue: "g" });
      expect(wrapper.find(".hotkey-conflict").text()).toBe(
        'G is already used for "Show/hide transcripts" (View). Pressing it will do both.',
      );
    });

    it("does not warn for a free key or the tool's own hotkey", () => {
      expect(
        mountComponent({ modelValue: "q" }).find(".hotkey-conflict").exists(),
      ).toBe(false);
      expect(
        mountComponent({
          modelValue: "p",
          ownHotkey: "p",
          ownDescription: "Toggle tool:  Spots",
        })
          .find(".hotkey-conflict")
          .exists(),
      ).toBe(false);
      expect(mountComponent().find(".hotkey-conflict").exists()).toBe(false);
    });

    it("still warns about another binding on the tool's own key", () => {
      boundKeys.value = {
        g: [
          { section: "Tools", description: "Toggle tool:  Spots" },
          { section: "View", description: "Show/hide transcripts" },
        ],
      };
      const wrapper = mountComponent({
        modelValue: "g",
        ownHotkey: "g",
        ownDescription: "Toggle tool:  Spots",
      });
      expect(wrapper.find(".hotkey-conflict").text()).toBe(
        'G is already used for "Show/hide transcripts" (View). Pressing it will do both.',
      );
    });
  });
});

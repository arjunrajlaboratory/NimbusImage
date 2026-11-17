import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
} from "vitest";
import { mount } from "@vue/test-utils";
import HotkeySelection from "./HotkeySelection.vue";
import { boundKeys } from "@/utils/v-mousetrap";

// Mock Mousetrap to avoid DOM key event dependencies
const mocks = vi.hoisted(() => ({
  pauseConditions: [] as (() => boolean)[],
  releases: 0,
  // Simulate recording "ctrl+s" at once; a test can hold the callback.
  record: vi.fn((callback: (sequence: string[]) => void) => {
    callback(["ctrl+s"]);
  }),
}));

vi.mock("mousetrap", () => ({ default: { record: mocks.record } }));

vi.mock("@/utils/v-mousetrap", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/v-mousetrap")>()),
  pauseHotkeysWhile: (condition: () => boolean) => {
    mocks.pauseConditions.push(condition);
    return () => {
      mocks.releases++;
    };
  },
}));

vi.mock("@/commands/hotkeys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/hotkeys")>();
  // Windows/Linux spellings, whatever machine runs the tests.
  return {
    ...actual,
    canonicalHotkey: (binding: string) =>
      actual.canonicalHotkey(binding, false),
    formatHotkey: (binding: string) => actual.formatHotkey(binding, false),
  };
});

// jsdom does no layout, so offsetParent is always null; stand in for whether
// the recorder is on screen (a closed dialog keeps it mounted but hidden).
let shown = true;
const offsetParent = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "offsetParent",
)!;
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get: () => (shown ? document.body : null),
  });
});
afterAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetParent", offsetParent);
});
beforeEach(() => {
  shown = true;
  mocks.pauseConditions.length = 0;
  mocks.releases = 0;
});

function holdRecording() {
  let finish!: (sequence: string[]) => void;
  mocks.record.mockImplementationOnce((callback) => {
    finish = callback;
  });
  return (sequence: string[]) => finish(sequence);
}

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

  it("pauses bound hotkeys while recording", async () => {
    const finish = holdRecording();
    const wrapper = mountComponent();
    await wrapper.findAll(".v-btn").at(0)!.trigger("click");
    const [paused] = mocks.pauseConditions;
    expect(paused()).toBe(true);
    finish(["g"]);
    expect(paused()).toBe(false);
    expect(mocks.releases).toBe(1);
    expect(wrapper.emitted("update:modelValue")![0]).toEqual(["g"]);
  });

  it("lifts the pause when unmounted mid-recording", async () => {
    const finish = holdRecording();
    const wrapper = mountComponent();
    await wrapper.findAll(".v-btn").at(0)!.trigger("click");
    wrapper.unmount();
    expect(mocks.releases).toBe(1);
    // A late recording neither releases again nor sets a hotkey.
    finish(["g"]);
    expect(mocks.releases).toBe(1);
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
  });

  it("neither pauses nor takes a key once its dialog is hidden", async () => {
    const finish = holdRecording();
    const wrapper = mountComponent();
    await wrapper.findAll(".v-btn").at(0)!.trigger("click");
    const [paused] = mocks.pauseConditions;
    shown = false;
    expect(paused()).toBe(false);
    finish(["a"]);
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
    expect(mocks.releases).toBe(1);
    shown = true;
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("Record");
    expect(wrapper.text()).not.toContain("Recording...");
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

    it("warns when a recorded spelling is an alias of a bound key", () => {
      boundKeys.value = {
        "mod+shift+z": [
          { section: "Objects", description: "Redo last action" },
        ],
      };
      const wrapper = mountComponent({ modelValue: "ctrl+shift+z" });
      expect(wrapper.find(".hotkey-conflict").text()).toBe(
        'Ctrl+Shift+Z is already used for "Redo last action" (Objects). Pressing it will do both.',
      );
    });

    it("warns when a sequence runs a bound single key", () => {
      const wrapper = mountComponent({ modelValue: "g i" });
      expect(wrapper.find(".hotkey-conflict").text()).toBe(
        'G then I is already used for "Show/hide transcripts" (View, G). Pressing it will do both.',
      );
    });

    it("warns when a longer sequence contains a bound one", () => {
      boundKeys.value = {
        "g i": [{ section: "Tools", description: "Toggle tool:  Spots" }],
      };
      const wrapper = mountComponent({ modelValue: "g i x" });
      expect(wrapper.find(".hotkey-conflict").text()).toBe(
        'G then I then X is already used for "Toggle tool:  Spots" (Tools, G then I). Pressing it will do both.',
      );
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

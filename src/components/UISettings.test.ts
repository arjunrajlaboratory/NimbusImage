import { describe, it, expect, vi } from "vitest";
import { shallowMount } from "@vue/test-utils";
import UISettings from "./UISettings.vue";

vi.mock("@/store/index", () => ({
  default: {},
}));

function mountComponent() {
  return shallowMount(UISettings, {
    global: {
      stubs: {
        VExpansionPanel: { template: "<div><slot /></div>" },
        VExpansionPanelTitle: { template: "<div><slot /></div>" },
        VExpansionPanelText: { template: "<div><slot /></div>" },
      },
    },
  });
}

describe("UISettings", () => {
  it("renders 'Interface settings' header", () => {
    const wrapper = mountComponent();
    expect(wrapper.html()).toContain("Interface settings");
  });

  it("has darkMode computed property", () => {
    const wrapper = mountComponent();
    // Dark mode label is inside expansion panel content (not rendered until expanded)
    // Test the computed property instead
    expect(typeof (wrapper.vm as any).darkMode).toBe("boolean");
  });

  it("has darkMode computed that accesses vuetify theme", () => {
    const wrapper = mountComponent();
    // The darkMode computed reads from useTheme().global.name
    expect((wrapper.vm as any).darkMode).toBe(false);
    (wrapper.vm as any).darkMode = true;
    expect((wrapper.vm as any).darkMode).toBe(true);
  });
});

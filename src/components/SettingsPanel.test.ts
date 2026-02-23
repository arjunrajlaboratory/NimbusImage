import { describe, it, expect, vi } from "vitest";
import { shallowMount } from "@vue/test-utils";

vi.mock("@/store", () => ({
  default: {},
}));

vi.mock("@/store/annotation", () => ({
  default: {},
}));

vi.mock("@/store/properties", () => ({
  default: {},
}));

vi.mock("@/store/filters", () => ({
  default: {},
}));

vi.mock("@/store/progress", () => ({
  default: {
    activeProgresses: [],
    activeNotifications: [],
    hasActiveProgresses: false,
  },
}));

import SettingsPanel from "./SettingsPanel.vue";

function mountComponent() {
  return shallowMount(SettingsPanel, {
    global: {
      stubs: {
        VCard: { template: "<div><slot /></div>" },
        VCardTitle: { template: "<div><slot /></div>" },
        VCardText: { template: "<div><slot /></div>" },
      },
    },
  });
}

describe("SettingsPanel", () => {
  it("renders with default expanded panels [0,1,2,3]", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.panels).toEqual([0, 1, 2, 3]);
  });

  it("renders NimbusImage settings title", () => {
    const wrapper = mountComponent();
    expect(wrapper.html()).toContain("NimbusImage settings");
  });
});

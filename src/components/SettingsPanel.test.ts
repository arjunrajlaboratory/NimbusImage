import { describe, it, expect, vi } from "vitest";
import { shallowMount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

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

Vue.use(Vuetify);
Vue.directive("description", {});

function mountComponent() {
  return shallowMount(SettingsPanel, {
    vuetify: new Vuetify(),
  });
}

describe("SettingsPanel", () => {
  it("renders with default expanded panels [0,1,2,3]", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.panels).toEqual([0, 1, 2, 3]);
  });

  it("renders NimbusImage settings title", () => {
    const wrapper = mountComponent();
    expect(wrapper.text()).toContain("NimbusImage settings");
  });
});

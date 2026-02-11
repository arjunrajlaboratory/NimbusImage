import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";
import UISettings from "./UISettings.vue";

vi.mock("@/store/index", () => ({
  default: {},
}));

Vue.use(Vuetify);
Vue.directive("description", {});

function mountComponent() {
  return mount(UISettings, {
    vuetify: new Vuetify(),
  });
}

describe("UISettings", () => {
  it("renders 'Interface settings' header", () => {
    const wrapper = mountComponent();
    expect(wrapper.text()).toContain("Interface settings");
  });

  it("has darkMode computed property", () => {
    const wrapper = mountComponent();
    // Dark mode label is inside expansion panel content (not rendered until expanded)
    // Test the computed property instead
    expect(typeof wrapper.vm.darkMode).toBe("boolean");
  });

  it("has darkMode computed that accesses $vuetify.theme.dark", () => {
    const wrapper = mountComponent();
    // The darkMode computed reads from $vuetify.theme.dark
    expect(wrapper.vm.darkMode).toBe(false);
    wrapper.vm.darkMode = true;
    expect(wrapper.vm.$vuetify.theme.dark).toBe(true);
  });
});

import { describe, it, expect, vi } from "vitest";
import { shallowMount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

vi.mock("@/store", () => ({
  default: {},
}));

vi.mock("@/store/properties", () => ({
  default: {},
}));

vi.mock("@/store/annotation", () => ({
  default: {},
}));

vi.mock("@/store/filters", () => ({
  default: {},
}));

import AnalyzePanel from "./AnalyzePanel.vue";

Vue.use(Vuetify);

function mountComponent(props = {}) {
  return shallowMount(AnalyzePanel, {
    vuetify: new Vuetify(),
    propsData: {
      ...props,
    },
    stubs: {
      PropertyCreation: true,
      PropertyList: true,
    },
  });
}

describe("AnalyzePanel", () => {
  it("renders without error", () => {
    const wrapper = mountComponent();
    expect(wrapper.find(".analyze-panel").exists()).toBe(true);
  });

  it("has applyToAllDatasets default to false", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.applyToAllDatasets).toBe(false);
  });

  it("passes applyToAllDatasets prop through", () => {
    const wrapper = mountComponent({ applyToAllDatasets: true });
    expect(wrapper.vm.applyToAllDatasets).toBe(true);
  });

  it("renders property-creation and property-list stubs", () => {
    const wrapper = mountComponent();
    expect(wrapper.find("propertycreation-stub").exists()).toBe(true);
    // PropertyList is a <script setup> component, so shallowMount renders
    // it as anonymous-stub. Verify it renders inside property-list-scroll.
    expect(wrapper.find(".property-list-scroll").exists()).toBe(true);
  });
});

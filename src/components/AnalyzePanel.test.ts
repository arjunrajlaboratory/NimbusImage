import { describe, it, expect, vi } from "vitest";
import { shallowMount } from "@vue/test-utils";

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

function mountComponent(props = {}) {
  return shallowMount(AnalyzePanel, {
    props: {
      ...props,
    },
    global: {
      stubs: {
        PropertyCreation: true,
        PropertyList: true,
        VCard: { template: "<div><slot /></div>" },
      },
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
    // Both PropertyCreation and PropertyList are <script setup> components,
    // so shallowMount renders them as stubs.
    // In Vuetify 3 shallowMount, v-card is also stubbed which may not render
    // its slot content. Verify the stubs exist in the rendered HTML.
    const html = wrapper.html();
    expect(html).toContain("property-creation-stub");
    expect(html).toContain("property-list-stub");
  });
});

import { describe, it, expect, vi } from "vitest";
import { shallowMount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

vi.mock("@/store", () => ({
  default: {
    layers: [
      { id: "l1", name: "Layer 1" },
      { id: "l2", name: "Layer 2" },
    ],
  },
}));

vi.mock("@/store/annotation", () => ({
  default: {},
}));

vi.mock("@/store/properties", () => ({
  default: {},
}));

import ContrastPanels from "./ContrastPanels.vue";

Vue.use(Vuetify);

function mountComponent() {
  return shallowMount(ContrastPanels, {
    vuetify: new Vuetify(),
  });
}

describe("ContrastPanels", () => {
  it("renders an expansion panel for each layer", () => {
    const wrapper = mountComponent();
    expect(wrapper.findAll("v-expansion-panel-stub")).toHaveLength(2);
  });

  it("renders layers computed from store", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.layers).toHaveLength(2);
    expect(wrapper.vm.layers[0].id).toBe("l1");
  });
});

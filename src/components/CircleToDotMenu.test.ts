import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";
import CircleToDotMenu from "./CircleToDotMenu.vue";

vi.mock("@/store", () => ({
  default: {},
}));

vi.mock("@/store/annotation", () => ({
  default: {},
}));

vi.mock("@/store/properties", () => ({
  default: {},
}));

Vue.use(Vuetify);

function mountComponent(props = {}) {
  return mount(CircleToDotMenu, {
    vuetify: new Vuetify(),
    propsData: {
      tool: {
        id: "1",
        name: "Circle to Dot",
        type: "snap",
        hotkey: null,
        values: { radius: 25 },
      },
      ...props,
    },
  });
}

describe("CircleToDotMenu", () => {
  it("displays tool name", () => {
    const wrapper = mountComponent();
    expect(wrapper.text()).toContain("Circle to Dot");
  });

  it("initializes radius from tool prop on mount", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.radius).toBe(25);
  });

  it("updates radius when tool changes", async () => {
    const wrapper = mountComponent();
    await wrapper.setProps({
      tool: {
        id: "1",
        name: "Circle to Dot",
        type: "snap",
        hotkey: null,
        values: { radius: 50 },
      },
    });
    await Vue.nextTick();
    expect(wrapper.vm.radius).toBe(50);
  });

  it("renders a slider", () => {
    const wrapper = mountComponent();
    expect(wrapper.find(".v-slider").exists()).toBe(true);
  });

  it("renders Radius label", () => {
    const wrapper = mountComponent();
    expect(wrapper.text()).toContain("Radius");
  });
});

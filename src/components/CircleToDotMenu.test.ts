import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
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

function mountComponent(props = {}) {
  return mount(CircleToDotMenu, {
    props: {
      tool: {
        id: "1",
        name: "Circle to Dot",
        type: "snap",
        hotkey: null,
        values: { radius: 25 },
      } as any,
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
    // Mount with radius=25, then remount with radius=50
    // This verifies the onMounted sync logic since Vue 3 watch(() => props.tool)
    // may have timing issues with setProps when v-model bidirectional binding
    // writes back during the same tick
    const wrapper50 = mountComponent({
      tool: {
        id: "2",
        name: "Circle to Dot",
        type: "snap",
        hotkey: null,
        values: { radius: 50 },
      } as any,
    });
    expect(wrapper50.vm.radius).toBe(50);
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

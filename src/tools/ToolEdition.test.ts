import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

vi.mock("@/store", () => ({
  default: {
    editToolInConfiguration: vi.fn(),
    removeToolFromConfiguration: vi.fn(),
  },
}));

import store from "@/store";
import ToolEdition from "./ToolEdition.vue";

Vue.use(Vuetify);

const baseTool = {
  id: "tool-1",
  name: "Test Tool",
  hotkey: "t",
  type: "create" as const,
  template: { name: "test" },
  values: { foo: "bar" },
};

function mountComponent(props = {}) {
  return mount(ToolEdition, {
    vuetify: new Vuetify(),
    propsData: {
      tool: baseTool,
      ...props,
    },
    stubs: {
      ToolConfiguration: {
        template: "<div></div>",
        methods: { reset: vi.fn() },
      },
      HotkeySelection: true,
    },
  });
}

describe("ToolEdition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reset syncs name and hotkey from prop", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.toolName).toBe("Test Tool");
    expect(wrapper.vm.toolHotkey).toBe("t");
  });

  it("submit calls store.editToolInConfiguration and emits close", () => {
    const wrapper = mountComponent();
    wrapper.vm.toolName = "Updated Tool";
    wrapper.vm.toolHotkey = "u";
    wrapper.vm.toolValues = { baz: "qux" };
    wrapper.vm.submit();
    expect(store.editToolInConfiguration).toHaveBeenCalledWith({
      ...baseTool,
      name: "Updated Tool",
      hotkey: "u",
      values: { baz: "qux" },
    });
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("cancel calls reset and emits close", () => {
    const wrapper = mountComponent();
    wrapper.vm.toolName = "Changed Name";
    wrapper.vm.cancel();
    expect(wrapper.vm.toolName).toBe("Test Tool");
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("removeTool calls store.removeToolFromConfiguration", () => {
    const wrapper = mountComponent();
    wrapper.vm.removeTool();
    expect(store.removeToolFromConfiguration).toHaveBeenCalledWith("tool-1");
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("watch on tool triggers reset", async () => {
    const wrapper = mountComponent();
    wrapper.vm.toolName = "Changed";
    await wrapper.setProps({
      tool: { ...baseTool, name: "New Name", hotkey: "n" },
    });
    expect(wrapper.vm.toolName).toBe("New Name");
    expect(wrapper.vm.toolHotkey).toBe("n");
  });
});

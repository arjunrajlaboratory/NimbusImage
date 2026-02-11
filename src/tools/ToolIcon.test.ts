import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";
import ToolIcon from "./ToolIcon.vue";

Vue.use(Vuetify);

function mountComponent(props = {}) {
  return mount(ToolIcon, {
    vuetify: new Vuetify(),
    propsData: props,
  });
}

describe("ToolIcon", () => {
  it("renders no icon when tool is undefined", () => {
    const wrapper = mountComponent();
    expect(wrapper.find(".v-icon").exists()).toBe(false);
  });

  it("returns correct iconName for snap tool", () => {
    const wrapper = mountComponent({
      tool: { type: "snap", values: {}, name: "Snap", id: "1", hotkey: null },
    });
    expect(wrapper.vm.iconName).toBe("mdi-arrow-collapse-vertical");
  });

  it("returns correct iconName for create + point", () => {
    const wrapper = mountComponent({
      tool: {
        type: "create",
        values: { annotation: { shape: "point" } },
        name: "Point",
        id: "2",
        hotkey: null,
      },
    });
    expect(wrapper.vm.iconName).toBe("mdi-dots-hexagon");
  });

  it("returns correct iconName for create + polygon", () => {
    const wrapper = mountComponent({
      tool: {
        type: "create",
        values: { annotation: { shape: "polygon" } },
        name: "Polygon",
        id: "3",
        hotkey: null,
      },
    });
    expect(wrapper.vm.iconName).toBe("mdi-vector-polygon");
  });

  it("returns correct iconName for create + line", () => {
    const wrapper = mountComponent({
      tool: {
        type: "create",
        values: { annotation: { shape: "line" } },
        name: "Line",
        id: "4",
        hotkey: null,
      },
    });
    expect(wrapper.vm.iconName).toBe("mdi-chart-timeline-variant");
  });

  it("returns correct iconName for connection tool", () => {
    const wrapper = mountComponent({
      tool: {
        type: "connection",
        values: {},
        name: "Connection",
        id: "5",
        hotkey: null,
      },
    });
    expect(wrapper.vm.iconName).toBe("mdi-vector-line");
  });

  it("returns correct iconName for select tool", () => {
    const wrapper = mountComponent({
      tool: {
        type: "select",
        values: {},
        name: "Select",
        id: "6",
        hotkey: null,
      },
    });
    expect(wrapper.vm.iconName).toBe("mdi-select-drag");
  });

  it("returns correct iconName for edit tool", () => {
    const wrapper = mountComponent({
      tool: {
        type: "edit",
        values: {},
        name: "Edit",
        id: "7",
        hotkey: null,
      },
    });
    expect(wrapper.vm.iconName).toBe("mdi-vector-polygon");
  });

  it("falls back to type icon when create has no shape", () => {
    const wrapper = mountComponent({
      tool: {
        type: "create",
        values: {},
        name: "Create",
        id: "8",
        hotkey: null,
      },
    });
    expect(wrapper.vm.iconName).toBe("mdi-shape-plus");
  });
});

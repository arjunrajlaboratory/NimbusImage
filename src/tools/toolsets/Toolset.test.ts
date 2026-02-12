import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

vi.mock("@/store", () => ({
  default: {
    selectedTool: null,
    tools: [],
    configuration: { tools: [] },
    isLoggedIn: true,
    setSelectedToolId: vi.fn(),
    getLayerFromId: vi.fn(),
  },
}));

vi.mock("@/store/annotation", () => ({ default: {} }));
vi.mock("@/store/properties", () => ({ default: {} }));

vi.mock("vuedraggable", () => ({
  default: { name: "draggable", template: "<div><slot /></div>" },
}));

import store from "@/store";
import Toolset from "./Toolset.vue";

Vue.use(Vuetify);
Vue.directive("tour-trigger", {});

function mountComponent() {
  return mount(Toolset, {
    vuetify: new Vuetify(),
    stubs: {
      ToolCreation: true,
      ToolTypeSelection: true,
      ToolItem: true,
      AnnotationWorkerMenu: true,
      SamToolMenu: true,
      CircleToDotMenu: true,
    },
  });
}

describe("Toolset", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (store as any).selectedTool = null;
    (store as any).tools = [];
    (store as any).configuration = { tools: [] };
    (store as any).isLoggedIn = true;
  });

  it("toolsetTools returns tools from configuration", () => {
    const mockTools = [
      {
        id: "t1",
        name: "Tool 1",
        type: "create",
        values: {},
        hotkey: null,
        template: { name: "t" },
      },
      {
        id: "t2",
        name: "Tool 2",
        type: "snap",
        values: {},
        hotkey: null,
        template: { name: "t" },
      },
    ];
    (store as any).configuration = { tools: mockTools };
    const wrapper = mountComponent();
    expect((wrapper.vm as any).toolsetTools).toEqual(mockTools);
  });

  it("toolsetTools returns empty array when configuration is null", () => {
    (store as any).configuration = null;
    const wrapper = mountComponent();
    expect((wrapper.vm as any).toolsetTools).toEqual([]);
  });

  it("getToolPropertiesDescription builds correct descriptions for basic tool", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    const tool = {
      id: "t1",
      name: "My Tool",
      type: "create",
      values: {},
      hotkey: null,
      template: { name: "create" },
    };

    const result = vm.getToolPropertiesDescription(tool);
    expect(result).toEqual([["Name", "My Tool"]]);
  });

  it("getToolPropertiesDescription includes shape and tags from annotation values", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    const tool = {
      id: "t1",
      name: "Annotator",
      type: "create",
      values: {
        annotation: {
          shape: "point",
          tags: ["cell", "nucleus"],
        },
      },
      hotkey: "a",
      template: { name: "create" },
    };

    const result = vm.getToolPropertiesDescription(tool);
    expect(result).toEqual([
      ["Name", "Annotator"],
      ["Shape", "Point"],
      ["Tag(s)", "cell, nucleus"],
      ["Hotkey", "a"],
    ]);
  });

  it("getToolPropertiesDescription includes selection type", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    const tool = {
      id: "t1",
      name: "Selector",
      type: "select",
      values: {
        selectionType: { text: "Rectangle" },
      },
      hotkey: null,
      template: { name: "select" },
    };

    const result = vm.getToolPropertiesDescription(tool);
    expect(result).toEqual([
      ["Name", "Selector"],
      ["Selection type", "Rectangle"],
    ]);
  });

  it("getToolPropertiesDescription includes connectTo tags and layer", () => {
    const mockLayer = { name: "Layer A" };
    (store.getLayerFromId as any).mockReturnValue(mockLayer);

    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    const tool = {
      id: "t1",
      name: "Connector",
      type: "connection",
      values: {
        connectTo: {
          tags: ["tag1", "tag2"],
          layer: "layer-1",
        },
      },
      hotkey: null,
      template: { name: "connection" },
    };

    const result = vm.getToolPropertiesDescription(tool);
    expect(result).toEqual([
      ["Name", "Connector"],
      ["Connect to tags", "tag1, tag2"],
      ["Connect only on layer", "Layer A"],
    ]);
    expect(store.getLayerFromId).toHaveBeenCalledWith("layer-1");
  });

  it("handleToolTypeSelected opens creation dialog and closes type dialog", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    const toolType = { name: "create", type: "create" };
    vm.handleToolTypeSelected(toolType);

    expect(vm.selectedToolType).toEqual(toolType);
    expect(vm.toolTypeDialogOpen).toBe(false);
    expect(vm.toolCreationDialogOpen).toBe(true);
  });

  it("onToolCreationDone closes dialog and clears selectedToolType", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    vm.toolCreationDialogOpen = true;
    vm.selectedToolType = { name: "create" };

    vm.onToolCreationDone();

    expect(vm.toolCreationDialogOpen).toBe(false);
    expect(vm.selectedToolType).toBeNull();
  });

  it("onToolCreationDialogInput clears selectedToolType when dialog closes", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    vm.selectedToolType = { name: "create" };
    vm.onToolCreationDialogInput(false);

    expect(vm.toolCreationDialogOpen).toBe(false);
    expect(vm.selectedToolType).toBeNull();
  });

  it("onToolCreationDialogInput keeps selectedToolType when dialog opens", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    const toolType = { name: "create" };
    vm.selectedToolType = toolType;
    vm.onToolCreationDialogInput(true);

    expect(vm.toolCreationDialogOpen).toBe(true);
    expect(vm.selectedToolType).toEqual(toolType);
  });

  it("selectedToolId getter returns id from store selectedTool", () => {
    (store as any).selectedTool = { configuration: { id: "tool-abc" } };
    const wrapper = mountComponent();
    expect((wrapper.vm as any).selectedToolId).toBe("tool-abc");
  });

  it("selectedToolId getter returns null when no selected tool", () => {
    (store as any).selectedTool = null;
    const wrapper = mountComponent();
    expect((wrapper.vm as any).selectedToolId).toBeNull();
  });

  it("selectedToolId setter calls store.setSelectedToolId", () => {
    const wrapper = mountComponent();
    (wrapper.vm as any).selectedToolId = "tool-xyz";
    expect(store.setSelectedToolId).toHaveBeenCalledWith("tool-xyz");
  });

  it("isLoggedIn reflects store state", () => {
    (store as any).isLoggedIn = false;
    const wrapper = mountComponent();
    expect((wrapper.vm as any).isLoggedIn).toBe(false);
  });
});

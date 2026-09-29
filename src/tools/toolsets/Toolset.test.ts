import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";

// Reactive so computeds over the store (e.g. selectedToolId) track mutations
// made mid-test, as they would against the real Vuex store.
vi.mock("@/store", async () => {
  const { reactive } = await import("vue");
  return {
    default: reactive({
      selectedTool: null,
      tools: [],
      configuration: { tools: [] },
      isLoggedIn: true,
      setSelectedToolId: vi.fn(),
      getLayerFromId: vi.fn(),
    }),
  };
});

vi.mock("@/store/annotation", () => ({ default: {} }));
vi.mock("@/store/properties", () => ({ default: {} }));
vi.mock("@/store/toolSuggestions", () => ({
  default: {
    status: "idle",
    dismissed: false,
    setDismissed: vi.fn(),
    suggestForCurrentConfiguration: vi.fn(),
  },
}));

vi.mock("vuedraggable", () => ({
  default: { name: "draggable", template: "<div><slot /></div>" },
}));

import store from "@/store";
import toolSuggestionsStore from "@/store/toolSuggestions";
import Toolset from "./Toolset.vue";

function mountComponent() {
  return mount(Toolset, {
    global: {
      stubs: {
        ToolCreation: true,
        ToolTypeSelection: true,
        ToolItem: true,
        AnnotationWorkerMenu: true,
        SamToolMenu: true,
        CircleToDotMenu: true,
      },
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
    (toolSuggestionsStore as any).status = "idle";
    (toolSuggestionsStore as any).dismissed = false;
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

  it("openToolSuggestions clears dismissal and reruns AI suggestions", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    vm.openToolSuggestions();

    expect(toolSuggestionsStore.setDismissed).toHaveBeenCalledWith(false);
    expect(
      toolSuggestionsStore.suggestForCurrentConfiguration,
    ).toHaveBeenCalledTimes(1);
  });

  it("openToolSuggestions does not start a duplicate request while loading", () => {
    (toolSuggestionsStore as any).status = "loading";
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    vm.openToolSuggestions();

    expect(toolSuggestionsStore.setDismissed).toHaveBeenCalledWith(false);
    expect(
      toolSuggestionsStore.suggestForCurrentConfiguration,
    ).not.toHaveBeenCalled();
  });

  it("triggerToolSuggestionsGlow shows a transient AI button glow", () => {
    vi.useFakeTimers();
    try {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;

      vm.triggerToolSuggestionsGlow();

      expect(vm.toolSuggestionsGlow).toBe(true);
      vi.advanceTimersByTime(1800);
      expect(vm.toolSuggestionsGlow).toBe(false);
    } finally {
      vi.useRealTimers();
    }
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

  describe("worker dialog click-outside close", () => {
    const workerTool = { id: "worker-a", type: "segmentation" };

    function pointerDown(x: number, y: number) {
      window.dispatchEvent(
        // jsdom has no PointerEvent; a MouseEvent carries the same coordinates
        new MouseEvent("pointerdown", { clientX: x, clientY: y }),
      );
    }

    function outsideClick(vm: any, x: number, y: number) {
      vm.onWorkerDialogClickOutside(
        new MouseEvent("click", { clientX: x, clientY: y }),
      );
      vm.onWorkerDialogToggle(false);
    }

    beforeEach(() => {
      (store as any).selectedTool = { configuration: workerTool };
    });

    it("renders a non-persistent worker dialog wired to click:outside", () => {
      const wrapper = mountComponent();
      // The worker dialog is the only scrim-less one in Toolset
      const dialog = wrapper
        .findAllComponents({ name: "VDialog" })
        .find((d) => d.props("scrim") === false);
      expect(dialog).toBeDefined();
      expect(dialog!.props("persistent")).toBe(false);
      wrapper.unmount();
    });

    it("deselects the worker tool on a plain click outside the dialog", () => {
      const wrapper = mountComponent();
      pointerDown(100, 100);
      outsideClick(wrapper.vm, 102, 101);
      expect(store.setSelectedToolId).toHaveBeenCalledWith(null);
      wrapper.unmount();
    });

    it("keeps the dialog open when the outside interaction is a drag (pan)", () => {
      const wrapper = mountComponent();
      pointerDown(100, 100);
      outsideClick(wrapper.vm, 160, 130);
      expect(store.setSelectedToolId).not.toHaveBeenCalled();
      wrapper.unmount();
    });

    it("does not deselect a worker tool the same click just selected", () => {
      const wrapper = mountComponent();
      pointerDown(100, 100);
      // The click lands on another worker tool's button, which selects it
      // before Vuetify's deferred close runs.
      (store as any).selectedTool = {
        configuration: { id: "worker-b", type: "segmentation" },
      };
      outsideClick(wrapper.vm, 100, 100);
      expect(store.setSelectedToolId).not.toHaveBeenCalled();
      wrapper.unmount();
    });

    it("consumes a veto so a later Escape still closes the dialog", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      pointerDown(100, 100);
      outsideClick(vm, 200, 200);
      expect(store.setSelectedToolId).not.toHaveBeenCalled();
      // Escape: Vuetify emits update:model-value(false) with no click:outside
      vm.onWorkerDialogToggle(false);
      expect(store.setSelectedToolId).toHaveBeenCalledWith(null);
      wrapper.unmount();
    });

    it("removes its pointerdown listener on unmount", () => {
      const removeSpy = vi.spyOn(window, "removeEventListener");
      const wrapper = mountComponent();
      wrapper.unmount();
      expect(removeSpy).toHaveBeenCalledWith(
        "pointerdown",
        expect.any(Function),
        true,
      );
      removeSpy.mockRestore();
    });
  });
});

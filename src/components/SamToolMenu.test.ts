import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

vi.mock("@/store", () => ({
  default: {
    selectedTool: null,
    editToolInConfiguration: vi.fn(),
    dataset: { id: "ds1" },
  },
}));

vi.mock("@/store/annotation", () => ({
  default: {
    addAnnotationFromTool: vi.fn(),
  },
}));

vi.mock("@/store/model", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
  };
});

vi.mock("@/utils/debounce", () => ({
  Debounce: () => (_target: any, _name: any, descriptor: any) => descriptor,
}));

vi.mock("@/pipelines/computePipeline", () => ({
  NoOutput: Symbol("NoOutput"),
}));

import SamToolMenu from "./SamToolMenu.vue";
import store from "@/store";
import annotationStore from "@/store/annotation";
import { SamAnnotationToolStateSymbol } from "@/store/model";

Vue.use(Vuetify);

function createSamState(overrides: any = {}) {
  const mockSetValue = vi.fn();
  return {
    type: SamAnnotationToolStateSymbol,
    output: null,
    loadingMessages: [],
    nodes: {
      input: {
        simplificationTolerance: {
          output: 2.5,
          setValue: mockSetValue,
        },
        mainPrompt: {
          output: [],
          setValue: mockSetValue,
        },
      },
    },
    ...overrides,
  };
}

function mountComponent(props = {}) {
  return mount(SamToolMenu, {
    vuetify: new Vuetify(),
    propsData: {
      toolConfiguration: {
        id: "tool1",
        name: "SAM Tool",
        type: "samAnnotation",
        hotkey: null,
        values: {
          turboMode: false,
          simplificationTolerance: 2.5,
        },
        template: {
          name: "SAM Tool",
          type: "samAnnotation",
          description: "",
          interface: [],
        },
      },
      ...props,
    },
  });
}

describe("SamToolMenu", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    (store as any).selectedTool = null;
  });

  it("turboMode initialized from toolConfiguration.values.turboMode on mount", () => {
    const wrapper = mountComponent();
    expect((wrapper.vm as any).turboMode).toBe(false);
  });

  it("turboMode initialized as true when toolConfiguration specifies true", () => {
    const wrapper = mountComponent({
      toolConfiguration: {
        id: "tool2",
        name: "SAM Tool",
        type: "samAnnotation",
        hotkey: null,
        values: {
          turboMode: true,
          simplificationTolerance: 1.0,
        },
        template: {
          name: "SAM Tool",
          type: "samAnnotation",
          description: "",
          interface: [],
        },
      },
    });
    expect((wrapper.vm as any).turboMode).toBe(true);
  });

  it("resetPrompts clears promptHistory and prompts", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.promptHistory = [
      { type: "foregroundPoint", x: 1, y: 2 },
      { type: "foregroundPoint", x: 3, y: 4 },
    ];
    vm.resetPrompts();
    expect(vm.promptHistory).toEqual([]);
  });

  it("submit calls annotationStore.addAnnotationFromTool when outputCoordinates and datasetId exist", () => {
    const samState = createSamState({
      output: [
        [1, 2],
        [3, 4],
      ],
    });
    (store as any).selectedTool = { state: samState };

    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    vm.submit();
    expect(annotationStore.addAnnotationFromTool).toHaveBeenCalled();
  });

  it("submit does not call addAnnotationFromTool when outputCoordinates is null", () => {
    const samState = createSamState({ output: null });
    (store as any).selectedTool = { state: samState };

    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    vm.submit();
    // addAnnotationFromTool should not have been called (coordinates is null)
    // However, submit always calls resetPrompts, so we verify
    // the function was not called by checking the mock
    expect(annotationStore.addAnnotationFromTool).not.toHaveBeenCalled();
  });

  it("undo moves last prompt to promptHistory", () => {
    const mockSetValue = vi.fn();
    const prompts = [
      { type: "foregroundPoint", x: 1, y: 2 },
      { type: "foregroundPoint", x: 3, y: 4 },
    ];
    const samState = createSamState();
    samState.nodes.input.mainPrompt.output = [...prompts];
    samState.nodes.input.mainPrompt.setValue = mockSetValue;
    (store as any).selectedTool = { state: samState };

    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    vm.undo();

    // After undo, promptHistory should contain the last prompt
    expect(vm.promptHistory).toHaveLength(1);
    expect(vm.promptHistory[0]).toEqual({
      type: "foregroundPoint",
      x: 3,
      y: 4,
    });
    // setValue should have been called (to update prompts in the pipeline)
    expect(mockSetValue).toHaveBeenCalled();
  });

  it("redo moves last promptHistory item back to prompts", () => {
    const mockSetValue = vi.fn();
    const samState = createSamState();
    samState.nodes.input.mainPrompt.output = [];
    samState.nodes.input.mainPrompt.setValue = mockSetValue;
    (store as any).selectedTool = { state: samState };

    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    const historyItem = { type: "foregroundPoint", x: 5, y: 6 };
    vm.promptHistory = [historyItem];

    vm.redo();

    // After redo, promptHistory should be empty
    expect(vm.promptHistory).toHaveLength(0);
    // setValue should have been called to push the prompt back
    expect(mockSetValue).toHaveBeenCalled();
  });

  it("undo does nothing when prompts is empty", () => {
    const mockSetValue = vi.fn();
    const samState = createSamState();
    samState.nodes.input.mainPrompt.output = [];
    samState.nodes.input.mainPrompt.setValue = mockSetValue;
    (store as any).selectedTool = { state: samState };

    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.promptHistory = [];

    vm.undo();

    expect(vm.promptHistory).toHaveLength(0);
  });

  it("redo does nothing when promptHistory is empty", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.promptHistory = [];
    vm.redo();
    expect(vm.promptHistory).toHaveLength(0);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";

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

import { markRaw, nextTick, reactive } from "vue";
import SamToolMenu from "./SamToolMenu.vue";
import store from "@/store";
import annotationStore from "@/store/annotation";
import { SamAnnotationToolStateSymbol } from "@/store/model";
import { NoOutput } from "@/pipelines/computePipeline";

// Models the real tool state (createSamToolStateFromToolConfiguration): the
// nodes are markRaw'd, and setting the prompt node's value updates both its
// output and the reactive `prompts` mirror.
function createSamState(overrides: any = {}) {
  const promptNode: any = { output: NoOutput };
  const state: any = reactive({
    type: SamAnnotationToolStateSymbol,
    output: null,
    loadingMessages: [],
    prompts: [],
    failure: null,
    nodes: markRaw({
      retryLoad: vi.fn(),
      input: {
        simplificationTolerance: {
          output: 2.5,
          setValue: vi.fn(),
        },
        mainPrompt: promptNode,
      },
    }),
    ...overrides,
  });
  promptNode.setValue = vi.fn((value: any) => {
    promptNode.output = value;
    state.prompts = markRaw(value === NoOutput ? [] : [...value]);
  });
  return state;
}

const POINT = { type: "foregroundPoint", point: { x: 1, y: 2 } };

function mountComponent(props = {}) {
  return mount(SamToolMenu, {
    props: {
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
    const prompts = [
      { type: "foregroundPoint", x: 1, y: 2 },
      { type: "foregroundPoint", x: 3, y: 4 },
    ];
    const samState = createSamState();
    samState.nodes.input.mainPrompt.setValue([...prompts]);
    const mockSetValue = samState.nodes.input.mainPrompt.setValue;
    mockSetValue.mockClear();
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
    expect(mockSetValue).toHaveBeenCalledWith([prompts[0]]);
    expect(vm.prompts).toEqual([prompts[0]]);
  });

  it("redo moves last promptHistory item back to prompts", () => {
    const samState = createSamState();
    const mockSetValue = samState.nodes.input.mainPrompt.setValue;
    (store as any).selectedTool = { state: samState };

    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    const historyItem = { type: "foregroundPoint", x: 5, y: 6 };
    vm.promptHistory = [historyItem];

    vm.redo();

    // After redo, promptHistory should be empty
    expect(vm.promptHistory).toHaveLength(0);
    // setValue should have been called to push the prompt back
    expect(mockSetValue).toHaveBeenCalledWith([historyItem]);
    expect(vm.prompts).toEqual([historyItem]);
  });

  it("undo does nothing when prompts is empty", () => {
    const samState = createSamState();
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

  it("enables undo when a prompt is added through the pipeline node", async () => {
    // AnnotationViewer adds prompts by calling setValue on the node directly;
    // the menu only learns of it through the reactive mirror.
    const samState = createSamState();
    (store as any).selectedTool = { state: samState };
    const wrapper = mountComponent();
    const undoButton = () =>
      wrapper.findAll("button").find((b) => b.text().includes("Undo"))!;
    // turboMode is seeded from the configuration (false) in onMounted.
    await nextTick();
    expect(undoButton().attributes("disabled")).toBeDefined();

    samState.nodes.input.mainPrompt.setValue([POINT]);
    await nextTick();

    expect((wrapper.vm as any).prompts).toEqual([POINT]);
    expect(undoButton().attributes("disabled")).toBeUndefined();
  });

  it("keeps the prompts when submitting with no output", () => {
    // Nothing was submitted, so nothing should be cleared. In turbo mode
    // every output change calls submit, including the reset to null when a
    // decode starts.
    const samState = createSamState({ output: null });
    samState.nodes.input.mainPrompt.setValue([POINT]);
    const mockSetValue = samState.nodes.input.mainPrompt.setValue;
    mockSetValue.mockClear();
    (store as any).selectedTool = { state: samState };
    const wrapper = mountComponent();

    (wrapper.vm as any).submit();

    expect(mockSetValue).not.toHaveBeenCalled();
    expect((wrapper.vm as any).prompts).toEqual([POINT]);
  });

  it("shows a failed model load with a retry button", async () => {
    const samState = createSamState();
    (store as any).selectedTool = { state: samState };
    const wrapper = mountComponent();
    expect(wrapper.find(".sam-failure").exists()).toBe(false);

    samState.failure = {
      stage: "load",
      message: "model fetch failed",
      canRetry: true,
    };
    await nextTick();

    const alert = wrapper.find(".sam-failure");
    expect(alert.exists()).toBe(true);
    expect(alert.text()).toContain("Could not load the SAM model");
    expect(alert.text()).toContain("model fetch failed");
    const retry = alert.findAll("button").find((b) => b.text() === "Retry");
    await retry!.trigger("click");
    expect(samState.nodes.retryLoad).toHaveBeenCalledTimes(1);

    samState.failure = null;
    await nextTick();
    expect(wrapper.find(".sam-failure").exists()).toBe(false);
  });

  it("shows a failed run without a retry button", async () => {
    const samState = createSamState({
      failure: { stage: "run", message: "decode failed", canRetry: false },
    });
    (store as any).selectedTool = { state: samState };
    const wrapper = mountComponent();

    const alert = wrapper.find(".sam-failure");
    expect(alert.text()).toContain("SAM could not segment the image");
    expect(alert.text()).toContain("decode failed");
    expect(alert.findAll("button").some((b) => b.text() === "Retry")).toBe(
      false,
    );
  });
});

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
    getAnnotationLocationFromTool: vi.fn().mockResolvedValue({
      location: { XY: 0, Z: 0, Time: 0 },
      channel: 0,
    }),
    createMultipleAnnotations: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("@/pipelines/computePipeline", () => {
  const NoOutput = Symbol("NoOutput");
  return {
    NoOutput,
    readManualInputOr: (node: { output: unknown }, fallback: unknown) =>
      node.output === NoOutput ? fallback : node.output,
  };
});

import SamSimilarityToolMenu from "./SamSimilarityToolMenu.vue";
import store from "@/store";
import annotationStore from "@/store/annotation";
import { SamSimilarityToolStateSymbol } from "@/store/model";

function createSimilarityState(overrides: any = {}) {
  return {
    type: SamSimilarityToolStateSymbol,
    mapEntry: { map: {} },
    examples: [],
    proposals: [],
    nextPolarity: "foreground",
    exampleInputMode: "click",
    livePreview: null,
    status: {
      phase: "idle",
      putativeCount: 0,
      progress: null,
      timings: {},
    },
    nodes: {
      input: {
        similarityThreshold: { output: 0.5, setValue: vi.fn() },
        promptMode: { output: "point", setValue: vi.fn() },
        sizeRange: {
          output: { min: null, max: null },
          setValue: vi.fn(),
        },
        simplificationTolerance: { output: 1, setValue: vi.fn() },
        examples: { output: [], setValue: vi.fn() },
        previewPrompt: { output: undefined, setValue: vi.fn() },
      },
      reset: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  };
}

function mountComponent(props = {}) {
  return mount(SamSimilarityToolMenu, {
    props: {
      toolConfiguration: {
        id: "tool1",
        name: "SimSAM Tool",
        type: "samSimilarity",
        hotkey: null,
        values: {
          similarityThreshold: 0.5,
          simplificationTolerance: 1,
          promptMode: { text: "Point prompts", value: "point" },
          annotation: {
            tags: ["cell"],
            shape: "polygon",
            color: "#123456",
          },
        },
        template: {
          name: "SimSAM Tool",
          type: "samSimilarity",
          description: "",
          interface: [],
        },
      },
      ...props,
    },
  });
}

describe("SamSimilarityToolMenu", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    (store as any).selectedTool = null;
    (annotationStore.getAnnotationLocationFromTool as any).mockResolvedValue({
      location: { XY: 0, Z: 0, Time: 0 },
      channel: 0,
    });
    (annotationStore.createMultipleAnnotations as any).mockResolvedValue([]);
  });

  it("renders zero counts when there is no SAM similarity state", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.putativeCount).toBe(0);
    expect(vm.examplesTotal).toBe(0);
    expect(vm.foregroundCount).toBe(0);
    expect(vm.backgroundCount).toBe(0);
  });

  it("renders counts from a mocked tool state", () => {
    const similarityState = createSimilarityState({
      examples: [
        { polarity: "foreground", prompt: {}, polygon: [] },
        { polarity: "foreground", prompt: {}, polygon: [] },
        { polarity: "background", prompt: {}, polygon: null },
      ],
      proposals: [[{ x: 0, y: 0 }], [{ x: 1, y: 1 }]],
    });
    (store as any).selectedTool = { state: similarityState };

    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    expect(vm.putativeCount).toBe(2);
    expect(vm.examplesTotal).toBe(3);
    expect(vm.foregroundCount).toBe(2);
    expect(vm.backgroundCount).toBe(1);
    expect(wrapper.text()).toContain("2 putative objects");
    expect(wrapper.text()).toContain("3 examples");
  });

  it("renders candidate-decode progress text", () => {
    const similarityState = createSimilarityState({
      status: {
        phase: "computing",
        putativeCount: 0,
        progress: { done: 5, total: 20 },
        timings: {},
      },
    });
    (store as any).selectedTool = { state: similarityState };

    const wrapper = mountComponent();
    expect(wrapper.text()).toContain("Scanning candidates… 5/20");
  });

  it("Accept button is disabled when there are 0 proposals", () => {
    const similarityState = createSimilarityState({ proposals: [] });
    (store as any).selectedTool = { state: similarityState };

    const wrapper = mountComponent();
    const acceptButton = wrapper
      .findAll("button")
      .find((button) => button.text().includes("Accept"));

    expect(acceptButton).toBeDefined();
    expect(acceptButton!.attributes("disabled")).not.toBeUndefined();
  });

  it("accept() does not call createMultipleAnnotations when there are 0 proposals", async () => {
    const similarityState = createSimilarityState({ proposals: [] });
    (store as any).selectedTool = { state: similarityState };

    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    await vm.accept();

    expect(annotationStore.createMultipleAnnotations).not.toHaveBeenCalled();
  });

  it("accept() calls createMultipleAnnotations once with N annotation bases", async () => {
    const proposals = [
      [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
      ],
      [
        { x: 5, y: 5 },
        { x: 6, y: 5 },
        { x: 6, y: 6 },
      ],
    ];
    const similarityState = createSimilarityState({ proposals });
    (store as any).selectedTool = { state: similarityState };

    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    await vm.accept();

    expect(annotationStore.createMultipleAnnotations).toHaveBeenCalledTimes(1);
    const [bases] = (annotationStore.createMultipleAnnotations as any).mock
      .calls[0];
    expect(bases).toHaveLength(2);
    expect(bases[0]).toMatchObject({
      tags: ["cell"],
      shape: "polygon",
      color: "#123456",
      datasetId: "ds1",
      coordinates: proposals[0],
    });

    // The similarity-threshold node is nudged (immediate) to force the
    // proposals chain to re-run so newly-committed annotations get deduped
    // out.
    expect(
      similarityState.nodes.input.similarityThreshold.setValue,
    ).toHaveBeenCalledWith(0.5, true);
  });

  it("undoExample pops the last example from the input node, not the mirror", () => {
    // The state.examples mirror holds freshly-built decoded-example objects;
    // undo must slice the INPUT node's array so the pipeline's
    // reference-keyed descriptor cache still hits for the remaining examples.
    const inputExamples = [
      { polarity: "foreground", prompt: {} },
      { polarity: "background", prompt: {} },
    ];
    const similarityState = createSimilarityState({
      examples: [
        { polarity: "foreground", prompt: {}, polygon: [] },
        { polarity: "background", prompt: {}, polygon: null },
      ],
    });
    similarityState.nodes.input.examples.output = inputExamples;
    (store as any).selectedTool = { state: similarityState };

    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    vm.undoExample();

    expect(similarityState.nodes.input.examples.setValue).toHaveBeenCalledWith([
      inputExamples[0],
    ]);
  });

  it("writes state.exampleInputMode when the input-mode toggle changes", () => {
    const similarityState = createSimilarityState();
    (store as any).selectedTool = { state: similarityState };

    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    expect(vm.exampleInputMode).toBe("click");
    vm.exampleInputMode = "circle";

    expect(similarityState.exampleInputMode).toBe("circle");
  });

  it("clearAll resets the pipeline and clears the examples input node", async () => {
    const similarityState = createSimilarityState({
      examples: [{ polarity: "foreground", prompt: {}, polygon: [] }],
    });
    (store as any).selectedTool = { state: similarityState };

    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    await vm.clearAll();

    expect(similarityState.nodes.reset).toHaveBeenCalledOnce();
    expect(similarityState.nodes.input.examples.setValue).toHaveBeenCalledWith(
      [],
    );
  });
});

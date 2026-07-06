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

vi.mock("@/pipelines/computePipeline", () => ({
  NoOutput: Symbol("NoOutput"),
}));

import ExampleSegmentationToolMenu from "./ExampleSegmentationToolMenu.vue";
import store from "@/store";
import annotationStore from "@/store/annotation";
import { ExampleSegmentationToolStateSymbol } from "@/store/model";

function createExampleState(overrides: any = {}) {
  return {
    type: ExampleSegmentationToolStateSymbol,
    mapEntry: { map: {} },
    examples: [],
    proposals: [],
    nextPolarity: "foreground",
    status: {
      phase: "idle",
      putativeCount: 0,
      timings: {},
    },
    nodes: {
      input: {
        threshold: { output: 0.5, setValue: vi.fn() },
        sizeRange: {
          output: { min: null, max: null },
          setValue: vi.fn(),
        },
        simplificationTolerance: { output: 1, setValue: vi.fn() },
        examples: { output: [], setValue: vi.fn() },
      },
      reset: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  };
}

function mountComponent(props = {}) {
  return mount(ExampleSegmentationToolMenu, {
    props: {
      toolConfiguration: {
        id: "tool1",
        name: "AutoSeg Tool",
        type: "exampleSegmentation",
        hotkey: null,
        values: {
          threshold: 0.5,
          simplificationTolerance: 1,
          annotation: {
            tags: ["cell"],
            shape: "polygon",
            color: "#123456",
          },
        },
        template: {
          name: "AutoSeg Tool",
          type: "exampleSegmentation",
          description: "",
          interface: [],
        },
      },
      ...props,
    },
  });
}

describe("ExampleSegmentationToolMenu", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    (store as any).selectedTool = null;
    (annotationStore.getAnnotationLocationFromTool as any).mockResolvedValue({
      location: { XY: 0, Z: 0, Time: 0 },
      channel: 0,
    });
    (annotationStore.createMultipleAnnotations as any).mockResolvedValue([]);
  });

  it("renders zero counts when there is no example segmentation state", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.putativeCount).toBe(0);
    expect(vm.examplesTotal).toBe(0);
    expect(vm.foregroundCount).toBe(0);
    expect(vm.backgroundCount).toBe(0);
  });

  it("renders counts from a mocked tool state", () => {
    const exampleState = createExampleState({
      examples: [
        { polarity: "foreground", coordinates: [] },
        { polarity: "foreground", coordinates: [] },
        { polarity: "background", coordinates: [] },
      ],
      proposals: [[{ x: 0, y: 0 }], [{ x: 1, y: 1 }]],
    });
    (store as any).selectedTool = { state: exampleState };

    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    expect(vm.putativeCount).toBe(2);
    expect(vm.examplesTotal).toBe(3);
    expect(vm.foregroundCount).toBe(2);
    expect(vm.backgroundCount).toBe(1);
    expect(wrapper.text()).toContain("2 putative objects");
    expect(wrapper.text()).toContain("3 examples");
  });

  it("Accept button is disabled when there are 0 proposals", () => {
    const exampleState = createExampleState({ proposals: [] });
    (store as any).selectedTool = { state: exampleState };

    const wrapper = mountComponent();
    const acceptButton = wrapper
      .findAll("button")
      .find((button) => button.text().includes("Accept"));

    expect(acceptButton).toBeDefined();
    expect(acceptButton!.attributes("disabled")).not.toBeUndefined();
  });

  it("accept() does not call createMultipleAnnotations when there are 0 proposals", async () => {
    const exampleState = createExampleState({ proposals: [] });
    (store as any).selectedTool = { state: exampleState };

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
    const exampleState = createExampleState({ proposals });
    (store as any).selectedTool = { state: exampleState };

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

    // The threshold node is nudged (immediate) to force the proposals chain
    // to re-run so newly-committed annotations get deduped out.
    expect(exampleState.nodes.input.threshold.setValue).toHaveBeenCalledWith(
      0.5,
      true,
    );
  });

  it("undoExample pops the last example and pushes a new array", () => {
    const examples = [
      { polarity: "foreground", coordinates: [] },
      { polarity: "background", coordinates: [] },
    ];
    const exampleState = createExampleState({ examples });
    (store as any).selectedTool = { state: exampleState };

    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    vm.undoExample();

    expect(exampleState.nodes.input.examples.setValue).toHaveBeenCalledWith([
      examples[0],
    ]);
  });

  it("clearAll resets the worker model and clears the examples input node", async () => {
    const exampleState = createExampleState({
      examples: [{ polarity: "foreground", coordinates: [] }],
    });
    (store as any).selectedTool = { state: exampleState };

    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    await vm.clearAll();

    expect(exampleState.nodes.reset).toHaveBeenCalledOnce();
    expect(exampleState.nodes.input.examples.setValue).toHaveBeenCalledWith([]);
  });
});

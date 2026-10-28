import { cloneDeep, omit } from "lodash";
import { shallowMount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  store: {
    tools: [] as any[],
    configuration: { propertyIds: [] as string[] },
  },
  pipelinesStore: {
    pipelines: [] as any[],
    getPipelineById: vi.fn(),
    savePipeline: vi.fn(),
    createStepId: vi.fn(),
    deleteUnreferencedMaterializedProperties: vi.fn(),
    loadMissingLinkedProperties: vi.fn(),
  },
  properties: {
    properties: [] as any[],
    // Which configuration's fetch filled `properties` (see properties.ts).
    propertiesConfigurationId: undefined as string | undefined,
    workerImageList: { "img/x": {} } as Record<string, any>,
    fetchWorkerImageList: vi.fn(),
  },
}));

// Reactive, so a tool changed "elsewhere" (a test reassigning h.store.tools)
// reaches the editor's computeds, as a real store change would.
vi.mock("@/store", async () => {
  const { reactive } = await import("vue");
  h.store = reactive(h.store);
  return { default: h.store };
});
vi.mock("@/store/pipelines", () => ({
  default: h.pipelinesStore,
  mergeMaterializedPropertyIds: vi.fn(),
}));
vi.mock("@/store/properties", () => ({ default: h.properties }));
vi.mock("@/store/annotation", () => ({
  default: { annotationTags: new Set<string>() },
}));
vi.mock("@/tools/creation/toolFromCatalog", () => ({
  buildDefaultCoordinateAssignments: () => ({
    layer: null,
    Z: { type: "layer", value: 1, max: 1 },
    Time: { type: "layer", value: 1, max: 1 },
  }),
}));
vi.mock("@/components/pipelines/usePipelineRun", () => ({
  PipelineRunControllerKey: Symbol("PipelineRunController"),
  stepStatusColor: () => "",
  stepStatusIcon: () => "",
}));
vi.mock("@/components/DockerImageSelect.vue", () => ({ default: {} }));
vi.mock("@/components/JobLogDialog.vue", () => ({ default: {} }));
vi.mock("@/components/pipelines/PipelineStepEditor.vue", () => ({
  default: {},
}));
vi.mock("@/utils/log", () => ({ logError: vi.fn() }));

import PipelineEditor from "./PipelineEditor.vue";
import { PipelineRunControllerKey } from "@/components/pipelines/usePipelineRun";
import { AnnotationShape, IPipeline } from "@/store/model";

function annotationSetup(tags: string[]): any {
  return {
    tags,
    shape: AnnotationShape.Polygon,
    color: undefined,
    coordinateAssignments: {
      layer: null,
      Z: { type: "layer", value: 1, max: 1 },
      Time: { type: "layer", value: 1, max: 1 },
    },
  };
}

function workerTool(id: string, threshold: number, tags: string[]): any {
  return {
    id,
    name: `Tool ${id}`,
    hotkey: null,
    type: "segmentation",
    template: { name: "t", type: "segmentation", interface: [] },
    values: {
      image: { image: "img/tool" },
      workerInterfaceValues: { threshold },
      annotation: annotationSetup(tags),
    },
  };
}

function linkedAnnotationStep(id: string, toolId: string, threshold = 1): any {
  return {
    id,
    kind: "annotation",
    name: id,
    image: "img/tool",
    workerInterfaceValues: { threshold },
    enabled: true,
    annotation: annotationSetup(["saved"]),
    sourceToolId: toolId,
  };
}

function propertyStep(id: string, extra: any = {}): any {
  return {
    id,
    kind: "property",
    name: id,
    image: "img/prop",
    workerInterfaceValues: {},
    enabled: true,
    shape: AnnotationShape.Polygon,
    inputTags: { tags: ["own"], exclusive: false },
    autoWired: true,
    ...extra,
  };
}

const controller = {
  isRunning: { value: false },
  continueOnError: { value: false },
  canApplyToAllDatasets: { value: false },
  batchDisabledReason: { value: null },
  applyToAllDatasets: { value: false },
  collectionDatasetCount: { value: 0 },
  batchProgress: { value: null },
  runNotice: { value: null },
  isRunningPipeline: () => false,
  canRunPipeline: () => true,
  statusesFor: () => [],
  jobIdFor: () => null,
  run: vi.fn(),
  cancel: vi.fn(),
};

function mountEditor(pipeline: IPipeline) {
  // Persisted, like the real store: getPipelineById returns what was last
  // saved (the editor's unsaved-changes baseline), and savePipeline replaces it.
  let stored = pipeline;
  h.pipelinesStore.getPipelineById.mockImplementation((id: string) =>
    id === stored.id ? stored : null,
  );
  h.pipelinesStore.savePipeline.mockImplementation(async (saved: IPipeline) => {
    stored = saved;
  });
  return shallowMount(PipelineEditor, {
    props: { pipeline },
    global: {
      provide: { [PipelineRunControllerKey as symbol]: controller },
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.store.tools = [];
  h.properties.properties = [];
  h.properties.propertiesConfigurationId = undefined;
  (h.store.configuration as any).id = undefined;
  h.pipelinesStore.pipelines = [];
  h.pipelinesStore.createStepId.mockReturnValue("new-step");
});

describe("PipelineEditor linked steps", () => {
  it("does not offer or show another configuration's properties while this one's are loading", () => {
    // Right after a switch, the loaded list is still the other
    // configuration's.
    (h.store.configuration as any).id = "config-a";
    h.properties.propertiesConfigurationId = "config-b";
    h.properties.properties = [
      {
        id: "elsewhere",
        name: "Elsewhere",
        image: "img/prop",
        shape: AnnotationShape.Polygon,
        tags: { tags: ["theirs"], exclusive: false },
        workerInterface: {},
      },
    ];
    const wrapper = mountEditor({
      id: "pipe",
      name: "P",
      steps: [propertyStep("p", { sourcePropertyId: "elsewhere" })],
    });
    const vm = wrapper.vm as any;

    expect(vm.linkableProperties).toEqual([]);
    // The step shows its saved copy, not the other configuration's values.
    expect(vm.displayedPipeline.steps[0].inputTags.tags).toEqual(["own"]);
  });

  it("shows a linked step with its tool's live values on open, without marking it dirty", () => {
    h.store.tools = [workerTool("t1", 5, ["from-tool"])];
    const wrapper = mountEditor({
      id: "pipe",
      name: "P",
      steps: [linkedAnnotationStep("a", "t1", 1)],
    });
    const vm = wrapper.vm as any;

    expect(vm.displayedPipeline.steps[0].workerInterfaceValues).toEqual({
      threshold: 5,
    });
    expect(vm.displayedPipeline.steps[0].annotation.tags).toEqual([
      "from-tool",
    ]);
    expect(vm.isDirty).toBe(false);
    expect(vm.linkStates[0]).toEqual({
      state: "linked",
      sourceKind: "tool",
      sourceName: "Tool t1",
    });
  });

  it("shows a tool change made elsewhere while the editor is open", () => {
    h.store.tools = [workerTool("t1", 5, ["original"])];
    const wrapper = mountEditor({
      id: "pipe",
      name: "P",
      steps: [linkedAnnotationStep("a", "t1")],
    });
    const vm = wrapper.vm as any;

    h.store.tools = [workerTool("t1", 42, ["changed-elsewhere"])];

    expect(vm.displayedPipeline.steps[0].workerInterfaceValues).toEqual({
      threshold: 42,
    });
    expect(vm.displayedPipeline.steps[0].annotation.tags).toEqual([
      "changed-elsewhere",
    ]);
    expect(vm.isDirty).toBe(false);
  });

  // A linked tool's output tags change while the editor is open, then the
  // step the property step reads from is removed or disabled.
  async function changeUpstreamAfterToolChange(change: "removed" | "disabled") {
    h.store.tools = [workerTool("t1", 5, ["original"])];
    const wrapper = mountEditor({
      id: "pipe",
      name: "P",
      steps: [linkedAnnotationStep("a", "t1"), propertyStep("p")],
    });
    const vm = wrapper.vm as any;
    // The linked tool's output tags change elsewhere; the property step
    // after it is shown wired to them.
    h.store.tools = [workerTool("t1", 5, ["changed-elsewhere"])];
    expect(vm.displayedPipeline.steps[1].inputTags.tags).toEqual([
      "changed-elsewhere",
    ]);

    if (change === "removed") {
      vm.removeStep(0);
    } else {
      vm.handleStepUpdate(0, {
        ...vm.displayedPipeline.steps[0],
        enabled: false,
      });
    }

    const property = vm.displayedPipeline.steps.find(
      (step: any) => step.id === "p",
    );
    expect(property.inputTags.tags).toEqual(["changed-elsewhere"]);
    await vm.save();
    const [saved] = h.pipelinesStore.savePipeline.mock.calls[0];
    expect(
      saved.steps.find((step: any) => step.id === "p").inputTags.tags,
    ).toEqual(["changed-elsewhere"]);
  }

  it("keeps the wiring last shown when the upstream step is removed", async () => {
    await changeUpstreamAfterToolChange("removed");
  });

  it("keeps the wiring last shown when the upstream step is disabled", async () => {
    await changeUpstreamAfterToolChange("disabled");
  });

  it("keeps an exclusive-match change on an auto-wired step", async () => {
    h.store.tools = [workerTool("t1", 5, ["wired"])];
    const wrapper = mountEditor({
      id: "pipe",
      name: "P",
      steps: [linkedAnnotationStep("a", "t1"), propertyStep("p")],
    });
    const vm = wrapper.vm as any;
    const shown = vm.displayedPipeline.steps[1];

    vm.handleStepUpdate(1, {
      ...shown,
      inputTags: { ...shown.inputTags, exclusive: true },
    });

    expect(vm.displayedPipeline.steps[1].inputTags).toEqual({
      tags: ["wired"],
      exclusive: true,
    });
    await vm.save();
    const [saved] = h.pipelinesStore.savePipeline.mock.calls[0];
    expect(saved.steps[1].inputTags.exclusive).toBe(true);
  });

  it("keeps only the name and enabled flag from an edit to a linked step", async () => {
    h.store.tools = [workerTool("t1", 5, ["t"])];
    const wrapper = mountEditor({
      id: "pipe",
      name: "P",
      steps: [linkedAnnotationStep("a", "t1")],
    });
    const vm = wrapper.vm as any;

    vm.handleStepUpdate(0, {
      ...vm.displayedPipeline.steps[0],
      name: "Renamed step",
      workerInterfaceValues: { threshold: 9 },
    });

    expect(vm.displayedPipeline.steps[0].name).toBe("Renamed step");
    expect(vm.displayedPipeline.steps[0].workerInterfaceValues).toEqual({
      threshold: 5,
    });
    await vm.save();
    const [saved] = h.pipelinesStore.savePipeline.mock.calls[0];
    expect(saved.steps[0]).toMatchObject({
      name: "Renamed step",
      workerInterfaceValues: { threshold: 5 },
      sourceToolId: "t1",
    });
  });

  it("does not treat a child re-emitting a linked step with undefined keys as an edit", () => {
    // As loaded from Girder: JSON has no `color` key.
    const tool = JSON.parse(JSON.stringify(workerTool("t1", 5, ["t"])));
    h.store.tools = [tool];
    const wrapper = mountEditor({
      id: "pipe",
      name: "P",
      steps: [JSON.parse(JSON.stringify(linkedAnnotationStep("a", "t1", 5)))],
    });
    const vm = wrapper.vm as any;
    const step = vm.displayedPipeline.steps[0];
    // What AnnotationConfiguration emits on mount.
    vm.handleStepUpdate(0, {
      ...step,
      annotation: { ...step.annotation, color: undefined },
    });

    expect(vm.isDirty).toBe(false);
  });

  it("changes no editor state on an unchanged re-emit", () => {
    h.store.tools = [workerTool("t1", 5, ["t"])];
    const wrapper = mountEditor({
      id: "pipe",
      name: "P",
      steps: [linkedAnnotationStep("a", "t1"), propertyStep("p")],
    });
    const vm = wrapper.vm as any;
    const steps = vm.localPipeline.steps;

    // What AnnotationConfiguration does whenever its value's identity
    // changes: re-emit the same content as a new object (linked and unlinked
    // steps alike).
    vm.handleStepUpdate(0, cloneDeep(vm.displayedPipeline.steps[0]));
    vm.handleStepUpdate(1, cloneDeep(vm.displayedPipeline.steps[1]));

    expect(vm.localPipeline.steps).toBe(steps);
  });

  it("refreshes a linked step's stored copy to its tool's settings on save", async () => {
    h.store.tools = [workerTool("t1", 5, [])];
    const wrapper = mountEditor({
      id: "pipe",
      name: "P",
      steps: [linkedAnnotationStep("a", "t1")],
    });
    const vm = wrapper.vm as any;
    h.store.tools = [workerTool("t1", 42, [])];
    vm.localPipeline.name = "Renamed";

    await vm.save();

    const [saved] = h.pipelinesStore.savePipeline.mock.calls[0];
    expect(saved.steps[0].workerInterfaceValues).toEqual({ threshold: 42 });
    expect(vm.localPipeline.steps[0].workerInterfaceValues).toEqual({
      threshold: 42,
    });
    expect(vm.isDirty).toBe(false);
  });

  it("stays unsaved for edits made during a save", async () => {
    let finishSave: () => void = () => {};
    h.pipelinesStore.savePipeline.mockImplementation(
      () => new Promise<void>((resolve) => (finishSave = resolve)),
    );
    const wrapper = mountEditor({
      id: "pipe",
      name: "P",
      steps: [propertyStep("p")],
    });
    const vm = wrapper.vm as any;
    vm.localPipeline.name = "Before save";

    const saving = vm.save();
    vm.localPipeline.name = "Edited during save";
    finishSave();
    await saving;

    expect(h.pipelinesStore.savePipeline.mock.calls[0][0].name).toBe(
      "Before save",
    );
    expect(vm.localPipeline.name).toBe("Edited during save");
  });

  it("keeps the shown values when a linked step is unlinked", async () => {
    h.store.tools = [workerTool("t1", 5, ["t"])];
    const wrapper = mountEditor({
      id: "pipe",
      name: "P",
      steps: [linkedAnnotationStep("a", "t1", 1)],
    });
    const vm = wrapper.vm as any;

    vm.handleStepUpdate(0, omit(vm.displayedPipeline.steps[0], "sourceToolId"));
    // The tool changes afterwards; the unlinked step keeps its own values.
    h.store.tools = [workerTool("t1", 42, ["t"])];

    expect(vm.displayedPipeline.steps[0].workerInterfaceValues).toEqual({
      threshold: 5,
    });
    expect(vm.linkStates[0]).toEqual({ state: "unlinked" });
  });

  it("does not auto-wire a step linked to an existing property", () => {
    h.properties.properties = [
      {
        id: "user",
        name: "User property",
        image: "img/prop",
        shape: AnnotationShape.Point,
        tags: { tags: ["own"], exclusive: false },
        workerInterface: {},
      },
    ];
    const upstream = {
      ...linkedAnnotationStep("a", "none"),
      sourceToolId: undefined,
      annotation: annotationSetup(["upstream"]),
    };
    const wrapper = mountEditor({
      id: "pipe",
      name: "P",
      steps: [upstream, propertyStep("p", { sourcePropertyId: "user" })],
    });
    const vm = wrapper.vm as any;

    expect(vm.displayedPipeline.steps[1].inputTags.tags).toEqual(["own"]);
    expect(vm.displayedPipeline.steps[1].shape).toBe(AnnotationShape.Point);
  });

  it("adds an existing property as a linked, non-auto-wired step", () => {
    h.properties.properties = [
      {
        id: "user",
        name: "User property",
        image: "img/prop",
        shape: AnnotationShape.Line,
        tags: { tags: ["own"], exclusive: true },
        workerInterface: { radius: 2 },
      },
    ];
    const wrapper = mountEditor({ id: "pipe", name: "P", steps: [] });
    const vm = wrapper.vm as any;

    vm.newStepSource = "existingProperty";
    vm.newStepPropertyId = "user";
    vm.confirmAddStep();

    expect(vm.displayedPipeline.steps).toEqual([
      expect.objectContaining({
        kind: "property",
        name: "User property",
        image: "img/prop",
        shape: AnnotationShape.Line,
        inputTags: { tags: ["own"], exclusive: true },
        workerInterfaceValues: { radius: 2 },
        autoWired: false,
        sourcePropertyId: "user",
      }),
    ]);
    expect(vm.displayedPipeline.steps[0]).not.toHaveProperty(
      "materializedPropertyId",
    );
  });

  it("adds an existing tool as a step linked to that tool", () => {
    h.store.tools = [workerTool("t1", 5, ["from-tool"])];
    const wrapper = mountEditor({ id: "pipe", name: "P", steps: [] });
    const vm = wrapper.vm as any;

    vm.newStepSource = "tool";
    vm.newStepToolId = "t1";
    vm.confirmAddStep();

    expect(vm.displayedPipeline.steps[0]).toMatchObject({
      kind: "annotation",
      sourceToolId: "t1",
      workerInterfaceValues: { threshold: 5 },
    });
  });

  it("reloads properties on open when a linked property is missing", () => {
    mountEditor({
      id: "pipe",
      name: "P",
      steps: [propertyStep("p", { sourcePropertyId: "not-loaded" })],
    });

    expect(h.pipelinesStore.loadMissingLinkedProperties).toHaveBeenCalledWith(
      expect.objectContaining({ id: "pipe" }),
    );
  });

  it("keeps a wired property step's tags when its upstream step is removed before saving", async () => {
    const wrapper = mountEditor({
      id: "pipe",
      name: "P",
      steps: [
        {
          ...linkedAnnotationStep("a", "none"),
          sourceToolId: undefined,
          annotation: annotationSetup(["upstream"]),
        },
        propertyStep("p", { inputTags: { tags: [], exclusive: false } }),
      ],
    });
    const vm = wrapper.vm as any;
    expect(vm.displayedPipeline.steps[1].inputTags.tags).toEqual(["upstream"]);

    vm.askRemoveStep(0);
    await vm.save();

    const [saved] = h.pipelinesStore.savePipeline.mock.calls[0];
    expect(saved.steps[0].inputTags.tags).toEqual(["upstream"]);
  });

  it("does not auto-wire a property step without the autoWired flag", () => {
    const wrapper = mountEditor({
      id: "pipe",
      name: "P",
      steps: [
        {
          ...linkedAnnotationStep("a", "none"),
          sourceToolId: undefined,
          annotation: annotationSetup(["upstream"]),
        },
        propertyStep("p", {
          autoWired: undefined,
          inputTags: { tags: ["manual"], exclusive: false },
        }),
      ],
    });
    const vm = wrapper.vm as any;

    expect(vm.displayedPipeline.steps[1].inputTags.tags).toEqual(["manual"]);
  });

  it("keeps a linked step's saved copy when a settings edit comes in", () => {
    h.store.tools = [workerTool("t1", 5, [])];
    const wrapper = mountEditor({
      id: "pipe",
      name: "P",
      steps: [linkedAnnotationStep("a", "t1", 1)],
    });
    const vm = wrapper.vm as any;

    vm.handleStepUpdate(0, {
      ...vm.displayedPipeline.steps[0],
      name: "Renamed",
      workerInterfaceValues: { threshold: 9 },
    });
    // With the tool gone, the saved copy (the fallback) shows: unchanged.
    h.store.tools = [];

    expect(vm.displayedPipeline.steps[0]).toMatchObject({
      name: "Renamed",
      workerInterfaceValues: { threshold: 1 },
    });
  });

  it("offers to remove the property the runner materialized on the stored pipeline", () => {
    const wrapper = mountEditor({
      id: "pipe",
      name: "P",
      steps: [propertyStep("p")],
    });
    const vm = wrapper.vm as any;
    // The runner recorded the id on the stored pipeline after the editor
    // cloned it.
    h.pipelinesStore.getPipelineById.mockReturnValue({
      id: "pipe",
      name: "P",
      steps: [propertyStep("p", { materializedPropertyId: "M" })],
    });

    vm.askRemoveStep(0);
    vm.confirmRemoveStep();

    expect(vm.materializedPropertyIdsToRemove).toEqual(["M"]);
  });

  it("does not offer a pipeline-materialized property to link to", () => {
    h.properties.properties = [
      { id: "own", name: "Own" },
      { id: "materialized", name: "Materialized" },
    ];
    h.pipelinesStore.pipelines = [
      {
        id: "other",
        name: "Other",
        steps: [propertyStep("x", { materializedPropertyId: "materialized" })],
      },
    ];
    const wrapper = mountEditor({ id: "pipe", name: "P", steps: [] });

    expect(
      (wrapper.vm as any).linkableProperties.map((p: any) => p.id),
    ).toEqual(["own"]);
  });
});

import { ref } from "vue";
import { shallowMount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  pipelinesStore: {
    pipelines: [] as any[],
    runningPipelineId: null as string | null,
    createEmptyPipeline: vi.fn(),
    duplicatePipeline: vi.fn().mockResolvedValue(null),
    deletePipeline: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/store/pipelines", () => ({ default: h.pipelinesStore }));
vi.mock("@/utils/log", () => ({ logError: vi.fn() }));

import PipelineList from "./PipelineList.vue";
import { PipelineRunControllerKey } from "./usePipelineRun";
import { AnnotationShape, IPipeline } from "@/store/model";

const pipeline: IPipeline = {
  id: "pipe1",
  name: "Test",
  steps: [
    {
      id: "step1",
      kind: "property",
      name: "Measure",
      image: "worker/image",
      workerInterfaceValues: {},
      enabled: true,
      shape: AnnotationShape.Polygon,
      inputTags: { tags: [], exclusive: false },
    },
  ],
};

const isRunning = ref(false);
const controller = {
  isRunning,
  canRunPipeline: vi.fn().mockReturnValue(true),
  run: vi.fn().mockResolvedValue(undefined),
};

function mountList() {
  return shallowMount(PipelineList, {
    global: {
      provide: {
        [PipelineRunControllerKey as symbol]: controller,
      },
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  isRunning.value = false;
  h.pipelinesStore.pipelines = [pipeline];
  h.pipelinesStore.duplicatePipeline.mockResolvedValue(null);
  h.pipelinesStore.deletePipeline.mockResolvedValue(undefined);
});

describe("PipelineList", () => {
  it("quick-runs only the current dataset", () => {
    const wrapper = mountList();

    (wrapper.vm as any).runPipeline(pipeline);

    expect(controller.run).toHaveBeenCalledWith(pipeline, {
      allowBatch: false,
    });
  });

  it("guards duplicate and delete actions while a run is active", async () => {
    const wrapper = mountList();
    isRunning.value = true;

    await (wrapper.vm as any).duplicate(pipeline.id);
    (wrapper.vm as any).askDelete(pipeline);
    await (wrapper.vm as any).confirmDelete();

    expect(h.pipelinesStore.duplicatePipeline).not.toHaveBeenCalled();
    expect(h.pipelinesStore.deletePipeline).not.toHaveBeenCalled();
  });
});

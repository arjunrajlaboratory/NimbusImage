import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  store: {
    selectedConfigurationId: "cfg1" as string | null,
    getCollectionDatasetCount: vi.fn(),
  },
  pipelinesStore: {
    runningPipelineId: null as string | null,
    runPipeline: vi.fn().mockResolvedValue(undefined),
    runPipelineBatch: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/store", () => ({ default: h.store }));
vi.mock("@/store/pipelines", () => ({ default: h.pipelinesStore }));

import { createPipelineRunController } from "./usePipelineRun";
import { AnnotationShape, IPipeline } from "@/store/model";

const pipeline: IPipeline = {
  id: "pipe1",
  name: "Test pipeline",
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

beforeEach(() => {
  vi.clearAllMocks();
  h.store.selectedConfigurationId = "cfg1";
  h.pipelinesStore.runningPipelineId = null;
});

describe("createPipelineRunController", () => {
  it("falls back to a single-dataset run when the live batch guard is false", async () => {
    const controller = createPipelineRunController();
    controller.collectionDatasetCount.value = 51;
    controller.applyToAllDatasets.value = true;

    await controller.run(pipeline);

    expect(h.pipelinesStore.runPipelineBatch).not.toHaveBeenCalled();
    expect(h.pipelinesStore.runPipeline).toHaveBeenCalledTimes(1);
    expect(controller.lastRunWasBatch.value).toBe(false);
  });
});

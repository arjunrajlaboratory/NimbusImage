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

const twoStepPipeline: IPipeline = {
  ...pipeline,
  steps: [
    pipeline.steps[0],
    {
      ...pipeline.steps[0],
      id: "step2",
      name: "Measure again",
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

  it("honors a caller that explicitly disables shared batch mode", async () => {
    const controller = createPipelineRunController();
    controller.collectionDatasetCount.value = 2;
    controller.applyToAllDatasets.value = true;

    await controller.run(pipeline, { allowBatch: false });

    expect(h.pipelinesStore.runPipelineBatch).not.toHaveBeenCalled();
    expect(h.pipelinesStore.runPipeline).toHaveBeenCalledTimes(1);
    expect(controller.lastRunWasBatch.value).toBe(false);
  });

  it("keeps statuses and job ids attached to step ids after reordering", async () => {
    h.pipelinesStore.runPipeline.mockImplementationOnce(async (options) => {
      options.onStepStart?.(0);
      options.onStepJob?.(0, "job-step1");
      options.onStepComplete?.(0, true);
      options.onStepStart?.(1);
      options.onStepJob?.(1, "job-step2");
      options.onStepComplete?.(1, false);
      options.onComplete?.({
        succeeded: 1,
        failed: 1,
        cancelled: 0,
        failedStepIndex: 1,
      });
    });
    const controller = createPipelineRunController();

    await controller.run(twoStepPipeline);
    const reordered: IPipeline = {
      ...twoStepPipeline,
      steps: [...twoStepPipeline.steps].reverse(),
    };

    expect(
      controller.statusesFor(reordered).map(({ status }) => status),
    ).toEqual(["error", "success"]);
    expect(controller.jobIdFor(reordered, 0)).toBe("job-step2");
    expect(controller.jobIdFor(reordered, 1)).toBe("job-step1");
  });
});

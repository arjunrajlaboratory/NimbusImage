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
  it("refuses an over-limit 'apply to all' run with a notice instead of running one dataset silently", async () => {
    const controller = createPipelineRunController();
    controller.collectionDatasetCount.value = 51;
    controller.applyToAllDatasets.value = true;

    await controller.run(pipeline);

    expect(h.pipelinesStore.runPipelineBatch).not.toHaveBeenCalled();
    expect(h.pipelinesStore.runPipeline).not.toHaveBeenCalled();
    expect(controller.runNotice.value).toMatch(/over the 50-dataset limit/i);
    expect(controller.lastRunWasBatch.value).toBe(false);
  });

  it("runs as a batch when 'apply to all' is on and within the limit", async () => {
    const controller = createPipelineRunController();
    controller.collectionDatasetCount.value = 3;
    controller.applyToAllDatasets.value = true;

    await controller.run(pipeline);

    expect(h.pipelinesStore.runPipelineBatch).toHaveBeenCalledTimes(1);
    expect(h.pipelinesStore.runPipeline).not.toHaveBeenCalled();
    expect(controller.lastRunWasBatch.value).toBe(true);
    expect(controller.runNotice.value).toBeNull();
  });

  it("surfaces a notice when the store rejects the batch as over-limit (stale count)", async () => {
    h.pipelinesStore.runPipelineBatch.mockImplementationOnce(
      async (options: any) => {
        options.onRejected?.(75);
      },
    );
    const controller = createPipelineRunController();
    // Cached count is under the limit, so the pre-check passes and the store
    // discovers the real (over-limit) count server-side.
    controller.collectionDatasetCount.value = 3;
    controller.applyToAllDatasets.value = true;

    await controller.run(pipeline);

    expect(controller.runNotice.value).toMatch(/75 datasets/);
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

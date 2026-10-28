/**
 * Tests for the worker-pipeline runner (src/store/pipelines.ts).
 *
 * The runner sequences steps: submit a job, await its completion promise, then
 * move to the next step. These tests verify ordering, stop-on-failure vs
 * continueOnError, cancellation, and materialized-property reuse. All store
 * dependencies are mocked so no backend/job machinery is exercised.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  main: {
    dataset: { id: "d1", z: [0], time: [0] } as {
      id: string;
      z: number[];
      time: number[];
    } | null,
    configuration: {
      pipelines: [] as any[],
      compatibility: { channels: {} as Record<number, string> },
    } as any,
    isLoggedIn: true,
    tools: [] as any[],
    selectedConfigurationId: "cfg1",
    api: {
      cancelJob: vi.fn(),
      findDatasetViews: vi.fn().mockResolvedValue([]),
      batchResources: vi.fn().mockResolvedValue({ folder: {} }),
      updateConfigurationKey: vi.fn().mockResolvedValue({}),
    },
    loadLargeImages: vi.fn().mockResolvedValue(false),
    scheduleTileFramesComputation: vi.fn(),
    scheduleMaxMergeCache: vi.fn(),
    scheduleHistogramCache: vi.fn(),
    updateConfigurationPipelines: vi.fn().mockResolvedValue(undefined),
  } as any,
  annotations: {
    submitAnnotationWorkerJob: vi.fn(),
    fetchAnnotations: vi.fn().mockResolvedValue(undefined),
    annotationTags: new Set<string>(),
    annotations: [] as any[],
    annotationsForIteration: [] as any[],
  },
  properties: {
    submitPropertyJob: vi.fn(),
    createProperty: vi.fn(),
    deleteProperty: vi.fn().mockResolvedValue(undefined),
    deleteProperties: vi.fn().mockResolvedValue(undefined),
    properties: [] as any[],
    // Which configuration's fetch filled `properties` (see properties.ts).
    propertiesConfigurationId: undefined as string | null | undefined,
    fetchPropertyValues: vi.fn().mockResolvedValue(undefined),
    fetchProperties: vi.fn().mockResolvedValue(undefined),
    getWorkerInterface: vi.fn().mockReturnValue(null),
    fetchWorkerInterface: vi.fn().mockResolvedValue(undefined),
    fetchWorkerImageList: vi.fn().mockResolvedValue(undefined),
    workerImageList: {} as Record<string, any>,
  },
  progress: {
    create: vi.fn().mockResolvedValue("prog"),
    update: vi.fn(),
    complete: vi.fn(),
    handleJobProgress: vi.fn(),
  },
}));

// `main` is wrapped in Vue's `reactive()` (instead of exported as a plain
// object) because pipelines.ts's `pipelines` getter - and getters derived
// from it, like `isPropertyReferencedByPipelineStep` - are real Vuex getters,
// which Vuex implements internally as `computed()`. A computed with no
// reactive dependency computes once and caches its result forever. Exporting
// a plain mock object here would mean the first test in this file to touch
// `main.configuration.pipelines` permanently freezes that getter's result
// for every later test. `reactive()` makes `main.configuration.pipelines` a
// tracked dependency so the getter recomputes whenever a test reassigns it.
// The `reactive` import must be dynamic (not a static top-level import) so
// it runs inside the (lazily-invoked) mock factory, after Vitest's hoisting
// of `vi.mock`/`vi.hoisted` above static imports.
vi.mock("./index", async () => {
  const { reactive } = await import("vue");
  h.main = reactive(h.main);
  return { default: h.main };
});
vi.mock("./annotation", () => ({ default: h.annotations }));
vi.mock("./properties", () => ({ default: h.properties }));
vi.mock("./jobs", () => ({
  default: {},
  createProgressEventCallback: () => () => {},
  createErrorEventCallback: () => () => {},
}));
vi.mock("./progress", () => ({ default: h.progress }));
vi.mock("./filters", () => ({
  default: { updateHistograms: vi.fn().mockResolvedValue(undefined) },
}));

import pipelinesStore, {
  CONFIGURATION_CHANGED_DURING_RUN,
  mergeMaterializedPropertyIds,
} from "./pipelines";
import rootStore from "./root";
import { resolveLinkedStep, stepLinkState } from "@/utils/pipelineLinks";
import { AnnotationShape, IPipeline } from "./model";

function annotationStep(id: string, tags: string[] = []): any {
  return {
    id,
    kind: "annotation",
    name: id,
    image: "img/annotate",
    workerInterfaceValues: {},
    enabled: true,
    annotation: {
      tags,
      shape: AnnotationShape.Polygon,
      color: undefined,
      coordinateAssignments: {
        layer: null,
        Z: { type: "layer", value: 1, max: 1 },
        Time: { type: "layer", value: 1, max: 1 },
      },
    },
  };
}

function propertyStep(id: string, tags: string[] = []): any {
  return {
    id,
    kind: "property",
    name: id,
    image: "img/prop",
    workerInterfaceValues: {},
    enabled: true,
    shape: AnnotationShape.Polygon,
    inputTags: { tags, exclusive: false },
  };
}

function pipeline(steps: any[]): IPipeline {
  return { id: "pipe1", name: "Test", steps };
}

// A submitter result whose completion resolves to `success`.
function submitResult(jobId: string, success: boolean) {
  return { job: { jobId }, completionPromise: Promise.resolve(success) };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.main.api.findDatasetViews.mockResolvedValue([]);
  h.main.api.batchResources.mockResolvedValue({ folder: {} });
  h.main.updateConfigurationPipelines.mockResolvedValue(undefined);
  h.annotations.fetchAnnotations.mockResolvedValue(undefined);
  h.properties.fetchPropertyValues.mockResolvedValue(undefined);
  h.properties.fetchProperties.mockResolvedValue(undefined);
  // clearAllMocks keeps implementations: reset the ones tests override.
  h.properties.getWorkerInterface.mockReturnValue(null);
  h.properties.fetchWorkerInterface.mockResolvedValue(undefined);
  h.properties.deleteProperty.mockResolvedValue(undefined);
  h.properties.deleteProperties.mockResolvedValue(undefined);
  h.progress.create.mockResolvedValue("prog");
  pipelinesStore.setRunningPipelineId(null);
  h.main.dataset = { id: "d1", z: [0], time: [0] };
  h.main.isLoggedIn = true;
  h.main.configuration = {
    pipelines: [],
    propertyIds: [],
    compatibility: { channels: {} },
  };
  h.main.tools = [];
  h.properties.properties = [];
  h.properties.propertiesConfigurationId = undefined;
  h.properties.workerImageList = {};
  h.annotations.annotationTags = new Set();
  h.annotations.annotations = [];
  h.annotations.annotationsForIteration = [];
});

describe("runPipeline", () => {
  it("runs enabled steps in order and awaits each", async () => {
    const order: string[] = [];
    h.annotations.submitAnnotationWorkerJob.mockImplementation(
      async ({ tool }: any) => {
        order.push(tool.id);
        return submitResult("j-" + tool.id, true);
      },
    );

    const completes: Array<[number, boolean]> = [];
    const result = await pipelinesStore.runPipeline({
      pipeline: pipeline([annotationStep("a"), annotationStep("b")]),
      onStepComplete: (i, ok) => completes.push([i, ok]),
    });

    expect(order).toEqual(["a", "b"]);
    expect(completes).toEqual([
      [0, true],
      [1, true],
    ]);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.failedStepIndex).toBeNull();
  });

  it("reports each step's job id through onStepJob", async () => {
    h.annotations.submitAnnotationWorkerJob.mockImplementation(
      async ({ tool }: any) => submitResult("j-" + tool.id, true),
    );

    const jobIds: Array<[number, string]> = [];
    await pipelinesStore.runPipeline({
      pipeline: pipeline([annotationStep("a"), annotationStep("b")]),
      onStepJob: (i, jobId) => jobIds.push([i, jobId]),
    });

    expect(jobIds).toEqual([
      [0, "j-a"],
      [1, "j-b"],
    ]);
  });

  it("skips disabled steps", async () => {
    const order: string[] = [];
    h.annotations.submitAnnotationWorkerJob.mockImplementation(
      async ({ tool }: any) => {
        order.push(tool.id);
        return submitResult("j", true);
      },
    );
    const disabled = annotationStep("b");
    disabled.enabled = false;

    const result = await pipelinesStore.runPipeline({
      pipeline: pipeline([annotationStep("a"), disabled, annotationStep("c")]),
    });

    expect(order).toEqual(["a", "c"]);
    expect(result.succeeded).toBe(2);
  });

  it("stops after a failed step by default", async () => {
    const order: string[] = [];
    h.annotations.submitAnnotationWorkerJob.mockImplementation(
      async ({ tool }: any) => {
        order.push(tool.id);
        return submitResult("j", tool.id === "a" ? false : true);
      },
    );

    const result = await pipelinesStore.runPipeline({
      pipeline: pipeline([annotationStep("a"), annotationStep("b")]),
    });

    expect(order).toEqual(["a"]); // b never submitted
    expect(result.failed).toBe(1);
    expect(result.failedStepIndex).toBe(0);
    expect(result.succeeded).toBe(0);
  });

  it("continues past a failed step when continueOnError is true", async () => {
    const order: string[] = [];
    h.annotations.submitAnnotationWorkerJob.mockImplementation(
      async ({ tool }: any) => {
        order.push(tool.id);
        return submitResult("j", tool.id === "a" ? false : true);
      },
    );

    const result = await pipelinesStore.runPipeline({
      pipeline: pipeline([annotationStep("a"), annotationStep("b")]),
      continueOnError: true,
    });

    expect(order).toEqual(["a", "b"]);
    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.failedStepIndex).toBe(0);
  });

  it("cancels remaining steps and cancels the running job", async () => {
    let cancelFn: (() => void) | null = null;
    // First step's completion stays pending until we resolve it, so we can
    // cancel while it is genuinely "running" (currentJob assigned, awaiting).
    let resolveFirst!: (v: boolean) => void;
    const firstCompletion = new Promise<boolean>((r) => (resolveFirst = r));
    h.annotations.submitAnnotationWorkerJob.mockImplementationOnce(
      async () => ({
        job: { jobId: "j-cancel" },
        completionPromise: firstCompletion,
      }),
    );

    const runPromise = pipelinesStore.runPipeline({
      pipeline: pipeline([annotationStep("a"), annotationStep("b")]),
      onCancel: (c) => {
        cancelFn = c;
      },
    });

    // Let the first submit resolve and currentJob get assigned.
    await new Promise((r) => setTimeout(r, 0));
    cancelFn!();
    resolveFirst(false);
    const result = await runPromise;

    expect(h.main.api.cancelJob).toHaveBeenCalledWith("j-cancel");
    // Second step counted as cancelled, not submitted.
    expect(h.annotations.submitAnnotationWorkerJob).toHaveBeenCalledTimes(1);
    expect(result.cancelled).toBeGreaterThanOrEqual(1);
  });

  it("returns an empty result with no enabled steps", async () => {
    const disabled = annotationStep("a");
    disabled.enabled = false;
    const result = await pipelinesStore.runPipeline({
      pipeline: pipeline([disabled]),
    });
    expect(result).toEqual({
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      failedStepIndex: null,
    });
    expect(h.annotations.submitAnnotationWorkerJob).not.toHaveBeenCalled();
  });

  it("materializes a property for a property step, then submits it", async () => {
    h.properties.createProperty.mockResolvedValue({
      id: "prop-created",
      image: "img/prop",
      shape: AnnotationShape.Polygon,
      tags: { tags: ["nuclei"], exclusive: false },
      workerInterface: {},
    });
    let submittedPropertyId: string | null = null;
    h.properties.submitPropertyJob.mockImplementation(
      async ({ property }: any) => {
        submittedPropertyId = property.id;
        return submitResult("j-prop", true);
      },
    );

    const step = propertyStep("p", ["nuclei"]);
    const result = await pipelinesStore.runPipeline({
      pipeline: pipeline([step]),
    });

    expect(h.properties.createProperty).toHaveBeenCalledTimes(1);
    expect(submittedPropertyId).toBe("prop-created");
    expect(step.materializedPropertyId).toBe("prop-created");
    expect(result.succeeded).toBe(1);
  });

  it("reuses a materialized property that still matches", async () => {
    h.properties.properties = [
      {
        id: "existing",
        image: "img/prop",
        shape: AnnotationShape.Polygon,
        tags: { tags: ["nuclei"], exclusive: false },
        workerInterface: {},
      },
    ];
    h.properties.submitPropertyJob.mockResolvedValue(submitResult("j", true));

    const step = propertyStep("p", ["nuclei"]);
    step.materializedPropertyId = "existing";

    await pipelinesStore.runPipeline({ pipeline: pipeline([step]) });

    expect(h.properties.createProperty).not.toHaveBeenCalled();
  });

  it("bails out when not logged in", async () => {
    h.main.isLoggedIn = false;
    const result = await pipelinesStore.runPipeline({
      pipeline: pipeline([annotationStep("a")]),
    });
    expect(result.succeeded).toBe(0);
    expect(h.annotations.submitAnnotationWorkerJob).not.toHaveBeenCalled();
  });

  it("does not persist the configuration when no property is materialized (annotation-only run)", async () => {
    h.annotations.submitAnnotationWorkerJob.mockResolvedValue(
      submitResult("j", true),
    );

    await pipelinesStore.runPipeline({
      pipeline: pipeline([annotationStep("a")]),
    });

    expect(h.main.updateConfigurationPipelines).not.toHaveBeenCalled();
  });

  it("clears running state when the post-run refresh fails", async () => {
    h.annotations.submitAnnotationWorkerJob.mockResolvedValue(
      submitResult("j", true),
    );
    h.properties.fetchPropertyValues.mockRejectedValueOnce(
      new Error("refresh failed"),
    );

    await expect(
      pipelinesStore.runPipeline({
        pipeline: pipeline([annotationStep("a")]),
      }),
    ).rejects.toThrow("refresh failed");

    expect(pipelinesStore.runningPipelineId).toBeNull();
    expect(h.progress.complete).toHaveBeenCalledTimes(2);
  });

  it("persists the configuration when a property is newly materialized", async () => {
    h.properties.createProperty.mockResolvedValue({
      id: "prop-created",
      image: "img/prop",
      shape: AnnotationShape.Polygon,
      tags: { tags: ["nuclei"], exclusive: false },
      workerInterface: {},
    });
    h.properties.submitPropertyJob.mockResolvedValue(submitResult("j", true));

    await pipelinesStore.runPipeline({
      pipeline: pipeline([propertyStep("p", ["nuclei"])]),
    });

    expect(h.main.updateConfigurationPipelines).toHaveBeenCalledTimes(1);
  });

  it("does not persist the configuration when a materialized property is reused unchanged", async () => {
    h.properties.properties = [
      {
        id: "existing",
        image: "img/prop",
        shape: AnnotationShape.Polygon,
        tags: { tags: ["nuclei"], exclusive: false },
        workerInterface: {},
      },
    ];
    h.properties.submitPropertyJob.mockResolvedValue(submitResult("j", true));

    const step = propertyStep("p", ["nuclei"]);
    step.materializedPropertyId = "existing";

    await pipelinesStore.runPipeline({ pipeline: pipeline([step]) });

    expect(h.main.updateConfigurationPipelines).not.toHaveBeenCalled();
  });

  it("deletes the stale materialized property on drift and keeps only the new id", async () => {
    h.properties.properties = [
      {
        id: "stale",
        image: "img/prop",
        shape: AnnotationShape.Polygon,
        tags: { tags: ["old-tag"], exclusive: false },
        workerInterface: {},
      },
    ];
    h.properties.createProperty.mockResolvedValue({
      id: "fresh",
      image: "img/prop",
      shape: AnnotationShape.Polygon,
      tags: { tags: ["nuclei"], exclusive: false },
      workerInterface: {},
    });
    h.properties.submitPropertyJob.mockResolvedValue(submitResult("j", true));

    // Step's inputTags ("nuclei") no longer match the materialized
    // property's tags ("old-tag") - simulates the step's config having
    // drifted since the property was created.
    const step = propertyStep("p", ["nuclei"]);
    step.materializedPropertyId = "stale";
    const pipe = pipeline([step]);
    h.main.configuration.pipelines = [pipe];

    await pipelinesStore.runPipeline({ pipeline: pipe });

    expect(h.properties.createProperty).toHaveBeenCalledTimes(1);
    expect(h.properties.deleteProperty).toHaveBeenCalledWith("stale");
    expect(step.materializedPropertyId).toBe("fresh");
  });

  it("does not delete a drifted-away property still referenced by another pipeline's step", async () => {
    h.properties.properties = [
      {
        id: "stale",
        image: "img/prop",
        shape: AnnotationShape.Polygon,
        tags: { tags: ["old-tag"], exclusive: false },
        workerInterface: {},
      },
    ];
    h.properties.createProperty.mockResolvedValue({
      id: "fresh",
      image: "img/prop",
      shape: AnnotationShape.Polygon,
      tags: { tags: ["nuclei"], exclusive: false },
      workerInterface: {},
    });
    h.properties.submitPropertyJob.mockResolvedValue(submitResult("j", true));

    const step = propertyStep("p", ["nuclei"]);
    step.materializedPropertyId = "stale";
    const pipe = pipeline([step]);

    const otherStep = propertyStep("other", ["old-tag"]);
    otherStep.materializedPropertyId = "stale";
    const otherPipeline: IPipeline = {
      id: "pipe2",
      name: "Other",
      steps: [otherStep],
    };

    h.main.configuration.pipelines = [pipe, otherPipeline];

    await pipelinesStore.runPipeline({ pipeline: pipe });

    expect(h.properties.deleteProperty).not.toHaveBeenCalled();
  });
});

describe("deletePipeline", () => {
  it("removes materialized properties by default", async () => {
    const step = propertyStep("p", ["nuclei"]);
    step.materializedPropertyId = "prop-1";
    const pipe = pipeline([step]);
    h.main.configuration.pipelines = [pipe];

    await pipelinesStore.deletePipeline({ pipelineId: pipe.id });

    expect(h.properties.deleteProperties).toHaveBeenCalledWith(["prop-1"]);
    expect(h.main.updateConfigurationPipelines).toHaveBeenCalledWith([]);
  });

  it("skips property cleanup when the removeMaterializedProperties flag is false", async () => {
    const step = propertyStep("p", ["nuclei"]);
    step.materializedPropertyId = "prop-1";
    const pipe = pipeline([step]);
    h.main.configuration.pipelines = [pipe];

    await pipelinesStore.deletePipeline({
      pipelineId: pipe.id,
      removeMaterializedProperties: false,
    });

    expect(h.properties.deleteProperties).not.toHaveBeenCalled();
    expect(h.main.updateConfigurationPipelines).toHaveBeenCalledWith([]);
  });

  it("does not delete a materialized property still referenced by another pipeline", async () => {
    const step = propertyStep("p", ["nuclei"]);
    step.materializedPropertyId = "shared";
    const pipe = pipeline([step]);

    const otherStep = propertyStep("other", ["nuclei"]);
    otherStep.materializedPropertyId = "shared";
    const otherPipeline: IPipeline = {
      id: "pipe2",
      name: "Other",
      steps: [otherStep],
    };

    h.main.configuration.pipelines = [pipe, otherPipeline];

    await pipelinesStore.deletePipeline({ pipelineId: pipe.id });

    expect(h.properties.deleteProperties).not.toHaveBeenCalled();
    expect(h.main.updateConfigurationPipelines).toHaveBeenCalledWith([
      otherPipeline,
    ]);
  });

  it("keeps properties intact when the pipeline deletion fails to persist", async () => {
    const step = propertyStep("p");
    step.materializedPropertyId = "prop-1";
    const pipe = pipeline([step]);
    h.main.configuration.pipelines = [pipe];
    h.main.updateConfigurationPipelines.mockRejectedValueOnce(
      new Error("configuration write failed"),
    );

    await expect(
      pipelinesStore.deletePipeline({ pipelineId: pipe.id }),
    ).rejects.toThrow("configuration write failed");

    expect(h.properties.deleteProperties).not.toHaveBeenCalled();
  });
});

describe("pipeline persistence and property-step cleanup", () => {
  it("rejects a pipeline save when backend configuration persistence fails", async () => {
    const error = new Error("configuration write failed");
    h.main.updateConfigurationPipelines.mockRejectedValueOnce(error);

    await expect(
      pipelinesStore.savePipeline(pipeline([annotationStep("a")])),
    ).rejects.toThrow("configuration write failed");
  });

  it("removes materialized properties no longer referenced by any step", async () => {
    await pipelinesStore.deleteUnreferencedMaterializedProperties([
      "orphan",
      "orphan",
    ]);

    expect(h.properties.deleteProperties).toHaveBeenCalledWith(["orphan"]);
  });

  it("keeps a materialized property that another step still references", async () => {
    const step = propertyStep("p");
    step.materializedPropertyId = "shared";
    h.main.configuration.pipelines = [pipeline([step])];

    await pipelinesStore.deleteUnreferencedMaterializedProperties(["shared"]);

    expect(h.properties.deleteProperties).not.toHaveBeenCalled();
  });
});

describe("runPipelineBatch", () => {
  it("runs the pipeline once per dataset and tallies results", async () => {
    h.main.api.findDatasetViews.mockResolvedValue([
      { datasetId: "d1" },
      { datasetId: "d2" },
      { datasetId: "d2" }, // duplicate → deduped
    ]);
    h.main.api.batchResources.mockResolvedValue({
      folder: { d1: { name: "Dataset 1" }, d2: { name: "Dataset 2" } },
    });
    const datasetsRun: string[] = [];
    h.annotations.submitAnnotationWorkerJob.mockImplementation(
      async ({ datasetId }: any) => {
        datasetsRun.push(datasetId);
        return submitResult("j", true);
      },
    );

    const summary = await pipelinesStore.runPipelineBatch({
      pipeline: pipeline([annotationStep("a")]),
      configurationId: "cfg1",
    });

    expect(datasetsRun).toEqual(["d1", "d2"]);
    expect(summary).toEqual({ succeeded: 2, failed: 0, cancelled: 0 });
    // One end-of-batch refresh, not one per dataset.
    expect(h.annotations.fetchAnnotations).toHaveBeenCalledTimes(1);
  });

  it("runs every dataset with the linked settings resolved when the batch started", async () => {
    const tool = (threshold: number) => ({
      id: "t1",
      name: "Tool",
      hotkey: null,
      type: "segmentation",
      template: { name: "t", type: "segmentation", interface: [] },
      values: {
        image: { image: "img/tool" },
        workerInterfaceValues: { threshold },
      },
    });
    h.main.tools = [tool(7)];
    h.main.api.findDatasetViews.mockResolvedValue([
      { datasetId: "d1" },
      { datasetId: "d2" },
    ]);
    const thresholds: number[] = [];
    h.annotations.submitAnnotationWorkerJob.mockImplementation(
      async ({ tool: submitted }: any) => {
        thresholds.push(submitted.values.workerInterfaceValues.threshold);
        // The tool is edited while the batch runs.
        h.main.tools = [tool(99)];
        return submitResult("j", true);
      },
    );
    const step = { ...annotationStep("a"), sourceToolId: "t1" };

    await pipelinesStore.runPipelineBatch({
      pipeline: pipeline([step]),
      configurationId: "cfg1",
    });

    expect(thresholds).toEqual([7, 7]);
  });

  it("counts a dataset with a failed step as failed", async () => {
    h.main.api.findDatasetViews.mockResolvedValue([
      { datasetId: "d1" },
      { datasetId: "d2" },
    ]);
    h.annotations.submitAnnotationWorkerJob.mockImplementation(
      async ({ datasetId }: any) => submitResult("j", datasetId !== "d2"),
    );

    const summary = await pipelinesStore.runPipelineBatch({
      pipeline: pipeline([annotationStep("a")]),
      configurationId: "cfg1",
    });

    expect(summary).toEqual({ succeeded: 1, failed: 1, cancelled: 0 });
  });

  it("returns empty when the collection has no datasets", async () => {
    h.main.api.findDatasetViews.mockResolvedValue([]);
    const summary = await pipelinesStore.runPipelineBatch({
      pipeline: pipeline([annotationStep("a")]),
      configurationId: "cfg1",
    });
    expect(summary).toEqual({ succeeded: 0, failed: 0, cancelled: 0 });
    expect(h.annotations.submitAnnotationWorkerJob).not.toHaveBeenCalled();
  });

  it("refuses to launch a batch larger than the authoritative limit", async () => {
    h.main.api.findDatasetViews.mockResolvedValue(
      Array.from({ length: 51 }, (_, index) => ({
        datasetId: `d-${index}`,
      })),
    );

    const onRejected = vi.fn();
    const summary = await pipelinesStore.runPipelineBatch({
      pipeline: pipeline([annotationStep("a")]),
      configurationId: "cfg1",
      onRejected,
    });

    expect(summary).toEqual({ succeeded: 0, failed: 51, cancelled: 0 });
    expect(onRejected).toHaveBeenCalledWith(51);
    expect(h.main.api.batchResources).not.toHaveBeenCalled();
    expect(h.annotations.submitAnnotationWorkerJob).not.toHaveBeenCalled();
    expect(pipelinesStore.runningPipelineId).toBeNull();
  });

  it("clears batch running state when a child persistence step fails", async () => {
    h.main.api.findDatasetViews.mockResolvedValue([{ datasetId: "d1" }]);
    h.main.api.batchResources.mockResolvedValue({
      folder: { d1: { name: "Dataset 1" } },
    });
    h.properties.createProperty.mockResolvedValue({
      id: "prop-created",
      image: "img/prop",
      shape: AnnotationShape.Polygon,
      tags: { tags: [], exclusive: false },
      workerInterface: {},
    });
    h.properties.submitPropertyJob.mockResolvedValue(submitResult("j", true));
    h.main.updateConfigurationPipelines.mockRejectedValueOnce(
      new Error("configuration write failed"),
    );

    await expect(
      pipelinesStore.runPipelineBatch({
        pipeline: pipeline([propertyStep("p")]),
        configurationId: "cfg1",
      }),
    ).rejects.toThrow("configuration write failed");

    expect(pipelinesStore.runningPipelineId).toBeNull();
    // Step, child-pipeline, and outer-batch progress all close.
    expect(h.progress.complete).toHaveBeenCalledTimes(3);
  });
});

describe("mergeMaterializedPropertyIds", () => {
  function withMaterialized(step: any, id: string | undefined) {
    return { ...step, materializedPropertyId: id };
  }

  it("carries a materialized id from source into a target step lacking one", () => {
    const target = pipeline([annotationStep("a"), propertyStep("p")]);
    const source = pipeline([
      annotationStep("a"),
      withMaterialized(propertyStep("p"), "prop-1"),
    ]);

    mergeMaterializedPropertyIds(target, source);

    expect((target.steps[1] as any).materializedPropertyId).toBe("prop-1");
  });

  it("prefers the source's (runner-written) id over the target's stale one", () => {
    const target = pipeline([withMaterialized(propertyStep("p"), "old")]);
    const source = pipeline([withMaterialized(propertyStep("p"), "new")]);

    mergeMaterializedPropertyIds(target, source);

    expect((target.steps[0] as any).materializedPropertyId).toBe("new");
  });

  it("leaves the target unchanged when the source has no id or no match", () => {
    const target = pipeline([withMaterialized(propertyStep("p"), "keep")]);
    // Source lacks an id, and has an unrelated step id.
    const source = pipeline([propertyStep("other")]);

    mergeMaterializedPropertyIds(target, source);

    expect((target.steps[0] as any).materializedPropertyId).toBe("keep");
  });

  it("is a no-op for a null/undefined source", () => {
    const target = pipeline([withMaterialized(propertyStep("p"), "keep")]);

    mergeMaterializedPropertyIds(target, null);

    expect((target.steps[0] as any).materializedPropertyId).toBe("keep");
  });

  it("ignores annotation steps sharing an id slot", () => {
    const target = pipeline([annotationStep("x")]);
    const source = pipeline([
      withMaterialized(propertyStep("x") as any, "prop-1"),
    ]);

    mergeMaterializedPropertyIds(target, source);

    expect((target.steps[0] as any).materializedPropertyId).toBeUndefined();
  });
});

describe("linked steps", () => {
  function workerTool(id: string, overrides: any = {}): any {
    return {
      id,
      name: `Tool ${id}`,
      hotkey: null,
      type: "segmentation",
      template: { name: "t", type: "segmentation", interface: [] },
      values: {
        image: { image: "img/tool" },
        workerInterfaceValues: { threshold: 7 },
        annotation: {
          tags: ["from-tool"],
          shape: AnnotationShape.Polygon,
          color: undefined,
          coordinateAssignments: {
            layer: null,
            Z: { type: "layer", value: 1, max: 1 },
            Time: { type: "layer", value: 1, max: 1 },
          },
        },
        ...overrides,
      },
    };
  }

  function existingProperty(id: string): any {
    return {
      id,
      name: `Property ${id}`,
      image: "img/user-prop",
      shape: AnnotationShape.Point,
      tags: { tags: ["user-tag"], exclusive: true },
      workerInterface: { radius: 3 },
    };
  }

  it("runs a linked annotation step with its tool's current values", async () => {
    h.main.tools = [workerTool("t1")];
    let submittedTool: any = null;
    h.annotations.submitAnnotationWorkerJob.mockImplementation(
      async ({ tool }: any) => {
        submittedTool = tool;
        return submitResult("j", true);
      },
    );
    // The saved copy is stale: the tool was edited after the step was added.
    const step = { ...annotationStep("a", ["stale-tag"]), sourceToolId: "t1" };

    await pipelinesStore.runPipeline({ pipeline: pipeline([step]) });

    expect(submittedTool.values.image.image).toBe("img/tool");
    expect(submittedTool.values.workerInterfaceValues).toEqual({
      threshold: 7,
    });
    expect(submittedTool.values.annotation.tags).toEqual(["from-tool"]);
  });

  it("submits a linked tool's interface defaults for parameters it has no value for", async () => {
    // Saved with one value only (an accepted AI suggestion saves none).
    const tool = workerTool("t1");
    h.main.tools = [tool];
    h.properties.getWorkerInterface.mockReturnValue({
      threshold: { type: "number", default: 3 },
      radius: { type: "number", default: 2 },
    });
    let submittedTool: any = null;
    h.annotations.submitAnnotationWorkerJob.mockImplementation(
      async ({ tool: submitted }: any) => {
        submittedTool = submitted;
        return submitResult("j", true);
      },
    );

    await pipelinesStore.runPipeline({
      pipeline: pipeline([{ ...annotationStep("a"), sourceToolId: "t1" }]),
    });

    // As the tool's own menu submits it: saved values, then defaults.
    expect(submittedTool.values.workerInterfaceValues).toEqual({
      threshold: 7,
      radius: 2,
    });
    // The tool itself is not modified.
    expect(tool.values.workerInterfaceValues).toEqual({ threshold: 7 });
  });

  it("loads an uncached worker interface before filling defaults", async () => {
    h.main.tools = [workerTool("t1", { workerInterfaceValues: {} })];
    let loaded = false;
    // Never fetched (undefined), as opposed to fetched without one (null).
    h.properties.getWorkerInterface.mockImplementation(() =>
      loaded ? { radius: { type: "number", default: 2 } } : undefined,
    );
    h.properties.fetchWorkerInterface.mockImplementation(async () => {
      loaded = true;
    });
    let submittedTool: any = null;
    h.annotations.submitAnnotationWorkerJob.mockImplementation(
      async ({ tool: submitted }: any) => {
        submittedTool = submitted;
        return submitResult("j", true);
      },
    );

    await pipelinesStore.runPipeline({
      pipeline: pipeline([{ ...annotationStep("a"), sourceToolId: "t1" }]),
    });

    expect(h.properties.fetchWorkerInterface).toHaveBeenCalledWith({
      image: "img/tool",
    });
    expect(submittedTool.values.workerInterfaceValues).toEqual({ radius: 2 });
  });

  it("does not submit a step cancelled while its worker interface loads", async () => {
    h.main.tools = [workerTool("t1")];
    h.properties.getWorkerInterface.mockReturnValue(undefined);
    let finishFetch!: () => void;
    h.properties.fetchWorkerInterface.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishFetch = resolve;
        }),
    );
    let cancel!: () => void;
    const run = pipelinesStore.runPipeline({
      pipeline: pipeline([{ ...annotationStep("a"), sourceToolId: "t1" }]),
      onCancel: (c) => {
        cancel = c;
      },
    });
    await vi.waitFor(() =>
      expect(h.properties.fetchWorkerInterface).toHaveBeenCalled(),
    );

    cancel();
    finishFetch();
    const result = await run;

    expect(h.annotations.submitAnnotationWorkerJob).not.toHaveBeenCalled();
    expect(result.cancelled).toBe(1);
  });

  it("cancels a job whose run was cancelled while it was being submitted", async () => {
    let finishSubmit!: (value: any) => void;
    h.annotations.submitAnnotationWorkerJob.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSubmit = resolve;
        }),
    );
    let cancel!: () => void;
    const run = pipelinesStore.runPipeline({
      pipeline: pipeline([annotationStep("a")]),
      onCancel: (c) => {
        cancel = c;
      },
    });
    await vi.waitFor(() =>
      expect(h.annotations.submitAnnotationWorkerJob).toHaveBeenCalled(),
    );

    cancel();
    finishSubmit(submitResult("submitted-late", false));
    await run;

    expect(h.main.api.cancelJob).toHaveBeenCalledWith("submitted-late");
  });

  it("does not refetch a worker interface the worker does not have", async () => {
    // null: fetched before, and the worker has no interface.
    h.properties.getWorkerInterface.mockReturnValue(null);
    h.annotations.submitAnnotationWorkerJob.mockResolvedValue(
      submitResult("j", true),
    );

    await pipelinesStore.runPipeline({
      pipeline: pipeline([annotationStep("a"), annotationStep("b")]),
    });

    expect(h.properties.fetchWorkerInterface).not.toHaveBeenCalled();
  });

  it("does not materialize a property from another configuration's list", async () => {
    const step = propertyStep("p", ["nuclei"]);
    step.materializedPropertyId = "materialized";
    h.main.configuration = { ...h.main.configuration, id: "config-a" };
    h.properties.propertiesConfigurationId = "config-b";
    h.properties.properties = [];

    const result = await pipelinesStore.runPipeline({
      pipeline: pipeline([step]),
    });

    // A miss in the other list would create a property that could not be
    // registered here, leaving it orphaned on the server.
    expect(h.properties.createProperty).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
  });

  it("does not compute a linked property from another configuration's list after a failed reload", async () => {
    const shared = existingProperty("shared");
    // Right after a switch: the loaded list is still the other
    // configuration's, and this configuration's reload fails.
    h.main.configuration = { ...h.main.configuration, id: "config-a" };
    h.properties.propertiesConfigurationId = "config-b";
    h.properties.properties = [shared];
    h.properties.fetchProperties.mockRejectedValue(new Error("offline"));
    const errors: any[] = [];

    const result = await pipelinesStore.runPipeline({
      pipeline: pipeline([
        { ...propertyStep("p"), sourcePropertyId: "shared" },
      ]),
      onStepError: (_index, info) => errors.push(...info.errors),
    });

    expect(h.properties.submitPropertyJob).not.toHaveBeenCalled();
    expect(h.properties.createProperty).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
    expect(errors[0].error).toContain(
      "Could not check whether the linked property still exists",
    );
  });

  it("runs a linked annotation step from its saved copy when the tool is gone", async () => {
    h.main.tools = [];
    let submittedTool: any = null;
    h.annotations.submitAnnotationWorkerJob.mockImplementation(
      async ({ tool }: any) => {
        submittedTool = tool;
        return submitResult("j", true);
      },
    );
    const step = { ...annotationStep("a", ["saved"]), sourceToolId: "gone" };

    const result = await pipelinesStore.runPipeline({
      pipeline: pipeline([step]),
    });

    expect(result.succeeded).toBe(1);
    expect(submittedTool.values.image.image).toBe("img/annotate");
    expect(submittedTool.values.annotation.tags).toEqual(["saved"]);
  });

  it("computes a linked property step on the existing property without materializing", async () => {
    h.properties.properties = [existingProperty("user")];
    let submittedProperty: any = null;
    h.properties.submitPropertyJob.mockImplementation(
      async ({ property }: any) => {
        submittedProperty = property;
        return submitResult("j", true);
      },
    );
    const step = { ...propertyStep("p", ["other"]), sourcePropertyId: "user" };
    const pipe = pipeline([step]);
    h.main.configuration.pipelines = [pipe];

    const result = await pipelinesStore.runPipeline({ pipeline: pipe });

    expect(result.succeeded).toBe(1);
    expect(submittedProperty.id).toBe("user");
    expect(h.properties.createProperty).not.toHaveBeenCalled();
    expect(h.properties.deleteProperty).not.toHaveBeenCalled();
    expect(h.main.updateConfigurationPipelines).not.toHaveBeenCalled();
    expect(step).not.toHaveProperty("materializedPropertyId");
  });

  it("materializes a linked property step from its saved copy when the property is gone", async () => {
    h.properties.createProperty.mockResolvedValue({
      id: "fresh",
      image: "img/prop",
      shape: AnnotationShape.Polygon,
      tags: { tags: ["nuclei"], exclusive: false },
      workerInterface: {},
    });
    h.properties.submitPropertyJob.mockResolvedValue(submitResult("j", true));
    const step = { ...propertyStep("p", ["nuclei"]), sourcePropertyId: "gone" };

    await pipelinesStore.runPipeline({ pipeline: pipeline([step]) });

    expect(h.properties.createProperty).toHaveBeenCalledWith(
      expect.objectContaining({ image: "img/prop" }),
    );
    expect((step as any).materializedPropertyId).toBe("fresh");
  });

  it("does not delete a drifted-away property that another step links to", async () => {
    h.properties.properties = [
      {
        id: "shared",
        image: "img/prop",
        shape: AnnotationShape.Polygon,
        tags: { tags: ["old-tag"], exclusive: false },
        workerInterface: {},
      },
    ];
    h.properties.createProperty.mockResolvedValue({
      id: "fresh",
      image: "img/prop",
      shape: AnnotationShape.Polygon,
      tags: { tags: ["nuclei"], exclusive: false },
      workerInterface: {},
    });
    h.properties.submitPropertyJob.mockResolvedValue(submitResult("j", true));
    const step = propertyStep("p", ["nuclei"]);
    step.materializedPropertyId = "shared";
    const pipe = pipeline([step]);
    const linkedStep = {
      ...propertyStep("linked", ["old-tag"]),
      sourcePropertyId: "shared",
    };
    h.main.configuration.pipelines = [
      pipe,
      { id: "pipe2", name: "Other", steps: [linkedStep] },
    ];

    await pipelinesStore.runPipeline({ pipeline: pipe });

    expect(h.properties.deleteProperty).not.toHaveBeenCalled();
  });

  it("keeps a materialized property another pipeline links to when its own pipeline is deleted", async () => {
    const owner = { ...propertyStep("owner"), materializedPropertyId: "P" };
    const linker = { ...propertyStep("linker"), sourcePropertyId: "P" };
    h.main.configuration.pipelines = [
      pipeline([owner]),
      { id: "pipe2", name: "Other", steps: [linker] },
    ];

    await pipelinesStore.deletePipeline({ pipelineId: "pipe1" });

    expect(h.properties.deleteProperties).not.toHaveBeenCalled();
  });

  it("deletes a property both of whose steps drifted away from it in one run", async () => {
    h.properties.properties = [
      {
        id: "X",
        image: "img/prop",
        shape: AnnotationShape.Polygon,
        tags: { tags: ["old"], exclusive: false },
        workerInterface: {},
      },
    ];
    let created = 0;
    h.properties.createProperty.mockImplementation(async (property: any) => ({
      ...property,
      id: `new-${++created}`,
    }));
    h.annotations.submitAnnotationWorkerJob.mockResolvedValue(
      submitResult("j-a", true),
    );
    h.properties.submitPropertyJob.mockResolvedValue(submitResult("j", true));
    // Both share X and are rewired at run time (so they run as copies).
    const wired = (id: string) => ({
      ...propertyStep(id, ["old"]),
      autoWired: true,
      materializedPropertyId: "X",
    });
    const pipe = pipeline([
      annotationStep("a", ["new"]),
      wired("s1"),
      wired("s2"),
    ]);
    h.main.configuration.pipelines = [pipe];

    await pipelinesStore.runPipeline({ pipeline: pipe });

    expect(h.properties.deleteProperty).toHaveBeenCalledWith("X");
  });

  it("never deletes a linked property when its pipeline is deleted", async () => {
    const linkedStep = {
      ...propertyStep("linked"),
      sourcePropertyId: "user",
    };
    h.main.configuration.pipelines = [pipeline([linkedStep])];

    await pipelinesStore.deletePipeline({ pipelineId: "pipe1" });

    expect(h.properties.deleteProperties).not.toHaveBeenCalled();
  });

  it("resolveLinkedStep returns the same step when unlinked, missing or in sync", () => {
    const tool = workerTool("t1");
    const unlinked = annotationStep("a");
    const missing = { ...annotationStep("b"), sourceToolId: "gone" };
    const inSync = resolveLinkedStep(
      { ...annotationStep("c"), sourceToolId: "t1" },
      [tool],
      [],
    );

    expect(resolveLinkedStep(unlinked, [tool], [])).toBe(unlinked);
    expect(resolveLinkedStep(missing, [tool], [])).toBe(missing);
    expect(resolveLinkedStep(inSync, [tool], [])).toBe(inSync);
  });

  it("resolveLinkedStep takes a linked property step's fields from the property", () => {
    const step = { ...propertyStep("p", ["x"]), sourcePropertyId: "user" };

    const resolved = resolveLinkedStep(step, [], [existingProperty("user")]);

    expect(resolved).toMatchObject({
      image: "img/user-prop",
      shape: AnnotationShape.Point,
      inputTags: { tags: ["user-tag"], exclusive: true },
      workerInterfaceValues: { radius: 3 },
      sourcePropertyId: "user",
    });
  });

  it("stepLinkState distinguishes linked, missing and unlinked steps", () => {
    const tools = [workerTool("t1")];
    const props = [existingProperty("user")];

    expect(
      stepLinkState({ ...annotationStep("a"), sourceToolId: "t1" }, tools, []),
    ).toEqual({ state: "linked", sourceKind: "tool", sourceName: "Tool t1" });
    expect(
      stepLinkState({ ...propertyStep("p"), sourcePropertyId: "x" }, [], props),
    ).toEqual({ state: "missing", sourceKind: "property", reason: "notFound" });
    expect(stepLinkState(annotationStep("a"), tools, props)).toEqual({
      state: "unlinked",
    });
    // A tool that still exists but has no worker image is unusable, not
    // deleted.
    expect(
      stepLinkState(
        { ...annotationStep("a"), sourceToolId: "t2" },
        [workerTool("t2", { image: { image: "" } })],
        [],
      ),
    ).toEqual({
      state: "missing",
      sourceKind: "tool",
      reason: "noWorker",
      sourceName: "Tool t2",
    });
  });

  it("re-wires a property step to the output tags its linked tool produces now", async () => {
    // Saved while the tool produced "stale-tag"; the tool now produces
    // "from-tool".
    h.main.tools = [workerTool("t1")];
    h.annotations.submitAnnotationWorkerJob.mockResolvedValue(
      submitResult("j-a", true),
    );
    h.properties.createProperty.mockResolvedValue({
      id: "fresh",
      image: "img/prop",
      shape: AnnotationShape.Polygon,
      tags: { tags: ["from-tool"], exclusive: false },
      workerInterface: {},
    });
    h.properties.submitPropertyJob.mockResolvedValue(submitResult("j", true));
    const linkedStep = {
      ...annotationStep("a", ["stale-tag"]),
      sourceToolId: "t1",
    };
    const wiredStep = { ...propertyStep("p", ["stale-tag"]), autoWired: true };
    const pipe = pipeline([linkedStep, wiredStep]);
    h.main.configuration.pipelines = [pipe];

    await pipelinesStore.runPipeline({ pipeline: pipe });

    expect(h.properties.createProperty).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: { tags: ["from-tool"], exclusive: false },
      }),
    );
    // The materialized id lands on the stored step, and is persisted.
    expect(wiredStep.materializedPropertyId).toBe("fresh");
    expect(h.main.updateConfigurationPipelines).toHaveBeenCalledTimes(1);
  });

  it("reloads properties once before treating a linked property as deleted", async () => {
    // Not loaded yet when the run starts; the reload finds it.
    h.properties.properties = [];
    h.properties.fetchProperties.mockImplementation(async () => {
      h.properties.properties = [existingProperty("user")];
    });
    h.properties.submitPropertyJob.mockResolvedValue(submitResult("j", true));
    const step = { ...propertyStep("p"), sourcePropertyId: "user" };

    const result = await pipelinesStore.runPipeline({
      pipeline: pipeline([step]),
    });

    expect(h.properties.fetchProperties).toHaveBeenCalledTimes(1);
    expect(h.properties.createProperty).not.toHaveBeenCalled();
    expect(h.properties.submitPropertyJob).toHaveBeenCalledWith(
      expect.objectContaining({
        property: expect.objectContaining({ id: "user" }),
      }),
    );
    expect(result.succeeded).toBe(1);
  });

  it("does not reload a linked property already running its fallback", async () => {
    h.properties.submitPropertyJob.mockResolvedValue(submitResult("j", true));
    h.properties.properties = [
      {
        id: "fallback",
        image: "img/prop",
        shape: AnnotationShape.Polygon,
        tags: { tags: [], exclusive: false },
        workerInterface: {},
      },
    ];
    const step = {
      ...propertyStep("p"),
      sourcePropertyId: "gone",
      materializedPropertyId: "fallback",
    };

    const result = await pipelinesStore.runPipeline({
      pipeline: pipeline([step]),
    });

    expect(h.properties.fetchProperties).not.toHaveBeenCalled();
    expect(h.properties.createProperty).not.toHaveBeenCalled();
    expect(result.succeeded).toBe(1);
  });

  it("fails a missing linked property step when the reload fails, without materializing or holding the run lock", async () => {
    h.properties.properties = [];
    h.properties.fetchProperties.mockRejectedValue(new Error("offline"));
    const errors: any[] = [];

    const result = await pipelinesStore.runPipeline({
      pipeline: pipeline([{ ...propertyStep("p"), sourcePropertyId: "user" }]),
      onStepError: (_index, info) => errors.push(...info.errors),
    });

    expect(result.failed).toBe(1);
    expect(h.properties.createProperty).not.toHaveBeenCalled();
    expect(errors[0].error).toContain("Could not check");
    expect(pipelinesStore.runningPipelineId).toBeNull();
  });

  it("does not rewire a property step without an autoWired flag at run time", async () => {
    h.annotations.submitAnnotationWorkerJob.mockResolvedValue(
      submitResult("j-a", true),
    );
    h.properties.createProperty.mockResolvedValue({
      id: "fresh",
      image: "img/prop",
      shape: AnnotationShape.Polygon,
      tags: { tags: ["cells"], exclusive: false },
      workerInterface: {},
    });
    h.properties.submitPropertyJob.mockResolvedValue(submitResult("j", true));
    // Saved before the flag existed, with manually chosen tags.
    const manualStep = propertyStep("p", ["cells"]);

    await pipelinesStore.runPipeline({
      pipeline: pipeline([annotationStep("a", ["nuclei"]), manualStep]),
    });

    expect(h.properties.createProperty).toHaveBeenCalledWith(
      expect.objectContaining({ tags: { tags: ["cells"], exclusive: false } }),
    );
  });

  it("holds the run lock while it reloads linked properties", async () => {
    h.properties.properties = [];
    let lockDuringReload: string | null = null;
    h.properties.fetchProperties.mockImplementation(async () => {
      lockDuringReload = pipelinesStore.runningPipelineId;
      h.properties.properties = [existingProperty("user")];
    });
    h.properties.submitPropertyJob.mockResolvedValue(submitResult("j", true));

    await pipelinesStore.runPipeline({
      pipeline: pipeline([{ ...propertyStep("p"), sourcePropertyId: "user" }]),
    });

    expect(lockDuringReload).toBe("pipe1");
  });

  it("runs a step already on its fallback when another step's reload fails", async () => {
    h.properties.properties = [
      {
        id: "fallback",
        image: "img/prop",
        shape: AnnotationShape.Polygon,
        tags: { tags: [], exclusive: false },
        workerInterface: {},
      },
    ];
    h.properties.fetchProperties.mockRejectedValue(new Error("offline"));
    h.properties.submitPropertyJob.mockResolvedValue(submitResult("j", true));
    const onFallback = {
      ...propertyStep("a"),
      sourcePropertyId: "gone",
      materializedPropertyId: "fallback",
    };
    const unchecked = { ...propertyStep("b"), sourcePropertyId: "not-loaded" };

    const result = await pipelinesStore.runPipeline({
      pipeline: pipeline([onFallback, unchecked]),
      continueOnError: true,
    });

    expect(result).toMatchObject({ succeeded: 1, failed: 1 });
    expect(h.properties.submitPropertyJob).toHaveBeenCalledWith(
      expect.objectContaining({
        property: expect.objectContaining({ id: "fallback" }),
      }),
    );
  });

  it("does not recheck a linked property a reload confirmed missing", async () => {
    h.properties.properties = [];
    h.properties.createProperty.mockResolvedValue({
      id: "fresh",
      image: "img/prop",
      shape: AnnotationShape.Polygon,
      tags: { tags: [], exclusive: false },
      workerInterface: {},
    });
    h.properties.submitPropertyJob.mockResolvedValue(submitResult("j", true));
    const step = () => ({
      ...propertyStep("p"),
      sourcePropertyId: "confirmed-missing",
    });

    await pipelinesStore.loadMissingLinkedProperties(pipeline([step()]));
    await pipelinesStore.loadMissingLinkedProperties(pipeline([step()]));

    expect(h.properties.fetchProperties).toHaveBeenCalledTimes(1);
  });

  it("fails the run without holding the lock when its steps can't be prepared", async () => {
    // Malformed stored data: an auto-wired property step without inputTags.
    const malformed = { ...propertyStep("p"), autoWired: true } as any;
    delete malformed.inputTags;
    const onComplete = vi.fn();

    const result = await pipelinesStore.runPipeline({
      pipeline: pipeline([annotationStep("a", ["t"]), malformed]),
      onComplete,
    });

    expect(result.failed).toBe(2);
    expect(onComplete).toHaveBeenCalledWith(result);
    expect(pipelinesStore.runningPipelineId).toBeNull();
    expect(h.annotations.submitAnnotationWorkerJob).not.toHaveBeenCalled();
  });

  it("records a new materialized id on the store's current copy of the pipeline", async () => {
    h.properties.createProperty.mockResolvedValue({
      id: "fresh",
      image: "img/prop",
      shape: AnnotationShape.Polygon,
      tags: { tags: [], exclusive: false },
      workerInterface: {},
    });
    h.properties.submitPropertyJob.mockResolvedValue(submitResult("j", true));
    const storeCopy = pipeline([propertyStep("p")]);
    h.main.configuration.pipelines = [storeCopy];

    // Run with a stale copy (as a batch does after its first config write).
    await pipelinesStore.runPipeline({
      pipeline: JSON.parse(JSON.stringify(storeCopy)),
    });

    expect((storeCopy.steps[0] as any).materializedPropertyId).toBe("fresh");
  });

  it("does not confirm a linked property missing when the configuration changes during the reload", async () => {
    h.main.configuration = { ...h.main.configuration, id: "config-a" };
    h.properties.properties = [];
    h.properties.fetchProperties.mockImplementation(async () => {
      // A dataset switch replaces the configuration mid-reload.
      h.main.configuration = { ...h.main.configuration, id: "config-b" };
    });
    const linked = pipeline([
      { ...propertyStep("p"), sourcePropertyId: "switched-during-reload" },
    ]);

    expect(await pipelinesStore.loadMissingLinkedProperties(linked)).toBe(
      false,
    );
    // Not recorded as confirmed missing: the next check reloads again.
    await pipelinesStore.loadMissingLinkedProperties(linked);
    expect(h.properties.fetchProperties).toHaveBeenCalledTimes(2);
  });

  it("does not carry a property found missing in one configuration to another", async () => {
    const shared = {
      id: "shared",
      name: "Shared",
      image: "img/user-prop",
      shape: AnnotationShape.Polygon,
      tags: { tags: ["nuclei"], exclusive: false },
      workerInterface: {},
    };
    const linked = pipeline([
      { ...propertyStep("p", ["nuclei"]), sourcePropertyId: "shared" },
    ]);
    // Configuration B no longer registers the shared property: its reload
    // confirms it missing there.
    h.main.configuration = { ...h.main.configuration, id: "config-b" };
    h.properties.propertiesConfigurationId = "config-b";
    h.properties.properties = [];
    expect(await pipelinesStore.loadMissingLinkedProperties(linked)).toBe(true);
    expect(h.properties.fetchProperties).toHaveBeenCalledTimes(1);

    // Configuration A still registers it, and its properties are still
    // loading (the list is B's) when the pipeline runs.
    h.main.configuration = { ...h.main.configuration, id: "config-a" };
    h.properties.fetchProperties.mockImplementation(async () => {
      h.properties.properties = [shared];
      h.properties.propertiesConfigurationId = "config-a";
    });
    h.properties.submitPropertyJob.mockResolvedValue(submitResult("j", true));

    await pipelinesStore.runPipeline({ pipeline: linked });

    // Reloaded for A, then computed A's property: no fallback duplicate.
    expect(h.properties.fetchProperties).toHaveBeenCalledTimes(2);
    expect(h.properties.createProperty).not.toHaveBeenCalled();
    expect(h.properties.submitPropertyJob).toHaveBeenCalledWith(
      expect.objectContaining({ property: shared }),
    );
  });

  it("reloads linked properties while the loaded list is another configuration's", async () => {
    const shared = {
      id: "shared",
      name: "Shared",
      image: "img/user-prop",
      shape: AnnotationShape.Polygon,
      tags: { tags: ["nuclei"], exclusive: false },
      workerInterface: {},
    };
    // The previous configuration's list happens to hold the property, but
    // that says nothing about whether this configuration registers it.
    h.main.configuration = { ...h.main.configuration, id: "config-a" };
    h.properties.propertiesConfigurationId = "config-b";
    h.properties.properties = [shared];

    await pipelinesStore.loadMissingLinkedProperties(
      pipeline([
        { ...propertyStep("p", ["nuclei"]), sourcePropertyId: "shared" },
      ]),
    );

    expect(h.properties.fetchProperties).toHaveBeenCalledTimes(1);
  });

  it("does not reload properties when every linked property is loaded", async () => {
    h.properties.properties = [existingProperty("user")];
    h.properties.submitPropertyJob.mockResolvedValue(submitResult("j", true));

    await pipelinesStore.runPipeline({
      pipeline: pipeline([{ ...propertyStep("p"), sourcePropertyId: "user" }]),
    });

    expect(h.properties.fetchProperties).not.toHaveBeenCalled();
  });
});

describe("configuration switch during a run", () => {
  // Opening a dataset of another configuration replaces main.configuration
  // (and with it the loaded tools and properties) while a run continues.
  function switchConfiguration() {
    h.main.configuration = {
      id: "config-b",
      pipelines: [],
      propertyIds: [],
      compatibility: { channels: {} },
    };
  }

  // Stubs girderResources' cache invalidation. Store actions dispatch
  // through the root store too, so everything else passes through.
  function stubRessourceChanged() {
    const realDispatch = rootStore.dispatch.bind(rootStore);
    return vi
      .spyOn(rootStore, "dispatch")
      .mockImplementation(((type: string, payload?: unknown) =>
        type === "ressourceChanged"
          ? Promise.resolve()
          : realDispatch(type, payload)) as typeof rootStore.dispatch);
  }

  beforeEach(() => {
    h.main.configuration = { ...h.main.configuration, id: "config-a" };
    // config-a's properties have loaded.
    h.properties.propertiesConfigurationId = "config-a";
  });

  it("fails the next step and stops when the configuration changes during a run", async () => {
    h.properties.properties = [
      {
        id: "user-prop",
        name: "User property",
        image: "img/user-prop",
        shape: AnnotationShape.Polygon,
        tags: { tags: ["nuclei"], exclusive: false },
        workerInterface: {},
      },
    ];
    h.annotations.submitAnnotationWorkerJob.mockImplementation(async () => {
      switchConfiguration();
      return submitResult("j", true);
    });
    const errors: any[] = [];

    const result = await pipelinesStore.runPipeline({
      pipeline: pipeline([
        annotationStep("a", ["nuclei"]),
        { ...propertyStep("p", ["nuclei"]), sourcePropertyId: "user-prop" },
        propertyStep("q", ["nuclei"]),
      ]),
      // Stops even when the caller asked to continue past failures: every
      // later step would fail the same way.
      continueOnError: true,
      onStepError: (_index, info) => errors.push(...info.errors),
    });

    expect(result).toEqual({
      succeeded: 1,
      failed: 1,
      cancelled: 0,
      failedStepIndex: 1,
    });
    expect(h.properties.submitPropertyJob).not.toHaveBeenCalled();
    expect(h.properties.createProperty).not.toHaveBeenCalled();
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toContain(CONFIGURATION_CHANGED_DURING_RUN);
    expect(h.main.updateConfigurationPipelines).not.toHaveBeenCalled();
    expect(pipelinesStore.runningPipelineId).toBeNull();
  });

  it("saves a materialized property id to the run's configuration after a switch", async () => {
    const step = propertyStep("p", ["nuclei"]);
    const pipe = pipeline([step]);
    const configA = h.main.configuration;
    configA.pipelines = [cloneForStore(pipe)];
    h.properties.createProperty.mockResolvedValue({
      id: "prop-created",
      image: "img/prop",
      shape: AnnotationShape.Polygon,
      tags: { tags: ["nuclei"], exclusive: false },
      workerInterface: {},
    });
    h.properties.submitPropertyJob.mockImplementation(async () => {
      switchConfiguration();
      return submitResult("j", true);
    });
    const dispatch = stubRessourceChanged();

    let dispatched: unknown[][];
    try {
      await pipelinesStore.runPipeline({ pipeline: pipe });
    } finally {
      // Copied first: mockRestore clears the recorded calls.
      dispatched = [...dispatch.mock.calls];
      dispatch.mockRestore();
    }

    // Not through the loaded (now other) configuration.
    expect(h.main.updateConfigurationPipelines).not.toHaveBeenCalled();
    expect(h.main.api.updateConfigurationKey).toHaveBeenCalledTimes(1);
    const [written, key] = h.main.api.updateConfigurationKey.mock.calls[0];
    expect(written.id).toBe("config-a");
    expect(key).toBe("pipelines");
    expect(written.pipelines[0].steps[0].materializedPropertyId).toBe(
      "prop-created",
    );
    expect(h.main.configuration.pipelines).toEqual([]);
    expect(dispatched).toContainEqual(["ressourceChanged", "config-a"]);
  });

  it("stops when the property creation sees a configuration switch", async () => {
    const pipe = pipeline([
      propertyStep("p", ["nuclei"]),
      propertyStep("q", ["nuclei"]),
    ]);
    h.main.configuration.pipelines = [cloneForStore(pipe)];
    // createProperty registers nothing and throws when a switch lands during
    // its request (properties.createProperty.test.ts).
    h.properties.createProperty.mockImplementation(async () => {
      switchConfiguration();
      throw new Error("switched during creation");
    });

    const result = await pipelinesStore.runPipeline({
      pipeline: pipe,
      continueOnError: true,
    });

    // One failed step, then the run stops (continueOnError notwithstanding).
    expect(h.properties.createProperty).toHaveBeenCalledTimes(1);
    expect(result.failed).toBe(1);
    expect(h.properties.submitPropertyJob).not.toHaveBeenCalled();
    // Nothing written through the property list or to either configuration.
    expect(h.properties.deleteProperty).not.toHaveBeenCalled();
    expect(h.main.api.updateConfigurationKey).not.toHaveBeenCalled();
    expect(h.main.updateConfigurationPipelines).not.toHaveBeenCalled();
  });

  it("keeps a property created just before a switch and leaves the stale one", async () => {
    const step = propertyStep("p", ["nuclei"]);
    step.materializedPropertyId = "stale";
    const pipe = pipeline([step, annotationStep("a")]);
    const configA = h.main.configuration;
    configA.pipelines = [cloneForStore(pipe)];
    // A drifted property: the step no longer matches it.
    h.properties.properties = [
      {
        id: "stale",
        image: "img/other",
        shape: AnnotationShape.Polygon,
        tags: { tags: ["nuclei"], exclusive: false },
        workerInterface: {},
      },
    ];
    h.properties.createProperty.mockImplementation(async () => {
      // Registered in this configuration, then the switch lands before the
      // stale property would be removed.
      switchConfiguration();
      return {
        id: "prop-created",
        image: "img/prop",
        shape: AnnotationShape.Polygon,
        tags: { tags: ["nuclei"], exclusive: false },
        workerInterface: {},
      };
    });
    h.properties.submitPropertyJob.mockResolvedValue(submitResult("j", true));
    const dispatch = stubRessourceChanged();

    try {
      await pipelinesStore.runPipeline({ pipeline: pipe });
    } finally {
      dispatch.mockRestore();
    }

    // Deleting it would rewrite the loaded configuration's propertyIds from
    // a list that may still be the previous configuration's.
    expect(h.properties.deleteProperty).not.toHaveBeenCalled();
    expect(h.annotations.submitAnnotationWorkerJob).not.toHaveBeenCalled();
    const [written] = h.main.api.updateConfigurationKey.mock.calls[0];
    expect(written.id).toBe("config-a");
    expect(written.pipelines[0].steps[0].materializedPropertyId).toBe(
      "prop-created",
    );
  });

  it("keeps ids materialized before a switch away and back", async () => {
    const pipe = pipeline([propertyStep("p", ["nuclei"]), annotationStep("a")]);
    h.main.configuration.pipelines = [cloneForStore(pipe)];
    // What the server holds: taken now, since the run writes the id onto
    // the step objects it was handed.
    const serverCopy = cloneForStore(pipe);
    h.properties.createProperty.mockResolvedValue({
      id: "prop-created",
      image: "img/prop",
      shape: AnnotationShape.Polygon,
      tags: { tags: ["nuclei"], exclusive: false },
      workerInterface: {},
    });
    h.properties.submitPropertyJob.mockImplementation(async () => {
      // Away to another configuration and back: the configuration is
      // reloaded from the server, without the id merged so far.
      switchConfiguration();
      h.main.configuration = {
        id: "config-a",
        pipelines: [cloneForStore(serverCopy)],
        propertyIds: [],
        compatibility: { channels: {} },
      };
      return submitResult("j", true);
    });
    h.annotations.submitAnnotationWorkerJob.mockResolvedValue(
      submitResult("j2", true),
    );

    await pipelinesStore.runPipeline({ pipeline: pipe });

    expect(h.main.updateConfigurationPipelines).toHaveBeenCalledTimes(1);
    const [written] = h.main.updateConfigurationPipelines.mock.calls[0];
    expect(written[0].steps[0].materializedPropertyId).toBe("prop-created");
  });

  it("does not run a batch's remaining datasets after a configuration switch", async () => {
    h.main.api.findDatasetViews.mockResolvedValue([
      { datasetId: "d1" },
      { datasetId: "d2" },
      { datasetId: "d3" },
    ]);
    const datasetsRun: string[] = [];
    h.annotations.submitAnnotationWorkerJob.mockImplementation(
      async ({ datasetId }: any) => {
        datasetsRun.push(datasetId);
        switchConfiguration();
        return submitResult("j", true);
      },
    );

    const summary = await pipelinesStore.runPipelineBatch({
      pipeline: pipeline([annotationStep("a")]),
      configurationId: "config-a",
    });

    expect(datasetsRun).toEqual(["d1"]);
    expect(summary).toEqual({ succeeded: 1, failed: 2, cancelled: 0 });
    // The batch skips the remaining datasets itself rather than starting
    // runs that fail on their first step.
    const runsStarted = h.progress.create.mock.calls.filter(
      ([entry]: any[]) => entry.title === "Pipeline: Test",
    );
    expect(runsStarted).toHaveLength(1);
    expect(pipelinesStore.runningPipelineId).toBeNull();
  });

  it("does not reload linked properties for a batch whose configuration switched before the reload", async () => {
    h.main.api.findDatasetViews.mockImplementation(async () => {
      // The switch lands while the batch is still listing its datasets.
      switchConfiguration();
      return [{ datasetId: "d1" }];
    });
    const linked = pipeline([
      { ...propertyStep("p"), sourcePropertyId: "not-loaded-yet" },
    ]);

    const summary = await pipelinesStore.runPipelineBatch({
      pipeline: linked,
      configurationId: "config-a",
    });

    expect(summary).toEqual({ succeeded: 0, failed: 1, cancelled: 0 });
    // The other configuration's list says nothing about this source.
    expect(h.properties.fetchProperties).not.toHaveBeenCalled();
    // Not recorded as missing: back on its configuration, a run reloads.
    h.main.configuration = { ...h.main.configuration, id: "config-a" };
    await pipelinesStore.loadMissingLinkedProperties(linked);
    expect(h.properties.fetchProperties).toHaveBeenCalledTimes(1);
  });

  it("fails a batch child that starts after the configuration switched", async () => {
    // The child is handed the batch's configuration, so it fails on its own
    // even if it starts after the switch.
    switchConfiguration();
    const result = await pipelinesStore.runPipeline({
      pipeline: pipeline([annotationStep("a")]),
      configurationId: "config-a",
      skipRunningState: true,
      skipRefresh: true,
    });

    expect(result.failed).toBe(1);
    expect(h.annotations.submitAnnotationWorkerJob).not.toHaveBeenCalled();
  });
});

function cloneForStore(pipe: IPipeline): IPipeline {
  return JSON.parse(JSON.stringify(pipe));
}

describe("removing a property that pipeline steps use", () => {
  function linkedStep(id: string, propertyId: string, enabled = true): any {
    return { ...propertyStep(id), sourcePropertyId: propertyId, enabled };
  }

  it("lists the pipeline steps that use a property", () => {
    const materialized = propertyStep("owned");
    materialized.materializedPropertyId = "user-prop";
    h.main.configuration.pipelines = [
      {
        id: "pipe1",
        name: "Segment and measure",
        steps: [
          annotationStep("segment"),
          linkedStep("measure", "user-prop"),
          linkedStep("other", "another-prop"),
        ],
      },
      {
        id: "pipe2",
        name: "Disabled link",
        steps: [linkedStep("off", "user-prop", false)],
      },
      { id: "pipe3", name: "Materialized only", steps: [materialized] },
      {
        id: "pipe4",
        name: "Second pipeline",
        steps: [linkedStep("again", "user-prop")],
      },
    ];

    // Disabled steps too (they use it again once re-enabled), and a step
    // that created the property: removing it makes each create a new one.
    expect(pipelinesStore.pipelineStepsLinkedToProperty("user-prop")).toEqual([
      {
        pipelineId: "pipe1",
        pipelineName: "Segment and measure",
        stepId: "measure",
        stepName: "measure",
        enabled: true,
        use: "linked",
      },
      {
        pipelineId: "pipe2",
        pipelineName: "Disabled link",
        stepId: "off",
        stepName: "off",
        enabled: false,
        use: "linked",
      },
      {
        pipelineId: "pipe3",
        pipelineName: "Materialized only",
        stepId: "owned",
        stepName: "owned",
        enabled: true,
        use: "created",
      },
      {
        pipelineId: "pipe4",
        pipelineName: "Second pipeline",
        stepId: "again",
        stepName: "again",
        enabled: true,
        use: "linked",
      },
    ]);
    expect(pipelinesStore.pipelineStepsLinkedToProperty("unused")).toEqual([]);
  });

  it("finds the running pipeline that computes a property", () => {
    const materialized = propertyStep("owned");
    materialized.materializedPropertyId = "owned-prop";
    const running: IPipeline = {
      id: "pipe1",
      name: "Running",
      steps: [
        linkedStep("measure", "user-prop"),
        materialized,
        linkedStep("off", "disabled-prop", false),
      ],
    };
    const idle: IPipeline = {
      id: "pipe2",
      name: "Idle",
      steps: [linkedStep("idle", "idle-prop")],
    };
    h.main.configuration.pipelines = [running, idle];

    // Nothing runs: no removal is blocked.
    expect(
      pipelinesStore.runningPipelineComputingProperty("user-prop"),
    ).toBeNull();

    pipelinesStore.setRunningPipelineId("pipe1");
    // A linked property and one the pipeline materialized are both computed
    // by the run; a disabled step's property and another pipeline's are not.
    expect(
      pipelinesStore.runningPipelineComputingProperty("user-prop")?.id,
    ).toBe("pipe1");
    expect(
      pipelinesStore.runningPipelineComputingProperty("owned-prop")?.id,
    ).toBe("pipe1");
    expect(
      pipelinesStore.runningPipelineComputingProperty("disabled-prop"),
    ).toBeNull();
    expect(
      pipelinesStore.runningPipelineComputingProperty("idle-prop"),
    ).toBeNull();
  });
});

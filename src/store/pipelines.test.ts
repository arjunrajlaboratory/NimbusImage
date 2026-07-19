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
    selectedConfigurationId: "cfg1",
    api: {
      cancelJob: vi.fn(),
      findDatasetViews: vi.fn().mockResolvedValue([]),
      batchResources: vi.fn().mockResolvedValue({ folder: {} }),
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
    fetchPropertyValues: vi.fn().mockResolvedValue(undefined),
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
// from it, like `isMaterializedPropertyReferenced` - are real Vuex getters,
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

import pipelinesStore from "./pipelines";
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
  h.main.dataset = { id: "d1", z: [0], time: [0] };
  h.main.isLoggedIn = true;
  h.main.configuration = {
    pipelines: [],
    compatibility: { channels: {} },
  };
  h.properties.properties = [];
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
});

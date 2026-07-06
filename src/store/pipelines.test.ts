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
    dataset: { id: "d1" } as { id: string } | null,
    configuration: {
      pipelines: [] as any[],
      compatibility: { channels: {} as Record<number, string> },
    } as any,
    isLoggedIn: true,
    api: { cancelJob: vi.fn() },
    loadLargeImages: vi.fn().mockResolvedValue(false),
    scheduleTileFramesComputation: vi.fn(),
    scheduleMaxMergeCache: vi.fn(),
    scheduleHistogramCache: vi.fn(),
    updateConfigurationPipelines: vi.fn().mockResolvedValue(undefined),
    chatAPI: { suggestPipelines: vi.fn() },
  },
  annotations: {
    submitAnnotationWorkerJob: vi.fn(),
    fetchAnnotations: vi.fn().mockResolvedValue(undefined),
    annotationTags: new Set<string>(),
    annotations: [] as any[],
  },
  properties: {
    submitPropertyJob: vi.fn(),
    createProperty: vi.fn(),
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

vi.mock("./index", () => ({ default: h.main }));
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
  h.main.dataset = { id: "d1" };
  h.main.isLoggedIn = true;
  h.main.configuration = {
    pipelines: [],
    compatibility: { channels: {} },
  };
  h.properties.properties = [];
  h.properties.workerImageList = {};
  h.annotations.annotationTags = new Set();
  h.annotations.annotations = [];
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
});

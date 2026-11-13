/**
 * Every way out of a worker run must report back, or the worker menu's
 * "running" state never ends (IMPLICIT_STATE_MACHINES.md J2). Exercises the
 * real annotation store actions.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  main: {
    isLoggedIn: true,
    dataset: { id: "ds-1" } as any,
    configuration: { id: "config-1" } as any,
    layers: [],
    scales: {},
    xy: 0,
    z: 0,
    time: 0,
    getLayerFromId: () => null,
    layerSliceIndexes: () => null,
    loadLargeImages: vi.fn(),
    scheduleTileFramesComputation: vi.fn(),
    scheduleMaxMergeCache: vi.fn(),
    scheduleHistogramCache: vi.fn(),
    annotationsAPI: {
      computeAnnotationWithWorker: vi.fn(),
      updateAnnotations: vi.fn(),
      deleteMultipleConnections: vi.fn(),
    },
    api: {
      findDatasetViews: vi.fn(),
      batchResources: vi.fn(),
      cancelJob: vi.fn(),
    },
  },
  addJob: vi.fn(),
  runsInFlight: [] as string[],
  progress: {
    create: vi.fn(),
    complete: vi.fn(),
    update: vi.fn(),
    handleJobProgress: vi.fn(),
  },
}));

vi.mock("./index", () => ({ default: mocks.main }));
vi.mock("./sync", () => ({ default: { setSaving: vi.fn() } }));
vi.mock("./jobs", () => ({
  default: {
    addJob: (...args: any[]) => mocks.addJob(...args),
    toolRunStarted: (key: string) => mocks.runsInFlight.push(key),
    toolRunEnded: (key: string) =>
      mocks.runsInFlight.splice(mocks.runsInFlight.indexOf(key), 1),
  },
  toolRunKey: (...parts: any[]) => parts.join(":"),
  createProgressEventCallback: () => () => {},
  createErrorEventCallback: () => () => {},
}));
vi.mock("./progress", () => ({ default: mocks.progress }));
vi.mock("@/utils/log", () => ({ logError: vi.fn(), logWarning: vi.fn() }));
vi.mock("geojs", () => ({
  default: { util: { pointInPolygon: () => false } },
}));
vi.mock("@/tools/creation/templates/AnnotationConfiguration.vue", () => ({}));

import annotationStore from "./annotation";
import rootStore from "./root";
import { resetBatchRuns } from "./batchRuns";
import { logError } from "@/utils/log";

const tool = {
  id: "tool-1",
  name: "Worker",
  type: "segmentation",
  values: { image: { image: "worker:latest" }, annotation: {} },
} as any;

describe("worker compute actions report back on every path", () => {
  beforeEach(() => {
    mocks.main.dataset = { id: "ds-1" };
    mocks.main.configuration = { id: "config-1" };
    mocks.runsInFlight.length = 0;
    mocks.progress.complete.mockClear();
    mocks.progress.create.mockResolvedValue("progress-1");
    mocks.main.loadLargeImages.mockResolvedValue(false);
    mocks.main.annotationsAPI.computeAnnotationWithWorker.mockResolvedValue({
      data: [{ _id: "job-1" }],
    });
    // The post-job refresh starts with fetchAnnotations; with no
    // configuration loaded it returns at once, which keeps this test to the
    // worker action itself.
    mocks.addJob.mockImplementation(async () => {
      mocks.main.configuration = null;
      return true;
    });
  });

  it("calls back with failure when the worker request rejects", async () => {
    mocks.main.annotationsAPI.computeAnnotationWithWorker.mockRejectedValue(
      new Error("POST failed"),
    );
    const callback = vi.fn();
    const job = await annotationStore.computeAnnotationsWithWorker({
      tool,
      workerInterface: {},
      progress: {},
      error: { errors: [] },
      callback,
    });
    expect(job).toBeNull();
    expect(callback).toHaveBeenCalledWith(false);
    expect(mocks.progress.complete).toHaveBeenCalledWith("progress-1");
  });

  it("marks the run in flight from the request until the job settles", async () => {
    let answerSubmit!: (response: any) => void;
    mocks.main.annotationsAPI.computeAnnotationWithWorker.mockReturnValue(
      new Promise((resolve) => (answerSubmit = resolve)),
    );
    let settleJob!: (success: boolean) => void;
    mocks.addJob.mockReturnValue(
      new Promise<boolean>((resolve) => (settleJob = resolve)),
    );
    const callback = vi.fn();
    const submitted = annotationStore.computeAnnotationsWithWorker({
      tool,
      workerInterface: {},
      progress: {},
      error: { errors: [] },
      callback,
    });
    // Before the submission is answered there is no tracked job, so this
    // mark is all that says the run exists.
    expect(mocks.runsInFlight).toEqual([":ds-1:tool-1"]);
    answerSubmit({ data: [{ _id: "job-1" }] });
    await submitted;
    expect(mocks.runsInFlight).toEqual([":ds-1:tool-1"]);
    mocks.main.configuration = null;
    settleJob(true);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(true));
    expect(mocks.runsInFlight).toEqual([]);
  });

  it("ends the run when the worker request rejects or the job cannot be tracked", async () => {
    mocks.main.annotationsAPI.computeAnnotationWithWorker.mockRejectedValueOnce(
      new Error("POST failed"),
    );
    const run = () =>
      annotationStore.computeAnnotationsWithWorker({
        tool,
        workerInterface: {},
        progress: {},
        error: { errors: [] },
        callback,
      });
    const callback = vi.fn();
    await run();
    expect(mocks.runsInFlight).toEqual([]);

    callback.mockClear();
    mocks.addJob.mockRejectedValue(new Error("no notification stream"));
    await run();
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(false));
    expect(mocks.runsInFlight).toEqual([]);
    expect(mocks.progress.complete).toHaveBeenCalledWith("progress-1");
  });

  it("calls back with the job's outcome when the post-job refresh fails", async () => {
    mocks.main.loadLargeImages.mockRejectedValue(new Error("refresh failed"));
    const callback = vi.fn();
    await annotationStore.computeAnnotationsWithWorker({
      tool,
      workerInterface: {},
      progress: {},
      error: { errors: [] },
      callback,
    });
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(true));
    expect(mocks.progress.complete).toHaveBeenCalledWith("progress-1");
  });

  it("completes a batch whose per-dataset progress entry or final refresh fails", async () => {
    mocks.main.api.findDatasetViews.mockResolvedValue([
      { datasetId: "ds-a" },
      { datasetId: "ds-b" },
    ]);
    mocks.main.api.batchResources.mockResolvedValue({ folder: {} });
    mocks.progress.create
      .mockResolvedValueOnce("batch-progress")
      .mockRejectedValueOnce(new Error("progress failed"))
      .mockResolvedValue("dataset-progress");
    mocks.addJob.mockResolvedValue(true);
    mocks.main.loadLargeImages.mockRejectedValue(new Error("refresh failed"));
    const onComplete = vi.fn();
    await annotationStore.computeAnnotationsWithWorkerBatch({
      tool,
      workerInterface: {},
      configurationId: "config-1",
      onBatchProgress: vi.fn(),
      onJobProgress: vi.fn(),
      onJobError: vi.fn(),
      onCancel: vi.fn(),
      onComplete,
    });
    expect(onComplete).toHaveBeenCalledWith({
      succeeded: 1,
      failed: 1,
      cancelled: 0,
    });
  });

  // Logout settles the tracked job as not successful; the loop must not
  // take that for a failed dataset and go on to the next one.
  it("submits no further batch dataset once the session has ended", async () => {
    mocks.main.api.findDatasetViews.mockResolvedValue([
      { datasetId: "ds-a" },
      { datasetId: "ds-b" },
    ]);
    mocks.main.api.batchResources.mockResolvedValue({ folder: {} });
    mocks.main.annotationsAPI.computeAnnotationWithWorker.mockClear();
    let endJob!: (success: boolean) => void;
    mocks.addJob.mockReset();
    mocks.addJob.mockReturnValue(
      new Promise<boolean>((resolve) => (endJob = resolve)),
    );
    const onComplete = vi.fn();
    const batch = annotationStore.computeAnnotationsWithWorkerBatch({
      tool,
      workerInterface: {},
      configurationId: "config-1",
      onBatchProgress: vi.fn(),
      onJobProgress: vi.fn(),
      onJobError: vi.fn(),
      onCancel: vi.fn(),
      onComplete,
    });
    await vi.waitFor(() => expect(mocks.addJob).toHaveBeenCalled());

    resetBatchRuns();
    endJob(false);
    await batch;

    expect(
      mocks.main.annotationsAPI.computeAnnotationWithWorker,
    ).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith({
      succeeded: 0,
      failed: 0,
      cancelled: 2,
    });
  });
});

// Without `rawError: true`, vuex-module-decorators replaces a propagated error
// with "ERR_ACTION_ACCESS_UNDEFINED: ..." whose stack embeds the original
// message, so only an exact-message assertion tells the two apart.
describe("annotation actions keep the real reason of a failure", () => {
  async function rejectionOf(promise: Promise<unknown>) {
    try {
      await promise;
    } catch (error) {
      return error as Error;
    }
    throw new Error("expected a rejection");
  }

  beforeEach(() => {
    mocks.main.dataset = { id: "ds-1" };
    mocks.main.configuration = { id: "config-1" };
    mocks.progress.create.mockResolvedValue("progress-1");
  });

  it("rejects a pipeline step's worker submit with the request's own error", async () => {
    mocks.main.annotationsAPI.computeAnnotationWithWorker.mockRejectedValue(
      new Error("worker image not found"),
    );
    const error = await rejectionOf(
      annotationStore.submitAnnotationWorkerJob({ tool, datasetId: "ds-1" }),
    );
    expect(error.message).toBe("worker image not found");
  });

  it("rejects a batch whose dataset listing fails with the listing's error", async () => {
    mocks.main.api.findDatasetViews.mockRejectedValue(
      new Error("views listing failed"),
    );
    const error = await rejectionOf(
      annotationStore.computeAnnotationsWithWorkerBatch({
        tool,
        workerInterface: {},
        configurationId: "config-1",
        onBatchProgress: vi.fn(),
        onJobProgress: vi.fn(),
        onJobError: vi.fn(),
        onCancel: vi.fn(),
        onComplete: vi.fn(),
      }),
    );
    expect(error.message).toBe("views listing failed");
  });

  it("logs a batch dataset's failed submit with the request's own error", async () => {
    mocks.main.api.findDatasetViews.mockResolvedValue([{ datasetId: "ds-a" }]);
    mocks.main.api.batchResources.mockResolvedValue({
      folder: { "ds-a": { name: "Dataset A" } },
    });
    mocks.main.annotationsAPI.computeAnnotationWithWorker.mockRejectedValue(
      new Error("worker image not found"),
    );
    mocks.main.loadLargeImages.mockResolvedValue(false);
    vi.mocked(logError).mockClear();
    await annotationStore.computeAnnotationsWithWorkerBatch({
      tool,
      workerInterface: {},
      configurationId: "config-1",
      onBatchProgress: vi.fn(),
      onJobProgress: vi.fn(),
      onJobError: vi.fn(),
      onCancel: vi.fn(),
      onComplete: vi.fn(),
    });
    expect(logError).toHaveBeenCalledWith(
      "Failed to process dataset Dataset A: Error: worker image not found",
    );
  });

  describe("tag and color edits the AI agent reports", () => {
    beforeEach(() => {
      // No legend to retire: colorAnnotationIds' failure cleanup needs a
      // configuration, and this is about the message alone.
      mocks.main.configuration = null;
      const state = (rootStore.state as any).annotation;
      state.stubOnlyMode = true;
      state.annotationStubs = new Map([
        [
          "a1",
          {
            id: "a1",
            color: null,
            tags: ["old"],
            shape: "point",
            channel: 0,
            location: { XY: 0, Z: 0, Time: 0 },
            centroid: { x: 0, y: 0 },
            estimatedRadius: 1,
          },
        ],
      ]);
      mocks.main.annotationsAPI.updateAnnotations.mockRejectedValue(
        new Error("annotation save failed"),
      );
    });

    afterEach(() => {
      const state = (rootStore.state as any).annotation;
      state.stubOnlyMode = false;
      state.annotationStubs = new Map();
    });

    it.each([
      [
        "addTagsByAnnotationIds",
        () =>
          annotationStore.addTagsByAnnotationIds({
            annotationIds: ["a1"],
            tags: ["new"],
          }),
      ],
      [
        "replaceTagsByAnnotationIds",
        () =>
          annotationStore.replaceTagsByAnnotationIds({
            annotationIds: ["a1"],
            tags: ["new"],
          }),
      ],
      [
        "removeTagsByAnnotationIds",
        () =>
          annotationStore.removeTagsByAnnotationIds({
            annotationIds: ["a1"],
            tags: ["old"],
          }),
      ],
      [
        "colorAnnotationIds",
        () =>
          annotationStore.colorAnnotationIds({
            annotationIds: ["a1"],
            color: "#ff0000",
          }),
      ],
    ])("%s rejects with the save's own error", async (_name, edit) => {
      const error = await rejectionOf(edit());
      expect(error.message).toBe("annotation save failed");
    });
  });

  it("rejects a failed connection delete with the request's own error", async () => {
    mocks.main.annotationsAPI.deleteMultipleConnections.mockRejectedValue(
      new Error("connection delete failed"),
    );
    const error = await rejectionOf(annotationStore.deleteConnections(["c1"]));
    expect(error.message).toBe("connection delete failed");
  });
});

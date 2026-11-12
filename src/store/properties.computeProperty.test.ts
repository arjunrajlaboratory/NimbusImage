import { beforeEach, describe, expect, it, vi } from "vitest";
import { watch } from "vue";

const mocks = vi.hoisted(() => ({
  computeProperty: vi.fn(),
  computeProperties: vi.fn(),
  getPropertyValues: vi.fn(),
  addJob: vi.fn(),
  createProgress: vi.fn(),
  completeProgress: vi.fn(),
  createNotification: vi.fn(),
  updateHistograms: vi.fn(),
  findDatasetViews: vi.fn(),
  batchResources: vi.fn(),
  updateProgress: vi.fn(),
}));

vi.mock("@/store/index", () => ({
  default: {
    dataset: { id: "dataset-1" },
    isLoggedIn: true,
    scales: {},
    propertiesAPI: {
      computeProperty: (...args: any[]) => mocks.computeProperty(...args),
      computeProperties: (...args: any[]) => mocks.computeProperties(...args),
      getPropertyValues: (...args: any[]) => mocks.getPropertyValues(...args),
    },
    scheduleAnnotationBrowserSave: vi.fn(),
    api: {
      findDatasetViews: (...args: any[]) => mocks.findDatasetViews(...args),
      batchResources: (...args: any[]) => mocks.batchResources(...args),
      cancelJob: vi.fn(),
    },
  },
}));

vi.mock("@/store/annotation", () => ({
  default: {
    annotations: [],
    stubOnlyMode: false,
    visibleAnnotationIds: new Set<string>(),
  },
}));

vi.mock("@/store/jobs", () => ({
  default: {
    addJob: (...args: any[]) => mocks.addJob(...args),
  },
  createProgressEventCallback: () => vi.fn(),
  createErrorEventCallback: () => vi.fn(),
}));

vi.mock("@/store/progress", () => ({
  default: {
    create: (...args: any[]) => mocks.createProgress(...args),
    complete: (...args: any[]) => mocks.completeProgress(...args),
    update: (...args: any[]) => mocks.updateProgress(...args),
    createNotification: (...args: any[]) => mocks.createNotification(...args),
    handleJobProgress: vi.fn(),
  },
}));

vi.mock("@/store/filters", () => ({
  default: {
    updateHistograms: (...args: any[]) => mocks.updateHistograms(...args),
  },
}));

vi.mock("@/utils/log", () => ({
  logError: vi.fn(),
  logWarning: vi.fn(),
}));

vi.mock("geojs", () => ({ default: { util: {} } }));

import properties from "@/store/properties";
import type { IAnnotationProperty, IErrorInfoList } from "@/store/model";

const property = {
  id: "property-1",
  name: "Area",
  image: "worker:latest",
  shape: "polygon",
  tags: { tags: [], exclusive: false },
  workerInterface: {},
} as IAnnotationProperty;

function status() {
  return properties.propertyStatuses[property.id];
}

describe("property compute lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    properties.resetPropertyState();
    mocks.createProgress.mockResolvedValue("progress-1");
    mocks.computeProperty.mockResolvedValue({ data: [{ _id: "job-1" }] });
    mocks.computeProperties.mockResolvedValue([
      { propertyId: property.id, jobs: [{ _id: "job-1" }] },
    ]);
    mocks.addJob.mockResolvedValue(true);
    mocks.getPropertyValues.mockResolvedValue({});
    mocks.updateHistograms.mockResolvedValue(undefined);
  });

  it("cleans up and surfaces an API submission failure", async () => {
    mocks.computeProperty.mockRejectedValue(new Error("backend unavailable"));
    const errorInfo: IErrorInfoList = { errors: [] };

    const result = await properties.computeProperty({ property, errorInfo });

    expect(result).toBeNull();
    expect(status()).toMatchObject({ running: false, previousRun: false });
    expect(errorInfo.errors).toEqual([
      expect.objectContaining({
        title: "Property submission failed",
        error: "backend unavailable",
      }),
    ]);
    expect(mocks.completeProgress).toHaveBeenCalledWith("progress-1");
  });

  it("cleans up and surfaces a response without a job id", async () => {
    mocks.computeProperty.mockResolvedValue({ data: [] });
    const errorInfo: IErrorInfoList = { errors: [] };

    const result = await properties.computeProperty({ property, errorInfo });

    expect(result).toBeNull();
    expect(status()).toMatchObject({ running: false, previousRun: false });
    expect(errorInfo.errors[0]?.error).toContain(
      "did not return a compute job",
    );
    expect(mocks.completeProgress).toHaveBeenCalledWith("progress-1");
  });

  it("cleans up and surfaces job tracking failures", async () => {
    mocks.addJob.mockRejectedValue(new Error("websocket failed"));
    const errorInfo: IErrorInfoList = { errors: [] };

    await properties.computeProperty({ property, errorInfo });

    await vi.waitFor(() => expect(status().running).toBe(false));
    expect(status().previousRun).toBe(false);
    expect(errorInfo.errors).toEqual([
      expect.objectContaining({ error: "websocket failed" }),
    ]);
    expect(mocks.completeProgress).toHaveBeenCalledWith("progress-1");
  });

  it("cleans up and surfaces post-job refresh failures", async () => {
    mocks.getPropertyValues.mockRejectedValue(new Error("refresh failed"));
    const errorInfo: IErrorInfoList = { errors: [] };

    await properties.computeProperty({ property, errorInfo });

    await vi.waitFor(() => expect(status().running).toBe(false));
    expect(status().previousRun).toBe(false);
    expect(errorInfo.errors).toEqual([
      expect.objectContaining({
        title: "Property refresh failed",
        error: "refresh failed",
      }),
    ]);
    expect(mocks.completeProgress).toHaveBeenCalledWith("progress-1");
  });

  it("marks a successful run complete after refreshing values and histograms", async () => {
    const errorInfo: IErrorInfoList = { errors: [] };

    await properties.computeProperty({ property, errorInfo });

    await vi.waitFor(() => expect(status().running).toBe(false));
    expect(status().previousRun).toBe(true);
    expect(mocks.getPropertyValues).toHaveBeenCalledTimes(1);
    expect(mocks.updateHistograms).toHaveBeenCalledTimes(1);
    expect(mocks.completeProgress).toHaveBeenCalledWith("progress-1");
  });

  it("surfaces worker failure when job completes unsuccessfully", async () => {
    mocks.addJob.mockResolvedValue(false);
    const errorInfo: IErrorInfoList = { errors: [] };

    await properties.computeProperty({ property, errorInfo });

    await vi.waitFor(() => expect(status().running).toBe(false));
    expect(status().previousRun).toBe(false);
    expect(errorInfo.errors).toEqual([
      expect.objectContaining({
        title: "Property computation failed",
        error: "The worker job did not complete successfully.",
      }),
    ]);
    expect(mocks.completeProgress).toHaveBeenCalledWith("progress-1");
  });

  it("cleans up batch state when the batch API rejects", async () => {
    mocks.computeProperties.mockRejectedValue(new Error("batch unavailable"));
    const secondProperty = {
      ...property,
      id: "property-2",
      name: "Perimeter",
    };

    const result = await properties.computeProperties([
      property,
      secondProperty,
    ]);

    expect(result).toEqual([]);
    expect(status()).toMatchObject({ running: false, previousRun: false });
    expect(properties.propertyStatuses[secondProperty.id]).toMatchObject({
      running: false,
      previousRun: false,
    });
    expect(status().errorInfo?.errors).toEqual([
      expect.objectContaining({
        title: "Property submission failed",
        error: "batch unavailable",
      }),
    ]);
    expect(mocks.completeProgress).toHaveBeenCalledWith("progress-1");
    expect(mocks.createNotification).toHaveBeenCalledTimes(1);
  });

  // The UI reads `running` reactively. A status created by the run itself
  // must be written through the store, or the spinner never clears.
  function watchRunning() {
    const seen: (boolean | undefined)[] = [];
    const stop = watch(
      () => properties.propertyStatuses[property.id]?.running,
      (running) => seen.push(running),
      { flush: "sync" },
    );
    return { seen, stop };
  }

  it("tells the UI a first batch run stopped after the API rejects", async () => {
    mocks.computeProperties.mockRejectedValue(new Error("batch unavailable"));
    const { seen, stop } = watchRunning();

    await properties.computeProperties([property]);
    stop();

    expect(seen).toEqual([false, true, false]);
  });

  it("tells the UI a first single run stopped after the API rejects", async () => {
    mocks.computeProperty.mockRejectedValue(new Error("worker unavailable"));
    const { seen, stop } = watchRunning();

    await properties.computeProperty({ property });
    stop();

    expect(seen).toEqual([false, true, false]);
  });

  it("cleans up batch state when the server omits a job", async () => {
    mocks.computeProperties.mockResolvedValue([
      { propertyId: property.id, jobs: [] },
    ]);

    const result = await properties.computeProperties([property]);

    expect(result).toEqual([]);
    expect(status()).toMatchObject({ running: false, previousRun: false });
    expect(status().errorInfo?.errors[0]?.error).toContain(
      "did not return a compute job",
    );
    expect(mocks.completeProgress).toHaveBeenCalledWith("progress-1");
  });

  it("applies the same cleanup guarantee to batch job tracking failures", async () => {
    mocks.addJob.mockRejectedValue(new Error("subscription failed"));

    await properties.computeProperties([property]);

    await vi.waitFor(() => expect(status().running).toBe(false));
    expect(status().previousRun).toBe(false);
    expect(status().errorInfo?.errors).toEqual([
      expect.objectContaining({ error: "subscription failed" }),
    ]);
    expect(mocks.completeProgress).toHaveBeenCalledWith("progress-1");
  });

  it("does not strand batch state when progress creation fails", async () => {
    mocks.createProgress.mockRejectedValue(new Error("progress store failed"));

    const result = await properties.computeProperties([property]);

    expect(result).toEqual([]);
    expect(status()).toMatchObject({ running: false, previousRun: false });
    expect(status().errorInfo?.errors).toEqual([
      expect.objectContaining({ error: "progress store failed" }),
    ]);
    expect(mocks.computeProperties).not.toHaveBeenCalled();
  });

  it("submits at most 100 properties so the client matches the server limit", async () => {
    const requested = Array.from({ length: 101 }, (_, index) => ({
      ...property,
      id: `property-${index}`,
      name: `Property ${index}`,
    }));
    mocks.computeProperties.mockResolvedValue([]);

    await properties.computeProperties(requested);

    expect(mocks.computeProperties).toHaveBeenCalledWith(
      "dataset-1",
      requested.slice(0, 100),
      {},
    );
  });
});

describe("property batch compute lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    properties.resetPropertyState();
    mocks.createProgress.mockResolvedValue("progress-1");
    mocks.computeProperty.mockResolvedValue({ data: [{ _id: "job-1" }] });
    mocks.addJob.mockResolvedValue(true);
    mocks.getPropertyValues.mockResolvedValue({});
    mocks.updateHistograms.mockResolvedValue(undefined);
    mocks.findDatasetViews.mockResolvedValue([
      { datasetId: "ds-a" },
      { datasetId: "ds-b" },
    ]);
    mocks.batchResources.mockResolvedValue({ folder: {} });
  });

  function runBatch(onComplete = vi.fn()) {
    return properties.computePropertyBatch({
      property,
      configurationId: "config-1",
      onBatchProgress: vi.fn(),
      onCancel: vi.fn(),
      onComplete,
    });
  }

  it("releases the running state when listing the batch's datasets fails", async () => {
    mocks.findDatasetViews.mockRejectedValue(new Error("listing failed"));

    await expect(runBatch()).rejects.toThrow("listing failed");

    expect(status()).toMatchObject({ running: false, previousRun: false });
  });

  it("finishes the batch when a dataset's progress entry cannot be created", async () => {
    mocks.createProgress
      .mockResolvedValueOnce("batch-progress")
      .mockRejectedValueOnce(new Error("progress failed"))
      .mockResolvedValue("dataset-progress");
    const onComplete = vi.fn();

    await runBatch(onComplete);

    expect(onComplete).toHaveBeenCalledWith({
      succeeded: 1,
      failed: 1,
      cancelled: 0,
    });
    expect(status()).toMatchObject({ running: false, previousRun: false });
  });

  // `running` is a flag, so a property runs once at a time: a second run
  // would let the first to finish clear it while the other still runs.
  describe("overlapping runs of one property", () => {
    let releaseJobs!: (success: boolean) => void;

    beforeEach(() => {
      const jobsDone = new Promise<boolean>((resolve) => {
        releaseJobs = resolve;
      });
      mocks.addJob.mockReturnValue(jobsDone);
    });

    function watchRunning() {
      const seen: (boolean | undefined)[] = [];
      const stop = watch(
        () => properties.propertyStatuses[property.id]?.running,
        (running) => seen.push(running),
        { flush: "sync" },
      );
      return { seen, stop };
    }

    it("refuses a batch while a single run of the property is running", async () => {
      const { seen, stop } = watchRunning();
      await properties.computeProperty({ property });
      const onCancel = vi.fn();

      const started = await properties.computePropertyBatch({
        property,
        configurationId: "config-1",
        onBatchProgress: vi.fn(),
        onCancel,
        onComplete: vi.fn(),
      });

      expect(started).toBe(false);
      expect(onCancel).not.toHaveBeenCalled();
      expect(mocks.findDatasetViews).not.toHaveBeenCalled();
      expect(status().running).toBe(true);

      releaseJobs(true);
      await vi.waitFor(() => expect(status().running).toBe(false));
      stop();
      expect(seen).toEqual([false, true, false]);
    });

    it("records a refused batch on the property's status, without a toast", async () => {
      const errorInfo: IErrorInfoList = { errors: [] };
      await properties.computeProperty({ property, errorInfo });

      const started = await runBatch();

      expect(started).toBe(false);
      expect(status().errorInfo?.errors.map(({ title }) => title)).toEqual([
        "Property is already computing",
      ]);
      expect(mocks.createNotification).not.toHaveBeenCalled();

      // The refusal does not stand in for the running run's own failure, and
      // it ends with the run it was refused for.
      releaseJobs(false);
      await vi.waitFor(() => expect(status().running).toBe(false));
      expect(status().errorInfo?.errors.map(({ title }) => title)).toEqual([
        "Property computation failed",
      ]);
    });

    it("drops a refusal when the run it was refused for succeeds", async () => {
      const errorInfo: IErrorInfoList = { errors: [] };
      await properties.computeProperty({ property, errorInfo });
      expect(await runBatch()).toBe(false);
      expect(await runBatch()).toBe(false);
      expect(status().errorInfo?.errors).toHaveLength(2);

      releaseJobs(true);
      await vi.waitFor(() => expect(status().running).toBe(false));
      expect(status().previousRun).toBe(true);
      expect(status().errorInfo?.errors).toEqual([]);
    });

    it("drops a refusal recorded during a batch when the batch ends", async () => {
      const batch = runBatch();
      await vi.waitFor(() => expect(mocks.addJob).toHaveBeenCalled());
      expect(await runBatch()).toBe(false);
      expect(status().errorInfo?.errors.map(({ title }) => title)).toEqual([
        "Property is already computing",
      ]);

      releaseJobs(true);
      await expect(batch).resolves.toBe(true);
      expect(status().errorInfo?.errors).toEqual([]);
    });

    it("starts a batch without the previous run's errors", async () => {
      await properties.computeProperty({ property });
      releaseJobs(false);
      await vi.waitFor(() => expect(status().running).toBe(false));
      expect(status().errorInfo?.errors).toHaveLength(1);

      // jobsDone is already settled (false); the batch's jobs succeed.
      mocks.addJob.mockResolvedValue(true);
      await runBatch();

      expect(status().previousRun).toBe(true);
      expect(status().errorInfo?.errors).toEqual([]);
    });

    describe("across a property-state reset", () => {
      it("refuses a second start after a reset while the first run is in flight", async () => {
        await properties.computeProperty({ property });
        properties.resetPropertyState();

        expect(await properties.computeProperty({ property })).toBeNull();
        expect(await runBatch()).toBe(false);
        expect(mocks.computeProperty).toHaveBeenCalledTimes(1);

        releaseJobs(true);
        await vi.waitFor(() => expect(status().running).toBe(false));
      });

      it("keeps an in-flight status reactive across a reset", async () => {
        const batch = runBatch();
        await vi.waitFor(() => expect(mocks.addJob).toHaveBeenCalled());
        properties.resetPropertyState();
        const { seen, stop } = watchRunning();

        releaseJobs(true);
        await expect(batch).resolves.toBe(true);
        stop();

        expect(seen).toEqual([false]);
        expect(status()).toMatchObject({ running: false, previousRun: true });
      });

      it("drops a settled status on reset", async () => {
        await properties.computeProperty({ property });
        releaseJobs(true);
        await vi.waitFor(() => expect(status().running).toBe(false));

        properties.resetPropertyState();

        expect(properties.propertyStatuses).toEqual({});
      });
    });

    it("refuses a single run while a batch of the property is running", async () => {
      const { seen, stop } = watchRunning();
      const batch = runBatch();
      await vi.waitFor(() => expect(mocks.addJob).toHaveBeenCalled());
      const errorInfo: IErrorInfoList = { errors: [] };

      const job = await properties.computeProperty({ property, errorInfo });

      expect(job).toBeNull();
      expect(errorInfo.errors[0]?.title).toBe("Property is already computing");
      expect(mocks.createNotification).not.toHaveBeenCalled();
      // Only the batch's first dataset was submitted
      expect(mocks.computeProperty).toHaveBeenCalledTimes(1);
      expect(status().running).toBe(true);

      releaseJobs(true);
      await expect(batch).resolves.toBe(true);
      stop();
      expect(status().running).toBe(false);
      expect(seen).toEqual([false, true, false]);
    });

    it("refuses a second single run until the first finishes", async () => {
      await properties.computeProperty({ property });

      expect(await properties.computeProperty({ property })).toBeNull();
      expect(mocks.computeProperty).toHaveBeenCalledTimes(1);

      releaseJobs(true);
      await vi.waitFor(() => expect(status().running).toBe(false));
      expect(status().previousRun).toBe(true);
    });
  });
});

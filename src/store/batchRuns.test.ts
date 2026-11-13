import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watch } from "vue";
import batchRuns, {
  BATCH_PROGRESS_LINGER_MS,
  IBatchHooks,
  resetBatchRuns,
  runBatch,
} from "@/store/batchRuns";

const progress = (currentDatasetName: string) => ({
  total: 2,
  completed: 1,
  failed: 0,
  cancelled: 0,
  currentDatasetName,
});

describe("batch runs", () => {
  beforeEach(() => {
    resetBatchRuns();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refuses a second batch of the same run while the first is in flight", async () => {
    const start = vi.fn(() => new Promise(() => {}));
    void runBatch("workerTool", "config-1", "tool-1", 2, start);

    const second = await runBatch("workerTool", "config-1", "tool-1", 2, start);

    expect(second).toEqual({
      started: false,
      results: null,
      cancelRequested: false,
    });
    expect(start).toHaveBeenCalledTimes(1);
    // Another tool's batch is its own run
    void runBatch("workerTool", "config-1", "tool-2", 2, start);
    expect(start).toHaveBeenCalledTimes(2);
  });

  // The results cannot tell: a cancel after the last job ended cancels none.
  it("reports that its cancel was called, whatever the results count", async () => {
    const cancelJobs = vi.fn();
    const result = runBatch(
      "property",
      "config-1",
      "property-1",
      2,
      async (hooks) => {
        hooks.onCancel(cancelJobs);
        batchRuns.batchRun("property", "config-1", "property-1")?.cancel?.();
        hooks.onComplete({ succeeded: 2, failed: 0, cancelled: 0 });
      },
    );

    expect(await result).toMatchObject({ cancelRequested: true });
    expect(cancelJobs).toHaveBeenCalledTimes(1);
  });

  it("tells the UI about the progress and release of a run it just created", async () => {
    const seen: (string | boolean | null | undefined)[] = [];
    const stop = watch(
      () => {
        const run = batchRuns.batchRun("property", "config-1", "property-1");
        return run
          ? `${run.inFlight}:${run.progress?.currentDatasetName ?? null}`
          : null;
      },
      (value) => seen.push(value),
      { flush: "sync" },
    );
    let hooks!: IBatchHooks;
    let finish!: () => void;
    const batch = runBatch(
      "property",
      "config-1",
      "property-1",
      2,
      (batchHooks) =>
        new Promise<void>((resolve) => {
          hooks = batchHooks;
          finish = resolve;
        }),
    );

    hooks.onBatchProgress(progress("dataset-a"));
    finish();
    await batch;
    stop();

    expect(seen).toEqual([
      "true:Starting...",
      "true:dataset-a",
      "false:dataset-a",
    ]);
  });

  it("releases the run and clears its progress when the action throws", async () => {
    const cancel = vi.fn();
    await expect(
      runBatch(
        "property",
        "config-1",
        "property-1",
        2,
        async ({ onCancel }) => {
          onCancel(cancel);
          throw new Error("listing failed");
        },
      ),
    ).rejects.toThrow("listing failed");

    expect(batchRuns.batchRun("property", "config-1", "property-1")).toEqual({
      configurationId: "config-1",
      inFlight: false,
      progress: null,
      cancel: null,
    });
    expect(batchRuns.anyInFlight("property", "config-1")).toBe(false);
  });

  it("clears the progress at once when the action refuses to start", async () => {
    const result = await runBatch(
      "property",
      "config-1",
      "property-1",
      2,
      async () => false,
    );

    expect(result.started).toBe(true);
    expect(
      batchRuns.batchRun("property", "config-1", "property-1")?.progress,
    ).toBeNull();
  });

  it("returns the results and lets a finished batch's progress linger", async () => {
    vi.useFakeTimers();
    const result = await runBatch(
      "workerTool",
      "config-1",
      "tool-1",
      2,
      async ({ onBatchProgress, onComplete }) => {
        onBatchProgress(progress("dataset-b"));
        onComplete({ succeeded: 2, failed: 0, cancelled: 0 });
      },
    );

    expect(result).toEqual({
      started: true,
      results: { succeeded: 2, failed: 0, cancelled: 0 },
      cancelRequested: false,
    });
    expect(
      batchRuns.shownRun("workerTool", "config-1")?.progress
        ?.currentDatasetName,
    ).toBe("dataset-b");
    await vi.advanceTimersByTimeAsync(BATCH_PROGRESS_LINGER_MS);
    expect(
      batchRuns.batchRun("workerTool", "config-1", "tool-1")?.progress,
    ).toBeNull();
    expect(batchRuns.shownRun("workerTool", "config-1")).toBeNull();
  });

  it("never lets a finished batch's hide timer clear the next batch's progress", async () => {
    vi.useFakeTimers();
    await runBatch("property", "config-1", "property-1", 2, async () => {});
    await vi.advanceTimersByTimeAsync(BATCH_PROGRESS_LINGER_MS - 1);
    let finish!: () => void;
    const next = runBatch(
      "property",
      "config-1",
      "property-1",
      2,
      ({ onBatchProgress }) =>
        new Promise<void>((resolve) => {
          onBatchProgress(progress("next"));
          finish = resolve;
        }),
    );

    await vi.advanceTimersByTimeAsync(1);
    expect(
      batchRuns.batchRun("property", "config-1", "property-1")?.progress
        ?.currentDatasetName,
    ).toBe("next");

    finish();
    await next;
    // The next batch lingers for its own full period
    await vi.advanceTimersByTimeAsync(BATCH_PROGRESS_LINGER_MS - 1);
    expect(
      batchRuns.batchRun("property", "config-1", "property-1")?.progress,
    ).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(
      batchRuns.batchRun("property", "config-1", "property-1")?.progress,
    ).toBeNull();
  });

  it("does not cut short the linger of a next batch that ends before the previous hide", async () => {
    vi.useFakeTimers();
    await runBatch("property", "config-1", "property-1", 2, async () => {});
    await vi.advanceTimersByTimeAsync(BATCH_PROGRESS_LINGER_MS - 1);
    // A quick next batch ends before the previous batch's hide is due
    await runBatch(
      "property",
      "config-1",
      "property-1",
      2,
      async ({ onBatchProgress }) => onBatchProgress(progress("next")),
    );

    await vi.advanceTimersByTimeAsync(1);
    expect(
      batchRuns.batchRun("property", "config-1", "property-1")?.progress
        ?.currentDatasetName,
    ).toBe("next");
    await vi.advanceTimersByTimeAsync(BATCH_PROGRESS_LINGER_MS - 1);
    expect(
      batchRuns.batchRun("property", "config-1", "property-1")?.progress,
    ).toBeNull();
  });

  it("keeps one collection's batch out of another that shares its ids", async () => {
    let finish!: () => void;
    void runBatch(
      "property",
      "config-1",
      "property-1",
      2,
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );

    // A duplicated collection keeps the same property and tool ids
    expect(batchRuns.batchRun("property", "config-copy", "property-1")).toBe(
      null,
    );
    expect(batchRuns.anyInFlight("property", "config-copy")).toBe(false);
    expect(batchRuns.shownRun("property", "config-copy")).toBeNull();
    expect(batchRuns.anyInFlight("property", "config-1")).toBe(true);
    expect(batchRuns.shownRun("property", "config-1")?.inFlight).toBe(true);

    const start = vi.fn(() => new Promise(() => {}));
    void runBatch("property", "config-copy", "property-1", 2, start);
    expect(start).toHaveBeenCalledTimes(1);
    finish();
  });

  it("forgets every batch on reset and keeps a batch that outlives it from writing", async () => {
    vi.useFakeTimers();
    let hooks!: IBatchHooks;
    let finish!: () => void;
    const before = runBatch(
      "workerTool",
      "config-1",
      "tool-1",
      2,
      (batchHooks) =>
        new Promise<void>((resolve) => {
          hooks = batchHooks;
          finish = resolve;
        }),
    );
    await runBatch("property", "config-1", "property-1", 2, async () => {});

    resetBatchRuns();

    expect(batchRuns.shownRun("workerTool", "config-1")).toBeNull();
    expect(batchRuns.shownRun("property", "config-1")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);

    // The next session starts the same run; the old batch finishing later
    // must not report into it, release it or schedule a hide.
    void runBatch(
      "workerTool",
      "config-1",
      "tool-1",
      2,
      () => new Promise(() => {}),
    );
    hooks.onBatchProgress(progress("old session"));
    // Nor hand it a cancel that would stop the old session's jobs
    hooks.onCancel(vi.fn());
    finish();
    await before;

    const run = batchRuns.batchRun("workerTool", "config-1", "tool-1");
    expect(run?.inFlight).toBe(true);
    expect(run?.progress?.currentDatasetName).toBe("Starting...");
    expect(run?.cancel).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});

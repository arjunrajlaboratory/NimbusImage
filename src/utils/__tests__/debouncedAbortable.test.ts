import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createDebouncedAbortableTask,
  isAbortError,
} from "@/utils/debouncedAbortable";

describe("isAbortError", () => {
  it("detects an axios CanceledError", () => {
    expect(isAbortError({ name: "CanceledError", code: "ERR_CANCELED" })).toBe(
      true,
    );
  });

  it("detects a DOMException AbortError", () => {
    expect(isAbortError({ name: "AbortError" })).toBe(true);
  });

  it("returns false for a generic error", () => {
    expect(isAbortError(new Error("network down"))).toBe(false);
  });

  it("returns false for non-objects", () => {
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
    expect(isAbortError("nope")).toBe(false);
  });
});

describe("createDebouncedAbortableTask", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces rapid schedules into one run with the latest payload", () => {
    const run = vi.fn();
    const task = createDebouncedAbortableTask<string>(run, 200);

    task.schedule("a");
    task.schedule("b");
    task.schedule("c");

    vi.advanceTimersByTime(199);
    expect(run).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toBe("c");
    expect(run.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
  });

  it("aborts the previous run's signal when a new run fires", () => {
    const run = vi.fn();
    const task = createDebouncedAbortableTask<string>(run, 200);

    task.schedule("a");
    vi.advanceTimersByTime(200);
    const firstSignal: AbortSignal = run.mock.calls[0][1];
    expect(firstSignal.aborted).toBe(false);

    task.schedule("b");
    vi.advanceTimersByTime(200);
    const secondSignal: AbortSignal = run.mock.calls[1][1];

    expect(firstSignal.aborted).toBe(true);
    expect(secondSignal.aborted).toBe(false);
  });

  it("cancel() prevents a pending scheduled run from firing", () => {
    const run = vi.fn();
    const task = createDebouncedAbortableTask<string>(run, 200);

    task.schedule("a");
    task.cancel();
    vi.advanceTimersByTime(500);

    expect(run).not.toHaveBeenCalled();
  });

  it("cancel() aborts the most recent in-flight run's signal", () => {
    const run = vi.fn();
    const task = createDebouncedAbortableTask<string>(run, 200);

    task.schedule("a");
    vi.advanceTimersByTime(200);
    const signal: AbortSignal = run.mock.calls[0][1];
    expect(signal.aborted).toBe(false);

    task.cancel();
    expect(signal.aborted).toBe(true);
  });
});

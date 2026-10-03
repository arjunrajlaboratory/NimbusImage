import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  computeProperty: vi.fn(),
  getPropertyValues: vi.fn(),
  addJob: vi.fn(),
  createProgress: vi.fn(),
  completeProgress: vi.fn(),
  createNotification: vi.fn(),
  updateHistograms: vi.fn(),
}));

vi.mock("@/store/index", () => ({
  default: {
    dataset: { id: "dataset-1" },
    isLoggedIn: true,
    scales: {},
    propertiesAPI: {
      computeProperty: (...args: any[]) => mocks.computeProperty(...args),
      getPropertyValues: (...args: any[]) => mocks.getPropertyValues(...args),
    },
    scheduleAnnotationBrowserSave: vi.fn(),
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

  it("cleans up batch state when every submission rejects", async () => {
    mocks.computeProperty.mockRejectedValue(new Error("backend unavailable"));
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
        error: "backend unavailable",
      }),
    ]);
    expect(mocks.completeProgress).toHaveBeenCalledWith("progress-1");
    // Shared-cause failures collapse to a single notification.
    expect(mocks.createNotification).toHaveBeenCalledTimes(1);
  });

  it("cleans up batch state when the server omits a job", async () => {
    mocks.computeProperty.mockResolvedValue({ data: [] });

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
    expect(mocks.computeProperty).not.toHaveBeenCalled();
  });

  it("submits at most 100 properties per compute-all run", async () => {
    const requested = Array.from({ length: 101 }, (_, index) => ({
      ...property,
      id: `property-${index}`,
      name: `Property ${index}`,
    }));

    await properties.computeProperties(requested);

    expect(mocks.computeProperty).toHaveBeenCalledTimes(100);
    expect(mocks.computeProperty).not.toHaveBeenCalledWith(
      "property-100",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });
});

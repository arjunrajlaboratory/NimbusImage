import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { enableAutoUnmount, shallowMount } from "@vue/test-utils";

const mocks = vi.hoisted(() => ({
  computePropertyBatch: vi.fn(),
}));

vi.mock("@/store", () => ({
  default: {
    selectedConfigurationId: "config-1",
    getCollectionDatasetCount: vi.fn().mockResolvedValue(3),
  },
}));

vi.mock("@/store/properties", () => ({
  default: {
    computedPropertyPaths: [],
    computePropertyBatch: (...args: any[]) =>
      mocks.computePropertyBatch(...args),
  },
}));

vi.mock("@/utils/log", () => ({ logError: vi.fn(), logWarning: vi.fn() }));

import AnalyzeDialog from "./AnalyzeDialog.vue";
import store from "@/store";
import batchRuns, { resetBatchRuns, runBatch } from "@/store/batchRuns";

enableAutoUnmount(afterEach);

const property = { id: "property-1", name: "Area" } as any;

function mountDialog() {
  return shallowMount(AnalyzeDialog, {
    props: { modelValue: true },
    global: { stubs: { AnalyzePanel: true, PropertyPicker: true } },
  });
}

describe("AnalyzeDialog batch compute", () => {
  beforeEach(() => {
    mocks.computePropertyBatch.mockReset();
    resetBatchRuns();
    (store as any).selectedConfigurationId = "config-1";
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not start a second batch while one is running", async () => {
    let finish!: () => void;
    mocks.computePropertyBatch.mockImplementation(
      ({ onCancel }: any) =>
        new Promise<void>((resolve) => {
          onCancel(vi.fn());
          finish = resolve;
        }),
    );
    const vm = mountDialog().vm as any;

    const first = vm.onComputePropertyBatch(property);
    await vm.onComputePropertyBatch(property);
    expect(mocks.computePropertyBatch).toHaveBeenCalledTimes(1);

    finish();
    await first;
    // Once the first has settled, a new batch starts (left pending)
    vm.onComputePropertyBatch(property);
    expect(mocks.computePropertyBatch).toHaveBeenCalledTimes(2);
  });

  it("releases the batch when the batch action rejects", async () => {
    mocks.computePropertyBatch.mockRejectedValue(new Error("listing failed"));
    const vm = mountDialog().vm as any;

    await vm.onComputePropertyBatch(property);

    expect(vm.batchProgress).toBeNull();
    await vm.onComputePropertyBatch(property);
    expect(mocks.computePropertyBatch).toHaveBeenCalledTimes(2);
  });

  it("keeps the next batch's progress when the previous batch's hide timer fires", async () => {
    vi.useFakeTimers();
    let call = 0;
    mocks.computePropertyBatch.mockImplementation(
      ({ onBatchProgress, onComplete }: any) => {
        call++;
        if (call === 1) {
          onComplete({ succeeded: 1, failed: 0, cancelled: 0 });
          return Promise.resolve(true);
        }
        onBatchProgress({
          total: 3,
          completed: 1,
          failed: 0,
          cancelled: 0,
          currentDatasetName: "second",
        });
        // The second batch is still running when the first's timer fires
        return new Promise(() => {});
      },
    );
    const vm = mountDialog().vm as any;

    void vm.onComputePropertiesBatch([property, property]);
    await vi.advanceTimersByTimeAsync(3000);

    expect(vm.batchProgress?.currentDatasetName).toBe("second");
  });

  // A dialog reopened mid-batch (IMPLICIT_STATE_MACHINES.md J2 / K1)
  it("shows, cancels and guards a batch started before the dialog remounted", async () => {
    const cancel = vi.fn();
    let reportProgress!: (status: any) => void;
    mocks.computePropertyBatch.mockImplementation(
      ({ onCancel, onBatchProgress }: any) => {
        onCancel(cancel);
        reportProgress = onBatchProgress;
        return new Promise(() => {});
      },
    );
    const first = mountDialog();
    void (first.vm as any).onComputePropertyBatch(property);
    first.unmount();

    const vm = mountDialog().vm as any;
    expect(vm.batchProgress?.currentDatasetName).toBe("Starting...");

    // Progress the batch reports after the remount reaches the new dialog
    reportProgress({
      total: 3,
      completed: 2,
      failed: 0,
      cancelled: 0,
      currentDatasetName: "dataset-3",
    });
    expect(vm.batchProgress?.currentDatasetName).toBe("dataset-3");
    expect(vm.batchProgressPercent).toBeCloseTo(66.67, 1);

    vm.cancelBatch();
    expect(cancel).toHaveBeenCalledTimes(1);

    await vm.onComputePropertyBatch({ id: "property-2", name: "Perimeter" });
    expect(mocks.computePropertyBatch).toHaveBeenCalledTimes(1);
  });

  it("clears the progress when the store refuses the batch", async () => {
    mocks.computePropertyBatch.mockResolvedValue(false);
    const vm = mountDialog().vm as any;

    await vm.onComputePropertyBatch(property);

    expect(vm.batchProgress).toBeNull();
    expect(batchRuns.anyInFlight("property", "config-1")).toBe(false);
  });

  describe("a multi-property batch", () => {
    const perimeter = { id: "property-2", name: "Perimeter" } as any;
    let finishBatch!: (results: any) => void;
    let cancelJobs!: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mocks.computePropertyBatch.mockImplementation(
        ({ onCancel, onComplete }: any) =>
          new Promise((resolve) => {
            cancelJobs = vi.fn();
            onCancel(cancelJobs);
            finishBatch = (results) => {
              onComplete(results);
              resolve(true);
            };
          }),
      );
    });

    it("runs each property over the collection it started in", async () => {
      const vm = mountDialog().vm as any;

      const batch = vm.onComputePropertiesBatch([property, perimeter]);
      await vi.waitFor(() =>
        expect(mocks.computePropertyBatch).toHaveBeenCalledTimes(1),
      );
      finishBatch({ succeeded: 3, failed: 0, cancelled: 0 });
      await vi.waitFor(() =>
        expect(mocks.computePropertyBatch).toHaveBeenCalledTimes(2),
      );
      finishBatch({ succeeded: 3, failed: 0, cancelled: 0 });
      await batch;

      expect(
        mocks.computePropertyBatch.mock.calls.map(
          ([{ property, configurationId }]) => [property.id, configurationId],
        ),
      ).toEqual([
        ["property-1", "config-1"],
        ["property-2", "config-1"],
      ]);
    });

    it("stops when the user moves to another collection", async () => {
      const vm = mountDialog().vm as any;

      void vm.onComputePropertiesBatch([property, perimeter]);
      await vi.waitFor(() =>
        expect(mocks.computePropertyBatch).toHaveBeenCalledTimes(1),
      );
      (store as any).selectedConfigurationId = "config-2";
      finishBatch({ succeeded: 3, failed: 0, cancelled: 0 });
      // A second batch would never settle, so wait a macrotask, not on it
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mocks.computePropertyBatch).toHaveBeenCalledTimes(1);
    });

    it("stops after Cancel All", async () => {
      const vm = mountDialog().vm as any;

      void vm.onComputePropertiesBatch([property, perimeter]);
      await vi.waitFor(() =>
        expect(mocks.computePropertyBatch).toHaveBeenCalledTimes(1),
      );
      vm.cancelBatch();
      expect(cancelJobs).toHaveBeenCalledTimes(1);
      finishBatch({ succeeded: 1, failed: 0, cancelled: 2 });
      // A second batch would never settle, so wait a macrotask, not on it
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mocks.computePropertyBatch).toHaveBeenCalledTimes(1);
    });
  });

  it("neither shows nor waits on another collection's batch", async () => {
    // A duplicated collection keeps the same property ids
    void runBatch(
      "property",
      "config-copy",
      "property-1",
      3,
      ({ onCancel }) => {
        onCancel(vi.fn());
        return new Promise(() => {});
      },
    );
    mocks.computePropertyBatch.mockImplementation(() => new Promise(() => {}));
    const vm = mountDialog().vm as any;

    expect(vm.batchProgress).toBeNull();
    void vm.onComputePropertyBatch(property);
    expect(mocks.computePropertyBatch).toHaveBeenCalledTimes(1);
    expect(vm.batchProgress?.currentDatasetName).toBe("Starting...");
  });
});

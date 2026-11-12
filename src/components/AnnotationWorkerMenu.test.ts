import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { nextTick } from "vue";
import { shallowMount, flushPromises } from "@vue/test-utils";

// Mock lodash/debounce to invoke immediately
vi.mock("lodash", () => ({
  debounce: (fn: any) => {
    const debounced = fn;
    debounced.cancel = vi.fn();
    debounced.flush = vi.fn();
    return debounced;
  },
}));

vi.mock("@/utils/log", () => ({
  logError: vi.fn(),
}));

vi.mock("@/store", () => ({
  default: {
    editToolInConfiguration: vi.fn(),
    selectedConfigurationId: "config-1",
    // The open dataset: the tool's job is looked up on it
    dataset: { id: "ds-1" },
    api: {
      cancelJob: vi.fn(),
    },
    getCollectionDatasetCount: vi.fn().mockResolvedValue(3),
  },
}));

vi.mock("@/store/annotation", () => ({
  default: {
    computeAnnotationsWithWorker: vi.fn().mockResolvedValue({
      jobId: "job-123",
      datasetId: "ds-1",
    }),
    computeAnnotationsWithWorkerBatch: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/store/properties", () => ({
  default: {
    getWorkerInterface: vi.fn().mockReturnValue({
      param1: { type: "number", default: 5 },
    }),
    getWorkerPreview: vi.fn().mockReturnValue({
      text: "preview text",
      image: "preview-image-url",
    }),
    displayWorkerPreview: false,
    setDisplayWorkerPreview: vi.fn(),
    hasPreview: vi.fn().mockReturnValue(false),
    fetchWorkerInterface: vi.fn().mockResolvedValue(undefined),
    fetchWorkerImageList: vi.fn(),
    requestWorkerPreview: vi.fn(),
  },
}));

vi.mock("@/store/jobs", () => ({
  default: {
    // Tracked tool jobs per dataset: { [datasetId]: { [toolId]: jobId } }
    trackedToolJobs: {} as Record<string, Record<string, string>>,
    jobIdForToolInDataset(toolId: string, datasetId: string | null) {
      return this.trackedToolJobs[String(datasetId)]?.[toolId] ?? null;
    },
    getJobLog: vi.fn().mockReturnValue(""),
  },
}));

vi.mock("@/utils/workerInterface", () => ({
  getDefault: vi.fn((type: string, defaultVal?: any) => {
    if (defaultVal !== undefined) return defaultVal;
    if (type === "number") return 0;
    if (type === "text") return "";
    return null;
  }),
}));

import AnnotationWorkerMenu from "./AnnotationWorkerMenu.vue";
import store from "@/store";
import annotationsStore from "@/store/annotation";
import propertiesStore from "@/store/properties";
import jobsStore from "@/store/jobs";
import { getDefault } from "@/utils/workerInterface";
import batchRuns, { resetBatchRuns } from "@/store/batchRuns";

function makeTool(overrides: Record<string, any> = {}): any {
  return {
    id: "tool-1",
    name: "Test Worker",
    type: "worker" as const,
    hotkey: null,
    values: {
      image: { image: "worker-image:latest" },
      workerInterfaceValues: {},
      ...overrides,
    },
    template: {
      name: "Test Worker Template",
      type: "worker",
      description: "A test worker",
      interface: [],
    },
  };
}

function mountComponent(props: Record<string, any> = {}) {
  return shallowMount(AnnotationWorkerMenu, {
    props: {
      tool: makeTool(),
      ...props,
    },
    global: {
      stubs: {
        WorkerInterfaceValues: true,
      },
    },
  });
}

describe("AnnotationWorkerMenu", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Reset store mocks
    (store as any).editToolInConfiguration = vi.fn();
    (store as any).selectedConfigurationId = "config-1";
    (store as any).dataset = { id: "ds-1" };
    (store as any).api = { cancelJob: vi.fn() };
    (store as any).getCollectionDatasetCount = vi.fn().mockResolvedValue(3);
    (annotationsStore as any).computeAnnotationsWithWorker = vi
      .fn()
      .mockResolvedValue({ jobId: "job-123", datasetId: "ds-1" });
    (annotationsStore as any).computeAnnotationsWithWorkerBatch = vi
      .fn()
      .mockResolvedValue(undefined);
    (propertiesStore as any).getWorkerInterface = vi
      .fn()
      .mockReturnValue({ param1: { type: "number", default: 5 } });
    (propertiesStore as any).getWorkerPreview = vi
      .fn()
      .mockReturnValue({ text: "preview text", image: "preview-image-url" });
    (propertiesStore as any).displayWorkerPreview = false;
    (propertiesStore as any).setDisplayWorkerPreview = vi.fn();
    (propertiesStore as any).hasPreview = vi.fn().mockReturnValue(false);
    (propertiesStore as any).fetchWorkerInterface = vi
      .fn()
      .mockResolvedValue(undefined);
    (propertiesStore as any).fetchWorkerImageList = vi.fn();
    (propertiesStore as any).requestWorkerPreview = vi.fn();
    (jobsStore as any).trackedToolJobs = {};
    (jobsStore as any).getJobLog = vi.fn().mockReturnValue("");
    resetBatchRuns();
  });

  const toolRun = {
    kind: "workerTool" as const,
    configurationId: "config-1",
    id: "tool-1",
  };

  // Puts a running batch for tool-1 in the store, as the menu would
  function startStoreBatch(cancel?: () => void) {
    batchRuns.startRun({ ...toolRun, total: 10 });
    if (cancel) {
      batchRuns.setRunCancel({ ...toolRun, cancel });
    }
  }

  // -- Computed: workerInterface --
  it("workerInterface returns store value for the image", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(propertiesStore.getWorkerInterface).toHaveBeenCalledWith(
      "worker-image:latest",
    );
    expect(vm.workerInterface).toEqual({
      param1: { type: "number", default: 5 },
    });
  });

  // -- Computed: image --
  it("image returns tool.values.image.image", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.image).toBe("worker-image:latest");
  });

  // -- Computed: hasPreview --
  it("hasPreview returns false when propertiesStore.hasPreview is false", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.hasPreview).toBe(false);
  });

  it("hasPreview returns true when propertiesStore.hasPreview is true", () => {
    (propertiesStore.hasPreview as any).mockReturnValue(true);
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.hasPreview).toBe(true);
  });

  // -- Computed: displayWorkerPreview --
  it("displayWorkerPreview getter returns propertiesStore value", () => {
    (propertiesStore as any).displayWorkerPreview = true;
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.displayWorkerPreview).toBe(true);
  });

  // -- Computed: currentJobId --
  it("currentJobId returns null when no matching jobId", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.currentJobId).toBeNull();
  });

  it("currentJobId returns job ID when tool has matching entry", () => {
    (jobsStore as any).trackedToolJobs = { "ds-1": { "tool-1": "job-abc" } };
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.currentJobId).toBe("job-abc");
  });

  // -- Computed: canApplyToAllDatasets --
  it("canApplyToAllDatasets is true when configurationId set and count in range", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    // Wait for onMounted fetchCollectionDatasetCount to resolve
    await flushPromises();
    expect(vm.collectionDatasetCount).toBe(3);
    expect(vm.canApplyToAllDatasets).toBe(true);
  });

  it("canApplyToAllDatasets is false when no selectedConfigurationId", async () => {
    (store as any).selectedConfigurationId = null;
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    await nextTick();
    expect(vm.canApplyToAllDatasets).toBe(false);
  });

  // -- Computed: batchDisabledReason --
  it("batchDisabledReason returns null when configurationId is null", () => {
    (store as any).selectedConfigurationId = null;
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.batchDisabledReason).toBeNull();
  });

  it("batchDisabledReason returns limit message when count > 50", async () => {
    (store as any).getCollectionDatasetCount = vi.fn().mockResolvedValue(55);
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    await flushPromises();
    expect(vm.batchDisabledReason).toContain("more than 50 datasets");
  });

  it("batchDisabledReason returns null when count <= 1", async () => {
    (store as any).getCollectionDatasetCount = vi.fn().mockResolvedValue(1);
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    await nextTick();
    await nextTick();
    expect(vm.batchDisabledReason).toBeNull();
  });

  // -- Computed: batchProgressPercent --
  it("batchProgressPercent is 0 when batchProgress is null", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.batchProgressPercent).toBe(0);
  });

  it("batchProgressPercent computes correct percentage", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    startStoreBatch();
    batchRuns.setRunProgress({
      ...toolRun,
      progress: {
        total: 10,
        completed: 3,
        failed: 1,
        cancelled: 1,
        currentDatasetName: "test",
      },
    });
    expect(vm.batchProgressPercent).toBe(50);
  });

  // -- Computed: filteredErrors / filteredWarnings --
  it("filteredErrors returns only items with type ERROR", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.errorInfo = {
      errors: [
        { error: "err1", type: "error" },
        { warning: "warn1", type: "warning" },
        { error: "err2", type: "error" },
      ],
    };
    expect(vm.filteredErrors).toHaveLength(2);
    expect(vm.filteredErrors[0].error).toBe("err1");
  });

  it("filteredWarnings returns only items with type WARNING", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.errorInfo = {
      errors: [
        { error: "err1", type: "error" },
        { warning: "warn1", type: "warning" },
      ],
    };
    expect(vm.filteredWarnings).toHaveLength(1);
    expect(vm.filteredWarnings[0].warning).toBe("warn1");
  });

  // -- Computed: jobLog --
  it("jobLog returns store log when currentJobId exists", () => {
    (jobsStore as any).trackedToolJobs = { "ds-1": { "tool-1": "job-abc" } };
    (jobsStore.getJobLog as any).mockReturnValue("log from store");
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.jobLog).toBe("log from store");
  });

  it("jobLog returns localJobLog when no currentJobId", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.localJobLog = "local log data";
    expect(vm.jobLog).toBe("local log data");
  });

  // -- Method: compute --
  it("compute does nothing when already running", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.localRunning = true;
    await vm.compute();
    expect(
      annotationsStore.computeAnnotationsWithWorker,
    ).not.toHaveBeenCalled();
  });

  it("compute calls computeAnnotationsWithWorker for single dataset", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.localRunning = false;
    vm.applyToAllDatasets = false;
    await vm.compute();
    expect(annotationsStore.computeAnnotationsWithWorker).toHaveBeenCalled();
    const callArgs = (annotationsStore.computeAnnotationsWithWorker as any).mock
      .calls[0][0];
    expect(callArgs.tool.id).toBe("tool-1");
  });

  it("compute calls computeBatch when applyToAllDatasets is true", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.localRunning = false;
    vm.applyToAllDatasets = true;
    await vm.compute();
    expect(
      annotationsStore.computeAnnotationsWithWorkerBatch,
    ).toHaveBeenCalled();
  });

  // -- Method: cancel --
  it("cancel calls batchCancelFunction when it exists", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const mockCancel = vi.fn();
    startStoreBatch(mockCancel);
    vm.cancel();
    expect(mockCancel).toHaveBeenCalled();
    expect(store.api.cancelJob).not.toHaveBeenCalled();
  });

  it("cancel calls api.cancelJob when currentJob has jobId", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.currentJob = { jobId: "job-xyz", datasetId: "ds-1" };
    vm.cancel();
    expect(store.api.cancelJob).toHaveBeenCalledWith("job-xyz");
  });

  it("cancel does nothing when no batchCancel and no currentJob", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.currentJob = null;
    vm.cancel();
    expect(store.api.cancelJob).not.toHaveBeenCalled();
  });

  // -- Method: preview --
  it("preview calls requestWorkerPreview with correct args", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.interfaceValues = { key: "val" };
    vm.preview();
    expect(propertiesStore.requestWorkerPreview).toHaveBeenCalledWith({
      image: "worker-image:latest",
      tool: expect.objectContaining({ id: "tool-1" }),
      workerInterface: { key: "val" },
    });
  });

  // -- Method: resetInterfaceValues --
  it("resetInterfaceValues resets using getDefault for each interface entry", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.resetInterfaceValues();
    expect(getDefault).toHaveBeenCalledWith("number", 5);
  });

  it("resetInterfaceValues sets empty object when workerInterface is null", () => {
    (propertiesStore.getWorkerInterface as any).mockReturnValue(null);
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.resetInterfaceValues();
    expect(vm.interfaceValues).toEqual({});
  });

  // -- Method: updateInterface --
  it("updateInterface fetches when workerInterface is undefined", async () => {
    (propertiesStore.getWorkerInterface as any).mockReturnValue(undefined);
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    // Reset the mock call count from onMounted
    (propertiesStore.fetchWorkerInterface as any).mockClear();
    vm.fetchingWorkerInterface = false;
    await vm.updateInterface();
    expect(propertiesStore.fetchWorkerInterface).toHaveBeenCalledWith({
      image: "worker-image:latest",
      force: undefined,
    });
  });

  it("updateInterface fetches when force=true even if workerInterface exists", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    (propertiesStore.fetchWorkerInterface as any).mockClear();
    vm.fetchingWorkerInterface = false;
    await vm.updateInterface(true);
    expect(propertiesStore.fetchWorkerInterface).toHaveBeenCalledWith({
      image: "worker-image:latest",
      force: true,
    });
  });

  it("updateInterface skips fetch when workerInterface exists and not forced", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    (propertiesStore.fetchWorkerInterface as any).mockClear();
    (propertiesStore.fetchWorkerImageList as any).mockClear();
    vm.fetchingWorkerInterface = false;
    await vm.updateInterface();
    expect(propertiesStore.fetchWorkerInterface).not.toHaveBeenCalled();
    // fetchWorkerImageList is always called
    expect(propertiesStore.fetchWorkerImageList).toHaveBeenCalled();
  });

  // -- Method: fetchCollectionDatasetCount --
  it("fetchCollectionDatasetCount updates collectionDatasetCount", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    (store.getCollectionDatasetCount as any).mockResolvedValue(7);
    await vm.fetchCollectionDatasetCount();
    expect(vm.collectionDatasetCount).toBe(7);
    expect(vm.loadingDatasetCount).toBe(false);
  });

  it("fetchCollectionDatasetCount sets 0 on error", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    (store.getCollectionDatasetCount as any).mockRejectedValue(
      new Error("fail"),
    );
    await vm.fetchCollectionDatasetCount();
    expect(vm.collectionDatasetCount).toBe(0);
    expect(vm.loadingDatasetCount).toBe(false);
  });

  // -- Method: copyLogToClipboard --
  it("copyLogToClipboard uses clipboard API when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText },
    });
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.localJobLog = "some log";
    vm.copyLogToClipboard();
    expect(writeText).toHaveBeenCalledWith("some log");
  });

  // -- Watcher: tool prop triggers updateInterface --
  it("watcher on tool calls updateInterface", async () => {
    const wrapper = mountComponent();
    (propertiesStore.fetchWorkerImageList as any).mockClear();
    const newTool = makeTool({ image: { image: "new-image:latest" } });
    await wrapper.setProps({ tool: newTool });
    await nextTick();
    expect(propertiesStore.fetchWorkerImageList).toHaveBeenCalled();
  });

  // -- Run state ends on every path (IMPLICIT_STATE_MACHINES.md J2) --
  describe("run state", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("ends the run when starting the worker job rejects", async () => {
      (annotationsStore as any).computeAnnotationsWithWorker = vi
        .fn()
        .mockRejectedValue(new Error("POST failed"));
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      await vm.compute();
      expect(vm.running).toBe(false);
      expect(vm.previousRunStatus).toBe(false);
    });

    it("ends a batch run when the batch action rejects", async () => {
      (annotationsStore as any).computeAnnotationsWithWorkerBatch = vi
        .fn()
        .mockRejectedValue(new Error("findDatasetViews failed"));
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.applyToAllDatasets = true;
      await vm.compute();
      expect(vm.running).toBe(false);
      expect(vm.batchProgress).toBeNull();
    });

    it("stops showing the interface spinner when fetching the interface rejects", async () => {
      (propertiesStore.getWorkerInterface as any).mockReturnValue(undefined);
      (propertiesStore as any).fetchWorkerInterface = vi
        .fn()
        .mockRejectedValue(new Error("worker down"));
      const wrapper = mountComponent();
      await flushPromises();
      expect((wrapper.vm as any).fetchingWorkerInterface).toBe(false);
    });

    it("keeps a new batch's progress when the previous batch's hide timer fires", async () => {
      vi.useFakeTimers();
      let call = 0;
      (annotationsStore as any).computeAnnotationsWithWorkerBatch = vi.fn(
        ({ onBatchProgress, onComplete }: any) => {
          call++;
          if (call === 1) {
            onComplete({ succeeded: 1, failed: 0, cancelled: 0 });
            return Promise.resolve();
          }
          onBatchProgress({
            total: 3,
            completed: 1,
            failed: 0,
            cancelled: 0,
            currentDatasetName: "second",
          });
          // Still running when the first batch's timer fires
          return new Promise(() => {});
        },
      );
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.applyToAllDatasets = true;
      await vm.compute();
      await vi.advanceTimersByTimeAsync(1000);
      void vm.compute();
      await vi.advanceTimersByTimeAsync(3000);
      expect(vm.batchProgress?.currentDatasetName).toBe("second");
    });

    it("shows a run the jobs store still tracks for the tool after remounting", () => {
      (jobsStore as any).trackedToolJobs = {
        "ds-1": {
          "tool-1": "job-running",
        },
      };
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.running).toBe(true);
      vm.cancel();
      expect(store.api.cancelJob).toHaveBeenCalledWith("job-running");
    });

    // A menu remounted mid-batch (palettes remount; the menu is keyed by
    // tool): the batch outlives the component (IMPLICIT_STATE_MACHINES.md J2)
    it("shows, cancels and guards a batch started before the menu remounted", async () => {
      const cancelBatch = vi.fn();
      let reportProgress!: (status: any) => void;
      (annotationsStore as any).computeAnnotationsWithWorkerBatch = vi.fn(
        ({ onCancel, onBatchProgress }: any) => {
          onCancel(cancelBatch);
          reportProgress = onBatchProgress;
          return new Promise(() => {});
        },
      );
      const first = mountComponent();
      (first.vm as any).applyToAllDatasets = true;
      void (first.vm as any).compute();
      await flushPromises();
      first.unmount();

      const vm = mountComponent().vm as any;
      expect(vm.running).toBe(true);
      expect(vm.batchProgress?.currentDatasetName).toBe("Starting...");

      reportProgress({
        total: 4,
        completed: 1,
        failed: 0,
        cancelled: 0,
        currentDatasetName: "dataset-2",
      });
      expect(vm.batchProgress?.currentDatasetName).toBe("dataset-2");
      expect(vm.batchProgressPercent).toBe(25);

      vm.cancel();
      expect(cancelBatch).toHaveBeenCalledTimes(1);
      expect(store.api.cancelJob).not.toHaveBeenCalled();

      vm.applyToAllDatasets = true;
      await vm.compute();
      vm.applyToAllDatasets = false;
      await vm.compute();
      expect(
        annotationsStore.computeAnnotationsWithWorkerBatch,
      ).toHaveBeenCalledTimes(1);
      expect(
        annotationsStore.computeAnnotationsWithWorker,
      ).not.toHaveBeenCalled();
    });

    it("ends the run and keeps the outcome when a batch completes", async () => {
      (annotationsStore as any).computeAnnotationsWithWorkerBatch = vi.fn(
        async ({ onComplete }: any) => {
          onComplete({ succeeded: 2, failed: 0, cancelled: 0 });
        },
      );
      const vm = mountComponent().vm as any;
      vm.applyToAllDatasets = true;
      await vm.compute();
      expect(vm.running).toBe(false);
      expect(vm.previousRunStatus).toBe(true);
      expect(vm.batchCancelFunction).toBeNull();
    });

    it("does not show another dataset's run of the same tool", () => {
      (jobsStore as any).trackedToolJobs = {
        "some-other-dataset": { "tool-1": "job-elsewhere" },
      };
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.running).toBe(false);
      vm.cancel();
      expect(store.api.cancelJob).not.toHaveBeenCalled();
    });

    it("does not show or cancel a duplicated collection's batch of the same tool", () => {
      const cancelBatch = vi.fn();
      batchRuns.startRun({
        ...toolRun,
        configurationId: "config-copy",
        total: 4,
      });
      batchRuns.setRunCancel({
        ...toolRun,
        configurationId: "config-copy",
        cancel: cancelBatch,
      });
      const vm = mountComponent().vm as any;
      expect(vm.running).toBe(false);
      expect(vm.batchProgress).toBeNull();
      vm.cancel();
      expect(cancelBatch).not.toHaveBeenCalled();
    });
  });
});

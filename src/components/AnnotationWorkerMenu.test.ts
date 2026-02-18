import { describe, it, expect, vi, beforeEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

// Mock lodash/debounce to invoke immediately
vi.mock("lodash", () => ({
  debounce: (fn: any) => {
    const debounced = fn;
    debounced.cancel = vi.fn();
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
    jobIdForToolId: {} as Record<string, string>,
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

Vue.use(Vuetify);

function makeTool(overrides: Record<string, any> = {}) {
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
    vuetify: new Vuetify(),
    propsData: {
      tool: makeTool(),
      ...props,
    },
    stubs: {
      WorkerInterfaceValues: true,
    },
  });
}

describe("AnnotationWorkerMenu", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Reset store mocks
    (store as any).editToolInConfiguration = vi.fn();
    (store as any).selectedConfigurationId = "config-1";
    (store as any).api = { cancelJob: vi.fn() };
    (store as any).getCollectionDatasetCount = vi
      .fn()
      .mockResolvedValue(3);
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
    (jobsStore as any).jobIdForToolId = {};
    (jobsStore as any).getJobLog = vi.fn().mockReturnValue("");
  });

  // -- Computed: workerInterface --
  it("workerInterface returns store value for the image", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(propertiesStore.getWorkerInterface).toHaveBeenCalledWith(
      "worker-image:latest",
    );
    expect(vm.workerInterface).toEqual({ param1: { type: "number", default: 5 } });
    wrapper.destroy();
  });

  // -- Computed: image --
  it("image returns tool.values.image.image", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.image).toBe("worker-image:latest");
    wrapper.destroy();
  });

  // -- Computed: hasPreview --
  it("hasPreview returns false when propertiesStore.hasPreview is false", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.hasPreview).toBe(false);
    wrapper.destroy();
  });

  it("hasPreview returns true when propertiesStore.hasPreview is true", () => {
    (propertiesStore.hasPreview as any).mockReturnValue(true);
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.hasPreview).toBe(true);
    wrapper.destroy();
  });

  // -- Computed: displayWorkerPreview --
  it("displayWorkerPreview getter returns propertiesStore value", () => {
    (propertiesStore as any).displayWorkerPreview = true;
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.displayWorkerPreview).toBe(true);
    wrapper.destroy();
  });

  // -- Computed: currentJobId --
  it("currentJobId returns null when no matching jobId", () => {
    (jobsStore as any).jobIdForToolId = {};
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.currentJobId).toBeUndefined();
    wrapper.destroy();
  });

  it("currentJobId returns job ID when tool has matching entry", () => {
    (jobsStore as any).jobIdForToolId = { "tool-1": "job-abc" };
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.currentJobId).toBe("job-abc");
    wrapper.destroy();
  });

  // -- Computed: canApplyToAllDatasets --
  it("canApplyToAllDatasets is true when configurationId set and count in range", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    // Wait for onMounted fetchCollectionDatasetCount to resolve
    await Vue.nextTick();
    await Vue.nextTick();
    expect(vm.collectionDatasetCount).toBe(3);
    expect(vm.canApplyToAllDatasets).toBe(true);
    wrapper.destroy();
  });

  it("canApplyToAllDatasets is false when no selectedConfigurationId", async () => {
    (store as any).selectedConfigurationId = null;
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    await Vue.nextTick();
    expect(vm.canApplyToAllDatasets).toBe(false);
    wrapper.destroy();
  });

  // -- Computed: batchDisabledReason --
  it("batchDisabledReason returns null when configurationId is null", () => {
    (store as any).selectedConfigurationId = null;
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.batchDisabledReason).toBeNull();
    wrapper.destroy();
  });

  it("batchDisabledReason returns limit message when count > 10", async () => {
    (store as any).getCollectionDatasetCount = vi.fn().mockResolvedValue(15);
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    await Vue.nextTick();
    await Vue.nextTick();
    expect(vm.batchDisabledReason).toContain("more than 10 datasets");
    wrapper.destroy();
  });

  it("batchDisabledReason returns null when count <= 1", async () => {
    (store as any).getCollectionDatasetCount = vi.fn().mockResolvedValue(1);
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    await Vue.nextTick();
    await Vue.nextTick();
    expect(vm.batchDisabledReason).toBeNull();
    wrapper.destroy();
  });

  // -- Computed: batchProgressPercent --
  it("batchProgressPercent is 0 when batchProgress is null", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.batchProgressPercent).toBe(0);
    wrapper.destroy();
  });

  it("batchProgressPercent computes correct percentage", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.batchProgress = {
      total: 10,
      completed: 3,
      failed: 1,
      cancelled: 1,
      currentDatasetName: "test",
    };
    expect(vm.batchProgressPercent).toBe(50);
    wrapper.destroy();
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
    wrapper.destroy();
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
    wrapper.destroy();
  });

  // -- Computed: jobLog --
  it("jobLog returns store log when currentJobId exists", () => {
    (jobsStore as any).jobIdForToolId = { "tool-1": "job-abc" };
    (jobsStore.getJobLog as any).mockReturnValue("log from store");
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.jobLog).toBe("log from store");
    wrapper.destroy();
  });

  it("jobLog returns localJobLog when no currentJobId", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.localJobLog = "local log data";
    expect(vm.jobLog).toBe("local log data");
    wrapper.destroy();
  });

  // -- Method: compute --
  it("compute does nothing when already running", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.running = true;
    await vm.compute();
    expect(annotationsStore.computeAnnotationsWithWorker).not.toHaveBeenCalled();
    wrapper.destroy();
  });

  it("compute calls computeAnnotationsWithWorker for single dataset", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.running = false;
    vm.applyToAllDatasets = false;
    await vm.compute();
    expect(annotationsStore.computeAnnotationsWithWorker).toHaveBeenCalled();
    const callArgs = (annotationsStore.computeAnnotationsWithWorker as any).mock
      .calls[0][0];
    expect(callArgs.tool.id).toBe("tool-1");
    wrapper.destroy();
  });

  it("compute calls computeBatch when applyToAllDatasets is true", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.running = false;
    vm.applyToAllDatasets = true;
    await vm.compute();
    expect(
      annotationsStore.computeAnnotationsWithWorkerBatch,
    ).toHaveBeenCalled();
    wrapper.destroy();
  });

  // -- Method: cancel --
  it("cancel calls batchCancelFunction when it exists", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const mockCancel = vi.fn();
    vm.batchCancelFunction = mockCancel;
    vm.cancel();
    expect(mockCancel).toHaveBeenCalled();
    expect(store.api.cancelJob).not.toHaveBeenCalled();
    wrapper.destroy();
  });

  it("cancel calls api.cancelJob when currentJob has jobId", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.batchCancelFunction = null;
    vm.currentJob = { jobId: "job-xyz", datasetId: "ds-1" };
    vm.cancel();
    expect(store.api.cancelJob).toHaveBeenCalledWith("job-xyz");
    wrapper.destroy();
  });

  it("cancel does nothing when no batchCancel and no currentJob", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.batchCancelFunction = null;
    vm.currentJob = null;
    vm.cancel();
    expect(store.api.cancelJob).not.toHaveBeenCalled();
    wrapper.destroy();
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
    wrapper.destroy();
  });

  // -- Method: resetInterfaceValues --
  it("resetInterfaceValues resets using getDefault for each interface entry", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.resetInterfaceValues();
    expect(getDefault).toHaveBeenCalledWith("number", 5);
    wrapper.destroy();
  });

  it("resetInterfaceValues sets empty object when workerInterface is null", () => {
    (propertiesStore.getWorkerInterface as any).mockReturnValue(null);
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.resetInterfaceValues();
    expect(vm.interfaceValues).toEqual({});
    wrapper.destroy();
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
    wrapper.destroy();
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
    wrapper.destroy();
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
    wrapper.destroy();
  });

  // -- Method: fetchCollectionDatasetCount --
  it("fetchCollectionDatasetCount updates collectionDatasetCount", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    (store.getCollectionDatasetCount as any).mockResolvedValue(7);
    await vm.fetchCollectionDatasetCount();
    expect(vm.collectionDatasetCount).toBe(7);
    expect(vm.loadingDatasetCount).toBe(false);
    wrapper.destroy();
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
    wrapper.destroy();
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
    wrapper.destroy();
  });

  // -- Watcher: tool prop triggers updateInterface --
  it("watcher on tool calls updateInterface", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    (propertiesStore.fetchWorkerImageList as any).mockClear();
    const newTool = makeTool({ image: { image: "new-image:latest" } });
    await wrapper.setProps({ tool: newTool });
    await Vue.nextTick();
    expect(propertiesStore.fetchWorkerImageList).toHaveBeenCalled();
    wrapper.destroy();
  });
});

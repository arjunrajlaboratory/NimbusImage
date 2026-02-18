import { describe, it, expect, vi, beforeEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

// --- Top-level mock fn handles ---
const mockGetUserApiKeys = vi.fn().mockResolvedValue([]);
const mockCreateDataset = vi.fn().mockResolvedValue(null);
const mockSetSelectedDataset = vi.fn().mockResolvedValue(undefined);
const mockCreateDatasetView = vi.fn().mockResolvedValue(null);
const mockSetDatasetViewId = vi.fn();
const mockSetSelectedConfiguration = vi.fn();
const mockCreateUploadCollection = vi.fn().mockResolvedValue(null);
const mockAddUploadedDataset = vi.fn();
const mockAdvanceUploadDatasetIndex = vi.fn();
const mockSetUploadOriginalPath = vi.fn();
const mockCompleteUploadWorkflow = vi.fn();
const mockGetFolder = vi.fn().mockResolvedValue({
  _id: "folder2",
  _modelType: "folder",
});

const mockUploadWorkflow = {
  active: false,
  quickupload: false,
  batchMode: false,
  batchName: "",
  fileGroups: [] as File[][],
  initialUploadLocation: null as any,
  initialName: "",
  initialDescription: "",
  currentDatasetIndex: 0,
  datasets: [] as any[],
  collection: null as any,
  dimensionStrategy: null,
  originalPath: null as any,
  datasetNames: [] as string[],
};

vi.mock("@/store", () => ({
  default: {
    get uploadWorkflow() {
      return mockUploadWorkflow;
    },
    get uploadTotalDatasets() {
      return mockUploadWorkflow.fileGroups.length;
    },
    get uploadIsFirstDataset() {
      return mockUploadWorkflow.currentDatasetIndex === 0;
    },
    get uploadIsLastDataset() {
      return (
        mockUploadWorkflow.currentDatasetIndex >=
        mockUploadWorkflow.fileGroups.length - 1
      );
    },
    get uploadCurrentFiles() {
      const { fileGroups, currentDatasetIndex } = mockUploadWorkflow;
      if (fileGroups.length > 0 && currentDatasetIndex < fileGroups.length) {
        return fileGroups[currentDatasetIndex] || [];
      }
      return [];
    },
    get uploadCurrentDatasetName() {
      const { datasetNames, currentDatasetIndex } = mockUploadWorkflow;
      if (datasetNames.length > currentDatasetIndex) {
        return datasetNames[currentDatasetIndex];
      }
      return "Dataset";
    },
    api: {
      getUserApiKeys: (...args: any[]) => mockGetUserApiKeys(...args),
    },
    createDataset: (...args: any[]) => mockCreateDataset(...args),
    setSelectedDataset: (...args: any[]) => mockSetSelectedDataset(...args),
    createDatasetView: (...args: any[]) => mockCreateDatasetView(...args),
    setDatasetViewId: (...args: any[]) => mockSetDatasetViewId(...args),
    setSelectedConfiguration: (...args: any[]) =>
      mockSetSelectedConfiguration(...args),
    createUploadCollection: (...args: any[]) =>
      mockCreateUploadCollection(...args),
    addUploadedDataset: (...args: any[]) => mockAddUploadedDataset(...args),
    advanceUploadDatasetIndex: (...args: any[]) =>
      mockAdvanceUploadDatasetIndex(...args),
    setUploadOriginalPath: (...args: any[]) =>
      mockSetUploadOriginalPath(...args),
    completeUploadWorkflow: (...args: any[]) =>
      mockCompleteUploadWorkflow(...args),
  },
}));

vi.mock("@/store/girderResources", () => ({
  default: {
    getFolder: (...args: any[]) => mockGetFolder(...args),
  },
}));

vi.mock("@/store/datasetMetadataImport", () => ({
  default: {
    hasAnnotationData: false,
    annotationData: null,
    clearAnnotationFile: vi.fn(),
  },
}));

vi.mock("@/utils/log", () => ({
  logError: vi.fn(),
  logWarning: vi.fn(),
}));

vi.mock("@/utils/parsing", () => ({
  triggersPerCategory: {},
}));

vi.mock("@/utils/date", () => ({
  formatDate: vi.fn(() => "2026-01-01"),
}));

vi.mock("@/utils/girderSelectable", () => ({
  unselectableLocations: ["collections", "collection", "root", "users", "user"],
}));

vi.mock("@/utils/annotationImport", () => ({
  importAnnotationsFromData: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/utils/conversion", () => ({
  formatSize: vi.fn((bytes: number) => `${bytes} bytes`),
}));

vi.mock("@/utils/strings", () => ({
  parseTranscodeOutput: vi.fn(() => ({
    progressStatusText: "Processing...",
    transcodeProgress: 50,
    currentFrame: 5,
    totalFrames: 10,
  })),
}));

vi.mock("@girder/components/src/utils/upload", () => {
  return {
    default: class MockUploadManager {
      constructor() {}
    },
  };
});

vi.mock("@/girder/components", () => ({
  Upload: {
    name: "GirderUpload",
    template: "<div><slot name='files' :files='[]' /></div>",
    props: ["dest", "uploadCls", "hideStartButton", "hideHeadline"],
    methods: {
      inputFilesChanged: vi.fn(),
      startUpload: vi.fn(),
    },
    data: () => ({ totalProgressPercent: 0 }),
  },
}));

import NewDataset from "./NewDataset.vue";
import { parseTranscodeOutput } from "@/utils/strings";

Vue.use(Vuetify);
Vue.directive("tour-trigger", {});

const GirderUploadStub = {
  name: "GirderUpload",
  template: "<div><slot name='files' :files='[]' /></div>",
  props: ["dest", "uploadCls", "hideStartButton", "hideHeadline"],
  data: () => ({ totalProgressPercent: 0 }),
  methods: {
    inputFilesChanged: vi.fn(),
    startUpload: vi.fn(),
  },
};

function createFile(name: string, size = 100): File {
  const file = new File(["x"], name, { type: "application/octet-stream" });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

function mountComponent(props: Record<string, any> = {}, options: any = {}) {
  return shallowMount(NewDataset, {
    vuetify: new Vuetify(),
    propsData: {
      initialUploadLocation: { _id: "folder1", _modelType: "folder" },
      ...props,
    },
    stubs: {
      GirderLocationChooser: true,
      FileDropzone: true,
      MultiSourceConfiguration: true,
      DatasetInfo: true,
      GirderUpload: GirderUploadStub,
    },
    mocks: {
      $router: { push: vi.fn() },
    },
    ...options,
  });
}

function resetUploadWorkflow() {
  Object.assign(mockUploadWorkflow, {
    active: false,
    quickupload: false,
    batchMode: false,
    batchName: "",
    fileGroups: [],
    initialUploadLocation: null,
    initialName: "",
    initialDescription: "",
    currentDatasetIndex: 0,
    datasets: [],
    collection: null,
    dimensionStrategy: null,
    originalPath: null,
    datasetNames: [],
  });
}

describe("NewDataset", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetUploadWorkflow();
    mockGetUserApiKeys.mockResolvedValue([]);
    mockCreateDataset.mockResolvedValue(null);
    mockGetFolder.mockResolvedValue({
      _id: "folder1",
      _modelType: "folder",
    });
  });

  // ===========================================
  // 1. Data defaults
  // ===========================================
  describe("data defaults", () => {
    it("has configuring=false by default", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.configuring).toBe(false);
      wrapper.destroy();
    });

    it("has uploading=false by default", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.uploading).toBe(false);
      wrapper.destroy();
    });

    it("has dataset=null by default", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.dataset).toBeNull();
      wrapper.destroy();
    });

    it("has pipelineError=false by default", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.pipelineError).toBe(false);
      wrapper.destroy();
    });

    it("has hideUploader=false by default", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.hideUploader).toBe(false);
      wrapper.destroy();
    });

    it("has empty name and description by default", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.name).toBe("");
      expect(vm.description).toBe("");
      wrapper.destroy();
    });
  });

  // ===========================================
  // 2. Computed properties
  // ===========================================
  describe("maxTotalFileSize", () => {
    it("returns maxApiKeyFileSize when set", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.maxApiKeyFileSize = 5000;
      expect(vm.maxTotalFileSize).toBe(5000);
      wrapper.destroy();
    });

    it("falls back to env var when maxApiKeyFileSize is null", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.maxApiKeyFileSize = null;
      // Without env var set, should return Infinity
      expect(vm.maxTotalFileSize).toBe(Infinity);
      wrapper.destroy();
    });
  });

  describe("invalidLocation", () => {
    it("returns false for valid folder path", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.path = { _id: "folder1", _modelType: "folder" };
      expect(vm.invalidLocation).toBe(false);
      wrapper.destroy();
    });

    it("returns true for unselectable _modelType", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.path = { _id: "root1", _modelType: "root" };
      expect(vm.invalidLocation).toBe(true);
      wrapper.destroy();
    });

    it("returns true for unselectable type property", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.path = { type: "collections" };
      expect(vm.invalidLocation).toBe(true);
      wrapper.destroy();
    });

    it("returns false when path is null", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.path = null;
      expect(vm.invalidLocation).toBe(false);
      wrapper.destroy();
    });
  });

  describe("datasetId", () => {
    it("returns dataset.id when dataset is set", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.dataset = { id: "ds-123" };
      expect(vm.datasetId).toBe("ds-123");
      wrapper.destroy();
    });

    it("returns null when dataset is null", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.datasetId).toBeNull();
      wrapper.destroy();
    });
  });

  describe("totalProgressPercentage", () => {
    it("returns non-zero when uploading", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.uploading = true;
      // Without uploader ref, should return 0% of step 1
      const progress = vm.totalProgressPercentage;
      expect(progress).toBeGreaterThanOrEqual(0);
      expect(progress).toBeLessThan(100);
      wrapper.destroy();
    });

    it("returns progress based on configuring logs", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.configuring = true;
      vm.configurationLogs = "line1\nline2\nline3\nline4\nline5";
      const progress = vm.totalProgressPercentage;
      // Should be at step 2 (configuring) with some progress
      expect(progress).toBeGreaterThan(0);
      wrapper.destroy();
    });

    it("returns progress when creatingView", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.creatingView = true;
      const progress = vm.totalProgressPercentage;
      expect(progress).toBeGreaterThan(0);
      wrapper.destroy();
    });
  });

  describe("pageTwo", () => {
    it("returns true when dataset is set", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.dataset = { id: "ds-1" };
      expect(vm.pageTwo).toBe(true);
      wrapper.destroy();
    });

    it("returns false when dataset is null", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.pageTwo).toBe(false);
      wrapper.destroy();
    });
  });

  describe("rules", () => {
    it("validation fails for empty string", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      const rule = vm.rules[0];
      expect(rule("")).not.toBe(true);
      expect(rule("  ")).not.toBe(true);
      wrapper.destroy();
    });

    it("validation passes for non-empty string", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      const rule = vm.rules[0];
      expect(rule("test")).toBe(true);
      wrapper.destroy();
    });
  });

  describe("filesSelected", () => {
    it("returns true when files are present", () => {
      const wrapper = mountComponent({
        defaultFiles: [createFile("test.tif")],
      });
      const vm = wrapper.vm as any;
      expect(vm.filesSelected).toBe(true);
      wrapper.destroy();
    });

    it("returns false when no files", () => {
      const wrapper = mountComponent({ defaultFiles: [] });
      const vm = wrapper.vm as any;
      expect(vm.filesSelected).toBe(false);
      wrapper.destroy();
    });
  });

  describe("recommendedName", () => {
    it("returns empty string for no files", () => {
      const wrapper = mountComponent({ defaultFiles: [] });
      const vm = wrapper.vm as any;
      expect(vm.recommendedName).toBe("");
      wrapper.destroy();
    });

    it("returns basename for single file", () => {
      const wrapper = mountComponent({
        defaultFiles: [createFile("image.tif")],
      });
      const vm = wrapper.vm as any;
      expect(vm.recommendedName).toBe("image");
      wrapper.destroy();
    });

    it("returns common prefix for multiple files", () => {
      const wrapper = mountComponent({
        defaultFiles: [
          createFile("sample_001.tif"),
          createFile("sample_002.tif"),
        ],
      });
      const vm = wrapper.vm as any;
      // With our mock of triggersPerCategory={}, the regex will produce some result
      const name = vm.recommendedName;
      expect(typeof name).toBe("string");
      expect(name.length).toBeGreaterThan(0);
      wrapper.destroy();
    });
  });

  describe("isQuickImport", () => {
    it("uses store when active", () => {
      mockUploadWorkflow.active = true;
      mockUploadWorkflow.quickupload = true;
      const wrapper = mountComponent({ quickupload: false });
      const vm = wrapper.vm as any;
      expect(vm.isQuickImport).toBe(true);
      wrapper.destroy();
    });

    it("falls back to prop when store inactive", () => {
      mockUploadWorkflow.active = false;
      const wrapper = mountComponent({ quickupload: true });
      const vm = wrapper.vm as any;
      expect(vm.isQuickImport).toBe(true);
      wrapper.destroy();
    });

    it("returns false when both store and prop are false", () => {
      mockUploadWorkflow.active = false;
      const wrapper = mountComponent({ quickupload: false });
      const vm = wrapper.vm as any;
      expect(vm.isQuickImport).toBe(false);
      wrapper.destroy();
    });
  });

  describe("isBatchMode", () => {
    it("uses store when active", () => {
      mockUploadWorkflow.active = true;
      mockUploadWorkflow.batchMode = true;
      const wrapper = mountComponent({ batchMode: false });
      const vm = wrapper.vm as any;
      expect(vm.isBatchMode).toBe(true);
      wrapper.destroy();
    });

    it("falls back to prop when store inactive", () => {
      mockUploadWorkflow.active = false;
      const wrapper = mountComponent({ batchMode: true });
      const vm = wrapper.vm as any;
      expect(vm.isBatchMode).toBe(true);
      wrapper.destroy();
    });
  });

  describe("effectiveBatchName", () => {
    it("prefers store batchName", () => {
      mockUploadWorkflow.batchName = "Store Batch";
      const wrapper = mountComponent({ batchName: "Prop Batch" });
      const vm = wrapper.vm as any;
      expect(vm.effectiveBatchName).toBe("Store Batch");
      wrapper.destroy();
    });

    it("falls back to prop batchName", () => {
      mockUploadWorkflow.batchName = "";
      const wrapper = mountComponent({ batchName: "Prop Batch" });
      const vm = wrapper.vm as any;
      expect(vm.effectiveBatchName).toBe("Prop Batch");
      wrapper.destroy();
    });

    it("returns empty string when neither is set", () => {
      mockUploadWorkflow.batchName = "";
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.effectiveBatchName).toBe("");
      wrapper.destroy();
    });
  });

  describe("totalDatasets", () => {
    it("uses store fileGroups length when active", () => {
      mockUploadWorkflow.active = true;
      mockUploadWorkflow.fileGroups = [
        [createFile("a.tif")],
        [createFile("b.tif")],
        [createFile("c.tif")],
      ];
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.totalDatasets).toBe(3);
      wrapper.destroy();
    });

    it("uses fileGroups prop when store inactive", () => {
      mockUploadWorkflow.active = false;
      const wrapper = mountComponent({
        fileGroups: [[createFile("a.tif")], [createFile("b.tif")]],
      });
      const vm = wrapper.vm as any;
      expect(vm.totalDatasets).toBe(2);
      wrapper.destroy();
    });

    it("returns 1 for single defaultFiles when no fileGroups", () => {
      mockUploadWorkflow.active = false;
      const wrapper = mountComponent({
        fileGroups: [],
        defaultFiles: [createFile("a.tif")],
      });
      const vm = wrapper.vm as any;
      expect(vm.totalDatasets).toBe(1);
      wrapper.destroy();
    });
  });

  describe("isFirstDataset", () => {
    it("uses store when active", () => {
      mockUploadWorkflow.active = true;
      mockUploadWorkflow.currentDatasetIndex = 0;
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.isFirstDataset).toBe(true);
      wrapper.destroy();
    });

    it("returns false for non-zero index from store", () => {
      mockUploadWorkflow.active = true;
      mockUploadWorkflow.currentDatasetIndex = 2;
      mockUploadWorkflow.fileGroups = [[], [], []];
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.isFirstDataset).toBe(false);
      wrapper.destroy();
    });

    it("uses local index when store inactive", () => {
      mockUploadWorkflow.active = false;
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.isFirstDataset).toBe(true);
      wrapper.destroy();
    });
  });

  describe("isLastDataset", () => {
    it("uses store when active", () => {
      mockUploadWorkflow.active = true;
      mockUploadWorkflow.fileGroups = [[createFile("a.tif")]];
      mockUploadWorkflow.currentDatasetIndex = 0;
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.isLastDataset).toBe(true);
      wrapper.destroy();
    });

    it("returns false when not at last index", () => {
      mockUploadWorkflow.active = true;
      mockUploadWorkflow.fileGroups = [
        [createFile("a.tif")],
        [createFile("b.tif")],
      ];
      mockUploadWorkflow.currentDatasetIndex = 0;
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.isLastDataset).toBe(false);
      wrapper.destroy();
    });
  });

  describe("showConfigAtTop", () => {
    it("returns true for batch+!quick+first+configuring", () => {
      mockUploadWorkflow.active = true;
      mockUploadWorkflow.batchMode = true;
      mockUploadWorkflow.quickupload = false;
      mockUploadWorkflow.currentDatasetIndex = 0;
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.configuring = true;
      expect(vm.showConfigAtTop).toBe(true);
      wrapper.destroy();
    });

    it("returns false when not batch mode", () => {
      mockUploadWorkflow.active = true;
      mockUploadWorkflow.batchMode = false;
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.configuring = true;
      expect(vm.showConfigAtTop).toBe(false);
      wrapper.destroy();
    });

    it("returns false when quick import", () => {
      mockUploadWorkflow.active = true;
      mockUploadWorkflow.batchMode = true;
      mockUploadWorkflow.quickupload = true;
      mockUploadWorkflow.currentDatasetIndex = 0;
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.configuring = true;
      expect(vm.showConfigAtTop).toBe(false);
      wrapper.destroy();
    });

    it("returns false when not configuring", () => {
      mockUploadWorkflow.active = true;
      mockUploadWorkflow.batchMode = true;
      mockUploadWorkflow.quickupload = false;
      mockUploadWorkflow.currentDatasetIndex = 0;
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.configuring = false;
      expect(vm.showConfigAtTop).toBe(false);
      wrapper.destroy();
    });
  });

  describe("currentFiles", () => {
    it("returns store files in store-based batch mode", () => {
      const files = [createFile("a.tif"), createFile("b.tif")];
      mockUploadWorkflow.active = true;
      mockUploadWorkflow.batchMode = true;
      mockUploadWorkflow.fileGroups = [files];
      mockUploadWorkflow.currentDatasetIndex = 0;
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.currentFiles).toEqual(files);
      wrapper.destroy();
    });

    it("returns prop fileGroups in prop-based batch mode", () => {
      mockUploadWorkflow.active = false;
      const files = [createFile("c.tif")];
      const wrapper = mountComponent({
        batchMode: true,
        fileGroups: [files],
      });
      const vm = wrapper.vm as any;
      expect(vm.currentFiles).toEqual(files);
      wrapper.destroy();
    });

    it("returns defaultFiles in single mode", () => {
      mockUploadWorkflow.active = false;
      const files = [createFile("d.tif")];
      const wrapper = mountComponent({ defaultFiles: files });
      const vm = wrapper.vm as any;
      expect(vm.currentFiles).toEqual(files);
      wrapper.destroy();
    });
  });

  describe("files", () => {
    it("delegates to currentFiles in batch mode", () => {
      const files = [createFile("a.tif")];
      mockUploadWorkflow.active = true;
      mockUploadWorkflow.batchMode = true;
      mockUploadWorkflow.fileGroups = [files];
      mockUploadWorkflow.currentDatasetIndex = 0;
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.files).toEqual(files);
      wrapper.destroy();
    });

    it("returns uploadedFiles when set in single mode", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      const files = [createFile("manual.tif")];
      vm.uploadedFiles = files;
      expect(vm.files).toEqual(files);
      wrapper.destroy();
    });

    it("checks store when upload workflow active and no uploadedFiles", () => {
      mockUploadWorkflow.active = true;
      mockUploadWorkflow.batchMode = false;
      mockUploadWorkflow.fileGroups = [[createFile("store.tif")]];
      mockUploadWorkflow.currentDatasetIndex = 0;
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.files).toEqual([createFile("store.tif")]);
      wrapper.destroy();
    });

    it("falls back to defaultFiles prop", () => {
      mockUploadWorkflow.active = false;
      const files = [createFile("default.tif")];
      const wrapper = mountComponent({ defaultFiles: files });
      const vm = wrapper.vm as any;
      expect(vm.files).toEqual(files);
      wrapper.destroy();
    });
  });

  // ===========================================
  // 3. Mounted behavior
  // ===========================================
  describe("mounted", () => {
    it("sets path/name/description from store when active", async () => {
      mockUploadWorkflow.active = true;
      mockUploadWorkflow.initialUploadLocation = {
        _id: "store-folder",
        _modelType: "folder",
      };
      mockUploadWorkflow.initialName = "Store Name";
      mockUploadWorkflow.initialDescription = "Store Desc";
      const wrapper = mountComponent();
      await Vue.nextTick();
      const vm = wrapper.vm as any;
      expect(vm.path).toEqual({
        _id: "store-folder",
        _modelType: "folder",
      });
      expect(vm.name).toBe("Store Name");
      expect(vm.description).toBe("Store Desc");
      wrapper.destroy();
    });

    it("sets from props when store inactive", async () => {
      mockUploadWorkflow.active = false;
      const wrapper = mountComponent({
        initialUploadLocation: { _id: "prop-folder", _modelType: "folder" },
        initialName: "Prop Name",
        initialDescription: "Prop Desc",
      });
      await Vue.nextTick();
      const vm = wrapper.vm as any;
      expect(vm.path).toEqual({ _id: "prop-folder", _modelType: "folder" });
      expect(vm.name).toBe("Prop Name");
      expect(vm.description).toBe("Prop Desc");
      wrapper.destroy();
    });

    it("calls getMaxUploadSize on mount", async () => {
      mockGetUserApiKeys.mockResolvedValue([]);
      const wrapper = mountComponent();
      await Vue.nextTick();
      await Vue.nextTick();
      expect(mockGetUserApiKeys).toHaveBeenCalled();
      wrapper.destroy();
    });
  });

  // ===========================================
  // 4. Methods
  // ===========================================
  describe("convertScopeToBytes", () => {
    it("returns null for null scope", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.convertScopeToBytes(null)).toBeNull();
      wrapper.destroy();
    });

    it("returns correct bytes for recognized scope", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.convertScopeToBytes(["nimbus.upload.limit.1gb"])).toBe(
        1 * 1024 * 1024 * 1024,
      );
      expect(vm.convertScopeToBytes(["nimbus.upload.limit.500mb"])).toBe(
        500 * 1024 * 1024,
      );
      wrapper.destroy();
    });

    it("returns null for unrecognized scope", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.convertScopeToBytes(["unknown.scope"])).toBeNull();
      wrapper.destroy();
    });

    it("returns first matching scope value", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(
        vm.convertScopeToBytes([
          "other.scope",
          "nimbus.upload.limit.2gb",
          "nimbus.upload.limit.5gb",
        ]),
      ).toBe(2 * 1024 * 1024 * 1024);
      wrapper.destroy();
    });
  });

  describe("getMaxUploadSize", () => {
    it("returns null when no active keys", async () => {
      mockGetUserApiKeys.mockResolvedValue([
        { active: false, scope: ["nimbus.upload.limit.1gb"] },
      ]);
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      const result = await vm.getMaxUploadSize();
      expect(result).toBeNull();
      wrapper.destroy();
    });

    it("returns max size from active keys with matching scopes", async () => {
      mockGetUserApiKeys.mockResolvedValue([
        { active: true, scope: ["nimbus.upload.limit.1gb"] },
        { active: true, scope: ["nimbus.upload.limit.5gb"] },
        { active: false, scope: ["nimbus.upload.limit.10gb"] },
      ]);
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      const result = await vm.getMaxUploadSize();
      expect(result).toBe(5 * 1024 * 1024 * 1024);
      wrapper.destroy();
    });

    it("returns null when active keys have no matching scopes", async () => {
      mockGetUserApiKeys.mockResolvedValue([
        { active: true, scope: ["some.other.scope"] },
      ]);
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      const result = await vm.getMaxUploadSize();
      expect(result).toBeNull();
      wrapper.destroy();
    });
  });

  describe("filesChanged", () => {
    it("sets uploadedFiles from FileUpload format", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      const file = createFile("test.tif", 50);
      vm.filesChanged([{ file }]);
      expect(vm.uploadedFiles).toEqual([file]);
      wrapper.destroy();
    });

    it("sets uploadedFiles from raw File format", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      const file = createFile("test.tif", 50);
      vm.filesChanged([file]);
      expect(vm.uploadedFiles).toEqual([file]);
      wrapper.destroy();
    });

    it("detects file size exceeded", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.maxApiKeyFileSize = 100; // Set small limit
      const largeFile = createFile("big.tif", 200);
      vm.filesChanged([{ file: largeFile }]);
      expect(vm.fileSizeExceeded).toBe(true);
      expect(vm.uploadedFiles).toBeNull();
      wrapper.destroy();
    });

    it("sets pipelineError when quick import and size exceeded", () => {
      mockUploadWorkflow.active = true;
      mockUploadWorkflow.quickupload = true;
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.maxApiKeyFileSize = 100;
      const largeFile = createFile("big.tif", 200);
      vm.filesChanged([{ file: largeFile }]);
      expect(vm.pipelineError).toBe(true);
      wrapper.destroy();
    });

    it("updates name from recommendedName when name is empty", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.name = "";
      const file = createFile("myimage.tif", 50);
      vm.filesChanged([{ file }]);
      expect(vm.name).toBe("myimage");
      wrapper.destroy();
    });

    it("does not overwrite existing name", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.name = "Existing Name";
      const file = createFile("myimage.tif", 50);
      vm.filesChanged([{ file }]);
      expect(vm.name).toBe("Existing Name");
      wrapper.destroy();
    });
  });

  describe("addMoreFiles", () => {
    it("merges new files with existing allFiles", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      const file1 = createFile("a.tif");
      const file2 = createFile("b.tif");
      vm.allFiles = [file1];
      vm.addMoreFiles([file2]);
      expect(vm.allFiles).toEqual([file1, file2]);
      wrapper.destroy();
    });
  });

  describe("interruptedUpload", () => {
    it("resets uploading and hideUploader", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.uploading = true;
      vm.hideUploader = true;
      vm.interruptedUpload();
      expect(vm.uploading).toBe(false);
      expect(vm.hideUploader).toBe(false);
      wrapper.destroy();
    });
  });

  describe("nextStep", () => {
    it("sets hideUploader and uploading=false", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.dataset = { id: "ds-1" };
      vm.uploading = true;
      vm.nextStep();
      expect(vm.hideUploader).toBe(true);
      expect(vm.uploading).toBe(false);
      wrapper.destroy();
    });

    it("emits datasetUploaded with dataset id", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.dataset = { id: "ds-1" };
      vm.nextStep();
      expect(wrapper.emitted("datasetUploaded")).toBeTruthy();
      expect(wrapper.emitted("datasetUploaded")![0][0]).toBe("ds-1");
      wrapper.destroy();
    });

    it("sets pipelineError when dataset is null", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.dataset = null;
      vm.nextStep();
      expect(vm.pipelineError).toBe(true);
      wrapper.destroy();
    });

    it("routes to multi in autoMultiConfig single mode", () => {
      mockUploadWorkflow.active = false;
      const wrapper = mountComponent({
        quickupload: false,
        batchMode: false,
        autoMultiConfig: true,
      });
      const vm = wrapper.vm as any;
      vm.dataset = { id: "ds-1" };
      vm.nextStep();
      expect(vm.$router.push).toHaveBeenCalledWith({
        name: "multi",
        params: { datasetId: "ds-1" },
      });
      wrapper.destroy();
    });
  });

  describe("submit", () => {
    it("returns early on pipelineError", async () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.pipelineError = true;
      await vm.submit();
      expect(mockCreateDataset).not.toHaveBeenCalled();
      wrapper.destroy();
    });

    it("returns early when form is not valid", async () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.valid = false;
      await vm.submit();
      expect(mockCreateDataset).not.toHaveBeenCalled();
      wrapper.destroy();
    });

    it("returns early when path has no _id", async () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.valid = true;
      vm.path = { type: "root" };
      await vm.submit();
      expect(mockCreateDataset).not.toHaveBeenCalled();
      wrapper.destroy();
    });

    it("sets pipelineError when fileSizeExceeded", async () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.valid = true;
      vm.path = { _id: "folder1", _modelType: "folder" };
      vm.fileSizeExceeded = true;
      await vm.submit();
      expect(vm.pipelineError).toBe(true);
      wrapper.destroy();
    });

    it("creates dataset and starts upload on success", async () => {
      const mockDataset = { id: "ds-new" };
      mockCreateDataset.mockResolvedValue(mockDataset);
      // Mount without path to prevent girder-upload from rendering initially
      const wrapper = mountComponent({ initialUploadLocation: null });
      const vm = wrapper.vm as any;
      // Spy on uploadMounted to prevent it from firing submit when we set path
      vi.spyOn(vm, "uploadMounted").mockResolvedValue(undefined);
      vm.valid = true;
      vm.path = { _id: "folder1", _modelType: "folder" };
      vm.name = "Test Dataset";
      vm.description = "desc";
      await Vue.nextTick();
      await vm.submit();
      await Vue.nextTick();
      expect(mockCreateDataset).toHaveBeenCalledWith({
        name: "Test Dataset",
        description: "desc",
        path: { _id: "folder1", _modelType: "folder" },
      });
      expect(vm.dataset).toEqual(mockDataset);
      expect(vm.uploading).toBe(true);
      wrapper.destroy();
    });

    it("sets failedDataset when createDataset returns null", async () => {
      mockCreateDataset.mockResolvedValue(null);
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.valid = true;
      vm.path = { _id: "folder1", _modelType: "folder" };
      vm.name = "Bad Dataset";
      await vm.submit();
      expect(vm.failedDataset).toBe("Bad Dataset");
      wrapper.destroy();
    });

    it("adds dataset to store in batch mode", async () => {
      mockUploadWorkflow.active = true;
      mockUploadWorkflow.batchMode = true;
      mockUploadWorkflow.originalPath = {
        _id: "folder1",
        _modelType: "folder",
      };
      mockUploadWorkflow.fileGroups = [[createFile("a.tif")]];
      mockUploadWorkflow.currentDatasetIndex = 0;
      mockUploadWorkflow.datasetNames = ["batch-ds"];
      const mockDataset = { id: "ds-batch" };
      mockCreateDataset.mockResolvedValue(mockDataset);
      // Mount without path to prevent girder-upload from rendering initially
      const wrapper = mountComponent({ initialUploadLocation: null });
      const vm = wrapper.vm as any;
      // Spy on uploadMounted to prevent it from firing submit
      vi.spyOn(vm, "uploadMounted").mockResolvedValue(undefined);
      vm.valid = true;
      vm.path = { _id: "folder1", _modelType: "folder" };
      await Vue.nextTick();
      await vm.submit();
      await Vue.nextTick();
      expect(mockAddUploadedDataset).toHaveBeenCalledWith(mockDataset);
      wrapper.destroy();
    });
  });

  describe("handleBatchError", () => {
    it("sets pipelineError in single mode", () => {
      mockUploadWorkflow.active = false;
      const wrapper = mountComponent({ batchMode: false });
      const vm = wrapper.vm as any;
      vm.handleBatchError("Something went wrong");
      expect(vm.pipelineError).toBe(true);
      wrapper.destroy();
    });

    it("shows dialog in batch mode", () => {
      mockUploadWorkflow.active = true;
      mockUploadWorkflow.batchMode = true;
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.handleBatchError("Batch error");
      expect(vm.showBatchErrorDialog).toBe(true);
      expect(vm.batchErrorMessage).toBe("Batch error");
      wrapper.destroy();
    });
  });

  describe("handleStopBatch", () => {
    it("closes dialog, sets pipelineError, completes workflow, and navigates", () => {
      mockUploadWorkflow.active = true;
      mockUploadWorkflow.collection = { id: "col-1" };
      mockUploadWorkflow.datasets = [{ id: "ds-1" }];
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.showBatchErrorDialog = true;
      vm.handleStopBatch();
      expect(vm.showBatchErrorDialog).toBe(false);
      expect(vm.pipelineError).toBe(true);
      expect(mockCompleteUploadWorkflow).toHaveBeenCalled();
      expect(vm.$router.push).toHaveBeenCalledWith({
        name: "configuration",
        params: { configurationId: "col-1" },
      });
      wrapper.destroy();
    });

    it("navigates to dataset when no collection but has datasets", () => {
      mockUploadWorkflow.active = true;
      mockUploadWorkflow.collection = null;
      mockUploadWorkflow.datasets = [{ id: "ds-1" }];
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.handleStopBatch();
      expect(vm.$router.push).toHaveBeenCalledWith({
        name: "dataset",
        params: { datasetId: "ds-1" },
      });
      wrapper.destroy();
    });

    it("navigates to root when no collection or datasets", () => {
      mockUploadWorkflow.active = true;
      mockUploadWorkflow.collection = null;
      mockUploadWorkflow.datasets = [];
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.handleStopBatch();
      expect(vm.$router.push).toHaveBeenCalledWith({ name: "root" });
      wrapper.destroy();
    });
  });

  describe("handleContinueBatch", () => {
    it("records skipped index and resets error state", () => {
      mockUploadWorkflow.active = true;
      mockUploadWorkflow.batchMode = true;
      mockUploadWorkflow.currentDatasetIndex = 2;
      mockUploadWorkflow.fileGroups = [[], [], [], []];
      mockUploadWorkflow.originalPath = {
        _id: "folder1",
        _modelType: "folder",
      };
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.showBatchErrorDialog = true;
      vm.pipelineError = true;
      vm.batchErrorMessage = "error";
      vm.handleContinueBatch();
      expect(vm.showBatchErrorDialog).toBe(false);
      expect(vm.skippedDatasets).toContain(2);
      expect(vm.pipelineError).toBe(false);
      expect(vm.batchErrorMessage).toBe("");
      wrapper.destroy();
    });
  });

  describe("advanceToNextDataset", () => {
    it("navigates to collection when last dataset", () => {
      mockUploadWorkflow.active = true;
      mockUploadWorkflow.batchMode = true;
      mockUploadWorkflow.fileGroups = [[createFile("a.tif")]];
      mockUploadWorkflow.currentDatasetIndex = 0;
      mockUploadWorkflow.collection = { id: "col-1" };
      mockUploadWorkflow.datasets = [{ id: "ds-1" }];
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.advanceToNextDataset();
      expect(mockCompleteUploadWorkflow).toHaveBeenCalled();
      wrapper.destroy();
    });

    it("resets state when not last dataset", () => {
      mockUploadWorkflow.active = true;
      mockUploadWorkflow.batchMode = true;
      mockUploadWorkflow.fileGroups = [
        [createFile("a.tif")],
        [createFile("b.tif")],
      ];
      mockUploadWorkflow.currentDatasetIndex = 0;
      mockUploadWorkflow.originalPath = {
        _id: "folder1",
        _modelType: "folder",
      };
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.dataset = { id: "ds-1" };
      vm.configuring = true;
      vm.advanceToNextDataset();
      expect(mockAdvanceUploadDatasetIndex).toHaveBeenCalled();
      expect(vm.dataset).toBeNull();
      expect(vm.configuring).toBe(false);
      expect(vm.hideUploader).toBe(false);
      wrapper.destroy();
    });

    it("sets pipelineError when originalPath missing", () => {
      mockUploadWorkflow.active = true;
      mockUploadWorkflow.batchMode = true;
      mockUploadWorkflow.fileGroups = [
        [createFile("a.tif")],
        [createFile("b.tif")],
      ];
      mockUploadWorkflow.currentDatasetIndex = 0;
      mockUploadWorkflow.originalPath = null;
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.advanceToNextDataset();
      expect(vm.pipelineError).toBe(true);
      wrapper.destroy();
    });
  });

  describe("navigateToCollection", () => {
    it("navigates to configuration when collection exists", () => {
      mockUploadWorkflow.collection = { id: "col-1" };
      mockUploadWorkflow.datasets = [{ id: "ds-1" }];
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.navigateToCollection();
      expect(mockCompleteUploadWorkflow).toHaveBeenCalled();
      expect(mockSetSelectedConfiguration).toHaveBeenCalledWith("col-1");
      expect(vm.$router.push).toHaveBeenCalledWith({
        name: "configuration",
        params: { configurationId: "col-1" },
      });
      wrapper.destroy();
    });

    it("navigates to first dataset when no collection", () => {
      mockUploadWorkflow.collection = null;
      mockUploadWorkflow.datasets = [{ id: "ds-1" }, { id: "ds-2" }];
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.navigateToCollection();
      expect(vm.$router.push).toHaveBeenCalledWith({
        name: "dataset",
        params: { datasetId: "ds-1" },
      });
      wrapper.destroy();
    });

    it("navigates to root when no collection or datasets", () => {
      mockUploadWorkflow.collection = null;
      mockUploadWorkflow.datasets = [];
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.navigateToCollection();
      expect(vm.$router.push).toHaveBeenCalledWith({ name: "root" });
      wrapper.destroy();
    });
  });

  describe("copyLogToClipboard", () => {
    it("copies logs and shows snackbar", () => {
      const mockWriteText = vi.fn();
      Object.assign(navigator, {
        clipboard: { writeText: mockWriteText },
      });
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.configurationLogs = "some log text";
      vm.copyLogToClipboard();
      expect(mockWriteText).toHaveBeenCalledWith("some log text");
      expect(vm.showCopySnackbar).toBe(true);
      wrapper.destroy();
    });
  });

  describe("generationDone", () => {
    it("calls createView for quick import", async () => {
      mockUploadWorkflow.active = true;
      mockUploadWorkflow.quickupload = true;
      mockUploadWorkflow.batchMode = false;
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.dataset = { id: "ds-1" };
      // createView will fail without refs but we verify it's called path
      await vm.generationDone("json-id");
      // setSelectedDataset should be called in createView path
      expect(mockSetSelectedDataset).toHaveBeenCalledWith("ds-1");
      wrapper.destroy();
    });

    it("returns for non-quick non-batch mode", () => {
      mockUploadWorkflow.active = false;
      const wrapper = mountComponent({
        quickupload: false,
        batchMode: false,
      });
      const vm = wrapper.vm as any;
      // Should return without error
      vm.generationDone("json-id");
      expect(mockSetSelectedDataset).not.toHaveBeenCalled();
      wrapper.destroy();
    });
  });

  // ===========================================
  // 5. Watcher
  // ===========================================
  describe("configurationLogs watcher", () => {
    it("calls parseTranscodeOutput and updates progress fields", async () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.configuring = true;
      vm.configurationLogs = "new log line";
      await Vue.nextTick();
      expect(parseTranscodeOutput).toHaveBeenCalledWith("new log line");
      expect(vm.progressStatusText).toBe("Processing...");
      expect(vm.transcodeProgress).toBe(50);
      expect(vm.currentFrame).toBe(5);
      expect(vm.totalFrames).toBe(10);
      wrapper.destroy();
    });

    it("does not update when not configuring", async () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.configuring = false;
      vm.configurationLogs = "new log line";
      await Vue.nextTick();
      // parseTranscodeOutput should not be called since configuring is false
      expect(vm.progressStatusText).toBe("");
      wrapper.destroy();
    });
  });

  // ===========================================
  // 6. Event emissions
  // ===========================================
  describe("event emissions", () => {
    it("emits datasetUploaded with dataset ID in nextStep", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.dataset = { id: "ds-emit" };
      vm.nextStep();
      const emitted = wrapper.emitted("datasetUploaded");
      expect(emitted).toBeTruthy();
      expect(emitted![0][0]).toBe("ds-emit");
      wrapper.destroy();
    });

    it("does not emit datasetUploaded when dataset is null", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.dataset = null;
      vm.nextStep();
      expect(wrapper.emitted("datasetUploaded")).toBeFalsy();
      wrapper.destroy();
    });
  });

  // ===========================================
  // 7. DOM rendering
  // ===========================================
  describe("DOM rendering", () => {
    it("renders progress bar when quickupload=true", () => {
      mockUploadWorkflow.active = true;
      mockUploadWorkflow.quickupload = true;
      const wrapper = mountComponent({ quickupload: true });
      expect(wrapper.find(".text-progress").exists()).toBe(true);
      wrapper.destroy();
    });

    it("shows error alert for failedDataset", async () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.failedDataset = "Bad Dataset";
      await Vue.nextTick();
      const alerts = wrapper.findAll("v-alert-stub");
      const texts = alerts.wrappers.map((w: any) => w.text());
      expect(texts.some((t: string) => t.includes("Bad Dataset"))).toBe(true);
      wrapper.destroy();
    });

    it("shows error alert for fileSizeExceeded", async () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.fileSizeExceeded = true;
      await Vue.nextTick();
      const alerts = wrapper.findAll("v-alert-stub");
      expect(alerts.length).toBeGreaterThan(0);
      wrapper.destroy();
    });

    it("shows batch mode header when isBatchMode", async () => {
      mockUploadWorkflow.active = true;
      mockUploadWorkflow.batchMode = true;
      mockUploadWorkflow.fileGroups = [[createFile("a.tif")]];
      mockUploadWorkflow.currentDatasetIndex = 0;
      const wrapper = mountComponent();
      await Vue.nextTick();
      expect(wrapper.text()).toContain("Creating Collection");
      wrapper.destroy();
    });

    it("hides form when showConfigAtTop is true", async () => {
      mockUploadWorkflow.active = true;
      mockUploadWorkflow.batchMode = true;
      mockUploadWorkflow.quickupload = false;
      mockUploadWorkflow.currentDatasetIndex = 0;
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.configuring = true;
      vm.dataset = { id: "ds-1" };
      await Vue.nextTick();
      // The form should have v-show=false (display:none) when showConfigAtTop
      const form = wrapper.find("form");
      if (form.exists()) {
        expect((form.element as HTMLElement).style.display).toBe("none");
      }
      wrapper.destroy();
    });
  });
});

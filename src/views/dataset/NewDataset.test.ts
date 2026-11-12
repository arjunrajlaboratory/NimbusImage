import { describe, it, expect, vi, beforeEach } from "vitest";
import { nextTick } from "vue";
import { shallowMount, flushPromises } from "@vue/test-utils";

// --- Top-level mock fn handles ---
const mockGetUserApiKeys = vi.fn().mockResolvedValue([]);
const mockGetUserPrivateFolder = vi.fn().mockResolvedValue({
  _id: "private-folder",
  _modelType: "folder",
});
const mockCreateDataset = vi.fn().mockResolvedValue(null);
const mockSetSelectedDataset = vi.fn().mockResolvedValue(undefined);
const mockCreateDatasetView = vi.fn().mockResolvedValue(null);
const mockSetDatasetViewId = vi.fn();
const mockCreateDefaultView = vi.fn().mockResolvedValue({ id: "view-1" });
const mockDatasetInfoToRoute = vi.fn().mockReturnValue({
  name: "dataset",
  params: { datasetId: "ds-1" },
});
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
      getUserPrivateFolder: (...args: any[]) =>
        mockGetUserPrivateFolder(...args),
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

vi.mock("@girder/components", () => ({
  UploadManager: class MockUploadManager {
    constructor() {}
  },
}));

vi.mock("@/girder/components", () => ({
  Upload: {
    name: "GirderUpload",
    template: `
      <div>
        <slot
          name="dropzone"
          :files="files"
          :dropzoneMessage="dropzoneMessage"
          :multiple="multiple"
          :accept="accept"
          :inputFilesChanged="inputFilesChanged"
        />
        <slot name="files" :files="files" />
      </div>
    `,
    props: {
      dest: { type: Object, required: true },
      uploadCls: { type: Function, default: undefined },
      hideStartButton: { type: Boolean, default: false },
      hideHeadline: { type: Boolean, default: false },
      multiple: { type: Boolean, default: true },
      accept: { type: String, default: undefined },
    },
    methods: {
      inputFilesChanged(this: any, files: File[]) {
        this.files = files;
        if (files.length > 0) {
          this.$emit("filesChanged", files);
        }
      },
      startUpload: vi.fn(),
    },
    data: () => ({
      files: [],
      dropzoneMessage: "Drag files here or click to select them",
      totalProgressPercent: 0,
    }),
  },
}));

import { routerProvider } from "@/test/helpers";
import NewDataset from "./NewDataset.vue";
import { parseTranscodeOutput } from "@/utils/strings";

const GirderUploadStub = {
  name: "GirderUpload",
  template: `
    <div>
      <slot
        name="dropzone"
        :files="files"
        :dropzoneMessage="dropzoneMessage"
        :multiple="multiple"
        :accept="accept"
        :inputFilesChanged="inputFilesChanged"
      />
      <slot name="files" :files="files" />
    </div>
  `,
  props: {
    dest: { type: Object, required: true },
    uploadCls: { type: Function, default: undefined },
    hideStartButton: { type: Boolean, default: false },
    hideHeadline: { type: Boolean, default: false },
    multiple: { type: Boolean, default: true },
    accept: { type: String, default: undefined },
  },
  data: () => ({
    files: [],
    dropzoneMessage: "Drag files here or click to select them",
    totalProgressPercent: 0,
  }),
  methods: {
    inputFilesChanged(this: any, files: File[]) {
      this.files = files;
      if (files.length > 0) {
        this.$emit("filesChanged", files);
      }
    },
    startUpload: vi.fn(),
  },
};

const DatasetInfoStub = {
  template: "<div />",
  methods: {
    createDefaultView: (...args: any[]) => mockCreateDefaultView(...args),
    toRoute: (...args: any[]) => mockDatasetInfoToRoute(...args),
  },
};

function createFile(name: string, size = 100): File {
  const file = new File(["x"], name, { type: "application/octet-stream" });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

const mockRouter = { push: vi.fn() };

function mountComponent(props: Record<string, any> = {}, options: any = {}) {
  const { stubs: extraStubs, ...rest } = options;
  return shallowMount(NewDataset, {
    props: {
      initialUploadLocation: { _id: "folder1", _modelType: "folder" },
      ...props,
    },
    global: {
      stubs: {
        GirderLocationChooser: true,
        FileDropzone: true,
        MultiSourceConfiguration: true,
        DatasetInfo: DatasetInfoStub,
        GirderUpload: GirderUploadStub,
        // Vuetify 3 layout stubs need to render slot content for DOM tests
        VContainer: { template: "<div><slot /></div>" },
        VCard: { template: "<div><slot /></div>" },
        VCardTitle: { template: "<div><slot /></div>" },
        VCardText: { template: "<div><slot /></div>" },
        VCardSubtitle: { template: "<div><slot /></div>" },
        VAlert: { template: "<div><slot /></div>", props: ["type", "variant"] },
        VForm: {
          template: "<form><slot /></form>",
          props: ["modelValue", "disabled"],
          emits: ["submit"],
        },
        ...extraStubs,
      },
      provide: {
        ...routerProvider(mockRouter),
      },
    },
    ...rest,
  });
}

// A MultiSourceConfiguration that cannot read the dataset's files.
const FailingConfigurationStub = {
  name: "MultiSourceConfiguration",
  template: "<div />",
  props: ["datasetId", "autoDatasetRoute"],
  data: () => ({
    initialized: null,
    initError: { name: "a.tif", message: "Unsupported file" },
  }),
  methods: {
    initialize: () => Promise.reject(new Error("Unsupported file")),
    submit: vi.fn(),
  },
};

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
    mockRouter.push = vi.fn();
    resetUploadWorkflow();
    mockGetUserApiKeys.mockResolvedValue([]);
    mockGetUserPrivateFolder.mockResolvedValue({
      _id: "private-folder",
      _modelType: "folder",
    });
    mockCreateDataset.mockResolvedValue(null);
    mockCreateDefaultView.mockResolvedValue({ id: "view-1" });
    mockDatasetInfoToRoute.mockReturnValue({
      name: "dataset",
      params: { datasetId: "ds-1" },
    });
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
    });

    it("has uploading=false by default", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.uploading).toBe(false);
    });

    it("has dataset=null by default", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.dataset).toBeNull();
    });

    it("has pipelineError=false by default", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.pipelineError).toBe(false);
    });

    it("has hideUploader=false by default", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.hideUploader).toBe(false);
    });

    it("has empty name and description by default", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.name).toBe("");
      expect(vm.description).toBe("");
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
    });

    it("falls back to env var when maxApiKeyFileSize is null", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.maxApiKeyFileSize = null;
      // Without env var set, should return Infinity
      expect(vm.maxTotalFileSize).toBe(Infinity);
    });
  });

  describe("invalidLocation", () => {
    it("returns false for valid folder path", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.path = { _id: "folder1", _modelType: "folder" };
      expect(vm.invalidLocation).toBe(false);
    });

    it("returns true for unselectable _modelType", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.path = { _id: "root1", _modelType: "root" };
      expect(vm.invalidLocation).toBe(true);
    });

    it("returns true for unselectable type property", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.path = { type: "collections" };
      expect(vm.invalidLocation).toBe(true);
    });

    it("returns false when path is null", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.path = null;
      expect(vm.invalidLocation).toBe(false);
    });
  });

  describe("datasetId", () => {
    it("returns dataset.id when dataset is set", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.dataset = { id: "ds-123" };
      expect(vm.datasetId).toBe("ds-123");
    });

    it("returns null when dataset is null", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.datasetId).toBeNull();
    });
  });

  describe("totalProgressPercentage", () => {
    it("returns non-zero when uploading", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.phase = "uploading";
      // Without uploader ref, should return 0% of step 1
      const progress = vm.totalProgressPercentage;
      expect(progress).toBeGreaterThanOrEqual(0);
      expect(progress).toBeLessThan(100);
    });

    it("returns progress based on configuring logs", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.phase = "configuring";
      vm.configurationLogs = "line1\nline2\nline3\nline4\nline5";
      const progress = vm.totalProgressPercentage;
      // Should be at step 2 (configuring) with some progress
      expect(progress).toBeGreaterThan(0);
    });

    it("returns progress when creatingView", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.phase = "creatingView";
      const progress = vm.totalProgressPercentage;
      expect(progress).toBeGreaterThan(0);
    });
  });

  describe("pageTwo", () => {
    it("returns true when dataset is set", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.dataset = { id: "ds-1" };
      expect(vm.pageTwo).toBe(true);
    });

    it("returns false when dataset is null", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.pageTwo).toBe(false);
    });
  });

  describe("rules", () => {
    it("validation fails for empty string", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      const rule = vm.rules[0];
      expect(rule("")).not.toBe(true);
      expect(rule("  ")).not.toBe(true);
    });

    it("validation passes for non-empty string", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      const rule = vm.rules[0];
      expect(rule("test")).toBe(true);
    });
  });

  describe("filesSelected", () => {
    it("returns true when files are present", () => {
      const wrapper = mountComponent({
        defaultFiles: [createFile("test.tif")],
      });
      const vm = wrapper.vm as any;
      expect(vm.filesSelected).toBe(true);
    });

    it("returns false when no files", () => {
      const wrapper = mountComponent({ defaultFiles: [] });
      const vm = wrapper.vm as any;
      expect(vm.filesSelected).toBe(false);
    });
  });

  describe("recommendedName", () => {
    it("returns empty string for no files", () => {
      const wrapper = mountComponent({ defaultFiles: [] });
      const vm = wrapper.vm as any;
      expect(vm.recommendedName).toBe("");
    });

    it("returns basename for single file", () => {
      const wrapper = mountComponent({
        defaultFiles: [createFile("image.tif")],
      });
      const vm = wrapper.vm as any;
      expect(vm.recommendedName).toBe("image");
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
    });
  });

  describe("isQuickImport", () => {
    it("uses store when active", () => {
      mockUploadWorkflow.active = true;
      mockUploadWorkflow.quickupload = true;
      const wrapper = mountComponent({ quickupload: false });
      const vm = wrapper.vm as any;
      expect(vm.isQuickImport).toBe(true);
    });

    it("falls back to prop when store inactive", () => {
      mockUploadWorkflow.active = false;
      const wrapper = mountComponent({ quickupload: true });
      const vm = wrapper.vm as any;
      expect(vm.isQuickImport).toBe(true);
    });

    it("returns false when both store and prop are false", () => {
      mockUploadWorkflow.active = false;
      const wrapper = mountComponent({ quickupload: false });
      const vm = wrapper.vm as any;
      expect(vm.isQuickImport).toBe(false);
    });
  });

  describe("isBatchMode", () => {
    it("uses store when active", () => {
      mockUploadWorkflow.active = true;
      mockUploadWorkflow.batchMode = true;
      const wrapper = mountComponent({ batchMode: false });
      const vm = wrapper.vm as any;
      expect(vm.isBatchMode).toBe(true);
    });

    it("falls back to prop when store inactive", () => {
      mockUploadWorkflow.active = false;
      const wrapper = mountComponent({ batchMode: true });
      const vm = wrapper.vm as any;
      expect(vm.isBatchMode).toBe(true);
    });
  });

  describe("effectiveBatchName", () => {
    it("prefers store batchName", () => {
      mockUploadWorkflow.batchName = "Store Batch";
      const wrapper = mountComponent({ batchName: "Prop Batch" });
      const vm = wrapper.vm as any;
      expect(vm.effectiveBatchName).toBe("Store Batch");
    });

    it("falls back to prop batchName", () => {
      mockUploadWorkflow.batchName = "";
      const wrapper = mountComponent({ batchName: "Prop Batch" });
      const vm = wrapper.vm as any;
      expect(vm.effectiveBatchName).toBe("Prop Batch");
    });

    it("returns empty string when neither is set", () => {
      mockUploadWorkflow.batchName = "";
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.effectiveBatchName).toBe("");
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
    });

    it("uses fileGroups prop when store inactive", () => {
      mockUploadWorkflow.active = false;
      const wrapper = mountComponent({
        fileGroups: [[createFile("a.tif")], [createFile("b.tif")]],
      });
      const vm = wrapper.vm as any;
      expect(vm.totalDatasets).toBe(2);
    });

    it("returns 1 for single defaultFiles when no fileGroups", () => {
      mockUploadWorkflow.active = false;
      const wrapper = mountComponent({
        fileGroups: [],
        defaultFiles: [createFile("a.tif")],
      });
      const vm = wrapper.vm as any;
      expect(vm.totalDatasets).toBe(1);
    });
  });

  describe("isFirstDataset", () => {
    it("uses store when active", () => {
      mockUploadWorkflow.active = true;
      mockUploadWorkflow.currentDatasetIndex = 0;
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.isFirstDataset).toBe(true);
    });

    it("returns false for non-zero index from store", () => {
      mockUploadWorkflow.active = true;
      mockUploadWorkflow.currentDatasetIndex = 2;
      mockUploadWorkflow.fileGroups = [[], [], []];
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.isFirstDataset).toBe(false);
    });

    it("uses local index when store inactive", () => {
      mockUploadWorkflow.active = false;
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.isFirstDataset).toBe(true);
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
      vm.phase = "configuring";
      expect(vm.showConfigAtTop).toBe(true);
    });

    it("returns false when not batch mode", () => {
      mockUploadWorkflow.active = true;
      mockUploadWorkflow.batchMode = false;
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.phase = "configuring";
      expect(vm.showConfigAtTop).toBe(false);
    });

    it("returns false when quick import", () => {
      mockUploadWorkflow.active = true;
      mockUploadWorkflow.batchMode = true;
      mockUploadWorkflow.quickupload = true;
      mockUploadWorkflow.currentDatasetIndex = 0;
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.phase = "configuring";
      expect(vm.showConfigAtTop).toBe(false);
    });

    it("returns false when not configuring", () => {
      mockUploadWorkflow.active = true;
      mockUploadWorkflow.batchMode = true;
      mockUploadWorkflow.quickupload = false;
      mockUploadWorkflow.currentDatasetIndex = 0;
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.phase = "idle";
      expect(vm.showConfigAtTop).toBe(false);
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
    });

    it("returns defaultFiles in single mode", () => {
      mockUploadWorkflow.active = false;
      const files = [createFile("d.tif")];
      const wrapper = mountComponent({ defaultFiles: files });
      const vm = wrapper.vm as any;
      expect(vm.currentFiles).toEqual(files);
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
    });

    it("returns uploadedFiles when set in single mode", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      const files = [createFile("manual.tif")];
      vm.uploadedFiles = files;
      expect(vm.files).toEqual(files);
    });

    it("checks store when upload workflow active and no uploadedFiles", () => {
      mockUploadWorkflow.active = true;
      mockUploadWorkflow.batchMode = false;
      mockUploadWorkflow.fileGroups = [[createFile("store.tif")]];
      mockUploadWorkflow.currentDatasetIndex = 0;
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.files).toEqual([createFile("store.tif")]);
    });

    it("falls back to defaultFiles prop", () => {
      mockUploadWorkflow.active = false;
      const files = [createFile("default.tif")];
      const wrapper = mountComponent({ defaultFiles: files });
      const vm = wrapper.vm as any;
      expect(vm.files).toEqual(files);
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
      await nextTick();
      const vm = wrapper.vm as any;
      expect(vm.path).toEqual({
        _id: "store-folder",
        _modelType: "folder",
      });
      expect(vm.name).toBe("Store Name");
      expect(vm.description).toBe("Store Desc");
    });

    it("sets from props when store inactive", async () => {
      mockUploadWorkflow.active = false;
      const wrapper = mountComponent({
        initialUploadLocation: { _id: "prop-folder", _modelType: "folder" },
        initialName: "Prop Name",
        initialDescription: "Prop Desc",
      });
      await nextTick();
      const vm = wrapper.vm as any;
      expect(vm.path).toEqual({ _id: "prop-folder", _modelType: "folder" });
      expect(vm.name).toBe("Prop Name");
      expect(vm.description).toBe("Prop Desc");
    });

    it("falls back to the user private folder when no initial location exists", async () => {
      mockUploadWorkflow.active = false;
      const wrapper = mountComponent({ initialUploadLocation: null });
      await nextTick();
      await nextTick();
      const vm = wrapper.vm as any;
      expect(mockGetUserPrivateFolder).toHaveBeenCalled();
      expect(vm.path).toEqual({ _id: "private-folder", _modelType: "folder" });
    });

    it("calls getMaxUploadSize on mount", async () => {
      mockGetUserApiKeys.mockResolvedValue([]);
      mountComponent();
      await nextTick();
      await nextTick();
      expect(mockGetUserApiKeys).toHaveBeenCalled();
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
    });

    it("returns null for unrecognized scope", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.convertScopeToBytes(["unknown.scope"])).toBeNull();
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
    });

    it("returns null when active keys have no matching scopes", async () => {
      mockGetUserApiKeys.mockResolvedValue([
        { active: true, scope: ["some.other.scope"] },
      ]);
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      const result = await vm.getMaxUploadSize();
      expect(result).toBeNull();
    });
  });

  describe("primary upload dropzone", () => {
    it("renders the app FileDropzone in GirderUpload's dropzone slot", async () => {
      const wrapper = mountComponent();
      await nextTick();

      const dropzone = wrapper.findComponent({ name: "FileDropzone" });

      expect(dropzone.exists()).toBe(true);
      expect(dropzone.props("multiple")).toBe(true);
      expect(dropzone.props("accept")).toBeUndefined();
    });

    it("updates selected files when the primary dropzone emits files", async () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      await nextTick();

      const file = createFile("dropped-image.tif", 50);
      const dropzone = wrapper.findComponent({ name: "FileDropzone" });

      await dropzone.vm.$emit("update:modelValue", [file]);

      expect(vm.uploadedFiles).toEqual([file]);
      expect(vm.files).toEqual([file]);
      expect(vm.name).toBe("dropped-image");
    });
  });

  describe("filesChanged", () => {
    it("sets uploadedFiles from FileUpload format", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      const file = createFile("test.tif", 50);
      vm.filesChanged([{ file }]);
      expect(vm.uploadedFiles).toEqual([file]);
    });

    it("sets uploadedFiles from raw File format", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      const file = createFile("test.tif", 50);
      vm.filesChanged([file]);
      expect(vm.uploadedFiles).toEqual([file]);
    });

    it("detects file size exceeded", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.maxApiKeyFileSize = 100; // Set small limit
      const largeFile = createFile("big.tif", 200);
      vm.filesChanged([{ file: largeFile }]);
      expect(vm.fileSizeExceeded).toBe(true);
      expect(vm.uploadedFiles).toBeNull();
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
    });

    it("updates name from recommendedName when name is empty", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.name = "";
      const file = createFile("myimage.tif", 50);
      vm.filesChanged([{ file }]);
      expect(vm.name).toBe("myimage");
    });

    it("does not overwrite existing name", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.name = "Existing Name";
      const file = createFile("myimage.tif", 50);
      vm.filesChanged([{ file }]);
      expect(vm.name).toBe("Existing Name");
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
    });
  });

  describe("interruptedUpload", () => {
    it("stops uploading and reports the failure", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.phase = "uploading";
      vm.interruptedUpload();
      expect(vm.uploading).toBe(false);
      expect(vm.pipelineError).toBe(true);
      expect(vm.failedPhase).toBe("uploading");
    });

    it("resumes an interrupted upload into the same dataset instead of creating another", async () => {
      const wrapper = mountComponent();
      await flushPromises();
      const vm = wrapper.vm as any;
      const file = createFile("a.tif");
      vm.filesChanged([file]);
      vm.valid = true;
      // submit() created the dataset and pointed path at its folder.
      vm.dataset = { id: "ds-1" };
      vm.path = { _id: "ds-1-folder", _modelType: "folder" };
      vm.phase = "uploading";
      await nextTick();
      const startUpload = vi.spyOn(vm.uploader, "startUpload");

      vm.interruptedUpload();
      await vm.submit();

      expect(mockCreateDataset).not.toHaveBeenCalled();
      expect(startUpload).toHaveBeenCalledTimes(1);
      expect(vm.uploading).toBe(true);
      expect(vm.pipelineError).toBe(false);
    });
  });

  describe("nextStep", () => {
    it("sets hideUploader and uploading=false", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.dataset = { id: "ds-1" };
      vm.phase = "uploading";
      vm.nextStep();
      expect(vm.hideUploader).toBe(true);
      expect(vm.uploading).toBe(false);
    });

    it("emits datasetUploaded with dataset id", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.dataset = { id: "ds-1" };
      vm.nextStep();
      expect(wrapper.emitted("datasetUploaded")).toBeTruthy();
      expect(wrapper.emitted("datasetUploaded")![0][0]).toBe("ds-1");
    });

    it("sets pipelineError when dataset is null", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.dataset = null;
      vm.nextStep();
      expect(vm.pipelineError).toBe(true);
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
      expect(mockRouter.push).toHaveBeenCalledWith({
        name: "multi",
        params: { datasetId: "ds-1" },
      });
    });
  });

  describe("submit", () => {
    it("retries after a failure that happened before any dataset was created", async () => {
      mockCreateDataset.mockResolvedValue({ id: "ds-new" });
      const wrapper = mountComponent({ initialUploadLocation: null });
      const vm = wrapper.vm as any;
      vm.failedPhase = "idle";
      vm.valid = true;
      vm.path = { _id: "folder1", _modelType: "folder" };
      vm.name = "Retry";
      await vm.submit();
      expect(mockCreateDataset).toHaveBeenCalledTimes(1);
      expect(vm.pipelineError).toBe(false);
    });

    it("does not create a second dataset once the files are uploaded", async () => {
      // e.g. the uploader embedded in AddDatasetToCollection, after nextStep
      const wrapper = mountComponent({ autoMultiConfig: false });
      const vm = wrapper.vm as any;
      vm.filesChanged([createFile("a.tif")]);
      vm.valid = true;
      vm.dataset = { id: "ds-1" };
      vm.path = { _id: "ds-1-folder", _modelType: "folder" };
      vm.nextStep();
      expect(vm.uploadDisabled).toBe(true);
      await vm.submit();
      expect(mockCreateDataset).not.toHaveBeenCalled();
    });

    it("returns early when form is not valid", async () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.valid = false;
      await vm.submit();
      expect(mockCreateDataset).not.toHaveBeenCalled();
    });

    it("returns early when path has no _id", async () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.valid = true;
      vm.path = { type: "root" };
      await vm.submit();
      expect(mockCreateDataset).not.toHaveBeenCalled();
    });

    it("sets pipelineError when fileSizeExceeded", async () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.valid = true;
      vm.path = { _id: "folder1", _modelType: "folder" };
      vm.fileSizeExceeded = true;
      await vm.submit();
      expect(vm.pipelineError).toBe(true);
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
      await nextTick();
      await vm.submit();
      await nextTick();
      expect(mockCreateDataset).toHaveBeenCalledWith({
        name: "Test Dataset",
        description: "desc",
        path: { _id: "folder1", _modelType: "folder" },
      });
      expect(vm.dataset).toEqual(mockDataset);
      expect(vm.uploading).toBe(true);
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
      await nextTick();
      await vm.submit();
      await nextTick();
      expect(mockAddUploadedDataset).toHaveBeenCalledWith(mockDataset);
    });
  });

  describe("handleBatchError", () => {
    it("sets pipelineError in single mode", () => {
      mockUploadWorkflow.active = false;
      const wrapper = mountComponent({ batchMode: false });
      const vm = wrapper.vm as any;
      vm.handleBatchError("Something went wrong");
      expect(vm.pipelineError).toBe(true);
    });

    it("shows dialog in batch mode", () => {
      mockUploadWorkflow.active = true;
      mockUploadWorkflow.batchMode = true;
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.handleBatchError("Batch error");
      expect(vm.showBatchErrorDialog).toBe(true);
      expect(vm.batchErrorMessage).toBe("Batch error");
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
      expect(mockRouter.push).toHaveBeenCalledWith({
        name: "configuration",
        params: { configurationId: "col-1" },
      });
    });

    it("navigates to dataset when no collection but has datasets", () => {
      mockUploadWorkflow.active = true;
      mockUploadWorkflow.collection = null;
      mockUploadWorkflow.datasets = [{ id: "ds-1" }];
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.handleStopBatch();
      expect(mockRouter.push).toHaveBeenCalledWith({
        name: "dataset",
        params: { datasetId: "ds-1" },
      });
    });

    it("navigates to root when no collection or datasets", () => {
      mockUploadWorkflow.active = true;
      mockUploadWorkflow.collection = null;
      mockUploadWorkflow.datasets = [];
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.handleStopBatch();
      expect(mockRouter.push).toHaveBeenCalledWith({ name: "root" });
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
      vm.failedPhase = "configuring";
      vm.batchErrorMessage = "error";
      vm.handleContinueBatch();
      expect(vm.showBatchErrorDialog).toBe(false);
      expect(vm.skippedDatasets).toContain(2);
      expect(vm.pipelineError).toBe(false);
      expect(vm.batchErrorMessage).toBe("");
    });
  });

  describe("advanceToNextDataset", () => {
    it("resets everything the pipeline set for the previous dataset", () => {
      mockUploadWorkflow.active = true;
      mockUploadWorkflow.batchMode = true;
      mockUploadWorkflow.fileGroups = [
        [createFile("a.tif")],
        [createFile("b.tif")],
      ];
      mockUploadWorkflow.originalPath = {
        _id: "folder1",
        _modelType: "folder",
      };
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.dataset = { id: "ds-1" };
      vm.phase = "creatingView";
      vm.failedPhase = "creatingView";
      vm.failedDataset = "a";
      vm.progressStatusText = "Transcoding...";
      vm.totalFrames = 10;
      vm.currentFrame = 5;
      vm.hideUploader = true;

      vm.advanceToNextDataset();

      expect(vm.phase).toBe("idle");
      expect(vm.creatingView).toBe(false);
      expect(vm.pipelineError).toBe(false);
      expect(vm.failedDataset).toBe("");
      expect(vm.progressStatusText).toBe("");
      expect(vm.totalFrames).toBe(0);
      expect(vm.currentFrame).toBe(0);
      expect(vm.hideUploader).toBe(false);
    });

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
      vm.phase = "configuring";
      vm.advanceToNextDataset();
      expect(mockAdvanceUploadDatasetIndex).toHaveBeenCalled();
      expect(vm.dataset).toBeNull();
      expect(vm.configuring).toBe(false);
      expect(vm.hideUploader).toBe(false);
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
      expect(mockRouter.push).toHaveBeenCalledWith({
        name: "configuration",
        params: { configurationId: "col-1" },
      });
    });

    it("navigates to first dataset when no collection", () => {
      mockUploadWorkflow.collection = null;
      mockUploadWorkflow.datasets = [{ id: "ds-1" }, { id: "ds-2" }];
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.navigateToCollection();
      expect(mockRouter.push).toHaveBeenCalledWith({
        name: "dataset",
        params: { datasetId: "ds-1" },
      });
    });

    it("navigates to root when no collection or datasets", () => {
      mockUploadWorkflow.collection = null;
      mockUploadWorkflow.datasets = [];
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.navigateToCollection();
      expect(mockRouter.push).toHaveBeenCalledWith({ name: "root" });
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
    });
  });

  describe("pipeline failures", () => {
    beforeEach(() => {
      mockUploadWorkflow.active = true;
      mockUploadWorkflow.quickupload = true;
      mockUploadWorkflow.batchMode = false;
    });

    it("stops configuring and shows why when the files cannot be read", async () => {
      const wrapper = mountComponent(
        {},
        { stubs: { MultiSourceConfiguration: FailingConfigurationStub } },
      );
      const vm = wrapper.vm as any;
      vm.dataset = { id: "ds-1" };

      await vm.configureDataset();

      expect(vm.configuring).toBe(false);
      expect(vm.pipelineError).toBe(true);
      expect(vm.processingError).toBe(
        "Could not read the dataset's files (a.tif: Unsupported file)",
      );
    });

    // Renders buttons and card actions so their clicks can be driven.
    const buttonStubs = {
      VBtn: {
        template: "<button @click=\"$emit('click')\"><slot /></button>",
        emits: ["click"],
      },
      VCardActions: { template: "<div><slot /></div>" },
    };

    // Quick import whose files are uploaded and whose first read fails.
    async function failReadingFiles(initialize: () => Promise<void>) {
      const stub = {
        ...FailingConfigurationStub,
        methods: { initialize, submit: mockConfigurationSubmit },
      };
      const wrapper = mountComponent(
        {},
        { stubs: { MultiSourceConfiguration: stub, ...buttonStubs } },
      );
      await flushPromises();
      const vm = wrapper.vm as any;
      vm.dataset = { id: "ds-1" };
      vm.hideUploader = true;
      await vm.configureDataset();
      await nextTick();
      return wrapper;
    }

    const mockConfigurationSubmit = vi.fn();

    function buttonNamed(wrapper: any, label: string) {
      return wrapper
        .findAll("button")
        .find((b: any) => b.text().trim() === label);
    }

    it("says the quick import failed, not that it is in progress", async () => {
      const wrapper = await failReadingFiles(() =>
        Promise.reject(new Error("Unsupported file")),
      );

      expect(wrapper.text()).toContain("Quick Import Failed");
      expect(wrapper.text()).not.toContain("in Progress");
      // The files are uploaded, so Upload could only make a second dataset.
      expect(wrapper.find('[data-tour="upload-button"]').exists()).toBe(false);
    });

    it("reads the files again on Try again without creating another dataset", async () => {
      mockConfigurationSubmit.mockClear();
      const initialize = vi
        .fn()
        .mockRejectedValueOnce(new Error("Unsupported file"))
        .mockResolvedValue(undefined);
      const wrapper = await failReadingFiles(initialize);
      const vm = wrapper.vm as any;
      expect(vm.failedPhase).toBe("readingFiles");

      await buttonNamed(wrapper, "Try again")!.trigger("click");
      await flushPromises();

      expect(initialize).toHaveBeenCalledTimes(2);
      expect(mockConfigurationSubmit).toHaveBeenCalledTimes(1);
      expect(vm.pipelineError).toBe(false);
      expect(vm.processingError).toBeNull();
      expect(vm.phase).toBe("configuring");
      expect(mockCreateDataset).not.toHaveBeenCalled();
      expect(wrapper.text()).toContain("Quick Import in Progress");
    });

    it("does not offer Try again once generating the configuration has failed", async () => {
      const wrapper = mountComponent({}, { stubs: buttonStubs });
      await flushPromises();
      const vm = wrapper.vm as any;
      vm.dataset = { id: "ds-1" };
      vm.hideUploader = true;
      vm.phase = "configuring";
      vm.generationFailed("The transcoding job failed");
      await nextTick();

      expect(vm.failedPhase).toBe("configuring");
      expect(vm.canRetryReadingFiles).toBe(false);
      expect(buttonNamed(wrapper, "Try again")).toBeUndefined();
      vm.retryReadingFiles();
      expect(vm.pipelineError).toBe(true);
      expect(buttonNamed(wrapper, "Back to home")).toBeDefined();
    });

    it("leaves a failed quick import for the home page", async () => {
      const wrapper = await failReadingFiles(() =>
        Promise.reject(new Error("Unsupported file")),
      );

      await buttonNamed(wrapper, "Back to home")!.trigger("click");

      expect(mockRouter.push).toHaveBeenCalledWith({ name: "root" });
    });

    it("leaves no phase running beside the error when the default view fails", async () => {
      mockCreateDefaultView.mockResolvedValue(null);
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.dataset = { id: "ds-1" };
      vm.phase = "configuring";

      await vm.createView();
      await nextTick();

      expect(vm.creatingView).toBe(false);
      expect(vm.pipelineError).toBe(true);
      expect(vm.failedPhase).toBe("creatingView");
      // DatasetInfo stays mounted so a view can be created by hand.
      expect(vm.viewCreation).toBeTruthy();
      expect(mockRouter.push).not.toHaveBeenCalled();
    });
  });

  describe("upload workflow", () => {
    it("uses the store's quick-import mode in the template on the routed path", () => {
      mockUploadWorkflow.active = true;
      mockUploadWorkflow.quickupload = true;
      // The newdataset route passes no quickupload prop.
      const wrapper = mountComponent({ quickupload: false });
      expect(wrapper.text()).toContain("Quick Import in Progress");
    });

    it("gives each batch dataset a fresh uploader", async () => {
      const wrapper = mountComponent();
      await flushPromises();
      const first = wrapper.findComponent({ name: "GirderUpload" });
      expect(first.exists()).toBe(true);

      // The mocked workflow is not reactive: re-render through local state.
      mockUploadWorkflow.currentDatasetIndex = 1;
      (wrapper.vm as any).name = "next dataset";
      await nextTick();

      const second = wrapper.findComponent({ name: "GirderUpload" });
      expect(second.exists()).toBe(true);
      expect(second.vm).not.toBe(first.vm);
    });

    it("completes the workflow when the page is left", () => {
      mockUploadWorkflow.active = true;
      mockUploadWorkflow.fileGroups = [[createFile("a.tif")]];
      const wrapper = mountComponent();
      wrapper.unmount();
      expect(mockCompleteUploadWorkflow).toHaveBeenCalledTimes(1);
    });

    it("leaves an inactive workflow alone when the page is left", () => {
      const wrapper = mountComponent();
      wrapper.unmount();
      expect(mockCompleteUploadWorkflow).not.toHaveBeenCalled();
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
      await vm.generationDone("json-id");
      expect(mockSetSelectedDataset).toHaveBeenCalledWith("ds-1");
      expect(mockCreateDefaultView).toHaveBeenCalled();
      expect(mockSetDatasetViewId).toHaveBeenCalledWith({ id: "view-1" });
      expect(mockRouter.push).toHaveBeenCalledWith({
        name: "dataset",
        params: { datasetId: "ds-1" },
      });
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
    });
  });

  // ===========================================
  // 5. Watcher
  // ===========================================
  describe("configurationLogs watcher", () => {
    it("calls parseTranscodeOutput and updates progress fields", async () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.phase = "configuring";
      vm.configurationLogs = "new log line";
      await nextTick();
      expect(parseTranscodeOutput).toHaveBeenCalledWith("new log line");
      expect(vm.progressStatusText).toBe("Processing...");
      expect(vm.transcodeProgress).toBe(50);
      expect(vm.currentFrame).toBe(5);
      expect(vm.totalFrames).toBe(10);
    });

    it("does not update when not configuring", async () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.phase = "idle";
      vm.configurationLogs = "new log line";
      await nextTick();
      // parseTranscodeOutput should not be called since configuring is false
      expect(vm.progressStatusText).toBe("");
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
    });

    it("does not emit datasetUploaded when dataset is null", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.dataset = null;
      vm.nextStep();
      expect(wrapper.emitted("datasetUploaded")).toBeFalsy();
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
    });

    it("shows error alert for failedDataset", async () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.failedDataset = "Bad Dataset";
      await nextTick();
      expect(wrapper.html()).toContain("Bad Dataset");
    });

    it("shows error alert for fileSizeExceeded", async () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.fileSizeExceeded = true;
      await nextTick();
      // With custom VAlert stubs, check rendered HTML for the alert content
      expect(wrapper.html()).toContain("exceeds the maximum");
    });

    it("shows batch mode header when isBatchMode", async () => {
      mockUploadWorkflow.active = true;
      mockUploadWorkflow.batchMode = true;
      mockUploadWorkflow.fileGroups = [[createFile("a.tif")]];
      mockUploadWorkflow.currentDatasetIndex = 0;
      const wrapper = mountComponent();
      await nextTick();
      expect(wrapper.text()).toContain("Creating Collection");
    });

    it("hides form when showConfigAtTop is true", async () => {
      mockUploadWorkflow.active = true;
      mockUploadWorkflow.batchMode = true;
      mockUploadWorkflow.quickupload = false;
      mockUploadWorkflow.currentDatasetIndex = 0;
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.phase = "configuring";
      vm.dataset = { id: "ds-1" };
      await nextTick();
      // The form should have v-show=false (display:none) when showConfigAtTop
      const form = wrapper.find("form");
      if (form.exists()) {
        expect((form.element as HTMLElement).style.display).toBe("none");
      }
    });
  });
});

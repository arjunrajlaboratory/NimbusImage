import { describe, it, expect, vi, beforeEach } from "vitest";
import { nextTick } from "vue";
import { shallowMount, flushPromises } from "@vue/test-utils";

const mockGetUserPrivateFolder = vi.fn();
const mockFindDatasetViews = vi.fn();
const mockSetSelectedDataset = vi.fn();
const mockCreateDatasetView = vi.fn();
const mockGetDataset = vi.fn();
const mockIsDatasetFolder = vi.fn();
const mockGetDatasetCompatibility = vi.fn();
const mockAreCompatibles = vi.fn();
const mockConfigInitialize = vi.fn();
const mockConfigSubmit = vi.fn();

vi.mock("@/store", () => ({
  default: {
    api: {
      getUserPrivateFolder: (...args: any[]) =>
        mockGetUserPrivateFolder(...args),
      findDatasetViews: (...args: any[]) => mockFindDatasetViews(...args),
    },
    girderUser: { _id: "user1", _modelType: "user" as const },
    setSelectedDataset: (...args: any[]) => mockSetSelectedDataset(...args),
    createDatasetView: (...args: any[]) => mockCreateDatasetView(...args),
  },
}));

vi.mock("@/store/annotation", () => ({ default: {} }));
vi.mock("@/store/properties", () => ({ default: {} }));

vi.mock("@/store/girderResources", () => ({
  default: {
    getDataset: (...args: any[]) => mockGetDataset(...args),
  },
}));

vi.mock("@/store/GirderAPI", () => ({
  getDatasetCompatibility: (...args: any[]) =>
    mockGetDatasetCompatibility(...args),
}));

vi.mock("@/store/model", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    areCompatibles: (...args: any[]) => mockAreCompatibles(...args),
  };
});

vi.mock("@/utils/girderSelectable", () => ({
  isDatasetFolder: (...args: any[]) => mockIsDatasetFolder(...args),
}));

vi.mock("@/utils/log", () => ({
  logError: vi.fn(),
}));

vi.mock("@/components/CustomFileManager.vue", () => ({
  default: {
    name: "CustomFileManager",
    template: "<div></div>",
    props: [
      "title",
      "breadcrumb",
      "selectable",
      "location",
      "initialItemsPerPage",
      "itemsPerPageOptions",
      "menuEnabled",
      "moreChips",
      "clickableChips",
    ],
  },
}));

vi.mock("@/views/dataset/MultiSourceConfiguration.vue", () => ({
  default: {
    name: "MultiSourceConfiguration",
    template: "<div></div>",
    props: ["datasetId", "autoDatasetRoute"],
    emits: ["generatedJson", "generationError", "log"],
    data: () => ({
      initialized: null,
      initError: null,
      generationErrorMessage: null,
    }),
    methods: {
      initialize: (...args: any[]) => mockConfigInitialize(...args),
      submit: (...args: any[]) => mockConfigSubmit(...args),
    },
  },
}));

vi.mock("@/views/dataset/NewDataset.vue", () => ({
  default: {
    name: "NewDataset",
    template: "<div></div>",
    props: ["autoMultiConfig", "initialUploadLocation"],
  },
}));

import AddDatasetToCollection from "./AddDatasetToCollection.vue";

const sampleCollection = {
  id: "c1",
  name: "Test Collection",
  description: "",
  compatibility: {
    xyDimensions: { length: 1 },
    zDimensions: { length: 1 },
    tDimensions: { length: 1 },
    channels: { 0: "DAPI" },
  },
  layers: [],
  tools: [],
  snapshots: [],
  propertyIds: [],
  scales: {},
} as any;

function mountComponent(props = {}, options: any = {}) {
  return shallowMount(AddDatasetToCollection, {
    props: {
      collection: sampleCollection,
      ...props,
    },
    ...options,
  });
}

// Renders the upload branch's MultiSourceConfiguration (the mocked one).
const withConfiguration = {
  global: {
    renderStubDefaultSlot: true,
    stubs: { MultiSourceConfiguration: false },
  },
};

describe("AddDatasetToCollection", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockGetUserPrivateFolder.mockResolvedValue({ _id: "private" });
    mockFindDatasetViews.mockResolvedValue([]);
    mockSetSelectedDataset.mockResolvedValue(undefined);
    mockCreateDatasetView.mockResolvedValue({ id: "view1" });
    mockGetDatasetCompatibility.mockReturnValue({});
    mockAreCompatibles.mockReturnValue(true);
    mockIsDatasetFolder.mockReturnValue(true);
  });

  it("addDatasetOptionType getter returns option type", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.addDatasetOptionType).toBe("upload");
  });

  it("addDatasetOptionType setter switches to add", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.addDatasetOptionType = "add";
    expect(vm.option.type).toBe("add");
    expect(vm.option.datasets).toEqual([]);
    expect(vm.option.warnings).toEqual([]);
  });

  it("addDatasetOptionType setter switches to upload", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.addDatasetOptionType = "add";
    expect(vm.option.type).toBe("add");
    vm.addDatasetOptionType = "upload";
    expect(vm.option.type).toBe("upload");
    expect(vm.option.editVariables).toBe(false);
    expect(vm.option.configuring).toBe(false);
  });

  it("canAddDatasetToCollection returns false when no datasets selected (add mode)", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.addDatasetOptionType = "add";
    expect(vm.canAddDatasetToCollection).toBe(false);
  });

  it("canAddDatasetToCollection returns true when datasets are selected (add mode)", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.addDatasetOptionType = "add";
    vm.option.datasets = [{ id: "ds1", name: "Dataset 1" }];
    expect(vm.canAddDatasetToCollection).toBe(true);
  });

  it("canAddDatasetToCollection returns false in upload mode", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.option.type).toBe("upload");
    expect(vm.canAddDatasetToCollection).toBe(false);
  });

  it("initializes upload location on mount", async () => {
    mockGetUserPrivateFolder.mockResolvedValue({ _id: "private-folder" });
    const wrapper = mountComponent();
    await flushPromises();
    const vm = wrapper.vm as any;
    expect(mockGetUserPrivateFolder).toHaveBeenCalled();
    expect(vm.uploadLocation).toEqual({ _id: "private-folder" });
  });

  it("falls back to girderUser if getUserPrivateFolder fails", async () => {
    mockGetUserPrivateFolder.mockRejectedValue(new Error("fail"));
    const wrapper = mountComponent();
    await flushPromises();
    const vm = wrapper.vm as any;
    expect(vm.uploadLocation).toEqual({
      _id: "user1",
      _modelType: "user",
    });
  });

  it("resets option when collection prop changes", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.addDatasetOptionType = "add";
    expect(vm.option.type).toBe("add");

    await wrapper.setProps({
      collection: { ...sampleCollection, id: "c2", name: "Other" },
    });
    await nextTick();

    expect(vm.option.type).toBe("upload");
  });

  it("selectAddDatasetFolder clears datasets when empty locations", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.addDatasetOptionType = "add";
    vm.option.datasets = [{ id: "ds1", name: "old" }];

    await vm.selectAddDatasetFolder([]);

    expect(vm.option.datasets).toEqual([]);
    expect(vm.option.warnings).toEqual([]);
  });

  it("selectAddDatasetFolder processes selected dataset folders", async () => {
    mockGetDataset.mockResolvedValue({ id: "ds1", name: "Dataset 1" });

    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.addDatasetOptionType = "add";

    await vm.selectAddDatasetFolder([{ _id: "ds1", _modelType: "folder" }]);

    expect(mockIsDatasetFolder).toHaveBeenCalled();
    expect(mockGetDataset).toHaveBeenCalledWith({ id: "ds1" });
    expect(vm.option.datasets).toHaveLength(1);
    expect(vm.option.datasets[0].id).toBe("ds1");
  });

  it("selectAddDatasetFolder warns about non-dataset items", async () => {
    mockIsDatasetFolder.mockReturnValue(false);

    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.addDatasetOptionType = "add";

    await vm.selectAddDatasetFolder([{ _id: "not-ds", _modelType: "folder" }]);

    expect(vm.option.datasets).toEqual([]);
    expect(vm.option.warnings).toContain("1 selected items are not datasests");
  });

  it("selectAddDatasetFolder warns about incompatible datasets", async () => {
    mockGetDataset.mockResolvedValue({ id: "ds1", name: "Dataset 1" });
    mockAreCompatibles.mockReturnValue(false);

    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.addDatasetOptionType = "add";

    await vm.selectAddDatasetFolder([{ _id: "ds1", _modelType: "folder" }]);

    expect(vm.option.datasets).toEqual([]);
    expect(vm.option.warnings).toContain(
      "1 selected items are not compatible with the current configuration",
    );
  });

  it("selectAddDatasetFolder excludes already-added datasets", async () => {
    mockGetDataset.mockResolvedValue({ id: "ds1", name: "Dataset 1" });
    mockFindDatasetViews.mockResolvedValue([{ datasetId: "ds1" }]);

    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.addDatasetOptionType = "add";

    await vm.selectAddDatasetFolder([{ _id: "ds1", _modelType: "folder" }]);

    expect(vm.option.datasets).toEqual([]);
  });

  it("addDatasetToCollection creates views and emits addedDatasets", async () => {
    mockCreateDatasetView.mockResolvedValue({ id: "view1" });

    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.addDatasetOptionType = "add";
    vm.option.datasets = [
      { id: "ds1", name: "Dataset 1" },
      { id: "ds2", name: "Dataset 2" },
    ];

    await vm.addDatasetToCollection();

    expect(mockCreateDatasetView).toHaveBeenCalledTimes(2);
    expect(mockCreateDatasetView).toHaveBeenCalledWith({
      datasetId: "ds1",
      configurationId: "c1",
    });
    expect(mockCreateDatasetView).toHaveBeenCalledWith({
      datasetId: "ds2",
      configurationId: "c1",
    });
    expect(wrapper.emitted("addedDatasets")).toBeTruthy();
    expect(wrapper.emitted("addedDatasets")![0][0]).toEqual(["ds1", "ds2"]);
    // Option should reset to upload after adding
    expect(vm.option.type).toBe("upload");
  });

  it("addDatasetToCollection in upload mode uses uploadedDatasetId", async () => {
    mockCreateDatasetView.mockResolvedValue({ id: "view1" });

    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.option = {
      type: "upload",
      editVariables: false,
      configuring: false,
      configurationLogs: "",
      uploadedDatasetId: "ds-upload",
    };

    await vm.addDatasetToCollection();

    expect(mockCreateDatasetView).toHaveBeenCalledTimes(1);
    expect(mockCreateDatasetView).toHaveBeenCalledWith({
      datasetId: "ds-upload",
      configurationId: "c1",
    });
    expect(wrapper.emitted("addedDatasets")).toBeTruthy();
    expect(wrapper.emitted("addedDatasets")![0][0]).toEqual(["ds-upload"]);
    // Option should reset to upload defaults after adding
    expect(vm.option.type).toBe("upload");
    expect(vm.option.uploadedDatasetId).toBeNull();
  });

  it("selectAddDatasetFolder returns early when option type is not add", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    // Default is upload
    expect(vm.option.type).toBe("upload");

    await vm.selectAddDatasetFolder([{ _id: "ds1", _modelType: "folder" }]);

    expect(mockIsDatasetFolder).not.toHaveBeenCalled();
  });

  it("addDatasetConfigurationDone returns early when type is not upload", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.addDatasetOptionType = "add";

    await vm.addDatasetConfigurationDone("json1");

    expect(mockSetSelectedDataset).not.toHaveBeenCalled();
  });

  it("addDatasetConfigurationDone emits error when no configCompat", async () => {
    const wrapper = mountComponent({
      collection: {
        ...sampleCollection,
        compatibility: null,
      },
    });
    const vm = wrapper.vm as any;
    vm.option = {
      type: "upload",
      editVariables: false,
      configuring: true,
      configurationLogs: "",
      uploadedDatasetId: "ds1",
    };

    await vm.addDatasetConfigurationDone("json1");

    expect(wrapper.emitted("error")).toBeTruthy();
    expect(wrapper.emitted("error")![0][0]).toContain(
      "DatasetConfiguration missing",
    );
    expect(wrapper.emitted("done")).toBeTruthy();
  });

  it("addDatasetConfigurationDone emits error when dataset not found", async () => {
    mockGetDataset.mockResolvedValue(null);

    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.option = {
      type: "upload",
      editVariables: false,
      configuring: true,
      configurationLogs: "",
      uploadedDatasetId: "ds1",
    };

    await vm.addDatasetConfigurationDone("json1");

    expect(wrapper.emitted("error")).toBeTruthy();
    expect(wrapper.emitted("error")![0][0]).toContain("Dataset missing");
    expect(wrapper.emitted("done")).toBeTruthy();
  });

  it("addDatasetConfigurationDone emits warning when dataset incompatible", async () => {
    mockGetDataset.mockResolvedValue({ id: "ds1", name: "Dataset 1" });
    mockAreCompatibles.mockReturnValue(false);

    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.option = {
      type: "upload",
      editVariables: false,
      configuring: true,
      configurationLogs: "",
      uploadedDatasetId: "ds1",
    };

    await vm.addDatasetConfigurationDone("json1");

    expect(wrapper.emitted("warning")).toBeTruthy();
    expect(wrapper.emitted("warning")![0][0]).toBe(
      "Incompatible dataset uploaded",
    );
    expect(wrapper.emitted("done")).toBeTruthy();
  });

  it("addDatasetConfigurationFailed reveals the configuration and keeps it mounted", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.option = {
      type: "upload",
      editVariables: false,
      configuring: true,
      configurationLogs: "",
      uploadedDatasetId: "ds1",
    };

    vm.addDatasetConfigurationFailed();

    expect(vm.option.editVariables).toBe(true);
    expect(vm.option.configuring).toBe(true);
  });

  it("keeps the configuration and its error on screen after a generation failure", async () => {
    const wrapper = mountComponent({}, withConfiguration);
    const vm = wrapper.vm as any;
    vm.option = {
      type: "upload",
      editVariables: false,
      configuring: true,
      configurationLogs: "",
      uploadedDatasetId: "ds1",
    };
    await nextTick();
    expect(wrapper.text()).toContain("Configuring the dataset");

    const configuration = wrapper.findComponent({
      name: "MultiSourceConfiguration",
    });
    // The configuration shows its own error, then reports it.
    (configuration.vm as any).generationErrorMessage = "Transcode failed";
    configuration.vm.$emit("generationError", "Transcode failed");
    await nextTick();

    expect(vm.option.editVariables).toBe(true);
    expect(
      wrapper.findComponent({ name: "MultiSourceConfiguration" }).exists(),
    ).toBe(true);
    expect(wrapper.text()).not.toContain("Configuring the dataset");
    expect(mockSetSelectedDataset).not.toHaveBeenCalled();
  });

  it("reveals the configuration when reading the uploaded files fails", async () => {
    mockConfigInitialize.mockRejectedValue(new Error("Access denied"));
    const wrapper = mountComponent({}, withConfiguration);
    const vm = wrapper.vm as any;

    await vm.addDatasetToCollectionUploaded("ds1");

    expect(mockConfigInitialize).toHaveBeenCalled();
    expect(mockConfigSubmit).not.toHaveBeenCalled();
    expect(vm.option.editVariables).toBe(true);
  });

  it("hides the configuring progress while the configuration shows a load error", async () => {
    mockConfigInitialize.mockRejectedValue(new Error("Access denied"));
    const wrapper = mountComponent({}, withConfiguration);
    const vm = wrapper.vm as any;
    const pending = vm.addDatasetToCollectionUploaded("ds1");
    await nextTick();
    // The configuration records its load error as it fails.
    (
      wrapper.findComponent({ name: "MultiSourceConfiguration" }).vm as any
    ).initError = { name: "a.tif", message: "Access denied" };
    await pending;
    await nextTick();

    expect(
      wrapper.findComponent({ name: "MultiSourceConfiguration" }).exists(),
    ).toBe(true);
    expect(wrapper.text()).not.toContain("Configuring the dataset");
  });

  it("addDatasetToCollectionUploaded returns early when type is not upload", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.addDatasetOptionType = "add";

    await vm.addDatasetToCollectionUploaded("ds1");

    // Should not modify the option since it's in "add" mode
    expect(vm.option.type).toBe("add");
  });
});

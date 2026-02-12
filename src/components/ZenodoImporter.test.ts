import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockSetFolderLocation,
  mockStoreAnnotationFile,
  mockStoreCollectionFile,
  mockFilterImageFiles,
  mockDownloadFile,
} = vi.hoisted(() => {
  const mockSetFolderLocation = vi.fn();
  const mockStoreAnnotationFile = vi.fn();
  const mockStoreCollectionFile = vi.fn();
  const mockFilterImageFiles = vi.fn((files: any[]) =>
    files.filter((f: any) => {
      const key = f.key.toLowerCase();
      return (
        key.endsWith(".tif") ||
        key.endsWith(".tiff") ||
        key.endsWith(".png") ||
        key.endsWith(".jpg")
      );
    }),
  );
  const mockDownloadFile = vi.fn().mockResolvedValue(new Blob(["test"]));
  return {
    mockSetFolderLocation,
    mockStoreAnnotationFile,
    mockStoreCollectionFile,
    mockFilterImageFiles,
    mockDownloadFile,
  };
});

vi.mock("@/store", () => ({
  default: {
    girderRestProxy: {},
    folderLocation: { _id: "folder1", _modelType: "folder" },
    setFolderLocation: mockSetFolderLocation,
  },
}));
vi.mock("@/store/annotation", () => ({ default: {} }));
vi.mock("@/store/properties", () => ({ default: {} }));
vi.mock("@/store/girderResources", () => ({ default: {} }));

vi.mock("@/store/datasetMetadataImport", () => ({
  default: {
    storeAnnotationFile: mockStoreAnnotationFile,
    storeCollectionFile: mockStoreCollectionFile,
  },
}));

vi.mock("@/store/ZenodoAPI", () => ({
  default: vi.fn().mockImplementation(() => ({
    filterImageFiles: mockFilterImageFiles,
    downloadFile: mockDownloadFile,
  })),
  IZenodoRecord: {},
  IZenodoFile: {},
}));

vi.mock("@/components/GirderLocationChooser.vue", () => ({
  default: {
    name: "GirderLocationChooser",
    template: "<div />",
    props: ["value", "breadcrumb", "title", "disabled"],
  },
}));

vi.mock("@/utils/strings", () => ({
  stripHtml: vi.fn((s: string) => s),
  getTourStepId: vi.fn().mockReturnValue("test-tourstep"),
  getTourTriggerId: vi.fn().mockReturnValue("test-tourtrigger"),
}));

vi.mock("@/utils/log", () => ({
  logError: vi.fn(),
}));

import { shallowMount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";
import ZenodoImporter from "./ZenodoImporter.vue";

Vue.use(Vuetify);
Vue.directive("tour-trigger", {});

const sampleFiles = [
  {
    id: "f1",
    key: "image1.tiff",
    size: 1048576,
    checksum: "abc",
    links: { self: "https://zenodo.org/files/image1.tiff", download: "" },
  },
  {
    id: "f2",
    key: "image2.png",
    size: 2048,
    checksum: "def",
    links: { self: "https://zenodo.org/files/image2.png", download: "" },
  },
  {
    id: "f3",
    key: "annotations.json",
    size: 512,
    checksum: "ghi",
    links: {
      self: "https://zenodo.org/files/annotations.json",
      download: "",
    },
  },
];

const sampleDataset = {
  id: "rec-123",
  conceptdoi: "10.5281/zenodo.123",
  doi: "10.5281/zenodo.124",
  title: "Test Dataset",
  description: "A test dataset",
  created: "2024-01-01",
  updated: "2024-06-01",
  files: sampleFiles,
  metadata: {
    title: "Test Dataset",
    description: "<p>Test description</p>",
    creators: [{ name: "Test Author" }],
    publication_date: "2024-01-01",
  },
  links: {
    self: "",
    html: "",
    latest: "",
    latest_html: "https://zenodo.org/records/123",
    files: "",
  },
};

function mountComponent(props = {}) {
  const mockRouter = { push: vi.fn() };
  return shallowMount(ZenodoImporter, {
    vuetify: new Vuetify(),
    propsData: {
      ...props,
    },
    mocks: {
      $router: mockRouter,
    },
  });
}

describe("ZenodoImporter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore the default implementation after clearAllMocks
    mockFilterImageFiles.mockImplementation((files: any[]) =>
      files.filter((f: any) => {
        const key = f.key.toLowerCase();
        return (
          key.endsWith(".tif") ||
          key.endsWith(".tiff") ||
          key.endsWith(".png") ||
          key.endsWith(".jpg")
        );
      }),
    );
    mockDownloadFile.mockResolvedValue(new Blob(["test"]));
  });

  it("filteredFiles returns only image files", async () => {
    const wrapper = mountComponent({ dataset: sampleDataset });
    await Vue.nextTick();
    const vm = wrapper.vm as any;
    expect(vm.filteredFiles).toHaveLength(2);
    expect(vm.filteredFiles[0].key).toBe("image1.tiff");
    expect(vm.filteredFiles[1].key).toBe("image2.png");
  });

  it("filteredFiles returns empty array when no dataset selected", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.filteredFiles).toEqual([]);
  });

  it("canImport is true when dataset, files, and path are present", async () => {
    const wrapper = mountComponent({ dataset: sampleDataset });
    await Vue.nextTick();
    const vm = wrapper.vm as any;
    // Path is initialized from store.folderLocation in onMounted
    expect(vm.canImport).toBe(true);
  });

  it("canImport is false when no dataset is selected", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.canImport).toBe(false);
  });

  it("canImport is false when importing", async () => {
    const wrapper = mountComponent({ dataset: sampleDataset });
    await Vue.nextTick();
    const vm = wrapper.vm as any;
    vm.importing = true;
    await Vue.nextTick();
    expect(vm.canImport).toBe(false);
  });

  it("formatSize formats bytes correctly", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.formatSize(500)).toBe("500 B");
    expect(vm.formatSize(1024)).toBe("1.00 KB");
    expect(vm.formatSize(1048576)).toBe("1.00 MB");
    expect(vm.formatSize(1073741824)).toBe("1.00 GB");
    expect(vm.formatSize(0)).toBe("0 B");
  });

  it("initializes path from store on mount", async () => {
    const wrapper = mountComponent();
    await Vue.nextTick();
    const vm = wrapper.vm as any;
    expect(vm.path).toEqual({ _id: "folder1", _modelType: "folder" });
  });

  it("sets selectedDataset from prop on mount", async () => {
    const wrapper = mountComponent({ dataset: sampleDataset });
    await Vue.nextTick();
    const vm = wrapper.vm as any;
    expect(vm.selectedDataset).toEqual(sampleDataset);
  });

  it("updates selectedDataset when dataset prop changes", async () => {
    const wrapper = mountComponent();
    await Vue.nextTick();
    const vm = wrapper.vm as any;
    expect(vm.selectedDataset).toBeNull();

    await wrapper.setProps({ dataset: sampleDataset });
    await Vue.nextTick();
    expect(vm.selectedDataset).toEqual(sampleDataset);
  });

  it("clears error when dataset prop changes", async () => {
    const wrapper = mountComponent();
    await Vue.nextTick();
    const vm = wrapper.vm as any;
    vm.error = "Some error";

    await wrapper.setProps({ dataset: sampleDataset });
    await Vue.nextTick();
    expect(vm.error).toBe("");
  });

  it("setting path calls store.setFolderLocation", async () => {
    const wrapper = mountComponent();
    await Vue.nextTick();
    const vm = wrapper.vm as any;

    const newPath = { _id: "folder2", _modelType: "folder" };
    vm.path = newPath;
    expect(mockSetFolderLocation).toHaveBeenCalledWith(newPath);
  });

  it("setting path to null does not call store.setFolderLocation", async () => {
    const wrapper = mountComponent();
    await Vue.nextTick();
    mockSetFolderLocation.mockClear();

    const vm = wrapper.vm as any;
    vm.path = null;
    expect(mockSetFolderLocation).not.toHaveBeenCalled();
  });

  it("emits close event", async () => {
    const wrapper = mountComponent();
    await Vue.nextTick();
    // The close button has @click="$emit('close')" in the template.
    // With shallowMount, we verify the emit works via the vm.
    wrapper.vm.$emit("close");
    expect(wrapper.emitted("close")).toBeTruthy();
  });

  it("importSelectedDataset returns early when canImport is false", async () => {
    const wrapper = mountComponent();
    await Vue.nextTick();
    const vm = wrapper.vm as any;
    await vm.importSelectedDataset();
    expect(mockDownloadFile).not.toHaveBeenCalled();
  });

  it("importSelectedDataset downloads files and navigates", async () => {
    const mockRouter = { push: vi.fn() };
    const wrapper = shallowMount(ZenodoImporter, {
      vuetify: new Vuetify(),
      propsData: { dataset: sampleDataset },
      mocks: { $router: mockRouter },
    });
    await Vue.nextTick();
    const vm = wrapper.vm as any;

    await vm.importSelectedDataset();

    // Should have downloaded image files (2) and non-image files (1)
    expect(mockDownloadFile).toHaveBeenCalledTimes(3);
    expect(mockStoreAnnotationFile).toHaveBeenCalledTimes(1);
    expect(mockRouter.push).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "newdataset",
      }),
    );
  });

  it("importSelectedDataset sets error on failure", async () => {
    mockDownloadFile.mockRejectedValueOnce(new Error("Network error"));
    const wrapper = mountComponent({ dataset: sampleDataset });
    await Vue.nextTick();
    const vm = wrapper.vm as any;

    await vm.importSelectedDataset();

    expect(vm.error).toBe(
      "Failed to download files from Zenodo. Please try again.",
    );
    expect(vm.importing).toBe(false);
  });
});

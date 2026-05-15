import { describe, it, expect, vi, beforeEach } from "vitest";
import { shallowMount, flushPromises } from "@vue/test-utils";

const mockGetFolders = vi.fn();
const mockGetAllConfigurations = vi.fn();
const mockFindDatasetViews = vi.fn();
const mockGetUserPrivateFolder = vi.fn();

let mockDataset: any = {
  id: "dataset-1",
  name: "Dataset 1",
  channels: [{ channel: 0, frameIndex: 0 }],
};

vi.mock("@/store", () => ({
  default: {
    get dataset() {
      return mockDataset;
    },
    girderUser: {
      _id: "user-1",
      _modelType: "user",
      login: "user",
      name: "user",
    },
    api: {
      getFolders: (...args: any[]) => mockGetFolders(...args),
      getAllConfigurations: (...args: any[]) =>
        mockGetAllConfigurations(...args),
      findDatasetViews: (...args: any[]) => mockFindDatasetViews(...args),
      getUserPrivateFolder: (...args: any[]) =>
        mockGetUserPrivateFolder(...args),
    },
  },
}));

vi.mock("@/store/model", () => ({
  areCompatibles: vi.fn(
    (configurationCompatibility: any, datasetCompatibility: any) =>
      configurationCompatibility?.channels === datasetCompatibility?.channels,
  ),
}));

vi.mock("@/store/GirderAPI", () => ({
  getDatasetCompatibility: vi.fn((dataset: any) => ({
    channels: dataset.channels?.length ?? 0,
  })),
}));

vi.mock("@/utils/log", () => ({
  logError: vi.fn(),
}));

import CollectionNavigator from "./CollectionNavigator.vue";

const rootFolder = {
  _id: "folder-1",
  _modelType: "folder" as const,
  name: "Folder 1",
  description: "",
  creatorId: "user-1",
  meta: {},
};

function mountComponent(props = {}) {
  return shallowMount(CollectionNavigator, {
    props: {
      location: rootFolder,
      useDefaultLocation: false,
      ...props,
    },
    global: {
      stubs: {
        GirderBreadcrumb: true,
      },
    },
  });
}

describe("CollectionNavigator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDataset = {
      id: "dataset-1",
      name: "Dataset 1",
      channels: [{ channel: 0, frameIndex: 0 }],
    };
    mockGetFolders.mockResolvedValue([
      {
        _id: "folder-b",
        _modelType: "folder",
        name: "Bravo",
        description: "",
        meta: {},
      },
      {
        _id: "dataset-folder",
        _modelType: "folder",
        name: "Dataset Folder",
        description: "",
        meta: { subtype: "contrastDataset" },
      },
      {
        _id: "folder-a",
        _modelType: "folder",
        name: "Alpha",
        description: "",
        meta: {},
      },
    ]);
    mockGetAllConfigurations.mockResolvedValue([
      {
        id: "linked",
        name: "Already Linked",
        description: "",
        compatibility: { channels: 1 },
      },
      {
        id: "compatible",
        name: "Compatible",
        description: "",
        compatibility: { channels: 1 },
      },
      {
        id: "incompatible",
        name: "Incompatible",
        description: "",
        compatibility: { channels: 2 },
      },
    ]);
    mockFindDatasetViews.mockResolvedValue([{ configurationId: "linked" }]);
    mockGetUserPrivateFolder.mockResolvedValue(rootFolder);
  });

  it("shows normal folders, compatible collections, and incompatible collections", async () => {
    const wrapper = mountComponent();
    await flushPromises();

    const vm = wrapper.vm as any;

    expect(mockGetFolders).toHaveBeenCalledWith("folder-1", "folder");
    expect(mockGetAllConfigurations).toHaveBeenCalledWith("folder-1");
    expect(mockFindDatasetViews).toHaveBeenCalledWith({
      datasetId: "dataset-1",
    });
    expect(vm.folders.map((folder: any) => folder._id)).toEqual([
      "folder-a",
      "folder-b",
    ]);
    expect(
      vm.configurations.map((configuration: any) => configuration.id),
    ).toEqual(["compatible"]);
    expect(
      vm.incompatibleConfigurations.map(
        (configuration: any) => configuration.id,
      ),
    ).toEqual(["incompatible"]);
  });

  it("filters incompatible collections separately from selectable collections", async () => {
    const wrapper = mountComponent();
    await flushPromises();

    const vm = wrapper.vm as any;
    vm.search = "incompatible";

    expect(vm.filteredConfigurations).toEqual([]);
    expect(
      vm.filteredIncompatibleConfigurations.map(
        (configuration: any) => configuration.id,
      ),
    ).toEqual(["incompatible"]);
  });

  it("navigates by emitting the selected folder location", async () => {
    const wrapper = mountComponent();
    await flushPromises();

    const folder = (wrapper.vm as any).folders[0];
    (wrapper.vm as any).navigateToLocation(folder);

    expect(wrapper.emitted("update:location")?.[0]).toEqual([folder]);
  });

  it("emits selected collections on submit", async () => {
    const wrapper = mountComponent();
    await flushPromises();

    const vm = wrapper.vm as any;
    vm.toggleSelection(vm.configurations[0]);
    vm.submit();

    expect(vm.selectedConfigurations).toHaveLength(1);
    expect(wrapper.emitted("submit")?.[0][0]).toEqual([
      expect.objectContaining({ id: "compatible" }),
    ]);
  });

  it("fetches folders but not collections at a user location", async () => {
    const userLocation = {
      _id: "user-1",
      _modelType: "user" as const,
      login: "user",
      email: "user@example.com",
      firstName: "First",
      lastName: "Last",
      name: "user",
    };

    const wrapper = mountComponent({ location: userLocation });
    await flushPromises();

    expect(mockGetFolders).toHaveBeenCalledWith("user-1", "user");
    expect(mockGetAllConfigurations).not.toHaveBeenCalled();
    expect((wrapper.vm as any).configurations).toEqual([]);
    expect((wrapper.vm as any).incompatibleConfigurations).toEqual([]);
  });
});

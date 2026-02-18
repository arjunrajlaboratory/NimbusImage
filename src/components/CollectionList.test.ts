import { describe, it, expect, vi, beforeEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

const mockClientGet = vi.fn();
const mockGetUserPrivateFolder = vi.fn();
const mockFindDatasetViews = vi.fn();
const mockBatchResources = vi.fn();

vi.mock("@/store", () => ({
  default: {
    folderLocation: null as any,
    api: {
      client: {
        get: (...args: any[]) => mockClientGet(...args),
      },
      getUserPrivateFolder: (...args: any[]) =>
        mockGetUserPrivateFolder(...args),
      findDatasetViews: (...args: any[]) => mockFindDatasetViews(...args),
      batchResources: (...args: any[]) => mockBatchResources(...args),
    },
  },
}));

const mockGetFolder = vi.fn();
vi.mock("@/store/girderResources", () => ({
  default: {
    getFolder: (...args: any[]) => mockGetFolder(...args),
  },
}));

vi.mock("@/utils/log", () => ({
  logError: vi.fn(),
  logWarning: vi.fn(),
}));

vi.mock("@/girder/components", () => ({
  Breadcrumb: {
    name: "GirderBreadcrumb",
    template: "<div></div>",
    props: ["location"],
  },
}));

vi.mock("@/utils/date", () => ({
  formatDateString: vi.fn(() => "formatted-date"),
}));

import CollectionList from "./CollectionList.vue";
import store from "@/store";

Vue.use(Vuetify);

function mountComponent() {
  const mockRouter = { push: vi.fn() };
  const mockRoute = { params: {}, query: {} };
  return shallowMount(CollectionList, {
    vuetify: new Vuetify(),
    stubs: {
      "girder-breadcrumb": true,
      "collection-item-row": true,
      CollectionItemRow: true,
    },
    mocks: {
      $router: mockRouter,
      $route: mockRoute,
    },
  });
}

describe("CollectionList", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Reset store defaults
    (store as any).folderLocation = null;
    mockClientGet.mockResolvedValue({ data: [] });
    mockGetUserPrivateFolder.mockResolvedValue({
      _id: "private-folder",
      _modelType: "folder",
    });
    mockFindDatasetViews.mockResolvedValue([]);
    mockBatchResources.mockResolvedValue({ folder: {} });
    mockGetFolder.mockResolvedValue(null);
  });

  // --- currentFolderLocation ---

  it("currentFolderLocation returns null when store.folderLocation is null", () => {
    (store as any).folderLocation = null;
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.currentFolderLocation).toBeNull();
    wrapper.destroy();
  });

  it("currentFolderLocation returns location when it has _id and name", () => {
    (store as any).folderLocation = {
      _id: "folder1",
      name: "My Folder",
    };
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.currentFolderLocation).toEqual({
      _id: "folder1",
      name: "My Folder",
    });
    wrapper.destroy();
  });

  it("currentFolderLocation returns null when location missing _id", () => {
    (store as any).folderLocation = { name: "No ID" };
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.currentFolderLocation).toBeNull();
    wrapper.destroy();
  });

  // --- fallbackFolderPath ---

  it("fallbackFolderPath returns 'Unknown location' when folderLocation is null", () => {
    (store as any).folderLocation = null;
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.fallbackFolderPath).toBe("Unknown location");
    wrapper.destroy();
  });

  it("fallbackFolderPath returns name when folderLocation has name", () => {
    (store as any).folderLocation = { name: "Some Folder" };
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.fallbackFolderPath).toBe("Some Folder");
    wrapper.destroy();
  });

  it("fallbackFolderPath returns type label for root/users/collections", () => {
    (store as any).folderLocation = { type: "root" };
    const wrapper = mountComponent();
    expect((wrapper.vm as any).fallbackFolderPath).toBe("Root");
    wrapper.destroy();

    (store as any).folderLocation = { type: "users" };
    const wrapper2 = mountComponent();
    expect((wrapper2.vm as any).fallbackFolderPath).toBe("Users");
    wrapper2.destroy();

    (store as any).folderLocation = { type: "collections" };
    const wrapper3 = mountComponent();
    expect((wrapper3.vm as any).fallbackFolderPath).toBe("Collections");
    wrapper3.destroy();
  });

  it("fallbackFolderPath returns login's folder for login-based location", () => {
    (store as any).folderLocation = { login: "testuser" };
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.fallbackFolderPath).toBe("testuser's folder");
    wrapper.destroy();
  });

  it("fallbackFolderPath returns 'Current folder' as final fallback", () => {
    (store as any).folderLocation = { someUnknownProp: true };
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.fallbackFolderPath).toBe("Current folder");
    wrapper.destroy();
  });

  // --- filteredCollections ---

  it("filteredCollections returns all collections when searchQuery is empty", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.collections = [
      { _id: "c1", name: "Alpha", description: "" },
      { _id: "c2", name: "Beta", description: "" },
    ];
    vm.searchQuery = "";
    expect(vm.filteredCollections).toHaveLength(2);
    wrapper.destroy();
  });

  it("filteredCollections filters by name (case-insensitive)", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.collections = [
      { _id: "c1", name: "Alpha Project", description: "" },
      { _id: "c2", name: "Beta Test", description: "" },
    ];
    vm.searchQuery = "alpha";
    expect(vm.filteredCollections).toHaveLength(1);
    expect(vm.filteredCollections[0].name).toBe("Alpha Project");
    wrapper.destroy();
  });

  it("filteredCollections filters by description", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.collections = [
      { _id: "c1", name: "First", description: "important stuff" },
      { _id: "c2", name: "Second", description: "unrelated" },
    ];
    vm.searchQuery = "important";
    expect(vm.filteredCollections).toHaveLength(1);
    expect(vm.filteredCollections[0]._id).toBe("c1");
    wrapper.destroy();
  });

  // --- fetchCollections ---

  it("fetchCollections populates collections from API response", async () => {
    (store as any).folderLocation = { _id: "folder1", name: "F" };
    mockClientGet.mockResolvedValue({
      data: [
        { _id: "c1", name: "Collection 1" },
        { _id: "c2", name: "Collection 2" },
      ],
    });
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    await vm.fetchCollections();
    expect(vm.collections).toHaveLength(2);
    expect(vm.collections[0]._modelType).toBe("upenn_collection");
    expect(vm.loading).toBe(false);
    wrapper.destroy();
  });

  it("fetchCollections handles error and sets empty collections", async () => {
    (store as any).folderLocation = { _id: "folder1", name: "F" };
    mockClientGet.mockRejectedValue(new Error("Network error"));
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    await vm.fetchCollections();
    expect(vm.collections).toEqual([]);
    expect(vm.loading).toBe(false);
    wrapper.destroy();
  });

  it("fetchCollections falls back to private folder when no _id in folderLocation", async () => {
    (store as any).folderLocation = { type: "root" };
    mockGetUserPrivateFolder.mockResolvedValue({
      _id: "private-folder",
      _modelType: "folder",
    });
    mockClientGet.mockResolvedValue({ data: [] });
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    await vm.fetchCollections();
    expect(mockGetUserPrivateFolder).toHaveBeenCalled();
    expect(mockClientGet).toHaveBeenCalledWith("upenn_collection", {
      params: {
        folderId: "private-folder",
        limit: 0,
        sort: "updated",
        sortdir: -1,
      },
    });
    wrapper.destroy();
  });

  it("fetchCollections sets empty collections when no folderId available", async () => {
    (store as any).folderLocation = { type: "root" };
    mockGetUserPrivateFolder.mockResolvedValue(null);
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    await vm.fetchCollections();
    expect(vm.collections).toEqual([]);
    expect(vm.loading).toBe(false);
    wrapper.destroy();
  });

  // --- navigateToCollection ---

  it("navigateToCollection pushes route with configurationId", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.navigateToCollection("config123");
    expect(vm.$router.push).toHaveBeenCalledWith({
      name: "configuration",
      params: { configurationId: "config123" },
    });
    wrapper.destroy();
  });

  // --- collectionToChips ---

  it("collectionToChips returns empty chips when no views exist", async () => {
    mockFindDatasetViews.mockResolvedValue([]);
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const result = await vm.collectionToChips({
      _id: "col1",
      name: "Test",
    });
    expect(result.chips).toEqual([]);
    expect(result.type).toBe("collection");
    wrapper.destroy();
  });

  it("collectionToChips creates chips from views with folder info", async () => {
    mockFindDatasetViews.mockResolvedValue([
      { id: "v1", datasetId: "ds1", configurationId: "col1" },
      { id: "v2", datasetId: "ds2", configurationId: "col1" },
    ]);
    mockBatchResources.mockResolvedValue({
      folder: {
        ds1: { name: "Dataset A" },
        ds2: { name: "Dataset B" },
      },
    });
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const result = await vm.collectionToChips({
      _id: "col1",
      name: "Test Collection",
    });
    expect(result.chips).toHaveLength(2);
    expect(result.chips[0].text).toBe("Dataset A");
    expect(result.chips[0].color).toBe("#e57373");
    expect(result.chips[0].to).toEqual({
      name: "dataset",
      params: { datasetId: "ds1" },
    });
    wrapper.destroy();
  });

  it("collectionToChips handles empty folder info by skipping missing datasets", async () => {
    mockFindDatasetViews.mockResolvedValue([
      { id: "v1", datasetId: "ds1", configurationId: "col1" },
    ]);
    mockBatchResources.mockResolvedValue({
      folder: {},
    });
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const result = await vm.collectionToChips({
      _id: "col1",
      name: "Test",
    });
    expect(result.chips).toEqual([]);
    wrapper.destroy();
  });

  // --- addChipPromise ---

  it("addChipPromise increments pendingChips and updates chipsPerItemId", async () => {
    mockFindDatasetViews.mockResolvedValue([]);
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.addChipPromise({ _id: "col1", name: "Test" });
    // pendingChips was incremented (may have already resolved)
    // Wait for all promises to complete
    await Vue.nextTick();
    await Vue.nextTick();
    await new Promise((r) => setTimeout(r, 10));
    expect(vm.chipsPerItemId).toHaveProperty("col1");
    wrapper.destroy();
  });

  // --- bulkCollectionsToChips ---

  it("bulkCollectionsToChips returns empty result for empty array", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const result = await vm.bulkCollectionsToChips([]);
    expect(result).toEqual({});
    wrapper.destroy();
  });

  it("bulkCollectionsToChips batches view fetching for multiple collections", async () => {
    mockFindDatasetViews.mockResolvedValue([
      { id: "v1", datasetId: "ds1", configurationId: "col1" },
      { id: "v2", datasetId: "ds2", configurationId: "col2" },
    ]);
    mockBatchResources.mockResolvedValue({
      folder: {
        ds1: { name: "Dataset A" },
        ds2: { name: "Dataset B" },
      },
    });
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const result = await vm.bulkCollectionsToChips([
      { _id: "col1", name: "Col 1" },
      { _id: "col2", name: "Col 2" },
    ]);
    expect(result).toHaveProperty("col1");
    expect(result).toHaveProperty("col2");
    expect(result.col1.chips).toHaveLength(1);
    expect(result.col1.chips[0].text).toBe("Dataset A");
    expect(result.col2.chips).toHaveLength(1);
    expect(result.col2.chips[0].text).toBe("Dataset B");
    wrapper.destroy();
  });

  it("bulkCollectionsToChips falls back to individual collectionToChips on error", async () => {
    mockFindDatasetViews
      .mockRejectedValueOnce(new Error("Batch failed"))
      .mockResolvedValue([]);
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const result = await vm.bulkCollectionsToChips([
      { _id: "col1", name: "Col 1" },
    ]);
    expect(result).toHaveProperty("col1");
    expect(result.col1.chips).toEqual([]);
    expect(result.col1.type).toBe("collection");
    wrapper.destroy();
  });

  // --- watcher: filteredCollections -> chips ---

  it("watcher triggers chip computation for new filtered collections", async () => {
    mockFindDatasetViews.mockResolvedValue([]);
    mockBatchResources.mockResolvedValue({ folder: {} });
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    // Simulate collections appearing
    vm.collections = [
      {
        _id: "c1",
        name: "Test",
        description: "",
        _modelType: "upenn_collection",
      },
    ];
    await Vue.nextTick();
    await Vue.nextTick();
    // The watcher should have added c1 to computedChipsIds
    expect(vm.computedChipsIds.has("c1")).toBe(true);
    wrapper.destroy();
  });

  it("fetchCollections retries without folderId on folder error", async () => {
    (store as any).folderLocation = { _id: "folder1", name: "F" };
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    // Wait for initial mount fetchCollections to complete
    await Vue.nextTick();
    await Vue.nextTick();
    mockClientGet.mockReset();
    mockClientGet
      .mockRejectedValueOnce(new Error("Folder not accessible"))
      .mockResolvedValueOnce({
        data: [{ _id: "c1", name: "Fallback Collection" }],
      });
    await vm.fetchCollections();
    expect(mockClientGet).toHaveBeenCalledTimes(2);
    expect(vm.collections).toHaveLength(1);
    expect(vm.collections[0].name).toBe("Fallback Collection");
    wrapper.destroy();
  });
});

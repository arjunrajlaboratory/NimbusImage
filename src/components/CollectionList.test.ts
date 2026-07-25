import { describe, it, expect, vi, beforeEach } from "vitest";
import { shallowMount } from "@vue/test-utils";

const mockListCollections = vi.fn();
const mockGetUserPrivateFolder = vi.fn();
const mockBatchResources = vi.fn();

vi.mock("@/store", () => ({
  default: {
    folderLocation: null as any,
    api: {
      listCollections: (...args: any[]) => mockListCollections(...args),
      getUserPrivateFolder: (...args: any[]) =>
        mockGetUserPrivateFolder(...args),
      batchResources: (...args: any[]) => mockBatchResources(...args),
    },
  },
}));

const mockCollectionsToDatasetChips = vi.fn();
vi.mock("@/utils/collectionChips", () => ({
  collectionsToDatasetChips: (...args: any[]) =>
    mockCollectionsToDatasetChips(...args),
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

import { routeProvider, routerProvider } from "@/test/helpers";
import CollectionList from "./CollectionList.vue";
import store from "@/store";
import Persister from "@/store/Persister";

const mockRouter = { push: vi.fn() };

function mountComponent() {
  return shallowMount(CollectionList, {
    global: {
      stubs: {
        "girder-breadcrumb": true,
        "collection-dataset-chips": true,
        CollectionDatasetChips: true,
      },
      provide: {
        ...routeProvider({ params: {}, query: {} }),
        ...routerProvider(mockRouter),
      },
    },
  });
}

function collection(id: string, overrides: Record<string, any> = {}) {
  return {
    _id: id,
    _modelType: "upenn_collection" as const,
    name: `Collection ${id}`,
    description: "",
    folderId: "folder1",
    creatorId: "u1",
    created: "2024-01-01T00:00:00Z",
    updated: "2024-06-15T12:00:00Z",
    ...overrides,
  };
}

describe("CollectionList", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Persister.delete("collectionBrowseScope");
    (store as any).folderLocation = null;
    mockListCollections.mockResolvedValue({ collections: [], hasMore: false });
    mockGetUserPrivateFolder.mockResolvedValue({
      _id: "private-folder",
      _modelType: "folder",
    });
    mockBatchResources.mockResolvedValue({ folder: {} });
    mockCollectionsToDatasetChips.mockResolvedValue({});
  });

  // --- currentFolderLocation ---

  it("currentFolderLocation returns null when store.folderLocation is null", () => {
    (store as any).folderLocation = null;
    const vm = mountComponent().vm as any;
    expect(vm.currentFolderLocation).toBeNull();
  });

  it("currentFolderLocation returns location when it has _id and name", () => {
    (store as any).folderLocation = { _id: "folder1", name: "My Folder" };
    const vm = mountComponent().vm as any;
    expect(vm.currentFolderLocation).toEqual({
      _id: "folder1",
      name: "My Folder",
    });
  });

  it("currentFolderLocation returns null when location missing _id", () => {
    (store as any).folderLocation = { name: "No ID" };
    const vm = mountComponent().vm as any;
    expect(vm.currentFolderLocation).toBeNull();
  });

  // --- fallbackFolderPath ---

  it("fallbackFolderPath returns 'Unknown location' when folderLocation is null", () => {
    (store as any).folderLocation = null;
    expect((mountComponent().vm as any).fallbackFolderPath).toBe(
      "Unknown location",
    );
  });

  it("fallbackFolderPath returns name when folderLocation has name", () => {
    (store as any).folderLocation = { name: "Some Folder" };
    expect((mountComponent().vm as any).fallbackFolderPath).toBe("Some Folder");
  });

  it("fallbackFolderPath returns type label for root/users/collections", () => {
    (store as any).folderLocation = { type: "root" };
    expect((mountComponent().vm as any).fallbackFolderPath).toBe("Root");

    (store as any).folderLocation = { type: "users" };
    expect((mountComponent().vm as any).fallbackFolderPath).toBe("Users");

    (store as any).folderLocation = { type: "collections" };
    expect((mountComponent().vm as any).fallbackFolderPath).toBe("Collections");
  });

  it("fallbackFolderPath returns login's folder for login-based location", () => {
    (store as any).folderLocation = { login: "testuser" };
    expect((mountComponent().vm as any).fallbackFolderPath).toBe(
      "testuser's folder",
    );
  });

  it("fallbackFolderPath returns 'Current folder' as final fallback", () => {
    (store as any).folderLocation = { someUnknownProp: true };
    expect((mountComponent().vm as any).fallbackFolderPath).toBe(
      "Current folder",
    );
  });

  // --- filteredCollections ---

  it("filteredCollections returns all collections when searchQuery is empty", () => {
    const vm = mountComponent().vm as any;
    vm.collections = [collection("c1"), collection("c2")];
    vm.searchQuery = "";
    expect(vm.filteredCollections).toHaveLength(2);
  });

  it("filteredCollections filters by name (case-insensitive)", () => {
    const vm = mountComponent().vm as any;
    vm.collections = [
      collection("c1", { name: "Alpha Project" }),
      collection("c2", { name: "Beta Test" }),
    ];
    vm.searchQuery = "alpha";
    expect(vm.filteredCollections).toHaveLength(1);
    expect(vm.filteredCollections[0].name).toBe("Alpha Project");
  });

  it("filteredCollections filters by description", () => {
    const vm = mountComponent().vm as any;
    vm.collections = [
      collection("c1", { description: "important stuff" }),
      collection("c2", { description: "unrelated" }),
    ];
    vm.searchQuery = "important";
    expect(vm.filteredCollections).toHaveLength(1);
    expect(vm.filteredCollections[0]._id).toBe("c1");
  });

  it("filteredCollections filters by resolved folder name", () => {
    const vm = mountComponent().vm as any;
    vm.collections = [
      collection("c1", { folderId: "f1" }),
      collection("c2", { folderId: "f2" }),
    ];
    vm.folderNames = { f1: "Experiments", f2: "Archive" };
    vm.searchQuery = "experi";
    expect(vm.filteredCollections).toHaveLength(1);
    expect(vm.filteredCollections[0]._id).toBe("c1");
  });

  // --- tableHeaders ---

  it("tableHeaders includes the Folder column only in the 'all' scope", async () => {
    const vm = mountComponent().vm as any;
    expect(vm.tableHeaders.map((h: any) => h.key)).not.toContain("folderName");
    vm.scope = "all";
    // Let the refetch the scope watcher kicks off settle first.
    await new Promise((r) => setTimeout(r, 0));
    expect(vm.tableHeaders.map((h: any) => h.key)).toContain("folderName");
  });

  // --- fetchCollections ---

  it("fetchCollections populates collections from the listing endpoint", async () => {
    (store as any).folderLocation = { _id: "folder1", name: "F" };
    mockListCollections.mockResolvedValue({
      collections: [collection("c1"), collection("c2")],
      hasMore: false,
    });
    const vm = mountComponent().vm as any;
    await vm.fetchCollections();
    expect(vm.collections).toHaveLength(2);
    expect(vm.hasMore).toBe(false);
    expect(vm.loading).toBe(false);
  });

  it("fetchCollections omits folderId in the 'all' scope", async () => {
    (store as any).folderLocation = { _id: "folder1", name: "F" };
    const vm = mountComponent().vm as any;
    vm.scope = "all";
    mockListCollections.mockClear();
    await vm.fetchCollections();
    expect(mockListCollections).toHaveBeenCalledWith({
      folderId: undefined,
      limit: vm.COLLECTION_PAGE_SIZE,
    });
  });

  it("fetchCollections handles error and sets empty collections", async () => {
    (store as any).folderLocation = { _id: "folder1", name: "F" };
    mockListCollections.mockRejectedValue(new Error("Network error"));
    const vm = mountComponent().vm as any;
    await vm.fetchCollections();
    expect(vm.collections).toEqual([]);
    expect(vm.loading).toBe(false);
  });

  it("fetchCollections falls back to the private folder when the location has no _id", async () => {
    (store as any).folderLocation = { type: "root" };
    const vm = mountComponent().vm as any;
    mockListCollections.mockClear();
    await vm.fetchCollections();
    expect(mockGetUserPrivateFolder).toHaveBeenCalled();
    expect(mockListCollections).toHaveBeenCalledWith({
      folderId: "private-folder",
      limit: vm.COLLECTION_PAGE_SIZE,
    });
  });

  it("fetchCollections sets empty collections when no folderId available", async () => {
    (store as any).folderLocation = { type: "root" };
    mockGetUserPrivateFolder.mockResolvedValue(null);
    const vm = mountComponent().vm as any;
    await vm.fetchCollections();
    expect(vm.collections).toEqual([]);
    expect(vm.loading).toBe(false);
  });

  // --- loadMore ---

  it("loadMore appends the next page at the current offset", async () => {
    (store as any).folderLocation = { _id: "folder1", name: "F" };
    const vm = mountComponent().vm as any;
    // Let the on-mount fetch settle so it doesn't clobber the seeded page.
    await new Promise((r) => setTimeout(r, 0));
    vm.collections = [collection("c1")];
    vm.hasMore = true;
    mockListCollections.mockResolvedValue({
      collections: [collection("c2")],
      hasMore: false,
    });
    await vm.loadMore();
    expect(mockListCollections).toHaveBeenLastCalledWith({
      folderId: "folder1",
      limit: vm.COLLECTION_PAGE_SIZE,
      offset: 1,
    });
    expect(vm.collections.map((c: any) => c._id)).toEqual(["c1", "c2"]);
    expect(vm.hasMore).toBe(false);
  });

  it("loadMore is a no-op when there is nothing more to load", async () => {
    const vm = mountComponent().vm as any;
    vm.hasMore = false;
    mockListCollections.mockClear();
    await vm.loadMore();
    expect(mockListCollections).not.toHaveBeenCalled();
  });

  // --- resolveFolderNames ---

  it("resolveFolderNames does nothing in the folder scope", async () => {
    const vm = mountComponent().vm as any;
    vm.collections = [collection("c1", { folderId: "f1" })];
    mockBatchResources.mockClear();
    await vm.resolveFolderNames();
    expect(mockBatchResources).not.toHaveBeenCalled();
    expect(vm.folderNames).toEqual({});
  });

  it("resolveFolderNames chunks large id sets across requests", async () => {
    const vm = mountComponent().vm as any;
    vm.scope = "all";
    // Let the refetch the scope watcher kicks off settle first.
    await new Promise((r) => setTimeout(r, 0));
    // One collection per folder, more folders than fit in a single request.
    vm.collections = Array.from({ length: 1200 }, (_unused, i) =>
      collection(`c${i}`, { folderId: `f${i}` }),
    );
    mockBatchResources.mockResolvedValue({ folder: {} });
    mockBatchResources.mockClear();
    await vm.resolveFolderNames();
    expect(mockBatchResources).toHaveBeenCalledTimes(3);
    expect(mockBatchResources.mock.calls[0][0].folder).toHaveLength(500);
    expect(mockBatchResources.mock.calls[2][0].folder).toHaveLength(200);
    expect(Object.keys(vm.folderNames)).toHaveLength(1200);
  });

  it("resolveFolderNames batch-resolves unseen folders only", async () => {
    const vm = mountComponent().vm as any;
    vm.scope = "all";
    // Let the refetch the scope watcher kicks off settle first.
    await new Promise((r) => setTimeout(r, 0));
    vm.collections = [
      collection("c1", { folderId: "f1" }),
      collection("c2", { folderId: "f1" }),
      collection("c3", { folderId: "f2" }),
    ];
    mockBatchResources.mockResolvedValue({
      folder: { f1: { name: "Experiments" } },
    });
    mockBatchResources.mockClear();
    await vm.resolveFolderNames();
    expect(mockBatchResources).toHaveBeenCalledTimes(1);
    expect(mockBatchResources).toHaveBeenCalledWith({ folder: ["f1", "f2"] });
    expect(vm.folderNames).toEqual({
      f1: "Experiments",
      f2: "Unknown folder",
    });

    // A second pass has nothing left to resolve.
    mockBatchResources.mockClear();
    await vm.resolveFolderNames();
    expect(mockBatchResources).not.toHaveBeenCalled();
  });

  // --- chips for the visible page ---

  it("onCurrentItemsChange resolves chips for the visible rows only once", async () => {
    const vm = mountComponent().vm as any;
    mockCollectionsToDatasetChips.mockResolvedValue({
      c1: {
        chips: [{ text: "Dataset A", color: "dataset" }],
        type: "collection",
      },
    });
    vm.onCurrentItemsChange([collection("c1")]);
    await new Promise((r) => setTimeout(r, 0));
    expect(mockCollectionsToDatasetChips).toHaveBeenCalledWith(["c1"]);
    expect(vm.debouncedChipsPerItemId.c1.chips).toHaveLength(1);

    // Paging back to the same row does not refetch.
    mockCollectionsToDatasetChips.mockClear();
    vm.onCurrentItemsChange([collection("c1")]);
    expect(mockCollectionsToDatasetChips).not.toHaveBeenCalled();
  });

  // --- navigation ---

  it("navigateToCollection pushes route with configurationId", () => {
    const vm = mountComponent().vm as any;
    vm.navigateToCollection("config123");
    expect(mockRouter.push).toHaveBeenCalledWith({
      name: "configuration",
      params: { configurationId: "config123" },
    });
  });

  it("onRowClick navigates to the clicked collection", () => {
    const vm = mountComponent().vm as any;
    mockRouter.push.mockClear();
    vm.onRowClick(new Event("click"), { item: collection("c9") });
    expect(mockRouter.push).toHaveBeenCalledWith({
      name: "configuration",
      params: { configurationId: "c9" },
    });
  });

  // --- scope persistence ---

  it("persists the scope choice and refetches when it changes", async () => {
    const vm = mountComponent().vm as any;
    mockListCollections.mockClear();
    vm.scope = "all";
    // Let the refetch the scope watcher kicks off settle first.
    await new Promise((r) => setTimeout(r, 0));
    expect(Persister.get("collectionBrowseScope", "folder")).toBe("all");
    expect(mockListCollections).toHaveBeenCalled();
  });

  it("restores the persisted scope on mount", () => {
    Persister.set("collectionBrowseScope", "all");
    const vm = mountComponent().vm as any;
    expect(vm.scope).toBe("all");
  });
});

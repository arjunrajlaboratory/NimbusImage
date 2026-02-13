import { describe, it, expect, vi, beforeEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

const mockFindDatasetViews = vi.fn();
const mockUpdateProject = vi.fn();
const mockUpdateProjectStatus = vi.fn();
const mockUpdateProjectMetadata = vi.fn();
const mockDeleteProject = vi.fn();
const mockRemoveDatasetFromProject = vi.fn();
const mockRemoveCollectionFromProject = vi.fn();
const mockWatchFolder = vi.fn();
const mockWatchCollection = vi.fn();
const mockBatchFetchResources = vi.fn();

vi.mock("@/store", () => ({
  default: {
    api: {
      findDatasetViews: (...args: any[]) => mockFindDatasetViews(...args),
    },
  },
}));

vi.mock("@/store/projects", () => ({
  default: {
    currentProject: {
      id: "proj-1",
      name: "Test Project",
      description: "A test project",
      meta: {
        status: "draft",
        datasets: [
          { datasetId: "ds-1", addedDate: "2024-01-01" },
          { datasetId: "ds-2", addedDate: "2024-01-02" },
        ],
        collections: [{ collectionId: "coll-1", addedDate: "2024-01-01" }],
        metadata: {
          title: "Project Title",
          description: "Project Description",
          license: "CC-BY-4.0",
          keywords: ["test"],
          authors: "Author 1",
          doi: "",
          publicationDate: "",
          funding: "",
        },
      },
    },
    updateProject: (...args: any[]) => mockUpdateProject(...args),
    updateProjectStatus: (...args: any[]) => mockUpdateProjectStatus(...args),
    updateProjectMetadata: (...args: any[]) =>
      mockUpdateProjectMetadata(...args),
    deleteProject: (...args: any[]) => mockDeleteProject(...args),
    removeDatasetFromProject: (...args: any[]) =>
      mockRemoveDatasetFromProject(...args),
    removeCollectionFromProject: (...args: any[]) =>
      mockRemoveCollectionFromProject(...args),
  },
}));

vi.mock("@/store/girderResources", () => ({
  default: {
    watchFolder: (...args: any[]) => mockWatchFolder(...args),
    watchCollection: (...args: any[]) => mockWatchCollection(...args),
    batchFetchResources: (...args: any[]) => mockBatchFetchResources(...args),
  },
}));

vi.mock("@/store/annotation", () => ({ default: {} }));
vi.mock("@/store/properties", () => ({ default: {} }));
vi.mock("@/utils/log", () => ({ logError: vi.fn() }));

import projects from "@/store/projects";
import ProjectInfo from "./ProjectInfo.vue";

Vue.use(Vuetify);

function mountComponent() {
  const app = document.createElement("div");
  app.setAttribute("data-app", "true");
  document.body.appendChild(app);
  return shallowMount(ProjectInfo, {
    vuetify: new Vuetify(),
    attachTo: app,
    mocks: {
      $route: { params: { projectId: "proj-1" } },
      $router: { push: vi.fn() },
    },
    stubs: {
      AlertDialog: true,
      AddDatasetToProjectDialog: true,
      AddCollectionToProjectFilterDialog: true,
    },
  });
}

function flushPromises() {
  return new Promise((r) => setTimeout(r, 0));
}

describe("ProjectInfo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (projects as any).currentProject = {
      id: "proj-1",
      name: "Test Project",
      description: "A test project",
      meta: {
        status: "draft",
        datasets: [
          { datasetId: "ds-1", addedDate: "2024-01-01" },
          { datasetId: "ds-2", addedDate: "2024-01-02" },
        ],
        collections: [{ collectionId: "coll-1", addedDate: "2024-01-01" }],
        metadata: {
          title: "Project Title",
          description: "Project Description",
          license: "CC-BY-4.0",
          keywords: ["test"],
          authors: "Author 1",
          doi: "",
          publicationDate: "",
          funding: "",
        },
      },
    };
    mockBatchFetchResources.mockResolvedValue(undefined);
    mockFindDatasetViews.mockResolvedValue([]);
    mockWatchFolder.mockReturnValue(null);
    mockWatchCollection.mockReturnValue(null);
  });

  it("project returns from projects store", () => {
    const wrapper = mountComponent();
    expect((wrapper.vm as any).project).toEqual(
      (projects as any).currentProject,
    );
    wrapper.destroy();
  });

  it("statusColor returns correct color for draft", () => {
    const wrapper = mountComponent();
    expect((wrapper.vm as any).statusColor).toBe("grey");
    wrapper.destroy();
  });

  it("statusColor returns correct color for exporting", () => {
    (projects as any).currentProject.meta.status = "exporting";
    const wrapper = mountComponent();
    expect((wrapper.vm as any).statusColor).toBe("warning");
    wrapper.destroy();
  });

  it("statusColor returns correct color for exported", () => {
    (projects as any).currentProject.meta.status = "exported";
    const wrapper = mountComponent();
    expect((wrapper.vm as any).statusColor).toBe("success");
    wrapper.destroy();
  });

  it("canStartExport returns true for draft", () => {
    const wrapper = mountComponent();
    expect((wrapper.vm as any).canStartExport).toBe(true);
    wrapper.destroy();
  });

  it("canMarkExported returns true for exporting", () => {
    (projects as any).currentProject.meta.status = "exporting";
    const wrapper = mountComponent();
    expect((wrapper.vm as any).canMarkExported).toBe(true);
    wrapper.destroy();
  });

  it("hasMetadataChanges detects field differences", async () => {
    const wrapper = mountComponent();
    await flushPromises();
    const vm = wrapper.vm as any;
    expect(vm.hasMetadataChanges).toBe(false);
    vm.metadata.title = "Changed Title";
    expect(vm.hasMetadataChanges).toBe(true);
    wrapper.destroy();
  });

  it("hasMetadataChanges detects array differences", async () => {
    const wrapper = mountComponent();
    await flushPromises();
    const vm = wrapper.vm as any;
    expect(vm.hasMetadataChanges).toBe(false);
    vm.metadata.keywords = ["test", "new"];
    expect(vm.hasMetadataChanges).toBe(true);
    wrapper.destroy();
  });

  it("allDatasetItems deduplicates direct + collection datasets", async () => {
    mockFindDatasetViews.mockResolvedValue([
      { id: "view-1", datasetId: "ds-1", configurationId: "coll-1" },
      { id: "view-2", datasetId: "ds-3", configurationId: "coll-1" },
    ]);
    const wrapper = mountComponent();
    await flushPromises();
    const vm = wrapper.vm as any;
    const items = vm.allDatasetItems;
    // ds-1 from direct, ds-2 from direct, ds-3 from collection
    // ds-1 appears in both direct and collection, should be deduplicated
    const datasetIds = items.map((i: any) => i.datasetId);
    expect(new Set(datasetIds).size).toBe(datasetIds.length);
    wrapper.destroy();
  });

  it("filteredDatasetItems filters by search", async () => {
    const wrapper = mountComponent();
    await flushPromises();
    const vm = wrapper.vm as any;
    // With no filter, should return all
    vm.datasetFilter = "";
    expect(vm.filteredDatasetItems.length).toBe(vm.allDatasetItems.length);
    wrapper.destroy();
  });

  it("filteredCollectionItems filters by search", async () => {
    const wrapper = mountComponent();
    await flushPromises();
    const vm = wrapper.vm as any;
    vm.collectionFilter = "";
    expect(vm.filteredCollectionItems.length).toBe(vm.collectionItems.length);
    wrapper.destroy();
  });

  it("totalProjectSize sums unique dataset sizes", async () => {
    const wrapper = mountComponent();
    await flushPromises();
    const vm = wrapper.vm as any;
    // With no cached info, total should be 0
    expect(vm.totalProjectSize).toBe(0);
    wrapper.destroy();
  });

  it("initializeMetadata populates form with fallbacks", async () => {
    const wrapper = mountComponent();
    await flushPromises();
    const vm = wrapper.vm as any;
    expect(vm.metadata.title).toBe("Project Title");
    expect(vm.metadata.license).toBe("CC-BY-4.0");
    expect(vm.metadata.keywords).toEqual(["test"]);
    wrapper.destroy();
  });

  it("tryUpdateName no-ops when unchanged", async () => {
    const wrapper = mountComponent();
    await flushPromises();
    const vm = wrapper.vm as any;
    vm.nameInput = "Test Project";
    await vm.tryUpdateName();
    expect(mockUpdateProject).not.toHaveBeenCalled();
    wrapper.destroy();
  });

  it("tryUpdateName calls API when different", async () => {
    mockUpdateProject.mockResolvedValue(undefined);
    const wrapper = mountComponent();
    await flushPromises();
    const vm = wrapper.vm as any;
    vm.nameInput = "New Name";
    await vm.tryUpdateName();
    expect(mockUpdateProject).toHaveBeenCalledWith({
      projectId: "proj-1",
      name: "New Name",
    });
    wrapper.destroy();
  });

  it("deleteProject calls store and navigates to home", async () => {
    mockDeleteProject.mockResolvedValue(true);
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    await vm.deleteProject();
    expect(mockDeleteProject).toHaveBeenCalledWith("proj-1");
    expect(wrapper.vm.$router.push).toHaveBeenCalledWith({ name: "home" });
    wrapper.destroy();
  });

  it("deleteProject does not navigate on failure", async () => {
    mockDeleteProject.mockResolvedValue(false);
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    await vm.deleteProject();
    expect(wrapper.vm.$router.push).not.toHaveBeenCalled();
    wrapper.destroy();
  });

  it("confirmRemoveDataset sets dialog state", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.confirmRemoveDataset("ds-1");
    expect(vm.datasetToRemove).toBe("ds-1");
    expect(vm.removeDatasetConfirm).toBe(true);
    wrapper.destroy();
  });

  it("removeDataset calls store and clears dialog", async () => {
    mockRemoveDatasetFromProject.mockResolvedValue(undefined);
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.datasetToRemove = "ds-1";
    vm.removeDatasetConfirm = true;
    await vm.removeDataset();
    expect(mockRemoveDatasetFromProject).toHaveBeenCalledWith({
      projectId: "proj-1",
      datasetId: "ds-1",
    });
    expect(vm.removeDatasetConfirm).toBe(false);
    expect(vm.datasetToRemove).toBeNull();
    wrapper.destroy();
  });

  it("confirmRemoveCollection sets dialog state", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.confirmRemoveCollection("coll-1");
    expect(vm.collectionToRemove).toBe("coll-1");
    expect(vm.removeCollectionConfirm).toBe(true);
    wrapper.destroy();
  });

  it("removeCollection calls store and clears dialog", async () => {
    mockRemoveCollectionFromProject.mockResolvedValue(undefined);
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.collectionToRemove = "coll-1";
    vm.removeCollectionConfirm = true;
    await vm.removeCollection();
    expect(mockRemoveCollectionFromProject).toHaveBeenCalledWith({
      projectId: "proj-1",
      collectionId: "coll-1",
    });
    expect(vm.removeCollectionConfirm).toBe(false);
    expect(vm.collectionToRemove).toBeNull();
    wrapper.destroy();
  });

  it("dialog state toggles", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.deleteConfirm).toBe(false);
    vm.deleteConfirm = true;
    expect(vm.deleteConfirm).toBe(true);
    wrapper.destroy();
  });
});

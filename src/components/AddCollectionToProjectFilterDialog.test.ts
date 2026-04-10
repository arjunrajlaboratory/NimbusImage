import { describe, it, expect, vi, beforeEach } from "vitest";
import { nextTick } from "vue";
import { shallowMount } from "@vue/test-utils";

const mockGetUserPrivateFolder = vi.fn();
const mockClientGet = vi.fn();
const mockAddCollectionToProject = vi.fn();

vi.mock("@/store", () => ({
  default: {
    api: {
      getUserPrivateFolder: (...args: any[]) =>
        mockGetUserPrivateFolder(...args),
      client: {
        get: (...args: any[]) => mockClientGet(...args),
      },
    },
    girderUser: { _id: "user1", login: "testuser" },
  },
}));

vi.mock("@/store/projects", () => ({
  default: {
    addCollectionToProject: (...args: any[]) =>
      mockAddCollectionToProject(...args),
  },
}));

vi.mock("@/girder/components", () => ({
  Breadcrumb: { name: "GirderBreadcrumb", template: "<div></div>" },
}));

vi.mock("@/components/GirderLocationChooser.vue", () => ({
  default: {
    name: "GirderLocationChooser",
    template: "<div></div>",
  },
}));

import AddCollectionToProjectFilterDialog from "./AddCollectionToProjectFilterDialog.vue";

const sampleProject = {
  id: "proj1",
  name: "Test Project",
  description: "A test project",
  creatorId: "u1",
  created: "2024-01-01T00:00:00Z",
  updated: "2024-06-01T00:00:00Z",
  meta: {
    datasets: [],
    collections: [
      { collectionId: "existing-col-1", addedDate: "2024-01-01" },
      { collectionId: "existing-col-2", addedDate: "2024-02-01" },
    ],
    metadata: {
      title: "",
      description: "",
      license: "",
      keywords: [],
    },
    status: "draft" as const,
  },
};

const sampleCollections = [
  {
    _id: "existing-col-1",
    _modelType: "upenn_collection" as const,
    name: "Collection Alpha",
    description: "Alpha description",
  },
  {
    _id: "col-3",
    _modelType: "upenn_collection" as const,
    name: "Collection Beta",
    description: "Beta description",
  },
  {
    _id: "col-4",
    _modelType: "upenn_collection" as const,
    name: "Collection Gamma",
    description: "",
  },
];

async function mountComponent(props = {}) {
  mockGetUserPrivateFolder.mockResolvedValue({
    _id: "private-folder",
    name: "Private",
    _modelType: "folder",
  });
  mockClientGet.mockResolvedValue({ data: [] });

  const wrapper = shallowMount(AddCollectionToProjectFilterDialog, {
    props: {
      project: sampleProject,
      ...props,
    },
  });

  // Wait for onMounted async to complete
  await nextTick();
  await nextTick();

  return wrapper;
}

describe("AddCollectionToProjectFilterDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("existingCollectionIds returns Set from project.meta.collections", async () => {
    const wrapper = await mountComponent();
    const vm = wrapper.vm as any;
    const ids = vm.existingCollectionIds;
    expect(ids).toBeInstanceOf(Set);
    expect(ids.has("existing-col-1")).toBe(true);
    expect(ids.has("existing-col-2")).toBe(true);
    expect(ids.has("col-3")).toBe(false);
  });

  it("filteredCollections returns all collections when searchQuery is empty", async () => {
    const wrapper = await mountComponent();
    const vm = wrapper.vm as any;
    vm.allCollections = sampleCollections;
    vm.searchQuery = "";
    expect(vm.filteredCollections).toEqual(sampleCollections);
  });

  it("filteredCollections filters by searchQuery on name", async () => {
    const wrapper = await mountComponent();
    const vm = wrapper.vm as any;
    vm.allCollections = sampleCollections;
    vm.searchQuery = "beta";
    expect(vm.filteredCollections).toHaveLength(1);
    expect(vm.filteredCollections[0]._id).toBe("col-3");
  });

  it("filteredCollections filters by searchQuery on description", async () => {
    const wrapper = await mountComponent();
    const vm = wrapper.vm as any;
    vm.allCollections = sampleCollections;
    vm.searchQuery = "alpha description";
    expect(vm.filteredCollections).toHaveLength(1);
    expect(vm.filteredCollections[0]._id).toBe("existing-col-1");
  });

  it("isInProject checks existingCollectionIds Set", async () => {
    const wrapper = await mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.isInProject("existing-col-1")).toBe(true);
    expect(vm.isInProject("existing-col-2")).toBe(true);
    expect(vm.isInProject("col-3")).toBe(false);
    expect(vm.isInProject("nonexistent")).toBe(false);
  });

  it("selectedCollections maps from selectedIds, filtering out already-in-project", async () => {
    const wrapper = await mountComponent();
    const vm = wrapper.vm as any;
    vm.allCollections = sampleCollections;
    vm.searchQuery = "";
    vm.selectedIds = new Set(["existing-col-1", "col-3"]);
    expect(vm.selectedCollections).toHaveLength(1);
    expect(vm.selectedCollections[0]._id).toBe("col-3");
  });

  it("selectedCollections returns empty when no ids selected", async () => {
    const wrapper = await mountComponent();
    const vm = wrapper.vm as any;
    vm.allCollections = sampleCollections;
    vm.selectedIds = new Set();
    expect(vm.selectedCollections).toHaveLength(0);
  });

  it("addCollections calls store for each selected collection and emits added", async () => {
    mockAddCollectionToProject.mockResolvedValue({});
    const wrapper = await mountComponent();
    const vm = wrapper.vm as any;
    vm.allCollections = sampleCollections;
    vm.searchQuery = "";
    vm.selectedIds = new Set(["col-3", "col-4"]);

    await vm.addCollections();

    expect(mockAddCollectionToProject).toHaveBeenCalledTimes(2);
    expect(mockAddCollectionToProject).toHaveBeenCalledWith({
      projectId: "proj1",
      collectionId: "col-3",
    });
    expect(mockAddCollectionToProject).toHaveBeenCalledWith({
      projectId: "proj1",
      collectionId: "col-4",
    });
    expect(wrapper.emitted("added")).toBeTruthy();
    expect(wrapper.emitted("added")![0][0]).toEqual(["col-3", "col-4"]);
  });

  it("addCollections does nothing when selectedCollections is empty", async () => {
    const wrapper = await mountComponent();
    const vm = wrapper.vm as any;
    vm.allCollections = sampleCollections;
    vm.selectedIds = new Set();

    await vm.addCollections();

    expect(mockAddCollectionToProject).not.toHaveBeenCalled();
    expect(wrapper.emitted("added")).toBeFalsy();
  });

  it("addCollections resets selectedIds after adding", async () => {
    mockAddCollectionToProject.mockResolvedValue({});
    const wrapper = await mountComponent();
    const vm = wrapper.vm as any;
    vm.allCollections = sampleCollections;
    vm.searchQuery = "";
    vm.selectedIds = new Set(["col-3"]);

    await vm.addCollections();

    expect(vm.selectedIds).toEqual(new Set());
  });

  it("watch on project resets selectedIds", async () => {
    const wrapper = await mountComponent();
    const vm = wrapper.vm as any;
    vm.selectedIds = new Set(["existing-col-1", "col-3", "col-4"]);

    const newProject = {
      ...sampleProject,
      id: "proj2",
      name: "New Project",
    };
    await wrapper.setProps({ project: newProject });

    expect(vm.selectedIds).toEqual(new Set());
  });
});

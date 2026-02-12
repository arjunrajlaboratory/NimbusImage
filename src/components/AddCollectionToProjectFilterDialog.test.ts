import { describe, it, expect, vi, beforeEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

const mockGetAllConfigurations = vi.fn();
const mockAddCollectionToProject = vi.fn();

vi.mock("@/store", () => ({
  default: {
    api: {
      getAllConfigurations: (...args: any[]) =>
        mockGetAllConfigurations(...args),
    },
  },
}));

vi.mock("@/store/projects", () => ({
  default: {
    addCollectionToProject: (...args: any[]) =>
      mockAddCollectionToProject(...args),
  },
}));

import AddCollectionToProjectFilterDialog from "./AddCollectionToProjectFilterDialog.vue";

Vue.use(Vuetify);

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
    id: "existing-col-1",
    name: "Collection Alpha",
    description: "Alpha description",
    compatibility: {
      xyDimensions: {},
      zDimensions: {},
      tDimensions: {},
      channels: {},
    },
    layers: [],
    tools: [],
    snapshots: [],
    propertyIds: [],
    scales: {},
  },
  {
    id: "col-3",
    name: "Collection Beta",
    description: "Beta description",
    compatibility: {
      xyDimensions: {},
      zDimensions: {},
      tDimensions: {},
      channels: {},
    },
    layers: [],
    tools: [],
    snapshots: [],
    propertyIds: [],
    scales: {},
  },
  {
    id: "col-4",
    name: "Collection Gamma",
    description: "",
    compatibility: {
      xyDimensions: {},
      zDimensions: {},
      tDimensions: {},
      channels: {},
    },
    layers: [],
    tools: [],
    snapshots: [],
    propertyIds: [],
    scales: {},
  },
];

async function mountComponent(props = {}) {
  // Prevent mounted() from making real API calls
  mockGetAllConfigurations.mockResolvedValue([]);

  const wrapper = shallowMount(AddCollectionToProjectFilterDialog, {
    vuetify: new Vuetify(),
    propsData: {
      project: sampleProject,
      ...props,
    },
  });

  // Wait for mounted() async fetchCollections to complete
  await Vue.nextTick();
  await Vue.nextTick();

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
    wrapper.destroy();
  });

  it("filteredCollections returns all collections when searchQuery is empty", async () => {
    const wrapper = await mountComponent();
    const vm = wrapper.vm as any;
    vm.allCollections = sampleCollections;
    vm.searchQuery = "";
    expect(vm.filteredCollections).toEqual(sampleCollections);
    wrapper.destroy();
  });

  it("filteredCollections filters by searchQuery on name", async () => {
    const wrapper = await mountComponent();
    const vm = wrapper.vm as any;
    vm.allCollections = sampleCollections;
    vm.searchQuery = "beta";
    expect(vm.filteredCollections).toHaveLength(1);
    expect(vm.filteredCollections[0].id).toBe("col-3");
    wrapper.destroy();
  });

  it("filteredCollections filters by searchQuery on description", async () => {
    const wrapper = await mountComponent();
    const vm = wrapper.vm as any;
    vm.allCollections = sampleCollections;
    vm.searchQuery = "alpha description";
    expect(vm.filteredCollections).toHaveLength(1);
    expect(vm.filteredCollections[0].id).toBe("existing-col-1");
    wrapper.destroy();
  });

  it("isInProject checks existingCollectionIds Set", async () => {
    const wrapper = await mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.isInProject("existing-col-1")).toBe(true);
    expect(vm.isInProject("existing-col-2")).toBe(true);
    expect(vm.isInProject("col-3")).toBe(false);
    expect(vm.isInProject("nonexistent")).toBe(false);
    wrapper.destroy();
  });

  it("selectedCollections maps from selectedIndices, filtering out already-in-project", async () => {
    const wrapper = await mountComponent();
    const vm = wrapper.vm as any;
    vm.allCollections = sampleCollections;
    vm.searchQuery = "";
    // Select index 0 (existing-col-1, already in project) and index 1 (col-3, not in project)
    vm.selectedIndices = [0, 1];
    expect(vm.selectedCollections).toHaveLength(1);
    expect(vm.selectedCollections[0].id).toBe("col-3");
    wrapper.destroy();
  });

  it("selectedCollections returns empty when no indices selected", async () => {
    const wrapper = await mountComponent();
    const vm = wrapper.vm as any;
    vm.allCollections = sampleCollections;
    vm.selectedIndices = [];
    expect(vm.selectedCollections).toHaveLength(0);
    wrapper.destroy();
  });

  it("addCollections calls store for each selected collection and emits added", async () => {
    mockAddCollectionToProject.mockResolvedValue({});
    const wrapper = await mountComponent();
    const vm = wrapper.vm as any;
    vm.allCollections = sampleCollections;
    vm.searchQuery = "";
    // Select col-3 (index 1) and col-4 (index 2) - both not in project
    vm.selectedIndices = [1, 2];

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
    wrapper.destroy();
  });

  it("addCollections does nothing when selectedCollections is empty", async () => {
    const wrapper = await mountComponent();
    const vm = wrapper.vm as any;
    vm.allCollections = sampleCollections;
    vm.selectedIndices = [];

    await vm.addCollections();

    expect(mockAddCollectionToProject).not.toHaveBeenCalled();
    expect(wrapper.emitted("added")).toBeFalsy();
    wrapper.destroy();
  });

  it("addCollections resets selectedIndices after adding", async () => {
    mockAddCollectionToProject.mockResolvedValue({});
    const wrapper = await mountComponent();
    const vm = wrapper.vm as any;
    vm.allCollections = sampleCollections;
    vm.searchQuery = "";
    vm.selectedIndices = [1];

    await vm.addCollections();

    expect(vm.selectedIndices).toEqual([]);
    wrapper.destroy();
  });

  it("watch on project resets selectedIndices", async () => {
    const wrapper = await mountComponent();
    const vm = wrapper.vm as any;
    vm.selectedIndices = [0, 1, 2];

    const newProject = {
      ...sampleProject,
      id: "proj2",
      name: "New Project",
    };
    await wrapper.setProps({ project: newProject });

    expect(vm.selectedIndices).toEqual([]);
    wrapper.destroy();
  });
});

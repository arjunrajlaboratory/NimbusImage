import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetchProjects = vi.fn().mockResolvedValue(undefined);
const mockCreateProject = vi.fn().mockResolvedValue(undefined);
const mockUpdateProject = vi.fn().mockResolvedValue(undefined);
const mockDeleteProject = vi.fn().mockResolvedValue(undefined);

const mockProjects = [
  {
    id: "p1",
    name: "Project One",
    description: "First project description",
    creatorId: "u1",
    created: "2024-01-01T00:00:00Z",
    updated: "2024-06-01T00:00:00Z",
    meta: {
      datasets: [{ datasetId: "d1", addedDate: "2024-01-01" }],
      collections: [{ collectionId: "c1", addedDate: "2024-01-01" }],
      metadata: { title: "", description: "", license: "", keywords: [] },
      status: "active" as const,
    },
  },
  {
    id: "p2",
    name: "Test Project",
    description: "Second project description",
    creatorId: "u1",
    created: "2024-02-01T00:00:00Z",
    updated: "2024-07-01T00:00:00Z",
    meta: {
      datasets: [],
      collections: [],
      metadata: { title: "", description: "", license: "", keywords: [] },
      status: "draft" as const,
    },
  },
];

vi.mock("@/store", () => ({
  default: { isLoggedIn: true },
}));

vi.mock("@/store/annotation", () => ({ default: {} }));
vi.mock("@/store/properties", () => ({ default: {} }));

vi.mock("@/store/projects", () => ({
  default: {
    get projects() {
      return mockProjects;
    },
    fetchProjects: (...args: any[]) => mockFetchProjects(...args),
    createProject: (...args: any[]) => mockCreateProject(...args),
    updateProject: (...args: any[]) => mockUpdateProject(...args),
    deleteProject: (...args: any[]) => mockDeleteProject(...args),
  },
}));

import { shallowMount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";
import ProjectList from "./ProjectList.vue";

Vue.use(Vuetify);

function mountComponent() {
  const app = document.createElement("div");
  app.setAttribute("data-app", "true");
  document.body.appendChild(app);

  return shallowMount(ProjectList, {
    vuetify: new Vuetify(),
    attachTo: app,
  });
}

describe("ProjectList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchProjects.mockResolvedValue(undefined);
  });

  it("fetchProjects is called on mount", async () => {
    const wrapper = mountComponent();
    await Vue.nextTick();
    expect(mockFetchProjects).toHaveBeenCalled();
    wrapper.destroy();
  });

  it("filteredProjects returns all projects when no search query", async () => {
    const wrapper = mountComponent();
    await Vue.nextTick();
    const vm = wrapper.vm as any;
    vm.searchQuery = "";
    expect(vm.filteredProjects).toEqual(mockProjects);
    wrapper.destroy();
  });

  it("filteredProjects filters by name", async () => {
    const wrapper = mountComponent();
    await Vue.nextTick();
    const vm = wrapper.vm as any;
    vm.searchQuery = "Test";
    expect(vm.filteredProjects).toHaveLength(1);
    expect(vm.filteredProjects[0].id).toBe("p2");
    wrapper.destroy();
  });

  it("filteredProjects filters by description", async () => {
    const wrapper = mountComponent();
    await Vue.nextTick();
    const vm = wrapper.vm as any;
    vm.searchQuery = "First";
    expect(vm.filteredProjects).toHaveLength(1);
    expect(vm.filteredProjects[0].id).toBe("p1");
    wrapper.destroy();
  });

  it("filteredProjects is case insensitive", async () => {
    const wrapper = mountComponent();
    await Vue.nextTick();
    const vm = wrapper.vm as any;
    vm.searchQuery = "test project";
    expect(vm.filteredProjects).toHaveLength(1);
    expect(vm.filteredProjects[0].id).toBe("p2");
    wrapper.destroy();
  });

  it("editProject sets editing state", async () => {
    const wrapper = mountComponent();
    await Vue.nextTick();
    const vm = wrapper.vm as any;
    vm.editProject(mockProjects[0]);
    expect(vm.editingProject).toEqual(mockProjects[0]);
    expect(vm.editProjectName).toBe("Project One");
    expect(vm.editProjectDescription).toBe("First project description");
    expect(vm.showEditDialog).toBe(true);
    wrapper.destroy();
  });

  it("confirmDeleteProject sets delete state", async () => {
    const wrapper = mountComponent();
    await Vue.nextTick();
    const vm = wrapper.vm as any;
    vm.confirmDeleteProject(mockProjects[1]);
    expect(vm.projectToDelete).toEqual(mockProjects[1]);
    expect(vm.showDeleteDialog).toBe(true);
    wrapper.destroy();
  });

  it("createProject calls store and resets form", async () => {
    const wrapper = mountComponent();
    await Vue.nextTick();
    const vm = wrapper.vm as any;
    vm.newProjectName = "New Project";
    vm.newProjectDescription = "A description";
    vm.showCreateDialog = true;

    await vm.createProject();

    expect(mockCreateProject).toHaveBeenCalledWith({
      name: "New Project",
      description: "A description",
    });
    expect(vm.showCreateDialog).toBe(false);
    expect(vm.newProjectName).toBe("");
    expect(vm.newProjectDescription).toBe("");
    expect(vm.creating).toBe(false);
    wrapper.destroy();
  });

  it("createProject does nothing when name is empty", async () => {
    const wrapper = mountComponent();
    await Vue.nextTick();
    const vm = wrapper.vm as any;
    vm.newProjectName = "   ";

    await vm.createProject();

    expect(mockCreateProject).not.toHaveBeenCalled();
    wrapper.destroy();
  });

  it("saveProject calls store and closes dialog", async () => {
    const wrapper = mountComponent();
    await Vue.nextTick();
    const vm = wrapper.vm as any;
    vm.editingProject = mockProjects[0];
    vm.editProjectName = "Updated Name";
    vm.editProjectDescription = "Updated Desc";

    await vm.saveProject();

    expect(mockUpdateProject).toHaveBeenCalledWith({
      projectId: "p1",
      name: "Updated Name",
      description: "Updated Desc",
    });
    expect(vm.showEditDialog).toBe(false);
    expect(vm.editingProject).toBeNull();
    expect(vm.saving).toBe(false);
    wrapper.destroy();
  });

  it("saveProject does nothing when no editing project", async () => {
    const wrapper = mountComponent();
    await Vue.nextTick();
    const vm = wrapper.vm as any;
    vm.editingProject = null;
    vm.editProjectName = "Name";

    await vm.saveProject();

    expect(mockUpdateProject).not.toHaveBeenCalled();
    wrapper.destroy();
  });

  it("deleteProject calls store and closes dialog", async () => {
    const wrapper = mountComponent();
    await Vue.nextTick();
    const vm = wrapper.vm as any;
    vm.projectToDelete = mockProjects[1];

    await vm.deleteProject();

    expect(mockDeleteProject).toHaveBeenCalledWith("p2");
    expect(vm.showDeleteDialog).toBe(false);
    expect(vm.projectToDelete).toBeNull();
    expect(vm.deleting).toBe(false);
    wrapper.destroy();
  });

  it("deleteProject does nothing when no project to delete", async () => {
    const wrapper = mountComponent();
    await Vue.nextTick();
    const vm = wrapper.vm as any;
    vm.projectToDelete = null;

    await vm.deleteProject();

    expect(mockDeleteProject).not.toHaveBeenCalled();
    wrapper.destroy();
  });

  it("loading is set to false after fetchProjects completes", async () => {
    const wrapper = mountComponent();
    // Flush the microtask queue so the async onMounted resolves
    await Vue.nextTick();
    await Vue.nextTick();
    const vm = wrapper.vm as any;
    expect(vm.loading).toBe(false);
    wrapper.destroy();
  });
});

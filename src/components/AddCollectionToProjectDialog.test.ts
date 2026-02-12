import { describe, it, expect, vi, beforeEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

const mockFetchProjects = vi.fn();
const mockCreateProject = vi.fn();
const mockAddCollectionToProject = vi.fn();

const mockProjects = [
  {
    id: "proj1",
    name: "Project One",
    description: "First project",
    creatorId: "u1",
    created: "2024-01-01T00:00:00Z",
    updated: "2024-06-01T00:00:00Z",
    meta: {
      datasets: [],
      collections: [{ collectionId: "col1", addedDate: "2024-01-01" }],
      metadata: { title: "", description: "", license: "", keywords: [] },
      status: "draft" as const,
    },
  },
  {
    id: "proj2",
    name: "Project Two",
    description: "Second project",
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
  default: {},
}));

vi.mock("@/store/projects", () => ({
  default: {
    get projects() {
      return mockProjects;
    },
    fetchProjects: (...args: any[]) => mockFetchProjects(...args),
    createProject: (...args: any[]) => mockCreateProject(...args),
    addCollectionToProject: (...args: any[]) =>
      mockAddCollectionToProject(...args),
  },
}));

import AddCollectionToProjectDialog from "./AddCollectionToProjectDialog.vue";

Vue.use(Vuetify);

function mountComponent(props = {}) {
  const app = document.createElement("div");
  app.setAttribute("data-app", "true");
  document.body.appendChild(app);

  return shallowMount(AddCollectionToProjectDialog, {
    vuetify: new Vuetify(),
    attachTo: app,
    propsData: {
      value: false,
      collectionId: "col-new",
      collectionName: "New Collection",
      ...props,
    },
  });
}

describe("AddCollectionToProjectDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("dialogModel get returns prop value", () => {
    const wrapper = mountComponent({ value: true });
    expect((wrapper.vm as any).dialogModel).toBe(true);
    wrapper.destroy();
  });

  it("dialogModel get returns false when value is false", () => {
    const wrapper = mountComponent({ value: false });
    expect((wrapper.vm as any).dialogModel).toBe(false);
    wrapper.destroy();
  });

  it("dialogModel set emits input", () => {
    const wrapper = mountComponent();
    (wrapper.vm as any).dialogModel = true;
    expect(wrapper.emitted("input")).toBeTruthy();
    expect(wrapper.emitted("input")![0][0]).toBe(true);
    wrapper.destroy();
  });

  it("canAdd returns false when no project selected on tab 0", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.tab = 0;
    vm.selectedProjectIndex = null;
    expect(vm.canAdd).toBe(false);
    wrapper.destroy();
  });

  it("canAdd returns true when valid project selected on tab 0", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.tab = 0;
    // Select Project Two (index 1) which has no collections
    vm.selectedProjectIndex = 1;
    expect(vm.canAdd).toBe(true);
    wrapper.destroy();
  });

  it("canAdd returns false when selected project already has the collection", () => {
    const wrapper = mountComponent({ collectionId: "col1" });
    const vm = wrapper.vm as any;
    vm.tab = 0;
    // Select Project One (index 0) which has col1
    vm.selectedProjectIndex = 0;
    expect(vm.canAdd).toBe(false);
    wrapper.destroy();
  });

  it("canAdd returns false when empty name on tab 1", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.tab = 1;
    vm.newProjectName = "";
    expect(vm.canAdd).toBe(false);
    wrapper.destroy();
  });

  it("canAdd returns false when whitespace-only name on tab 1", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.tab = 1;
    vm.newProjectName = "   ";
    expect(vm.canAdd).toBe(false);
    wrapper.destroy();
  });

  it("canAdd returns true when name entered on tab 1", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.tab = 1;
    vm.newProjectName = "My New Project";
    expect(vm.canAdd).toBe(true);
    wrapper.destroy();
  });

  it("availableProjects returns projects from store", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.availableProjects).toEqual(mockProjects);
    wrapper.destroy();
  });

  it("selectedProject returns null when no index selected", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.selectedProjectIndex = null;
    expect(vm.selectedProject).toBeNull();
    wrapper.destroy();
  });

  it("selectedProject returns correct project by index", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.selectedProjectIndex = 1;
    expect(vm.selectedProject).toEqual(mockProjects[1]);
    wrapper.destroy();
  });

  it("isCollectionInProject returns true when collection is in project", () => {
    const wrapper = mountComponent({ collectionId: "col1" });
    const vm = wrapper.vm as any;
    expect(vm.isCollectionInProject(mockProjects[0])).toBe(true);
    wrapper.destroy();
  });

  it("isCollectionInProject returns false when collection is not in project", () => {
    const wrapper = mountComponent({ collectionId: "col-new" });
    const vm = wrapper.vm as any;
    expect(vm.isCollectionInProject(mockProjects[0])).toBe(false);
    wrapper.destroy();
  });

  it("addToProject (tab 0) calls addCollectionToProject with selected project", async () => {
    mockAddCollectionToProject.mockResolvedValue({});
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.tab = 0;
    vm.selectedProjectIndex = 1;

    await vm.addToProject();

    expect(mockAddCollectionToProject).toHaveBeenCalledWith({
      projectId: "proj2",
      collectionId: "col-new",
    });
    expect(wrapper.emitted("added")).toBeTruthy();
    expect(wrapper.emitted("added")![0][0]).toBe("proj2");
    wrapper.destroy();
  });

  it("addToProject (tab 1) calls createProject then addCollectionToProject", async () => {
    const newProject = { id: "proj-new", name: "New Project" };
    mockCreateProject.mockResolvedValue(newProject);
    mockAddCollectionToProject.mockResolvedValue({});
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.tab = 1;
    vm.newProjectName = "New Project";
    vm.newProjectDescription = "A description";

    await vm.addToProject();

    expect(mockCreateProject).toHaveBeenCalledWith({
      name: "New Project",
      description: "A description",
    });
    expect(mockAddCollectionToProject).toHaveBeenCalledWith({
      projectId: "proj-new",
      collectionId: "col-new",
    });
    expect(wrapper.emitted("added")).toBeTruthy();
    expect(wrapper.emitted("added")![0][0]).toBe("proj-new");
    wrapper.destroy();
  });

  it("addToProject (tab 1) returns early if createProject returns null", async () => {
    mockCreateProject.mockResolvedValue(null);
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.tab = 1;
    vm.newProjectName = "New Project";

    await vm.addToProject();

    expect(mockCreateProject).toHaveBeenCalled();
    expect(mockAddCollectionToProject).not.toHaveBeenCalled();
    expect(wrapper.emitted("added")).toBeFalsy();
    wrapper.destroy();
  });

  it("addToProject does nothing when canAdd is false", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.tab = 0;
    vm.selectedProjectIndex = null;

    await vm.addToProject();

    expect(mockAddCollectionToProject).not.toHaveBeenCalled();
    expect(wrapper.emitted("added")).toBeFalsy();
    wrapper.destroy();
  });

  it("reset clears all fields", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.tab = 1;
    vm.selectedProjectIndex = 2;
    vm.newProjectName = "Something";
    vm.newProjectDescription = "Desc";

    vm.reset();

    expect(vm.tab).toBe(0);
    expect(vm.selectedProjectIndex).toBeNull();
    expect(vm.newProjectName).toBe("");
    expect(vm.newProjectDescription).toBe("");
    wrapper.destroy();
  });

  it("cancel closes dialog", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.cancel();
    expect(wrapper.emitted("input")).toBeTruthy();
    expect(wrapper.emitted("input")![0][0]).toBe(false);
    wrapper.destroy();
  });

  it("watch on value loads projects and resets when opened", async () => {
    mockFetchProjects.mockResolvedValue(undefined);
    const wrapper = mountComponent({ value: false });
    const vm = wrapper.vm as any;
    vm.tab = 1;
    vm.newProjectName = "test";

    await wrapper.setProps({ value: true });
    await Vue.nextTick();

    expect(mockFetchProjects).toHaveBeenCalled();
    expect(vm.tab).toBe(0);
    expect(vm.newProjectName).toBe("");
    wrapper.destroy();
  });
});

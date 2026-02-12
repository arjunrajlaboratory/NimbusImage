import { describe, it, expect, vi, beforeEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

const mockFetchProjects = vi.fn();
const mockCreateProject = vi.fn();
const mockAddDatasetToProject = vi.fn();

const mockProjects = [
  {
    id: "proj1",
    name: "Project One",
    description: "First project",
    creatorId: "u1",
    created: "2024-01-01T00:00:00Z",
    updated: "2024-06-01T00:00:00Z",
    meta: {
      datasets: [{ datasetId: "ds1", addedDate: "2024-01-01" }],
      collections: [],
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
    addDatasetToProject: (...args: any[]) => mockAddDatasetToProject(...args),
  },
}));

import AddToProjectDialog from "./AddToProjectDialog.vue";

Vue.use(Vuetify);

function mountComponent(props = {}) {
  const app = document.createElement("div");
  app.setAttribute("data-app", "true");
  document.body.appendChild(app);

  return shallowMount(AddToProjectDialog, {
    vuetify: new Vuetify(),
    attachTo: app,
    propsData: {
      value: false,
      datasetId: "ds-new",
      datasetName: "New Dataset",
      ...props,
    },
  });
}

describe("AddToProjectDialog", () => {
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
    // Select Project Two (index 1) which does not have ds-new
    vm.selectedProjectIndex = 1;
    expect(vm.canAdd).toBe(true);
    wrapper.destroy();
  });

  it("canAdd returns false when selected project already has the dataset", () => {
    const wrapper = mountComponent({ datasetId: "ds1" });
    const vm = wrapper.vm as any;
    vm.tab = 0;
    // Select Project One (index 0) which has ds1
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

  it("isDatasetInProject returns true when dataset is in project", () => {
    const wrapper = mountComponent({ datasetId: "ds1" });
    const vm = wrapper.vm as any;
    expect(vm.isDatasetInProject(mockProjects[0])).toBe(true);
    wrapper.destroy();
  });

  it("isDatasetInProject returns false when dataset is not in project", () => {
    const wrapper = mountComponent({ datasetId: "ds-new" });
    const vm = wrapper.vm as any;
    expect(vm.isDatasetInProject(mockProjects[0])).toBe(false);
    wrapper.destroy();
  });

  it("addToProject (tab 0) calls addDatasetToProject with selected project", async () => {
    mockAddDatasetToProject.mockResolvedValue({});
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.tab = 0;
    vm.selectedProjectIndex = 1;

    await vm.addToProject();

    expect(mockAddDatasetToProject).toHaveBeenCalledWith({
      projectId: "proj2",
      datasetId: "ds-new",
    });
    expect(wrapper.emitted("added")).toBeTruthy();
    expect(wrapper.emitted("added")![0][0]).toBe("proj2");
    wrapper.destroy();
  });

  it("addToProject (tab 1) calls createProject then addDatasetToProject", async () => {
    const newProject = { id: "proj-new", name: "New Project" };
    mockCreateProject.mockResolvedValue(newProject);
    mockAddDatasetToProject.mockResolvedValue({});
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
    expect(mockAddDatasetToProject).toHaveBeenCalledWith({
      projectId: "proj-new",
      datasetId: "ds-new",
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
    expect(mockAddDatasetToProject).not.toHaveBeenCalled();
    expect(wrapper.emitted("added")).toBeFalsy();
    wrapper.destroy();
  });

  it("addToProject does nothing when canAdd is false", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.tab = 0;
    vm.selectedProjectIndex = null;

    await vm.addToProject();

    expect(mockAddDatasetToProject).not.toHaveBeenCalled();
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
    // Allow async operations to settle
    await Vue.nextTick();

    expect(mockFetchProjects).toHaveBeenCalled();
    expect(vm.tab).toBe(0);
    expect(vm.newProjectName).toBe("");
    wrapper.destroy();
  });
});

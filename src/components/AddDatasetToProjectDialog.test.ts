import { describe, it, expect, vi, beforeEach } from "vitest";
import { shallowMount } from "@vue/test-utils";

const mockGetDataset = vi.fn();
const mockAddDatasetToProject = vi.fn();
const mockIsDatasetFolder = vi.fn();

vi.mock("@/store", () => ({
  default: {},
}));

vi.mock("@/store/girderResources", () => ({
  default: {
    getDataset: (...args: any[]) => mockGetDataset(...args),
  },
}));

vi.mock("@/store/projects", () => ({
  default: {
    addDatasetToProject: (...args: any[]) => mockAddDatasetToProject(...args),
  },
}));

vi.mock("@/utils/girderSelectable", () => ({
  isDatasetFolder: (...args: any[]) => mockIsDatasetFolder(...args),
}));

vi.mock("@/components/CustomFileManager.vue", () => ({
  default: {
    name: "CustomFileManager",
    template: "<div></div>",
  },
}));

import AddDatasetToProjectDialog from "./AddDatasetToProjectDialog.vue";

const sampleProject = {
  id: "proj1",
  name: "Test Project",
  description: "A test project",
  creatorId: "u1",
  created: "2024-01-01T00:00:00Z",
  updated: "2024-06-01T00:00:00Z",
  meta: {
    datasets: [
      { datasetId: "ds-existing-1", addedDate: "2024-01-01" },
      { datasetId: "ds-existing-2", addedDate: "2024-02-01" },
    ],
    collections: [],
    metadata: {
      title: "",
      description: "",
      license: "",
      keywords: [],
    },
    status: "draft" as const,
  },
};

function mountComponent(props = {}) {
  return shallowMount(AddDatasetToProjectDialog, {
    props: {
      project: sampleProject,
      ...props,
    },
    global: {
      stubs: {
        CustomFileManager: true,
      },
    },
  });
}

describe("AddDatasetToProjectDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("existingDatasetIds returns Set from project.meta.datasets", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const ids = vm.existingDatasetIds;
    expect(ids).toBeInstanceOf(Set);
    expect(ids.has("ds-existing-1")).toBe(true);
    expect(ids.has("ds-existing-2")).toBe(true);
    expect(ids.has("ds-new")).toBe(false);
  });

  it("existingDatasetIds returns empty Set when no datasets", () => {
    const projectWithNoDatasets = {
      ...sampleProject,
      meta: {
        ...sampleProject.meta,
        datasets: [],
      },
    };
    const wrapper = mountComponent({ project: projectWithNoDatasets });
    const vm = wrapper.vm as any;
    expect(vm.existingDatasetIds.size).toBe(0);
  });

  it("addDatasets calls addDatasetToProject for each selected dataset and emits added", async () => {
    mockAddDatasetToProject.mockResolvedValue({});
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    vm.selectedDatasets = [
      { id: "ds-new-1", name: "Dataset One" },
      { id: "ds-new-2", name: "Dataset Two" },
    ];

    await vm.addDatasets();

    expect(mockAddDatasetToProject).toHaveBeenCalledTimes(2);
    expect(mockAddDatasetToProject).toHaveBeenCalledWith({
      projectId: "proj1",
      datasetId: "ds-new-1",
    });
    expect(mockAddDatasetToProject).toHaveBeenCalledWith({
      projectId: "proj1",
      datasetId: "ds-new-2",
    });
    expect(wrapper.emitted("added")).toBeTruthy();
    expect(wrapper.emitted("added")![0][0]).toEqual(["ds-new-1", "ds-new-2"]);
  });

  it("addDatasets does nothing when selectedDatasets is empty", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.selectedDatasets = [];

    await vm.addDatasets();

    expect(mockAddDatasetToProject).not.toHaveBeenCalled();
    expect(wrapper.emitted("added")).toBeFalsy();
  });

  it("addDatasets clears selectedDatasets and warnings after success", async () => {
    mockAddDatasetToProject.mockResolvedValue({});
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    vm.selectedDatasets = [{ id: "ds-new-1", name: "Dataset One" }];
    vm.warnings = ["some warning"];

    await vm.addDatasets();

    expect(vm.selectedDatasets).toEqual([]);
    expect(vm.warnings).toEqual([]);
  });

  it("addDatasets sets adding to true during execution and false after", async () => {
    let resolvePromise: () => void;
    mockAddDatasetToProject.mockImplementation(
      () => new Promise<void>((resolve) => (resolvePromise = resolve)),
    );

    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.selectedDatasets = [{ id: "ds-new-1", name: "Dataset One" }];

    const addPromise = vm.addDatasets();
    expect(vm.adding).toBe(true);

    resolvePromise!();
    await addPromise;

    expect(vm.adding).toBe(false);
  });

  it("onSelectDataset processes selected locations", async () => {
    const selectedLocations = [
      { _id: "folder1", _modelType: "folder" },
      { _id: "folder2", _modelType: "folder" },
    ];

    mockIsDatasetFolder.mockReturnValue(true);
    mockGetDataset.mockImplementation(({ id }: { id: string }) =>
      Promise.resolve({
        id,
        name: `Dataset ${id}`,
      }),
    );

    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    await vm.onSelectDataset(selectedLocations);

    expect(mockIsDatasetFolder).toHaveBeenCalledTimes(2);
    expect(mockGetDataset).toHaveBeenCalledTimes(2);
    expect(vm.selectedDatasets).toHaveLength(2);
  });

  it("onSelectDataset clears selection when empty locations provided", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.selectedDatasets = [{ id: "ds1", name: "old" }];
    vm.warnings = ["old warning"];

    await vm.onSelectDataset([]);

    expect(vm.selectedDatasets).toEqual([]);
    expect(vm.warnings).toEqual([]);
  });

  it("onSelectDataset warns about already-in-project datasets", async () => {
    const selectedLocations = [{ _id: "ds-existing-1", _modelType: "folder" }];

    mockIsDatasetFolder.mockReturnValue(true);
    mockGetDataset.mockResolvedValue({
      id: "ds-existing-1",
      name: "Existing Dataset",
    });

    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    await vm.onSelectDataset(selectedLocations);

    expect(vm.selectedDatasets).toHaveLength(0);
    expect(vm.warnings).toContain(
      '"Existing Dataset" is already in this project',
    );
  });

  it("onSelectDataset warns about non-dataset selections", async () => {
    const selectedLocations = [{ _id: "not-a-dataset", _modelType: "folder" }];

    mockIsDatasetFolder.mockReturnValue(false);

    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    await vm.onSelectDataset(selectedLocations);

    expect(vm.selectedDatasets).toHaveLength(0);
    expect(vm.warnings).toContain("1 selected item(s) are not datasets");
  });
});

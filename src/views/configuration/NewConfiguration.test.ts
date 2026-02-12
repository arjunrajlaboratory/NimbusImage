import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

const mockGetFolder = vi.fn();

vi.mock("@/store", () => ({
  default: {
    dataset: { id: "ds-1", name: "Test Dataset" },
    selectedDatasetId: "ds-1",
    setSelectedDataset: vi.fn(),
    girderUser: { _id: "user-1", login: "admin", _modelType: "user" },
    createConfiguration: vi.fn(),
    createDatasetView: vi.fn(),
  },
}));

vi.mock("@/store/girderResources", () => ({
  default: {
    getFolder: (...args: any[]) => mockGetFolder(...args),
  },
}));

vi.mock("@/store/annotation", () => ({ default: {} }));
vi.mock("@/store/properties", () => ({ default: {} }));
vi.mock("@/utils/useRouteMapper", () => ({ useRouteMapper: vi.fn() }));

vi.mock("@/components/GirderLocationChooser.vue", () => ({
  default: {
    name: "GirderLocationChooser",
    template: "<div />",
    props: ["value", "breadcrumb", "title"],
  },
}));

import store from "@/store";
import NewConfiguration from "./NewConfiguration.vue";

Vue.use(Vuetify);

function mountComponent() {
  return mount(NewConfiguration, {
    vuetify: new Vuetify(),
    mocks: {
      $route: { params: { datasetId: "ds-1" } },
      $router: { push: vi.fn() },
    },
    stubs: {
      GirderLocationChooser: true,
    },
  });
}

/** Flush all pending microtasks (resolved promises) */
function flushPromises() {
  return new Promise((r) => setTimeout(r, 0));
}

describe("NewConfiguration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (store as any).dataset = { id: "ds-1", name: "Test Dataset" };
    (store as any).girderUser = {
      _id: "user-1",
      login: "admin",
      _modelType: "user",
    };
    // Default mock so onMounted fetchDefaultPath does not break
    mockGetFolder.mockResolvedValue(null);
  });

  it("initial state has empty name and description", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.name).toBe("");
    expect(vm.description).toBe("");
  });

  it("dataset computed returns store.dataset", () => {
    const wrapper = mountComponent();
    expect((wrapper.vm as any).dataset).toEqual({
      id: "ds-1",
      name: "Test Dataset",
    });
  });

  it("fetchDefaultPath sets path from parent folder", async () => {
    const parentFolder = {
      _id: "parent-1",
      name: "Parent Folder",
      parentId: "grandparent-1",
      _modelType: "folder",
    };
    // onMounted will consume these first
    mockGetFolder
      .mockResolvedValueOnce({
        _id: "ds-1",
        name: "Dataset Folder",
        parentId: "parent-1",
        _modelType: "folder",
      })
      .mockResolvedValueOnce(parentFolder);

    const wrapper = mountComponent();
    // Wait for onMounted fetchDefaultPath to complete
    await flushPromises();

    expect(mockGetFolder).toHaveBeenCalledWith("ds-1");
    expect(mockGetFolder).toHaveBeenCalledWith("parent-1");
    expect((wrapper.vm as any).path).toEqual(parentFolder);
  });

  it("fetchDefaultPath falls back to girderUser when no dataset", async () => {
    (store as any).dataset = null;

    const wrapper = mountComponent();
    await flushPromises();

    expect(mockGetFolder).not.toHaveBeenCalled();
    expect((wrapper.vm as any).path).toEqual({
      _id: "user-1",
      login: "admin",
      _modelType: "user",
    });
  });

  it("fetchDefaultPath falls back to girderUser when dataset folder has no parentId", async () => {
    mockGetFolder.mockResolvedValueOnce({
      _id: "ds-1",
      name: "Dataset Folder",
      _modelType: "folder",
    });

    const wrapper = mountComponent();
    await flushPromises();

    expect((wrapper.vm as any).path).toEqual({
      _id: "user-1",
      login: "admin",
      _modelType: "user",
    });
  });

  it("validation rules reject empty string", () => {
    const wrapper = mountComponent();
    const ruleFns = (wrapper.vm as any).rules;
    expect(ruleFns).toHaveLength(1);
    expect(ruleFns[0]("")).toBe("value is required");
    expect(ruleFns[0]("   ")).toBe("value is required");
  });

  it("validation rules accept non-empty string", () => {
    const wrapper = mountComponent();
    const ruleFns = (wrapper.vm as any).rules;
    expect(ruleFns[0]("My Config")).toBe(true);
  });

  it("submit does nothing when not valid", async () => {
    const wrapper = mountComponent();
    await flushPromises();
    const vm = wrapper.vm as any;
    vm.valid = false;
    vm.submit();
    expect(store.createConfiguration).not.toHaveBeenCalled();
  });

  it("submit does nothing when path has no _id", async () => {
    const wrapper = mountComponent();
    await flushPromises();
    const vm = wrapper.vm as any;
    vm.valid = true;
    vm.path = null;
    vm.submit();
    expect(store.createConfiguration).not.toHaveBeenCalled();
  });

  it("submit calls createConfiguration and navigates on success", async () => {
    const mockConfig = { id: "config-new" };
    (store.createConfiguration as any).mockResolvedValue(mockConfig);
    (store.createDatasetView as any).mockResolvedValue(undefined);

    const wrapper = mountComponent();
    await flushPromises();
    const vm = wrapper.vm as any;
    vm.valid = true;
    vm.name = "My Config";
    vm.description = "A description";
    vm.path = { _id: "folder-1", name: "Folder", _modelType: "folder" };

    vm.submit();
    await flushPromises();

    expect(store.createConfiguration).toHaveBeenCalledWith({
      name: "My Config",
      description: "A description",
      folderId: "folder-1",
    });
    expect(store.createDatasetView).toHaveBeenCalledWith({
      configurationId: "config-new",
      datasetId: "ds-1",
    });
    expect(wrapper.vm.$router.push).toHaveBeenCalledWith({
      name: "configuration",
      params: {
        configurationId: "config-new",
        datasetId: "ds-1",
      },
    });
  });

  it("submit does not create dataset view when no dataset", async () => {
    (store as any).dataset = null;
    const mockConfig = { id: "config-new" };
    (store.createConfiguration as any).mockResolvedValue(mockConfig);

    const wrapper = mountComponent();
    await flushPromises();
    const vm = wrapper.vm as any;
    vm.valid = true;
    vm.name = "Config";
    vm.path = { _id: "folder-1", name: "Folder", _modelType: "folder" };

    vm.submit();
    await flushPromises();

    expect(store.createConfiguration).toHaveBeenCalled();
    expect(store.createDatasetView).not.toHaveBeenCalled();
  });
});

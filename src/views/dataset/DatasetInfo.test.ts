import { describe, it, expect, vi, beforeEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

const mockFindDatasetViews = vi.fn();
const mockDuplicateConfiguration = vi.fn();
const mockGetAnnotationCount = vi.fn();
const mockGetConnectionCount = vi.fn();
const mockGetPropertyValueCount = vi.fn();
const mockGetPropertyCount = vi.fn();
const mockDeleteDataset = vi.fn();
const mockDeleteDatasetView = vi.fn();
const mockCreateDatasetView = vi.fn();
const mockCreateConfiguration = vi.fn();
const mockCreateConfigurationFromBase = vi.fn();

vi.mock("@/store", () => ({
  default: {
    dataset: {
      id: "ds-1",
      name: "Test Dataset",
      description: "A test dataset",
      time: [0, 1, 2],
      xy: [0],
      z: [0, 1],
      channels: [0, 1, 2],
    },
    api: {
      findDatasetViews: (...args: any[]) => mockFindDatasetViews(...args),
      duplicateConfiguration: (...args: any[]) =>
        mockDuplicateConfiguration(...args),
      createConfigurationFromBase: (...args: any[]) =>
        mockCreateConfigurationFromBase(...args),
    },
    annotationsAPI: {
      getAnnotationCount: (...args: any[]) => mockGetAnnotationCount(...args),
      getConnectionCount: (...args: any[]) => mockGetConnectionCount(...args),
      getPropertyValueCount: (...args: any[]) =>
        mockGetPropertyValueCount(...args),
    },
    propertiesAPI: {
      getPropertyCount: (...args: any[]) => mockGetPropertyCount(...args),
    },
    deleteDataset: (...args: any[]) => mockDeleteDataset(...args),
    deleteDatasetView: (...args: any[]) => mockDeleteDatasetView(...args),
    createDatasetView: (...args: any[]) => mockCreateDatasetView(...args),
    createConfiguration: (...args: any[]) => mockCreateConfiguration(...args),
  },
}));

const mockGetFolder = vi.fn();
const mockGetCollection = vi.fn();
const mockGetConfiguration = vi.fn();

vi.mock("@/store/girderResources", () => ({
  default: {
    getFolder: (...args: any[]) => mockGetFolder(...args),
    getCollection: (...args: any[]) => mockGetCollection(...args),
    getConfiguration: (...args: any[]) => mockGetConfiguration(...args),
  },
}));

vi.mock("@/store/datasetMetadataImport", () => ({
  default: {
    hasCollectionData: false,
    collectionData: null,
    clearCollectionFile: vi.fn(),
  },
}));

vi.mock("@/store/annotation", () => ({ default: {} }));
vi.mock("@/store/properties", () => ({ default: {} }));
vi.mock("@/utils/log", () => ({ logError: vi.fn() }));

import store from "@/store";
import DatasetInfo from "./DatasetInfo.vue";

Vue.use(Vuetify);
Vue.directive("tour-trigger", {});

function mountComponent() {
  const app = document.createElement("div");
  app.setAttribute("data-app", "true");
  document.body.appendChild(app);
  return shallowMount(DatasetInfo, {
    vuetify: new Vuetify(),
    attachTo: app,
    mocks: {
      $route: {
        params: { datasetId: "ds-1", configurationId: "config-1" },
      },
      $router: { push: vi.fn(), back: vi.fn() },
    },
    stubs: {
      GirderLocationChooser: true,
      AddToProjectDialog: true,
    },
  });
}

function flushPromises() {
  return new Promise((r) => setTimeout(r, 0));
}

describe("DatasetInfo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (store as any).dataset = {
      id: "ds-1",
      name: "Test Dataset",
      description: "A test dataset",
      time: [0, 1, 2],
      xy: [0],
      z: [0, 1],
      channels: [0, 1, 2],
    };
    mockFindDatasetViews.mockResolvedValue([]);
    mockGetFolder.mockResolvedValue(null);
    mockGetCollection.mockResolvedValue(null);
    mockGetAnnotationCount.mockResolvedValue(10);
    mockGetConnectionCount.mockResolvedValue(5);
    mockGetPropertyValueCount.mockResolvedValue(100);
    mockGetPropertyCount.mockResolvedValue(3);
  });

  it("dataset computed returns store.dataset", () => {
    const wrapper = mountComponent();
    expect((wrapper.vm as any).dataset).toEqual((store as any).dataset);
    wrapper.destroy();
  });

  it("datasetName computed returns dataset name", () => {
    const wrapper = mountComponent();
    expect((wrapper.vm as any).datasetName).toBe("Test Dataset");
    wrapper.destroy();
  });

  it("datasetName returns empty string when no dataset", () => {
    (store as any).dataset = null;
    const wrapper = mountComponent();
    expect((wrapper.vm as any).datasetName).toBe("");
    wrapper.destroy();
  });

  it("datasetId computed returns dataset id", () => {
    const wrapper = mountComponent();
    expect((wrapper.vm as any).datasetId).toBe("ds-1");
    wrapper.destroy();
  });

  it("report generates correct rows", async () => {
    const wrapper = mountComponent();
    await flushPromises();
    const vm = wrapper.vm as any;
    const report = vm.report;
    expect(report).toHaveLength(10);
    expect(report[0]).toEqual({ name: "Dataset Name", value: "Test Dataset" });
    expect(report[2]).toEqual({ name: "Timepoints", value: 3 });
    expect(report[3]).toEqual({ name: "XY Slices", value: 1 });
    expect(report[4]).toEqual({ name: "Z Slices", value: 2 });
    expect(report[5]).toEqual({ name: "Channels", value: 3 });
    wrapper.destroy();
  });

  it("report shows Loading... for counts when null", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    // Before counts are fetched, they should show Loading...
    vm.annotationCount = null;
    vm.connectionCount = null;
    vm.propertyCount = null;
    vm.propertyValueCount = null;
    const report = vm.report;
    expect(report[6]).toEqual({ name: "Annotations", value: "Loading..." });
    expect(report[7]).toEqual({ name: "Connections", value: "Loading..." });
    expect(report[8]).toEqual({ name: "Properties", value: "Loading..." });
    expect(report[9]).toEqual({
      name: "Property Values",
      value: "Loading...",
    });
    wrapper.destroy();
  });

  it("nameRules validates non-empty", () => {
    const wrapper = mountComponent();
    const rules = (wrapper.vm as any).nameRules;
    expect(rules[0]("")).toBe("Name is required");
    expect(rules[0]("valid")).toBe(true);
    wrapper.destroy();
  });

  it("updateDefaultConfigurationName builds name from dataset name", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.defaultConfigurationName).toBe("Test Dataset collection");
    wrapper.destroy();
  });

  it("fetchCounts calls 4 APIs in parallel", async () => {
    const wrapper = mountComponent();
    await flushPromises();
    expect(mockGetAnnotationCount).toHaveBeenCalledWith("ds-1");
    expect(mockGetConnectionCount).toHaveBeenCalledWith("ds-1");
    expect(mockGetPropertyValueCount).toHaveBeenCalledWith("ds-1");
    wrapper.destroy();
  });

  it("fetchCounts resets when no dataset", async () => {
    (store as any).dataset = null;
    const wrapper = mountComponent();
    await flushPromises();
    const vm = wrapper.vm as any;
    expect(vm.annotationCount).toBeNull();
    expect(vm.connectionCount).toBeNull();
    wrapper.destroy();
  });

  it("toRoute constructs correct route", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const route = vm.toRoute({
      id: "view-1",
      datasetId: "ds-1",
      configurationId: "config-1",
    });
    expect(route.name).toBe("datasetview");
    expect(route.params.datasetViewId).toBe("view-1");
    expect(route.params.datasetId).toBe("ds-1");
    expect(route.params.configurationId).toBe("config-1");
    wrapper.destroy();
  });

  it("removeDataset calls deleteDataset and navigates to root", async () => {
    mockDeleteDataset.mockResolvedValue(undefined);
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.removeDataset();
    await flushPromises();
    expect(mockDeleteDataset).toHaveBeenCalledWith((store as any).dataset);
    expect(wrapper.vm.$router.push).toHaveBeenCalledWith({ name: "root" });
    wrapper.destroy();
  });

  it("openRemoveConfigurationDialog sets dialog state", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const view = { id: "view-1", configurationId: "config-1" };
    vm.openRemoveConfigurationDialog(view);
    expect(vm.removeDatasetViewConfirm).toBe(true);
    expect(vm.viewToRemove).toEqual(view);
    wrapper.destroy();
  });

  it("closeRemoveConfigurationDialog clears dialog state", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.removeDatasetViewConfirm = true;
    vm.viewToRemove = { id: "view-1" };
    vm.closeRemoveConfigurationDialog();
    expect(vm.removeDatasetViewConfirm).toBe(false);
    expect(vm.viewToRemove).toBeNull();
    wrapper.destroy();
  });

  it("datasetViewItems maps views with cached config info", async () => {
    const views = [
      { id: "view-1", datasetId: "ds-1", configurationId: "config-1" },
    ];
    mockFindDatasetViews.mockResolvedValue(views);
    const wrapper = mountComponent();
    await flushPromises();
    const vm = wrapper.vm as any;
    expect(vm.datasetViewItems).toHaveLength(1);
    expect(vm.datasetViewItems[0].datasetView.id).toBe("view-1");
    wrapper.destroy();
  });

  it("showAddToProjectDialog toggles state", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.showAddToProjectDialog).toBe(false);
    vm.showAddToProjectDialog = true;
    expect(vm.showAddToProjectDialog).toBe(true);
    wrapper.destroy();
  });

  it("removeDatasetConfirm toggles state", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.removeDatasetConfirm).toBe(false);
    vm.removeDatasetConfirm = true;
    expect(vm.removeDatasetConfirm).toBe(true);
    wrapper.destroy();
  });
});

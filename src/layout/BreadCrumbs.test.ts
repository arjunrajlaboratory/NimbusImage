import { describe, it, expect, vi, beforeEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

const mockGetDatasetView = vi.fn();
const mockFindDatasetViews = vi.fn();

vi.mock("@/store", () => ({
  default: {
    isAdmin: false,
    girderRest: {
      apiRoot: "http://localhost:8080/api/v1",
    },
    api: {
      getDatasetView: (...args: any[]) => mockGetDatasetView(...args),
      findDatasetViews: (...args: any[]) => mockFindDatasetViews(...args),
    },
  },
  girderUrlFromApiRoot: (apiRoot: string) => {
    const suffix = "/api/v1";
    if (apiRoot.endsWith(suffix)) {
      return apiRoot.slice(0, apiRoot.length - suffix.length);
    }
    return apiRoot;
  },
}));

const mockWatchCollection = vi.fn();
const mockWatchFolder = vi.fn();
const mockGetFolder = vi.fn();
const mockGetResource = vi.fn();
const mockGetUser = vi.fn();
const mockForceFetchResource = vi.fn();
const mockGetConfiguration = vi.fn();

vi.mock("@/store/girderResources", () => ({
  default: {
    watchCollection: (...args: any[]) => mockWatchCollection(...args),
    watchFolder: (...args: any[]) => mockWatchFolder(...args),
    getFolder: (...args: any[]) => mockGetFolder(...args),
    getResource: (...args: any[]) => mockGetResource(...args),
    getUser: (...args: any[]) => mockGetUser(...args),
    forceFetchResource: (...args: any[]) => mockForceFetchResource(...args),
    getConfiguration: (...args: any[]) => mockGetConfiguration(...args),
  },
}));

vi.mock("@/utils/log", () => ({
  logError: vi.fn(),
}));

vi.mock("@/components/AlertDialog.vue", () => ({
  default: {
    name: "AlertDialog",
    template: "<div></div>",
    methods: { openAlert: vi.fn() },
  },
}));

vi.mock("@/components/AddDatasetToCollection.vue", () => ({
  default: {
    name: "AddDatasetToCollection",
    template: "<div></div>",
  },
}));

import BreadCrumbs from "./BreadCrumbs.vue";
import store from "@/store";

Vue.use(Vuetify);

function mountComponent(routeParams: any = {}, routeQuery: any = {}, routeName = "home") {
  const mockRouter = { push: vi.fn() };
  const mockRoute = {
    params: routeParams,
    query: routeQuery,
    name: routeName,
  };
  return shallowMount(BreadCrumbs, {
    vuetify: new Vuetify(),
    stubs: {
      "alert-dialog": true,
      "add-dataset-to-collection": true,
      AlertDialog: true,
      AddDatasetToCollection: true,
    },
    mocks: {
      $router: mockRouter,
      $route: mockRoute,
    },
  });
}

describe("BreadCrumbs", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    (store as any).isAdmin = false;
    (store as any).girderRest = { apiRoot: "http://localhost:8080/api/v1" };
    mockGetDatasetView.mockResolvedValue({
      datasetId: "ds1",
      configurationId: "cfg1",
    });
    mockFindDatasetViews.mockResolvedValue([]);
    mockWatchCollection.mockReturnValue(null);
    mockWatchFolder.mockReturnValue(null);
    mockGetFolder.mockResolvedValue(null);
    mockGetResource.mockResolvedValue(null);
    mockGetUser.mockResolvedValue(null);
    mockForceFetchResource.mockReturnValue(undefined);
    mockGetConfiguration.mockResolvedValue(null);
  });

  // --- addDatasetFlag ---

  it("addDatasetFlag get returns false when addDatasetCollection is null", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.addDatasetFlag).toBe(false);
    wrapper.destroy();
  });

  it("addDatasetFlag get returns true when addDatasetCollection is set", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.addDatasetCollection = { _id: "cfg1", name: "Test Config" };
    expect(vm.addDatasetFlag).toBe(true);
    wrapper.destroy();
  });

  it("addDatasetFlag set to false clears addDatasetCollection", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.addDatasetCollection = { _id: "cfg1", name: "Test Config" };
    expect(vm.addDatasetFlag).toBe(true);
    vm.addDatasetFlag = false;
    expect(vm.addDatasetCollection).toBeNull();
    wrapper.destroy();
  });

  // --- showExternalLink ---

  it("showExternalLink returns false when not admin", () => {
    (store as any).isAdmin = false;
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.currentDatasetId = "ds1";
    expect(vm.showExternalLink).toBe(false);
    wrapper.destroy();
  });

  it("showExternalLink returns true when admin and datasetId is set", () => {
    (store as any).isAdmin = true;
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.currentDatasetId = "ds1";
    expect(vm.showExternalLink).toBe(true);
    wrapper.destroy();
  });

  it("showExternalLink returns false when admin but no datasetId", () => {
    (store as any).isAdmin = true;
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.currentDatasetId = null;
    expect(vm.showExternalLink).toBe(false);
    wrapper.destroy();
  });

  // --- girderDatasetUrl ---

  it("girderDatasetUrl returns null when no currentDatasetId", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.currentDatasetId = null;
    expect(vm.girderDatasetUrl).toBeNull();
    wrapper.destroy();
  });

  it("girderDatasetUrl returns null when datasetResource has no creatorId", () => {
    mockWatchFolder.mockReturnValue({ name: "Test" });
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.currentDatasetId = "ds1";
    expect(vm.girderDatasetUrl).toBeNull();
    wrapper.destroy();
  });

  it("girderDatasetUrl constructs correct URL when datasetResource has creatorId", () => {
    mockWatchFolder.mockReturnValue({
      name: "Test",
      creatorId: "creator1",
    });
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.currentDatasetId = "ds1";
    expect(vm.girderDatasetUrl).toBe(
      "http://localhost:8080/#user/creator1/folder/ds1",
    );
    wrapper.destroy();
  });

  // --- openGirderFolder ---

  it("openGirderFolder opens window when girderDatasetUrl is available", () => {
    mockWatchFolder.mockReturnValue({
      name: "Test",
      creatorId: "creator1",
    });
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.currentDatasetId = "ds1";
    vm.openGirderFolder();
    expect(openSpy).toHaveBeenCalledWith(
      "http://localhost:8080/#user/creator1/folder/ds1",
      "_blank",
    );
    openSpy.mockRestore();
    wrapper.destroy();
  });

  it("openGirderFolder does nothing when girderDatasetUrl is null", () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.currentDatasetId = null;
    vm.openGirderFolder();
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
    wrapper.destroy();
  });

  // --- getCurrentViewItem ---

  it("getCurrentViewItem returns matching subitem", () => {
    const wrapper = mountComponent({ datasetViewId: "v1" });
    const vm = wrapper.vm as any;
    const subitems = [
      { text: "Dataset A", value: "v1" },
      { text: "Dataset B", value: "v2" },
    ];
    const result = vm.getCurrentViewItem(subitems);
    expect(result).toEqual({ text: "Dataset A", value: "v1" });
    wrapper.destroy();
  });

  it("getCurrentViewItem returns null when no datasetViewId in route", () => {
    const wrapper = mountComponent({});
    const vm = wrapper.vm as any;
    const subitems = [{ text: "Dataset A", value: "v1" }];
    expect(vm.getCurrentViewItem(subitems)).toBeNull();
    wrapper.destroy();
  });

  it("getCurrentViewItem returns null when subitems is null/undefined", () => {
    const wrapper = mountComponent({ datasetViewId: "v1" });
    const vm = wrapper.vm as any;
    expect(vm.getCurrentViewItem(null)).toBeNull();
    expect(vm.getCurrentViewItem(undefined)).toBeNull();
    wrapper.destroy();
  });

  it("getCurrentViewItem returns null when no match found", () => {
    const wrapper = mountComponent({ datasetViewId: "v999" });
    const vm = wrapper.vm as any;
    const subitems = [{ text: "Dataset A", value: "v1" }];
    expect(vm.getCurrentViewItem(subitems)).toBeNull();
    wrapper.destroy();
  });

  // --- goToView ---

  it("goToView pushes to datasetview route", () => {
    const wrapper = mountComponent({}, { foo: "bar" });
    const vm = wrapper.vm as any;
    vm.goToView("view123");
    expect(vm.$router.push).toHaveBeenCalledWith({
      name: "datasetview",
      params: { datasetViewId: "view123" },
      query: { foo: "bar" },
    });
    wrapper.destroy();
  });

  it("goToView skips push when datasetViewId matches current", () => {
    const wrapper = mountComponent({ datasetViewId: "view123" });
    const vm = wrapper.vm as any;
    vm.goToView("view123");
    expect(vm.$router.push).not.toHaveBeenCalled();
    wrapper.destroy();
  });

  // --- refreshItems ---

  it("refreshItems builds items array with dataset and configuration", async () => {
    mockWatchFolder.mockReturnValue({ name: "My Dataset" });
    mockWatchCollection.mockReturnValue({ name: "My Collection" });
    mockGetFolder.mockResolvedValue({ name: "My Dataset", creatorId: "u1" });
    const wrapper = mountComponent(
      { datasetId: "ds1", configurationId: "cfg1" },
      {},
      "dataset",
    );
    const vm = wrapper.vm as any;
    await vm.refreshItems(true);
    const itemTitles = vm.items.map((i: any) => i.title);
    expect(itemTitles).toContain("Dataset:");
    expect(itemTitles).toContain("Collection:");
    wrapper.destroy();
  });

  it("refreshItems builds owner item when folder has creatorId", async () => {
    mockWatchFolder.mockReturnValue({ name: "My Dataset" });
    mockGetFolder.mockResolvedValue({ name: "My Dataset", creatorId: "u1" });
    const wrapper = mountComponent(
      { datasetId: "ds1" },
      {},
      "dataset",
    );
    const vm = wrapper.vm as any;
    await vm.refreshItems(true);
    const itemTitles = vm.items.map((i: any) => i.title);
    expect(itemTitles).toContain("Owner:");
    wrapper.destroy();
  });

  it("refreshItems deduplicates when called with same params and not forced", async () => {
    mockWatchFolder.mockReturnValue({ name: "My Dataset" });
    mockGetFolder.mockResolvedValue({ name: "My Dataset" });
    const wrapper = mountComponent(
      { datasetId: "ds1" },
      {},
      "dataset",
    );
    const vm = wrapper.vm as any;
    await vm.refreshItems(true);
    const initialCallCount = mockGetFolder.mock.calls.length;
    await vm.refreshItems(false);
    // Should not have called getFolder again since params are the same
    expect(mockGetFolder.mock.calls.length).toBe(initialCallCount);
    wrapper.destroy();
  });

  it("refreshItems forces refresh even when params are the same", async () => {
    mockWatchFolder.mockReturnValue({ name: "My Dataset" });
    mockGetFolder.mockResolvedValue({ name: "My Dataset" });
    const wrapper = mountComponent(
      { datasetId: "ds1" },
      {},
      "dataset",
    );
    const vm = wrapper.vm as any;
    await vm.refreshItems(true);
    const initialCallCount = mockGetFolder.mock.calls.length;
    await vm.refreshItems(true);
    // Should have called getFolder again since force=true
    expect(mockGetFolder.mock.calls.length).toBeGreaterThan(initialCallCount);
    wrapper.destroy();
  });

  // --- addedDatasets ---

  it("addedDatasets navigates to first dataset view", async () => {
    mockWatchFolder.mockReturnValue(null);
    mockGetFolder.mockResolvedValue(null);
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.addedDatasets(["ds1"], [{ id: "view1", datasetId: "ds1", configurationId: "cfg1" }]);
    expect(vm.$router.push).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "datasetview",
        params: { datasetViewId: "view1" },
      }),
    );
    wrapper.destroy();
  });

  // --- datasetId computed ---

  it("datasetId returns promise of paramsId when present", async () => {
    const wrapper = mountComponent({ datasetId: "ds1" });
    const vm = wrapper.vm as any;
    const result = await vm.datasetId;
    expect(result).toBe("ds1");
    wrapper.destroy();
  });

  it("datasetId returns null when no params or query", () => {
    const wrapper = mountComponent({}, {});
    const vm = wrapper.vm as any;
    // No datasetViewId either, so datasetView is null
    expect(vm.datasetId).toBeNull();
    wrapper.destroy();
  });

  it("datasetId uses query.datasetId when no params", async () => {
    const wrapper = mountComponent({}, { datasetId: "ds-from-query" });
    const vm = wrapper.vm as any;
    const result = await vm.datasetId;
    expect(result).toBe("ds-from-query");
    wrapper.destroy();
  });

  // --- configurationId computed ---

  it("configurationId returns promise of paramsId when no datasetView", async () => {
    const wrapper = mountComponent({ configurationId: "cfg1" });
    const vm = wrapper.vm as any;
    const result = await vm.configurationId;
    expect(result).toBe("cfg1");
    wrapper.destroy();
  });

  it("configurationId returns null when no route params or query", () => {
    const wrapper = mountComponent({}, {});
    const vm = wrapper.vm as any;
    expect(vm.configurationId).toBeNull();
    wrapper.destroy();
  });
});

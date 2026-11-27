import { describe, it, expect, vi, beforeEach } from "vitest";
import { flushPromises, shallowMount } from "@vue/test-utils";

const mockGetDatasetView = vi.fn();
const mockFindDatasetViews = vi.fn();
// Stands in for the store's REST client token, which the real
// fetchDatasetView reads synchronously (reactively) to key its request.
const restSession = vi.hoisted(() => ({ state: null as any }));

vi.mock("@/store", async () => {
  const { reactive } = await import("vue");
  restSession.state = reactive({ token: "token-1" });
  return {
    default: {
      isAdmin: false,
      girderRest: {
        apiRoot: "http://localhost:8080/api/v1",
      },
      api: {
        getDatasetView: (...args: any[]) => mockGetDatasetView(...args),
        findDatasetViews: (...args: any[]) => mockFindDatasetViews(...args),
      },
      setDatasetViewId: vi.fn(),
      // The store's shared view read (one GET with the viewer's own load)
      fetchDatasetView: (...args: any[]) => {
        void restSession.state.token;
        return mockGetDatasetView(...args);
      },
    },
    girderUrlFromApiRoot: (apiRoot: string) => {
      const suffix = "/api/v1";
      if (apiRoot.endsWith(suffix)) {
        return apiRoot.slice(0, apiRoot.length - suffix.length);
      }
      return apiRoot;
    },
  };
});

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

import { routeProvider, routerProvider } from "@/test/helpers";
import BreadCrumbs from "./BreadCrumbs.vue";
import store from "@/store";

const mockRouter = { push: vi.fn() };

function mountComponent(
  routeParams: any = {},
  routeQuery: any = {},
  routeName = "home",
) {
  return shallowMount(BreadCrumbs, {
    global: {
      stubs: {
        "alert-dialog": true,
        "add-dataset-to-collection": true,
        AlertDialog: true,
        AddDatasetToCollection: true,
      },
      provide: {
        ...routeProvider({
          params: routeParams,
          query: routeQuery,
          name: routeName,
        }),
        ...routerProvider(mockRouter),
      },
    },
  });
}

describe("BreadCrumbs", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockRouter.push = vi.fn();
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
  });

  it("addDatasetFlag get returns true when addDatasetCollection is set", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.addDatasetCollection = { _id: "cfg1", name: "Test Config" };
    expect(vm.addDatasetFlag).toBe(true);
  });

  it("addDatasetFlag set to false clears addDatasetCollection", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.addDatasetCollection = { _id: "cfg1", name: "Test Config" };
    expect(vm.addDatasetFlag).toBe(true);
    vm.addDatasetFlag = false;
    expect(vm.addDatasetCollection).toBeNull();
  });

  // --- showExternalLink ---

  it("showExternalLink returns false when not admin", () => {
    (store as any).isAdmin = false;
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.currentDatasetId = "ds1";
    expect(vm.showExternalLink).toBe(false);
  });

  it("showExternalLink returns true when admin and datasetId is set", () => {
    (store as any).isAdmin = true;
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.currentDatasetId = "ds1";
    expect(vm.showExternalLink).toBe(true);
  });

  it("showExternalLink returns false when admin but no datasetId", () => {
    (store as any).isAdmin = true;
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.currentDatasetId = null;
    expect(vm.showExternalLink).toBe(false);
  });

  // --- girderDatasetUrl ---

  it("girderDatasetUrl returns null when no currentDatasetId", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.currentDatasetId = null;
    expect(vm.girderDatasetUrl).toBeNull();
  });

  it("girderDatasetUrl returns null when datasetResource has no creatorId", () => {
    mockWatchFolder.mockReturnValue({ name: "Test" });
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.currentDatasetId = "ds1";
    expect(vm.girderDatasetUrl).toBeNull();
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
  });

  it("openGirderFolder does nothing when girderDatasetUrl is null", () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.currentDatasetId = null;
    vm.openGirderFolder();
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
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
  });

  it("getCurrentViewItem returns null when no datasetViewId in route", () => {
    const wrapper = mountComponent({});
    const vm = wrapper.vm as any;
    const subitems = [{ text: "Dataset A", value: "v1" }];
    expect(vm.getCurrentViewItem(subitems)).toBeNull();
  });

  it("getCurrentViewItem returns null when subitems is null/undefined", () => {
    const wrapper = mountComponent({ datasetViewId: "v1" });
    const vm = wrapper.vm as any;
    expect(vm.getCurrentViewItem(null)).toBeNull();
    expect(vm.getCurrentViewItem(undefined)).toBeNull();
  });

  it("getCurrentViewItem returns null when no match found", () => {
    const wrapper = mountComponent({ datasetViewId: "v999" });
    const vm = wrapper.vm as any;
    const subitems = [{ text: "Dataset A", value: "v1" }];
    expect(vm.getCurrentViewItem(subitems)).toBeNull();
  });

  // --- goToView ---

  it("goToView pushes to datasetview route", () => {
    const wrapper = mountComponent({}, { foo: "bar" });
    const vm = wrapper.vm as any;
    vm.goToView("view123");
    expect(mockRouter.push).toHaveBeenCalledWith({
      name: "datasetview",
      params: { datasetViewId: "view123" },
      query: { foo: "bar" },
    });
  });

  it("goToView keeps the location but drops a camera deep link", () => {
    const wrapper = mountComponent(
      {},
      { xy: "1", z: "2", x: "100", y: "200", zoom: "6" },
    );
    const vm = wrapper.vm as any;
    vm.goToView("view123");
    expect(mockRouter.push).toHaveBeenCalledWith({
      name: "datasetview",
      params: { datasetViewId: "view123" },
      query: { xy: "1", z: "2" },
    });
  });

  it("goToView skips push when datasetViewId matches current", () => {
    const wrapper = mountComponent({ datasetViewId: "view123" });
    const vm = wrapper.vm as any;
    vm.goToView("view123");
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  // --- refreshItems ---

  it("refreshItems builds dataset item and stores collection in ref when dataset exists", async () => {
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
    // Collection is now in the ref, not in items
    expect(itemTitles).not.toContain("Collection:");
    expect(vm.collectionDisplayName).toBe("My Collection");
  });

  it("refreshItems keeps collection inline when no dataset (configuration-only route)", async () => {
    mockWatchCollection.mockReturnValue({ name: "My Collection" });
    const wrapper = mountComponent(
      { configurationId: "cfg1" },
      {},
      "configuration",
    );
    const vm = wrapper.vm as any;
    await vm.refreshItems(true);
    const itemTitles = vm.items.map((i: any) => i.title);
    expect(itemTitles).toContain("Collection:");
  });

  it("refreshItems sets ownerDisplayName when folder has creatorId", async () => {
    mockWatchFolder.mockReturnValue({ name: "My Dataset" });
    mockGetFolder.mockResolvedValue({ name: "My Dataset", creatorId: "u1" });
    mockGetUser.mockResolvedValue({
      firstName: "John",
      lastName: "Doe",
      email: "john@example.com",
    });
    const wrapper = mountComponent({ datasetId: "ds1" }, {}, "dataset");
    const vm = wrapper.vm as any;
    await vm.refreshItems(true);
    // Owner is no longer in items
    const itemTitles = vm.items.map((i: any) => i.title);
    expect(itemTitles).not.toContain("Owner:");
    // Wait for the async getUser call
    await new Promise((r) => setTimeout(r, 0));
    expect(vm.ownerDisplayName).toBe("John Doe (john@example.com)");
  });

  it("refreshItems shows the owner's login when their email is hidden", async () => {
    mockWatchFolder.mockReturnValue({ name: "My Dataset" });
    mockGetFolder.mockResolvedValue({ name: "My Dataset", creatorId: "u1" });
    // GET user/{id} omits another user's email unless the caller is an admin.
    mockGetUser.mockResolvedValue({
      firstName: "John",
      lastName: "Doe",
      login: "jdoe",
    });
    const wrapper = mountComponent({ datasetId: "ds1" }, {}, "dataset");
    const vm = wrapper.vm as any;
    await vm.refreshItems(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(vm.ownerDisplayName).toBe("John Doe (jdoe)");
  });

  it("refreshItems deduplicates when called with same params and not forced", async () => {
    mockWatchFolder.mockReturnValue({ name: "My Dataset" });
    mockGetFolder.mockResolvedValue({ name: "My Dataset" });
    const wrapper = mountComponent({ datasetId: "ds1" }, {}, "dataset");
    const vm = wrapper.vm as any;
    await vm.refreshItems(true);
    const initialCallCount = mockGetFolder.mock.calls.length;
    await vm.refreshItems(false);
    // Should not have called getFolder again since params are the same
    expect(mockGetFolder.mock.calls.length).toBe(initialCallCount);
  });

  it("refreshItems forces refresh even when params are the same", async () => {
    mockWatchFolder.mockReturnValue({ name: "My Dataset" });
    mockGetFolder.mockResolvedValue({ name: "My Dataset" });
    const wrapper = mountComponent({ datasetId: "ds1" }, {}, "dataset");
    const vm = wrapper.vm as any;
    await vm.refreshItems(true);
    const initialCallCount = mockGetFolder.mock.calls.length;
    await vm.refreshItems(true);
    // Should have called getFolder again since force=true
    expect(mockGetFolder.mock.calls.length).toBeGreaterThan(initialCallCount);
  });

  it("does not refetch the view when the session token changes", async () => {
    mockGetDatasetView.mockClear();
    mountComponent({ datasetViewId: "v1" }, {}, "datasetview");
    await flushPromises();
    expect(mockGetDatasetView).toHaveBeenCalledTimes(1);
    // A logout (or login) changes the token while the route stays put.
    restSession.state.token = "token-2";
    await flushPromises();
    expect(mockGetDatasetView).toHaveBeenCalledTimes(1);
  });

  it("fetches the next view when the route moves to it", async () => {
    mockGetDatasetView.mockClear();
    const route = routeProvider({
      params: { datasetViewId: "v1" },
      name: "datasetview",
    });
    shallowMount(BreadCrumbs, {
      global: {
        stubs: { AlertDialog: true, AddDatasetToCollection: true },
        provide: { ...route, ...routerProvider(mockRouter) },
      },
    });
    await flushPromises();
    const reactiveRoute = Object.getOwnPropertySymbols(route).map(
      (key) => (route as any)[key],
    )[0];
    reactiveRoute.params = { datasetViewId: "v2" };
    await flushPromises();
    expect(mockGetDatasetView.mock.calls.map(([id]) => id)).toEqual([
      "v1",
      "v2",
    ]);
  });

  describe("moving between views", () => {
    function mountAtView(datasetViewId: string) {
      const route = routeProvider({
        params: { datasetViewId },
        name: "datasetview",
      });
      const wrapper = shallowMount(BreadCrumbs, {
        global: {
          stubs: { AlertDialog: true, AddDatasetToCollection: true },
          provide: { ...route, ...routerProvider(mockRouter) },
        },
      });
      const reactiveRoute = Object.getOwnPropertySymbols(route).map(
        (key) => (route as any)[key],
      )[0];
      return {
        vm: wrapper.vm as any,
        goTo: (id: string) => {
          reactiveRoute.params = { datasetViewId: id };
        },
      };
    }

    function deferred<T>() {
      let resolve!: (value: T) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    const views: Record<string, any> = {
      v1: { datasetId: "ds1", configurationId: "cfg1" },
      v2: { datasetId: "ds2", configurationId: "cfg2" },
    };

    beforeEach(() => {
      mockWatchFolder.mockImplementation((id: string) => ({
        name: `Dataset ${id}`,
      }));
    });

    it("keeps the newer view's breadcrumbs when the older view's fetch lands last", async () => {
      const slowV1 = deferred<any>();
      mockGetDatasetView.mockImplementation((id: string) =>
        id === "v1" ? slowV1.promise : Promise.resolve(views[id]),
      );
      const { vm, goTo } = mountAtView("v1");
      goTo("v2");
      await flushPromises();
      expect(vm.currentDatasetId).toBe("ds2");

      slowV1.resolve(views.v1);
      await flushPromises();

      expect(vm.currentDatasetId).toBe("ds2");
      expect(vm.currentConfigurationId).toBe("cfg2");
      expect(vm.items.map((item: any) => item.text)).toEqual(["Dataset ds2"]);
    });

    it("clears the previous view's breadcrumbs when the next view cannot be fetched", async () => {
      mockGetDatasetView.mockImplementation((id: string) =>
        id === "v1"
          ? Promise.resolve(views.v1)
          : Promise.reject(new Error("403")),
      );
      const { vm, goTo } = mountAtView("v1");
      await flushPromises();
      expect(vm.currentDatasetId).toBe("ds1");

      goTo("v2");
      await flushPromises();

      expect(vm.currentDatasetId).toBeNull();
      expect(vm.currentConfigurationId).toBeNull();
      expect(vm.items).toEqual([]);

      // A return to the first view shows it again
      goTo("v1");
      await flushPromises();
      expect(vm.currentDatasetId).toBe("ds1");
      expect(vm.items.map((item: any) => item.text)).toEqual(["Dataset ds1"]);
    });

    it("shows a view again on return when its first refresh gave way", async () => {
      mockGetDatasetView.mockImplementation((id: string) =>
        id === "v2" ? new Promise(() => {}) : Promise.resolve(views[id]),
      );
      const slowFolder = deferred<any>();
      mockGetFolder.mockReturnValueOnce(slowFolder.promise);
      const { vm, goTo } = mountAtView("v1");
      await flushPromises();
      // The first refresh of v1 waits on its folder while the user leaves
      // and comes back
      goTo("v2");
      await flushPromises();
      goTo("v1");
      slowFolder.resolve(null);
      await flushPromises();

      expect(vm.currentDatasetId).toBe("ds1");
      expect(vm.items.map((item: any) => item.text)).toEqual(["Dataset ds1"]);
    });
  });

  it("refreshItems resolves when the view cannot be fetched", async () => {
    mockGetDatasetView.mockRejectedValue(new Error("403"));
    const wrapper = mountComponent({ datasetViewId: "v1" }, {}, "datasetview");
    const vm = wrapper.vm as any;
    await expect(vm.refreshItems(true)).resolves.toBeUndefined();
    expect(vm.items).toEqual([]);
  });

  // --- addedDatasets ---

  it("addedDatasets sets dataset view in store", async () => {
    mockWatchFolder.mockReturnValue(null);
    mockGetFolder.mockResolvedValue(null);
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const { default: store } = await import("@/store");
    vm.addedDatasets(
      ["ds1"],
      [{ id: "view1", datasetId: "ds1", configurationId: "cfg1" }],
    );
    expect(store.setDatasetViewId).toHaveBeenCalledWith({ id: "view1" });
  });

  // --- datasetId computed ---

  it("datasetId returns promise of paramsId when present", async () => {
    const wrapper = mountComponent({ datasetId: "ds1" });
    const vm = wrapper.vm as any;
    const result = await vm.datasetId;
    expect(result).toBe("ds1");
  });

  it("datasetId returns null when no params or query", () => {
    const wrapper = mountComponent({}, {});
    const vm = wrapper.vm as any;
    // No datasetViewId either, so datasetView is null
    expect(vm.datasetId).toBeNull();
  });

  it("datasetId uses query.datasetId when no params", async () => {
    const wrapper = mountComponent({}, { datasetId: "ds-from-query" });
    const vm = wrapper.vm as any;
    const result = await vm.datasetId;
    expect(result).toBe("ds-from-query");
  });

  // --- configurationId computed ---

  it("configurationId returns promise of paramsId when no datasetView", async () => {
    const wrapper = mountComponent({ configurationId: "cfg1" });
    const vm = wrapper.vm as any;
    const result = await vm.configurationId;
    expect(result).toBe("cfg1");
  });

  it("configurationId returns null when no route params or query", () => {
    const wrapper = mountComponent({}, {});
    const vm = wrapper.vm as any;
    expect(vm.configurationId).toBeNull();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { shallowMount } from "@vue/test-utils";

const mockFindDatasetViews = vi.fn();
const mockRenameConfiguration = vi.fn();
const mockDeleteDatasetView = vi.fn();
const mockDeleteConfiguration = vi.fn();
const mockWatchCollection = vi.fn();
const mockGetFolder = vi.fn();
const mockGetDataset = vi.fn();

vi.mock("@/store", () => ({
  default: {
    configuration: {
      id: "config-1",
      name: "Test Config",
      description: "A test configuration",
      compatibility: null,
    },
    layers: [
      {
        name: "Layer 1",
        color: "#ff0000",
        visible: true,
        channel: 0,
        z: { type: "current", value: 0 },
        time: { type: "current", value: 0 },
      },
    ],
    api: {
      findDatasetViews: (...args: any[]) => mockFindDatasetViews(...args),
    },
    renameConfiguration: (...args: any[]) => mockRenameConfiguration(...args),
    deleteDatasetView: (...args: any[]) => mockDeleteDatasetView(...args),
    deleteConfiguration: (...args: any[]) => mockDeleteConfiguration(...args),
  },
}));

vi.mock("@/store/girderResources", () => ({
  default: {
    watchCollection: (...args: any[]) => mockWatchCollection(...args),
    getFolder: (...args: any[]) => mockGetFolder(...args),
    getDataset: (...args: any[]) => mockGetDataset(...args),
  },
}));

vi.mock("@/store/GirderAPI", () => ({
  getDatasetCompatibility: vi.fn(),
}));

vi.mock("@/store/model", async () => {
  const actual = await vi.importActual("@/store/model");
  return {
    ...actual,
    areCompatibles: vi.fn().mockReturnValue(true),
  };
});

vi.mock("@/store/annotation", () => ({ default: {} }));
vi.mock("@/store/properties", () => ({ default: {} }));

import { routeProvider, routerProvider } from "@/test/helpers";
import store from "@/store";
import ConfigurationInfo from "./ConfigurationInfo.vue";

const mockRouter = { back: vi.fn(), push: vi.fn() };

function mountComponent() {
  const app = document.createElement("div");
  app.setAttribute("data-app", "true");
  document.body.appendChild(app);
  return shallowMount(ConfigurationInfo, {
    attachTo: app,
    global: {
      provide: {
        ...routeProvider({
          params: { configurationId: "config-1", datasetId: "ds-1" },
        }),
        ...routerProvider(mockRouter),
      },
      stubs: {
        AlertDialog: true,
        ScaleSettings: true,
        AddDatasetToCollection: true,
        AddCollectionToProjectDialog: true,
      },
    },
  });
}

function flushPromises() {
  return new Promise((r) => setTimeout(r, 0));
}

describe("ConfigurationInfo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (store as any).configuration = {
      id: "config-1",
      name: "Test Config",
      description: "A test configuration",
      compatibility: null,
    };
    (store as any).layers = [
      {
        name: "Layer 1",
        color: "#ff0000",
        visible: true,
        channel: 0,
        z: { type: "current", value: 0 },
        time: { type: "current", value: 0 },
      },
    ];
    mockFindDatasetViews.mockResolvedValue([]);
    mockWatchCollection.mockReturnValue(null);
    mockGetFolder.mockResolvedValue(null);
    mockGetDataset.mockResolvedValue(null);
  });

  it("name computed returns from girderResources.watchCollection", () => {
    mockWatchCollection.mockReturnValue({ name: "Cached Name" });
    const wrapper = mountComponent();
    expect((wrapper.vm as any).name).toBe("Cached Name");
  });

  it("name computed falls back to store.configuration.name", () => {
    mockWatchCollection.mockReturnValue(null);
    const wrapper = mountComponent();
    expect((wrapper.vm as any).name).toBe("Test Config");
  });

  it("name returns empty string when no configuration", () => {
    (store as any).configuration = null;
    const wrapper = mountComponent();
    expect((wrapper.vm as any).name).toBe("");
  });

  it("description computed returns configuration description", () => {
    const wrapper = mountComponent();
    expect((wrapper.vm as any).description).toBe("A test configuration");
  });

  it("layers computed returns store layers", () => {
    const wrapper = mountComponent();
    expect((wrapper.vm as any).layers).toHaveLength(1);
    expect((wrapper.vm as any).layers[0].name).toBe("Layer 1");
  });

  it("datasetViewItems maps views with cached config info", async () => {
    const views = [
      { id: "view-1", datasetId: "ds-1", configurationId: "config-1" },
      { id: "view-2", datasetId: "ds-2", configurationId: "config-1" },
    ];
    mockFindDatasetViews.mockResolvedValue(views);
    const wrapper = mountComponent();
    await flushPromises();
    const vm = wrapper.vm as any;
    expect(vm.datasetViewItems).toHaveLength(2);
    expect(vm.datasetViewItems[0].datasetView.id).toBe("view-1");
    expect(vm.datasetViewItems[1].datasetView.id).toBe("view-2");
  });

  it("tryRename calls store when name differs", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.nameInput = "New Name";
    vm.tryRename();
    expect(mockRenameConfiguration).toHaveBeenCalledWith("New Name");
  });

  it("tryRename no-ops when name is same", () => {
    mockWatchCollection.mockReturnValue(null);
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.nameInput = "Test Config";
    vm.tryRename();
    expect(mockRenameConfiguration).not.toHaveBeenCalled();
  });

  it("tryRename no-ops when name is empty", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.nameInput = "";
    vm.tryRename();
    expect(mockRenameConfiguration).not.toHaveBeenCalled();
  });

  it("toSlice formats current slice", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.toSlice({ type: "current", value: 0 })).toBe("Current");
  });

  it("toSlice formats constant slice", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.toSlice({ type: "constant", value: 5 })).toBe("5");
  });

  it("toSlice formats max-merge slice", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.toSlice({ type: "max-merge", value: 0 })).toBe("Max Merge");
  });

  it("toSlice formats offset slice", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.toSlice({ type: "offset", value: 3 })).toBe("Offset by 3");
  });

  it("toRoute builds correct route from $route.params", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const route = vm.toRoute({
      id: "view-1",
      datasetId: "ds-1",
      configurationId: "config-1",
    });
    expect(route.name).toBe("datasetview");
    expect(route.params.datasetViewId).toBe("view-1");
    expect(route.params.configurationId).toBe("config-1");
  });

  it("openRemoveDatasetDialog sets dialog state", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const view = { id: "view-1", datasetId: "ds-1" };
    vm.openRemoveDatasetDialog(view);
    expect(vm.removeDatasetViewConfirm).toBe(true);
    expect(vm.viewToRemove).toEqual(view);
  });

  it("closeRemoveDatasetDialog clears dialog state", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.removeDatasetViewConfirm = true;
    vm.viewToRemove = { id: "view-1" };
    vm.closeRemoveDatasetDialog();
    expect(vm.removeDatasetViewConfirm).toBe(false);
    expect(vm.viewToRemove).toBeNull();
  });

  it("remove calls deleteConfiguration and $router.back()", async () => {
    mockDeleteConfiguration.mockResolvedValue(undefined);
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.remove();
    await flushPromises();
    expect(mockDeleteConfiguration).toHaveBeenCalledWith(
      (store as any).configuration,
    );
    expect(mockRouter.back).toHaveBeenCalled();
  });

  it("removeConfirm dialog toggles state", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.removeConfirm).toBe(false);
    vm.removeConfirm = true;
    expect(vm.removeConfirm).toBe(true);
  });

  it("showAddToProjectDialog toggles state", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.showAddToProjectDialog).toBe(false);
    vm.showAddToProjectDialog = true;
    expect(vm.showAddToProjectDialog).toBe(true);
  });
});

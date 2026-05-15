import { describe, it, expect, vi, beforeEach } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";

vi.mock("@/store", () => ({
  default: {
    dataset: { id: "ds-1", name: "Test Dataset" },
    selectedDatasetId: "ds-1",
    setSelectedDataset: vi.fn().mockResolvedValue(undefined),
    girderUser: {
      _id: "user-1",
      _modelType: "user",
      login: "user",
      name: "user",
    },
    api: {
      getUserPrivateFolder: vi.fn().mockResolvedValue({
        _id: "private-folder",
        name: "Private",
        _modelType: "folder",
      }),
    },
    createDatasetView: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/store/girderResources", () => ({
  default: {
    getFolder: vi.fn().mockResolvedValue({
      _id: "folder-1",
      name: "Test Folder",
      parentId: "parent-1",
      _modelType: "folder",
    }),
  },
}));

import { routeProvider, routerProvider } from "@/test/helpers";
import store from "@/store";
import ImportConfiguration from "./ImportConfiguration.vue";

const mockRouter = { back: vi.fn() };

function mountComponent(routeQuery = {}) {
  return mount(ImportConfiguration, {
    global: {
      provide: {
        ...routeProvider({ query: routeQuery }),
        ...routerProvider(mockRouter),
      },
      stubs: {
        CollectionNavigator: true,
      },
    },
  });
}

describe("ImportConfiguration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("datasetName returns name", () => {
    const wrapper = mountComponent();
    expect((wrapper.vm as any).datasetName).toBe("Test Dataset");
  });

  it("cancel calls router.back", () => {
    const wrapper = mountComponent();
    (wrapper.vm as any).cancel();
    expect(mockRouter.back).toHaveBeenCalled();
  });

  it("does not replace a user-selected folder during reinitialization", async () => {
    const wrapper = mountComponent();
    await flushPromises();

    const userFolder = {
      _id: "user-folder",
      name: "User Folder",
      _modelType: "folder",
    };

    (wrapper.vm as any).onNavigatorLocationUpdate(userFolder);
    await (wrapper.vm as any).initializeSelectedFolder({
      replaceDefault: true,
    });

    expect((wrapper.vm as any).selectedFolder).toEqual(userFolder);
    expect((wrapper.vm as any).selectedFolderSource).toBe("user");
  });

  it("submit calls createDatasetView for each configuration", async () => {
    const wrapper = mountComponent();
    const configs = [
      { id: "c1", name: "Config1" },
      { id: "c2", name: "Config2" },
    ];
    await (wrapper.vm as any).submit(configs);
    expect(store.createDatasetView).toHaveBeenCalledTimes(2);
    expect(store.createDatasetView).toHaveBeenCalledWith({
      configurationId: "c1",
      datasetId: "ds-1",
    });
  });
});

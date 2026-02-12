import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

vi.mock("@/store", () => ({
  default: {
    dataset: { id: "ds-1", name: "Test Dataset" },
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

import store from "@/store";
import ImportConfiguration from "./ImportConfiguration.vue";

Vue.use(Vuetify);

function mountComponent(routeQuery = {}) {
  return mount(ImportConfiguration, {
    vuetify: new Vuetify(),
    mocks: {
      $route: { query: routeQuery },
      $router: { back: vi.fn() },
    },
    stubs: {
      ConfigurationSelect: true,
      GirderLocationChooser: true,
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
    expect(wrapper.vm.$router.back).toHaveBeenCalled();
  });

  it("folderId derives from selectedFolder", async () => {
    const wrapper = mountComponent();
    (wrapper.vm as any).selectedFolder = {
      _id: "folder-abc",
      name: "Abc",
      _modelType: "folder",
    };
    expect((wrapper.vm as any).folderId).toBe("folder-abc");
  });

  it("folderId falls back to route query", () => {
    const wrapper = mountComponent({ folderId: "query-folder" });
    expect((wrapper.vm as any).folderId).toBe("query-folder");
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

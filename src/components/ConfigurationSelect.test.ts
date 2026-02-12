import { describe, it, expect, vi, beforeEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

const mockFindDatasetViews = vi.fn();
const mockGetAllConfigurations = vi.fn();
const mockSetSelectedDataset = vi.fn();

let mockDataset: any = {
  id: "ds1",
  name: "Test Dataset",
  channels: [{ channel: 0, frameIndex: 0 }],
};

vi.mock("@/store", () => {
  const findDatasetViews = (...args: any[]) => mockFindDatasetViews(...args);
  const getAllConfigurations = (...args: any[]) =>
    mockGetAllConfigurations(...args);
  const setSelectedDataset = (...args: any[]) =>
    mockSetSelectedDataset(...args);
  return {
    default: {
      get dataset() {
        return mockDataset;
      },
      selectedDatasetId: "ds1",
      setSelectedDataset,
      api: {
        findDatasetViews,
        getAllConfigurations,
      },
    },
  };
});

vi.mock("@/store/model", () => ({
  areCompatibles: vi.fn(
    (confCompat: any, dsCompat: any) =>
      confCompat?.channels === dsCompat?.channels,
  ),
}));

vi.mock("@/store/GirderAPI", () => ({
  getDatasetCompatibility: vi.fn((ds: any) => ({
    channels: ds.channels?.length ?? 0,
  })),
}));

vi.mock("@/utils/useRouteMapper", () => ({
  useRouteMapper: vi.fn(),
}));

vi.mock("@/utils/log", () => ({
  logError: vi.fn(),
}));

import ConfigurationSelect from "./ConfigurationSelect.vue";

Vue.use(Vuetify);

function mountComponent(props = {}) {
  return shallowMount(ConfigurationSelect, {
    vuetify: new Vuetify(),
    propsData: {
      ...props,
    },
  });
}

describe("ConfigurationSelect", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockFindDatasetViews.mockReset();
    mockGetAllConfigurations.mockReset();
  });

  it("updateCompatibleConfigurations fetches and filters correctly", async () => {
    mockFindDatasetViews.mockResolvedValue([
      { configurationId: "conf-linked" },
    ]);
    mockGetAllConfigurations.mockResolvedValue([
      {
        id: "conf-linked",
        name: "Linked Config",
        description: "Already linked",
        compatibility: { channels: 1 },
      },
      {
        id: "conf-compatible",
        name: "Compatible Config",
        description: "Not linked, compatible",
        compatibility: { channels: 1 },
      },
      {
        id: "conf-incompatible",
        name: "Incompatible Config",
        description: "Not linked, incompatible",
        compatibility: { channels: 5 },
      },
    ]);

    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    await vm.updateCompatibleConfigurations();

    expect(mockFindDatasetViews).toHaveBeenCalledWith({ datasetId: "ds1" });
    expect(mockGetAllConfigurations).toHaveBeenCalledWith(undefined);
    // conf-linked is excluded (already linked), conf-incompatible is excluded (not compatible)
    expect(vm.compatibleConfigurations).toHaveLength(1);
    expect(vm.compatibleConfigurations[0].id).toBe("conf-compatible");
    wrapper.destroy();
  });

  it("updateCompatibleConfigurations passes folderId to getAllConfigurations", async () => {
    mockFindDatasetViews.mockResolvedValue([]);
    mockGetAllConfigurations.mockResolvedValue([]);

    const wrapper = mountComponent({ folderId: "folder123" });
    const vm = wrapper.vm as any;

    await vm.updateCompatibleConfigurations();

    expect(mockGetAllConfigurations).toHaveBeenCalledWith("folder123");
    wrapper.destroy();
  });

  it("updateCompatibleConfigurations clears list when dataset is null", async () => {
    const originalDataset = mockDataset;
    mockDataset = null;

    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.compatibleConfigurations = [{ id: "old", name: "old" }];

    await vm.updateCompatibleConfigurations();

    expect(vm.compatibleConfigurations).toEqual([]);
    expect(mockFindDatasetViews).not.toHaveBeenCalled();

    mockDataset = originalDataset;
    wrapper.destroy();
  });

  it("updateCompatibleConfigurations clears list and sets loading false on error", async () => {
    mockFindDatasetViews.mockRejectedValue(new Error("Network error"));

    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    await vm.updateCompatibleConfigurations();

    expect(vm.compatibleConfigurations).toEqual([]);
    expect(vm.loading).toBe(false);
    wrapper.destroy();
  });

  it("submit emits selected configurations", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    const configs = [
      { id: "c1", name: "Config 1" },
      { id: "c2", name: "Config 2" },
    ];
    vm.selectedConfigurations = configs;

    vm.submit();

    expect(wrapper.emitted("submit")).toBeTruthy();
    expect(wrapper.emitted("submit")![0][0]).toEqual(configs);
    wrapper.destroy();
  });

  it("submit emits empty array when no configurations selected", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    vm.submit();

    expect(wrapper.emitted("submit")).toBeTruthy();
    expect(wrapper.emitted("submit")![0][0]).toEqual([]);
    wrapper.destroy();
  });

  it("cancel emits cancel event", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    vm.cancel();

    expect(wrapper.emitted("cancel")).toBeTruthy();
    wrapper.destroy();
  });

  it("loading state is managed properly during updateCompatibleConfigurations", async () => {
    let resolveViews: (value: any) => void;
    mockFindDatasetViews.mockImplementation(
      () => new Promise((resolve) => (resolveViews = resolve)),
    );
    mockGetAllConfigurations.mockResolvedValue([]);

    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    const updatePromise = vm.updateCompatibleConfigurations();
    expect(vm.loading).toBe(true);

    resolveViews!([]);
    await updatePromise;

    expect(vm.loading).toBe(false);
    wrapper.destroy();
  });

  it("default title prop is 'Select collections'", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.$props.title).toBe("Select collections");
    wrapper.destroy();
  });

  it("custom title prop is passed through", () => {
    const wrapper = mountComponent({ title: "Pick configurations" });
    const vm = wrapper.vm as any;
    expect(vm.$props.title).toBe("Pick configurations");
    wrapper.destroy();
  });

  it("headers has correct structure", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.headers).toEqual([
      { text: "Collection Name", value: "name" },
      { text: "Collection Description", value: "description" },
    ]);
    wrapper.destroy();
  });

  it("search starts empty", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.search).toBe("");
    wrapper.destroy();
  });

  it("selectedConfigurations starts empty", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.selectedConfigurations).toEqual([]);
    wrapper.destroy();
  });
});

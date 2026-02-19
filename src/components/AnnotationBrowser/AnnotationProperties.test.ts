import { describe, it, expect, vi, beforeEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

const mockGetCollectionDatasetCount = vi.fn();
const mockComputePropertyBatch = vi.fn();

vi.mock("@/store", () => ({
  default: {
    isLoggedIn: true,
    selectedConfigurationId: "cfg1",
    getCollectionDatasetCount: (...args: any[]) =>
      mockGetCollectionDatasetCount(...args),
  },
}));

vi.mock("@/store/properties", () => ({
  default: {
    computedPropertyPaths: [
      ["prop1", "subA"],
      ["prop1", "subB"],
      ["prop2", "subC"],
    ],
    displayedPropertyPaths: [["prop1", "subA"]],
    getFullNameFromPath: vi.fn((path: string[]) => path.join(".")),
    togglePropertyPathVisibility: vi.fn(),
    computePropertyBatch: (...args: any[]) => mockComputePropertyBatch(...args),
    getPropertyById: vi.fn((id: string) => ({ name: id.toUpperCase() })),
  },
}));

vi.mock("@/store/filters", () => ({
  default: {
    filterPaths: [["prop2", "subC"]],
    togglePropertyPathFiltering: vi.fn(),
  },
}));

vi.mock("@/utils/paths", () => ({
  findIndexOfPath: vi.fn((path: string[], arr: string[][]) =>
    arr.findIndex(
      (p) => p.length === path.length && p.every((s, i) => s === path[i]),
    ),
  ),
}));

vi.mock("@/utils/log", () => ({
  logError: vi.fn(),
}));

import AnnotationProperties from "./AnnotationProperties.vue";
import store from "@/store";
import propertyStore from "@/store/properties";
import filterStore from "@/store/filters";

Vue.use(Vuetify);
Vue.directive("tour-trigger", {});

function mountComponent() {
  return shallowMount(AnnotationProperties, {
    vuetify: new Vuetify(),
    stubs: {
      AnalyzePanel: true,
      VExpansionPanel: {
        template: "<div><slot /></div>",
      },
      VExpansionPanelHeader: {
        template: "<div><slot /></div>",
      },
      VExpansionPanelContent: {
        template: "<div><slot /></div>",
      },
    },
  });
}

describe("AnnotationProperties", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    (store as any).isLoggedIn = true;
    (store as any).selectedConfigurationId = "cfg1";
    (store as any).getCollectionDatasetCount = (...args: any[]) =>
      mockGetCollectionDatasetCount(...args);
    mockGetCollectionDatasetCount.mockResolvedValue(3);
    // Re-assign mock functions after restoreAllMocks
    (propertyStore as any).togglePropertyPathVisibility = vi.fn();
    (propertyStore as any).getFullNameFromPath = vi.fn((path: string[]) =>
      path.join("."),
    );
    (propertyStore as any).getPropertyById = vi.fn((id: string) => ({
      name: id.toUpperCase(),
    }));
    (filterStore as any).togglePropertyPathFiltering = vi.fn();
  });

  it("activeTabIndex defaults to 0 (display tab)", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.activeTabIndex).toBe(0);
    wrapper.destroy();
  });

  it("activeTabIndex setter updates activeTabKey", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.activeTabIndex = 1;
    expect(vm.activeTabKey).toBe("filter");
    wrapper.destroy();
  });

  it("activeTabIndex getter reflects activeTabKey", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.activeTabKey = "filter";
    expect(vm.activeTabIndex).toBe(1);
    wrapper.destroy();
  });

  it("isLoggedIn reflects store.isLoggedIn", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.isLoggedIn).toBe(true);
    wrapper.destroy();
  });

  it("filteredPaths returns all paths when propFilter is null", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.propFilter = null;
    expect(vm.filteredPaths).toHaveLength(3);
    wrapper.destroy();
  });

  it("filteredPaths filters by propFilter text", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.propFilter = "subA";
    // getFullNameFromPath returns path.join('.'), so "prop1.subA" includes "subA"
    expect(vm.filteredPaths).toHaveLength(1);
    expect(vm.filteredPaths[0]).toEqual(["prop1", "subA"]);
    wrapper.destroy();
  });

  it("filteredPaths is case insensitive", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.propFilter = "SUBA";
    expect(vm.filteredPaths).toHaveLength(1);
    wrapper.destroy();
  });

  it("columns builds miller column structure", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.selectedPath = [];
    const cols = vm.columns;
    // First column should have unique top-level segments: prop1, prop2
    expect(cols).toHaveLength(1);
    expect(cols[0]).toHaveLength(2); // prop1, prop2
    wrapper.destroy();
  });

  it("columns expands when selectedPath is set", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.selectedPath = ["prop1"];
    const cols = vm.columns;
    expect(cols.length).toBeGreaterThanOrEqual(2);
    // Second column should have subA and subB
    expect(cols[1]).toHaveLength(2);
    wrapper.destroy();
  });

  it("getPropertySettings returns true for displayed property in display tab", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.activeTabKey = "display";
    expect(vm.getPropertySettings(["prop1", "subA"])).toBe(true);
    wrapper.destroy();
  });

  it("getPropertySettings returns false for non-displayed property in display tab", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.activeTabKey = "display";
    expect(vm.getPropertySettings(["prop2", "subC"])).toBe(false);
    wrapper.destroy();
  });

  it("getPropertySettings returns true for filtered property in filter tab", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.activeTabKey = "filter";
    expect(vm.getPropertySettings(["prop2", "subC"])).toBe(true);
    wrapper.destroy();
  });

  it("getPropertySettings returns false for non-filtered property in filter tab", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.activeTabKey = "filter";
    expect(vm.getPropertySettings(["prop1", "subA"])).toBe(false);
    wrapper.destroy();
  });

  it("togglePropertySettings calls togglePropertyPathVisibility in display tab", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.activeTabKey = "display";
    vm.togglePropertySettings(["prop1", "subA"]);
    expect(propertyStore.togglePropertyPathVisibility).toHaveBeenCalledWith([
      "prop1",
      "subA",
    ]);
    wrapper.destroy();
  });

  it("togglePropertySettings calls togglePropertyPathFiltering in filter tab", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.activeTabKey = "filter";
    vm.togglePropertySettings(["prop2", "subC"]);
    expect(filterStore.togglePropertyPathFiltering).toHaveBeenCalledWith([
      "prop2",
      "subC",
    ]);
    wrapper.destroy();
  });

  it("canApplyToAllDatasets is true when conditions met", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    // Wait for onMounted fetchCollectionDatasetCount
    await Vue.nextTick();
    await Vue.nextTick();
    expect(vm.collectionDatasetCount).toBe(3);
    expect(vm.canApplyToAllDatasets).toBe(true);
    wrapper.destroy();
  });

  it("canApplyToAllDatasets is false when count is 1", async () => {
    mockGetCollectionDatasetCount.mockResolvedValue(1);
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    await Vue.nextTick();
    await Vue.nextTick();
    expect(vm.canApplyToAllDatasets).toBe(false);
    wrapper.destroy();
  });

  it("canApplyToAllDatasets is false when count exceeds limit", async () => {
    mockGetCollectionDatasetCount.mockResolvedValue(11);
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    await Vue.nextTick();
    await Vue.nextTick();
    expect(vm.canApplyToAllDatasets).toBe(false);
    wrapper.destroy();
  });

  it("canApplyToAllDatasets is false when no configurationId", async () => {
    (store as any).selectedConfigurationId = null;
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    await Vue.nextTick();
    await Vue.nextTick();
    expect(vm.canApplyToAllDatasets).toBe(false);
    (store as any).selectedConfigurationId = "cfg1";
    wrapper.destroy();
  });

  it("batchDisabledReason returns message when count exceeds limit", async () => {
    mockGetCollectionDatasetCount.mockResolvedValue(11);
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    await Vue.nextTick();
    await Vue.nextTick();
    expect(vm.batchDisabledReason).toBe("Collection has more than 10 datasets");
    wrapper.destroy();
  });

  it("batchDisabledReason returns null when conditions met", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    await Vue.nextTick();
    await Vue.nextTick();
    expect(vm.batchDisabledReason).toBeNull();
    wrapper.destroy();
  });

  it("batchProgressPercent returns 0 when no batchProgress", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.batchProgressPercent).toBe(0);
    wrapper.destroy();
  });

  it("batchProgressPercent computes correctly", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.batchProgress = {
      total: 10,
      completed: 3,
      failed: 1,
      cancelled: 1,
      currentDatasetName: "DS5",
    };
    expect(vm.batchProgressPercent).toBe(50);
    wrapper.destroy();
  });

  it("cancelBatch calls batchCancelFunction when set", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const mockCancel = vi.fn();
    vm.batchCancelFunction = mockCancel;
    vm.cancelBatch();
    expect(mockCancel).toHaveBeenCalled();
    wrapper.destroy();
  });

  it("cancelBatch does nothing when batchCancelFunction is null", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.batchCancelFunction = null;
    // Should not throw
    vm.cancelBatch();
    wrapper.destroy();
  });

  it("fetchCollectionDatasetCount sets collectionDatasetCount", async () => {
    mockGetCollectionDatasetCount.mockResolvedValue(5);
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    await vm.fetchCollectionDatasetCount();
    expect(vm.collectionDatasetCount).toBe(5);
    expect(vm.loadingDatasetCount).toBe(false);
    wrapper.destroy();
  });

  it("fetchCollectionDatasetCount handles error", async () => {
    mockGetCollectionDatasetCount.mockRejectedValue(new Error("fail"));
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    await vm.fetchCollectionDatasetCount();
    expect(vm.collectionDatasetCount).toBe(0);
    expect(vm.loadingDatasetCount).toBe(false);
    wrapper.destroy();
  });

  it("onDialogClose sets showAnalyzeDialog false and emits expand", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.showAnalyzeDialog = true;
    vm.onDialogClose(false);
    expect(vm.showAnalyzeDialog).toBe(false);
    expect(wrapper.emitted("expand")).toBeTruthy();
    wrapper.destroy();
  });

  it("onDialogClose does nothing when value is true", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.showAnalyzeDialog = true;
    vm.onDialogClose(true);
    expect(vm.showAnalyzeDialog).toBe(true);
    wrapper.destroy();
  });
});

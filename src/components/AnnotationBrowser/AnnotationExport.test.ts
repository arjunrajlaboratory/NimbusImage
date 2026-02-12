import { describe, it, expect, vi, beforeEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

vi.mock("@/store", () => ({
  default: {
    dataset: { id: "ds1", name: "TestDataset" },
    configuration: { id: "cfg1" },
    api: {
      findDatasetViews: vi.fn().mockResolvedValue([]),
    },
    girderResources: {
      batchFetchResources: vi.fn().mockResolvedValue(undefined),
      watchFolder: vi.fn().mockReturnValue({ name: "Folder" }),
    },
    exportAPI: {
      exportJson: vi.fn(),
      exportBulkJson: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

import AnnotationExport from "./AnnotationExport.vue";
import store from "@/store";

Vue.use(Vuetify);
Vue.directive("description", {});

function mountComponent() {
  return shallowMount(AnnotationExport, {
    vuetify: new Vuetify(),
  });
}

describe("AnnotationExport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("canExport is true when dataset exists", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.canExport).toBe(true);
  });

  it("canExport is false when no dataset", () => {
    const prev = store.dataset;
    (store as any).dataset = null;
    const wrapper = mountComponent();
    expect(wrapper.vm.canExport).toBe(false);
    (store as any).dataset = prev;
  });

  it("canSubmit checks state for current scope", () => {
    const wrapper = mountComponent();
    wrapper.vm.exportScope = "current";
    expect(wrapper.vm.canSubmit).toBe(true);
  });

  it("canSubmit is false when exporting", () => {
    const wrapper = mountComponent();
    wrapper.vm.exporting = true;
    expect(wrapper.vm.canSubmit).toBe(false);
    wrapper.vm.exporting = false;
  });

  it("resetFilename sets from dataset name", () => {
    const wrapper = mountComponent();
    wrapper.vm.resetFilename();
    expect(wrapper.vm.filename).toBe("TestDataset.json");
  });

  it("mounted calls resetFilename", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.filename).toBe("TestDataset.json");
  });

  it("submitSingleDataset calls exportAPI.exportJson", () => {
    const wrapper = mountComponent();
    wrapper.vm.submitSingleDataset();
    expect(store.exportAPI.exportJson).toHaveBeenCalledWith(
      expect.objectContaining({
        datasetId: "ds1",
        includeAnnotations: true,
      }),
    );
  });

  it("submitAllDatasets calls exportAPI.exportBulkJson", async () => {
    const wrapper = mountComponent();
    wrapper.vm.collectionDatasets = [
      { datasetId: "ds1", datasetName: "DS1" },
      { datasetId: "ds2", datasetName: "DS2" },
    ];
    wrapper.vm.exportScope = "all";
    await wrapper.vm.submitAllDatasets();
    expect(store.exportAPI.exportBulkJson).toHaveBeenCalledWith(
      expect.objectContaining({
        datasets: expect.arrayContaining([
          expect.objectContaining({ datasetId: "ds1" }),
        ]),
      }),
    );
  });

  it("submitButtonText shows Export for current scope", () => {
    const wrapper = mountComponent();
    wrapper.vm.exportScope = "current";
    expect(wrapper.vm.submitButtonText).toBe("Export");
  });
});

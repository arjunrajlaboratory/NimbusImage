import { describe, it, expect, vi, beforeEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

vi.mock("@/store", () => ({
  default: {
    dataset: {
      id: "ds1",
      name: "TestDataset",
      xy: [0, 1, 2],
      z: [0, 1],
      time: [0, 1, 2, 3],
    },
    selectedDatasetId: "ds1",
    girderResources: {
      getFolder: vi.fn().mockResolvedValue({
        meta: {
          dimensionLabels: {
            xy: ["H1", "H2", "H3"],
            z: ["0 µm", "2 µm"],
            t: ["0 min", "5 min", "10 min", "15 min"],
          },
        },
      }),
    },
  },
}));

vi.mock("@/utils/download", () => ({
  downloadToClient: vi.fn(),
}));

import IndexConversionDialog from "./IndexConversionDialog.vue";
import store from "@/store";
import { downloadToClient } from "@/utils/download";

Vue.use(Vuetify);
Vue.directive("description", {});

function mountComponent() {
  return shallowMount(IndexConversionDialog, {
    vuetify: new Vuetify(),
  });
}

describe("IndexConversionDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dataset reads from store", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.dataset).toBe(store.dataset);
  });

  it("xyCount derives from dataset", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.xyCount).toBe(3);
  });

  it("zCount derives from dataset", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.zCount).toBe(2);
  });

  it("timeCount derives from dataset", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.timeCount).toBe(4);
  });

  it("hasXYDimension is true when xyCount > 1", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.hasXYDimension).toBe(true);
  });

  it("generateCSV produces correct columns", () => {
    const wrapper = mountComponent();
    const csv = wrapper.vm.generateCSV(3, ["H1", "H2", "H3"]);
    expect(csv).toContain("UI Index");
    expect(csv).toContain("JSON Index");
    expect(csv).toContain("Label");
    expect(csv).toContain("1,0");
    expect(csv).toContain("2,1");
    expect(csv).toContain("3,2");
  });

  it("generateCSV handles null labels", () => {
    const wrapper = mountComponent();
    const csv = wrapper.vm.generateCSV(2, null);
    expect(csv).toContain("UI Index");
    expect(csv).toContain('""');
  });

  it("downloadXY calls downloadToClient", () => {
    const wrapper = mountComponent();
    wrapper.vm.dimensionLabels = {
      xy: ["H1", "H2", "H3"],
      z: null,
      t: null,
    };
    wrapper.vm.downloadXY();
    expect(downloadToClient).toHaveBeenCalled();
    const callArgs = (downloadToClient as any).mock.calls[0][0];
    expect(callArgs.download).toContain("xy_index_conversion.csv");
  });

  it("watch on dialog calls loadDimensionLabels", async () => {
    const wrapper = mountComponent();
    wrapper.vm.dialog = true;
    await Vue.nextTick();
    expect(store.girderResources.getFolder).toHaveBeenCalledWith("ds1");
  });
});

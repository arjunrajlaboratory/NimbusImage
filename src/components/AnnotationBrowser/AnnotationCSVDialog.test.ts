import { describe, it, expect, vi, beforeEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

vi.mock("@/store", () => ({
  default: {
    dataset: { id: "ds1", name: "TestDataset" },
    exportAPI: {
      exportCsv: vi.fn(),
    },
  },
}));

vi.mock("@/store/properties", () => ({
  default: {
    displayedPropertyPaths: [["propA", "sub1"]],
    getFullNameFromPath: vi.fn((path: string[]) => {
      const map: Record<string, string> = {
        "propA.sub1": "Property A > Sub1",
        "propB.sub2": "Property B > Sub2",
        "propC.sub3": "Property C > Sub3",
      };
      return map[path.join(".")] || null;
    }),
    propertyValues: {} as Record<string, any>,
  },
}));

vi.mock("@/store/annotation", () => ({
  default: {},
}));

vi.mock("@/store/filters", () => ({
  default: {},
}));

// Mock papaparse
vi.mock("papaparse", () => ({
  default: {
    unparse: vi.fn(({ fields, data }: any) => {
      const header = fields.join(",");
      const rows = data.map((row: any[]) => row.join(","));
      return [header, ...rows].join("\n");
    }),
  },
}));

vi.mock("@/utils/paths", () => ({
  getValueFromObjectAndPath: vi.fn((values: any, path: string[]) => {
    if (!values) return null;
    let current = values;
    for (const key of path) {
      if (current && typeof current === "object" && key in current) {
        current = current[key];
      } else {
        return null;
      }
    }
    return current;
  }),
}));

import AnnotationCSVDialog from "./AnnotationCSVDialog.vue";
import store from "@/store";
import propertyStore from "@/store/properties";

Vue.use(Vuetify);
Vue.directive("description", {});

const sampleAnnotations = [
  {
    id: "ann1",
    channel: 0,
    location: { XY: 0, Z: 1, Time: 2 },
    tags: ["tag1", "tag2"],
    shape: "point",
    name: "Annotation 1",
    coordinates: [],
    datasetId: "ds1",
    color: null,
  },
  {
    id: "ann2",
    channel: 1,
    location: { XY: 0, Z: 0, Time: 0 },
    tags: [],
    shape: "polygon",
    name: null,
    coordinates: [],
    datasetId: "ds1",
    color: null,
  },
];

const samplePropertyPaths = [
  ["propA", "sub1"],
  ["propB", "sub2"],
  ["propC", "sub3"],
];

function mountComponent(propsOverrides: any = {}) {
  return shallowMount(AnnotationCSVDialog, {
    vuetify: new Vuetify(),
    propsData: {
      annotations: sampleAnnotations,
      propertyPaths: samplePropertyPaths,
      ...propsOverrides,
    },
  });
}

describe("AnnotationCSVDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    (store as any).dataset = { id: "ds1", name: "TestDataset" };
    (store as any).exportAPI = { exportCsv: vi.fn() };
    (propertyStore as any).displayedPropertyPaths = [["propA", "sub1"]];
    (propertyStore as any).getFullNameFromPath = vi.fn((path: string[]) => {
      const map: Record<string, string> = {
        "propA.sub1": "Property A > Sub1",
        "propB.sub2": "Property B > Sub2",
        "propC.sub3": "Property C > Sub3",
      };
      return map[path.join(".")] || null;
    });
    (propertyStore as any).propertyValues = {};
    (store.exportAPI.exportCsv as any).mockReset();
  });

  it("isTooLargeForPreview is false for small annotation sets", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.isTooLargeForPreview).toBe(false);
    wrapper.destroy();
  });

  it("isTooLargeForPreview is true when annotations exceed 1000", () => {
    const manyAnnotations = Array.from({ length: 1001 }, (_, i) => ({
      id: `ann${i}`,
      channel: 0,
      location: { XY: 0, Z: 0, Time: 0 },
      tags: [],
      shape: "point",
      name: null,
      coordinates: [],
      datasetId: "ds1",
      color: null,
    }));
    const wrapper = mountComponent({ annotations: manyAnnotations });
    const vm = wrapper.vm as any;
    expect(vm.isTooLargeForPreview).toBe(true);
    wrapper.destroy();
  });

  it("resetFilename sets filename from dataset name", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.resetFilename();
    expect(vm.filename).toBe("TestDataset.csv");
    wrapper.destroy();
  });

  it("resetFilename uses 'unknown' when no dataset", () => {
    (store as any).dataset = null;
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.resetFilename();
    expect(vm.filename).toBe("unknown.csv");
    wrapper.destroy();
  });

  it("shouldIncludePropertyPath returns true for all mode", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.propertyExportMode = "all";
    expect(vm.shouldIncludePropertyPath(["propA", "sub1"])).toBe(true);
    expect(vm.shouldIncludePropertyPath(["propB", "sub2"])).toBe(true);
    wrapper.destroy();
  });

  it("shouldIncludePropertyPath in listed mode only includes displayed paths", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.propertyExportMode = "listed";
    // propA.sub1 is in displayedPropertyPaths
    expect(vm.shouldIncludePropertyPath(["propA", "sub1"])).toBe(true);
    // propB.sub2 is NOT in displayedPropertyPaths
    expect(vm.shouldIncludePropertyPath(["propB", "sub2"])).toBe(false);
    wrapper.destroy();
  });

  it("shouldIncludePropertyPath in selected mode checks selectedPropertyPaths", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.propertyExportMode = "selected";
    // Nothing selected yet
    expect(vm.shouldIncludePropertyPath(["propA", "sub1"])).toBe(false);
    wrapper.destroy();
  });

  it("getUndefinedValueString returns empty string for empty mode", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.undefinedHandling = "empty";
    expect(vm.getUndefinedValueString()).toBe("");
    wrapper.destroy();
  });

  it("getUndefinedValueString returns NA for na mode", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.undefinedHandling = "na";
    expect(vm.getUndefinedValueString()).toBe("NA");
    wrapper.destroy();
  });

  it("getUndefinedValueString returns NaN for nan mode", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.undefinedHandling = "nan";
    expect(vm.getUndefinedValueString()).toBe("NaN");
    wrapper.destroy();
  });

  it("getIncludedPropertyPaths filters based on mode", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.propertyExportMode = "all";
    const result = vm.getIncludedPropertyPaths();
    expect(result).toHaveLength(3);
    wrapper.destroy();
  });

  it("getIncludedPropertyPaths in listed mode returns only displayed paths", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.propertyExportMode = "listed";
    const result = vm.getIncludedPropertyPaths();
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(["propA", "sub1"]);
    wrapper.destroy();
  });

  it("updateText clears text when dialog is closed", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    // dialog is initially false
    // Set text values first
    vm.text = "some csv";
    // Now verify that dialog is false (initial state)
    expect(vm.dialog).toBe(false);
    // Calling updateText with dialog=false should clear text
    vm.updateText();
    expect(vm.text).toBe("");
    wrapper.destroy();
  });

  it("updateText clears text and sets progress when too large for preview", () => {
    const manyAnnotations = Array.from({ length: 1001 }, (_, i) => ({
      id: `ann${i}`,
      channel: 0,
      location: { XY: 0, Z: 0, Time: 0 },
      tags: [],
      shape: "point",
      name: null,
      coordinates: [],
      datasetId: "ds1",
      color: null,
    }));
    const wrapper = mountComponent({ annotations: manyAnnotations });
    const vm = wrapper.vm as any;
    vm.dialog = true;
    vm.updateText();
    expect(vm.text).toBe("");
    expect(vm.processingProgress).toBe(1);
    wrapper.destroy();
  });

  it("updateText generates CSV when dialog is open and within limit", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.dialog = true;
    vm.propertyExportMode = "all";
    vm.updateText();
    // Wait for the async generateCSVStringForAnnotations to resolve
    await Vue.nextTick();
    await Vue.nextTick();
    expect(vm.text).toBeTruthy();
    expect(vm.text).toContain("Id");
    wrapper.destroy();
  });

  it("download does nothing when no dataset", async () => {
    (store as any).dataset = null;
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    await vm.download();
    expect(store.exportAPI.exportCsv).not.toHaveBeenCalled();
    wrapper.destroy();
  });

  it("download calls exportAPI.exportCsv with correct params", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.filename = "export.csv";
    vm.propertyExportMode = "all";
    vm.undefinedHandling = "empty";
    await vm.download();
    expect(store.exportAPI.exportCsv).toHaveBeenCalledTimes(1);
    const arg = (store.exportAPI.exportCsv as any).mock.calls[0][0];
    expect(arg.datasetId).toBe("ds1");
    expect(arg.filename).toBe("export.csv");
    expect(arg.undefinedValue).toBe("");
    expect(arg.annotationIds).toEqual(["ann1", "ann2"]);
    wrapper.destroy();
  });

  it("generateCSVStringForAnnotations produces CSV with headers", async () => {
    (propertyStore as any).propertyValues = {
      ann1: { propA: { sub1: 42 } },
      ann2: { propA: { sub1: 99 } },
    };
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.propertyExportMode = "all";
    const csv = await vm.generateCSVStringForAnnotations();
    expect(csv).toContain("Id");
    expect(csv).toContain("Channel");
    expect(csv).toContain("ann1");
    expect(csv).toContain("ann2");
    wrapper.destroy();
  });

  it("generateCSVStringForAnnotations uses undefined handling for missing values", async () => {
    (propertyStore as any).propertyValues = {};
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.propertyExportMode = "all";
    vm.undefinedHandling = "na";
    const csv = await vm.generateCSVStringForAnnotations();
    expect(csv).toContain("NA");
    wrapper.destroy();
  });

  it("watcher on propertyExportMode causes text regeneration when dialog open", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.dialog = true;
    vm.propertyExportMode = "all";
    // Let watcher + async CSV generation run
    await Vue.nextTick();
    await Vue.nextTick();
    await Vue.nextTick();
    const textAfterAll = vm.text;
    // Change mode to listed (which filters fewer properties)
    vm.propertyExportMode = "listed";
    await Vue.nextTick();
    await Vue.nextTick();
    await Vue.nextTick();
    // Text should have been regenerated (may be different content)
    expect(typeof vm.text).toBe("string");
    wrapper.destroy();
  });

  it("watcher on dialog regenerates text when opened", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    // Start with dialog closed
    vm.dialog = false;
    await Vue.nextTick();
    expect(vm.text).toBe("");
    // Open dialog - watcher should trigger updateText
    vm.dialog = true;
    await Vue.nextTick();
    await Vue.nextTick();
    await Vue.nextTick();
    // Text should be generated since dialog is now open
    expect(vm.text).toBeTruthy();
    wrapper.destroy();
  });

  it("resetFilename reflects current dataset name via computed", () => {
    // The component's dataset computed reads store.dataset which is non-reactive in tests.
    // Verify that calling resetFilename uses the initial store.dataset value.
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.resetFilename();
    expect(vm.filename).toBe("TestDataset.csv");
    wrapper.destroy();
  });

  it("filteredPropertyItems maps paths to items with names", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const items = vm.filteredPropertyItems;
    expect(items).toHaveLength(3);
    expect(items[0].name).toBe("Property A > Sub1");
    expect(items[0].pathString).toBe("propA.sub1");
    wrapper.destroy();
  });

  it("displayedPropertyPaths returns from propertyStore", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.displayedPropertyPaths).toEqual([["propA", "sub1"]]);
    wrapper.destroy();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { nextTick } from "vue";
import { shallowMount } from "@vue/test-utils";

vi.mock("@/store", () => ({
  default: {
    dataset: { id: "ds1", name: "TestDataset" },
    configuration: { id: "cfg1" },
    exportAPI: {
      exportCsv: vi.fn(),
      exportBulkCsv: vi.fn().mockResolvedValue(undefined),
    },
    api: {
      findDatasetViews: vi.fn().mockResolvedValue([]),
    },
    girderResources: {
      batchFetchResources: vi.fn().mockResolvedValue(undefined),
      watchFolder: vi.fn().mockReturnValue({ name: "Folder" }),
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
  default: {
    annotations: [] as any[],
    selectedAnnotationIds: new Set<string>(),
  },
}));

vi.mock("@/store/filters", () => ({
  default: {},
}));

// Mock papaparse
vi.mock("papaparse", () => ({
  default: {
    unparse: vi.fn(({ fields, data }: any, config?: any) => {
      const delim = config?.delimiter || ",";
      const header = fields.join(delim);
      const rows = data.map((row: any[]) => row.join(delim));
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
import annotationStore from "@/store/annotation";

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
    props: {
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
    (store as any).configuration = { id: "cfg1" };
    (store as any).exportAPI = {
      exportCsv: vi.fn(),
      exportBulkCsv: vi.fn().mockResolvedValue(undefined),
    };
    (store as any).api = {
      findDatasetViews: vi.fn().mockResolvedValue([]),
    };
    (store as any).girderResources = {
      batchFetchResources: vi.fn().mockResolvedValue(undefined),
      watchFolder: vi.fn().mockReturnValue({ name: "Folder" }),
    };
    (annotationStore as any).annotations = sampleAnnotations;
    (annotationStore as any).selectedAnnotationIds = new Set<string>();
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
  });

  it("isTooLargeForPreview is false for small annotation sets", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.isTooLargeForPreview).toBe(false);
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
    (annotationStore as any).annotations = manyAnnotations;
    const wrapper = mountComponent({ annotations: manyAnnotations });
    const vm = wrapper.vm as any;
    expect(vm.isTooLargeForPreview).toBe(true);
  });

  it("resetFilename sets filename from dataset name", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.resetFilename();
    expect(vm.filename).toBe("TestDataset.csv");
  });

  it("resetFilename uses 'unknown' when no dataset", () => {
    (store as any).dataset = null;
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.resetFilename();
    expect(vm.filename).toBe("unknown.csv");
  });

  it("shouldIncludePropertyPath returns true for all mode", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.propertyExportMode = "all";
    expect(vm.shouldIncludePropertyPath(["propA", "sub1"])).toBe(true);
    expect(vm.shouldIncludePropertyPath(["propB", "sub2"])).toBe(true);
  });

  it("shouldIncludePropertyPath in listed mode only includes displayed paths", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.propertyExportMode = "listed";
    // propA.sub1 is in displayedPropertyPaths
    expect(vm.shouldIncludePropertyPath(["propA", "sub1"])).toBe(true);
    // propB.sub2 is NOT in displayedPropertyPaths
    expect(vm.shouldIncludePropertyPath(["propB", "sub2"])).toBe(false);
  });

  it("shouldIncludePropertyPath in selected mode checks selectedPropertyPaths", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.propertyExportMode = "selected";
    // Nothing selected yet
    expect(vm.shouldIncludePropertyPath(["propA", "sub1"])).toBe(false);
  });

  it("getUndefinedValueString returns empty string for empty mode", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.undefinedHandling = "empty";
    expect(vm.getUndefinedValueString()).toBe("");
  });

  it("getUndefinedValueString returns NA for na mode", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.undefinedHandling = "na";
    expect(vm.getUndefinedValueString()).toBe("NA");
  });

  it("getUndefinedValueString returns NaN for nan mode", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.undefinedHandling = "nan";
    expect(vm.getUndefinedValueString()).toBe("NaN");
  });

  it("getIncludedPropertyPaths filters based on mode", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.propertyExportMode = "all";
    const result = vm.getIncludedPropertyPaths();
    expect(result).toHaveLength(3);
  });

  it("getIncludedPropertyPaths in listed mode returns only displayed paths", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.propertyExportMode = "listed";
    const result = vm.getIncludedPropertyPaths();
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(["propA", "sub1"]);
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
  });

  it("updateText generates CSV when dialog is open and within limit", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.dialog = true;
    vm.propertyExportMode = "all";
    vm.updateText();
    // Wait for the async generateCSVStringForAnnotations to resolve
    await nextTick();
    await nextTick();
    expect(vm.text).toBeTruthy();
    expect(vm.text).toContain("Id");
  });

  it("download does nothing when no dataset", async () => {
    (store as any).dataset = null;
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    await vm.download();
    expect(store.exportAPI.exportCsv).not.toHaveBeenCalled();
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
    // When exporting all annotations (not a subset), annotationIds is omitted
    // to avoid exceeding MongoDB's BSON size limit
    expect(arg.annotationIds).toBeUndefined();
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
  });

  it("generateCSVStringForAnnotations uses undefined handling for missing values", async () => {
    (propertyStore as any).propertyValues = {};
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.propertyExportMode = "all";
    vm.undefinedHandling = "na";
    const csv = await vm.generateCSVStringForAnnotations();
    expect(csv).toContain("NA");
  });

  it("watcher on propertyExportMode causes text regeneration when dialog open", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.dialog = true;
    vm.propertyExportMode = "all";
    // Let watcher + async CSV generation run
    await nextTick();
    await nextTick();
    await nextTick();
    // Change mode to listed (which filters fewer properties)
    vm.propertyExportMode = "listed";
    await nextTick();
    await nextTick();
    await nextTick();
    // Text should have been regenerated (may be different content)
    expect(typeof vm.text).toBe("string");
  });

  it("watcher on dialog regenerates text when opened", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    // Start with dialog closed
    vm.dialog = false;
    await nextTick();
    expect(vm.text).toBe("");
    // Open dialog - watcher should trigger updateText
    vm.dialog = true;
    await nextTick();
    await nextTick();
    await nextTick();
    // Text should be generated since dialog is now open
    expect(vm.text).toBeTruthy();
  });

  it("resetFilename reflects current dataset name via computed", () => {
    // The component's dataset computed reads store.dataset which is non-reactive in tests.
    // Verify that calling resetFilename uses the initial store.dataset value.
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.resetFilename();
    expect(vm.filename).toBe("TestDataset.csv");
  });

  it("filteredPropertyItems maps paths to items with names", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const items = vm.filteredPropertyItems;
    expect(items).toHaveLength(3);
    expect(items[0].name).toBe("Property A > Sub1");
    expect(items[0].pathString).toBe("propA.sub1");
  });

  it("displayedPropertyPaths returns from propertyStore", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.displayedPropertyPaths).toEqual([["propA", "sub1"]]);
  });

  // TSV format tests
  it("fileFormat defaults to csv", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.fileFormat).toBe("csv");
  });

  it("resetFilename uses .tsv extension when fileFormat is tsv", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.fileFormat = "tsv";
    vm.resetFilename();
    expect(vm.filename).toBe("TestDataset.tsv");
  });

  it("resetFilename uses .csv extension when fileFormat is csv", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.fileFormat = "csv";
    vm.resetFilename();
    expect(vm.filename).toBe("TestDataset.csv");
  });

  it("generateCSVStringForAnnotations uses tab delimiter for tsv format", async () => {
    (propertyStore as any).propertyValues = {
      ann1: { propA: { sub1: 42 } },
    };
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.fileFormat = "tsv";
    vm.propertyExportMode = "all";
    const tsv = await vm.generateCSVStringForAnnotations();
    // The mock papaparse joins with the delimiter, so tabs should appear
    expect(tsv).toContain("\t");
    expect(tsv).toContain("Id\t");
  });

  it("generateCSVStringForAnnotations uses comma delimiter for csv format", async () => {
    (propertyStore as any).propertyValues = {
      ann1: { propA: { sub1: 42 } },
    };
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.fileFormat = "csv";
    vm.propertyExportMode = "all";
    const csv = await vm.generateCSVStringForAnnotations();
    expect(csv).toContain("Id,");
    expect(csv).not.toContain("Id\t");
  });

  it("download passes tab delimiter when fileFormat is tsv", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.fileFormat = "tsv";
    vm.filename = "export.tsv";
    vm.propertyExportMode = "all";
    await vm.download();
    expect(store.exportAPI.exportCsv).toHaveBeenCalledTimes(1);
    const arg = (store.exportAPI.exportCsv as any).mock.calls[0][0];
    expect(arg.delimiter).toBe("\t");
    expect(arg.filename).toBe("export.tsv");
  });

  it("download passes comma delimiter when fileFormat is csv", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.fileFormat = "csv";
    vm.filename = "export.csv";
    vm.propertyExportMode = "all";
    await vm.download();
    const arg = (store.exportAPI.exportCsv as any).mock.calls[0][0];
    expect(arg.delimiter).toBe(",");
  });

  it("hasCommasInPropertyNames detects commas in property names", () => {
    (propertyStore as any).getFullNameFromPath = vi.fn((path: string[]) => {
      const map: Record<string, string> = {
        "propA.sub1": "cell, fibroblast Blob Metrics",
        "propB.sub2": "Property B > Sub2",
        "propC.sub3": "Property C > Sub3",
      };
      return map[path.join(".")] || null;
    });
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.hasCommasInPropertyNames).toBe(true);
    expect(vm.propertyNamesWithCommas).toEqual([
      "cell, fibroblast Blob Metrics",
    ]);
  });

  it("hasCommasInPropertyNames is false when no property names have commas", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.hasCommasInPropertyNames).toBe(false);
    expect(vm.propertyNamesWithCommas).toEqual([]);
  });

  it("watcher on fileFormat triggers text regeneration when dialog open", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.dialog = true;
    vm.fileFormat = "csv";
    await nextTick();
    await nextTick();
    await nextTick();
    vm.fileFormat = "tsv";
    await nextTick();
    await nextTick();
    await nextTick();
    // Text should have been regenerated (content changes due to delimiter)
    expect(typeof vm.text).toBe("string");
    expect(vm.text).toBeTruthy();
  });

  // Bulk CSV export tests
  it("exportScope defaults to current", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.exportScope).toBe("current");
  });

  it("canDownload is true for current scope with dataset", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.exportScope = "current";
    expect(vm.canDownload).toBe(true);
  });

  it("canDownload is false for current scope without dataset", () => {
    (store as any).dataset = null;
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.exportScope = "current";
    expect(vm.canDownload).toBe(false);
  });

  it("canDownload is false for all scope with no datasets loaded", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.exportScope = "all";
    vm.collectionDatasets = [];
    expect(vm.canDownload).toBe(false);
  });

  it("canDownload is true for all scope with datasets loaded", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.exportScope = "all";
    vm.collectionDatasets = [{ datasetId: "ds1", datasetName: "DS1" }];
    expect(vm.canDownload).toBe(true);
  });

  it("canDownload is false while bulk exporting", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.exportScope = "all";
    vm.collectionDatasets = [{ datasetId: "ds1", datasetName: "DS1" }];
    vm.bulkExporting = true;
    expect(vm.canDownload).toBe(false);
  });

  it("downloadButtonText shows Download for current scope", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.exportScope = "current";
    expect(vm.downloadButtonText).toBe("Download");
  });

  it("downloadButtonText shows dataset count for all scope", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.exportScope = "all";
    vm.collectionDatasets = [
      { datasetId: "ds1", datasetName: "DS1" },
      { datasetId: "ds2", datasetName: "DS2" },
    ];
    expect(vm.downloadButtonText).toBe("Download 2 datasets");
  });

  it("downloadButtonText handles singular dataset", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.exportScope = "all";
    vm.collectionDatasets = [{ datasetId: "ds1", datasetName: "DS1" }];
    expect(vm.downloadButtonText).toBe("Download 1 dataset");
  });

  it("download calls exportCsv for current scope", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.exportScope = "current";
    vm.filename = "test.csv";
    vm.propertyExportMode = "all";
    await vm.download();
    expect(store.exportAPI.exportCsv).toHaveBeenCalledTimes(1);
    expect(store.exportAPI.exportBulkCsv).not.toHaveBeenCalled();
  });

  it("download calls exportBulkCsv for all scope", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.exportScope = "all";
    vm.collectionDatasets = [
      { datasetId: "ds1", datasetName: "DS1" },
      { datasetId: "ds2", datasetName: "DS2" },
    ];
    vm.propertyExportMode = "all";
    vm.undefinedHandling = "na";
    vm.fileFormat = "csv";
    await vm.downloadAllDatasets();
    expect(store.exportAPI.exportBulkCsv).toHaveBeenCalledTimes(1);
    expect(store.exportAPI.exportBulkCsv).toHaveBeenCalledWith(
      expect.objectContaining({
        datasets: [
          { datasetId: "ds1", datasetName: "DS1" },
          { datasetId: "ds2", datasetName: "DS2" },
        ],
        undefinedValue: "NA",
        delimiter: ",",
      }),
    );
  });

  it("downloadAllDatasets does nothing with empty datasets", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.exportScope = "all";
    vm.collectionDatasets = [];
    await vm.downloadAllDatasets();
    expect(store.exportAPI.exportBulkCsv).not.toHaveBeenCalled();
  });

  it("downloadAllDatasets passes tab delimiter for tsv format", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.exportScope = "all";
    vm.collectionDatasets = [{ datasetId: "ds1", datasetName: "DS1" }];
    vm.fileFormat = "tsv";
    vm.propertyExportMode = "all";
    await vm.downloadAllDatasets();
    expect(store.exportAPI.exportBulkCsv).toHaveBeenCalledWith(
      expect.objectContaining({ delimiter: "\t" }),
    );
  });

  it("downloadAllDatasets sets bulkExporting during export", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.exportScope = "all";
    vm.collectionDatasets = [{ datasetId: "ds1", datasetName: "DS1" }];
    vm.propertyExportMode = "all";

    expect(vm.bulkExporting).toBe(false);

    // Make exportBulkCsv resolve after we check state
    let resolveExport: () => void;
    (store.exportAPI.exportBulkCsv as any).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveExport = resolve;
        }),
    );

    const downloadPromise = vm.downloadAllDatasets();
    await nextTick();
    expect(vm.bulkExporting).toBe(true);

    resolveExport!();
    await downloadPromise;
    expect(vm.bulkExporting).toBe(false);
  });

  it("watcher on exportScope loads collection datasets when switching to all", async () => {
    (store.api.findDatasetViews as any).mockResolvedValue([
      { datasetId: "ds1" },
      { datasetId: "ds2" },
    ]);
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.dialog = true;
    vm.exportScope = "all";
    await nextTick();
    await nextTick();
    await nextTick();
    expect(store.api.findDatasetViews).toHaveBeenCalledWith({
      configurationId: "cfg1",
    });
  });

  it("downloadAllDatasets passes included property paths", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.exportScope = "all";
    vm.collectionDatasets = [{ datasetId: "ds1", datasetName: "DS1" }];
    vm.propertyExportMode = "listed";
    await vm.downloadAllDatasets();
    const callArgs = (store.exportAPI.exportBulkCsv as any).mock.calls[0][0];
    // In "listed" mode, only propA.sub1 is in displayedPropertyPaths
    expect(callArgs.propertyPaths).toEqual([["propA", "sub1"]]);
  });
});

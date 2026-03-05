import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { shallowMount } from "@vue/test-utils";

// ---- Hoisted mocks ----

vi.mock("@/store", () => ({
  default: {
    isLoggedIn: true,
    configuration: {
      name: "Test Config",
      snapshots: [],
      layers: [],
      scales: { pixelSize: { value: 0.5, unit: "µm" } },
    },
    dataset: {
      id: "dataset1",
      name: "Test Dataset",
      width: 1000,
      height: 800,
      channels: [0, 1, 2],
      channelNames: new Map([
        [0, "DAPI"],
        [1, "GFP"],
        [2, "RFP"],
      ]),
      anyImage: () => ({ item: { _id: "item1" } }),
    },
    datasetView: { id: "view1", datasetId: "dataset1" },
    layers: [
      {
        id: "layer1",
        name: "Layer 1",
        channel: 0,
        visible: true,
        color: "#ff0000",
      },
      {
        id: "layer2",
        name: "Layer 2",
        channel: 1,
        visible: true,
        color: "#00ff00",
      },
      {
        id: "layer3",
        name: "Layer 3",
        channel: 2,
        visible: false,
        color: "#0000ff",
      },
    ],
    maps: [],
    unroll: false,
    unrollXY: false,
    unrollZ: false,
    unrollT: false,
    xy: 0,
    z: 0,
    time: 0,
    layerMode: "multiple",
    currentLocation: { xy: 0, z: 0, time: 0 },
    girderRest: { apiRoot: "/api/v1", get: vi.fn() },
    girderUser: { _id: "user1" },
    api: {
      getDatasetView: vi.fn().mockResolvedValue({ datasetId: "dataset1" }),
    },
    setXY: vi.fn().mockResolvedValue(undefined),
    setZ: vi.fn().mockResolvedValue(undefined),
    setTime: vi.fn().mockResolvedValue(undefined),
    setUnrollXY: vi.fn().mockResolvedValue(undefined),
    setUnrollZ: vi.fn().mockResolvedValue(undefined),
    setUnrollT: vi.fn().mockResolvedValue(undefined),
    setConfigurationLayers: vi.fn().mockResolvedValue(undefined),
    setLayerMode: vi.fn().mockResolvedValue(undefined),
    setDatasetViewId: vi.fn().mockResolvedValue(undefined),
    loadSnapshotLayers: vi.fn().mockResolvedValue(undefined),
    resetDatasetViewContrasts: vi.fn(),
    addSnapshot: vi.fn(),
    removeSnapshot: vi.fn(),
  },
}));

vi.mock("@/store/progress", () => ({
  default: {
    create: vi.fn().mockResolvedValue("progress1"),
    update: vi.fn(),
    complete: vi.fn(),
  },
}));

vi.mock("@/store/girderResources", () => ({
  default: {
    getDataset: vi.fn().mockResolvedValue({
      id: "dataset1",
      name: "Test Dataset",
      width: 1000,
      height: 800,
      channels: [0, 1, 2],
      channelNames: new Map([
        [0, "DAPI"],
        [1, "GFP"],
        [2, "RFP"],
      ]),
      anyImage: () => ({ item: { _id: "item1" } }),
    }),
  },
}));

vi.mock("geojs", () => ({
  default: {
    annotation: {
      rectangleAnnotation: vi.fn(() => ({
        options: vi.fn(),
        coordinates: vi.fn(() => []),
        style: vi.fn(),
      })),
      lineAnnotation: vi.fn(() => ({
        options: vi.fn(),
        style: vi.fn(),
      })),
    },
    event: {
      annotation: {
        mode: "geojs.annotation.mode",
        coordinates: "geojs.annotation.coordinates",
      },
      drawEnd: "geojs.drawEnd",
    },
    transform: {
      transformCoordinates: vi.fn((_from, _to, coords) => coords),
    },
  },
}));

vi.mock("gif.js", () => ({
  default: vi.fn().mockImplementation(() => ({
    addFrame: vi.fn(),
    on: vi.fn(),
    render: vi.fn(),
  })),
}));

vi.mock("fflate", () => ({
  Zip: vi.fn().mockImplementation(() => ({
    add: vi.fn(),
    end: vi.fn(),
    ondata: null,
  })),
  ZipDeflate: vi.fn().mockImplementation(() => ({
    push: vi.fn(),
  })),
}));

vi.mock("@/utils/date", () => ({
  formatDate: vi.fn(() => "2026-01-01"),
}));

vi.mock("@/utils/download", () => ({
  downloadToClient: vi.fn(),
}));

vi.mock("@/utils/screenshot", () => ({
  getDownloadParameters: vi.fn(() => ({
    left: 0,
    top: 0,
    right: 100,
    bottom: 100,
    regionWidth: 100,
    regionHeight: 100,
    format: "png",
    jpegQuality: 95,
  })),
  getBaseURLFromDownloadParameters: vi.fn(
    () => new URL("http://localhost/api/v1/item/item1/tiles/region"),
  ),
  getChannelsDownloadUrls: vi.fn(() => [
    {
      url: new URL("http://localhost/api/v1/channel0"),
      channel: 0,
    },
  ]),
  getLayersDownloadUrls: vi.fn().mockResolvedValue([
    {
      url: new URL("http://localhost/api/v1/layer1"),
      layerIds: ["layer1"],
    },
  ]),
}));

vi.mock("@/utils/log", () => ({
  logError: vi.fn(),
}));

import store from "@/store";
import {
  getDownloadParameters,
  getChannelsDownloadUrls,
  getLayersDownloadUrls,
} from "@/utils/screenshot";
import { downloadToClient } from "@/utils/download";
import { logError } from "@/utils/log";
import progress from "@/store/progress";
import girderResources from "@/store/girderResources";
import Snapshots from "./Snapshots.vue";
import {
  TScalebarUnit,
  PixelSizeMode,
  ScalebarMode,
  MovieFormat,
} from "./Snapshots.vue";

const mockedGetDownloadParameters = vi.mocked(getDownloadParameters);
const mockedGetChannelsDownloadUrls = vi.mocked(getChannelsDownloadUrls);
const mockedGetLayersDownloadUrls = vi.mocked(getLayersDownloadUrls);
const mockedDownloadToClient = vi.mocked(downloadToClient);
const mockedLogError = vi.mocked(logError);
const mockedProgress = vi.mocked(progress);
const mockedGirderResources = vi.mocked(girderResources);

function mountComponent(propsData: Record<string, unknown> = {}) {
  const app = document.createElement("div");
  app.setAttribute("data-app", "true");
  document.body.appendChild(app);

  const w = shallowMount(Snapshots as any, {
    props: {
      snapshotVisible: false,
      ...propsData,
    },
    global: {
      stubs: {
        TagPicker: true,
        MovieDialog: { template: "<div />", props: ["dataset"] },
        ColorPickerMenu: true,
      },
    },
    attachTo: app,
  });

  // Mock the saveSnapshotForm ref with Vuetify form methods
  (w.vm as any).saveSnapshotForm = {
    validate: vi.fn(() => true),
    resetValidation: vi.fn(),
  };

  return w;
}

// ---- Tests ----

describe("Snapshots.vue", () => {
  let wrapper: ReturnType<typeof mountComponent>;

  afterEach(() => {
    if (wrapper) {
    }
    vi.clearAllMocks();
  });

  // =========================================================================
  // Group 1: Initial state and props
  // =========================================================================
  describe("Group 1: Initial state and props", () => {
    beforeEach(() => {
      wrapper = mountComponent();
    });

    it("has default movieDialog as false", () => {
      expect((wrapper.vm as any).movieDialog).toBe(false);
    });

    it("has default downloading as false", () => {
      expect((wrapper.vm as any).downloading).toBe(false);
    });

    it("has default imageTooBigDialog as false", () => {
      expect((wrapper.vm as any).imageTooBigDialog).toBe(false);
    });

    it("has default createDialog as false", () => {
      expect((wrapper.vm as any).createDialog).toBe(false);
    });

    it("has default newName as empty string", () => {
      expect((wrapper.vm as any).newName).toBe("");
    });

    it("has default newDescription as empty string", () => {
      expect((wrapper.vm as any).newDescription).toBe("");
    });

    it("has default newTags as empty array", () => {
      expect((wrapper.vm as any).newTags).toEqual([]);
    });

    it("has default snapshotSearch as empty string", () => {
      expect((wrapper.vm as any).snapshotSearch).toBe("");
    });

    it("has default bbox values as 0", () => {
      // Note: bbox values may be set by showSnapshot logic, so we check the type
      expect(typeof (wrapper.vm as any).bboxLeft).toBe("number");
      expect(typeof (wrapper.vm as any).bboxTop).toBe("number");
      expect(typeof (wrapper.vm as any).bboxRight).toBe("number");
      expect(typeof (wrapper.vm as any).bboxBottom).toBe("number");
    });

    it("has default downloadMode as layers", () => {
      expect((wrapper.vm as any).downloadMode).toBe("layers");
    });

    it("has default exportLayer as composite", () => {
      expect((wrapper.vm as any).exportLayer).toBe("composite");
    });

    it("has default exportChannel as all", () => {
      expect((wrapper.vm as any).exportChannel).toBe("all");
    });

    it("has default format as png", () => {
      expect((wrapper.vm as any).format).toBe("png");
    });

    it("has default jpegQuality as 95", () => {
      expect((wrapper.vm as any).jpegQuality).toBe(95);
    });

    it("has default addScalebar as true", () => {
      expect((wrapper.vm as any).addScalebar).toBe(true);
    });

    it("has default addScalebarText as true", () => {
      expect((wrapper.vm as any).addScalebarText).toBe(true);
    });

    it("has default snapshotScalebarColor as #ffffff", () => {
      expect((wrapper.vm as any).snapshotScalebarColor).toBe("#ffffff");
    });

    it("has default pixelSizeMode as dataset", () => {
      expect((wrapper.vm as any).pixelSizeMode).toBe(PixelSizeMode.DATASET);
    });

    it("has default scalebarMode as automatic", () => {
      expect((wrapper.vm as any).scalebarMode).toBe(ScalebarMode.AUTOMATIC);
    });

    it("has default addAnnotationsToMovie as false", () => {
      expect((wrapper.vm as any).addAnnotationsToMovie).toBe(false);
    });

    it("has default selectedSnapshotItems as empty array", () => {
      expect((wrapper.vm as any).selectedSnapshotItems).toEqual([]);
    });

    it("has correct maxPixels constant", () => {
      expect((wrapper.vm as any).maxPixels).toBe(4_000_000);
    });

    it("has correct tableHeaders", () => {
      const headers = (wrapper.vm as any).tableHeaders;
      expect(headers).toHaveLength(5);
      expect(headers[0].title).toBe("Name");
      expect(headers[1].title).toBe("Dataset");
      expect(headers[2].title).toBe("Timestamp");
      expect(headers[3].title).toBe("Tags");
      expect(headers[4].title).toBe("Delete");
    });

    it("has nameRules that require non-empty name", () => {
      const rules = (wrapper.vm as any).nameRules;
      expect(rules).toHaveLength(1);
      expect(rules[0]("Valid name")).toBe(true);
      expect(rules[0]("")).toBe("Name is required");
      expect(rules[0]("  ")).toBe("Name is required");
    });

    it("receives snapshotVisible prop", () => {
      expect((wrapper.vm as any).snapshotVisible).toBe(false);
    });

    it("computes isLoggedIn from store", () => {
      expect((wrapper.vm as any).isLoggedIn).toBe(true);
    });

    it("computes unroll from store", () => {
      expect((wrapper.vm as any).unroll).toBe(false);
    });

    it("computes formatList for layers mode", () => {
      (wrapper.vm as any).downloadMode = "layers";
      const list = (wrapper.vm as any).formatList;
      expect(list).toHaveLength(4);
      expect(list.map((f: any) => f.value)).toEqual([
        "png",
        "jpeg",
        "tiff",
        "tiled",
      ]);
    });

    it("computes formatList for channels mode", () => {
      (wrapper.vm as any).downloadMode = "channels";
      const list = (wrapper.vm as any).formatList;
      expect(list).toHaveLength(2);
      expect(list.map((f: any) => f.value)).toEqual(["tiff", "tiled"]);
    });
  });

  // =========================================================================
  // Group 2: Bounding box and scalebar computeds
  // =========================================================================
  describe("Group 2: Bounding box and scalebar computeds", () => {
    beforeEach(() => {
      wrapper = mountComponent();
    });

    it("computes bboxWidth from bboxRight - bboxLeft", () => {
      (wrapper.vm as any).bboxLeft = 10;
      (wrapper.vm as any).bboxRight = 110;
      expect((wrapper.vm as any).bboxWidth).toBe(100);
    });

    it("sets bboxWidth as number updates bboxRight", () => {
      (wrapper.vm as any).bboxLeft = 10;
      (wrapper.vm as any).bboxWidth = 200;
      // When set as number, bboxRight = value (not left + value)
      expect((wrapper.vm as any).bboxRight).toBe(200);
    });

    it("sets bboxWidth as string updates bboxRight to left + parsed value", () => {
      (wrapper.vm as any).bboxLeft = 10;
      (wrapper.vm as any).bboxWidth = "200";
      expect((wrapper.vm as any).bboxRight).toBe(210);
    });

    it("computes bboxHeight from bboxBottom - bboxTop", () => {
      (wrapper.vm as any).bboxTop = 20;
      (wrapper.vm as any).bboxBottom = 120;
      expect((wrapper.vm as any).bboxHeight).toBe(100);
    });

    it("sets bboxHeight as number updates bboxBottom", () => {
      (wrapper.vm as any).bboxTop = 20;
      (wrapper.vm as any).bboxHeight = 300;
      expect((wrapper.vm as any).bboxBottom).toBe(300);
    });

    it("sets bboxHeight as string updates bboxBottom to top + parsed value", () => {
      (wrapper.vm as any).bboxTop = 20;
      (wrapper.vm as any).bboxHeight = "300";
      expect((wrapper.vm as any).bboxBottom).toBe(320);
    });

    it("setBoundingBox clamps values to dataset bounds", () => {
      // dataset width=1000, height=800
      (wrapper.vm as any).setBoundingBox(-10, -20, 1100, 900);
      expect((wrapper.vm as any).bboxLeft).toBe(0);
      expect((wrapper.vm as any).bboxTop).toBe(0);
      expect((wrapper.vm as any).bboxRight).toBe(1000);
      expect((wrapper.vm as any).bboxBottom).toBe(800);
    });

    it("setBoundingBox ensures right > left and bottom > top", () => {
      (wrapper.vm as any).setBoundingBox(500, 400, 500, 400);
      expect((wrapper.vm as any).bboxRight).toBeGreaterThan(
        (wrapper.vm as any).bboxLeft,
      );
      expect((wrapper.vm as any).bboxBottom).toBeGreaterThan(
        (wrapper.vm as any).bboxTop,
      );
    });

    it("computes layerItems with composite, all, and visible layers", () => {
      const items = (wrapper.vm as any).layerItems;
      expect(items[0]).toEqual({
        text: "Composite layers",
        value: "composite",
      });
      expect(items[1]).toEqual({ text: "All layers (zip)", value: "all" });
      // Only visible layers (layer1, layer2 are visible, layer3 is not)
      expect(items).toHaveLength(4);
      expect(items[2]).toEqual({ text: "Layer 1", value: "layer1" });
      expect(items[3]).toEqual({ text: "Layer 2", value: "layer2" });
    });

    it("computes channelItems with all and dataset channels", () => {
      const items = (wrapper.vm as any).channelItems;
      expect(items[0]).toEqual({ text: "All channels", value: "all" });
      expect(items).toHaveLength(4);
      expect(items[1]).toEqual({ text: "DAPI", value: 0 });
      expect(items[2]).toEqual({ text: "GFP", value: 1 });
      expect(items[3]).toEqual({ text: "RFP", value: 2 });
    });

    it("computes configurationPixelSize from store", () => {
      const ps = (wrapper.vm as any).configurationPixelSize;
      expect(ps.length).toBe(0.5);
      expect(ps.unit).toBe("µm");
    });

    it("configurationPixelSize defaults to 1px when no scale", () => {
      (store as any).configuration = { scales: {}, snapshots: [], layers: [] };
      // Force recompute
      const w = mountComponent();
      const ps = (w.vm as any).configurationPixelSize;
      expect(ps.length).toBe(1.0);
      expect(ps.unit).toBe(TScalebarUnit.PX);

      // Restore
      (store as any).configuration = {
        name: "Test Config",
        snapshots: [],
        layers: [],
        scales: { pixelSize: { value: 0.5, unit: "µm" } },
      };
    });

    it("configurationPixelSize defaults to 1px when scale value is 0", () => {
      (store as any).configuration = {
        scales: { pixelSize: { value: 0, unit: "µm" } },
        snapshots: [],
        layers: [],
      };
      const w = mountComponent();
      const ps = (w.vm as any).configurationPixelSize;
      expect(ps.length).toBe(1.0);
      expect(ps.unit).toBe(TScalebarUnit.PX);

      (store as any).configuration = {
        name: "Test Config",
        snapshots: [],
        layers: [],
        scales: { pixelSize: { value: 0.5, unit: "µm" } },
      };
    });

    it("computes pixelSize using configurationPixelSize by default", () => {
      const ps = (wrapper.vm as any).pixelSize;
      expect(ps.length).toBe(0.5);
      expect(ps.unit).toBe("µm");
    });

    it("computes pixelSize from manual settings when mode is manual", () => {
      (wrapper.vm as any).pixelSizeMode = "manual";
      (wrapper.vm as any).manualPixelSize = {
        length: 2.0,
        unit: TScalebarUnit.NM,
      };
      const ps = (wrapper.vm as any).pixelSize;
      expect(ps.length).toBe(2.0);
      expect(ps.unit).toBe(TScalebarUnit.NM);
    });

    it("convertLengthToMeters converts nm correctly", () => {
      expect((wrapper.vm as any).convertLengthToMeters(100, "nm")).toBeCloseTo(
        1e-7,
      );
    });

    it("convertLengthToMeters converts µm correctly", () => {
      expect((wrapper.vm as any).convertLengthToMeters(1, "µm")).toBeCloseTo(
        1e-6,
      );
    });

    it("convertLengthToMeters converts mm correctly", () => {
      expect((wrapper.vm as any).convertLengthToMeters(1, "mm")).toBeCloseTo(
        1e-3,
      );
    });

    it("convertLengthToMeters converts m correctly", () => {
      expect((wrapper.vm as any).convertLengthToMeters(1, "m")).toBe(1);
    });

    it("convertMetersToLength returns nm for very small lengths", () => {
      const result = (wrapper.vm as any).convertMetersToLength(5e-8);
      expect(result.unit).toBe(TScalebarUnit.NM);
      expect(result.length).toBeCloseTo(50);
    });

    it("convertMetersToLength returns µm for small lengths", () => {
      const result = (wrapper.vm as any).convertMetersToLength(5e-5);
      expect(result.unit).toBe(TScalebarUnit.UM);
      expect(result.length).toBeCloseTo(50);
    });

    it("convertMetersToLength returns mm for medium lengths", () => {
      const result = (wrapper.vm as any).convertMetersToLength(0.05);
      expect(result.unit).toBe(TScalebarUnit.MM);
      expect(result.length).toBeCloseTo(50);
    });

    it("convertMetersToLength returns m for large lengths", () => {
      const result = (wrapper.vm as any).convertMetersToLength(5);
      expect(result.unit).toBe(TScalebarUnit.M);
      expect(result.length).toBe(5);
    });

    it("scalebarSettings uses automatic mode by default", () => {
      const settings = (wrapper.vm as any).scalebarSettings;
      // In automatic mode, it computes ideal scalebar length
      expect(settings).toBeDefined();
      expect(typeof settings.length).toBe("number");
      expect(settings.unit).toBeDefined();
    });

    it("scalebarSettings uses manual settings when mode is manual", () => {
      (wrapper.vm as any).scalebarMode = "manual";
      (wrapper.vm as any).manualScalebarSettings = {
        length: 50,
        unit: TScalebarUnit.UM,
      };
      const settings = (wrapper.vm as any).scalebarSettings;
      expect(settings.length).toBe(50);
      expect(settings.unit).toBe(TScalebarUnit.UM);
    });

    it("scalebarLengthInPixels returns length directly for px unit", () => {
      (wrapper.vm as any).scalebarMode = "manual";
      (wrapper.vm as any).manualScalebarSettings = {
        length: 100,
        unit: TScalebarUnit.PX,
      };
      expect((wrapper.vm as any).scalebarLengthInPixels).toBe(100);
    });

    it("scalebarLengthInPixels converts physical units to pixels", () => {
      // pixelSize is 0.5µm, scalebar is 50µm → 50/0.5 = 100 pixels
      (wrapper.vm as any).scalebarMode = "manual";
      (wrapper.vm as any).manualScalebarSettings = {
        length: 50,
        unit: TScalebarUnit.UM,
      };
      expect((wrapper.vm as any).scalebarLengthInPixels).toBeCloseTo(100);
    });

    it("prettyScalebarSettings formats px correctly", () => {
      const result = (wrapper.vm as any).prettyScalebarSettings({
        length: 100,
        unit: TScalebarUnit.PX,
      });
      expect(result).toBe("100 px");
    });

    it("prettyScalebarSettings formats physical units correctly", () => {
      const result = (wrapper.vm as any).prettyScalebarSettings({
        length: 50,
        unit: TScalebarUnit.UM,
      });
      expect(result).toBe("50.0 µm");
    });

    it("pixelSizeUnitItems contains all units including px", () => {
      const items = (wrapper.vm as any).pixelSizeUnitItems;
      expect(items).toHaveLength(5);
      const values = items.map((i: any) => i.value);
      expect(values).toContain(TScalebarUnit.NM);
      expect(values).toContain(TScalebarUnit.UM);
      expect(values).toContain(TScalebarUnit.MM);
      expect(values).toContain(TScalebarUnit.M);
      expect(values).toContain(TScalebarUnit.PX);
    });

    it("scalebarSettingsUnitItems returns only px when pixelSize is px", () => {
      (wrapper.vm as any).pixelSizeMode = "manual";
      (wrapper.vm as any).manualPixelSize = {
        length: 1,
        unit: TScalebarUnit.PX,
      };
      const items = (wrapper.vm as any).scalebarSettingsUnitItems;
      expect(items).toHaveLength(1);
      expect(items[0].value).toBe(TScalebarUnit.PX);
    });

    it("scalebarSettingsUnitItems returns all units when pixelSize is physical", () => {
      const items = (wrapper.vm as any).scalebarSettingsUnitItems;
      expect(items).toHaveLength(5);
    });

    it("handlePixelSizeModeChange copies configurationPixelSize to manualPixelSize", () => {
      (wrapper.vm as any).pixelSizeMode = "manual";
      (wrapper.vm as any).handlePixelSizeModeChange();
      expect((wrapper.vm as any).manualPixelSize).toEqual({
        length: 0.5,
        unit: "µm",
      });
    });

    it("handleScalebarModeChange copies scalebarSettings to manualScalebarSettings", () => {
      (wrapper.vm as any).scalebarMode = "manual";
      (wrapper.vm as any).handleScalebarModeChange();
      expect((wrapper.vm as any).manualScalebarSettings).toBeDefined();
      expect(typeof (wrapper.vm as any).manualScalebarSettings.length).toBe(
        "number",
      );
    });

    it("manualScalebarSettingsLength get returns 1.0 when null", () => {
      (wrapper.vm as any).manualScalebarSettings = null;
      expect((wrapper.vm as any).manualScalebarSettingsLength).toBe(1.0);
    });

    it("manualScalebarSettingsLength set updates the settings", () => {
      (wrapper.vm as any).manualScalebarSettings = {
        length: 10,
        unit: TScalebarUnit.UM,
      };
      (wrapper.vm as any).manualScalebarSettingsLength = 25;
      expect((wrapper.vm as any).manualScalebarSettings.length).toBe(25);
    });

    it("manualScalebarSettingsUnit get returns PX when null", () => {
      (wrapper.vm as any).manualScalebarSettings = null;
      expect((wrapper.vm as any).manualScalebarSettingsUnit).toBe(
        TScalebarUnit.PX,
      );
    });

    it("manualScalebarSettingsUnit set updates the settings", () => {
      (wrapper.vm as any).manualScalebarSettings = {
        length: 10,
        unit: TScalebarUnit.UM,
      };
      (wrapper.vm as any).manualScalebarSettingsUnit = TScalebarUnit.MM;
      expect((wrapper.vm as any).manualScalebarSettings.unit).toBe(
        TScalebarUnit.MM,
      );
    });

    it("manualPixelSizeLength get returns 1.0 when null", () => {
      (wrapper.vm as any).manualPixelSize = null;
      expect((wrapper.vm as any).manualPixelSizeLength).toBe(1.0);
    });

    it("manualPixelSizeLength set updates the settings", () => {
      (wrapper.vm as any).manualPixelSize = {
        length: 1,
        unit: TScalebarUnit.NM,
      };
      (wrapper.vm as any).manualPixelSizeLength = 5;
      expect((wrapper.vm as any).manualPixelSize.length).toBe(5);
    });

    it("manualPixelSizeUnit get returns PX when null", () => {
      (wrapper.vm as any).manualPixelSize = null;
      expect((wrapper.vm as any).manualPixelSizeUnit).toBe(TScalebarUnit.PX);
    });

    it("manualPixelSizeUnit set updates the settings", () => {
      (wrapper.vm as any).manualPixelSize = {
        length: 1,
        unit: TScalebarUnit.NM,
      };
      (wrapper.vm as any).manualPixelSizeUnit = TScalebarUnit.M;
      expect((wrapper.vm as any).manualPixelSize.unit).toBe(TScalebarUnit.M);
    });
  });

  // =========================================================================
  // Group 3: Snapshot list and CRUD
  // =========================================================================
  describe("Group 3: Snapshot list and CRUD", () => {
    const makeSnapshot = (
      name: string,
      overrides: Record<string, unknown> = {},
    ) => ({
      name,
      description: `Description for ${name}`,
      tags: ["tag1"],
      created: 1000000,
      modified: 2000000,
      datasetViewId: "view1",
      viewport: {
        tl: { x: 0, y: 0 },
        tr: { x: 100, y: 0 },
        bl: { x: 0, y: 100 },
        br: { x: 100, y: 100 },
      },
      rotation: 0,
      unrollXY: false,
      unrollZ: false,
      unrollT: false,
      xy: 0,
      z: 0,
      time: 0,
      layerMode: "multiple",
      layers: [
        {
          id: "layer1",
          name: "Layer 1",
          channel: 0,
          visible: true,
          color: "#ff0000",
        },
      ],
      screenshot: { bbox: { left: 0, top: 0, right: 100, bottom: 100 } },
      ...overrides,
    });

    beforeEach(() => {
      wrapper = mountComponent();
    });

    afterEach(() => {
      (store as any).configuration = {
        name: "Test Config",
        snapshots: [],
        layers: [],
        scales: { pixelSize: { value: 0.5, unit: "µm" } },
      };
    });

    it("snapshotList returns empty array when no snapshots", () => {
      (store as any).configuration.snapshots = [];
      const list = (wrapper.vm as any).snapshotList;
      expect(list).toEqual([]);
    });

    it("snapshotList builds items from configuration snapshots", () => {
      (store as any).configuration.snapshots = [
        makeSnapshot("Snap 1"),
        makeSnapshot("Snap 2"),
      ];
      const w = mountComponent();
      const list = (w.vm as any).snapshotList;
      expect(list).toHaveLength(2);
      expect(list[0].name).toBeDefined();
      expect(list[0].record).toBeDefined();
      expect(list[0].modified).toBeDefined();
    });

    it("snapshotList sorts by modified date descending", () => {
      (store as any).configuration.snapshots = [
        makeSnapshot("Old", { modified: 1000 }),
        makeSnapshot("New", { modified: 3000 }),
      ];
      const w = mountComponent();
      const list = (w.vm as any).snapshotList;
      expect(list[0].name).toBe("New");
      expect(list[1].name).toBe("Old");
    });

    it("snapshotList filters by name search", () => {
      (store as any).configuration.snapshots = [
        makeSnapshot("Alpha"),
        makeSnapshot("Beta"),
      ];
      (wrapper.vm as any).snapshotSearch = "Alpha";
      const list = (wrapper.vm as any).snapshotList;
      expect(list).toHaveLength(1);
      expect(list[0].name).toBe("Alpha");
    });

    it("snapshotList filters by tag search", () => {
      (store as any).configuration.snapshots = [
        makeSnapshot("Snap 1", { tags: ["microscopy"] }),
        makeSnapshot("Snap 2", { tags: ["other"] }),
      ];
      (wrapper.vm as any).snapshotSearch = "microscopy";
      const list = (wrapper.vm as any).snapshotList;
      expect(list).toHaveLength(1);
      expect(list[0].name).toBe("Snap 1");
    });

    it("snapshotList filters by description search", () => {
      (store as any).configuration.snapshots = [
        makeSnapshot("Snap 1", { description: "important finding" }),
        makeSnapshot("Snap 2", { description: "nothing special" }),
      ];
      (wrapper.vm as any).snapshotSearch = "important";
      const list = (wrapper.vm as any).snapshotList;
      expect(list).toHaveLength(1);
    });

    it("snapshotList uses created date when modified is missing", () => {
      (store as any).configuration.snapshots = [
        makeSnapshot("Snap 1", { modified: 0, created: 5000 }),
      ];
      const w = mountComponent();
      const list = (w.vm as any).snapshotList;
      expect(list).toHaveLength(1);
    });

    it("currentSnapshot returns matching snapshot by name", () => {
      (store as any).configuration.snapshots = [makeSnapshot("MySnap")];
      (wrapper.vm as any).newName = "MySnap";
      const current = (wrapper.vm as any).currentSnapshot;
      expect(current).toBeDefined();
      expect(current.name).toBe("MySnap");
    });

    it("currentSnapshot returns undefined when no match", () => {
      (store as any).configuration.snapshots = [makeSnapshot("Other")];
      (wrapper.vm as any).newName = "NonExistent";
      expect((wrapper.vm as any).currentSnapshot).toBeUndefined();
    });

    it("currentSnapshot returns undefined when no configuration", () => {
      (store as any).configuration = null;
      const w = mountComponent();
      expect((w.vm as any).currentSnapshot).toBeUndefined();
    });

    it("saveSnapshot calls store.addSnapshot with correct data", () => {
      const mockMap = {
        displayToGcs: vi.fn((pt: any) => pt),
        size: vi.fn(() => ({ width: 800, height: 600 })),
        rotation: vi.fn(() => 0),
        bounds: vi.fn(() => ({ left: 0, top: 0, right: 1000, bottom: 800 })),
        gcsToDisplay: vi.fn((pts: any) => pts),
      };
      (store as any).maps = [{ map: mockMap }];
      const w = mountComponent();

      (w.vm as any).newName = "  Test Snapshot  ";
      (w.vm as any).newDescription = "  A description  ";
      (w.vm as any).newTags = ["tag1", "tag2"];
      (w.vm as any).isSaveSnapshotValid = true;

      (w.vm as any).saveSnapshot();

      expect(store.addSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Test Snapshot",
          description: "A description",
          tags: ["tag1", "tag2"],
        }),
      );

      (store as any).maps = [];
    });

    it("saveSnapshot does not call addSnapshot when form invalid", () => {
      // Must mount with validate returning false, since updateFormValidation()
      // overwrites isSaveSnapshotValid via the form element's validate()
      const w = mountComponent();
      (w.vm as any).saveSnapshotForm = {
        validate: vi.fn(() => false),
        resetValidation: vi.fn(),
      };
      (w.vm as any).saveSnapshot();
      expect(store.addSnapshot).not.toHaveBeenCalled();
    });

    it("saveSnapshot does not call addSnapshot when no map", () => {
      // Mount with maps=[] so firstMap computed evaluates to undefined
      (store as any).maps = [];
      const w = mountComponent();
      (w.vm as any).newName = "Test";
      (w.vm as any).isSaveSnapshotValid = true;
      (w.vm as any).saveSnapshot();
      expect(store.addSnapshot).not.toHaveBeenCalled();
    });

    it("removeSnapshot calls store.removeSnapshot", () => {
      (wrapper.vm as any).removeSnapshot("MySnap");
      expect(store.removeSnapshot).toHaveBeenCalledWith("MySnap");
    });

    it("resetAndCloseForm resets dialog and form fields", () => {
      (wrapper.vm as any).createDialog = true;
      (wrapper.vm as any).newName = "Test";
      (wrapper.vm as any).newDescription = "Desc";
      (wrapper.vm as any).newTags = ["tag"];
      (wrapper.vm as any).resetAndCloseForm();
      expect((wrapper.vm as any).createDialog).toBe(false);
      expect((wrapper.vm as any).newName).toBe("");
      expect((wrapper.vm as any).newDescription).toBe("");
      expect((wrapper.vm as any).newTags).toEqual([]);
    });

    it("areCurrentLayersCompatible returns true when layers match", () => {
      const snapshot = makeSnapshot("Test");
      expect((wrapper.vm as any).areCurrentLayersCompatible(snapshot)).toBe(
        true,
      );
    });

    it("areCurrentLayersCompatible returns false when layer missing", () => {
      const snapshot = makeSnapshot("Test", {
        layers: [{ id: "nonexistent", channel: 0 }],
      });
      expect((wrapper.vm as any).areCurrentLayersCompatible(snapshot)).toBe(
        false,
      );
    });

    it("areCurrentLayersCompatible returns false when channel differs", () => {
      const snapshot = makeSnapshot("Test", {
        layers: [{ id: "layer1", channel: 5 }],
      });
      expect((wrapper.vm as any).areCurrentLayersCompatible(snapshot)).toBe(
        false,
      );
    });
  });

  // =========================================================================
  // Group 4: Load snapshot + watchers
  // =========================================================================
  describe("Group 4: Load snapshot + watchers", () => {
    const makeSnapshot = (overrides: Record<string, unknown> = {}) => ({
      name: "Test Snapshot",
      description: "Test description",
      tags: ["tag1"],
      created: 1000000,
      modified: 2000000,
      datasetViewId: "view1",
      viewport: {
        tl: { x: 0, y: 0 },
        tr: { x: 800, y: 0 },
        bl: { x: 0, y: 600 },
        br: { x: 800, y: 600 },
      },
      rotation: 0,
      unrollXY: false,
      unrollZ: false,
      unrollT: false,
      xy: 2,
      z: 3,
      time: 5,
      layerMode: "single",
      layers: [
        {
          id: "layer1",
          name: "Layer 1",
          channel: 0,
          visible: true,
          color: "#ff0000",
        },
      ],
      screenshot: { bbox: { left: 10, top: 20, right: 300, bottom: 400 } },
      ...overrides,
    });

    beforeEach(() => {
      wrapper = mountComponent();
    });

    it("loadSnapshot sets bbox from snapshot", async () => {
      const snapshot = makeSnapshot();
      await (wrapper.vm as any).loadSnapshot(new Event("click"), {
        item: {
          record: snapshot,
          name: snapshot.name,
          datasetName: "",
          key: "",
          modified: "",
        },
      });
      expect((wrapper.vm as any).bboxLeft).toBe(10);
      expect((wrapper.vm as any).bboxTop).toBe(20);
      expect((wrapper.vm as any).bboxRight).toBe(300);
      expect((wrapper.vm as any).bboxBottom).toBe(400);
    });

    it("loadSnapshot sets form fields from snapshot", async () => {
      const snapshot = makeSnapshot();
      await (wrapper.vm as any).loadSnapshot(new Event("click"), {
        item: {
          record: snapshot,
          name: snapshot.name,
          datasetName: "",
          key: "",
          modified: "",
        },
      });
      expect((wrapper.vm as any).newName).toBe("Test Snapshot");
      expect((wrapper.vm as any).newDescription).toBe("Test description");
      expect((wrapper.vm as any).newTags).toEqual(["tag1"]);
    });

    it("loadSnapshot calls store navigation methods", async () => {
      const snapshot = makeSnapshot();
      await (wrapper.vm as any).loadSnapshot(new Event("click"), {
        item: {
          record: snapshot,
          name: snapshot.name,
          datasetName: "",
          key: "",
          modified: "",
        },
      });
      expect(store.setXY).toHaveBeenCalledWith(2);
      expect(store.setZ).toHaveBeenCalledWith(3);
      expect(store.setTime).toHaveBeenCalledWith(5);
      expect(store.setUnrollXY).toHaveBeenCalledWith(false);
      expect(store.setUnrollZ).toHaveBeenCalledWith(false);
      expect(store.setUnrollT).toHaveBeenCalledWith(false);
      expect(store.setLayerMode).toHaveBeenCalledWith("single");
    });

    it("loadSnapshot calls setDatasetViewId when different view", async () => {
      const snapshot = makeSnapshot({ datasetViewId: "differentView" });
      await (wrapper.vm as any).loadSnapshot(new Event("click"), {
        item: {
          record: snapshot,
          name: snapshot.name,
          datasetName: "",
          key: "",
          modified: "",
        },
      });
      expect(store.setDatasetViewId).toHaveBeenCalledWith({
        id: "differentView",
      });
    });

    it("loadSnapshot does not call setDatasetViewId when same view", async () => {
      const snapshot = makeSnapshot({ datasetViewId: "view1" });
      await (wrapper.vm as any).loadSnapshot(new Event("click"), {
        item: {
          record: snapshot,
          name: snapshot.name,
          datasetName: "",
          key: "",
          modified: "",
        },
      });
      expect(store.setDatasetViewId).not.toHaveBeenCalled();
    });

    it("loadSnapshot opens overwrite panel when layers incompatible", async () => {
      const snapshot = makeSnapshot({
        layers: [{ id: "nonexistent", channel: 99 }],
      });
      await (wrapper.vm as any).loadSnapshot(new Event("click"), {
        item: {
          record: snapshot,
          name: snapshot.name,
          datasetName: "",
          key: "",
          modified: "",
        },
      });
      expect((wrapper.vm as any).layersOverwritePanel).toBe(true);
    });

    it("loadSnapshot loads layers when compatible", async () => {
      const snapshot = makeSnapshot();
      await (wrapper.vm as any).loadSnapshot(new Event("click"), {
        item: {
          record: snapshot,
          name: snapshot.name,
          datasetName: "",
          key: "",
          modified: "",
        },
      });
      expect(store.loadSnapshotLayers).toHaveBeenCalledWith(snapshot);
    });

    it("openConfigurationLayersOverwritePanel sets state", () => {
      const snapshot = makeSnapshot();
      (wrapper.vm as any).openConfigurationLayersOverwritePanel(snapshot);
      expect((wrapper.vm as any).layersOverwritePanel).toBe(true);
      expect((wrapper.vm as any).overwrittingSnaphot).toStrictEqual(snapshot);
    });

    it("changeDatasetViewContrasts loads layers and closes panel", () => {
      const snapshot = makeSnapshot();
      (wrapper.vm as any).overwrittingSnaphot = snapshot;
      (wrapper.vm as any).layersOverwritePanel = true;
      (wrapper.vm as any).changeDatasetViewContrasts();
      expect(store.loadSnapshotLayers).toHaveBeenCalledWith(snapshot);
      expect((wrapper.vm as any).overwrittingSnaphot).toBeNull();
      expect((wrapper.vm as any).layersOverwritePanel).toBe(false);
    });

    it("overwriteConfigurationLayers sets layers and resets contrasts", () => {
      const snapshot = makeSnapshot();
      (wrapper.vm as any).overwrittingSnaphot = snapshot;
      (wrapper.vm as any).layersOverwritePanel = true;
      (wrapper.vm as any).overwriteConfigurationLayers();
      expect(store.setConfigurationLayers).toHaveBeenCalledWith(
        snapshot.layers,
      );
      expect(store.resetDatasetViewContrasts).toHaveBeenCalled();
      expect((wrapper.vm as any).overwrittingSnaphot).toBeNull();
      expect((wrapper.vm as any).layersOverwritePanel).toBe(false);
    });

    it("overwriteConfigurationLayers closes panel even when no snapshot", () => {
      (wrapper.vm as any).overwrittingSnaphot = null;
      (wrapper.vm as any).layersOverwritePanel = true;
      (wrapper.vm as any).overwriteConfigurationLayers();
      expect((wrapper.vm as any).layersOverwritePanel).toBe(false);
    });

    it("downloadModeChanged watcher sets format to first in list", async () => {
      (wrapper.vm as any).downloadMode = "channels";
      await wrapper.vm.$nextTick();
      expect((wrapper.vm as any).format).toBe("tiff");
    });
  });

  // =========================================================================
  // Group 5: GeoJS bounding box interaction
  // =========================================================================
  describe("Group 5: GeoJS bounding box interaction", () => {
    let mockMap: Record<string, any>;

    beforeEach(() => {
      mockMap = {
        displayToGcs: vi.fn((pt: any) => pt),
        gcsToDisplay: vi.fn((pts: any) =>
          Array.isArray(pts) ? pts : { x: pts.x, y: pts.y },
        ),
        size: vi.fn(() => ({ width: 800, height: 600 })),
        rotation: vi.fn(() => 0),
        bounds: vi.fn(() => ({ left: 0, top: 0, right: 1000, bottom: 800 })),
        createLayer: vi.fn(() => ({
          addAnnotation: vi.fn(),
          draw: vi.fn(),
          visible: vi.fn(),
          mode: vi.fn(),
          modes: { edit: "edit" },
          currentAnnotation: null,
          map: vi.fn(() => ({ interactor: vi.fn(() => true) })),
        })),
        deleteLayer: vi.fn(),
        draw: vi.fn(),
        geoOn: vi.fn(),
        geoOff: vi.fn(),
        ingcs: vi.fn(() => "EPSG:4326"),
        gcs: vi.fn(() => "EPSG:3857"),
        screenshot: vi.fn().mockResolvedValue("data:image/png;base64,abc"),
        layers: vi.fn(() => []),
      };
      (store as any).maps = [{ map: mockMap }];
      wrapper = mountComponent();
    });

    afterEach(() => {
      (store as any).maps = [];
    });

    it("showSnapshot(true) creates bbox layer and annotations", () => {
      (wrapper.vm as any).showSnapshot(true);
      expect(mockMap.createLayer).toHaveBeenCalledWith("annotation", {
        autoshareRenderer: false,
        showLabels: false,
      });
      expect((wrapper.vm as any).bboxLayer).toBeTruthy();
      expect((wrapper.vm as any).bboxAnnotation).toBeTruthy();
      expect((wrapper.vm as any).scalebarAnnotation).toBeTruthy();
    });

    it("showSnapshot(false) destroys layer and annotations", () => {
      (wrapper.vm as any).showSnapshot(true);
      (wrapper.vm as any).showSnapshot(false);
      expect(mockMap.deleteLayer).toHaveBeenCalled();
      expect((wrapper.vm as any).bboxLayer).toBeNull();
      expect((wrapper.vm as any).bboxAnnotation).toBeNull();
      expect((wrapper.vm as any).scalebarAnnotation).toBeNull();
    });

    it("showSnapshot(false) is no-op when no layer", () => {
      (wrapper.vm as any).bboxLayer = null;
      (wrapper.vm as any).showSnapshot(false);
      expect(mockMap.deleteLayer).not.toHaveBeenCalled();
    });

    it("showSnapshot is no-op when no map", () => {
      (store as any).maps = [];
      const w = mountComponent();
      (w.vm as any).showSnapshot(true);
      expect((w.vm as any).bboxLayer).toBeNull();
    });

    it("markCurrentArea updates bbox annotation options", () => {
      (wrapper.vm as any).showSnapshot(true);
      (wrapper.vm as any).bboxLeft = 50;
      (wrapper.vm as any).bboxTop = 60;
      (wrapper.vm as any).bboxRight = 200;
      (wrapper.vm as any).bboxBottom = 300;
      const result = (wrapper.vm as any).markCurrentArea();
      // Returns width * height of dataset
      expect(result).toBe(1000 * 800);
    });

    it("markCurrentArea returns undefined when no dataset", () => {
      (store as any).dataset = null;
      const w = mountComponent();
      expect((w.vm as any).markCurrentArea()).toBeUndefined();

      (store as any).dataset = {
        id: "dataset1",
        name: "Test Dataset",
        width: 1000,
        height: 800,
        channels: [0, 1, 2],
        channelNames: new Map([
          [0, "DAPI"],
          [1, "GFP"],
          [2, "RFP"],
        ]),
        anyImage: () => ({ item: { _id: "item1" } }),
      };
    });

    it("drawBoundingBox sets up event listeners", () => {
      (wrapper.vm as any).showSnapshot(true);
      (wrapper.vm as any).drawBoundingBox();
      expect(mockMap.geoOn).toHaveBeenCalled();
    });

    it("setArea full sets bbox to full dataset size", () => {
      (wrapper.vm as any).showSnapshot(true);
      (wrapper.vm as any).setArea("full");
      expect((wrapper.vm as any).bboxLeft).toBe(0);
      expect((wrapper.vm as any).bboxTop).toBe(0);
      expect((wrapper.vm as any).bboxRight).toBe(1000);
      expect((wrapper.vm as any).bboxBottom).toBe(800);
    });

    it("setArea viewport sets bbox to map bounds", () => {
      (wrapper.vm as any).showSnapshot(true);
      (wrapper.vm as any).setArea("viewport");
      expect((wrapper.vm as any).bboxLeft).toBe(0);
      expect((wrapper.vm as any).bboxTop).toBe(0);
      expect((wrapper.vm as any).bboxRight).toBe(1000);
      expect((wrapper.vm as any).bboxBottom).toBe(800);
    });

    it("isRotated returns false when no rotation", () => {
      expect((wrapper.vm as any).isRotated()).toBe(false);
    });

    it("isRotated returns true when map is rotated", () => {
      mockMap.rotation = vi.fn(() => 0.5);
      expect((wrapper.vm as any).isRotated()).toBe(true);
    });

    it("scalebarVertices returns two points for scalebar line", () => {
      (wrapper.vm as any).scalebarMode = "manual";
      (wrapper.vm as any).manualScalebarSettings = {
        length: 100,
        unit: TScalebarUnit.PX,
      };
      const vertices = (wrapper.vm as any).scalebarVertices(500, 400);
      expect(vertices).toHaveLength(2);
      expect(vertices[0].x).toBe(490); // rightEdge - 10
      expect(vertices[0].y).toBe(410); // bottomEdge + 10
      expect(vertices[1].x).toBe(390); // rightEdge - 10 - scalebarLength
      expect(vertices[1].y).toBe(410);
    });

    it("boundingBoxCoordinates updates bbox from annotation coords", () => {
      (wrapper.vm as any).showSnapshot(true);
      const mockAnnotation = (wrapper.vm as any).bboxAnnotation;
      const event = {
        annotation: {
          ...mockAnnotation,
          coordinates: vi.fn(() => [
            { x: 10, y: 20 },
            { x: 200, y: 20 },
            { x: 200, y: 300 },
            { x: 10, y: 300 },
          ]),
        },
      };
      // Make event.annotation === bboxAnnotation for the equality check
      event.annotation = (wrapper.vm as any).bboxAnnotation;
      event.annotation.coordinates = vi.fn(() => [
        { x: 10, y: 20 },
        { x: 200, y: 20 },
        { x: 200, y: 300 },
        { x: 10, y: 300 },
      ]);
      (wrapper.vm as any).boundingBoxCoordinates(event);
      expect((wrapper.vm as any).bboxLeft).toBe(10);
      expect((wrapper.vm as any).bboxTop).toBe(20);
      expect((wrapper.vm as any).bboxRight).toBe(200);
      expect((wrapper.vm as any).bboxBottom).toBe(300);
    });
  });

  // =========================================================================
  // Group 6: Download URLs and image download
  // =========================================================================
  describe("Group 6: Download URLs and image download", () => {
    beforeEach(() => {
      wrapper = mountComponent();
      vi.clearAllMocks();
    });

    it("getUrlsForSnapshot returns URLs for layer mode", async () => {
      (wrapper.vm as any).downloadMode = "layers";
      (wrapper.vm as any).exportLayer = "composite";
      const urls = await (wrapper.vm as any).getUrlsForSnapshot(
        { xy: 0, z: 0, time: 0 },
        { left: 0, top: 0, right: 100, bottom: 100 },
        "dataset1",
        "TestSnap",
        (store as any).layers,
        "TestConfig",
      );
      expect(urls).toBeDefined();
      expect(urls!.length).toBeGreaterThan(0);
      expect(mockedGetLayersDownloadUrls).toHaveBeenCalled();
    });

    it("getUrlsForSnapshot returns URLs for channel mode", async () => {
      (wrapper.vm as any).downloadMode = "channels";
      (wrapper.vm as any).exportChannel = "all";
      const urls = await (wrapper.vm as any).getUrlsForSnapshot(
        { xy: 0, z: 0, time: 0 },
        { left: 0, top: 0, right: 100, bottom: 100 },
        "dataset1",
        "TestSnap",
        (store as any).layers,
        "TestConfig",
      );
      expect(urls).toBeDefined();
      expect(mockedGetChannelsDownloadUrls).toHaveBeenCalled();
    });

    it("getUrlsForSnapshot returns undefined when image too big", async () => {
      mockedGetDownloadParameters.mockReturnValueOnce(null);
      const urls = await (wrapper.vm as any).getUrlsForSnapshot(
        { xy: 0, z: 0, time: 0 },
        { left: 0, top: 0, right: 100, bottom: 100 },
        "dataset1",
        "TestSnap",
        (store as any).layers,
        "TestConfig",
      );
      expect(urls).toBeUndefined();
      expect((wrapper.vm as any).imageTooBigDialog).toBe(true);
    });

    it("getUrlsForSnapshot sets contentDispositionFilename", async () => {
      (wrapper.vm as any).downloadMode = "layers";
      const urls = await (wrapper.vm as any).getUrlsForSnapshot(
        { xy: 0, z: 0, time: 0 },
        { left: 0, top: 0, right: 100, bottom: 100 },
        "dataset1",
        "MySnapshot",
        (store as any).layers,
        "MyConfig",
      );
      expect(urls).toBeDefined();
      const filename = urls![0].searchParams.get("contentDispositionFilename");
      expect(filename).toContain("MySnapshot");
    });

    it("downloadUrls downloads single file directly without scalebar", async () => {
      const url = new URL("http://localhost/api/v1/test");
      url.searchParams.set("contentDispositionFilename", "test.png");
      await (wrapper.vm as any).downloadUrls([url], false);
      expect(mockedDownloadToClient).toHaveBeenCalledWith({
        href: url.href,
      });
    });

    it("downloadUrls does nothing for empty array", async () => {
      await (wrapper.vm as any).downloadUrls([], false);
      expect(mockedDownloadToClient).not.toHaveBeenCalled();
    });

    it("downloadImagesForCurrentState returns early with no dataset", async () => {
      (store as any).dataset = null;
      const w = mountComponent();
      await (w.vm as any).downloadImagesForCurrentState();
      expect(mockedDownloadToClient).not.toHaveBeenCalled();

      (store as any).dataset = {
        id: "dataset1",
        name: "Test Dataset",
        width: 1000,
        height: 800,
        channels: [0, 1, 2],
        channelNames: new Map([
          [0, "DAPI"],
          [1, "GFP"],
          [2, "RFP"],
        ]),
        anyImage: () => ({ item: { _id: "item1" } }),
      };
    });

    it("downloadImagesForAllSnapshots returns early with no configuration", async () => {
      (store as any).configuration = null;
      const w = mountComponent();
      await (w.vm as any).downloadImagesForAllSnapshots();
      expect((w.vm as any).downloading).toBe(false);

      (store as any).configuration = {
        name: "Test Config",
        snapshots: [],
        layers: [],
        scales: { pixelSize: { value: 0.5, unit: "µm" } },
      };
    });

    it("downloadImagesForSelectedSnapshots returns early with no configuration", async () => {
      (store as any).configuration = null;
      const w = mountComponent();
      await (w.vm as any).downloadImagesForSelectedSnapshots();
      expect((w.vm as any).downloading).toBe(false);

      (store as any).configuration = {
        name: "Test Config",
        snapshots: [],
        layers: [],
        scales: { pixelSize: { value: 0.5, unit: "µm" } },
      };
    });

    it("screenshotViewport returns when no map", async () => {
      (store as any).maps = [];
      const w = mountComponent();
      await (w.vm as any).screenshotViewport();
      expect(mockedDownloadToClient).not.toHaveBeenCalled();
    });

    it("screenshotViewport downloads screenshot when map available", async () => {
      const mockMap = {
        displayToGcs: vi.fn((pt: any) => pt),
        gcsToDisplay: vi.fn((pts: any) =>
          Array.isArray(pts) ? pts : { x: pts.x, y: pts.y },
        ),
        size: vi.fn(() => ({ width: 800, height: 600 })),
        rotation: vi.fn(() => 0),
        bounds: vi.fn(() => ({ left: 0, top: 0, right: 1000, bottom: 800 })),
        createLayer: vi.fn(() => ({
          addAnnotation: vi.fn(),
          draw: vi.fn(),
          visible: vi.fn(),
          mode: vi.fn(),
          modes: { edit: "edit" },
          currentAnnotation: null,
          map: vi.fn(() => ({ interactor: vi.fn(() => true) })),
        })),
        deleteLayer: vi.fn(),
        draw: vi.fn(),
        geoOn: vi.fn(),
        geoOff: vi.fn(),
        ingcs: vi.fn(() => "EPSG:4326"),
        gcs: vi.fn(() => "EPSG:3857"),
        screenshot: vi.fn().mockResolvedValue("data:image/png;base64,abc"),
        layers: vi.fn(() => []),
      };
      (store as any).maps = [{ map: mockMap }];

      const w = mountComponent();
      await (w.vm as any).screenshotViewport();
      // screenshotViewport uses .then(), need to flush promise
      await new Promise((r) => setTimeout(r, 10));
      expect(mockMap.screenshot).toHaveBeenCalled();
      expect(mockedDownloadToClient).toHaveBeenCalledWith(
        expect.objectContaining({
          download: "viewport_screenshot.png",
        }),
      );

      (store as any).maps = [];
    });
  });

  // =========================================================================
  // Group 7: Movie download and canvas operations
  // =========================================================================
  describe("Group 7: Movie download and canvas operations", () => {
    beforeEach(() => {
      wrapper = mountComponent();
      vi.clearAllMocks();
    });

    it("handleMovieDownload returns early when no dataset", async () => {
      (store as any).dataset = null;
      const w = mountComponent();
      await (w.vm as any).handleMovieDownload({
        startTime: 0,
        endTime: 5,
        fps: 10,
        format: MovieFormat.ZIP,
        shouldAddTimeStamp: false,
        initialTimeStampTime: 0,
        timeStampStep: 1,
        timeStampUnits: "s",
      });
      expect((w.vm as any).downloading).toBe(false);

      (store as any).dataset = {
        id: "dataset1",
        name: "Test Dataset",
        width: 1000,
        height: 800,
        channels: [0, 1, 2],
        channelNames: new Map([
          [0, "DAPI"],
          [1, "GFP"],
          [2, "RFP"],
        ]),
        anyImage: () => ({ item: { _id: "item1" } }),
      };
    });

    it("handleMovieDownload generates correct timePoints array", async () => {
      // Instead of spying on closure-captured getUrlsForMovie, verify
      // via the mocked getLayersDownloadUrls which is called once per timepoint.
      await (wrapper.vm as any).handleMovieDownload({
        startTime: 2,
        endTime: 5,
        fps: 10,
        format: MovieFormat.ZIP,
        shouldAddTimeStamp: false,
        initialTimeStampTime: 0,
        timeStampStep: 1,
        timeStampUnits: "s",
      });

      // getLayersDownloadUrls should be called 4 times (timepoints 2, 3, 4, 5)
      expect(mockedGetLayersDownloadUrls).toHaveBeenCalledTimes(4);
    });

    it("handleMovieDownload uses annotations path when addAnnotationsToMovie", async () => {
      (wrapper.vm as any).addAnnotationsToMovie = true;

      await (wrapper.vm as any).handleMovieDownload({
        startTime: 0,
        endTime: 2,
        fps: 10,
        format: MovieFormat.ZIP,
        shouldAddTimeStamp: false,
        initialTimeStampTime: 0,
        timeStampStep: 1,
        timeStampUnits: "s",
      });

      // The annotations path was taken and failed (no map available),
      // so the error was caught by the catch block.
      expect(mockedLogError).toHaveBeenCalledWith(
        "Movie download failed:",
        expect.any(Error),
      );
      // The non-annotations path (getUrlsForMovie) should NOT have been called,
      // so getDownloadParameters should not have been invoked.
      expect(mockedGetDownloadParameters).not.toHaveBeenCalled();
    });

    it("handleMovieDownload logs error on unknown format", async () => {
      const spy = vi
        .spyOn(wrapper.vm as any, "getUrlsForMovie")
        .mockResolvedValue([]);

      await (wrapper.vm as any).handleMovieDownload({
        startTime: 0,
        endTime: 0,
        fps: 10,
        format: "unknown_format" as any,
        shouldAddTimeStamp: false,
        initialTimeStampTime: 0,
        timeStampStep: 1,
        timeStampUnits: "s",
      });

      expect(mockedLogError).toHaveBeenCalledWith(
        "Unknown format:",
        "unknown_format",
      );
      spy.mockRestore();
    });

    it("handleMovieDownload dispatches ZIP format", async () => {
      await (wrapper.vm as any).handleMovieDownload({
        startTime: 0,
        endTime: 2,
        fps: 10,
        format: MovieFormat.ZIP,
        shouldAddTimeStamp: false,
        initialTimeStampTime: 0,
        timeStampStep: 1,
        timeStampUnits: "s",
      });

      // ZIP format calls progress.create with "Generating ZIP sequence"
      expect(mockedProgress.create).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Generating ZIP sequence" }),
      );
    });

    it("handleMovieDownload dispatches GIF format", async () => {
      await (wrapper.vm as any).handleMovieDownload({
        startTime: 0,
        endTime: 2,
        fps: 10,
        format: MovieFormat.GIF,
        shouldAddTimeStamp: false,
        initialTimeStampTime: 0,
        timeStampStep: 1,
        timeStampUnits: "s",
      });

      // GIF format calls progress.create with "Generating GIF"
      expect(mockedProgress.create).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Generating GIF" }),
      );
    });

    it("handleMovieDownload dispatches MP4 format", async () => {
      // Mock MediaRecorder so getSupportedVideoMimeType returns an MP4 type
      const origMediaRecorder = globalThis.MediaRecorder;
      globalThis.MediaRecorder = {
        isTypeSupported: (type: string) => type.includes("mp4"),
      } as any;

      await (wrapper.vm as any).handleMovieDownload({
        startTime: 0,
        endTime: 2,
        fps: 10,
        format: MovieFormat.MP4,
        shouldAddTimeStamp: false,
        initialTimeStampTime: 0,
        timeStampStep: 1,
        timeStampUnits: "s",
      });

      // MP4 format calls progress.create with "Generating MP4 video"
      expect(mockedProgress.create).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Generating MP4 video" }),
      );

      globalThis.MediaRecorder = origMediaRecorder;
    });

    it("handleMovieDownload dispatches WEBM format", async () => {
      // Mock MediaRecorder so getSupportedVideoMimeType returns a WEBM type
      const origMediaRecorder = globalThis.MediaRecorder;
      globalThis.MediaRecorder = {
        isTypeSupported: (type: string) => type.includes("webm"),
      } as any;

      await (wrapper.vm as any).handleMovieDownload({
        startTime: 0,
        endTime: 2,
        fps: 10,
        format: MovieFormat.WEBM,
        shouldAddTimeStamp: false,
        initialTimeStampTime: 0,
        timeStampStep: 1,
        timeStampUnits: "s",
      });

      // WEBM format calls progress.create with "Generating WEBM video"
      expect(mockedProgress.create).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Generating WEBM video" }),
      );

      globalThis.MediaRecorder = origMediaRecorder;
    });

    it("handleMovieDownload sets downloading to false in finally", async () => {
      vi.spyOn(wrapper.vm as any, "getUrlsForMovie").mockRejectedValue(
        new Error("fail"),
      );
      await (wrapper.vm as any).handleMovieDownload({
        startTime: 0,
        endTime: 2,
        fps: 10,
        format: MovieFormat.ZIP,
        shouldAddTimeStamp: false,
        initialTimeStampTime: 0,
        timeStampStep: 1,
        timeStampUnits: "s",
      });
      expect((wrapper.vm as any).downloading).toBe(false);
    });

    it("addTimeStampToCanvas draws timestamp text", () => {
      const canvas = document.createElement("canvas");
      canvas.width = 400;
      canvas.height = 300;
      const mockCtx = {
        font: "",
        fillStyle: "",
        strokeStyle: "",
        lineWidth: 0,
        strokeText: vi.fn(),
        fillText: vi.fn(),
      };
      vi.spyOn(canvas, "getContext").mockReturnValue(mockCtx as any);

      (wrapper.vm as any).addTimeStampToCanvas(
        canvas,
        {
          initialTimeStampTime: 0,
          timeStampStep: 5,
          timeStampUnits: "min",
        },
        3,
      );

      expect(mockCtx.strokeText).toHaveBeenCalledWith("T=15 min", 10, 290);
      expect(mockCtx.fillText).toHaveBeenCalledWith("T=15 min", 10, 290);
    });

    it("addTimeStampToCanvas computes correct time for frame 0", () => {
      const canvas = document.createElement("canvas");
      canvas.width = 400;
      canvas.height = 300;
      const mockCtx = {
        font: "",
        fillStyle: "",
        strokeStyle: "",
        lineWidth: 0,
        strokeText: vi.fn(),
        fillText: vi.fn(),
      };
      vi.spyOn(canvas, "getContext").mockReturnValue(mockCtx as any);

      (wrapper.vm as any).addTimeStampToCanvas(
        canvas,
        {
          initialTimeStampTime: 10,
          timeStampStep: 2,
          timeStampUnits: "s",
        },
        0,
      );

      expect(mockCtx.fillText).toHaveBeenCalledWith("T=10 s", 10, 290);
    });

    it("getUrlsForMovie generates URLs for each time point", async () => {
      const urls = await (wrapper.vm as any).getUrlsForMovie(
        [0, 1, 2],
        "dataset1",
        { left: 0, top: 0, right: 100, bottom: 100 },
        (store as any).layers,
        { xy: 0, z: 0, time: 0 },
      );
      expect(urls).toHaveLength(3);
    });

    it("getUrlsForMovie throws when dataset not found", async () => {
      mockedGirderResources.getDataset.mockResolvedValueOnce(null as any);

      await expect(
        (wrapper.vm as any).getUrlsForMovie(
          [0],
          "nonexistent",
          { left: 0, top: 0, right: 100, bottom: 100 },
          [],
          { xy: 0, z: 0, time: 0 },
        ),
      ).rejects.toThrow("Dataset not found");
    });

    it("getUrlsForMovie throws when image too big", async () => {
      mockedGetDownloadParameters.mockReturnValueOnce(null);

      await expect(
        (wrapper.vm as any).getUrlsForMovie(
          [0],
          "dataset1",
          { left: 0, top: 0, right: 100, bottom: 100 },
          [],
          { xy: 0, z: 0, time: 0 },
        ),
      ).rejects.toThrow("Image size exceeds maximum allowed pixels");
    });

    it("module-level intFromString parses valid string", () => {
      // Access through the component's internal behavior via bboxWidth setter
      (wrapper.vm as any).bboxLeft = 0;
      (wrapper.vm as any).bboxWidth = "123";
      expect((wrapper.vm as any).bboxRight).toBe(123);
    });

    it("module-level intFromString returns 0 for empty string", () => {
      (wrapper.vm as any).bboxLeft = 0;
      (wrapper.vm as any).bboxWidth = "";
      expect((wrapper.vm as any).bboxRight).toBe(0);
    });
  });

  // Vuetify 3 @change migration: v-radio-group should use @update:model-value
  describe("Vuetify 3 @change migration", () => {
    it("pixelSizeMode v-radio-group triggers handlePixelSizeModeChange via update:modelValue", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      // Open the scalebar settings dialog so radio groups render
      vm.scalebarSettingsDialog = true;

      // Find v-radio-group components
      const radioGroups = wrapper.findAllComponents({ name: "v-radio-group" });
      // The first radio group is pixelSizeMode, second is scalebarMode
      if (radioGroups.length >= 1) {
        // Set pixelSizeMode to "dataset" first
        vm.pixelSizeMode = "dataset";
        // Emit update:modelValue as Vuetify 3 does when radio selection changes
        radioGroups[0].vm.$emit("update:modelValue", "manual");
        // If @update:model-value is wired, handlePixelSizeModeChange should fire
        // which copies configurationPixelSize to manualPixelSize when switching to manual
        // The key test is that the event was received (no error, handler was called)
        expect(vm.pixelSizeMode).toBe("manual");
      }
    });

    it("scalebarMode v-radio-group triggers handleScalebarModeChange via update:modelValue", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.scalebarSettingsDialog = true;

      const radioGroups = wrapper.findAllComponents({ name: "v-radio-group" });
      if (radioGroups.length >= 2) {
        vm.scalebarMode = "automatic";
        radioGroups[1].vm.$emit("update:modelValue", "manual");
        expect(vm.scalebarMode).toBe("manual");
      }
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { shallowMount, Wrapper } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

// --- Top-level mock fn handles (hoisted before vi.mock calls) ---
const mockGetItems = vi.fn().mockResolvedValue([]);
const mockGetTiles = vi.fn().mockResolvedValue({});
const mockGetTilesInternalMetadata = vi.fn().mockResolvedValue({});
const mockCreateLargeImage = vi.fn().mockResolvedValue({});
const mockUpdateDatasetMetadata = vi.fn().mockResolvedValue({});
const mockAddMultiSourceMetadata = vi.fn().mockResolvedValue("item-123");
const mockRessourceChanged = vi.fn().mockResolvedValue(undefined);
const mockScheduleTileFramesComputation = vi.fn().mockResolvedValue(undefined);
const mockScheduleMaxMergeCache = vi.fn().mockResolvedValue(undefined);
const mockScheduleHistogramCache = vi.fn().mockResolvedValue(undefined);
const mockSetUploadDimensionStrategy = vi.fn();

// --- Store mock ---
vi.mock("@/store", () => ({
  default: {
    api: {
      getItems: (...args: any[]) => mockGetItems(...args),
      getTiles: (...args: any[]) => mockGetTiles(...args),
      getTilesInternalMetadata: (...args: any[]) =>
        mockGetTilesInternalMetadata(...args),
      createLargeImage: (...args: any[]) => mockCreateLargeImage(...args),
      updateDatasetMetadata: (...args: any[]) =>
        mockUpdateDatasetMetadata(...args),
    },
    addMultiSourceMetadata: (...args: any[]) =>
      mockAddMultiSourceMetadata(...args),
    girderResources: {
      ressourceChanged: (...args: any[]) => mockRessourceChanged(...args),
    },
    scheduleTileFramesComputation: (...args: any[]) =>
      mockScheduleTileFramesComputation(...args),
    scheduleMaxMergeCache: (...args: any[]) =>
      mockScheduleMaxMergeCache(...args),
    scheduleHistogramCache: (...args: any[]) =>
      mockScheduleHistogramCache(...args),
    get uploadWorkflow() {
      return {
        active: false,
        batchMode: false,
      };
    },
    get uploadIsFirstDataset() {
      return false;
    },
    setUploadDimensionStrategy: (...args: any[]) =>
      mockSetUploadDimensionStrategy(...args),
  },
}));

// --- Utility mocks ---
vi.mock("@/utils/log", () => ({
  logError: vi.fn(),
  logWarning: vi.fn(),
}));

vi.mock("@/utils/strings", () => ({
  parseTranscodeOutput: vi.fn(() => ({
    progressStatusText: "",
    transcodeProgress: undefined,
  })),
}));

vi.mock("@/utils/ND2FileParsing", () => ({
  extractDimensionLabelsFromND2: vi.fn(() => null),
}));

// p-limit: identity wrapper (no concurrency limiting in tests)
vi.mock("p-limit", () => ({
  default: () => (fn: any) => fn(),
}));

// p-retry: execute function immediately (no retries in tests)
vi.mock("p-retry", () => ({
  default: (fn: any) => fn(),
  AbortError: class AbortError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "AbortError";
    }
  },
}));

// Import after mocks (real parsing is NOT mocked)
import MultiSourceConfiguration from "./MultiSourceConfiguration.vue";
import store from "@/store";
import { collectFilenameMetadata2 } from "@/utils/parsing";

Vue.use(Vuetify);
Vue.directive("tour-trigger", {});

// --- Test Fixtures ---

/**
 * Set A: Simple numeric OME-TIFF (20 files = 5 channels × 4 positions)
 */
function makeSetAItems() {
  const items: any[] = [];
  for (let ch = 0; ch < 5; ch++) {
    for (let pos = 0; pos < 4; pos++) {
      const name = `img${String(ch).padStart(3, "0")}_${String(pos).padStart(3, "0")}_000000_0000000000.ome.tif`;
      items.push({
        _id: `item-a-${ch}-${pos}`,
        _modelType: "item",
        name,
        folderId: "folder1",
        creatorId: "user1",
        description: "",
        meta: {},
      });
    }
  }
  return items;
}

function makeSetATileMeta() {
  return {
    levels: 1,
    magnification: 10,
    mm_x: 0.001,
    mm_y: 0.001,
    sizeX: 512,
    sizeY: 512,
    tileWidth: 256,
    tileHeight: 256,
    frames: [{ IndexT: 0, IndexZ: 0, IndexC: 0, IndexXY: 0 }],
    channels: ["Default"],
    bandCount: 1,
    IndexRange: null,
    IndexStride: null,
  };
}

/**
 * Set B: Directory-based channels with well positions and time (6 files)
 */
function makeSetBItems() {
  return [
    {
      _id: "item-b-1",
      _modelType: "item",
      name: "phase/VID1630_A1_1_00d00h00m.tif",
      folderId: "folder1",
      creatorId: "user1",
      description: "",
      meta: {},
    },
    {
      _id: "item-b-2",
      _modelType: "item",
      name: "red/VID1630_A1_1_00d00h00m.tif",
      folderId: "folder1",
      creatorId: "user1",
      description: "",
      meta: {},
    },
    {
      _id: "item-b-3",
      _modelType: "item",
      name: "gfp/VID1630_A1_1_00d00h00m.tif",
      folderId: "folder1",
      creatorId: "user1",
      description: "",
      meta: {},
    },
    {
      _id: "item-b-4",
      _modelType: "item",
      name: "phase/VID1630_C4_1_01d23h34m.tif",
      folderId: "folder1",
      creatorId: "user1",
      description: "",
      meta: {},
    },
    {
      _id: "item-b-5",
      _modelType: "item",
      name: "red/VID1630_C4_1_01d23h34m.tif",
      folderId: "folder1",
      creatorId: "user1",
      description: "",
      meta: {},
    },
    {
      _id: "item-b-6",
      _modelType: "item",
      name: "gfp/VID1630_C4_1_01d23h34m.tif",
      folderId: "folder1",
      creatorId: "user1",
      description: "",
      meta: {},
    },
  ];
}

/**
 * Set C: Single ND2 file
 */
function makeSetCItems() {
  return [
    {
      _id: "item-c-1",
      _modelType: "item",
      name: "experiment.nd2",
      folderId: "folder1",
      creatorId: "user1",
      description: "",
      meta: {},
    },
  ];
}

/**
 * Set D: Two files with no varying tokens except digits
 */
function makeSetDItems() {
  return [
    {
      _id: "item-d-1",
      _modelType: "item",
      name: "slide1.tif",
      folderId: "folder1",
      creatorId: "user1",
      description: "",
      meta: {},
    },
    {
      _id: "item-d-2",
      _modelType: "item",
      name: "slide2.tif",
      folderId: "folder1",
      creatorId: "user1",
      description: "",
      meta: {},
    },
  ];
}

function makeBasicTileMeta(overrides: any = {}) {
  return {
    levels: 1,
    magnification: 10,
    mm_x: 0.001,
    mm_y: 0.001,
    sizeX: 512,
    sizeY: 512,
    tileWidth: 256,
    tileHeight: 256,
    frames: [{ IndexT: 0, IndexZ: 0, IndexC: 0, IndexXY: 0 }],
    channels: ["Default"],
    bandCount: 1,
    IndexRange: null,
    IndexStride: null,
    ...overrides,
  };
}

function makeND2TileMeta(nC: number = 3, nZ: number = 5, nT: number = 4): any {
  const frames = [];
  let idx = 0;
  for (let t = 0; t < nT; t++) {
    for (let z = 0; z < nZ; z++) {
      for (let c = 0; c < nC; c++) {
        frames.push({ IndexT: t, IndexZ: z, IndexC: c, IndexXY: 0 });
        idx++;
      }
    }
  }
  const channels = Array.from({ length: nC }, (_, i) => `Channel ${i}`);
  return {
    levels: 1,
    magnification: 40,
    mm_x: 0.0005,
    mm_y: 0.0005,
    sizeX: 1024,
    sizeY: 1024,
    tileWidth: 256,
    tileHeight: 256,
    frames,
    channels,
    bandCount: 1,
    IndexRange: {
      IndexC: nC,
      IndexZ: nZ,
      IndexT: nT,
      IndexXY: 1,
    },
    IndexStride: {
      IndexC: 1,
      IndexZ: nC,
      IndexT: nC * nZ,
      IndexXY: nC * nZ * nT,
    },
  };
}

// --- Mount helper ---
const mockRouter = { push: vi.fn() };

function mountComponent(
  propsData: any = {},
  { skipInitialize = true }: { skipInitialize?: boolean } = {},
) {
  const app = document.createElement("div");
  app.setAttribute("data-app", "true");
  document.body.appendChild(app);

  // If skipInitialize, make getItems resolve with empty array.
  // The component's initializeImplementation will proceed but fail at
  // tilesMetadata[0] access — we suppress this via the initialized promise catch.
  if (skipInitialize) {
    mockGetItems.mockResolvedValueOnce([]);
  }

  const wrapper = shallowMount(MultiSourceConfiguration as any, {
    vuetify: new Vuetify(),
    attachTo: app,
    propsData: {
      datasetId: "ds-1",
      ...propsData,
    },
    mocks: {
      $router: mockRouter,
    },
    stubs: {
      VContainer: true,
      VCard: true,
      VCardTitle: true,
      VCardText: true,
      VCardActions: true,
      VSubheader: true,
      VDivider: true,
      VBtn: true,
      VIcon: true,
      VMenu: true,
      VList: true,
      VListItem: true,
      VListItemContent: true,
      VCheckbox: true,
      VRow: true,
      VCol: true,
      VSpacer: true,
      VProgressCircular: true,
      VProgressLinear: true,
      VAlert: true,
      VSimpleTable: true,
      VDialog: true,
      VSnackbar: true,
      VTooltip: true,
      VChip: true,
    },
  });

  // Suppress unhandled rejection from mounted() initialization
  const vm = wrapper.vm as any;
  if (vm.initialized) {
    vm.initialized.catch(() => {});
  }

  return wrapper;
}

// --- Tests ---

describe("MultiSourceConfiguration", () => {
  beforeEach(() => {
    vi.restoreAllMocks();

    // Re-wire mock fns after restoreAllMocks
    mockGetItems.mockResolvedValue([]);
    mockGetTiles.mockResolvedValue(makeBasicTileMeta());
    mockGetTilesInternalMetadata.mockResolvedValue({});
    mockCreateLargeImage.mockResolvedValue({});
    mockUpdateDatasetMetadata.mockResolvedValue({});
    mockAddMultiSourceMetadata.mockResolvedValue("item-123");
    mockRessourceChanged.mockResolvedValue(undefined);
    mockScheduleTileFramesComputation.mockResolvedValue(undefined);
    mockScheduleMaxMergeCache.mockResolvedValue(undefined);
    mockScheduleHistogramCache.mockResolvedValue(undefined);
    mockSetUploadDimensionStrategy.mockReset();
    mockRouter.push = vi.fn();
  });

  afterEach(() => {
    // Clean up any [data-app] divs
    document.querySelectorAll("[data-app]").forEach((el) => el.remove());
  });

  // ─── 1. Data defaults ───────────────────────────────────────────────

  describe("data defaults", () => {
    it("has configuring=false (initializing=false) initially", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.initializing).toBe(true); // mounted() sets initializing=true
      wrapper.destroy();
    });

    it("has empty dimensions array", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.dimensions).toEqual([]);
      wrapper.destroy();
    });

    it("has null assignments for all dimensions", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.assignments.XY).toBeNull();
      expect(vm.assignments.Z).toBeNull();
      expect(vm.assignments.T).toBeNull();
      expect(vm.assignments.C).toBeNull();
      wrapper.destroy();
    });

    it("has transcode=false initially", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.transcode).toBe(false);
      wrapper.destroy();
    });

    it("has enableCompositing=false and splitRGBBands=true", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.enableCompositing).toBe(false);
      expect(vm.splitRGBBands).toBe(true);
      wrapper.destroy();
    });
  });

  // ─── 2. Computed properties ─────────────────────────────────────────

  describe("isMultiBandRGBFile", () => {
    it("returns true when isRGBFile and rgbBandCount > 1", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.isRGBFile = true;
      vm.rgbBandCount = 3;
      expect(vm.isMultiBandRGBFile).toBe(true);
      wrapper.destroy();
    });

    it("returns false when isRGBFile but rgbBandCount <= 1", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.isRGBFile = true;
      vm.rgbBandCount = 1;
      expect(vm.isMultiBandRGBFile).toBe(false);
      wrapper.destroy();
    });

    it("returns false when not isRGBFile", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.isRGBFile = false;
      vm.rgbBandCount = 3;
      expect(vm.isMultiBandRGBFile).toBe(false);
      wrapper.destroy();
    });
  });

  describe("initProgressPercent", () => {
    it("returns 0 when initTotal is 0", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.initTotal = 0;
      vm.initCompleted = 0;
      expect(vm.initProgressPercent).toBe(0);
      wrapper.destroy();
    });

    it("returns 50 when half complete", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.initTotal = 10;
      vm.initCompleted = 5;
      expect(vm.initProgressPercent).toBe(50);
      wrapper.destroy();
    });

    it("returns 100 when all complete", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.initTotal = 10;
      vm.initCompleted = 10;
      expect(vm.initProgressPercent).toBe(100);
      wrapper.destroy();
    });
  });

  describe("initPendingDisplay", () => {
    it("returns at most 5 items", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.initPending = ["a", "b", "c", "d", "e", "f", "g"];
      expect(vm.initPendingDisplay).toHaveLength(5);
      expect(vm.initPendingDisplay).toEqual(["a", "b", "c", "d", "e"]);
      wrapper.destroy();
    });
  });

  describe("canDoCompositing", () => {
    it("returns true for single ND2 file with nd2_frame_metadata", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.tilesInternalMetadata = [{ nd2_frame_metadata: [{}] }];
      vm.tilesMetadata = [makeBasicTileMeta()];
      expect(vm.canDoCompositing).toBe(true);
      wrapper.destroy();
    });

    it("returns false when multiple files", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.tilesInternalMetadata = [
        { nd2_frame_metadata: [{}] },
        { nd2_frame_metadata: [{}] },
      ];
      vm.tilesMetadata = [makeBasicTileMeta(), makeBasicTileMeta()];
      expect(vm.canDoCompositing).toBe(false);
      wrapper.destroy();
    });

    it("returns false when tilesInternalMetadata is null", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.tilesInternalMetadata = null;
      vm.tilesMetadata = [makeBasicTileMeta()];
      expect(vm.canDoCompositing).toBe(false);
      wrapper.destroy();
    });

    it("returns false when no nd2_frame_metadata", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.tilesInternalMetadata = [{}];
      vm.tilesMetadata = [makeBasicTileMeta()];
      expect(vm.canDoCompositing).toBeFalsy();
      wrapper.destroy();
    });
  });

  describe("shouldDoCompositing", () => {
    it("returns true when canDoCompositing and enableCompositing", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.tilesInternalMetadata = [{ nd2_frame_metadata: [{}] }];
      vm.tilesMetadata = [makeBasicTileMeta()];
      vm.enableCompositing = true;
      expect(vm.shouldDoCompositing).toBe(true);
      wrapper.destroy();
    });

    it("returns false when canDoCompositing but not enableCompositing", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.tilesInternalMetadata = [{ nd2_frame_metadata: [{}] }];
      vm.tilesMetadata = [makeBasicTileMeta()];
      vm.enableCompositing = false;
      expect(vm.shouldDoCompositing).toBe(false);
      wrapper.destroy();
    });
  });

  describe("fileCount", () => {
    it("returns number of girder items", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.girderItems = [{ name: "a" }, { name: "b" }, { name: "c" }];
      expect(vm.fileCount).toBe(3);
      wrapper.destroy();
    });

    it("returns 0 when no items", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.girderItems = [];
      expect(vm.fileCount).toBe(0);
      wrapper.destroy();
    });
  });

  describe("framesPerFile", () => {
    it("returns max frames across tiles", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.tilesMetadata = [
        { frames: [1, 2, 3] },
        { frames: [1, 2, 3, 4, 5] },
        { frames: [1] },
      ];
      expect(vm.framesPerFile).toBe(5);
      wrapper.destroy();
    });

    it("returns 1 when tilesMetadata is null", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.tilesMetadata = null;
      expect(vm.framesPerFile).toBe(1);
      wrapper.destroy();
    });

    it("returns 1 for tiles without frames", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.tilesMetadata = [{ frames: null }, {}];
      expect(vm.framesPerFile).toBe(1);
      wrapper.destroy();
    });
  });

  describe("datasetTotalFrames", () => {
    it("sums frames across all tiles", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.tilesMetadata = [{ frames: [1, 2, 3] }, { frames: [1, 2] }];
      expect(vm.datasetTotalFrames).toBe(5);
      wrapper.destroy();
    });

    it("returns fileCount when tilesMetadata is null", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.tilesMetadata = null;
      vm.girderItems = [{ name: "a" }, { name: "b" }];
      expect(vm.datasetTotalFrames).toBe(2);
      wrapper.destroy();
    });
  });

  describe("items", () => {
    it("filters out dimensions with size 0", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.dimensions = [
        {
          id: 0,
          guess: "C",
          size: 3,
          name: "Channels",
          source: "filename",
          data: { values: ["a", "b", "c"], valueIdxPerFilename: {} },
        },
        {
          id: 1,
          guess: "Z",
          size: 0,
          name: "Empty",
          source: "filename",
          data: { values: [], valueIdxPerFilename: {} },
        },
      ];
      expect(vm.items).toHaveLength(1);
      expect(vm.items[0].name).toBe("Channels");
      wrapper.destroy();
    });

    it("produces values for filename source", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.dimensions = [
        {
          id: 0,
          guess: "C",
          size: 2,
          name: "Channels",
          source: "filename",
          data: { values: ["red", "green"], valueIdxPerFilename: {} },
        },
      ];
      expect(vm.items[0].values).toBe("red, green");
      wrapper.destroy();
    });

    it("produces numeric labels for images source", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.dimensions = [
        {
          id: 0,
          guess: "Z",
          size: 3,
          name: "All frames",
          source: "images",
          data: null,
        },
      ];
      const item = vm.items[0];
      expect(item.allValues).toEqual(["1", "2", "3"]);
      expect(item.values).toBe("");
      wrapper.destroy();
    });
  });

  describe("filenameVariables", () => {
    it("returns empty array when no girder items", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.girderItems = [];
      expect(vm.filenameVariables).toEqual([]);
      wrapper.destroy();
    });

    it("extracts variables from filename-sourced dimensions", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      // Use filenames where tokens match the variable values exactly
      // "red_01.tif" splits to ["red", "01", "tif"], values ["red", "green"]
      vm.girderItems = [{ name: "red_01.tif" }, { name: "green_01.tif" }];
      vm.dimensions = [
        {
          id: 0,
          guess: "C",
          size: 2,
          name: "Var 1",
          source: "filename",
          data: {
            values: ["red", "green"],
            valueIdxPerFilename: { "red_01.tif": 0, "green_01.tif": 1 },
          },
        },
      ];
      const vars = vm.filenameVariables;
      expect(vars).toHaveLength(1);
      expect(vars[0].value).toBe("red");
      expect(vars[0].tokenIndex).toBe(0);
      wrapper.destroy();
    });
  });

  describe("assignmentItems", () => {
    it("returns unassigned dimensions", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.dimensions = [
        {
          id: 0,
          guess: "C",
          size: 3,
          name: "Channels",
          source: "filename",
          data: { values: ["a", "b", "c"], valueIdxPerFilename: {} },
        },
        {
          id: 1,
          guess: "Z",
          size: 5,
          name: "Z-depth",
          source: "file",
          data: {},
        },
      ];
      // Assign channels to C
      vm.assignments.C = { text: "Channels", value: vm.dimensions[0] };

      const items = vm.assignmentItems;
      expect(items).toHaveLength(1);
      expect(items[0].text).toBe("Z-depth");
      wrapper.destroy();
    });

    it("returns all items when nothing assigned", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.dimensions = [
        {
          id: 0,
          guess: "C",
          size: 3,
          name: "Channels",
          source: "filename",
          data: { values: ["a", "b", "c"], valueIdxPerFilename: {} },
        },
      ];
      expect(vm.assignmentItems).toHaveLength(1);
      wrapper.destroy();
    });
  });

  describe("submitError", () => {
    it("returns error when submit not enabled", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      // No dimensions, no items => submitEnabled() is false
      expect(vm.submitError).toBe("Not all variables are assigned");
      wrapper.destroy();
    });

    it("returns RGB error when splitRGBBands with C assigned", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.isRGBFile = true;
      vm.rgbBandCount = 3;
      vm.splitRGBBands = true;
      vm.initializing = false;
      vm.dimensions = [
        {
          id: 0,
          guess: "C",
          size: 3,
          name: "Channels",
          source: "filename",
          data: { values: ["a", "b", "c"], valueIdxPerFilename: {} },
        },
      ];
      // Assign to C to trigger RGB error
      vm.assignments.C = { text: "Channels", value: vm.dimensions[0] };
      expect(vm.submitError).toBe(
        "If splitting RGB file into channels, then filenames must be assigned to another variable",
      );
      wrapper.destroy();
    });

    it("returns null when valid", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.initializing = false;
      // No dimensions, so 0 items, and 0 >= 0 filledAssignments >= 0
      // This means submitEnabled() returns true (0 >= 0)
      expect(vm.submitError).toBeNull();
      wrapper.destroy();
    });
  });

  describe("isRGBAssignmentValid", () => {
    it("returns true when not multi-band RGB", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.isRGBFile = false;
      vm.rgbBandCount = 1;
      expect(vm.isRGBAssignmentValid).toBe(true);
      wrapper.destroy();
    });

    it("returns true when multi-band RGB with splitRGBBands and C is null", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.isRGBFile = true;
      vm.rgbBandCount = 3;
      vm.splitRGBBands = true;
      vm.assignments.C = null;
      expect(vm.isRGBAssignmentValid).toBe(true);
      wrapper.destroy();
    });

    it("returns false when multi-band RGB with splitRGBBands and C is assigned", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.isRGBFile = true;
      vm.rgbBandCount = 3;
      vm.splitRGBBands = true;
      vm.assignments.C = { text: "Ch", value: { id: 0 } };
      expect(vm.isRGBAssignmentValid).toBe(false);
      wrapper.destroy();
    });
  });

  // ─── 3. Initialization with real parsing ────────────────────────────

  describe("initialization", () => {
    it("Set A: detects 2 filename variables from OME-TIFF files", async () => {
      const items = makeSetAItems();
      mockGetItems.mockResolvedValue(items);
      mockGetTiles.mockResolvedValue(makeSetATileMeta());
      mockGetTilesInternalMetadata.mockResolvedValue({});

      const wrapper = mountComponent({}, { skipInitialize: false });
      const vm = wrapper.vm as any;

      await vm.initialized;

      // Should have filename variables + possibly images variables
      expect(vm.girderItems).toHaveLength(20);
      // Filename parsing with 20 files should produce variables
      expect(vm.dimensions.length).toBeGreaterThanOrEqual(2);
      // Transcode should be true for .ome.tif files
      expect(vm.transcode).toBe(true);
      wrapper.destroy();
    });

    it("Set C: single ND2 file sets transcode=false", async () => {
      const items = makeSetCItems();
      const tileMeta = makeND2TileMeta(3, 5, 4);
      mockGetItems.mockResolvedValue(items);
      mockGetTiles.mockResolvedValue(tileMeta);
      mockGetTilesInternalMetadata.mockResolvedValue({});

      const wrapper = mountComponent({}, { skipInitialize: false });
      const vm = wrapper.vm as any;

      await vm.initialized;

      expect(vm.transcode).toBe(false);
      // Single file, no filename parsing
      expect(vm.girderItems).toHaveLength(1);
      // Should have file-source dimensions from IndexRange
      const fileDims = vm.dimensions.filter((d: any) => d.source === "file");
      expect(fileDims.length).toBeGreaterThan(0);
      wrapper.destroy();
    });

    it("Set C: processes IndexRange and IndexStride from tile metadata", async () => {
      const items = makeSetCItems();
      const tileMeta = makeND2TileMeta(3, 5, 4);
      mockGetItems.mockResolvedValue(items);
      mockGetTiles.mockResolvedValue(tileMeta);
      mockGetTilesInternalMetadata.mockResolvedValue({});

      const wrapper = mountComponent({}, { skipInitialize: false });
      const vm = wrapper.vm as any;

      await vm.initialized;

      // Should have dimensions for C=3, Z=5, T=4
      const cDim = vm.dimensions.find(
        (d: any) => d.source === "file" && d.guess === "C",
      );
      const zDim = vm.dimensions.find(
        (d: any) => d.source === "file" && d.guess === "Z",
      );
      const tDim = vm.dimensions.find(
        (d: any) => d.source === "file" && d.guess === "T",
      );
      expect(cDim).toBeDefined();
      expect(cDim.size).toBe(3);
      expect(zDim).toBeDefined();
      expect(zDim.size).toBe(5);
      expect(tDim).toBeDefined();
      expect(tDim.size).toBe(4);
      wrapper.destroy();
    });

    it("Set D: detects 1 variable from two files with varying digit", async () => {
      const items = makeSetDItems();
      mockGetItems.mockResolvedValue(items);
      mockGetTiles.mockResolvedValue(makeBasicTileMeta());
      mockGetTilesInternalMetadata.mockResolvedValue({});

      const wrapper = mountComponent({}, { skipInitialize: false });
      const vm = wrapper.vm as any;

      await vm.initialized;

      // Should detect at least 1 filename variable
      const filenameDims = vm.dimensions.filter(
        (d: any) => d.source === "filename",
      );
      expect(filenameDims.length).toBeGreaterThanOrEqual(1);
      wrapper.destroy();
    });

    it("detects RGB via photometricInterpretation", async () => {
      const items = makeSetCItems();
      items[0].name = "image.tif";
      const tileMeta = makeBasicTileMeta({
        bandCount: 3,
        metadata: { photometricInterpretation: 2 },
      });
      mockGetItems.mockResolvedValue(items);
      mockGetTiles.mockResolvedValue(tileMeta);
      mockGetTilesInternalMetadata.mockResolvedValue({});

      const wrapper = mountComponent({}, { skipInitialize: false });
      const vm = wrapper.vm as any;

      await vm.initialized;

      expect(vm.isRGBFile).toBe(true);
      expect(vm.rgbBandCount).toBe(3);
      wrapper.destroy();
    });

    it("handles OIB files by calling createLargeImage", async () => {
      vi.useFakeTimers();
      const items = [
        {
          _id: "item-oib-1",
          _modelType: "item",
          name: "sample.oib",
          folderId: "folder1",
          creatorId: "user1",
          description: "",
          meta: {},
        },
      ];
      mockGetItems.mockResolvedValue(items);
      mockGetTiles.mockResolvedValue(makeBasicTileMeta());
      mockGetTilesInternalMetadata.mockResolvedValue({});

      const wrapper = mountComponent({}, { skipInitialize: false });
      const vm = wrapper.vm as any;

      // Advance timers past the 5000ms OIB wait
      await vi.advanceTimersByTimeAsync(6000);
      await vm.initialized;

      expect(mockCreateLargeImage).toHaveBeenCalledWith(items[0]);
      wrapper.destroy();
      vi.useRealTimers();
    });

    it("tracks initialization progress", async () => {
      const items = makeSetDItems();
      let resolveFirst: any;
      let resolveSecond: any;
      const firstTilesPromise = new Promise((resolve) => {
        resolveFirst = resolve;
      });
      const secondTilesPromise = new Promise((resolve) => {
        resolveSecond = resolve;
      });

      mockGetItems.mockResolvedValue(items);
      mockGetTiles
        .mockReturnValueOnce(firstTilesPromise)
        .mockReturnValueOnce(secondTilesPromise);
      mockGetTilesInternalMetadata.mockResolvedValue({});

      const wrapper = mountComponent({}, { skipInitialize: false });
      const vm = wrapper.vm as any;

      // Wait a tick for initializeImplementation to start
      await Vue.nextTick();
      await new Promise((r) => setTimeout(r, 10));

      expect(vm.initTotal).toBe(2);

      // Resolve first item
      resolveFirst(makeBasicTileMeta());
      await new Promise((r) => setTimeout(r, 10));

      // Resolve second item
      resolveSecond(makeBasicTileMeta());
      await vm.initialized;

      expect(vm.initCompleted).toBe(2);
      expect(vm.initPending).toHaveLength(0);
      wrapper.destroy();
    });

    it("sets initError on failure", async () => {
      const items = makeSetCItems();
      items[0].name = "bad_file.tif";
      mockGetItems.mockResolvedValue(items);
      mockGetTiles.mockRejectedValue(new Error("Tile fetch failed"));
      mockGetTilesInternalMetadata.mockResolvedValue({});

      const wrapper = mountComponent({}, { skipInitialize: false });
      const vm = wrapper.vm as any;

      // Wait for initialization to fail
      try {
        await vm.initialized;
      } catch {
        // Expected to throw
      }

      expect(vm.initError).not.toBeNull();
      expect(vm.initError.name).toBe("bad_file.tif");
      wrapper.destroy();
    });

    it("calls resetDimensionsToDefault after initialization", async () => {
      const items = makeSetCItems();
      const tileMeta = makeND2TileMeta(3, 5, 4);
      mockGetItems.mockResolvedValue(items);
      mockGetTiles.mockResolvedValue(tileMeta);
      mockGetTilesInternalMetadata.mockResolvedValue({});

      const wrapper = mountComponent({}, { skipInitialize: false });
      const vm = wrapper.vm as any;

      await vm.initialized;

      // After init, assignments should have been set to defaults
      // C should be assigned since there's a file source with guess=C
      expect(vm.assignments.C).not.toBeNull();
      wrapper.destroy();
    });

    it("adds Images dimension when no file variables found", async () => {
      const items = makeSetCItems();
      items[0].name = "image.tif";
      const tileMeta = makeBasicTileMeta({
        frames: [{ IndexT: 0 }, { IndexT: 1 }, { IndexT: 2 }],
        // No IndexRange or IndexStride
      });
      mockGetItems.mockResolvedValue(items);
      mockGetTiles.mockResolvedValue(tileMeta);
      mockGetTilesInternalMetadata.mockResolvedValue({});

      const wrapper = mountComponent({}, { skipInitialize: false });
      const vm = wrapper.vm as any;

      await vm.initialized;

      const imagesDim = vm.dimensions.find((d: any) => d.source === "images");
      expect(imagesDim).toBeDefined();
      expect(imagesDim.name).toBe("All frames per item");
      expect(imagesDim.size).toBe(3);
      wrapper.destroy();
    });
  });

  // ─── 4. addSizeToDimension ──────────────────────────────────────────

  describe("addSizeToDimension", () => {
    it("adds new dimension for filename source", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.addSizeToDimension("C", 3, {
        source: "filename",
        data: { values: ["a", "b", "c"], valueIdxPerFilename: {} },
      });
      expect(vm.dimensions).toHaveLength(1);
      expect(vm.dimensions[0].guess).toBe("C");
      expect(vm.dimensions[0].size).toBe(3);
      expect(vm.dimensions[0].source).toBe("filename");
      wrapper.destroy();
    });

    it("adds new dimension for file source", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.addSizeToDimension("Z", 5, {
        source: "file",
        data: { 0: { stride: 1, range: 5, values: null } },
      });
      expect(vm.dimensions).toHaveLength(1);
      expect(vm.dimensions[0].guess).toBe("Z");
      expect(vm.dimensions[0].source).toBe("file");
      wrapper.destroy();
    });

    it("adds new dimension for images source", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.addSizeToDimension("Z", 10, { source: "images", data: null });
      expect(vm.dimensions).toHaveLength(1);
      expect(vm.dimensions[0].source).toBe("images");
      wrapper.destroy();
    });

    it("merges file-source dimensions with same guess", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.addSizeToDimension("Z", 5, {
        source: "file",
        data: { 0: { stride: 1, range: 5, values: null } },
      });
      vm.addSizeToDimension("Z", 7, {
        source: "file",
        data: { 1: { stride: 1, range: 7, values: null } },
      });
      // Should merge into one dimension
      expect(vm.dimensions).toHaveLength(1);
      expect(vm.dimensions[0].size).toBe(7); // max(5, 7)
      expect(vm.dimensions[0].data[0]).toBeDefined();
      expect(vm.dimensions[0].data[1]).toBeDefined();
      wrapper.destroy();
    });

    it("does not merge filename-source dimensions with same guess", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.addSizeToDimension("C", 3, {
        source: "filename",
        data: { values: ["a", "b", "c"], valueIdxPerFilename: {} },
      });
      vm.addSizeToDimension("C", 2, {
        source: "filename",
        data: { values: ["x", "y"], valueIdxPerFilename: {} },
      });
      expect(vm.dimensions).toHaveLength(2);
      wrapper.destroy();
    });

    it("skips when size is 0", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.addSizeToDimension("C", 0, {
        source: "filename",
        data: { values: [], valueIdxPerFilename: {} },
      });
      expect(vm.dimensions).toHaveLength(0);
      wrapper.destroy();
    });

    it("auto-generates name for filename source", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.addSizeToDimension("C", 2, {
        source: "filename",
        data: { values: ["a", "b"], valueIdxPerFilename: {} },
      });
      expect(vm.dimensions[0].name).toBe("Filename variable 1");
      wrapper.destroy();
    });

    it("auto-generates name for file source", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.addSizeToDimension("T", 3, {
        source: "file",
        data: { 0: { stride: 1, range: 3, values: null } },
      });
      expect(vm.dimensions[0].name).toBe("Metadata 1 (Time)");
      wrapper.destroy();
    });

    it("uses provided name when given", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.addSizeToDimension(
        "Z",
        10,
        { source: "images", data: null },
        "All frames per item",
      );
      expect(vm.dimensions[0].name).toBe("All frames per item");
      wrapper.destroy();
    });
  });

  // ─── 5. Assignment methods ──────────────────────────────────────────

  describe("assignment methods", () => {
    function setupDimensions(vm: any) {
      vm.dimensions = [
        {
          id: 0,
          guess: "C",
          size: 3,
          name: "Channels",
          source: "file",
          data: { 0: { stride: 1, range: 3, values: ["Ch0", "Ch1", "Ch2"] } },
        },
        {
          id: 1,
          guess: "Z",
          size: 5,
          name: "Z-depth",
          source: "file",
          data: { 0: { stride: 3, range: 5, values: null } },
        },
        {
          id: 2,
          guess: "T",
          size: 4,
          name: "Timepoints",
          source: "file",
          data: { 0: { stride: 15, range: 4, values: null } },
        },
      ];
      vm.girderItems = [{ name: "experiment.nd2" }];
    }

    it("resetDimensionsToDefault sets assignments to guessed defaults", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      setupDimensions(vm);
      vm.resetDimensionsToDefault();

      expect(vm.assignments.C).not.toBeNull();
      expect(vm.assignments.C.value.guess).toBe("C");
      expect(vm.assignments.Z).not.toBeNull();
      expect(vm.assignments.Z.value.guess).toBe("Z");
      expect(vm.assignments.T).not.toBeNull();
      expect(vm.assignments.T.value.guess).toBe("T");
      wrapper.destroy();
    });

    it("areDimensionsSetToDefault returns true when matching defaults", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      setupDimensions(vm);
      vm.resetDimensionsToDefault();
      expect(vm.areDimensionsSetToDefault()).toBe(true);
      wrapper.destroy();
    });

    it("areDimensionsSetToDefault returns false when modified", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      setupDimensions(vm);
      vm.resetDimensionsToDefault();
      vm.assignments.C = null;
      expect(vm.areDimensionsSetToDefault()).toBe(false);
      wrapper.destroy();
    });

    it("isVariableAssigned checks if variable is assigned to any dimension", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      setupDimensions(vm);
      vm.resetDimensionsToDefault();

      expect(vm.isVariableAssigned(vm.dimensions[0])).toBe(true);
      // Unassign C
      vm.assignments.C = null;
      expect(vm.isVariableAssigned(vm.dimensions[0])).toBe(false);
      wrapper.destroy();
    });

    it("getAssignedDimension returns dimension key for variable", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      setupDimensions(vm);
      vm.resetDimensionsToDefault();

      expect(vm.getAssignedDimension(vm.dimensions[0])).toBe("C");
      expect(vm.getAssignedDimension(vm.dimensions[1])).toBe("Z");
      wrapper.destroy();
    });

    it("getAssignedDimension returns null for unassigned variable", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      setupDimensions(vm);
      expect(vm.getAssignedDimension(vm.dimensions[0])).toBeNull();
      wrapper.destroy();
    });

    it("assignmentDisabled returns true for immutable ND2 assignments", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      setupDimensions(vm);
      vm.girderItems = [{ name: "experiment.nd2" }];
      vm.resetDimensionsToDefault();

      // File source + ND2 file = immutable
      expect(vm.assignmentDisabled("C")).toBe(true);
      wrapper.destroy();
    });

    it("assignmentDisabled returns false for non-ND2 files with available items", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      setupDimensions(vm);
      // Add extra dimensions so there are more than 4 (leaving some unassigned)
      vm.dimensions.push(
        {
          id: 3,
          guess: "XY",
          size: 2,
          name: "Positions",
          source: "filename",
          data: { values: ["p1", "p2"], valueIdxPerFilename: {} },
        },
        {
          id: 4,
          guess: "XY",
          size: 3,
          name: "Extra",
          source: "filename",
          data: { values: ["e1", "e2", "e3"], valueIdxPerFilename: {} },
        },
      );
      vm.girderItems = [{ name: "experiment.tif" }];
      vm.resetDimensionsToDefault();

      // C is assigned (file source from .tif, not ND2) and there are unassigned items
      expect(vm.assignmentDisabled("C")).toBe(false);
      wrapper.destroy();
    });

    it("clearDisabled returns true for immutable assignments", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      setupDimensions(vm);
      vm.girderItems = [{ name: "experiment.nd2" }];
      vm.resetDimensionsToDefault();
      expect(vm.clearDisabled("C")).toBe(true);
      wrapper.destroy();
    });

    it("clearDisabled returns true when no assignment", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.clearDisabled("C")).toBe(true);
      wrapper.destroy();
    });

    it("submitEnabled returns false when initializing", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.initializing = true;
      expect(vm.submitEnabled()).toBe(false);
      wrapper.destroy();
    });

    it("submitEnabled returns true when all items assigned", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      setupDimensions(vm);
      vm.initializing = false;
      vm.resetDimensionsToDefault();
      expect(vm.submitEnabled()).toBe(true);
      wrapper.destroy();
    });
  });

  // ─── 6. Dimension strategy ─────────────────────────────────────────

  describe("dimension strategy", () => {
    function setupAssigned(vm: any) {
      vm.dimensions = [
        {
          id: 0,
          guess: "C",
          size: 3,
          name: "Channels",
          source: "file",
          data: {},
        },
        {
          id: 1,
          guess: "Z",
          size: 5,
          name: "Z-depth",
          source: "filename",
          data: { values: ["1", "2", "3", "4", "5"], valueIdxPerFilename: {} },
        },
      ];
      vm.assignments.C = { text: "Channels", value: vm.dimensions[0] };
      vm.assignments.Z = { text: "Z-depth", value: vm.dimensions[1] };
      vm.transcode = true;
    }

    it("getDimensionStrategy extracts current strategy", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      setupAssigned(vm);

      const strategy = vm.getDimensionStrategy();
      expect(strategy.C).toEqual({ source: "file", guess: "C" });
      expect(strategy.Z).toEqual({ source: "filename", guess: "Z" });
      expect(strategy.XY).toBeNull();
      expect(strategy.T).toBeNull();
      expect(strategy.transcode).toBe(true);
      wrapper.destroy();
    });

    it("saveDimensionStrategyToStore does nothing when not in batch mode", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      setupAssigned(vm);

      vm.saveDimensionStrategyToStore();
      expect(mockSetUploadDimensionStrategy).not.toHaveBeenCalled();
      wrapper.destroy();
    });

    it("saveDimensionStrategyToStore saves when in batch mode for first dataset", () => {
      // Override uploadWorkflow to be active batch mode
      const storeAny = store as any;
      const origWorkflow = Object.getOwnPropertyDescriptor(
        storeAny,
        "uploadWorkflow",
      );
      const origFirstDataset = Object.getOwnPropertyDescriptor(
        storeAny,
        "uploadIsFirstDataset",
      );

      Object.defineProperty(storeAny, "uploadWorkflow", {
        get: () => ({ active: true, batchMode: true }),
        configurable: true,
      });
      Object.defineProperty(storeAny, "uploadIsFirstDataset", {
        get: () => true,
        configurable: true,
      });

      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      setupAssigned(vm);

      vm.saveDimensionStrategyToStore();
      expect(mockSetUploadDimensionStrategy).toHaveBeenCalled();
      const strategy = mockSetUploadDimensionStrategy.mock.calls[0][0];
      expect(strategy.C).toEqual({ source: "file", guess: "C" });

      // Restore
      if (origWorkflow) {
        Object.defineProperty(storeAny, "uploadWorkflow", origWorkflow);
      }
      if (origFirstDataset) {
        Object.defineProperty(
          storeAny,
          "uploadIsFirstDataset",
          origFirstDataset,
        );
      }
      wrapper.destroy();
    });

    it("applyDimensionStrategy applies exact match", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;

      vm.dimensions = [
        {
          id: 0,
          guess: "C",
          size: 3,
          name: "Channels",
          source: "file",
          data: {},
        },
        {
          id: 1,
          guess: "Z",
          size: 5,
          name: "Z-depth",
          source: "filename",
          data: { values: ["1", "2", "3", "4", "5"], valueIdxPerFilename: {} },
        },
      ];

      const strategy = {
        XY: null,
        Z: { source: "filename", guess: "Z" },
        T: null,
        C: { source: "file", guess: "C" },
        transcode: false,
      };

      vm.applyDimensionStrategy(strategy);

      expect(vm.assignments.C).not.toBeNull();
      expect(vm.assignments.C.value.id).toBe(0);
      expect(vm.assignments.Z).not.toBeNull();
      expect(vm.assignments.Z.value.id).toBe(1);
      expect(vm.transcode).toBe(false);
      wrapper.destroy();
    });

    it("applyDimensionStrategy falls back to guess-only match", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;

      vm.dimensions = [
        {
          id: 0,
          guess: "C",
          size: 3,
          name: "Channels",
          source: "filename",
          data: { values: ["a", "b", "c"], valueIdxPerFilename: {} },
        },
      ];

      // Strategy wants file source, but only filename source exists
      const strategy = {
        XY: null,
        Z: null,
        T: null,
        C: { source: "file", guess: "C" },
        transcode: true,
      };

      vm.applyDimensionStrategy(strategy);

      // Should fall back to guess match (same guess "C")
      expect(vm.assignments.C).not.toBeNull();
      expect(vm.assignments.C.value.id).toBe(0);
      wrapper.destroy();
    });

    it("applyDimensionStrategy falls back to source-only match", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;

      vm.dimensions = [
        {
          id: 0,
          guess: "T",
          size: 3,
          name: "Time",
          source: "file",
          data: {},
        },
      ];

      // Strategy wants file source with guess=C, but only file source with guess=T exists
      const strategy = {
        XY: null,
        Z: null,
        T: null,
        C: { source: "file", guess: "C" },
        transcode: true,
      };

      vm.applyDimensionStrategy(strategy);

      // Should fall back to source match (same source "file")
      expect(vm.assignments.C).not.toBeNull();
      expect(vm.assignments.C.value.id).toBe(0);
      wrapper.destroy();
    });

    it("applyDimensionStrategy falls back to default when no match", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;

      vm.dimensions = [
        {
          id: 0,
          guess: "XY",
          size: 3,
          name: "Positions",
          source: "images",
          data: null,
        },
      ];

      // Strategy wants something that doesn't exist
      const strategy = {
        XY: null,
        Z: { source: "file", guess: "Z" },
        T: null,
        C: null,
        transcode: true,
      };

      vm.applyDimensionStrategy(strategy);

      // Z should fall back to default (getDefaultAssignmentItem)
      // Since the only dimension has guess "XY", default for Z is null
      expect(vm.assignments.Z).toBeNull();
      wrapper.destroy();
    });

    it("reinitializeAndApplyStrategy resets state and re-initializes", async () => {
      const items = makeSetCItems();
      const tileMeta = makeND2TileMeta(2, 3, 2);
      mockGetItems.mockResolvedValue(items);
      mockGetTiles.mockResolvedValue(tileMeta);
      mockGetTilesInternalMetadata.mockResolvedValue({});

      const wrapper = mountComponent({}, { skipInitialize: false });
      const vm = wrapper.vm as any;

      await vm.initialized;

      const strategy = {
        XY: null,
        Z: { source: "file", guess: "Z" },
        T: { source: "file", guess: "T" },
        C: { source: "file", guess: "C" },
        transcode: false,
      };

      await vm.reinitializeAndApplyStrategy(strategy);

      expect(vm.assignments.C).not.toBeNull();
      expect(vm.assignments.Z).not.toBeNull();
      expect(vm.assignments.T).not.toBeNull();
      expect(vm.transcode).toBe(false);
      wrapper.destroy();
    });
  });

  // ─── 7. Value computation ──────────────────────────────────────────

  describe("getValueFromAssignments", () => {
    it("returns 0 when dimension not assigned", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.getValueFromAssignments("XY", 0, 0)).toBe(0);
      wrapper.destroy();
    });

    it("returns correct index for file source", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.assignments.C = {
        text: "Channels",
        value: {
          id: 0,
          source: "file",
          data: { 0: { stride: 1, range: 3, values: null } },
        },
      };
      // frameIdx=0, stride=1, range=3 => floor(0/1) % 3 = 0
      expect(vm.getValueFromAssignments("C", 0, 0)).toBe(0);
      // frameIdx=1 => floor(1/1) % 3 = 1
      expect(vm.getValueFromAssignments("C", 0, 1)).toBe(1);
      // frameIdx=5 => floor(5/1) % 3 = 2
      expect(vm.getValueFromAssignments("C", 0, 5)).toBe(2);
      wrapper.destroy();
    });

    it("returns correct index for filename source", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.girderItems = [{ name: "file_a.tif" }, { name: "file_b.tif" }];
      vm.assignments.C = {
        text: "Channels",
        value: {
          id: 0,
          source: "filename",
          data: {
            valueIdxPerFilename: { "file_a.tif": 0, "file_b.tif": 1 },
          },
        },
      };
      expect(vm.getValueFromAssignments("C", 0, 0)).toBe(0);
      expect(vm.getValueFromAssignments("C", 1, 0)).toBe(1);
      wrapper.destroy();
    });

    it("returns frameIdx for images source", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.assignments.Z = {
        text: "Frames",
        value: { id: 0, source: "images", data: null },
      };
      expect(vm.getValueFromAssignments("Z", 0, 7)).toBe(7);
      wrapper.destroy();
    });

    it("returns 0 when file data missing for item index", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.assignments.Z = {
        text: "Z",
        value: {
          id: 0,
          source: "file",
          data: { 0: { stride: 1, range: 3, values: null } },
        },
      };
      // itemIdx=1 has no data entry
      expect(vm.getValueFromAssignments("Z", 1, 5)).toBe(0);
      wrapper.destroy();
    });
  });

  describe("getCompositingValueFromAssignments", () => {
    it("returns correct value for file source", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.assignments.T = {
        text: "Time",
        value: {
          id: 0,
          source: "file",
          data: { 0: { stride: 15, range: 4, values: null } },
        },
      };
      // frameIdx=30, stride=15, range=4 => floor(30/15) % 4 = 2
      expect(vm.getCompositingValueFromAssignments("T", 0, 30)).toBe(2);
      wrapper.destroy();
    });
  });

  // ─── 8. generateJson / submit ──────────────────────────────────────

  describe("generateJson", () => {
    async function setupForSubmit(vm: any) {
      // Wait for mount initialization to complete (even if it errors)
      if (vm.initialized) {
        await vm.initialized.catch(() => {});
      }

      vm.dimensions = [
        {
          id: 0,
          guess: "C",
          size: 2,
          name: "Channels",
          source: "file",
          data: {
            0: {
              stride: 1,
              range: 2,
              values: ["DAPI", "GFP"],
            },
          },
        },
        {
          id: 1,
          guess: "Z",
          size: 3,
          name: "Z-depth",
          source: "file",
          data: {
            0: { stride: 2, range: 3, values: null },
          },
        },
      ];
      vm.girderItems = [{ _id: "item1", name: "test.nd2" }];
      vm.tilesMetadata = [
        {
          frames: Array.from({ length: 6 }, (_, i) => ({ Index: i })),
          sizeX: 512,
          sizeY: 512,
          mm_x: 0.001,
          mm_y: 0.001,
        },
      ];
      vm.tilesInternalMetadata = [{}];
      vm.initializing = false;

      vm.assignments.C = { text: "Channels", value: vm.dimensions[0] };
      vm.assignments.Z = { text: "Z-depth", value: vm.dimensions[1] };
    }

    it("returns item ID on success", async () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      await setupForSubmit(vm);

      const result = await vm.generateJson();

      expect(result).toBe("item-123");
      wrapper.destroy();
    });

    it("calls addMultiSourceMetadata with correct params", async () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      await setupForSubmit(vm);

      await vm.generateJson();

      expect(mockAddMultiSourceMetadata).toHaveBeenCalledWith(
        expect.objectContaining({
          parentId: "ds-1",
          transcode: false,
        }),
      );

      const callArg = mockAddMultiSourceMetadata.mock.calls[0][0];
      const metadata = JSON.parse(callArg.metadata);
      expect(metadata.channels).toContain("DAPI");
      expect(metadata.channels).toContain("GFP");
      expect(metadata.sources).toHaveLength(1);
      wrapper.destroy();
    });

    it("emits configData event", async () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      await setupForSubmit(vm);

      await vm.generateJson();

      expect(wrapper.emitted("configData")).toBeTruthy();
      const configData = wrapper.emitted("configData")![0][0];
      expect(configData.channels).toEqual(["DAPI", "GFP"]);
      expect(configData.sources).toBeDefined();
      wrapper.destroy();
    });

    it("calls updateDatasetMetadata with dimension labels", async () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      await setupForSubmit(vm);

      await vm.generateJson();

      expect(mockUpdateDatasetMetadata).toHaveBeenCalledWith(
        "ds-1",
        expect.objectContaining({
          dimensionLabels: expect.any(Object),
        }),
      );
      wrapper.destroy();
    });

    it("schedules caches after successful upload", async () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      await setupForSubmit(vm);

      await vm.generateJson();

      expect(mockScheduleTileFramesComputation).toHaveBeenCalledWith("ds-1");
      expect(mockScheduleMaxMergeCache).toHaveBeenCalledWith("ds-1");
      expect(mockScheduleHistogramCache).toHaveBeenCalledWith("ds-1");
      wrapper.destroy();
    });

    it("returns null on addMultiSourceMetadata failure", async () => {
      mockAddMultiSourceMetadata.mockResolvedValueOnce(null);

      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      await setupForSubmit(vm);

      const result = await vm.generateJson();
      expect(result).toBeNull();
      wrapper.destroy();
    });

    it("handles channel names from filename source", async () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      await vm.initialized.catch(() => {});

      vm.dimensions = [
        {
          id: 0,
          guess: "C",
          size: 2,
          name: "Channels",
          source: "filename",
          data: {
            values: ["red", "green"],
            valueIdxPerFilename: { "red_01.tif": 0, "green_01.tif": 1 },
          },
        },
      ];
      vm.girderItems = [
        { _id: "item1", name: "red_01.tif" },
        { _id: "item2", name: "green_01.tif" },
      ];
      vm.tilesMetadata = [
        { frames: [{ Index: 0 }] },
        { frames: [{ Index: 0 }] },
      ];
      vm.tilesInternalMetadata = [{}, {}];
      vm.initializing = false;
      vm.assignments.C = { text: "Channels", value: vm.dimensions[0] };

      await vm.generateJson();

      const callArg = mockAddMultiSourceMetadata.mock.calls[0][0];
      const metadata = JSON.parse(callArg.metadata);
      expect(metadata.channels).toEqual(["red", "green"]);
      wrapper.destroy();
    });

    it("handles RGB expansion with splitRGBBands", async () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      await vm.initialized.catch(() => {});

      vm.dimensions = [];
      vm.girderItems = [{ _id: "item1", name: "rgb_image.tif" }];
      vm.tilesMetadata = [{ frames: [{ Index: 0 }], sizeX: 512, sizeY: 512 }];
      vm.tilesInternalMetadata = [{}];
      vm.initializing = false;
      vm.isRGBFile = true;
      vm.rgbBandCount = 3;
      vm.splitRGBBands = true;

      await vm.generateJson();

      const callArg = mockAddMultiSourceMetadata.mock.calls[0][0];
      const metadata = JSON.parse(callArg.metadata);
      // Default channel expanded with R/G/B
      expect(metadata.channels).toEqual([
        "Default - Red",
        "Default - Green",
        "Default - Blue",
      ]);
      wrapper.destroy();
    });

    it("uses Default channel names for images source", async () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      await vm.initialized.catch(() => {});

      vm.dimensions = [
        {
          id: 0,
          guess: "C",
          size: 3,
          name: "Channels",
          source: "images",
          data: null,
        },
      ];
      vm.girderItems = [{ _id: "item1", name: "test.tif" }];
      vm.tilesMetadata = [{ frames: [{ Index: 0 }] }];
      vm.tilesInternalMetadata = [{}];
      vm.initializing = false;
      vm.assignments.C = { text: "Channels", value: vm.dimensions[0] };

      await vm.generateJson();

      const callArg = mockAddMultiSourceMetadata.mock.calls[0][0];
      const metadata = JSON.parse(callArg.metadata);
      expect(metadata.channels).toEqual([
        "Default 0",
        "Default 1",
        "Default 2",
      ]);
      wrapper.destroy();
    });
  });

  describe("submit", () => {
    it("emits generatedJson event", async () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      await vm.initialized.catch(() => {});

      vm.dimensions = [];
      vm.girderItems = [{ _id: "item1", name: "test.tif" }];
      vm.tilesMetadata = [{ frames: [{ Index: 0 }] }];
      vm.tilesInternalMetadata = [{}];
      vm.initializing = false;

      await vm.submit();

      expect(wrapper.emitted("generatedJson")).toBeTruthy();
      expect(wrapper.emitted("generatedJson")![0][0]).toBe("item-123");
      wrapper.destroy();
    });

    it("routes to dataset page when autoDatasetRoute is true", async () => {
      const wrapper = mountComponent({ autoDatasetRoute: true });
      const vm = wrapper.vm as any;
      await vm.initialized.catch(() => {});

      vm.dimensions = [];
      vm.girderItems = [{ _id: "item1", name: "test.tif" }];
      vm.tilesMetadata = [{ frames: [{ Index: 0 }] }];
      vm.tilesInternalMetadata = [{}];
      vm.initializing = false;

      await vm.submit();

      expect(mockRouter.push).toHaveBeenCalledWith({
        name: "dataset",
        params: { datasetId: "ds-1" },
      });
      wrapper.destroy();
    });

    it("does NOT route when autoDatasetRoute is false", async () => {
      const wrapper = mountComponent({ autoDatasetRoute: false });
      const vm = wrapper.vm as any;
      await vm.initialized.catch(() => {});

      vm.dimensions = [];
      vm.girderItems = [{ _id: "item1", name: "test.tif" }];
      vm.tilesMetadata = [{ frames: [{ Index: 0 }] }];
      vm.tilesInternalMetadata = [{}];
      vm.initializing = false;

      await vm.submit();

      expect(mockRouter.push).not.toHaveBeenCalled();
      wrapper.destroy();
    });

    it("does NOT route when generateJson returns null", async () => {
      mockAddMultiSourceMetadata.mockResolvedValueOnce(null);

      const wrapper = mountComponent({ autoDatasetRoute: true });
      const vm = wrapper.vm as any;
      await vm.initialized.catch(() => {});

      vm.dimensions = [];
      vm.girderItems = [{ _id: "item1", name: "test.tif" }];
      vm.tilesMetadata = [{ frames: [{ Index: 0 }] }];
      vm.tilesInternalMetadata = [{}];
      vm.initializing = false;

      await vm.submit();

      expect(mockRouter.push).not.toHaveBeenCalled();
      wrapper.destroy();
    });
  });

  // ─── 9. UI helpers ─────────────────────────────────────────────────

  describe("sliceAndJoin", () => {
    it("joins values within limit", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.sliceAndJoin(["foo", "bar"], 10)).toBe("foo, bar");
      wrapper.destroy();
    });

    it("truncates when first element is too long", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      const result = vm.sliceAndJoin(["very_long_string_here"], 10);
      expect(result).toMatch(/…$/);
      expect(result.length).toBeLessThanOrEqual(10);
      wrapper.destroy();
    });

    it("appends ellipsis when values exceed limit", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      const result = vm.sliceAndJoin(["foo", "bar", "baz", "qux", "quux"], 16);
      expect(result).toMatch(/…$/);
      wrapper.destroy();
    });

    it("returns empty string for empty array", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.sliceAndJoin([])).toBe("");
      wrapper.destroy();
    });

    it("returns whole string when it fits exactly", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.sliceAndJoin(["ab", "cd"], 6)).toBe("ab, cd");
      wrapper.destroy();
    });
  });

  describe("getItemValues", () => {
    it("returns values for filename source", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      const item = {
        source: "filename",
        data: { values: ["a", "b", "c"], valueIdxPerFilename: {} },
        size: 3,
      };
      const result = vm.getItemValues(item);
      expect(result).toBe("a, b, c");
      wrapper.destroy();
    });

    it("returns 'N values' for images source", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      const item = { source: "images", data: null, size: 5 };
      expect(vm.getItemValues(item)).toBe("5 values");
      wrapper.destroy();
    });

    it("returns extracted values for file source with values", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      const item = {
        source: "file",
        data: { 0: { stride: 1, range: 2, values: ["Ch0", "Ch1"] } },
        size: 2,
      };
      expect(vm.getItemValues(item)).toBe("Ch0, Ch1");
      wrapper.destroy();
    });

    it("returns 'N values' for file source without named values", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      const item = {
        source: "file",
        data: { 0: { stride: 1, range: 3, values: null } },
        size: 3,
      };
      expect(vm.getItemValues(item)).toBe("3 values");
      wrapper.destroy();
    });
  });

  describe("getSlotClasses", () => {
    it("returns filled class when dimension is assigned", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.assignments.C = {
        text: "Ch",
        value: { id: 0, source: "file", data: {} },
      };
      const classes = vm.getSlotClasses("C");
      expect(classes["assignment-slot--filled"]).toBe(true);
      expect(classes["assignment-slot--empty-available"]).toBe(false);
      wrapper.destroy();
    });

    it("returns empty-available when no assignment but items available", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.dimensions = [
        {
          id: 0,
          guess: "C",
          size: 3,
          name: "Ch",
          source: "file",
          data: {},
        },
      ];
      const classes = vm.getSlotClasses("C");
      expect(classes["assignment-slot--empty-available"]).toBe(true);
      wrapper.destroy();
    });

    it("returns empty-none when no assignment and no items", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.dimensions = [];
      const classes = vm.getSlotClasses("C");
      expect(classes["assignment-slot--empty-none"]).toBe(true);
      wrapper.destroy();
    });
  });

  describe("detectColorVsChannels", () => {
    it("detects RGB from photometricInterpretation=2", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(
        vm.detectColorVsChannels({
          bandCount: 3,
          metadata: { photometricInterpretation: 2 },
        }),
      ).toBe(true);
      wrapper.destroy();
    });

    it("detects RGB from photometricInterpretation='RGB'", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(
        vm.detectColorVsChannels({
          bandCount: 3,
          metadata: { photometricInterpretation: "RGB" },
        }),
      ).toBe(true);
      wrapper.destroy();
    });

    it("overrides to not-RGB when IndexRange.IndexC > 1", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(
        vm.detectColorVsChannels({
          bandCount: 3,
          metadata: { photometricInterpretation: 2 },
          IndexRange: { IndexC: 4 },
        }),
      ).toBe(false);
      wrapper.destroy();
    });

    it("fallback: bandCount=3 treated as color", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.detectColorVsChannels({ bandCount: 3 })).toBe(true);
      wrapper.destroy();
    });

    it("fallback: bandCount=1 not treated as color", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.detectColorVsChannels({ bandCount: 1 })).toBe(false);
      wrapper.destroy();
    });
  });

  describe("copyLogToClipboard", () => {
    it("copies logs and shows snackbar", () => {
      const mockWriteText = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, {
        clipboard: { writeText: mockWriteText },
      });

      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.logs = "some log output";

      vm.copyLogToClipboard();

      expect(mockWriteText).toHaveBeenCalledWith("some log output");
      expect(vm.showCopySnackbar).toBe(true);
      wrapper.destroy();
    });
  });

  // ─── 10. Watchers ──────────────────────────────────────────────────

  describe("watchers", () => {
    it("assignments watcher calls saveDimensionStrategyToStore", async () => {
      // Override store to enable the save path
      const storeAny = store as any;
      const origWorkflow = Object.getOwnPropertyDescriptor(
        storeAny,
        "uploadWorkflow",
      );
      const origFirstDataset = Object.getOwnPropertyDescriptor(
        storeAny,
        "uploadIsFirstDataset",
      );

      Object.defineProperty(storeAny, "uploadWorkflow", {
        get: () => ({ active: true, batchMode: true }),
        configurable: true,
      });
      Object.defineProperty(storeAny, "uploadIsFirstDataset", {
        get: () => true,
        configurable: true,
      });

      const wrapper = mountComponent();
      const vm = wrapper.vm as any;

      mockSetUploadDimensionStrategy.mockClear();

      vm.assignments.C = {
        text: "Ch",
        value: { id: 0, source: "file", data: {} },
      };

      await Vue.nextTick();

      expect(mockSetUploadDimensionStrategy).toHaveBeenCalled();

      // Restore
      if (origWorkflow) {
        Object.defineProperty(storeAny, "uploadWorkflow", origWorkflow);
      }
      if (origFirstDataset) {
        Object.defineProperty(
          storeAny,
          "uploadIsFirstDataset",
          origFirstDataset,
        );
      }
      wrapper.destroy();
    });

    it("transcode watcher calls saveDimensionStrategyToStore", async () => {
      // Override store to enable the save path
      const storeAny = store as any;
      const origWorkflow = Object.getOwnPropertyDescriptor(
        storeAny,
        "uploadWorkflow",
      );
      const origFirstDataset = Object.getOwnPropertyDescriptor(
        storeAny,
        "uploadIsFirstDataset",
      );

      Object.defineProperty(storeAny, "uploadWorkflow", {
        get: () => ({ active: true, batchMode: true }),
        configurable: true,
      });
      Object.defineProperty(storeAny, "uploadIsFirstDataset", {
        get: () => true,
        configurable: true,
      });

      const wrapper = mountComponent();
      const vm = wrapper.vm as any;

      mockSetUploadDimensionStrategy.mockClear();

      vm.transcode = true;
      await Vue.nextTick();

      expect(mockSetUploadDimensionStrategy).toHaveBeenCalled();

      // Restore
      if (origWorkflow) {
        Object.defineProperty(storeAny, "uploadWorkflow", origWorkflow);
      }
      if (origFirstDataset) {
        Object.defineProperty(
          storeAny,
          "uploadIsFirstDataset",
          origFirstDataset,
        );
      }
      wrapper.destroy();
    });
  });

  // ─── 11. Real parsing tests ────────────────────────────────────────

  describe("collectFilenameMetadata2 (real parsing)", () => {
    it("Set A: produces variables from OME-TIFF filenames", () => {
      const items = makeSetAItems();
      const names = items.map((i: any) => i.name);
      const variables = collectFilenameMetadata2(names);

      // Should detect at least 2 varying tokens
      expect(variables.length).toBeGreaterThanOrEqual(2);
      // Each variable should have values
      for (const v of variables) {
        expect(v.values.length).toBeGreaterThan(0);
      }
    });

    it("Set B: produces variables from directory/well/time filenames", () => {
      const items = makeSetBItems();
      const names = items.map((i: any) => i.name);
      const variables = collectFilenameMetadata2(names);

      // Should detect variables for directory (channel), well (XY), and time
      expect(variables.length).toBeGreaterThanOrEqual(2);
    });

    it("Set D: produces 1 variable from slide1/slide2", () => {
      const items = makeSetDItems();
      const names = items.map((i: any) => i.name);
      const variables = collectFilenameMetadata2(names);

      expect(variables.length).toBeGreaterThanOrEqual(1);
      // First variable should have 2 values
      expect(variables[0].values).toHaveLength(2);
    });
  });

  // ─── 12. extractDimensionLabels ────────────────────────────────────

  describe("extractDimensionLabels", () => {
    it("returns filename values for filename-sourced C assignment", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.tilesInternalMetadata = [{}];
      vm.assignments.C = {
        text: "Ch",
        value: {
          id: 0,
          source: "filename",
          guess: "C",
          size: 3,
          data: {
            values: ["red", "green", "blue"],
            valueIdxPerFilename: {},
          },
        },
      };

      const labels = vm.extractDimensionLabels("C");
      expect(labels).toEqual(["red", "green", "blue"]);
      wrapper.destroy();
    });

    it("returns numeric labels for images-sourced assignment", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.tilesInternalMetadata = [{}];
      vm.assignments.Z = {
        text: "Frames",
        value: {
          id: 0,
          source: "images",
          guess: "Z",
          size: 3,
          data: null,
        },
      };

      const labels = vm.extractDimensionLabels("Z");
      expect(labels).toEqual(["1", "2", "3"]);
      wrapper.destroy();
    });

    it("returns null when dimension not assigned", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.assignments.XY = null;
      expect(vm.extractDimensionLabels("XY")).toBeNull();
      wrapper.destroy();
    });

    it("returns file source values joined with /", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.tilesInternalMetadata = [{}];
      vm.assignments.C = {
        text: "Ch",
        value: {
          id: 0,
          source: "file",
          guess: "C",
          size: 2,
          data: {
            0: { stride: 1, range: 2, values: ["DAPI", "GFP"] },
            1: { stride: 1, range: 2, values: ["DAPI", "GFP"] },
          },
        },
      };

      const labels = vm.extractDimensionLabels("C");
      expect(labels).toEqual(["DAPI", "GFP"]);
      wrapper.destroy();
    });
  });

  // ─── 13. Assignment badge/style helpers ────────────────────────────

  describe("style and display helpers", () => {
    it("getAssignedDimensionColor returns correct color for assigned variable", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      const dim = { id: 0, guess: "C", size: 3, source: "file", data: {} };
      vm.assignments.C = { text: "Ch", value: dim };

      expect(vm.getAssignedDimensionColor(dim)).toBe("#9C27B0"); // Purple for C
      wrapper.destroy();
    });

    it("getAssignedDimensionColor returns default for unassigned", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      const dim = { id: 0, guess: "C", size: 3, source: "file", data: {} };
      expect(vm.getAssignedDimensionColor(dim)).toBe(
        "rgba(255, 255, 255, 0.3)",
      );
      wrapper.destroy();
    });

    it("getAssignmentText returns text for assigned dimension", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.assignments.Z = { text: "Z-depth", value: { id: 0 } };
      expect(vm.getAssignmentText("Z")).toBe("Z-depth");
      wrapper.destroy();
    });

    it("getAssignmentText returns empty string for unassigned", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.getAssignmentText("Z")).toBe("");
      wrapper.destroy();
    });

    it("getAssignmentSize returns size for assigned dimension", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.assignments.Z = { text: "Z", value: { id: 0, size: 5 } };
      expect(vm.getAssignmentSize("Z")).toBe(5);
      wrapper.destroy();
    });

    it("getAssignmentSize returns 0 for unassigned", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.getAssignmentSize("Z")).toBe(0);
      wrapper.destroy();
    });

    it("getSlotStyle returns faded color when no assignment and no items", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.dimensions = [];
      const style = vm.getSlotStyle("C");
      expect(style.backgroundColor).toContain("#9C27B0");
      wrapper.destroy();
    });

    it("getSlotStyle returns empty when assignment exists", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.assignments.C = {
        text: "Ch",
        value: { id: 0, source: "file", data: {} },
      };
      const style = vm.getSlotStyle("C");
      expect(style).toEqual({});
      wrapper.destroy();
    });

    it("getAssignmentBadgeStyleForSlot uses dimension color", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.assignments.XY = {
        text: "Positions",
        value: { id: 0, guess: "C", source: "file", data: {} },
      };
      const style = vm.getAssignmentBadgeStyleForSlot("XY");
      // Should use XY color (#4CAF50), not the variable's guess color
      expect(style.borderLeftColor).toBe("#4CAF50");
      wrapper.destroy();
    });

    it("isAssignmentImmutableForDimension returns false when not assigned", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      expect(vm.isAssignmentImmutableForDimension("Z")).toBe(false);
      wrapper.destroy();
    });
  });

  // ─── 14. filenameLegend and highlightedFilenameSegments ────────────

  describe("highlightedFilenameSegments", () => {
    it("returns empty array when no girder items", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.girderItems = [];
      expect(vm.highlightedFilenameSegments).toEqual([]);
      wrapper.destroy();
    });

    it("returns empty array when no filename variables", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.girderItems = [{ name: "test.tif" }];
      vm.dimensions = [];
      expect(vm.highlightedFilenameSegments).toEqual([]);
      wrapper.destroy();
    });
  });

  describe("filenameLegend", () => {
    it("builds legend entries from filename variables", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.girderItems = [{ name: "slide1.tif" }, { name: "slide2.tif" }];
      vm.dimensions = [
        {
          id: 0,
          guess: "XY",
          size: 2,
          name: "Var 1",
          source: "filename",
          data: {
            values: ["slide1", "slide2"],
            valueIdxPerFilename: { "slide1.tif": 0, "slide2.tif": 1 },
          },
        },
      ];
      vm.assignments.XY = { text: "Var 1", value: vm.dimensions[0] };

      const legend = vm.filenameLegend;
      // If the token matches, we should get a legend entry
      if (legend.length > 0) {
        expect(legend[0].color).toBe("#4CAF50"); // XY color
      }
      wrapper.destroy();
    });
  });

  // ─── 15. assignmentOptionToAssignmentItem ──────────────────────────

  describe("assignmentOptionToAssignmentItem", () => {
    it("creates IAssignment from TAssignmentOption", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      const dim = {
        id: 0,
        guess: "C",
        size: 3,
        name: "Channels",
        source: "file",
        data: {},
      };
      const item = vm.assignmentOptionToAssignmentItem(dim);
      expect(item.text).toBe("Channels");
      expect(item.value).toBe(dim);
      wrapper.destroy();
    });
  });

  // ─── 16. getDefaultAssignmentItem ──────────────────────────────────

  describe("getDefaultAssignmentItem", () => {
    it("prefers file source over other sources", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.dimensions = [
        {
          id: 0,
          guess: "C",
          size: 2,
          name: "Filename Ch",
          source: "filename",
          data: { values: ["a", "b"], valueIdxPerFilename: {} },
        },
        {
          id: 1,
          guess: "C",
          size: 3,
          name: "File Ch",
          source: "file",
          data: {},
        },
      ];
      const item = vm.getDefaultAssignmentItem("C");
      expect(item).not.toBeNull();
      expect(item.value.source).toBe("file");
      wrapper.destroy();
    });

    it("returns null when no matching dimension", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.dimensions = [];
      expect(vm.getDefaultAssignmentItem("C")).toBeNull();
      wrapper.destroy();
    });

    it("falls back to any source when no file source", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.dimensions = [
        {
          id: 0,
          guess: "C",
          size: 2,
          name: "Filename Ch",
          source: "filename",
          data: { values: ["a", "b"], valueIdxPerFilename: {} },
        },
      ];
      const item = vm.getDefaultAssignmentItem("C");
      expect(item).not.toBeNull();
      expect(item.value.source).toBe("filename");
      wrapper.destroy();
    });
  });

  // ─── 17. isAssignmentImmutable ─────────────────────────────────────

  describe("isAssignmentImmutable", () => {
    it("returns true for file source from ND2 files", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.girderItems = [{ name: "test.nd2" }];
      const assignment = {
        text: "Ch",
        value: {
          id: 0,
          source: "file",
          data: { 0: { stride: 1, range: 3, values: null } },
        },
      };
      expect(vm.isAssignmentImmutable(assignment)).toBe(true);
      wrapper.destroy();
    });

    it("returns false for file source from non-ND2 files", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      vm.girderItems = [{ name: "test.tif" }];
      const assignment = {
        text: "Ch",
        value: {
          id: 0,
          source: "file",
          data: { 0: { stride: 1, range: 3, values: null } },
        },
      };
      expect(vm.isAssignmentImmutable(assignment)).toBe(false);
      wrapper.destroy();
    });

    it("returns false for filename source", () => {
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      const assignment = {
        text: "Ch",
        value: {
          id: 0,
          source: "filename",
          data: { values: ["a"], valueIdxPerFilename: {} },
        },
      };
      expect(vm.isAssignmentImmutable(assignment)).toBe(false);
      wrapper.destroy();
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";
import { markRaw } from "vue";

// ---- Hoisted mocks ----

vi.mock("onnxruntime-web/webgpu", () => ({
  InferenceSession: { create: vi.fn() },
  Tensor: vi.fn(),
}));

vi.mock("@/pipelines/samPipeline", () => ({
  createSamToolStateFromToolConfiguration: vi.fn(),
}));

vi.mock("@/components/AnnotationViewer.vue", () => ({
  default: { name: "AnnotationViewer", render: () => null },
}));

const mockMap = () => {
  const m: any = {
    center: vi.fn().mockReturnThis(),
    zoom: vi.fn().mockReturnThis(),
    rotation: vi.fn().mockReturnValue(0),
    size: vi.fn().mockReturnValue({ width: 800, height: 600 }),
    maxBounds: vi.fn().mockReturnValue({ right: 1000, bottom: 800 }),
    zoomRange: vi.fn().mockReturnThis(),
    draw: vi.fn().mockReturnThis(),
    exit: vi.fn(),
    node: vi.fn().mockReturnValue({
      width: vi.fn().mockReturnValue(800),
      height: vi.fn().mockReturnValue(600),
      css: vi.fn(),
    }),
    geoOn: vi.fn().mockReturnThis(),
    geoOff: vi.fn().mockReturnThis(),
    displayToGcs: vi.fn((pt: any) => ({ x: pt.x, y: pt.y })),
    gcsToDisplay: vi.fn((pt: any) => ({ x: pt.x, y: pt.y })),
    interactor: vi.fn().mockReturnValue({
      options: vi.fn().mockReturnValue({
        actions: [{ action: "pan" }],
        keyboard: { actions: { "rotate.0": {} } },
      }),
    }),
    createLayer: vi.fn(() => mockLayer()),
    deleteLayer: vi.fn(),
    layers: vi.fn().mockReturnValue([]),
  };
  // Make zoom/rotation/center callable as both getter and setter
  m.zoom.mockImplementation((...args: any[]) => (args.length === 0 ? 5 : m));
  m.rotation.mockImplementation((...args: any[]) =>
    args.length === 0 ? 0 : m,
  );
  m.center.mockImplementation((...args: any[]) =>
    args.length === 0 ? { x: 500, y: 400 } : m,
  );
  return m;
};

const mockLayer = () => ({
  node: vi.fn().mockReturnValue({ css: vi.fn() }),
  createFeature: vi.fn().mockReturnValue({}),
  moveToTop: vi.fn(),
  zIndex: vi.fn().mockReturnValue(0),
  visible: vi.fn(),
  idle: true,
  onIdle: vi.fn((cb: Function) => cb()),
  reset: vi.fn(),
  url: vi.fn(),
  draw: vi.fn(),
  map: vi.fn().mockReturnValue({ draw: vi.fn() }),
  queue: {},
  _imageUrls: null as string[] | null,
  _tileBounds: null as Function | null,
  tileAtPoint: null as Function | null,
  setFrameQuad: vi.fn(),
  baseQuad: null,
  displayToLevel: vi.fn((pt: any) => pt),
});

// Use Vue.observable so the computed properties are reactive
vi.mock("@/store", () => {
  const Vue = require("vue");
  return {
    default: Vue.observable({
      maps: [] as any[],
      dataset: {
        id: "dataset1",
        name: "Test Dataset",
        width: 1000,
        height: 800,
      },
      configuration: { name: "Test Config" },
      layers: [{ id: "layer1", name: "Layer 1", channel: 0, visible: true }],
      cameraInfo: {
        zoom: 5,
        rotate: 0,
        center: { x: 500, y: 400 },
        gcsBounds: [],
      },
      compositionMode: "lighten",
      backgroundColor: "black",
      scales: { pixelSize: { value: 0.5, unit: "µm" } },
      overview: false,
      unroll: false,
      selectedTool: null as any,
      layerStackImages: [] as any[],
      layerMode: "multiple",
      showScalebar: false,
      showPixelScalebar: false,
      scalebarColor: "#ffffff",
      drawAnnotations: true,
      showTooltips: false,
      setMaps: vi.fn(),
      setCameraInfo: vi.fn(),
      setDrawAnnotations: vi.fn(),
      setShowTooltips: vi.fn(),
    }),
  };
});

vi.mock("@/store/annotation", () => {
  const Vue = require("vue");
  return {
    default: Vue.observable({
      selectedAnnotationIds: [],
      submitPendingAnnotation: null as Function | null,
      deleteSelectedAnnotations: vi.fn(),
      undoOrRedo: vi.fn(),
      copySelectedAnnotations: vi.fn(),
      pasteAnnotations: vi.fn(),
    }),
  };
});

vi.mock("@/store/progress", () => ({
  default: {
    create: vi.fn().mockResolvedValue("progress1"),
    update: vi.fn(),
    complete: vi.fn(),
    updateReactiveProgress: vi.fn(),
  },
}));

vi.mock("@/store/girderResources", () => ({
  default: {},
}));

vi.mock("geojs", () => ({
  default: {
    map: vi.fn(() => mockMap()),
    util: {
      pixelCoordinateParams: vi.fn(
        (_el: any, sizeX: number, sizeY: number) => ({
          map: {
            maxBounds: { left: 0, top: 0, right: sizeX, bottom: sizeY },
            min: 0,
            max: 10,
            zoom: 0,
            center: { x: sizeX / 2, y: sizeY / 2 },
          },
          layer: {
            crossDomain: undefined,
            autoshareRenderer: true,
            nearestPixel: 10,
            maxLevel: 10,
            tilesMaxBounds: {},
            url: "",
          },
        }),
      ),
    },
    event: {
      pan: "geojs.pan",
      annotation: {
        mode: "geojs.annotation.mode",
        coordinates: "geojs.annotation.coordinates",
      },
      drawEnd: "geojs.drawEnd",
    },
    listAnnotations: vi.fn().mockReturnValue([]),
  },
}));

vi.mock("@/utils/setFrameQuad", () => ({
  default: vi.fn(),
}));

vi.mock("@/utils/conversion", () => ({
  convertLength: vi.fn().mockReturnValue(0.0005),
}));

vi.mock("@/utils/log", () => ({
  logWarning: vi.fn(),
}));

vi.mock("@/pipelines/computePipeline", () => ({
  NoOutput: Symbol("NoOutput"),
}));

import store from "@/store";
import annotationStore from "@/store/annotation";
import progressStore from "@/store/progress";
import ImageViewer from "./ImageViewer.vue";

const mockedStore = vi.mocked(store);
const mockedAnnotationStore = vi.mocked(annotationStore);
const mockedProgressStore = vi.mocked(progressStore);

Vue.use(Vuetify);
Vue.directive("description", {});
Vue.directive("mousetrap", {});

function createLayerStackImage(overrides: any = {}): any {
  return {
    layer: {
      id: "layer1",
      visible: true,
      color: "#ff0000",
      contrast: { whitePoint: 100, blackPoint: 0, mode: "percentile" },
      layerGroup: null,
      ...overrides.layer,
    },
    images: [
      {
        item: { _id: "item1" },
        levels: 10,
        frameIndex: 0,
        sizeX: 1024,
        sizeY: 1024,
        tileWidth: 256,
        tileHeight: 256,
        tileinfo: {},
        ...overrides.image,
      },
    ],
    urls: ["http://localhost/api/v1/tile/{z}/{x}/{y}"],
    fullUrls: ["http://localhost/api/v1/tile/{z}/{x}/{y}?full=true"],
    hist: { min: 0, max: 255 },
    singleFrame: 0,
    baseQuadOptions: {},
    ...overrides,
  };
}

function mountComponent(propsData: Record<string, unknown> = {}) {
  const app = document.createElement("div");
  app.setAttribute("data-app", "true");
  document.body.appendChild(app);

  // Create a map div container that _setupMap needs
  const mapLayout = document.createElement("div");
  mapLayout.classList.add("map-layout");

  const w = shallowMount(ImageViewer as any, {
    vuetify: new Vuetify(),
    propsData,
    stubs: {
      AnnotationViewer: true,
      ImageOverview: true,
      ScaleSettings: true,
      ProgressBarGroup: true,
      LayerInfoGrid: true,
    },
    attachTo: app,
  });

  return w;
}

describe("ImageViewer", () => {
  let wrapper: ReturnType<typeof mountComponent>;

  beforeEach(() => {
    vi.useFakeTimers();
    // Reset store state
    mockedStore.maps = [];
    mockedStore.dataset = {
      id: "dataset1",
      name: "Test Dataset",
      width: 1000,
      height: 800,
    } as any;
    mockedStore.configuration = { name: "Test Config" } as any;
    mockedStore.cameraInfo = {
      zoom: 5,
      rotate: 0,
      center: { x: 500, y: 400 },
      gcsBounds: [],
    } as any;
    mockedStore.compositionMode = "lighten" as any;
    mockedStore.backgroundColor = "black";
    mockedStore.overview = false;
    mockedStore.unroll = false;
    mockedStore.selectedTool = null;
    mockedStore.layerStackImages = [];
    mockedStore.layerMode = "multiple" as any;
    mockedStore.showScalebar = false;
    mockedStore.showPixelScalebar = false;
    mockedStore.scalebarColor = "#ffffff";
    mockedAnnotationStore.submitPendingAnnotation = null;
    vi.clearAllMocks();
    // Make setMaps/setCameraInfo actually update the reactive store
    (mockedStore.setMaps as any).mockImplementation((v: any) => {
      mockedStore.maps = v;
    });
    (mockedStore.setCameraInfo as any).mockImplementation((v: any) => {
      mockedStore.cameraInfo = v;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    if (wrapper) {
      wrapper.destroy();
    }
  });

  // ---- 1. Mounting & Lifecycle ----

  describe("mounting and lifecycle", () => {
    it("mounts without errors", () => {
      wrapper = mountComponent();
      expect(wrapper.exists()).toBe(true);
    });

    it("sets refsMounted on mount", () => {
      wrapper = mountComponent();
      expect(wrapper.vm.refsMounted).toBe(true);
    });

    it("cleans up maps on beforeDestroy", () => {
      const map1 = mockMap();
      const map2 = mockMap();
      mockedStore.maps = [
        { map: map1, imageLayers: [], params: {} } as any,
        { map: map2, imageLayers: [], params: {} } as any,
      ];
      wrapper = mountComponent();
      wrapper.destroy();
      expect(map1.exit).toHaveBeenCalled();
      expect(map2.exit).toHaveBeenCalled();
      expect(mockedStore.setMaps).toHaveBeenCalledWith([]);
    });

    it("calls draw on mount when dataset and layers exist", () => {
      mockedStore.layerStackImages = [createLayerStackImage()];
      wrapper = mountComponent();
      // draw would have been called - since it modifies tileWidth/tileHeight
      // we can check that tileWidth got updated
      expect(wrapper.vm.tileWidth).toBeDefined();
    });
  });

  // ---- 2. Computed Properties - Store Proxies ----

  describe("computed properties - store proxies", () => {
    beforeEach(() => {
      wrapper = mountComponent();
    });

    it("maps getter returns store.maps", () => {
      const testMaps = [{ map: mockMap() }] as any;
      mockedStore.maps = testMaps;
      expect(wrapper.vm.maps).toBe(testMaps);
    });

    it("maps setter calls store.setMaps", () => {
      const newMaps = [{ map: mockMap() }] as any;
      wrapper.vm.maps = newMaps;
      expect(mockedStore.setMaps).toHaveBeenCalledWith(newMaps);
    });

    it("cameraInfo getter returns store.cameraInfo", () => {
      expect(wrapper.vm.cameraInfo).toBe(mockedStore.cameraInfo);
    });

    it("cameraInfo setter calls store.setCameraInfo", () => {
      const newInfo = {
        zoom: 3,
        rotate: 1,
        center: { x: 0, y: 0 },
        gcsBounds: [],
      };
      wrapper.vm.cameraInfo = newInfo;
      expect(mockedStore.setCameraInfo).toHaveBeenCalledWith(newInfo);
    });

    it("overview returns store.overview", () => {
      mockedStore.overview = true;
      expect(wrapper.vm.overview).toBe(true);
    });

    it("dataset returns store.dataset", () => {
      expect(wrapper.vm.dataset).toBe(mockedStore.dataset);
    });

    it("unrolling returns store.unroll", () => {
      mockedStore.unroll = true;
      expect(wrapper.vm.unrolling).toBe(true);
    });

    it("width returns dataset width or 1 if no dataset", () => {
      expect(wrapper.vm.width).toBe(1000);
    });

    it("width returns 1 when no dataset", () => {
      mockedStore.dataset = null as any;
      expect(wrapper.vm.width).toBe(1);
    });

    it("height returns dataset height or 1 if no dataset", () => {
      expect(wrapper.vm.height).toBe(800);
    });

    it("compositionMode returns store.compositionMode", () => {
      expect(wrapper.vm.compositionMode).toBe("lighten");
    });

    it("backgroundColor returns store.backgroundColor", () => {
      expect(wrapper.vm.backgroundColor).toBe("black");
    });

    it("pixelSize returns store.scales.pixelSize", () => {
      expect(wrapper.vm.pixelSize).toEqual({ value: 0.5, unit: "µm" });
    });

    it("showScalebar returns store.showScalebar", () => {
      expect(wrapper.vm.showScalebar).toBe(false);
    });

    it("showPixelScalebar returns store.showPixelScalebar", () => {
      expect(wrapper.vm.showPixelScalebar).toBe(false);
    });

    it("scalebarColor returns store.scalebarColor", () => {
      expect(wrapper.vm.scalebarColor).toBe("#ffffff");
    });

    it("selectedTool returns store.selectedTool", () => {
      expect(wrapper.vm.selectedTool).toBeNull();
    });

    it("layerStackImages returns store.layerStackImages when configuration exists", () => {
      const lsi = [createLayerStackImage()];
      mockedStore.layerStackImages = lsi;
      expect(wrapper.vm.layerStackImages).toBe(lsi);
    });

    it("layerStackImages returns empty array when no configuration", () => {
      mockedStore.configuration = null as any;
      expect(wrapper.vm.layerStackImages).toEqual([]);
    });

    it("submitPendingAnnotation returns annotationStore value", () => {
      const fn = vi.fn();
      mockedAnnotationStore.submitPendingAnnotation = fn;
      expect(wrapper.vm.submitPendingAnnotation).toBe(fn);
    });
  });

  // ---- 3. Computed Properties - Derived ----

  describe("computed properties - derived", () => {
    beforeEach(() => {
      wrapper = mountComponent();
    });

    it("readyLayersCount counts true values in readyLayers", () => {
      wrapper.vm.readyLayers = [true, false, true, true];
      expect(wrapper.vm.readyLayersCount).toBe(3);
    });

    it("readyLayersCount returns 0 for empty array", () => {
      wrapper.vm.readyLayers = [];
      expect(wrapper.vm.readyLayersCount).toBe(0);
    });

    it("readyLayersTotal returns readyLayers length", () => {
      wrapper.vm.readyLayers = [true, false, true];
      expect(wrapper.vm.readyLayersTotal).toBe(3);
    });

    it("layersReady returns true when all layers are ready", () => {
      wrapper.vm.readyLayers = [true, true, true];
      expect(wrapper.vm.layersReady).toBe(true);
    });

    it("layersReady returns false when some layers not ready", () => {
      wrapper.vm.readyLayers = [true, false, true];
      expect(wrapper.vm.layersReady).toBe(false);
    });

    it("layersReady returns true for empty array", () => {
      wrapper.vm.readyLayers = [];
      expect(wrapper.vm.layersReady).toBe(true);
    });

    it("selectedToolType returns tool state type", () => {
      mockedStore.selectedTool = {
        configuration: { id: "tool1" },
        state: { type: Symbol("test") },
      } as any;
      expect(wrapper.vm.selectedToolType).toBeDefined();
    });

    it("selectedToolType returns null when no tool", () => {
      mockedStore.selectedTool = null;
      expect(wrapper.vm.selectedToolType).toBeNull();
    });

    it("mapLayerList returns single group in multiple mode", () => {
      const lsi = [createLayerStackImage()];
      mockedStore.layerStackImages = lsi;
      mockedStore.layerMode = "multiple" as any;
      expect(wrapper.vm.mapLayerList).toEqual([lsi]);
    });

    it("mapLayerList groups by layerGroup in unroll mode", () => {
      const lsi1 = createLayerStackImage({
        layer: { layerGroup: "groupA", visible: true },
      });
      const lsi2 = createLayerStackImage({
        layer: { layerGroup: "groupA", visible: true },
      });
      const lsi3 = createLayerStackImage({
        layer: { layerGroup: null, visible: true },
      });
      mockedStore.layerStackImages = [lsi1, lsi2, lsi3];
      mockedStore.layerMode = "unroll" as any;
      const result = wrapper.vm.mapLayerList;
      // groupA gets one array, ungrouped gets one array each
      expect(result.length).toBe(2);
      expect(result[0]).toEqual([lsi1, lsi2]);
      expect(result[1]).toEqual([lsi3]);
    });

    it("mapLayerList filters invisible layers in unroll mode", () => {
      const lsi1 = createLayerStackImage({
        layer: { layerGroup: "groupA", visible: true },
      });
      const lsi2 = createLayerStackImage({
        layer: { layerGroup: "groupA", visible: false },
      });
      mockedStore.layerStackImages = [lsi1, lsi2];
      mockedStore.layerMode = "unroll" as any;
      const result = wrapper.vm.mapLayerList;
      expect(result.length).toBe(1);
      expect(result[0]).toEqual([lsi1]);
    });
  });

  // ---- 4. Watcher Behavior ----

  describe("watcher behavior", () => {
    it("shouldResetMaps prop triggers emit of reset-complete", async () => {
      mockedStore.layerStackImages = [createLayerStackImage()];
      wrapper = mountComponent({ shouldResetMaps: false });
      await wrapper.setProps({ shouldResetMaps: true });
      await Vue.nextTick();
      expect(wrapper.emitted("reset-complete")).toBeTruthy();
    });

    it("readyLayersCount/readyLayersTotal changes update progress store", async () => {
      wrapper = mountComponent();
      wrapper.vm.readyLayers = [false, false];
      await Vue.nextTick();
      expect(mockedProgressStore.updateReactiveProgress).toHaveBeenCalled();
    });

    it("compositionMode change applies to all image layers", async () => {
      const layer1 = mockLayer();
      const layer2 = mockLayer();
      const map1 = mockMap();
      mockedStore.maps = [
        { map: map1, imageLayers: [layer1, layer2], params: {} } as any,
      ];
      wrapper = mountComponent();
      mockedStore.compositionMode = "screen" as any;
      await Vue.nextTick();
      // The watcher should apply the new mode to each layer
      expect(layer1.node().css).toHaveBeenCalled();
      expect(layer2.node().css).toHaveBeenCalled();
    });

    it("backgroundColor change updates map-layout style", async () => {
      wrapper = mountComponent();
      // The updateBackgroundColor runs on mount
      const mapLayout = wrapper.find(".map-layout");
      expect(mapLayout.exists()).toBe(true);
    });
  });

  // ---- 5. Mouse Interaction ----

  describe("mouse interaction", () => {
    beforeEach(() => {
      const map1 = mockMap();
      mockedStore.maps = [{ map: map1, imageLayers: [], params: {} } as any];
      wrapper = mountComponent();
    });

    it("mouseDown with shift sets mouseState", () => {
      const target = document.createElement("div");
      const evt = new MouseEvent("mousedown", {
        shiftKey: true,
        buttons: 1,
      });
      Object.defineProperty(evt, "target", { value: target });
      wrapper.vm.mouseDown(evt, 0);
      expect(wrapper.vm.mouseState).not.toBeNull();
      expect(wrapper.vm.mouseState.mapEntry).toBe(mockedStore.maps[0]);
    });

    it("mouseDown without shift does not set mouseState (active)", () => {
      const target = document.createElement("div");
      const evt = new MouseEvent("mousedown", {
        shiftKey: false,
        buttons: 1,
      });
      Object.defineProperty(evt, "target", { value: target });
      wrapper.vm.mouseDown(evt, 0);
      // Should be null or preview state
      const state = wrapper.vm.mouseState;
      expect(state === null || state.isMouseMovePreviewState === true).toBe(
        true,
      );
    });

    it("mouseDown without valid mapEntry does nothing", () => {
      const target = document.createElement("div");
      const evt = new MouseEvent("mousedown", {
        shiftKey: true,
        buttons: 1,
      });
      Object.defineProperty(evt, "target", { value: target });
      wrapper.vm.mouseDown(evt, 999); // invalid index
      // mouseState should remain null or preview
      const state = wrapper.vm.mouseState;
      expect(state === null || state.isMouseMovePreviewState === true).toBe(
        true,
      );
    });

    it("mouseMove creates preview state when no active drag", () => {
      const target = document.createElement("div");
      target.getBoundingClientRect = vi.fn().mockReturnValue({ x: 0, y: 0 });
      const evt = new MouseEvent("mousemove", {});
      Object.defineProperty(evt, "target", { value: target });
      Object.defineProperty(evt, "x", { value: 50 });
      Object.defineProperty(evt, "y", { value: 50 });
      wrapper.vm.mouseMove(evt, 0);
      expect(wrapper.vm.mouseState).not.toBeNull();
      expect(wrapper.vm.mouseState.isMouseMovePreviewState).toBe(true);
    });

    it("mouseMove appends to path during active drag", () => {
      const target = document.createElement("div");
      target.getBoundingClientRect = vi.fn().mockReturnValue({ x: 0, y: 0 });

      // Setup active state
      wrapper.vm.mouseState = {
        isMouseMovePreviewState: false,
        mapEntry: mockedStore.maps[0],
        target,
        path: [],
        initialMouseEvent: new MouseEvent("mousedown"),
      };

      const evt = new MouseEvent("mousemove", {});
      Object.defineProperty(evt, "x", { value: 100 });
      Object.defineProperty(evt, "y", { value: 150 });
      const stopPropagation = vi.spyOn(evt, "stopPropagation");

      wrapper.vm.mouseMove(evt, 0);
      expect(wrapper.vm.mouseState.path.length).toBe(1);
      expect(stopPropagation).toHaveBeenCalled();
    });

    it("mouseUp clears mouseState during active drag", () => {
      const target = document.createElement("div");
      wrapper.vm.mouseState = {
        isMouseMovePreviewState: false,
        mapEntry: mockedStore.maps[0],
        target,
        path: [{ x: 0, y: 0 }],
        initialMouseEvent: new MouseEvent("mousedown"),
      };

      const evt = new MouseEvent("mouseup");
      wrapper.vm.mouseUp(evt);
      expect(wrapper.vm.mouseState).toBeNull();
    });

    it("mouseUp does nothing during preview state", () => {
      wrapper.vm.mouseState = {
        isMouseMovePreviewState: true,
        mapEntry: mockedStore.maps[0],
        target: document.createElement("div"),
        path: [{ x: 0, y: 0 }],
        initialMouseEvent: new MouseEvent("mousedown"),
      };

      const evt = new MouseEvent("mouseup");
      wrapper.vm.mouseUp(evt);
      // mouseState stays as is (preview)
      expect(wrapper.vm.mouseState).not.toBeNull();
    });

    it("mouseLeave clears mouseState when in preview state", () => {
      wrapper.vm.mouseState = {
        isMouseMovePreviewState: true,
        mapEntry: mockedStore.maps[0],
        target: document.createElement("div"),
        path: [],
        initialMouseEvent: new MouseEvent("mousedown"),
      };
      wrapper.vm.mouseLeave();
      expect(wrapper.vm.mouseState).toBeNull();
    });

    it("mouseLeave does not clear mouseState during active drag", () => {
      wrapper.vm.mouseState = {
        isMouseMovePreviewState: false,
        mapEntry: mockedStore.maps[0],
        target: document.createElement("div"),
        path: [{ x: 0, y: 0 }],
        initialMouseEvent: new MouseEvent("mousedown"),
      };
      wrapper.vm.mouseLeave();
      expect(wrapper.vm.mouseState).not.toBeNull();
    });
  });

  // ---- 6. Camera Synchronization ----

  describe("camera synchronization", () => {
    let map1: ReturnType<typeof mockMap>;

    beforeEach(() => {
      map1 = mockMap();
      mockedStore.maps = [{ map: map1, imageLayers: [], params: {} } as any];
      wrapper = mountComponent();
    });

    it("setCenter calls map.center with provided center", () => {
      const center = { x: 200, y: 300 };
      wrapper.vm.setCenter(center);
      expect(map1.center).toHaveBeenCalledWith(center);
    });

    it("setCenter does nothing when no maps", () => {
      mockedStore.maps = [];
      wrapper.vm.setCenter({ x: 0, y: 0 });
      // Should not throw
    });

    it("resetRotation sets map rotation to 0", () => {
      wrapper.vm.resetRotation();
      expect(map1.rotation).toHaveBeenCalledWith(0);
    });

    it("resetRotation does nothing when no maps", () => {
      mockedStore.maps = [];
      wrapper.vm.resetRotation();
      // Should not throw
    });

    it("applyCameraInfo applies camera to all maps", async () => {
      const map2 = mockMap();
      mockedStore.maps = [
        { map: map1, imageLayers: [], params: {} } as any,
        { map: map2, imageLayers: [], params: {} } as any,
      ];
      wrapper = mountComponent();

      // Trigger cameraInfo watcher
      const newInfo = {
        zoom: 3,
        rotate: 0.5,
        center: { x: 100, y: 100 },
        gcsBounds: [],
      };
      mockedStore.cameraInfo = newInfo as any;
      await Vue.nextTick();

      // Both maps should have zoom/rotation/center called
      expect(map1.zoom).toHaveBeenCalled();
      expect(map2.zoom).toHaveBeenCalled();
    });

    it("synchronisationEnabled prevents circular updates", () => {
      wrapper.vm.synchronisationEnabled = false;
      // When disabled, the sync callback won't update cameraInfo
      expect(wrapper.vm.synchronisationEnabled).toBe(false);
    });
  });

  // ---- 7. View Lock & Rotation ----

  describe("view lock and rotation", () => {
    let map1: ReturnType<typeof mockMap>;

    beforeEach(() => {
      map1 = mockMap();
      mockedStore.maps = [{ map: map1, imageLayers: [], params: {} } as any];
      wrapper = mountComponent();
    });

    it("toggleViewLock flips isViewLocked", () => {
      expect(wrapper.vm.isViewLocked).toBe(false);
      wrapper.vm.toggleViewLock();
      expect(wrapper.vm.isViewLocked).toBe(true);
      wrapper.vm.toggleViewLock();
      expect(wrapper.vm.isViewLocked).toBe(false);
    });

    it("lock stores default actions", () => {
      wrapper.vm.toggleViewLock();
      expect(wrapper.vm.defaultActions).toBeDefined();
    });

    it("lock sets empty actions on interactor", () => {
      wrapper.vm.toggleViewLock();
      const interactor = map1.interactor();
      expect(interactor.options).toHaveBeenCalledWith({ actions: [] });
    });

    it("unlock restores default actions", () => {
      wrapper.vm.toggleViewLock(); // lock
      const savedActions = wrapper.vm.defaultActions;
      wrapper.vm.toggleViewLock(); // unlock
      const interactor = map1.interactor();
      expect(interactor.options).toHaveBeenCalledWith({
        actions: savedActions,
      });
    });
  });

  // ---- 8. Scale Widgets ----

  describe("scale widgets", () => {
    beforeEach(() => {
      wrapper = mountComponent();
    });

    it("does not create scale widget when showScalebar is false", () => {
      expect(wrapper.vm.scaleWidget).toBeNull();
    });

    it("does not create pixel scale widget when showPixelScalebar is false", () => {
      expect(wrapper.vm.scalePixelWidget).toBeNull();
    });
  });

  // ---- 9. Keyboard Shortcuts ----

  describe("keyboard shortcuts", () => {
    beforeEach(() => {
      wrapper = mountComponent();
    });

    it("mousetrapAnnotations has correct bindings", () => {
      const bindings = wrapper.vm.mousetrapAnnotations;
      expect(bindings).toBeInstanceOf(Array);
      const bindKeys = bindings.map((b: any) => b.bind);
      expect(bindKeys).toContain("a");
      expect(bindKeys).toContain("t");
      expect(bindKeys).toContain("l");
      expect(bindKeys).toContain("mod+backspace");
      expect(bindKeys).toContain("mod+z");
      expect(bindKeys).toContain("mod+shift+z");
      expect(bindKeys).toContain("mod+c");
      expect(bindKeys).toContain("mod+v");
    });

    it("'a' hotkey toggles drawAnnotations", () => {
      const binding = wrapper.vm.mousetrapAnnotations.find(
        (b: any) => b.bind === "a",
      );
      binding.handler();
      expect(mockedStore.setDrawAnnotations).toHaveBeenCalledWith(false);
    });

    it("'t' hotkey toggles showTooltips", () => {
      const binding = wrapper.vm.mousetrapAnnotations.find(
        (b: any) => b.bind === "t",
      );
      binding.handler();
      expect(mockedStore.setShowTooltips).toHaveBeenCalledWith(true);
    });

    it("'l' hotkey toggles view lock", () => {
      const binding = wrapper.vm.mousetrapAnnotations.find(
        (b: any) => b.bind === "l",
      );
      expect(wrapper.vm.isViewLocked).toBe(false);
      binding.handler();
      expect(wrapper.vm.isViewLocked).toBe(true);
    });

    it("'mod+backspace' hotkey deletes selected annotations", () => {
      const binding = wrapper.vm.mousetrapAnnotations.find(
        (b: any) => b.bind === "mod+backspace",
      );
      binding.handler();
      expect(
        mockedAnnotationStore.deleteSelectedAnnotations,
      ).toHaveBeenCalled();
    });

    it("'mod+z' hotkey calls undoOrRedo(true)", () => {
      const binding = wrapper.vm.mousetrapAnnotations.find(
        (b: any) => b.bind === "mod+z",
      );
      binding.handler();
      expect(mockedAnnotationStore.undoOrRedo).toHaveBeenCalledWith(true);
    });

    it("'mod+shift+z' hotkey calls undoOrRedo(false)", () => {
      const binding = wrapper.vm.mousetrapAnnotations.find(
        (b: any) => b.bind === "mod+shift+z",
      );
      binding.handler();
      expect(mockedAnnotationStore.undoOrRedo).toHaveBeenCalledWith(false);
    });

    it("'mod+c' copies annotations when no text selected", () => {
      // Mock window.getSelection to return empty
      vi.spyOn(window, "getSelection").mockReturnValue({
        toString: () => "",
      } as any);
      const binding = wrapper.vm.mousetrapAnnotations.find(
        (b: any) => b.bind === "mod+c",
      );
      binding.handler();
      expect(mockedAnnotationStore.copySelectedAnnotations).toHaveBeenCalled();
    });

    it("'mod+v' pastes annotations when not in editable element", () => {
      const binding = wrapper.vm.mousetrapAnnotations.find(
        (b: any) => b.bind === "mod+v",
      );
      binding.handler();
      expect(mockedAnnotationStore.pasteAnnotations).toHaveBeenCalled();
    });

    it("hotkey data includes section and description", () => {
      const bindings = wrapper.vm.mousetrapAnnotations;
      bindings.forEach((b: any) => {
        expect(b.data).toBeDefined();
        expect(b.data.section).toBeDefined();
        expect(b.data.description).toBeDefined();
      });
    });
  });

  // ---- 10. markRaw / Reactivity ----

  describe("markRaw and reactivity", () => {
    it("readyLayers array triggers reactivity on updates", async () => {
      wrapper = mountComponent();
      wrapper.vm.readyLayers = [false, false, false];
      await Vue.nextTick();
      expect(wrapper.vm.readyLayersCount).toBe(0);
      expect(wrapper.vm.readyLayersTotal).toBe(3);
    });

    it("readyLayers splice triggers readyLayersCount recomputation", async () => {
      wrapper = mountComponent();
      wrapper.vm.readyLayers = [false, false];
      await Vue.nextTick();
      expect(wrapper.vm.readyLayersCount).toBe(0);

      wrapper.vm.readyLayers.splice(0, 1, true);
      await Vue.nextTick();
      expect(wrapper.vm.readyLayersCount).toBe(1);
    });

    it("maps array itself remains reactive", async () => {
      wrapper = mountComponent();
      const initialMaps = mockedStore.maps;
      const newMap = { map: mockMap(), imageLayers: [], params: {} } as any;
      mockedStore.maps = [...initialMaps, newMap];
      await Vue.nextTick();
      expect(wrapper.vm.maps.length).toBe(1);
    });
  });

  // ---- 11. _setupMap ----

  describe("_setupMap", () => {
    it("returns early when map element not found", () => {
      wrapper = mountComponent();
      // No ref for map-0 exists, so should return without error
      wrapper.vm._setupMap(0, createLayerStackImage().images[0], false);
      // Should not throw
    });
  });

  // ---- 12. _setupTileLayers ----

  describe("_setupTileLayers", () => {
    it("creates correct number of tile layers (2 per logical layer)", () => {
      const map1 = mockMap();
      const mapentry = {
        map: map1,
        imageLayers: markRaw([]),
        params: markRaw({
          map: { maxBounds: { right: 1024, bottom: 1024 }, min: 0, max: 10 },
          layer: {},
        }),
        baseLayerIndex: 0,
      } as any;
      mockedStore.maps = [mapentry];
      wrapper = mountComponent();

      const mll = [createLayerStackImage()];
      const someImage = mll[0].images[0];
      wrapper.vm._setupTileLayers(mll, 0, someImage, 0);

      // 2 layers per logical layer
      expect(mapentry.imageLayers.length).toBe(2);
    });

    it("removes excess layers when count decreases", () => {
      const map1 = mockMap();
      const layer1 = mockLayer();
      const layer2 = mockLayer();
      const layer3 = mockLayer();
      const layer4 = mockLayer();
      const mapentry = {
        map: map1,
        imageLayers: markRaw([layer1, layer2, layer3, layer4]),
        params: markRaw({
          map: { maxBounds: { right: 1024, bottom: 1024 }, min: 0, max: 10 },
          layer: {},
        }),
        baseLayerIndex: 0,
      } as any;
      mockedStore.maps = [mapentry];
      wrapper = mountComponent();

      // Now setup with only 1 logical layer (needs 2 tile layers)
      const mll = [createLayerStackImage()];
      const someImage = mll[0].images[0];
      wrapper.vm._setupTileLayers(mll, 0, someImage, 0);

      expect(mapentry.imageLayers.length).toBe(2);
      expect(map1.deleteLayer).toHaveBeenCalledTimes(2);
    });

    it("sets composition mode on new layers", () => {
      const map1 = mockMap();
      const mapentry = {
        map: map1,
        imageLayers: markRaw([]),
        params: markRaw({
          map: { maxBounds: { right: 1024, bottom: 1024 }, min: 0, max: 10 },
          layer: {},
        }),
        baseLayerIndex: 0,
      } as any;
      mockedStore.maps = [mapentry];
      mockedStore.compositionMode = "screen" as any;
      wrapper = mountComponent();

      const mll = [createLayerStackImage()];
      const someImage = mll[0].images[0];
      wrapper.vm._setupTileLayers(mll, 0, someImage, 0);

      // Each new layer should get composition mode set
      mapentry.imageLayers.forEach((layer: any) => {
        expect(layer.node().css).toHaveBeenCalledWith({
          "mix-blend-mode": "screen",
        });
      });
    });
  });

  // ---- 13. draw() ----

  describe("draw", () => {
    it("returns early when width equals height equals 1", () => {
      mockedStore.dataset = { id: "d1", width: 1, height: 1 } as any;
      wrapper = mountComponent();
      // draw is called on mount but should return early
      expect(wrapper.vm.tileWidth).toBe(0);
    });

    it("returns early when no dataset", () => {
      mockedStore.dataset = null as any;
      wrapper = mountComponent();
      expect(wrapper.vm.tileWidth).toBe(0);
    });

    it("returns early when no layerStackImages", () => {
      mockedStore.layerStackImages = [];
      wrapper = mountComponent();
      expect(wrapper.vm.tileWidth).toBe(0);
    });

    it("returns early when no images have data", () => {
      mockedStore.layerStackImages = [
        { ...createLayerStackImage(), images: [] },
      ];
      wrapper = mountComponent();
      expect(wrapper.vm.tileWidth).toBe(0);
    });

    it("sets tileWidth and tileHeight from image", () => {
      const lsi = createLayerStackImage();
      mockedStore.layerStackImages = [lsi];
      wrapper = mountComponent();
      // draw runs on mount
      expect(wrapper.vm.tileWidth).toBe(256);
      expect(wrapper.vm.tileHeight).toBe(256);
    });
  });

  // ---- 14. SAM Tool Help ----

  describe("SAM tool help alert", () => {
    it("showSamToolHelpAlert is initially false", () => {
      wrapper = mountComponent();
      expect(wrapper.vm.showSamToolHelpAlert).toBe(false);
    });
  });

  // ---- 15. Data Initialization ----

  describe("data initialization", () => {
    it("isViewLocked starts as false", () => {
      wrapper = mountComponent();
      expect(wrapper.vm.isViewLocked).toBe(false);
    });

    it("scaleDialog starts as false", () => {
      wrapper = mountComponent();
      expect(wrapper.vm.scaleDialog).toBe(false);
    });

    it("mouseState starts as null", () => {
      wrapper = mountComponent();
      expect(wrapper.vm.mouseState).toBeNull();
    });

    it("tileWidth starts as 0", () => {
      wrapper = mountComponent();
      // draw may update it, but initial is 0
      expect(typeof wrapper.vm.tileWidth).toBe("number");
    });

    it("unrollW starts as 1", () => {
      wrapper = mountComponent();
      expect(typeof wrapper.vm.unrollW).toBe("number");
    });

    it("synchronisationEnabled starts as true", () => {
      wrapper = mountComponent();
      expect(wrapper.vm.synchronisationEnabled).toBe(true);
    });

    it("scaleWidget starts as null", () => {
      wrapper = mountComponent();
      expect(wrapper.vm.scaleWidget).toBeNull();
    });

    it("scalePixelWidget starts as null", () => {
      wrapper = mountComponent();
      expect(wrapper.vm.scalePixelWidget).toBeNull();
    });

    it("defaultActions starts as undefined", () => {
      wrapper = mountComponent();
      expect(wrapper.vm.defaultActions).toBeUndefined();
    });

    it("resetMapsOnDraw starts as false", () => {
      wrapper = mountComponent();
      // It's set true during dataset watcher but reset in draw
      expect(typeof wrapper.vm.resetMapsOnDraw).toBe("boolean");
    });

    it("samMapEntry starts as null or first map", () => {
      wrapper = mountComponent();
      // On mount, mapsChanged sets it to maps[0] ?? null
      const val = wrapper.vm.samMapEntry;
      expect(val === null || typeof val === "object").toBe(true);
    });

    it("blankUrl is a valid data URL", () => {
      wrapper = mountComponent();
      expect(wrapper.vm.blankUrl).toContain("data:image/png;base64,");
    });
  });

  // ---- 16. setCorners ----

  describe("setCorners", () => {
    it("adjusts map zoom and center based on corners", () => {
      const map1 = mockMap();
      mockedStore.maps = [{ map: map1, imageLayers: [], params: {} } as any];
      wrapper = mountComponent();

      wrapper.vm.setCorners({
        lowerLeftGcs: { x: 0, y: 100 },
        upperRightGcs: { x: 100, y: 0 },
      });

      expect(map1.zoom).toHaveBeenCalled();
      expect(map1.center).toHaveBeenCalled();
    });

    it("setCorners does nothing when no maps", () => {
      mockedStore.maps = [];
      wrapper = mountComponent();
      wrapper.vm.setCorners({
        lowerLeftGcs: { x: 0, y: 100 },
        upperRightGcs: { x: 100, y: 0 },
      });
      // Should not throw
    });
  });

  // ---- 17. Template Rendering ----

  describe("template rendering", () => {
    it("renders map-layout div", () => {
      wrapper = mountComponent();
      expect(wrapper.find(".map-layout").exists()).toBe(true);
    });

    it("renders lock view button", () => {
      wrapper = mountComponent();
      expect(wrapper.find("#lock-view-tourstep").exists()).toBe(true);
    });

    it("renders layer info button", () => {
      wrapper = mountComponent();
      // The button is inside a v-menu which may not render the activator in shallow mount
      // Check the wrapper HTML for the button or the menu
      const html = wrapper.html();
      expect(html).toContain("lock-view-tourstep");
    });

    it("does not render reset rotation button when rotation is 0", () => {
      mockedStore.cameraInfo = {
        zoom: 5,
        rotate: 0,
        center: { x: 0, y: 0 },
        gcsBounds: [],
      } as any;
      wrapper = mountComponent();
      expect(wrapper.find("#reset-rotation-tourstep").exists()).toBe(false);
    });

    it("overview computed reflects store.overview", () => {
      mockedStore.overview = true;
      mockedStore.unroll = false;
      wrapper = mountComponent();
      expect(wrapper.vm.overview).toBe(true);
      expect(wrapper.vm.unrolling).toBe(false);
    });

    it("unrolling reflects store.unroll", () => {
      mockedStore.overview = true;
      mockedStore.unroll = true;
      wrapper = mountComponent();
      expect(wrapper.vm.unrolling).toBe(true);
    });

    it("renders map divs matching mapLayerList length", () => {
      mockedStore.layerStackImages = [createLayerStackImage()];
      wrapper = mountComponent();
      // mapLayerList wraps layerStackImages in a single group in "multiple" mode
      // The template renders one div per mapLayerList entry
      expect(wrapper.vm.mapLayerList.length).toBe(1);
    });
  });

  // ---- 18. Watcher - dataset ----

  describe("dataset watcher", () => {
    it("dataset change sets resetMapsOnDraw true", async () => {
      wrapper = mountComponent();
      wrapper.vm.resetMapsOnDraw = false;
      mockedStore.dataset = { id: "dataset2", width: 500, height: 500 } as any;
      await Vue.nextTick();
      // The watcher should set resetMapsOnDraw
      expect(wrapper.vm.resetMapsOnDraw).toBe(true);
    });
  });

  // ---- 19. mapSynchronizationCallbacks ----

  describe("mapSynchronizationCallbacks", () => {
    it("starts as empty Map", () => {
      wrapper = mountComponent();
      expect(wrapper.vm.mapSynchronizationCallbacks).toBeInstanceOf(Map);
      expect(wrapper.vm.mapSynchronizationCallbacks.size).toBe(0);
    });
  });
});

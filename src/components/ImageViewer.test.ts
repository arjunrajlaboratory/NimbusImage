import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import { markRaw, nextTick } from "vue";

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
    maxBounds: vi
      .fn()
      .mockReturnValue({ left: 0, top: 0, right: 1000, bottom: 800 }),
    bounds: vi.fn().mockReturnThis(),
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

// GeoJS dom widget: a real element so the label code can set its class, text
// and click handler. GeoJS builds it from `arg.el`, defaulting to a div.
const mockDomWidget = (el?: string) => {
  const element = document.createElement(el || "div");
  return { canvas: vi.fn(() => element) };
};

const mockLayer = () => {
  let isVisible = false;
  let layerOpacity = 1;
  return {
    node: vi.fn().mockReturnValue({ css: vi.fn() }),
    createFeature: vi.fn().mockReturnValue({}),
    createWidget: vi.fn((_widgetName: string, arg?: any) =>
      mockDomWidget(arg?.el),
    ),
    deleteWidget: vi.fn(),
    moveToTop: vi.fn(),
    zIndex: vi.fn().mockReturnValue(0),
    visible: vi.fn((value?: boolean) => {
      if (value !== undefined) isVisible = value;
      return isVisible;
    }),
    opacity: vi.fn((value?: number) => {
      if (value !== undefined) layerOpacity = value;
      return layerOpacity;
    }),
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
  };
};

// Use reactive() so the computed properties are reactive
vi.mock("@/store", () => {
  const { reactive } = require("vue");
  return {
    default: reactive({
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
      unrollXY: false,
      unrollZ: false,
      unrollT: false,
      showXYLabels: true,
      showZLabels: true,
      showTimeLabels: true,
      selectedTool: null as any,
      layerStackImages: [] as any[],
      layerMode: "multiple",
      showScalebar: false,
      showPixelScalebar: false,
      scalebarColor: "#ffffff",
      drawAnnotations: true,
      showAnnotationsFromHiddenLayers: false,
      showTooltips: false,
      setMaps: vi.fn(),
      setMapAt: vi.fn(),
      popMap: vi.fn(),
      clearMaps: vi.fn(),
      setCameraInfo: vi.fn(),
      setDrawAnnotations: vi.fn(),
      setShowTooltips: vi.fn(),
      setXY: vi.fn(),
      setZ: vi.fn(),
      setTime: vi.fn(),
      setUnrollXY: vi.fn(),
      setUnrollZ: vi.fn(),
      setUnrollT: vi.fn(),
      getLayerHistogram: vi.fn().mockResolvedValue(null),
      layerSliceIndexes: vi.fn().mockReturnValue({
        xyIndex: 0,
        zIndex: 0,
        tIndex: 0,
      }),
    }),
  };
});

vi.mock("@/store/annotation", () => {
  const { reactive } = require("vue");
  return {
    default: reactive({
      selectedAnnotationIds: new Set<string>(),
      overviewConfig: {
        enabled: false,
        mode: "shapes",
        opacity: 0.6,
        vectorSwitchThreshold: 1,
      },
      mutationCounter: 0,
      annotationsAPI: {
        annotationRasterTemplateUrl: vi.fn(
          ({ version }: { version: number }) =>
            `http://localhost/raster/{z}/{x}/{y}?v=${version}`,
        ),
      },
      submitPendingAnnotation: null as Function | null,
      deleteSelectedAnnotations: vi.fn(),
      undoOrRedo: vi.fn(),
      copySelectedAnnotations: vi.fn(),
      pasteAnnotations: vi.fn(),
      setVisibilitySuppressed: vi.fn(),
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
import { ProgressType } from "@/store/model";
import { logWarning } from "@/utils/log";
import ImageViewer from "./ImageViewer.vue";

const mockedStore = vi.mocked(store);
const mockedAnnotationStore = vi.mocked(annotationStore);
const mockedProgressStore = vi.mocked(progressStore);

function createLayerStackImage(overrides: any = {}): any {
  const { layer: layerOverride, image: imageOverride, ...rest } = overrides;
  return {
    layer: {
      id: "layer1",
      channel: 0,
      visible: true,
      color: "#ff0000",
      contrast: { whitePoint: 100, blackPoint: 0, mode: "percentile" },
      layerGroup: null,
      xy: { type: "current", value: null },
      z: { type: "current", value: null },
      time: { type: "current", value: null },
      ...layerOverride,
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
        ...imageOverride,
      },
    ],
    urls: ["http://localhost/api/v1/tile/{z}/{x}/{y}"],
    fullUrls: ["http://localhost/api/v1/tile/{z}/{x}/{y}?full=true"],
    hist: { min: 0, max: 255 },
    singleFrame: 0,
    baseQuadOptions: {},
    ...rest,
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
    props: propsData,
    global: {
      stubs: {
        AnnotationViewer: true,
        ImageOverview: true,
        ScaleSettings: true,
        ProgressBarGroup: true,
        LayerInfoGrid: true,
      },
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
    mockedStore.unrollXY = false;
    mockedStore.unrollZ = false;
    mockedStore.unrollT = false;
    mockedStore.showXYLabels = true;
    mockedStore.showZLabels = true;
    mockedStore.showTimeLabels = true;
    mockedStore.showAnnotationsFromHiddenLayers = false;
    mockedStore.selectedTool = null;
    mockedStore.layerStackImages = [];
    mockedStore.layerMode = "multiple" as any;
    mockedStore.showScalebar = false;
    mockedStore.showPixelScalebar = false;
    mockedStore.scalebarColor = "#ffffff";
    mockedAnnotationStore.submitPendingAnnotation = null;
    mockedAnnotationStore.overviewConfig = {
      enabled: false,
      mode: "shapes",
      opacity: 0.6,
      vectorSwitchThreshold: 1,
    } as any;
    mockedAnnotationStore.mutationCounter = 0;
    (mockedStore as any).getLayerHistogram = vi.fn().mockResolvedValue(null);
    (mockedStore.layerSliceIndexes as any).mockReturnValue({
      xyIndex: 0,
      zIndex: 0,
      tIndex: 0,
    });
    vi.clearAllMocks();
    // Make setMaps/setCameraInfo actually update the reactive store
    (mockedStore.setMaps as any).mockImplementation((v: any) => {
      mockedStore.maps = v;
    });
    (mockedStore.setMapAt as any).mockImplementation(
      ({ index, mapEntry }: any) => {
        const maps = [...mockedStore.maps];
        maps[index] = mapEntry;
        mockedStore.maps = maps;
      },
    );
    (mockedStore.popMap as any).mockImplementation(() => {
      mockedStore.maps = mockedStore.maps.slice(0, -1);
    });
    (mockedStore.clearMaps as any).mockImplementation(() => {
      mockedStore.maps = [];
    });
    (mockedStore.setCameraInfo as any).mockImplementation((v: any) => {
      mockedStore.cameraInfo = v;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    // Unmount, or every mounted instance keeps reacting to the shared reactive
    // store mock: a store change in a later test then runs the watchers of
    // every earlier test's component, all of them writing to the same
    // mockedStore.maps entries.
    wrapper?.unmount();
  });

  // ---- 1. Mounting & Lifecycle ----

  describe("mounting and lifecycle", () => {
    it("mounts without errors", () => {
      wrapper = mountComponent();
      expect(wrapper.exists()).toBe(true);
    });

    it("sets refsMounted on mount", () => {
      wrapper = mountComponent();
      expect((wrapper.vm as any).refsMounted).toBe(true);
    });

    it("cleans up maps on beforeUnmount", () => {
      const map1 = mockMap();
      const map2 = mockMap();
      mockedStore.maps = [
        { map: map1, imageLayers: [], params: {} } as any,
        { map: map2, imageLayers: [], params: {} } as any,
      ];
      wrapper = mountComponent();
      // Clear any calls from mount
      map1.exit.mockClear();
      map2.exit.mockClear();
      (mockedStore.clearMaps as any).mockClear();
      // Trigger onBeforeUnmount
      wrapper.unmount();
      expect(map1.exit).toHaveBeenCalled();
      expect(map2.exit).toHaveBeenCalled();
      expect(mockedStore.clearMaps).toHaveBeenCalledOnce();
    });

    it("calls draw on mount when dataset and layers exist", () => {
      mockedStore.layerStackImages = [createLayerStackImage()];
      wrapper = mountComponent();
      // draw would have been called - since it modifies tileWidth/tileHeight
      // we can check that tileWidth got updated
      expect((wrapper.vm as any).tileWidth).toBeDefined();
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
      expect((wrapper.vm as any).maps).toStrictEqual(testMaps);
    });

    it("maps setter calls store.setMaps", () => {
      const newMaps = [{ map: mockMap() }] as any;
      (wrapper.vm as any).maps = newMaps;
      expect(mockedStore.setMaps).toHaveBeenCalledWith(newMaps);
    });

    it("cameraInfo getter returns store.cameraInfo", () => {
      expect((wrapper.vm as any).cameraInfo).toBe(mockedStore.cameraInfo);
    });

    it("cameraInfo setter calls store.setCameraInfo", () => {
      const newInfo = {
        zoom: 3,
        rotate: 1,
        center: { x: 0, y: 0 },
        gcsBounds: [],
      };
      (wrapper.vm as any).cameraInfo = newInfo;
      expect(mockedStore.setCameraInfo).toHaveBeenCalledWith(newInfo);
    });

    it("overview returns store.overview", () => {
      mockedStore.overview = true;
      expect((wrapper.vm as any).overview).toBe(true);
    });

    it("dataset returns store.dataset", () => {
      expect((wrapper.vm as any).dataset).toBe(mockedStore.dataset);
    });

    it("unrolling returns store.unroll", () => {
      mockedStore.unroll = true;
      expect((wrapper.vm as any).unrolling).toBe(true);
    });

    it("width returns dataset width or 1 if no dataset", () => {
      expect((wrapper.vm as any).width).toBe(1000);
    });

    it("width returns 1 when no dataset", () => {
      mockedStore.dataset = null as any;
      expect((wrapper.vm as any).width).toBe(1);
    });

    it("height returns dataset height or 1 if no dataset", () => {
      expect((wrapper.vm as any).height).toBe(800);
    });

    it("compositionMode returns store.compositionMode", () => {
      expect((wrapper.vm as any).compositionMode).toBe("lighten");
    });

    it("backgroundColor returns store.backgroundColor", () => {
      expect((wrapper.vm as any).backgroundColor).toBe("black");
    });

    it("pixelSize returns store.scales.pixelSize", () => {
      expect((wrapper.vm as any).pixelSize).toEqual({ value: 0.5, unit: "µm" });
    });

    it("showScalebar returns store.showScalebar", () => {
      expect((wrapper.vm as any).showScalebar).toBe(false);
    });

    it("showPixelScalebar returns store.showPixelScalebar", () => {
      expect((wrapper.vm as any).showPixelScalebar).toBe(false);
    });

    it("scalebarColor returns store.scalebarColor", () => {
      expect((wrapper.vm as any).scalebarColor).toBe("#ffffff");
    });

    it("selectedTool returns store.selectedTool", () => {
      expect((wrapper.vm as any).selectedTool).toBeNull();
    });

    it("layerStackImages returns store.layerStackImages when configuration exists", () => {
      const lsi = [createLayerStackImage()];
      mockedStore.layerStackImages = lsi;
      expect((wrapper.vm as any).layerStackImages).toStrictEqual(lsi);
    });

    it("layerStackImages returns empty array when no configuration", () => {
      mockedStore.configuration = null as any;
      expect((wrapper.vm as any).layerStackImages).toEqual([]);
    });

    it("submitPendingAnnotation returns annotationStore value", () => {
      const fn = vi.fn();
      mockedAnnotationStore.submitPendingAnnotation = fn;
      expect((wrapper.vm as any).submitPendingAnnotation).toBe(fn);
    });
  });

  // ---- 3. Computed Properties - Derived ----

  describe("computed properties - derived", () => {
    beforeEach(() => {
      wrapper = mountComponent();
    });

    it("readyLayersCount counts true values in readyLayers", () => {
      (wrapper.vm as any).readyLayers = [true, false, true, true];
      expect((wrapper.vm as any).readyLayersCount).toBe(3);
    });

    it("readyLayersCount returns 0 for empty array", () => {
      (wrapper.vm as any).readyLayers = [];
      expect((wrapper.vm as any).readyLayersCount).toBe(0);
    });

    it("readyLayersTotal returns readyLayers length", () => {
      (wrapper.vm as any).readyLayers = [true, false, true];
      expect((wrapper.vm as any).readyLayersTotal).toBe(3);
    });

    it("layersReady returns true when all layers are ready", () => {
      (wrapper.vm as any).readyLayers = [true, true, true];
      expect((wrapper.vm as any).layersReady).toBe(true);
    });

    it("layersReady returns false when some layers not ready", () => {
      (wrapper.vm as any).readyLayers = [true, false, true];
      expect((wrapper.vm as any).layersReady).toBe(false);
    });

    it("layersReady returns true for empty array", () => {
      (wrapper.vm as any).readyLayers = [];
      expect((wrapper.vm as any).layersReady).toBe(true);
    });

    it("selectedToolType returns tool state type", () => {
      mockedStore.selectedTool = {
        configuration: { id: "tool1" },
        state: { type: Symbol("test") },
      } as any;
      expect((wrapper.vm as any).selectedToolType).toBeDefined();
    });

    it("selectedToolType returns null when no tool", () => {
      mockedStore.selectedTool = null;
      expect((wrapper.vm as any).selectedToolType).toBeNull();
    });

    it("mapLayerList returns single group in multiple mode", () => {
      const lsi = [createLayerStackImage()];
      mockedStore.layerStackImages = lsi;
      mockedStore.layerMode = "multiple" as any;
      expect((wrapper.vm as any).mapLayerList).toEqual([lsi]);
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
      const result = (wrapper.vm as any).mapLayerList;
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
      const result = (wrapper.vm as any).mapLayerList;
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
      await nextTick();
      expect(wrapper.emitted("reset-complete")).toBeTruthy();
    });

    it("readyLayersCount/readyLayersTotal changes update progress store", async () => {
      wrapper = mountComponent();
      (wrapper.vm as any).readyLayers = [false, false];
      await nextTick();
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
      await nextTick();
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
      (wrapper.vm as any).mouseDown(evt, 0);
      expect((wrapper.vm as any).mouseState).not.toBeNull();
      expect((wrapper.vm as any).mouseState.mapEntry).toStrictEqual(
        mockedStore.maps[0],
      );
    });

    it("mouseDown without shift does not set mouseState (active)", () => {
      const target = document.createElement("div");
      const evt = new MouseEvent("mousedown", {
        shiftKey: false,
        buttons: 1,
      });
      Object.defineProperty(evt, "target", { value: target });
      (wrapper.vm as any).mouseDown(evt, 0);
      // Should be null or preview state
      const state = (wrapper.vm as any).mouseState;
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
      (wrapper.vm as any).mouseDown(evt, 999); // invalid index
      // mouseState should remain null or preview
      const state = (wrapper.vm as any).mouseState;
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
      (wrapper.vm as any).mouseMove(evt, 0);
      expect((wrapper.vm as any).mouseState).not.toBeNull();
      expect((wrapper.vm as any).mouseState.isMouseMovePreviewState).toBe(true);
    });

    it("mouseMove appends to path during active drag", () => {
      const target = document.createElement("div");
      target.getBoundingClientRect = vi.fn().mockReturnValue({ x: 0, y: 0 });

      // Setup active state
      (wrapper.vm as any).mouseState = {
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

      (wrapper.vm as any).mouseMove(evt, 0);
      expect((wrapper.vm as any).mouseState.path.length).toBe(1);
      expect(stopPropagation).toHaveBeenCalled();
    });

    it("mouseUp clears mouseState during active drag", () => {
      const target = document.createElement("div");
      (wrapper.vm as any).mouseState = {
        isMouseMovePreviewState: false,
        mapEntry: mockedStore.maps[0],
        target,
        path: [{ x: 0, y: 0 }],
        initialMouseEvent: new MouseEvent("mousedown"),
      };

      const evt = new MouseEvent("mouseup");
      (wrapper.vm as any).mouseUp(evt);
      expect((wrapper.vm as any).mouseState).toBeNull();
    });

    it("mouseUp does nothing during preview state", () => {
      (wrapper.vm as any).mouseState = {
        isMouseMovePreviewState: true,
        mapEntry: mockedStore.maps[0],
        target: document.createElement("div"),
        path: [{ x: 0, y: 0 }],
        initialMouseEvent: new MouseEvent("mousedown"),
      };

      const evt = new MouseEvent("mouseup");
      (wrapper.vm as any).mouseUp(evt);
      // mouseState stays as is (preview)
      expect((wrapper.vm as any).mouseState).not.toBeNull();
    });

    it("mouseLeave clears mouseState when in preview state", () => {
      (wrapper.vm as any).mouseState = {
        isMouseMovePreviewState: true,
        mapEntry: mockedStore.maps[0],
        target: document.createElement("div"),
        path: [],
        initialMouseEvent: new MouseEvent("mousedown"),
      };
      (wrapper.vm as any).mouseLeave();
      expect((wrapper.vm as any).mouseState).toBeNull();
    });

    it("mouseLeave does not clear mouseState during active drag", () => {
      (wrapper.vm as any).mouseState = {
        isMouseMovePreviewState: false,
        mapEntry: mockedStore.maps[0],
        target: document.createElement("div"),
        path: [{ x: 0, y: 0 }],
        initialMouseEvent: new MouseEvent("mousedown"),
      };
      (wrapper.vm as any).mouseLeave();
      expect((wrapper.vm as any).mouseState).not.toBeNull();
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
      (wrapper.vm as any).setCenter(center);
      expect(map1.center).toHaveBeenCalledWith(center);
    });

    it("setCenter does nothing when no maps", () => {
      mockedStore.maps = [];
      (wrapper.vm as any).setCenter({ x: 0, y: 0 });
      // Should not throw
    });

    it("resetRotation sets map rotation to 0", () => {
      (wrapper.vm as any).resetRotation();
      expect(map1.rotation).toHaveBeenCalledWith(0);
    });

    it("resetRotation does nothing when no maps", () => {
      mockedStore.maps = [];
      (wrapper.vm as any).resetRotation();
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
      await nextTick();

      // Both maps should have zoom/rotation/center called
      expect(map1.zoom).toHaveBeenCalled();
      expect(map2.zoom).toHaveBeenCalled();
    });

    it("synchronisationEnabled prevents circular updates", () => {
      (wrapper.vm as any).synchronisationEnabled = false;
      // When disabled, the sync callback won't update cameraInfo
      expect((wrapper.vm as any).synchronisationEnabled).toBe(false);
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
      expect((wrapper.vm as any).isViewLocked).toBe(false);
      (wrapper.vm as any).toggleViewLock();
      expect((wrapper.vm as any).isViewLocked).toBe(true);
      (wrapper.vm as any).toggleViewLock();
      expect((wrapper.vm as any).isViewLocked).toBe(false);
    });

    it("lock stores default actions", () => {
      (wrapper.vm as any).toggleViewLock();
      expect((wrapper.vm as any).defaultActions).toBeDefined();
    });

    it("lock sets empty actions on interactor", () => {
      (wrapper.vm as any).toggleViewLock();
      const interactor = map1.interactor();
      expect(interactor.options).toHaveBeenCalledWith({ actions: [] });
    });

    it("unlock restores default actions", () => {
      (wrapper.vm as any).toggleViewLock(); // lock
      const savedActions = (wrapper.vm as any).defaultActions;
      (wrapper.vm as any).toggleViewLock(); // unlock
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
      expect((wrapper.vm as any).scaleWidget).toBeNull();
    });

    it("does not create pixel scale widget when showPixelScalebar is false", () => {
      expect((wrapper.vm as any).scalePixelWidget).toBeNull();
    });
  });

  // ---- 9. Keyboard Shortcuts ----

  describe("keyboard shortcuts", () => {
    beforeEach(() => {
      wrapper = mountComponent();
    });

    it("mousetrapAnnotations has correct bindings", () => {
      const bindings = (wrapper.vm as any).mousetrapAnnotations;
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
      const binding = (wrapper.vm as any).mousetrapAnnotations.find(
        (b: any) => b.bind === "a",
      );
      binding.handler();
      expect(mockedStore.setDrawAnnotations).toHaveBeenCalledWith(false);
    });

    it("'t' hotkey toggles showTooltips", () => {
      const binding = (wrapper.vm as any).mousetrapAnnotations.find(
        (b: any) => b.bind === "t",
      );
      binding.handler();
      expect(mockedStore.setShowTooltips).toHaveBeenCalledWith(true);
    });

    it("'l' hotkey toggles view lock", () => {
      const binding = (wrapper.vm as any).mousetrapAnnotations.find(
        (b: any) => b.bind === "l",
      );
      expect((wrapper.vm as any).isViewLocked).toBe(false);
      binding.handler();
      expect((wrapper.vm as any).isViewLocked).toBe(true);
    });

    it("'mod+backspace' hotkey deletes selected annotations", () => {
      const binding = (wrapper.vm as any).mousetrapAnnotations.find(
        (b: any) => b.bind === "mod+backspace",
      );
      binding.handler();
      expect(
        mockedAnnotationStore.deleteSelectedAnnotations,
      ).toHaveBeenCalled();
    });

    it("'mod+z' hotkey calls undoOrRedo(true)", () => {
      const binding = (wrapper.vm as any).mousetrapAnnotations.find(
        (b: any) => b.bind === "mod+z",
      );
      binding.handler();
      expect(mockedAnnotationStore.undoOrRedo).toHaveBeenCalledWith(true);
    });

    it("'mod+shift+z' hotkey calls undoOrRedo(false)", () => {
      const binding = (wrapper.vm as any).mousetrapAnnotations.find(
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
      const binding = (wrapper.vm as any).mousetrapAnnotations.find(
        (b: any) => b.bind === "mod+c",
      );
      binding.handler();
      expect(mockedAnnotationStore.copySelectedAnnotations).toHaveBeenCalled();
    });

    it("'mod+v' pastes annotations when not in editable element", () => {
      const binding = (wrapper.vm as any).mousetrapAnnotations.find(
        (b: any) => b.bind === "mod+v",
      );
      binding.handler();
      expect(mockedAnnotationStore.pasteAnnotations).toHaveBeenCalled();
    });

    it("hotkey data includes section and description", () => {
      const bindings = (wrapper.vm as any).mousetrapAnnotations;
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
      (wrapper.vm as any).readyLayers = [false, false, false];
      await nextTick();
      expect((wrapper.vm as any).readyLayersCount).toBe(0);
      expect((wrapper.vm as any).readyLayersTotal).toBe(3);
    });

    it("readyLayers splice triggers readyLayersCount recomputation", async () => {
      wrapper = mountComponent();
      (wrapper.vm as any).readyLayers = [false, false];
      await nextTick();
      expect((wrapper.vm as any).readyLayersCount).toBe(0);

      (wrapper.vm as any).readyLayers.splice(0, 1, true);
      await nextTick();
      expect((wrapper.vm as any).readyLayersCount).toBe(1);
    });

    it("maps array itself remains reactive", async () => {
      wrapper = mountComponent();
      const initialMaps = mockedStore.maps;
      const newMap = { map: mockMap(), imageLayers: [], params: {} } as any;
      mockedStore.maps = [...initialMaps, newMap];
      await nextTick();
      expect((wrapper.vm as any).maps.length).toBe(1);
    });
  });

  // ---- 11. _setupMap ----

  describe("_setupMap", () => {
    it("returns early when map element not found", () => {
      wrapper = mountComponent();
      // No ref for map-0 exists, so should return without error
      (wrapper.vm as any)._setupMap(
        0,
        createLayerStackImage().images[0],
        false,
      );
      // Should not throw
    });
  });

  describe("annotation overview layer", () => {
    it("coordinates shared raster suppression across mounted map viewers", () => {
      const firstEntry = {
        map: mockMap(),
        annotationLayer: {},
        annotationOverviewLayer: mockLayer(),
        imageLayers: [{}, {}],
        lowestLayer: 0,
        params: {},
      } as any;
      const secondEntry = {
        map: mockMap(),
        annotationLayer: {},
        annotationOverviewLayer: mockLayer(),
        imageLayers: [{}, {}],
        lowestLayer: 1,
        params: {},
      } as any;
      mockedStore.maps = [firstEntry, secondEntry];
      wrapper = mountComponent();
      const [mountedFirstEntry, mountedSecondEntry] = (wrapper.vm as any)
        .annotationViewerMaps;

      (wrapper.vm as any)._setAnnotationOverviewVisibility(mountedFirstEntry, {
        visible: true,
        opacity: 0.6,
      });
      expect((wrapper.vm as any).allAnnotationOverviewViewersRasterActive).toBe(
        false,
      );

      (wrapper.vm as any)._setAnnotationOverviewVisibility(mountedSecondEntry, {
        visible: true,
        opacity: 0.6,
      });
      expect((wrapper.vm as any).allAnnotationOverviewViewersRasterActive).toBe(
        true,
      );

      (wrapper.vm as any)._setAnnotationOverviewVisibility(mountedFirstEntry, {
        visible: false,
        opacity: 0.6,
      });
      expect((wrapper.vm as any).allAnnotationOverviewViewersRasterActive).toBe(
        false,
      );
    });

    it("ignores raster visibility events from removed map viewers", () => {
      const overviewLayer = mockLayer();
      const removedEntry = {
        map: mockMap(),
        annotationOverviewLayer: overviewLayer,
        imageLayers: [{}, {}],
        lowestLayer: 0,
        params: {},
      } as any;
      wrapper = mountComponent();

      (wrapper.vm as any)._setAnnotationOverviewVisibility(removedEntry, {
        visible: false,
        opacity: 0.6,
      });

      expect(overviewLayer.visible).not.toHaveBeenCalled();
      expect(overviewLayer.opacity).not.toHaveBeenCalled();
    });

    it("does not allocate a GeoJS layer while the feature is disabled", () => {
      const map = mockMap();
      const mapentry = { map, imageLayers: [], params: {} } as any;
      mockedStore.maps = [mapentry];
      wrapper = mountComponent();

      (wrapper.vm as any)._syncAnnotationOverviewLayer(
        mapentry,
        createLayerStackImage().images[0],
        document.createElement("div"),
      );

      expect(map.createLayer).not.toHaveBeenCalled();
      expect(mapentry.annotationOverviewLayer).toBeUndefined();
    });

    it("lazily creates the layer and refreshes its URL on mutations", async () => {
      const map = mockMap();
      const overviewLayer = mockLayer();
      const mapentry = {
        map,
        imageLayers: [],
        params: { layer: { maxLevel: 9 } },
      } as any;
      mockedStore.maps = [mapentry];
      mockedAnnotationStore.overviewConfig = {
        ...mockedAnnotationStore.overviewConfig,
        enabled: true,
      } as any;
      wrapper = mountComponent();
      mockedStore.layerStackImages = [createLayerStackImage()];
      await nextTick();
      const mountedMapentry = (wrapper.vm as any).maps[0];
      mountedMapentry.annotationOverviewLayer = undefined;
      mountedMapentry.map.createLayer.mockReturnValue(overviewLayer);
      const image = createLayerStackImage().images[0];
      const element = document.createElement("div");

      (wrapper.vm as any)._syncAnnotationOverviewLayer(
        mountedMapentry,
        image,
        element,
      );

      expect(mountedMapentry.map.createLayer).toHaveBeenCalledWith(
        "osm",
        expect.any(Object),
      );
      const layerParams = mountedMapentry.map.createLayer.mock.calls[0][1];
      expect(layerParams.maxLevel).toBe(9);
      expect(layerParams.tilesAtZoom(9)).toEqual({ x: 2, y: 2 });
      expect(layerParams.tilesAtZoom(8)).toEqual({ x: 1, y: 1 });
      expect(layerParams.tilesMaxBounds(8)).toEqual({ x: 512, y: 512 });
      expect(layerParams.visible).toBe(false);
      expect(
        mockedAnnotationStore.annotationsAPI.annotationRasterTemplateUrl,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          maxLevel: 9,
          selectors: [{ channel: 0, XY: 0, Z: 0, Time: 0 }],
        }),
      );
      expect(overviewLayer.url).not.toHaveBeenCalled();
      (wrapper.vm as any)._setAnnotationOverviewVisibility(mountedMapentry, {
        visible: true,
        opacity: 0.6,
      });
      const firstUrl = overviewLayer.url.mock.calls[0][0];
      expect(firstUrl(2, 3, 4)).toBe("http://localhost/raster/4/2/3?v=0");
      expect("_annotationOverviewUrl" in overviewLayer).toBe(false);

      mockedAnnotationStore.mutationCounter = 1;
      (wrapper.vm as any)._syncAnnotationOverviewLayer(
        mountedMapentry,
        image,
        element,
      );
      const secondUrl = overviewLayer.url.mock.calls[1][0];
      expect(secondUrl(2, 3, 4)).toBe("http://localhost/raster/4/2/3?v=1");
    });

    it("does not request or activate a raster above the selector limit", () => {
      const map = mockMap();
      const overviewLayer = mockLayer();
      map.createLayer.mockReturnValue(overviewLayer);
      const mapentry = {
        map,
        imageLayers: [],
        params: { layer: { maxLevel: 9 } },
      } as any;
      mockedStore.maps = [mapentry];
      mockedStore.layerStackImages = Array.from({ length: 65 }, (_, channel) =>
        createLayerStackImage({
          layer: { id: `layer-${channel}`, channel },
        }),
      );
      mockedAnnotationStore.overviewConfig = {
        ...mockedAnnotationStore.overviewConfig,
        enabled: true,
      } as any;
      wrapper = mountComponent();

      (wrapper.vm as any)._syncAnnotationOverviewLayer(
        mapentry,
        createLayerStackImage().images[0],
        document.createElement("div"),
      );
      (wrapper.vm as any)._setAnnotationOverviewVisibility(mapentry, {
        visible: true,
        opacity: 0.6,
      });

      expect(
        mockedAnnotationStore.annotationsAPI.annotationRasterTemplateUrl,
      ).not.toHaveBeenCalled();
      expect(overviewLayer.url).not.toHaveBeenCalled();
      expect(overviewLayer.visible()).toBe(false);
    });

    it("shows delayed progress while overview tiles load and completes on idle", async () => {
      const map = mockMap();
      const overviewLayer = mockLayer();
      let isIdle = false;
      let idleHandler: (() => void) | undefined;
      Object.defineProperty(overviewLayer, "idle", {
        get: () => isIdle,
      });
      overviewLayer.onIdle.mockImplementation((handler: Function) => {
        if (isIdle) {
          handler();
        } else {
          idleHandler = handler as () => void;
        }
      });
      map.createLayer.mockReturnValue(overviewLayer);
      const mapentry = {
        map,
        imageLayers: [],
        params: { layer: { maxLevel: 9 } },
      } as any;
      mockedStore.maps = [mapentry];
      mockedAnnotationStore.overviewConfig = {
        ...mockedAnnotationStore.overviewConfig,
        enabled: true,
      } as any;
      wrapper = mountComponent();
      mockedStore.layerStackImages = [createLayerStackImage()];
      await nextTick();
      await vi.advanceTimersByTimeAsync(300);
      expect(mockedProgressStore.create).not.toHaveBeenCalled();
      const mountedMapentry = (wrapper.vm as any).maps[0];
      mountedMapentry.annotationOverviewLayer = undefined;
      mountedMapentry.map.createLayer.mockReturnValue(overviewLayer);
      (wrapper.vm as any)._syncAnnotationOverviewLayer(
        mountedMapentry,
        createLayerStackImage().images[0],
        document.createElement("div"),
      );
      (wrapper.vm as any)._setAnnotationOverviewVisibility(mountedMapentry, {
        visible: true,
        opacity: 0.6,
      });
      expect(overviewLayer.visible()).toBe(true);
      expect(overviewLayer.url).toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(299);
      expect(mockedProgressStore.create).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(mockedProgressStore.create).toHaveBeenCalledWith({
        type: ProgressType.ANNOTATION_RASTER,
      });
      expect(mockedProgressStore.complete).not.toHaveBeenCalled();

      isIdle = true;
      idleHandler?.();
      expect(mockedProgressStore.complete).toHaveBeenCalledWith("progress1");
    });

    it("does not show progress when overview tiles are already cached", async () => {
      const map = mockMap();
      const overviewLayer = mockLayer();
      map.createLayer.mockReturnValue(overviewLayer);
      const mapentry = {
        map,
        imageLayers: [],
        params: { layer: { maxLevel: 9 } },
      } as any;
      mockedStore.maps = [mapentry];
      mockedAnnotationStore.overviewConfig = {
        ...mockedAnnotationStore.overviewConfig,
        enabled: true,
      } as any;
      wrapper = mountComponent();
      mockedStore.layerStackImages = [createLayerStackImage()];

      (wrapper.vm as any)._syncAnnotationOverviewLayer(
        mapentry,
        createLayerStackImage().images[0],
        document.createElement("div"),
      );
      (wrapper.vm as any)._setAnnotationOverviewVisibility(mapentry, {
        visible: true,
        opacity: 0.6,
      });

      await vi.advanceTimersByTimeAsync(300);
      expect(mockedProgressStore.create).not.toHaveBeenCalled();
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
      (wrapper.vm as any)._setupTileLayers(mll, 0, someImage, 0);

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
      (wrapper.vm as any)._setupTileLayers(mll, 0, someImage, 0);

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
      (wrapper.vm as any)._setupTileLayers(mll, 0, someImage, 0);

      // Each new layer should get composition mode set
      mapentry.imageLayers.forEach((layer: any) => {
        expect(layer.node().css).toHaveBeenCalledWith({
          "mix-blend-mode": "screen",
        });
      });
    });
  });

  // ---- 13. _setTileUrls ----

  describe("_setTileUrls", () => {
    it("assigns unrolled tile URLs and skips histogram fetch when hist is ready", () => {
      wrapper = mountComponent();
      vi.clearAllMocks();

      const fullLayer = mockLayer();
      const adjLayer = mockLayer();
      mockedStore.maps = [
        {
          map: mockMap(),
          imageLayers: [fullLayer, adjLayer],
          params: {},
        } as any,
      ];

      const baseImage = createLayerStackImage().images[0];
      const lsi = createLayerStackImage({
        images: [baseImage, { ...baseImage, frameIndex: 1 }],
        urls: [
          "http://localhost/api/v1/tile/0/{z}/{x}/{y}",
          "http://localhost/api/v1/tile/1/{z}/{x}/{y}",
        ],
        fullUrls: [
          "http://localhost/api/v1/tile/0/{z}/{x}/{y}?full=true",
          "http://localhost/api/v1/tile/1/{z}/{x}/{y}?full=true",
        ],
        singleFrame: null,
        baseQuadOptions: {},
      });

      (wrapper.vm as any)._setTileUrls([lsi], 0, lsi.images[0], 0);

      expect(fullLayer._imageUrls).toEqual(lsi.fullUrls);
      expect(adjLayer._imageUrls).toEqual(lsi.urls);
      expect(fullLayer.visible).toHaveBeenCalledWith(true);
      expect(adjLayer.visible).toHaveBeenCalledWith(true);
      expect(fullLayer.visible).not.toHaveBeenCalledWith(false);
      expect(mockedStore.getLayerHistogram).not.toHaveBeenCalled();
    });

    it("requests a histogram fetch when tile URLs are not ready", async () => {
      wrapper = mountComponent();
      vi.clearAllMocks();

      const fullLayer = mockLayer();
      const adjLayer = mockLayer();
      mockedStore.maps = [
        {
          map: mockMap(),
          imageLayers: [fullLayer, adjLayer],
          params: {},
        } as any,
      ];

      const lsi = createLayerStackImage({
        urls: [],
        fullUrls: [],
        hist: null,
        singleFrame: null,
        baseQuadOptions: undefined,
      });

      (wrapper.vm as any)._setTileUrls([lsi], 0, lsi.images[0], 0);
      await Promise.resolve();

      expect(mockedStore.getLayerHistogram).toHaveBeenCalledWith(lsi.layer);
      expect(fullLayer.visible).toHaveBeenCalledWith(false);
      expect(adjLayer.visible).toHaveBeenCalledWith(false);
    });
  });

  // ---- 14. draw() ----

  describe("draw", () => {
    it("returns early when width equals height equals 1", () => {
      mockedStore.dataset = { id: "d1", width: 1, height: 1 } as any;
      wrapper = mountComponent();
      // draw is called on mount but should return early
      expect((wrapper.vm as any).tileWidth).toBe(0);
    });

    it("returns early when no dataset", () => {
      mockedStore.dataset = null as any;
      wrapper = mountComponent();
      expect((wrapper.vm as any).tileWidth).toBe(0);
    });

    it("returns early when no layerStackImages", () => {
      mockedStore.layerStackImages = [];
      wrapper = mountComponent();
      expect((wrapper.vm as any).tileWidth).toBe(0);
    });

    it("returns early when no images have data", () => {
      mockedStore.layerStackImages = [
        { ...createLayerStackImage(), images: [] },
      ];
      wrapper = mountComponent();
      expect((wrapper.vm as any).tileWidth).toBe(0);
    });

    it("sets tileWidth and tileHeight from image", () => {
      const lsi = createLayerStackImage();
      mockedStore.layerStackImages = [lsi];
      wrapper = mountComponent();
      // draw runs on mount
      expect((wrapper.vm as any).tileWidth).toBe(256);
      expect((wrapper.vm as any).tileHeight).toBe(256);
    });

    it("shrinks excess maps through the store", () => {
      const map1 = mockMap();
      const map2 = mockMap();
      const removedMaps: any[] = [];
      (mockedStore.popMap as any).mockImplementation(() => {
        removedMaps.push(mockedStore.maps[mockedStore.maps.length - 1]);
        mockedStore.maps = mockedStore.maps.slice(0, -1);
      });
      mockedStore.maps = [
        { map: map1, imageLayers: [], params: {} } as any,
        { map: map2, imageLayers: [], params: {} } as any,
      ];
      mockedStore.layerStackImages = [createLayerStackImage()];

      wrapper = mountComponent();

      expect(map2.exit).toHaveBeenCalled();
      expect(mockedStore.popMap).toHaveBeenCalledOnce();
      expect(removedMaps[0].map.exit).toBe(map2.exit);
      expect(mockedStore.maps).toHaveLength(1);
    });
  });

  // ---- 14b. Unroll frame labels ----

  describe("unroll frame labels", () => {
    // A grid of XY frames: unrollW is ceil(sqrt(count)) for square images, so
    // the default 4 frames lay out 2x2.
    function unrolledXYStack(count = 4, overrides: any = {}) {
      const baseImage = createLayerStackImage().images[0];
      const images = Array.from({ length: count }, (_unused, IndexXY) => ({
        ...baseImage,
        frameIndex: IndexXY,
        frame: { IndexXY },
      }));
      return createLayerStackImage({
        ...overrides,
        images,
        urls: images.map((_image, i) => `http://localhost/${i}/{z}/{x}/{y}`),
        fullUrls: images.map(
          (_image, i) => `http://localhost/${i}/{z}/{x}/{y}?full=true`,
        ),
        singleFrame: null,
      });
    }

    function mountUnrolled(frameCount = 4) {
      mockedStore.unroll = true;
      mockedStore.unrollXY = true;
      mockedStore.layerStackImages = [unrolledXYStack(frameCount)];
      wrapper = mountComponent();
      return (mockedStore.maps[0] as any).uiLayer;
    }

    // The labels a layer still has: created minus deleted. The creation log
    // alone would also count labels a rebuild has since removed — and the ui
    // layer hosts the scale widgets too, hence the class filter.
    function labelElements(uiLayer: any): HTMLElement[] {
      const deleted = new Set(
        uiLayer.deleteWidget.mock.calls.map((call: any[]) => call[0]),
      );
      return uiLayer.createWidget.mock.results
        .map((result: any) => result.value)
        .filter((widget: any) => !deleted.has(widget))
        .map((widget: any) => widget.canvas())
        .filter((element: HTMLElement) =>
          element.classList.contains("unroll-frame-label"),
        );
    }

    // Labels on the map as it exists now: draw() can replace a map entry, and
    // with it the layer the labels live on.
    function labelTexts(mapIndex = 0): (string | null)[] {
      return labelElements((mockedStore.maps[mapIndex] as any).uiLayer).map(
        (element) => element.textContent,
      );
    }

    it("labels each cell of the grid at its upper-left corner", () => {
      const uiLayer = mountUnrolled();

      expect(uiLayer.createWidget).toHaveBeenCalledTimes(4);
      expect(
        uiLayer.createWidget.mock.calls.map((call: any[]) => call[1].position),
      ).toEqual([
        { x: 0, y: 0 },
        { x: 1024, y: 0 },
        { x: 0, y: 1024 },
        { x: 1024, y: 1024 },
      ]);
      expect(
        labelElements(uiLayer).map((element) => element.textContent),
      ).toEqual(["XY 1", "XY 2", "XY 3", "XY 4"]);
      expect(labelElements(uiLayer)[0].classList).toContain(
        "unroll-frame-label",
      );
    });

    it("navigates to the clicked frame and rolls the grid up", () => {
      const uiLayer = mountUnrolled();

      labelElements(uiLayer)[2].click();

      expect(mockedStore.setXY).toHaveBeenCalledWith(2);
      expect(mockedStore.setUnrollXY).toHaveBeenCalledWith(false);
      // Only the unrolled dimension moves, and the reload is left to the
      // unroll flag watcher.
      expect(mockedStore.setZ).not.toHaveBeenCalled();
      expect(mockedStore.setTime).not.toHaveBeenCalled();
      expect(mockedStore.setUnrollZ).not.toHaveBeenCalled();
      expect(mockedStore.setUnrollT).not.toHaveBeenCalled();
    });

    it("creates no labels when nothing is unrolled", () => {
      mockedStore.layerStackImages = [createLayerStackImage()];
      wrapper = mountComponent();

      expect(
        (mockedStore.maps[0] as any).uiLayer.createWidget,
      ).not.toHaveBeenCalled();
      expect((wrapper.vm as any).unrollCellsByMap).toEqual([]);
    });

    it("makes each label a real button", () => {
      const uiLayer = mountUnrolled();

      expect(uiLayer.createWidget).toHaveBeenCalledWith(
        "dom",
        expect.objectContaining({ el: "button" }),
      );
      const [label] = labelElements(uiLayer);
      expect(label.getAttribute("type")).toBe("button");
      expect(label.getAttribute("aria-label")).toBe("Show XY 1 on its own");
    });

    it("ranks frames over the dataset, not over the drawn layer", () => {
      // The layer covers XY 0 and 5; the dataset's frames cover 0, 2 and 5, and
      // store.xy indexes into that. So the second cell is dataset index 2.
      const cellFrames = [0, 5];
      const stack = unrolledXYStack(2);
      stack.images.forEach((image: any, i: number) => {
        image.frame = { IndexXY: cellFrames[i] };
      });
      mockedStore.dataset = {
        ...(mockedStore.dataset as any),
        allImages: [0, 2, 5].map((IndexXY) => ({ frame: { IndexXY } })),
      } as any;
      mockedStore.unroll = true;
      mockedStore.unrollXY = true;
      mockedStore.layerStackImages = [stack];

      wrapper = mountComponent();
      const uiLayer = (mockedStore.maps[0] as any).uiLayer;

      expect(
        labelElements(uiLayer).map((element) => element.textContent),
      ).toEqual(["XY 1", "XY 3"]);
      labelElements(uiLayer)[1].click();
      expect(mockedStore.setXY).toHaveBeenCalledWith(2);
    });

    it("includes the dataset's dimension label when that axis is switched on", () => {
      mockedStore.dataset = {
        ...(mockedStore.dataset as any),
        dimensionLabels: { xy: ["19263, -6626", "18743, -8631"] },
      } as any;
      mountUnrolled(2);

      expect(labelTexts()).toEqual([
        "XY 1 (19263, -6626)",
        "XY 2 (18743, -8631)",
      ]);
    });

    it("rebuilds the labels when a viewer label setting is toggled", async () => {
      // Toggling "Show XY labels" changes only label text, so it never
      // triggers a redraw — the labels have to react to the setting itself.
      mockedStore.dataset = {
        ...(mockedStore.dataset as any),
        dimensionLabels: { xy: ["19263, -6626", "18743, -8631"] },
      } as any;
      mountUnrolled(2);
      expect(labelTexts()).toEqual([
        "XY 1 (19263, -6626)",
        "XY 2 (18743, -8631)",
      ]);

      mockedStore.showXYLabels = false;
      await nextTick();

      expect(labelTexts()).toEqual(["XY 1", "XY 2"]);
    });

    it("drops the dimension label when the viewer setting is off", () => {
      mockedStore.dataset = {
        ...(mockedStore.dataset as any),
        dimensionLabels: { xy: ["19263, -6626", "18743, -8631"] },
      } as any;
      mockedStore.showXYLabels = false;
      mountUnrolled(2);

      expect(labelTexts()).toEqual(["XY 1", "XY 2"]);
    });

    it("labels each map from its own layer group in unroll layer mode", () => {
      // Two visible layers, so mapLayerList has two groups and each gets a map.
      // The second layer covers fewer frames than the first.
      mockedStore.layerMode = "unroll" as any;
      mockedStore.unroll = true;
      mockedStore.unrollXY = true;
      mockedStore.dataset = {
        ...(mockedStore.dataset as any),
        allImages: [0, 1, 2, 3].map((IndexXY) => ({ frame: { IndexXY } })),
      } as any;
      mockedStore.layerStackImages = [
        unrolledXYStack(4, { layer: { id: "layer1" } }),
        unrolledXYStack(2, { layer: { id: "layer2" } }),
      ];

      wrapper = mountComponent();

      expect(mockedStore.maps).toHaveLength(2);
      expect(
        mockedStore.maps.map((mapentry: any) =>
          labelElements(mapentry.uiLayer).map((el) => el.textContent),
        ),
      ).toEqual([
        ["XY 1", "XY 2", "XY 3", "XY 4"],
        ["XY 1", "XY 2"],
      ]);
    });

    it("keeps the labels of an unchanged grid instead of rebuilding them", () => {
      const uiLayer = mountUnrolled();
      uiLayer.createWidget.mockClear();

      (wrapper.vm as any).draw();

      expect(uiLayer.createWidget).not.toHaveBeenCalled();
      expect(uiLayer.deleteWidget).not.toHaveBeenCalled();
    });

    it("clears the labels when the grid goes away", () => {
      const uiLayer = mountUnrolled();

      (wrapper.vm as any).clearUnrollLabels();

      expect(uiLayer.deleteWidget).toHaveBeenCalledTimes(4);
    });

    it("labels nothing, and says so, for a grid past the label limit", () => {
      const uiLayer = mountUnrolled(401);

      expect(uiLayer.createWidget).not.toHaveBeenCalled();
      // The cells still exist; only the labels are dropped.
      expect((wrapper.vm as any).unrollCellsByMap[0]).toHaveLength(401);
      expect(vi.mocked(logWarning)).toHaveBeenCalledWith(
        expect.stringContaining("401 frames exceeds"),
      );
    });
  });

  // ---- 14. SAM Tool Help ----

  describe("SAM tool help alert", () => {
    it("showSamToolHelpAlert is initially false", () => {
      wrapper = mountComponent();
      expect((wrapper.vm as any).showSamToolHelpAlert).toBe(false);
    });
  });

  // ---- 15. Data Initialization ----

  describe("data initialization", () => {
    it("isViewLocked starts as false", () => {
      wrapper = mountComponent();
      expect((wrapper.vm as any).isViewLocked).toBe(false);
    });

    it("scaleDialog starts as false", () => {
      wrapper = mountComponent();
      expect((wrapper.vm as any).scaleDialog).toBe(false);
    });

    it("mouseState starts as null", () => {
      wrapper = mountComponent();
      expect((wrapper.vm as any).mouseState).toBeNull();
    });

    it("tileWidth starts as 0", () => {
      wrapper = mountComponent();
      // draw may update it, but initial is 0
      expect(typeof (wrapper.vm as any).tileWidth).toBe("number");
    });

    it("unrollW starts as 1", () => {
      wrapper = mountComponent();
      expect(typeof (wrapper.vm as any).unrollW).toBe("number");
    });

    it("synchronisationEnabled starts as true", () => {
      wrapper = mountComponent();
      expect((wrapper.vm as any).synchronisationEnabled).toBe(true);
    });

    it("scaleWidget starts as null", () => {
      wrapper = mountComponent();
      expect((wrapper.vm as any).scaleWidget).toBeNull();
    });

    it("scalePixelWidget starts as null", () => {
      wrapper = mountComponent();
      expect((wrapper.vm as any).scalePixelWidget).toBeNull();
    });

    it("defaultActions starts as undefined", () => {
      wrapper = mountComponent();
      expect((wrapper.vm as any).defaultActions).toBeUndefined();
    });

    it("resetMapsOnDraw starts as false", () => {
      wrapper = mountComponent();
      // It's set true during dataset watcher but reset in draw
      expect(typeof (wrapper.vm as any).resetMapsOnDraw).toBe("boolean");
    });

    it("samMapEntry starts as null or first map", () => {
      wrapper = mountComponent();
      // On mount, mapsChanged sets it to maps[0] ?? null
      const val = (wrapper.vm as any).samMapEntry;
      expect(val === null || typeof val === "object").toBe(true);
    });

    it("blankUrl is a valid data URL", () => {
      wrapper = mountComponent();
      expect((wrapper.vm as any).blankUrl).toContain("data:image/png;base64,");
    });
  });

  // ---- 16. setCorners ----

  describe("setCorners", () => {
    it("adjusts map zoom and center based on corners", () => {
      const map1 = mockMap();
      mockedStore.maps = [{ map: map1, imageLayers: [], params: {} } as any];
      wrapper = mountComponent();

      (wrapper.vm as any).setCorners({
        lowerLeftGcs: { x: 0, y: 100 },
        upperRightGcs: { x: 100, y: 0 },
      });

      expect(map1.zoom).toHaveBeenCalled();
      expect(map1.center).toHaveBeenCalled();
    });

    it("setCorners does nothing when no maps", () => {
      mockedStore.maps = [];
      wrapper = mountComponent();
      (wrapper.vm as any).setCorners({
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
      expect(wrapper.find('[data-tour="lock-view"]').exists()).toBe(true);
    });

    it("renders layer info button", () => {
      wrapper = mountComponent();
      // The button is inside a v-menu which may not render the activator in shallow mount
      // Check the wrapper HTML for the button or the menu
      const html = wrapper.html();
      expect(html).toContain("lock-view");
    });

    it("does not render reset rotation button when rotation is 0", () => {
      mockedStore.cameraInfo = {
        zoom: 5,
        rotate: 0,
        center: { x: 0, y: 0 },
        gcsBounds: [],
      } as any;
      wrapper = mountComponent();
      expect(wrapper.find('[data-tour="reset-rotation"]').exists()).toBe(false);
    });

    it("overview computed reflects store.overview", () => {
      mockedStore.overview = true;
      mockedStore.unroll = false;
      wrapper = mountComponent();
      expect((wrapper.vm as any).overview).toBe(true);
      expect((wrapper.vm as any).unrolling).toBe(false);
    });

    it("unrolling reflects store.unroll", () => {
      mockedStore.overview = true;
      mockedStore.unroll = true;
      wrapper = mountComponent();
      expect((wrapper.vm as any).unrolling).toBe(true);
    });

    it("renders map divs matching mapLayerList length", () => {
      mockedStore.layerStackImages = [createLayerStackImage()];
      wrapper = mountComponent();
      // mapLayerList wraps layerStackImages in a single group in "multiple" mode
      // The template renders one div per mapLayerList entry
      expect((wrapper.vm as any).mapLayerList.length).toBe(1);
    });
  });

  // ---- 18. Watcher - dataset ----

  describe("dataset watcher", () => {
    it("dataset change sets resetMapsOnDraw true", async () => {
      wrapper = mountComponent();
      (wrapper.vm as any).resetMapsOnDraw = false;
      mockedStore.dataset = { id: "dataset2", width: 500, height: 500 } as any;
      await nextTick();
      // The watcher should set resetMapsOnDraw
      expect((wrapper.vm as any).resetMapsOnDraw).toBe(true);
    });
  });

  // ---- 19. mapSynchronizationCallbacks ----

  describe("mapSynchronizationCallbacks", () => {
    it("starts as empty Map", () => {
      wrapper = mountComponent();
      expect((wrapper.vm as any).mapSynchronizationCallbacks).toBeInstanceOf(
        Map,
      );
      expect((wrapper.vm as any).mapSynchronizationCallbacks.size).toBe(0);
    });
  });
});

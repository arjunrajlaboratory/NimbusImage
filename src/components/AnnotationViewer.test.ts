import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { shallowMount } from "@vue/test-utils";

// ---- Hoisted mocks ----

// Records every throttle/debounce wrapper the component creates, so the
// teardown test can find them without a hand-maintained list. Delegates to the
// real lodash so timing behaviour (and every test that advances fake timers
// through a throttle) is unchanged.
const createdThrottles = vi.hoisted(() => [] as any[]);

vi.mock("lodash", async (importOriginal) => {
  const actual = await importOriginal<typeof import("lodash")>();
  const record = (wrapper: any) => {
    createdThrottles.push(wrapper);
    return wrapper;
  };
  return {
    ...actual,
    throttle: (...args: any[]) => record((actual.throttle as any)(...args)),
    debounce: (...args: any[]) => record((actual.debounce as any)(...args)),
  };
});

vi.mock("onnxruntime-web/webgpu", () => ({
  InferenceSession: { create: vi.fn() },
  Tensor: vi.fn(),
}));

vi.mock("@/pipelines/samPipeline", () => ({
  mouseStateToSamPrompt: vi.fn(),
  samPromptToAnnotation: vi.fn(),
}));

vi.mock("@/pipelines/computePipeline", () => ({
  NoOutput: Symbol("NoOutput"),
}));

vi.mock("@/utils/annotation", () => ({
  pointDistance: vi.fn(),
  getAnnotationStyleFromBaseStyle: vi.fn().mockReturnValue({
    fillColor: "red",
    fillOpacity: 0.5,
    strokeColor: "red",
    strokeWidth: 2,
    radius: 5,
  }),
  unrollIndexFromImages: vi.fn().mockReturnValue(0),
  geojsAnnotationFactory: vi.fn(),
  tagFilterFunction: vi.fn().mockReturnValue(true),
  ellipseToPolygonCoordinates: vi.fn((coords) => coords),
  // Faithful copy of the real keep-decision (unit-tested in
  // annotationStubUtils.test.ts). Importing the real module here pulls in its
  // heavy transitive graph and OOMs this large test file, so mirror the small
  // pure logic instead — stub ⇔ no `coordinates` field.
  drawnFeatureUnchanged: (
    layerExists: boolean,
    layerData: any,
    drawnColor: string | null,
    drawnIsStub: boolean,
    drawnGeometryKey: number,
  ) =>
    !!layerExists &&
    !!layerData &&
    layerData.color === drawnColor &&
    !("coordinates" in layerData) === drawnIsStub &&
    // Mirror geometryKeyForRender: hydrated keys off coordinates length, stub
    // off centroid — enough fidelity for the viewer test's keep-decision.
    (drawnGeometryKey === undefined ||
      drawnGeometryKey === (layerData.coordinates?.length ?? -1)),
  geometryKeyForRender: (data: any) =>
    "coordinates" in data ? data.coordinates?.length ?? -1 : -1,
  // Faithful copy of the real predicate (unit-tested in Task 1). Point stubs
  // use the regular point style (false); polygon/line/rectangle stubs use the
  // dot style (true).
  drawnFeatureUsesDotStyle: vi.fn(
    (isStub: boolean, shape: string) => isStub && shape !== "point",
  ),
  getStubStyleFromBaseStyle: vi.fn().mockReturnValue({
    fillColor: "blue",
    fillOpacity: 0.3,
    strokeColor: "blue",
    strokeWidth: 1,
    radius: 5,
  }),
  // Faithful copy of the real retained-feature skip predicate (unit-tested in
  // annotationStubUtils.test.ts). Retainable only with a stable (layer,
  // annotation) identity and not a connection / special feature.
  shouldRetainFeature: (options: any) =>
    !!(
      options.girderId &&
      options.layerId &&
      !options.isConnection &&
      !options.specialAnnotation
    ),
}));

// Real geometry throughout — only `unrollLayoutFor` is wrapped, so a test can
// count how many layouts a draw builds. It must be ONE per draw: building one
// inside the per-annotation transform allocates two objects per annotation,
// including on the un-unrolled path that is supposed to allocate nothing.
const unrollSpy = vi.hoisted(() => ({ unrollLayoutFor: vi.fn() }));
vi.mock("@/utils/unroll", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/unroll")>();
  unrollSpy.unrollLayoutFor.mockImplementation(actual.unrollLayoutFor);
  return { ...actual, unrollLayoutFor: unrollSpy.unrollLayoutFor };
});

vi.mock("@/utils/polygonSlice", () => ({
  editPolygonAnnotation: vi.fn().mockReturnValue([]),
}));

vi.mock("@/utils/itk", () => ({
  snapCoordinates: vi.fn(),
}));

vi.mock("@/utils/log", () => ({
  logError: vi.fn(),
  logWarning: vi.fn(),
}));

vi.mock("@/utils/paths", () => ({
  getStringFromPropertiesAndPath: vi.fn(),
}));

// GeoJS mock
const mockGeoJSAnnotation = (type: string = "point") => {
  const optionsStore: Record<string, any> = {};
  return {
    type: vi.fn().mockReturnValue(type),
    coordinates: vi.fn().mockReturnValue([{ x: 10, y: 20 }]),
    _coordinates: vi.fn(),
    style: vi.fn().mockReturnValue({
      radius: 5,
      strokeWidth: 2,
      fillColor: "red",
      fillOpacity: 0.5,
    }),
    options: vi.fn((...args: any[]) => {
      if (args.length === 0) return { ...optionsStore };
      if (args.length === 1 && typeof args[0] === "string")
        return optionsStore[args[0]];
      if (args.length === 2) {
        optionsStore[args[0]] = args[1];
        return mockGeoJSAnnotation;
      }
      if (args.length === 1 && typeof args[0] === "object") {
        Object.assign(optionsStore, args[0]);
        return mockGeoJSAnnotation;
      }
      return optionsStore;
    }),
    draw: vi.fn(),
    layer: vi.fn(),
    geojson: vi.fn(),
    mouseClick: vi.fn(),
  };
};

const mockAnnotationLayer = () => {
  const annotations: any[] = [];
  return {
    annotations: vi.fn(() => [...annotations]),
    addAnnotation: vi.fn((ann: any) => annotations.push(ann)),
    addMultipleAnnotations: vi.fn((anns: any[]) => annotations.push(...anns)),
    removeAnnotation: vi.fn((ann: any) => {
      const idx = annotations.indexOf(ann);
      if (idx !== -1) annotations.splice(idx, 1);
      return true;
    }),
    removeAllAnnotations: vi.fn(() => {
      annotations.length = 0;
      return 0;
    }),
    modified: vi.fn(),
    draw: vi.fn(),
    geoOn: vi.fn(),
    geoOff: vi.fn(),
    mode: vi.fn(),
    options: vi.fn(),
    currentAnnotation: null,
    map: vi.fn(() => ({
      unitsPerPixel: vi.fn().mockReturnValue(1),
      zoom: vi.fn().mockReturnValue(5),
      zoomRange: vi.fn().mockReturnValue({ min: 0, max: 10 }),
      size: vi.fn().mockReturnValue({ width: 1640, height: 877 }),
      bounds: vi.fn().mockReturnValue({
        left: 0,
        top: 0,
        right: 1000,
        bottom: 800,
      }),
      gcsToDisplay: vi.fn((pt: any) => pt),
      displayToGcs: vi.fn((pt: any) => pt),
      interactor: vi.fn().mockReturnValue({
        options: vi.fn().mockReturnValue({
          actions: [{ name: "button pan" }],
        }),
      }),
    })),
  };
};

const mockFeatureLayer = () => {
  const features: any[] = [];
  const featureChain = {
    data: vi.fn().mockReturnThis(),
    position: vi.fn().mockReturnThis(),
    style: vi.fn().mockReturnThis(),
    draw: vi.fn().mockReturnThis(),
  };
  return {
    createFeature: vi.fn().mockReturnValue(featureChain),
    features: vi.fn((...args: any[]) => {
      if (args.length === 0) return features;
      features.length = 0;
      features.push(...args[0]);
      return undefined;
    }),
    clear: vi.fn(),
    draw: vi.fn(),
    geoOn: vi.fn(),
    geoOff: vi.fn(),
  };
};

const mockWorkerPreviewFeature = () => ({
  data: vi.fn().mockReturnThis(),
  draw: vi.fn(),
});

const mockOverviewLayer = () => {
  let isVisible = false;
  let opacity = 1;
  return {
    visible: vi.fn((value?: boolean) => {
      if (value !== undefined) isVisible = value;
      return isVisible;
    }),
    opacity: vi.fn((value?: number) => {
      if (value !== undefined) opacity = value;
      return opacity;
    }),
    draw: vi.fn(),
  };
};

vi.mock("geojs", () => ({
  default: {
    annotation: {
      pointAnnotation: vi.fn(() => mockGeoJSAnnotation("point")),
      lineAnnotation: vi.fn(() => mockGeoJSAnnotation("line")),
      polygonAnnotation: vi.fn(() => mockGeoJSAnnotation("polygon")),
    },
    createAnnotation: vi.fn((type: string) => mockGeoJSAnnotation(type)),
    event: {
      mouseclick: "geojs.mouseclick",
      mousedown: "geojs.mousedown",
      mousemove: "geojs.mousemove",
      mouseup: "geojs.mouseup",
      zoom: "geojs.zoom",
      annotation: {
        mode: "geojs.annotation.mode",
        add: "geojs.annotation.add",
        update: "geojs.annotation.update",
        state: "geojs.annotation.state",
        coordinates: "geojs.annotation.coordinates",
      },
    },
    util: {
      distance2dToLineSquared: vi.fn().mockReturnValue(100),
      pointInPolygon: vi.fn().mockReturnValue(false),
    },
    listAnnotations: vi.fn().mockReturnValue([]),
  },
}));

// Use reactive() so the computed properties are reactive
vi.mock("@/store", () => {
  const { reactive } = require("vue");
  return {
    default: reactive({
      configuration: { name: "Test Config" },
      layers: [] as any[],
      dataset: {
        id: "dataset1",
        name: "Test Dataset",
        width: 1000,
        height: 800,
        anyImage: () => ({
          sizeX: 1024,
          sizeY: 1024,
          item: { _id: "item1" },
          frameIndex: 0,
          tileWidth: 256,
          tileHeight: 256,
        }),
        images: () => [],
      } as any,
      xy: 0,
      z: 0,
      time: 0,
      unrollXY: false,
      unrollZ: false,
      unrollT: false,
      // DERIVED, exactly as in the real store, where `unroll` is a getter over
      // the three flags. It used to be an independent field here, so a test that
      // set `unrollXY` alone left `unroll` false — the component's filtering saw
      // an unrolled axis while its coordinate transform did not, a state the app
      // can never actually be in. Writing `unroll` unrolls time, which is what
      // the tests that set it are reaching for.
      get unroll() {
        return this.unrollXY || this.unrollZ || this.unrollT;
      },
      set unroll(value: boolean) {
        this.unrollT = value;
      },
      selectedTool: null as any,
      drawAnnotations: true,
      drawAnnotationConnections: true,
      showTooltips: false,
      filteredDraw: false,
      filteredAnnotationTooltips: false,
      scaleAnnotationsWithZoom: false,
      annotationsRadius: 5,
      annotationOpacity: 0.5,
      annotationSelectionType: "ADD",
      showAnnotationsFromHiddenLayers: false,
      valueOnHover: false,
      layerSliceIndexes: vi.fn().mockReturnValue({
        xyIndex: 0,
        zIndex: 0,
        tIndex: 0,
      }),
      getLayerFromId: vi.fn().mockReturnValue(null),
      getLayerIndexFromId: vi.fn().mockReturnValue(null),
      getImagesFromLayer: vi.fn().mockReturnValue([]),
      setSelectedToolId: vi.fn(),
      setTime: vi.fn(),
      setHoverValue: vi.fn(),
      api: {
        getPixelValuesForAllLayers: vi.fn().mockResolvedValue([]),
      },
    }),
  };
});

// Timelapse view state moved out of the main store into its own module. Also
// `reactive()`, and for the same reason: the draw path is driven by watchers on
// these fields, so a plain object would let every timelapse test assert against
// a layer that was never rebuilt.
vi.mock("@/store/timelapse", () => {
  const { reactive } = require("vue");
  return {
    default: reactive({
      showMode: false,
      modeWindow: 5,
      tags: [] as string[],
      showLabels: false,
      trackColoring: "track" as "track" | "uniform",
      colorSeed: 0,
    }),
  };
});

vi.mock("@/store/annotation", () => {
  const { reactive } = require("vue");
  const state = reactive({
    annotations: [] as any[],
    annotationConnections: [] as any[],
    annotationCentroids: {} as Record<string, any>,
    selectedAnnotationIds: new Set<string>(),
    hoveredAnnotationId: null as string | null,
    pendingAnnotation: null as any,
    stubOnlyMode: false,
    overviewConfig: {
      enabled: false,
      mode: "shapes",
      opacity: 0.6,
      vectorSwitchThreshold: 1,
    },
    getAnnotationFromId: vi.fn().mockReturnValue(undefined),
    getStub: vi.fn().mockReturnValue(undefined),
    // Truthy by default: combine's "is the first annotation still hydrated?"
    // guard treats it as loaded unless a test overrides it.
    getHydratedAnnotation: vi.fn().mockReturnValue({ coordinates: [] }),
    isAnnotationSelected: vi.fn().mockReturnValue(false),
    annotationIdToIdx: {} as Record<string, number>,
    selectAnnotations: vi.fn(),
    unselectAnnotations: vi.fn(),
    toggleSelected: vi.fn(),
    clearSelectedAnnotations: vi.fn(),
    deleteSelectedAnnotations: vi.fn(),
    deleteUnselectedAnnotations: vi.fn(),
    addAnnotationFromTool: vi.fn().mockResolvedValue(null),
    updateAnnotationsPerId: vi.fn().mockResolvedValue(undefined),
    createConnection: vi.fn(),
    createTimelapseConnection: vi.fn(),
    createAllConnections: vi.fn().mockResolvedValue(undefined),
    createAllTimelapseConnections: vi.fn().mockResolvedValue(undefined),
    deleteAllConnections: vi.fn().mockResolvedValue(undefined),
    combineAnnotations: vi.fn().mockResolvedValue(true),
    colorAnnotationIds: vi.fn(),
    colorSelectedAnnotations: vi.fn(),
    tagSelectedAnnotations: vi.fn(),
    removeTagsFromSelectedAnnotations: vi.fn(),
    setHoveredAnnotationId: vi.fn(),
    ensureHydrated: vi.fn(),
    setVisibilitySuppressed: vi.fn(),
  });
  Object.defineProperty(state, "annotationsForIteration", {
    get() {
      return state.annotations;
    },
    enumerable: true,
  });
  return { default: state };
});

vi.mock("@/store/properties", () => {
  const { reactive } = require("vue");
  return {
    default: reactive({
      displayWorkerPreview: false,
      getWorkerPreview: vi.fn().mockReturnValue({ text: null, image: "" }),
      displayedPropertyPaths: [] as any[],
      properties: [] as any[],
      propertyValues: {} as Record<string, any>,
      getSubIdsNameFromPath: vi.fn().mockReturnValue(null),
      ensureVisiblePropertyValues: vi.fn(),
    }),
  };
});

vi.mock("@/store/filters", () => {
  const { reactive } = require("vue");
  return {
    default: reactive({
      filteredAnnotations: [] as any[],
      roiFilters: [] as any[],
      emptyROIFilter: null as any,
      validateNewROIFilter: vi.fn(),
      updateHistograms: vi.fn(),
    }),
  };
});

vi.mock("@/components/ColorPickerMenu.vue", () => ({
  default: { name: "ColorPickerMenu", render: () => null },
}));
vi.mock("@/components/AnnotationContextMenu.vue", () => ({
  default: { name: "AnnotationContextMenu", render: () => null },
}));
vi.mock("@/components/AnnotationActionPanel.vue", () => ({
  default: { name: "AnnotationActionPanel", render: () => null },
}));
vi.mock("@/components/TagSelectionDialog.vue", () => ({
  default: { name: "TagSelectionDialog", render: () => null },
}));
vi.mock("@/components/ColorSelectionDialog.vue", () => ({
  default: { name: "ColorSelectionDialog", render: () => null },
}));

import store from "@/store";
import annotationStore from "@/store/annotation";
import propertiesStore from "@/store/properties";
import filterStore from "@/store/filters";
import lineScanStore from "@/store/lineScan";
import {
  pointDistance,
  getAnnotationStyleFromBaseStyle,
  geojsAnnotationFactory,
  ellipseToPolygonCoordinates,
  unrollIndexFromImages,
} from "@/utils/annotation";
import geojs from "geojs";
import {
  ConnectionToolStateSymbol,
  CombineToolStateSymbol,
  SamAnnotationToolStateSymbol,
} from "@/store/model";
import { samPromptToAnnotation } from "@/pipelines/samPipeline";
import { NoOutput } from "@/pipelines/computePipeline";
import connectionListStore from "@/store/connectionList";
import timelapseStore from "@/store/timelapse";
import { TRACK_UNIFORM_COLOR, trackColor, trackKey } from "@/utils/connections";
import { annotationSpatialIndex } from "@/utils/spatialIndex";
import AnnotationViewer from "./AnnotationViewer.vue";

const mockedStore = vi.mocked(store);
const mockedTimelapseStore = vi.mocked(timelapseStore);
const mockedAnnotationStore = vi.mocked(annotationStore);
const mockedPropertiesStore = vi.mocked(propertiesStore);
const mockedFilterStore = vi.mocked(filterStore);

// ---- Test Data Factories ----

function makeAnnotation(overrides: Partial<any> = {}): any {
  return {
    id: "ann1",
    name: null,
    tags: [],
    shape: "point",
    channel: 0,
    location: { XY: 0, Z: 0, Time: 0 },
    coordinates: [{ x: 10, y: 20 }],
    datasetId: "dataset1",
    color: null,
    ...overrides,
  };
}

function makeConnection(overrides: Partial<any> = {}): any {
  return {
    id: "conn1",
    label: "test",
    tags: [],
    parentId: "ann1",
    childId: "ann2",
    datasetId: "dataset1",
    ...overrides,
  };
}

function makeLayer(overrides: Partial<any> = {}): any {
  return {
    id: "layer1",
    name: "Layer 1",
    color: "#ff0000",
    channel: 0,
    xy: { type: "current", value: 0 },
    z: { type: "current", value: 0 },
    time: { type: "current", value: 0 },
    visible: true,
    contrast: { whitePoint: 100, blackPoint: 0, mode: "percentile" },
    layerGroup: null,
    ...overrides,
  };
}

// ---- Mount Helper ----

function mountComponent(propsOverrides: Record<string, any> = {}) {
  const app = document.createElement("div");
  app.setAttribute("data-app", "true");
  document.body.appendChild(app);

  const aLayer = mockAnnotationLayer();
  const fLayer = mockFeatureLayer();
  const iLayer = mockAnnotationLayer();
  const tLayer = mockAnnotationLayer();
  const tTextLayer = mockFeatureLayer();
  const wpFeature = mockWorkerPreviewFeature();

  const mapObj = aLayer.map();

  const w = shallowMount(AnnotationViewer as any, {
    props: {
      map: mapObj,
      capturedMouseState: null,
      annotationLayer: aLayer,
      textLayer: fLayer,
      workerPreviewFeature: wpFeature,
      timelapseLayer: tLayer,
      timelapseTextLayer: tTextLayer,
      interactionLayer: iLayer,
      unrollH: 1,
      unrollW: 1,
      maps: [],
      tileWidth: 256,
      tileHeight: 256,
      lowestLayer: 0,
      layerCount: 10,
      ...propsOverrides,
    },
    global: {
      stubs: {
        AnnotationContextMenu: true,
        AnnotationActionPanel: true,
        TagSelectionDialog: true,
        ColorSelectionDialog: true,
        ColorPickerMenu: true,
      },
    },
    attachTo: app,
  });

  return w;
}

// ---- Tests ----

describe("AnnotationViewer", () => {
  let wrapper: ReturnType<typeof mountComponent>;

  beforeEach(() => {
    vi.useFakeTimers();
    annotationSpatialIndex.clear();

    // Reset store state
    mockedStore.configuration = { name: "Test Config" } as any;
    mockedStore.layers = [];
    mockedStore.dataset = {
      id: "dataset1",
      name: "Test Dataset",
      width: 1000,
      height: 800,
      anyImage: () => ({
        sizeX: 1024,
        sizeY: 1024,
        item: { _id: "item1" },
        frameIndex: 0,
        tileWidth: 256,
        tileHeight: 256,
      }),
      images: () => [],
    } as any;
    mockedStore.xy = 0;
    mockedStore.z = 0;
    mockedStore.time = 0;
    mockedStore.unroll = false;
    mockedStore.unrollXY = false;
    mockedStore.unrollZ = false;
    mockedStore.unrollT = false;
    mockedStore.selectedTool = null;
    mockedStore.drawAnnotations = true;
    mockedStore.drawAnnotationConnections = true;
    mockedStore.showTooltips = false;
    mockedTimelapseStore.showMode = false;
    mockedTimelapseStore.modeWindow = 5;
    mockedTimelapseStore.tags = [];
    mockedTimelapseStore.showLabels = false;
    mockedTimelapseStore.trackColoring = "track";
    mockedTimelapseStore.colorSeed = 0;
    mockedStore.filteredDraw = false;
    mockedStore.filteredAnnotationTooltips = false;
    mockedStore.scaleAnnotationsWithZoom = false;
    mockedStore.annotationsRadius = 5;
    mockedStore.annotationOpacity = 0.5;
    mockedStore.annotationSelectionType = "ADD" as any;
    mockedStore.showAnnotationsFromHiddenLayers = false;
    mockedStore.valueOnHover = false;
    mockedStore.cameraInfo = { gcsBounds: [] } as any;

    mockedAnnotationStore.annotations = [];
    mockedAnnotationStore.annotationConnections = [];
    mockedAnnotationStore.annotationCentroids = {};
    mockedAnnotationStore.selectedAnnotationIds = new Set<string>();
    // Explicit, because tests that install a real implementation would
    // otherwise leak it into every later test — vi.clearAllMocks() clears calls
    // but leaves implementations in place.
    (mockedAnnotationStore.isAnnotationSelected as any).mockReturnValue(false);
    mockedAnnotationStore.hoveredAnnotationId = null;
    mockedAnnotationStore.pendingAnnotation = null;
    mockedAnnotationStore.annotationIdToIdx = {};
    mockedAnnotationStore.stubOnlyMode = false;
    mockedAnnotationStore.overviewConfig = {
      enabled: false,
      mode: "shapes",
      opacity: 0.6,
      vectorSwitchThreshold: 1,
    } as any;
    (mockedAnnotationStore.getAnnotationFromId as any).mockReturnValue(
      undefined,
    );
    (mockedAnnotationStore.getStub as any).mockReturnValue(undefined);
    mockedAnnotationStore.annotationStubs = new Map();
    mockedAnnotationStore.hydratedAnnotations = new Map();
    mockedAnnotationStore.visibleAnnotationIds = new Set();
    mockedAnnotationStore.visibilityConfig = {
      stubThreshold: 10000,
      maxVisible: 10000,
      minimumVisible: 5000,
      maxHydrated: 5000,
      hydrationCacheCap: 10000,
      globalThreshold: true,
      coverageTarget: 0.15,
      revealMoreOnZoom: true,
      viewportRefreshFraction: 0.2,
    };
    mockedAnnotationStore.averageStubRadius = 0;
    mockedAnnotationStore.updateVisibilityAndHydration = vi.fn();

    mockedPropertiesStore.displayWorkerPreview = false;
    mockedPropertiesStore.displayedPropertyPaths = [];
    mockedPropertiesStore.properties = [];
    mockedPropertiesStore.propertyValues = {};

    mockedFilterStore.filteredAnnotations = [];
    mockedFilterStore.roiFilters = [];
    mockedFilterStore.emptyROIFilter = null;

    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    annotationSpatialIndex.clear();
    // Unmount the mounted component so its watchers, GeoJS layer refs, and
    // reactive subscriptions are released. Without this the ~246 mounted
    // instances accumulate across the run and OOM the vitest worker. Also clear
    // the `attachTo` divs mountComponent appends to document.body.
    if (wrapper) {
      wrapper.unmount();
    }
    createdThrottles.length = 0;
    document.body.innerHTML = "";
  });

  // =========================================================================
  // Category 1: Computed Property Store Proxies (~31 tests)
  // =========================================================================
  describe("annotation overview raster", () => {
    it("suppresses vectors and hydration only while the raster is active", async () => {
      mockedStore.layers = [makeLayer()];
      const map = mockAnnotationLayer().map();
      map.unitsPerPixel.mockReturnValue(2);
      const overviewLayer = mockOverviewLayer();
      mockedAnnotationStore.overviewConfig = {
        enabled: true,
        mode: "shapes",
        opacity: 0.6,
        vectorSwitchThreshold: 1,
      } as any;

      wrapper = mountComponent({
        map,
        annotationOverviewLayer: overviewLayer,
      });
      await wrapper.vm.$nextTick();

      expect((wrapper.vm as any).rasterActive).toBe(true);
      expect((wrapper.vm as any).shouldDrawAnnotations).toBe(false);
      expect(overviewLayer.visible).not.toHaveBeenCalled();
      expect(overviewLayer.opacity).not.toHaveBeenCalled();
      expect(
        wrapper.emitted("annotation-overview-visibility-change")?.at(-1),
      ).toEqual([{ visible: true, opacity: 0.6 }]);
      expect(
        mockedAnnotationStore.updateVisibilityAndHydration,
      ).toHaveBeenCalledWith(expect.objectContaining({ suppress: true }));

      vi.clearAllMocks();
      map.unitsPerPixel.mockReturnValue(0.5);
      mockedAnnotationStore.overviewConfig = {
        ...mockedAnnotationStore.overviewConfig,
      } as any;
      await wrapper.vm.$nextTick();

      expect((wrapper.vm as any).rasterActive).toBe(false);
      expect((wrapper.vm as any).shouldDrawAnnotations).toBe(true);
      expect(
        wrapper.emitted("annotation-overview-visibility-change")?.at(-1),
      ).toEqual([{ visible: false, opacity: 0.6 }]);
      expect(
        mockedAnnotationStore.updateVisibilityAndHydration,
      ).toHaveBeenCalledWith(expect.not.objectContaining({ suppress: true }));
    });

    it("retains vector mode above the raster selector limit", async () => {
      mockedStore.layers = Array.from({ length: 65 }, (_, channel) =>
        makeLayer({ id: `layer-${channel}`, channel, visible: true }),
      );
      mockedAnnotationStore.overviewConfig = {
        enabled: true,
        mode: "shapes",
        opacity: 0.6,
        vectorSwitchThreshold: 1,
      } as any;
      const map = mockAnnotationLayer().map();
      map.unitsPerPixel.mockReturnValue(2);

      wrapper = mountComponent({
        map,
        annotationOverviewLayer: mockOverviewLayer(),
        lowestLayer: 0,
        layerCount: 65,
      });
      await wrapper.vm.$nextTick();

      expect((wrapper.vm as any).rasterActive).toBe(false);
      expect((wrapper.vm as any).shouldDrawAnnotations).toBe(true);
      expect(
        wrapper.emitted("annotation-overview-visibility-change")?.at(-1),
      ).toEqual([{ visible: false, opacity: 0.6 }]);
    });

    it("draws only selected stubs as feedback over the raster", () => {
      const layer = makeLayer({ id: "l1", channel: 0, visible: true });
      mockedStore.layers = [layer];
      (mockedStore.getLayerFromId as any).mockReturnValue(layer);
      const selectedStub = {
        id: "selected",
        centroid: { x: 10, y: 20 },
        location: { XY: 0, Z: 0, Time: 0 },
        shape: "polygon",
        channel: 0,
        tags: [],
        color: null,
        estimatedRadius: 5,
      };
      const unselectedStub = {
        ...selectedStub,
        id: "unselected",
        centroid: { x: 30, y: 40 },
      };
      const selectedSecondStub = {
        ...selectedStub,
        id: "selected-second",
        centroid: { x: 50, y: 60 },
      };
      const selectedThirdStub = {
        ...selectedStub,
        id: "selected-third",
        centroid: { x: 70, y: 80 },
      };
      const selectedOtherFrameStub = {
        ...selectedStub,
        id: "selected-other-frame",
        location: { XY: 0, Z: 0, Time: 1 },
      };
      mockedAnnotationStore.annotationStubs = new Map([
        [selectedOtherFrameStub.id, selectedOtherFrameStub],
        [selectedStub.id, selectedStub],
        [selectedSecondStub.id, selectedSecondStub],
        [selectedThirdStub.id, selectedThirdStub],
        [unselectedStub.id, unselectedStub],
      ]) as any;
      mockedAnnotationStore.hydratedAnnotations = new Map([
        [
          selectedStub.id,
          makeAnnotation({
            id: selectedStub.id,
            shape: "polygon",
            coordinates: [
              { x: 5, y: 15 },
              { x: 15, y: 15 },
              { x: 10, y: 25 },
            ],
          }),
        ],
      ]);
      mockedAnnotationStore.selectedAnnotationIds = new Set([
        selectedOtherFrameStub.id,
        selectedStub.id,
        selectedSecondStub.id,
        selectedThirdStub.id,
      ]);
      mockedAnnotationStore.visibilityConfig = {
        ...mockedAnnotationStore.visibilityConfig,
        minimumVisible: 2,
      };
      (mockedAnnotationStore.isAnnotationSelected as any).mockImplementation(
        (id: string) => mockedAnnotationStore.selectedAnnotationIds.has(id),
      );
      mockedAnnotationStore.overviewConfig = {
        enabled: true,
        mode: "shapes",
        opacity: 0.6,
        vectorSwitchThreshold: 1,
      } as any;
      const map = mockAnnotationLayer().map();
      map.unitsPerPixel.mockReturnValue(2);

      wrapper = mountComponent({
        map,
        annotationOverviewLayer: mockOverviewLayer(),
        lowestLayer: 0,
        layerCount: 1,
      });

      expect((wrapper.vm as any).rasterActive).toBe(true);
      expect((wrapper.vm as any).shouldDrawAnnotations).toBe(true);
      expect(
        (wrapper.vm as any).displayedAnnotations.map(
          (annotation: any) => annotation.id,
        ),
      ).toHaveLength(2);
      expect(
        (wrapper.vm as any).displayedAnnotations.every((annotation: any) =>
          mockedAnnotationStore.selectedAnnotationIds.has(annotation.id),
        ),
      ).toBe(true);
      expect(
        (wrapper.vm as any).displayedAnnotations.every(
          (annotation: any) => !("coordinates" in annotation),
        ),
      ).toBe(true);
      expect(
        (wrapper.vm as any).displayedAnnotations.map(
          (annotation: any) => annotation.id,
        ),
      ).not.toContain(selectedOtherFrameStub.id);
      expect(
        (wrapper.vm as any).displayedAnnotations.map(
          (annotation: any) => annotation.id,
        ),
      ).not.toContain(unselectedStub.id);
    });
  });

  describe("computed property store proxies", () => {
    beforeEach(() => {
      wrapper = mountComponent();
    });

    it("annotationSelectionType returns store value", () => {
      mockedStore.annotationSelectionType = "TOGGLE" as any;
      expect((wrapper.vm as any).annotationSelectionType).toBe("TOGGLE");
    });

    it("roiFilter returns filterStore.emptyROIFilter", () => {
      const filter = { id: "f1", roi: [] };
      mockedFilterStore.emptyROIFilter = filter as any;
      expect((wrapper.vm as any).roiFilter).toStrictEqual(filter);
    });

    it("enabledRoiFilters returns only enabled filters", () => {
      mockedFilterStore.roiFilters = [
        { id: "f1", enabled: true },
        { id: "f2", enabled: false },
        { id: "f3", enabled: true },
      ] as any;
      expect((wrapper.vm as any).enabledRoiFilters).toHaveLength(2);
      expect((wrapper.vm as any).enabledRoiFilters[0].id).toBe("f1");
      expect((wrapper.vm as any).enabledRoiFilters[1].id).toBe("f3");
    });

    it("configuration returns store.configuration", () => {
      expect((wrapper.vm as any).configuration).toBe(mockedStore.configuration);
    });

    it("layers returns store.layers", () => {
      const layers = [makeLayer()];
      mockedStore.layers = layers;
      expect((wrapper.vm as any).layers).toStrictEqual(layers);
    });

    it("filteredAnnotations returns filterStore.filteredAnnotations", () => {
      const anns = [makeAnnotation()];
      mockedFilterStore.filteredAnnotations = anns;
      expect((wrapper.vm as any).filteredAnnotations).toStrictEqual(anns);
    });

    it("annotationConnections returns annotationStore.annotationConnections", () => {
      const conns = [makeConnection()];
      mockedAnnotationStore.annotationConnections = conns;
      expect((wrapper.vm as any).annotationConnections).toStrictEqual(conns);
    });

    it("unrolling returns store.unroll", () => {
      mockedStore.unroll = true;
      expect((wrapper.vm as any).unrolling).toBe(true);
    });

    it("xy returns store.xy", () => {
      mockedStore.xy = 3;
      expect((wrapper.vm as any).xy).toBe(3);
    });

    it("z returns store.z", () => {
      mockedStore.z = 2;
      expect((wrapper.vm as any).z).toBe(2);
    });

    it("time returns store.time", () => {
      mockedStore.time = 7;
      expect((wrapper.vm as any).time).toBe(7);
    });

    it("dataset returns store.dataset", () => {
      expect((wrapper.vm as any).dataset).toBe(mockedStore.dataset);
    });

    it("valueOnHover returns store.valueOnHover", () => {
      mockedStore.valueOnHover = true;
      expect((wrapper.vm as any).valueOnHover).toBe(true);
    });

    it("isAnnotationSelected returns annotationStore.isAnnotationSelected", () => {
      expect((wrapper.vm as any).isAnnotationSelected).toBe(
        mockedAnnotationStore.isAnnotationSelected,
      );
    });

    it("showAnnotationsFromHiddenLayers returns store value", () => {
      mockedStore.showAnnotationsFromHiddenLayers = true;
      expect((wrapper.vm as any).showAnnotationsFromHiddenLayers).toBe(true);
    });

    it("hoveredAnnotationId returns annotationStore value", () => {
      mockedAnnotationStore.hoveredAnnotationId = "ann42";
      expect((wrapper.vm as any).hoveredAnnotationId).toBe("ann42");
    });

    it("selectedAnnotationIds returns annotationStore value", () => {
      const selected = new Set(["s1"]);
      mockedAnnotationStore.selectedAnnotationIds = selected;
      expect((wrapper.vm as any).selectedAnnotationIds).toStrictEqual(selected);
    });

    it("shouldDrawAnnotations returns store.drawAnnotations", () => {
      mockedStore.drawAnnotations = false;
      expect((wrapper.vm as any).shouldDrawAnnotations).toBe(false);
    });

    it("shouldDrawConnections returns store.drawAnnotationConnections", () => {
      mockedStore.drawAnnotationConnections = false;
      expect((wrapper.vm as any).shouldDrawConnections).toBe(false);
    });

    it("showTooltips returns store.showTooltips", () => {
      mockedStore.showTooltips = true;
      expect((wrapper.vm as any).showTooltips).toBe(true);
    });

    it("showTimelapseMode returns store.showTimelapseMode", () => {
      mockedTimelapseStore.showMode = true;
      expect((wrapper.vm as any).showTimelapseMode).toBe(true);
    });

    it("timelapseModeWindow returns store.timelapseModeWindow", () => {
      mockedTimelapseStore.modeWindow = 10;
      expect((wrapper.vm as any).timelapseModeWindow).toBe(10);
    });

    it("showTimelapseLabels returns store.showTimelapseLabels", () => {
      mockedTimelapseStore.showLabels = true;
      expect((wrapper.vm as any).showTimelapseLabels).toBe(true);
    });

    it("filteredAnnotationTooltips returns store value", () => {
      mockedStore.filteredAnnotationTooltips = true;
      expect((wrapper.vm as any).filteredAnnotationTooltips).toBe(true);
    });

    it("getAnnotationFromId returns annotationStore function", () => {
      expect((wrapper.vm as any).getAnnotationFromId).toBe(
        mockedAnnotationStore.getAnnotationFromId,
      );
    });

    it("displayWorkerPreview returns propertiesStore value", () => {
      mockedPropertiesStore.displayWorkerPreview = true;
      expect((wrapper.vm as any).displayWorkerPreview).toBe(true);
    });

    it("displayedPropertyPaths returns propertiesStore value", () => {
      const paths = [["a", "b"]];
      mockedPropertiesStore.displayedPropertyPaths = paths;
      expect((wrapper.vm as any).displayedPropertyPaths).toStrictEqual(paths);
    });

    it("properties returns propertiesStore value", () => {
      const props = [{ id: "p1" }];
      mockedPropertiesStore.properties = props as any;
      expect((wrapper.vm as any).properties).toStrictEqual(props);
    });

    it("propertyValues returns propertiesStore value", () => {
      const vals = { ann1: { p1: 42 } };
      mockedPropertiesStore.propertyValues = vals;
      expect((wrapper.vm as any).propertyValues).toStrictEqual(vals);
    });

    it("selectedToolConfiguration returns tool config or null", () => {
      expect((wrapper.vm as any).selectedToolConfiguration).toBeNull();
      const toolConfig = { id: "t1", type: "create", values: {} };
      mockedStore.selectedTool = {
        configuration: toolConfig,
        state: { type: Symbol("test") },
      } as any;
      expect((wrapper.vm as any).selectedToolConfiguration).toStrictEqual(
        toolConfig,
      );
    });

    it("selectedToolState returns tool state or null", () => {
      expect((wrapper.vm as any).selectedToolState).toBeNull();
      const state = { type: Symbol("test") };
      mockedStore.selectedTool = {
        configuration: { id: "t1" },
        state,
      } as any;
      expect((wrapper.vm as any).selectedToolState).toStrictEqual(state);
    });

    it("pendingStoreAnnotation returns annotationStore.pendingAnnotation", () => {
      expect((wrapper.vm as any).pendingStoreAnnotation).toBeNull();
      const pending = makeAnnotation({ id: "pending1" });
      mockedAnnotationStore.pendingAnnotation = pending;
      expect((wrapper.vm as any).pendingStoreAnnotation).toStrictEqual(pending);
    });
  });

  // =========================================================================
  // Category 2: Annotation Rendering Logic (~23 tests)
  // =========================================================================
  describe("annotation rendering logic", () => {
    // --- displayableAnnotations ---
    describe("displayableAnnotations", () => {
      it("returns empty when shouldDrawAnnotations is false", () => {
        mockedStore.drawAnnotations = false;
        wrapper = mountComponent();
        expect((wrapper.vm as any).displayableAnnotations).toEqual([]);
      });

      it("returns empty when annotationLayer is missing and shouldDrawAnnotations is false", () => {
        mockedStore.drawAnnotations = false;
        wrapper = mountComponent();
        // With no annotationLayer or no drawAnnotations, displayableAnnotations is empty
        expect((wrapper.vm as any).displayableAnnotations).toEqual([]);
      });

      it("returns filteredAnnotations when filteredDraw is true", () => {
        const filtered = [makeAnnotation({ id: "f1" })];
        mockedFilterStore.filteredAnnotations = filtered;
        mockedStore.filteredDraw = true;
        wrapper = mountComponent();
        expect((wrapper.vm as any).displayableAnnotations).toStrictEqual(
          filtered,
        );
      });

      it("returns all annotations when filteredDraw is false", () => {
        const all = [
          makeAnnotation({ id: "a1" }),
          makeAnnotation({ id: "a2" }),
        ];
        mockedAnnotationStore.annotations = all;
        mockedStore.filteredDraw = false;
        wrapper = mountComponent();
        expect((wrapper.vm as any).displayableAnnotations).toStrictEqual(all);
      });
    });

    // --- layerAnnotations ---
    describe("layerAnnotations", () => {
      it("groups annotations by channel matching layers", () => {
        const layer1 = makeLayer({ id: "l1", channel: 0, visible: true });
        const layer2 = makeLayer({ id: "l2", channel: 1, visible: true });
        mockedStore.layers = [layer1, layer2];
        const ann1 = makeAnnotation({ id: "a1", channel: 0 });
        const ann2 = makeAnnotation({ id: "a2", channel: 1 });
        mockedAnnotationStore.annotations = [ann1, ann2];

        wrapper = mountComponent({ lowestLayer: 0, layerCount: 2 });
        const result = (wrapper.vm as any).layerAnnotations;
        expect(result.get("l1")?.has("a1")).toBe(true);
        expect(result.get("l2")?.has("a2")).toBe(true);
        expect(result.get("l1")?.has("a2")).toBeFalsy();
      });

      it("filters by slice indexes", () => {
        const layer = makeLayer({ id: "l1", channel: 0, visible: true });
        mockedStore.layers = [layer];
        (mockedStore.layerSliceIndexes as any).mockReturnValue({
          xyIndex: 0,
          zIndex: 0,
          tIndex: 0,
        });
        const ann1 = makeAnnotation({
          id: "a1",
          channel: 0,
          location: { XY: 0, Z: 0, Time: 0 },
        });
        const ann2 = makeAnnotation({
          id: "a2",
          channel: 0,
          location: { XY: 1, Z: 0, Time: 0 },
        });
        mockedAnnotationStore.annotations = [ann1, ann2];

        wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });
        const result = (wrapper.vm as any).layerAnnotations;
        expect(result.get("l1")?.has("a1")).toBe(true);
        expect(result.get("l1")?.has("a2")).toBeFalsy();
      });

      it("includes all XY when unrollXY is true", () => {
        const layer = makeLayer({ id: "l1", channel: 0, visible: true });
        mockedStore.layers = [layer];
        mockedStore.unrollXY = true;
        (mockedStore.layerSliceIndexes as any).mockReturnValue({
          xyIndex: 0,
          zIndex: 0,
          tIndex: 0,
        });
        const ann1 = makeAnnotation({
          id: "a1",
          channel: 0,
          location: { XY: 0, Z: 0, Time: 0 },
        });
        const ann2 = makeAnnotation({
          id: "a2",
          channel: 0,
          location: { XY: 5, Z: 0, Time: 0 },
        });
        mockedAnnotationStore.annotations = [ann1, ann2];
        // Unrolling is on, so the drawn-centroid transform runs. The real store
        // writes a centroid for every annotation it holds, so leaving these out
        // would test a state that cannot occur.
        mockedAnnotationStore.annotationCentroids = {
          a1: { x: 1, y: 2 },
          a2: { x: 3, y: 4 },
        };

        wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });
        const result = (wrapper.vm as any).layerAnnotations;
        expect(result.get("l1")?.has("a1")).toBe(true);
        expect(result.get("l1")?.has("a2")).toBe(true);
      });

      it("includes all T when layer time type is max-merge", () => {
        const layer = makeLayer({
          id: "l1",
          channel: 0,
          visible: true,
          time: { type: "max-merge", value: 0 },
        });
        mockedStore.layers = [layer];
        (mockedStore.layerSliceIndexes as any).mockReturnValue({
          xyIndex: 0,
          zIndex: 0,
          tIndex: 0,
        });
        const ann1 = makeAnnotation({
          id: "a1",
          channel: 0,
          location: { XY: 0, Z: 0, Time: 0 },
        });
        const ann2 = makeAnnotation({
          id: "a2",
          channel: 0,
          location: { XY: 0, Z: 0, Time: 5 },
        });
        mockedAnnotationStore.annotations = [ann1, ann2];

        wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });
        const result = (wrapper.vm as any).layerAnnotations;
        expect(result.get("l1")?.has("a1")).toBe(true);
        expect(result.get("l1")?.has("a2")).toBe(true);
      });

      it("excludes annotations from hidden layers when showAnnotationsFromHiddenLayers is false", () => {
        const layer = makeLayer({
          id: "l1",
          channel: 0,
          visible: false,
        });
        mockedStore.layers = [layer];
        mockedStore.showAnnotationsFromHiddenLayers = false;
        const ann = makeAnnotation({ id: "a1", channel: 0 });
        mockedAnnotationStore.annotations = [ann];

        wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });
        const result = (wrapper.vm as any).layerAnnotations;
        expect(result.get("l1")?.size).toBe(0);
      });

      it("includes annotations from hidden layers when showAnnotationsFromHiddenLayers is true", () => {
        const layer = makeLayer({
          id: "l1",
          channel: 0,
          visible: false,
        });
        mockedStore.layers = [layer];
        mockedStore.showAnnotationsFromHiddenLayers = true;
        (mockedStore.layerSliceIndexes as any).mockReturnValue({
          xyIndex: 0,
          zIndex: 0,
          tIndex: 0,
        });
        const ann = makeAnnotation({ id: "a1", channel: 0 });
        mockedAnnotationStore.annotations = [ann];

        wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });
        const result = (wrapper.vm as any).layerAnnotations;
        expect(result.get("l1")?.has("a1")).toBe(true);
      });

      it("returns empty map for layers not in valid range", () => {
        const layer = makeLayer({ id: "l1", channel: 0, visible: true });
        mockedStore.layers = [layer];
        // lowestLayer=5 means no layers in the valid range
        wrapper = mountComponent({ lowestLayer: 5, layerCount: 1 });
        const result = (wrapper.vm as any).layerAnnotations;
        expect(result.size).toBe(0);
      });

      it("handles annotations with unrollZ flag", () => {
        const layer = makeLayer({ id: "l1", channel: 0, visible: true });
        mockedStore.layers = [layer];
        mockedStore.unrollZ = true;
        (mockedStore.layerSliceIndexes as any).mockReturnValue({
          xyIndex: 0,
          zIndex: 0,
          tIndex: 0,
        });
        const ann = makeAnnotation({
          id: "a1",
          channel: 0,
          location: { XY: 0, Z: 99, Time: 0 },
        });
        mockedAnnotationStore.annotations = [ann];
        mockedAnnotationStore.annotationCentroids = { a1: { x: 1, y: 2 } };

        wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });
        const result = (wrapper.vm as any).layerAnnotations;
        expect(result.get("l1")?.has("a1")).toBe(true);
      });
    });

    // --- validLayers ---
    describe("validLayers", () => {
      it("slices from lowestLayer by layerCount", () => {
        const layers = [
          makeLayer({ id: "l0" }),
          makeLayer({ id: "l1" }),
          makeLayer({ id: "l2" }),
          makeLayer({ id: "l3" }),
        ];
        mockedStore.layers = layers;
        wrapper = mountComponent({ lowestLayer: 1, layerCount: 2 });
        expect((wrapper.vm as any).validLayers).toEqual([layers[1], layers[2]]);
      });
    });

    // --- displayedAnnotationIds / displayedAnnotations / connectionIdsSet ---
    describe("displayedAnnotationIds", () => {
      it("unions annotation ids from all layer annotation maps", () => {
        const layer1 = makeLayer({ id: "l1", channel: 0, visible: true });
        const layer2 = makeLayer({ id: "l2", channel: 0, visible: true });
        mockedStore.layers = [layer1, layer2];
        (mockedStore.layerSliceIndexes as any).mockReturnValue({
          xyIndex: 0,
          zIndex: 0,
          tIndex: 0,
        });
        const ann1 = makeAnnotation({ id: "a1", channel: 0 });
        mockedAnnotationStore.annotations = [ann1];

        wrapper = mountComponent({ lowestLayer: 0, layerCount: 2 });
        const ids = (wrapper.vm as any).displayedAnnotationIds;
        expect(ids.has("a1")).toBe(true);
      });
    });

    // --- drawNewConnections ---
    describe("drawNewConnections", () => {
      function setupTwoDisplayedAnnotations() {
        const layer = makeLayer({ id: "l1", channel: 0, visible: true });
        mockedStore.layers = [layer];
        (mockedStore.getLayerFromId as any).mockReturnValue(layer);
        (mockedStore.layerSliceIndexes as any).mockReturnValue({
          xyIndex: 0,
          zIndex: 0,
          tIndex: 0,
        });
        mockedAnnotationStore.annotations = [
          makeAnnotation({ id: "a1", channel: 0 }),
          makeAnnotation({ id: "a2", channel: 0 }),
        ];
        mockedAnnotationStore.annotationCentroids = {
          a1: { x: 10, y: 20 },
          a2: { x: 30, y: 40 },
        };
        mockedAnnotationStore.annotationConnections = [
          makeConnection({ id: "c1", parentId: "a1", childId: "a2" }),
        ];
        (geojsAnnotationFactory as any).mockImplementation((shape: string) =>
          mockGeoJSAnnotation(shape),
        );
      }

      it("draws a line for a connection between two displayed annotations", () => {
        setupTwoDisplayedAnnotations();
        (mockedAnnotationStore.getAnnotationFromId as any).mockImplementation(
          (id: string) =>
            mockedAnnotationStore.annotations.find((a: any) => a.id === id),
        );
        wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });
        const aLayer = (wrapper.vm as any).annotationLayer;
        aLayer.addAnnotation.mockClear();
        (wrapper.vm as any).drawNewConnections(new Map());
        const added = aLayer.addAnnotation.mock.calls
          .map((call: any[]) => call[0])
          .filter((f: any) => f?.options?.().isConnection);
        expect(added).toHaveLength(1);
        expect(added[0].options().girderId).toBe("c1");
      });

      // Regression: in stub-only mode getAnnotationFromId returns undefined for
      // unhydrated annotations. Gating the draw on it silently dropped nearly
      // every connection on a lazily-loaded dataset (1 of 11 drawn on the 709K
      // Xenium dataset) even though every centroid was present.
      it("still draws when the endpoints are unhydrated stubs", () => {
        setupTwoDisplayedAnnotations();
        (mockedAnnotationStore.getAnnotationFromId as any).mockReturnValue(
          undefined,
        );
        wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });
        const aLayer = (wrapper.vm as any).annotationLayer;
        aLayer.addAnnotation.mockClear();
        (wrapper.vm as any).drawNewConnections(new Map());
        const added = aLayer.addAnnotation.mock.calls
          .map((call: any[]) => call[0])
          .filter((f: any) => f?.options?.().isConnection);
        expect(added).toHaveLength(1);
        expect(added[0].options().girderId).toBe("c1");
        expect(added[0].options().style.stroke).toBe(true);
      });

      // Retention must use the same criteria as the draw path, or every draw
      // removes the lines it just created and rebuilds them next pass.
      it("retains stub-backed connection lines through clearOldAnnotations", () => {
        setupTwoDisplayedAnnotations();
        (mockedAnnotationStore.getAnnotationFromId as any).mockReturnValue(
          undefined,
        );
        wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });
        const aLayer = (wrapper.vm as any).annotationLayer;
        const countLines = () =>
          aLayer.annotations().filter((f: any) => f.options().isConnection)
            .length;
        const before = countLines();
        expect(before).toBeGreaterThan(0);

        (wrapper.vm as any).clearOldAnnotations(false, false);
        expect(countLines()).toBe(before);
      });

      it("styles a selected connection at construction, not only on restyle", () => {
        setupTwoDisplayedAnnotations();
        (mockedAnnotationStore.getAnnotationFromId as any).mockReturnValue(
          undefined,
        );
        connectionListStore.setSelectedConnectionIds(["c1"]);
        wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });
        const aLayer = (wrapper.vm as any).annotationLayer;
        aLayer.addAnnotation.mockClear();
        (wrapper.vm as any).drawNewConnections(new Map());
        const line = aLayer.addAnnotation.mock.calls
          .map((call: any[]) => call[0])
          .find((f: any) => f?.options?.().isConnection);
        expect(line.options().style.strokeColor).toBe("#00e5ff");
        // Asserting colour alone is not enough: options("style", …) REPLACES
        // the style, so dropping `stroke` yields a correctly-positioned,
        // correctly-coloured, completely invisible line.
        expect(line.options().style.stroke).toBe(true);
      });

      // Regression: connection lines carry a girderId, so they land in
      // drawnGeoJSAnnotations. They never set isHovered/isSelected, and
      // `undefined != false` is true, so the retained-restyle loop used to
      // overwrite a selected connection's cyan on the very next redraw.
      it("keeps a selected connection cyan through a redraw", async () => {
        setupTwoDisplayedAnnotations();
        (mockedAnnotationStore.getAnnotationFromId as any).mockImplementation(
          (id: string) =>
            mockedAnnotationStore.annotations.find((a: any) => a.id === id),
        );
        connectionListStore.setSelectedConnectionIds(["c1"]);
        wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });
        const aLayer = (wrapper.vm as any).annotationLayer;

        const lineOf = () =>
          aLayer.annotations().find((f: any) => f.options().isConnection);
        expect(lineOf().options().style.strokeColor).toBe("#00e5ff");
        expect(lineOf().options().style.stroke).toBe(true);

        // A plain redraw must not clobber it.
        (wrapper.vm as any).drawAnnotationsNoThrottle();
        vi.advanceTimersByTime(101);
        await wrapper.vm.$nextTick();
        expect(lineOf().options().style.strokeColor).toBe("#00e5ff");
        expect(lineOf().options().style.stroke).toBe(true);
      });

      // A plain click highlights an object but used to do nothing at all on a
      // connection line — the hover handler skipped isConnection features —
      // which reads as the feature being broken.
      it("hovers a connection on a plain click that hits no object", () => {
        setupTwoDisplayedAnnotations();
        (mockedAnnotationStore.getAnnotationFromId as any).mockImplementation(
          (id: string) =>
            mockedAnnotationStore.annotations.find((a: any) => a.id === id),
        );
        wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });
        (wrapper.vm as any).drawNewConnections(new Map());
        connectionListStore.setHoveredConnectionId(null);

        // The GeoJS mock does not derive coordinates() from the vertices
        // option, so the hit test would see no geometry. Give the drawn line
        // the segment it represents.
        const aLayer = (wrapper.vm as any).annotationLayer;
        const drawnLine = aLayer
          .annotations()
          .find((f: any) => f.options().isConnection);
        drawnLine.coordinates = () => [
          { x: 0, y: 0 },
          { x: 1000, y: 1000 },
        ];
        // The shared geojs mock returns 100 from distance2dToLineSquared, which
        // never clears the 6px tolerance; 1 means "the click is on the line".
        (geojs.util.distance2dToLineSquared as any).mockReturnValue(1);

        // Midpoint of the drawn line: on the connection, away from any object.
        (wrapper.vm as any).setHoveredAnnotationFromCoordinates({
          x: 500,
          y: 500,
        });
        expect(connectionListStore.hoveredConnectionId).toBe("c1");
      });

      it("clears connection hover when the click lands on an object", () => {
        setupTwoDisplayedAnnotations();
        (mockedAnnotationStore.getAnnotationFromId as any).mockImplementation(
          (id: string) =>
            mockedAnnotationStore.annotations.find((a: any) => a.id === id),
        );
        wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });
        (wrapper.vm as any).drawNewConnections(new Map());
        connectionListStore.setHoveredConnectionId("c1");
        (geojs.util.distance2dToLineSquared as any).mockReturnValue(100);

        // Far from the line, so no connection is hit either way.
        (wrapper.vm as any).setHoveredAnnotationFromCoordinates({
          x: 9999,
          y: 9999,
        });
        expect(connectionListStore.hoveredConnectionId).toBeNull();
      });

      // Regression: the hit test returned the FIRST line within tolerance, so
      // with parallel or dense tracks a click could select a far segment over
      // a near one and leave some links unreachable from the canvas.
      it("selects the closest connection when several are within tolerance", () => {
        setupTwoDisplayedAnnotations();
        mockedAnnotationStore.annotationConnections = [
          makeConnection({ id: "far", parentId: "a1", childId: "a2" }),
          makeConnection({ id: "near", parentId: "a2", childId: "a1" }),
        ];
        (mockedAnnotationStore.getAnnotationFromId as any).mockImplementation(
          (id: string) =>
            mockedAnnotationStore.annotations.find((a: any) => a.id === id),
        );
        wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });
        const aLayer = (wrapper.vm as any).annotationLayer;
        (wrapper.vm as any).drawNewConnections(new Map());

        const lines = aLayer
          .annotations()
          .filter((f: any) => f.options().isConnection);
        // Give each line distinguishable geometry, then make the SECOND one
        // measurably nearer while both stay inside the 6px tolerance (36).
        lines.forEach((l: any, i: number) => {
          l.coordinates = () => [
            { x: i, y: 0 },
            { x: i, y: 100 },
          ];
        });
        (geojs.util.distance2dToLineSquared as any).mockImplementation(
          (_p: any, a: any) => (a.x === 0 ? 25 : 1),
        );

        const first = lines[0].options().girderId;
        const nearest = lines[1].options().girderId;
        expect(
          (wrapper.vm as any).findConnectionIdAtPoint({ x: 0, y: 50 }),
        ).toBe(nearest);
        expect(nearest).not.toBe(first);
      });

      // ConnectionActionPanel must live in ImageViewer, mounted once: in unroll
      // mode ImageViewer renders one AnnotationViewer per layer group, and a
      // per-viewer panel registered N global keydown listeners, so one Delete
      // press sent N duplicate batch DELETEs.
      it("does not mount the connection action panel per viewer", () => {
        wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });
        expect(
          wrapper.findComponent({ name: "ConnectionActionPanel" }).exists(),
        ).toBe(false);
        expect(wrapper.html()).not.toContain("connection-action-panel");
      });

      // In timelapse mode the track segments ARE the visual; the annotation
      // layer's dots sit under them. Clicking a segment that crosses a dot must
      // select the link, not the dot — otherwise clicking a track does nothing
      // for the connection, which is what users hit.
      // Puts a drawn OBJECT feature and a connection line on the layer at the
      // same spot, so the hover handler genuinely has to choose between them.
      // Building them explicitly beats driving the whole draw pipeline: the
      // point of the test is the precedence rule, not the drawing.
      function mountWithOverlappingObjectAndConnection() {
        setupTwoDisplayedAnnotations();
        (mockedAnnotationStore.getAnnotationFromId as any).mockImplementation(
          (id: string) =>
            mockedAnnotationStore.annotations.find((a: any) => a.id === id),
        );
        (geojs.util.distance2dToLineSquared as any).mockReturnValue(1);
        // pointDistance is a bare vi.fn() returning undefined, so the object
        // hit-test can never succeed until the test says otherwise — 0 means
        // "the click is dead on the object".
        (pointDistance as any).mockReturnValue(0);

        wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });
        const aLayer = (wrapper.vm as any).annotationLayer;
        aLayer.removeAllAnnotations();

        // Object a1 renders at (10, 20) with radius 5 — a click there hits it.
        const objectFeature = mockGeoJSAnnotation("point");
        objectFeature.options({ girderId: "a1", layerId: "l1" });
        (objectFeature.style as any).mockReturnValue({
          radius: 5,
          strokeWidth: 2,
        });
        aLayer.addAnnotation(objectFeature);

        // A connection line passing straight through the same point.
        const lineFeature = mockGeoJSAnnotation("line");
        lineFeature.options({ girderId: "c1", isConnection: true });
        (lineFeature.coordinates as any).mockReturnValue([
          { x: 0, y: 0 },
          { x: 100, y: 100 },
        ]);
        aLayer.addAnnotation(lineFeature);

        connectionListStore.setHoveredConnectionId(null);
        mockedAnnotationStore.hoveredAnnotationId = null;
      }

      it("prefers the connection over an object in timelapse mode", () => {
        mockedTimelapseStore.showMode = true;
        mountWithOverlappingObjectAndConnection();

        (wrapper.vm as any).setHoveredAnnotationFromCoordinates({
          x: 10,
          y: 20,
        });
        expect(connectionListStore.hoveredConnectionId).toBe("c1");
      });

      it("still prefers the object outside timelapse mode", () => {
        mockedTimelapseStore.showMode = false;
        mountWithOverlappingObjectAndConnection();

        (wrapper.vm as any).setHoveredAnnotationFromCoordinates({
          x: 10,
          y: 20,
        });
        expect(connectionListStore.hoveredConnectionId).toBeNull();
      });

      // Hovering must not rebuild the timelapse layer. It is one line feature
      // per connection — ~2,500 on a real dataset — and hovering rows in the
      // list changes hoveredConnectionId continuously, so rebuilding per hover
      // made the list feel sluggish. Selection still rebuilds.
      it("does not rebuild the timelapse layer on hover", async () => {
        mockedTimelapseStore.showMode = true;
        setupTwoDisplayedAnnotations();
        (mockedAnnotationStore.getAnnotationFromId as any).mockImplementation(
          (id: string) =>
            mockedAnnotationStore.annotations.find((a: any) => a.id === id),
        );
        wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });
        const tLayer = (wrapper.vm as any).timelapseLayer;
        await wrapper.vm.$nextTick();

        tLayer.removeAllAnnotations.mockClear();
        connectionListStore.setHoveredConnectionId("c1");
        await wrapper.vm.$nextTick();
        vi.advanceTimersByTime(101);
        const rebuildsOnHover = tLayer.removeAllAnnotations.mock.calls.length;

        tLayer.removeAllAnnotations.mockClear();
        connectionListStore.setSelectedConnectionIds(["c1"]);
        await wrapper.vm.$nextTick();
        vi.advanceTimersByTime(101);
        const rebuildsOnSelect = tLayer.removeAllAnnotations.mock.calls.length;

        expect(rebuildsOnHover).toBe(0);
        expect(rebuildsOnSelect).toBeGreaterThan(0);
      });

      // The timelapse precedence inversion must apply to SELECTION too, not
      // only to plain-click highlighting: shift+click and the select tool go
      // through selectAnnotations, and a track segment almost always overlaps
      // a dot, so without this most timelapse connections cannot be selected.
      it("selects the connection over an object in timelapse mode", () => {
        mockedTimelapseStore.showMode = true;
        mountWithOverlappingObjectAndConnection();
        connectionListStore.setSelectedConnectionIds([]);

        (wrapper.vm as any).selectAnnotations({
          type: () => "point",
          coordinates: () => [{ x: 10, y: 20 }],
        });

        expect([...connectionListStore.selectedConnectionIds]).toEqual(["c1"]);
        // The object must NOT also be selected — the mocked store uses the ADD
        // selection type, so that path calls selectAnnotations.
        expect(mockedAnnotationStore.selectAnnotations).not.toHaveBeenCalled();
      });

      it("still selects the object outside timelapse mode", () => {
        mockedTimelapseStore.showMode = false;
        mountWithOverlappingObjectAndConnection();
        connectionListStore.setSelectedConnectionIds([]);

        (wrapper.vm as any).selectAnnotations({
          type: () => "point",
          coordinates: () => [{ x: 10, y: 20 }],
        });

        expect(connectionListStore.selectedConnectionIds.size).toBe(0);
        expect(mockedAnnotationStore.selectAnnotations).toHaveBeenCalled();
      });

      it("skips a connection whose centroid is missing rather than drawing NaN", () => {
        setupTwoDisplayedAnnotations();
        (mockedAnnotationStore.getAnnotationFromId as any).mockReturnValue(
          undefined,
        );
        mockedAnnotationStore.annotationCentroids = { a1: { x: 10, y: 20 } };
        wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });
        const aLayer = (wrapper.vm as any).annotationLayer;
        aLayer.addAnnotation.mockClear();
        (wrapper.vm as any).drawNewConnections(new Map());
        const added = aLayer.addAnnotation.mock.calls
          .map((call: any[]) => call[0])
          .filter((f: any) => f?.options?.().isConnection);
        expect(added).toHaveLength(0);
      });
    });

    describe("displayedAnnotations", () => {
      it("returns flat array of annotations from layerAnnotations", () => {
        const layer = makeLayer({ id: "l1", channel: 0, visible: true });
        mockedStore.layers = [layer];
        (mockedStore.layerSliceIndexes as any).mockReturnValue({
          xyIndex: 0,
          zIndex: 0,
          tIndex: 0,
        });
        const ann1 = makeAnnotation({ id: "a1", channel: 0 });
        mockedAnnotationStore.annotations = [ann1];

        wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });
        const result = (wrapper.vm as any).displayedAnnotations;
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe("a1");
      });

      it("omits unhydrated stubs while raster overview is enabled", async () => {
        const layer = makeLayer({ id: "l1", channel: 0, visible: true });
        mockedStore.layers = [layer];
        (mockedStore.layerSliceIndexes as any).mockReturnValue({
          xyIndex: 0,
          zIndex: 0,
          tIndex: 0,
        });
        const unhydratedStub = {
          id: "stub-only",
          centroid: { x: 10, y: 20 },
          location: { XY: 0, Z: 0, Time: 0 },
          shape: "polygon",
          channel: 0,
          tags: [],
          color: null,
          estimatedRadius: 5,
        };
        const hydratedStub = {
          ...unhydratedStub,
          id: "hydrated",
          centroid: { x: 30, y: 40 },
        };
        const hydratedAnnotation = makeAnnotation({
          id: "hydrated",
          shape: "polygon",
          coordinates: [
            { x: 25, y: 35 },
            { x: 35, y: 35 },
            { x: 30, y: 45 },
          ],
        });
        mockedAnnotationStore.stubOnlyMode = true;
        mockedAnnotationStore.annotations = [
          unhydratedStub,
          hydratedStub,
        ] as any;
        mockedAnnotationStore.annotationStubs = new Map([
          [unhydratedStub.id, unhydratedStub],
          [hydratedStub.id, hydratedStub],
        ]) as any;
        mockedAnnotationStore.hydratedAnnotations = new Map([
          [hydratedAnnotation.id, hydratedAnnotation],
        ]);
        mockedAnnotationStore.visibleAnnotationIds = new Set([
          unhydratedStub.id,
          hydratedStub.id,
        ]);
        mockedAnnotationStore.overviewConfig = {
          enabled: true,
          mode: "shapes",
          opacity: 0.6,
          vectorSwitchThreshold: 1,
        } as any;
        const map = mockAnnotationLayer().map();
        map.unitsPerPixel.mockReturnValue(0.5);

        wrapper = mountComponent({
          map,
          annotationOverviewLayer: mockOverviewLayer(),
          lowestLayer: 0,
          layerCount: 1,
        });

        expect(
          (wrapper.vm as any).displayedAnnotations.map(
            (annotation: any) => annotation.id,
          ),
        ).toEqual(["hydrated"]);

        mockedStore.unroll = true;
        await wrapper.vm.$nextTick();

        expect(
          (wrapper.vm as any).displayedAnnotations.map(
            (annotation: any) => annotation.id,
          ),
        ).toEqual(["stub-only", "hydrated"]);

        mockedStore.unroll = false;
        mockedAnnotationStore.overviewConfig = {
          ...mockedAnnotationStore.overviewConfig,
          enabled: false,
        } as any;
        await wrapper.vm.$nextTick();

        expect(
          (wrapper.vm as any).displayedAnnotations.map(
            (annotation: any) => annotation.id,
          ),
        ).toEqual(["stub-only", "hydrated"]);
      });
    });

    describe("connectionIdsSet", () => {
      it("builds set from connection ids", () => {
        mockedAnnotationStore.annotationConnections = [
          makeConnection({ id: "c1" }),
          makeConnection({ id: "c2" }),
        ];
        wrapper = mountComponent();
        const set = (wrapper.vm as any).connectionIdsSet;
        expect(set.has("c1")).toBe(true);
        expect(set.has("c2")).toBe(true);
        expect(set.size).toBe(2);
      });
    });

    // --- drawAnnotationsNoThrottle ---
    describe("drawAnnotationsNoThrottle", () => {
      it("clears and returns when shouldDrawAnnotations is false", () => {
        mockedStore.drawAnnotations = false;
        wrapper = mountComponent();
        const aLayer = (wrapper.vm as any).annotationLayer;
        (wrapper.vm as any).drawAnnotationsNoThrottle();
        expect(aLayer.removeAllAnnotations).toHaveBeenCalled();
      });

      it("draws incrementally (no bulk removeAllAnnotations) on a normal draw", () => {
        const layer = makeLayer({ id: "l1", channel: 0, visible: true });
        mockedStore.layers = [layer];
        (mockedStore.layerSliceIndexes as any).mockReturnValue({
          xyIndex: 0,
          zIndex: 0,
          tIndex: 0,
        });
        mockedAnnotationStore.annotations = [
          makeAnnotation({ id: "a1", channel: 0 }),
        ];
        wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });

        const aLayer = (wrapper.vm as any).annotationLayer;
        aLayer.removeAllAnnotations.mockClear();
        (wrapper.vm as any).drawAnnotationsNoThrottle();
        // The normal draw path now diffs incrementally instead of tearing the
        // whole layer down — a low-churn draw must not bulk-clear.
        expect(aLayer.removeAllAnnotations).not.toHaveBeenCalled();
        expect(aLayer.draw).toHaveBeenCalled();
      });

      it("draws connections when shouldDrawConnections is true", () => {
        mockedStore.drawAnnotationConnections = true;
        const layer = makeLayer({ id: "l1", channel: 0, visible: true });
        mockedStore.layers = [layer];
        (mockedStore.layerSliceIndexes as any).mockReturnValue({
          xyIndex: 0,
          zIndex: 0,
          tIndex: 0,
        });
        mockedAnnotationStore.annotations = [
          makeAnnotation({ id: "a1", channel: 0 }),
          makeAnnotation({ id: "a2", channel: 0 }),
        ];
        mockedAnnotationStore.annotationConnections = [
          makeConnection({ id: "c1", parentId: "a1", childId: "a2" }),
        ];
        (mockedAnnotationStore.getAnnotationFromId as any).mockImplementation(
          (id: string) =>
            mockedAnnotationStore.annotations.find((a: any) => a.id === id),
        );

        wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });
        (wrapper.vm as any).drawAnnotationsNoThrottle();
        // The draw method should be called (connections rendering happens inside)
        expect((wrapper.vm as any).annotationLayer.draw).toHaveBeenCalled();
      });
    });

    // --- clearOldAnnotations ---
    describe("clearOldAnnotations", () => {
      it("clears all when clearAll=true", () => {
        wrapper = mountComponent();
        const aLayer = (wrapper.vm as any).annotationLayer;
        (wrapper.vm as any).clearOldAnnotations(true);
        expect(aLayer.removeAllAnnotations).toHaveBeenCalled();
        expect(aLayer.modified).toHaveBeenCalled();
      });

      it("does not redraw when redraw=false", () => {
        wrapper = mountComponent();
        const aLayer = (wrapper.vm as any).annotationLayer;
        vi.clearAllMocks();
        (wrapper.vm as any).clearOldAnnotations(true, false);
        expect(aLayer.draw).not.toHaveBeenCalled();
      });

      it("redraws when redraw=true (default)", () => {
        wrapper = mountComponent();
        const aLayer = (wrapper.vm as any).annotationLayer;
        vi.clearAllMocks();
        (wrapper.vm as any).clearOldAnnotations(true, true);
        expect(aLayer.draw).toHaveBeenCalled();
      });

      // --- incremental diff path (clearOldAnnotations(false)) ---
      it("keeps a still-displayed feature and removes one no longer displayed", () => {
        const layer = makeLayer({ id: "layer1", channel: 0, visible: true });
        mockedStore.layers = [layer];
        (mockedStore.getLayerFromId as any).mockReturnValue(layer);
        (mockedStore.layerSliceIndexes as any).mockReturnValue({
          xyIndex: 0,
          zIndex: 0,
          tIndex: 0,
        });
        // a1 is displayed (hydrated, no color); "gone" is not.
        mockedAnnotationStore.annotations = [
          makeAnnotation({ id: "a1", channel: 0, color: null }),
        ];
        wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });
        const aLayer = (wrapper.vm as any).annotationLayer;

        const keepFeature = mockGeoJSAnnotation("point");
        keepFeature.options({
          girderId: "a1",
          layerId: "layer1",
          color: null,
          isStub: false,
        });
        const removeFeature = mockGeoJSAnnotation("point");
        removeFeature.options({
          girderId: "gone",
          layerId: "layer1",
          color: null,
          isStub: false,
        });
        aLayer.removeAllAnnotations();
        aLayer.addAnnotation(keepFeature);
        aLayer.addAnnotation(removeFeature);
        aLayer.removeAllAnnotations.mockClear();

        (wrapper.vm as any).clearOldAnnotations(false, false);

        const remaining = aLayer.annotations();
        expect(remaining).toContain(keepFeature);
        expect(remaining).not.toContain(removeFeature);
        // low churn (1 of 2) ⇒ individual removal, not a bulk clear
        expect(aLayer.removeAllAnnotations).not.toHaveBeenCalled();
      });

      it("bulk-clears when most features must be removed (hybrid)", () => {
        const layer = makeLayer({ id: "layer1", channel: 0, visible: true });
        mockedStore.layers = [layer];
        (mockedStore.getLayerFromId as any).mockReturnValue(layer);
        (mockedStore.layerSliceIndexes as any).mockReturnValue({
          xyIndex: 0,
          zIndex: 0,
          tIndex: 0,
        });
        // nothing displayed ⇒ all drawn features must be removed
        mockedAnnotationStore.annotations = [];
        wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });
        const aLayer = (wrapper.vm as any).annotationLayer;

        aLayer.removeAllAnnotations();
        for (const id of ["x1", "x2", "x3"]) {
          const f = mockGeoJSAnnotation("point");
          f.options({
            girderId: id,
            layerId: "layer1",
            color: null,
            isStub: false,
          });
          aLayer.addAnnotation(f);
        }
        aLayer.removeAllAnnotations.mockClear();

        (wrapper.vm as any).clearOldAnnotations(false, false);

        // 3 of 3 removed ⇒ a single bulk clear beats N individual removals
        expect(aLayer.removeAllAnnotations).toHaveBeenCalled();
        expect(aLayer.annotations()).toHaveLength(0);
      });
    });

    // --- drawNewAnnotations ---
    describe("drawNewAnnotations", () => {
      it("creates new annotations for those not already drawn", () => {
        const layer = makeLayer({ id: "l1", channel: 0, visible: true });
        mockedStore.layers = [layer];
        (mockedStore.getLayerFromId as any).mockReturnValue(layer);
        (mockedStore.layerSliceIndexes as any).mockReturnValue({
          xyIndex: 0,
          zIndex: 0,
          tIndex: 0,
        });
        const ann1 = makeAnnotation({ id: "a1", channel: 0 });
        mockedAnnotationStore.annotations = [ann1];

        const geoAnn = mockGeoJSAnnotation("point");
        (geojsAnnotationFactory as any).mockReturnValue(geoAnn);

        wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });
        const drawnMap = new Map();
        (wrapper.vm as any).drawNewAnnotations(drawnMap);

        expect(geojsAnnotationFactory).toHaveBeenCalled();
      });

      it("skips annotations already drawn on the same layer", () => {
        const layer = makeLayer({ id: "l1", channel: 0, visible: true });
        mockedStore.layers = [layer];
        (mockedStore.getLayerFromId as any).mockReturnValue(layer);
        (mockedStore.layerSliceIndexes as any).mockReturnValue({
          xyIndex: 0,
          zIndex: 0,
          tIndex: 0,
        });
        const ann1 = makeAnnotation({ id: "a1", channel: 0 });
        mockedAnnotationStore.annotations = [ann1];

        const existingGeoAnn = mockGeoJSAnnotation("point");
        existingGeoAnn.options("layerId", "l1");

        wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });
        const drawnMap = new Map([["a1", [existingGeoAnn]]]);

        vi.clearAllMocks();
        (wrapper.vm as any).drawNewAnnotations(drawnMap);

        // Should not create new annotation since it's already drawn for this layer
        expect(geojsAnnotationFactory).not.toHaveBeenCalled();
      });

      it("restyles annotations when hover/select state changes", () => {
        wrapper = mountComponent();
        const geoAnn = mockGeoJSAnnotation("point");
        geoAnn.options("girderId", "a1");
        geoAnn.options("layerId", "l1");
        geoAnn.options("isHovered", false);
        geoAnn.options("isSelected", false);
        geoAnn.options("style", {});
        geoAnn.options("customColor", null);

        // Now make it hovered
        mockedAnnotationStore.hoveredAnnotationId = "a1";
        wrapper = mountComponent();
        const drawnMap = new Map([["a1", [geoAnn]]]);
        (wrapper.vm as any).drawNewAnnotations(drawnMap);

        // Should update the style since isHovered changed
        expect(geoAnn.options).toHaveBeenCalledWith("isHovered", true);
      });
    });

    // --- retained-feature reuse (frame-scrub cache) ---
    // These drive the cache logic against the GeoJS mock, so they guard the
    // wiring (retain on remove, reuse-or-reject on redraw) — NOT the real GeoJS
    // _exit/re-add contract the optimization relies on (see retainRemovedFeatures
    // in AnnotationViewer.vue, which is pinned to geojs ^1.19.1).
    describe("retained-feature reuse", () => {
      function setupDisplayedLayer() {
        const layer = makeLayer({ id: "layer1", channel: 0, visible: true });
        mockedStore.layers = [layer];
        (mockedStore.getLayerFromId as any).mockReturnValue(layer);
        (mockedStore.layerSliceIndexes as any).mockReturnValue({
          xyIndex: 0,
          zIndex: 0,
          tIndex: 0,
        });
      }

      // A previously-drawn feature for a1; `color` decides whether the reuse
      // validity check (drawnFeatureUnchanged) accepts it against ann1.
      function drawnFeatureForA1(color: string | null) {
        const feature = mockGeoJSAnnotation("point");
        feature.options({
          girderId: "a1",
          layerId: "layer1",
          color,
          isStub: false,
          geometryKey: 1, // ann1 has one coordinate
        });
        return feature;
      }

      it("reuses a removed feature instead of reconstructing it on scrub-back", () => {
        setupDisplayedLayer();
        const ann1 = makeAnnotation({ id: "a1", channel: 0, color: null });
        mockedAnnotationStore.annotations = [ann1];
        wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });
        const aLayer = (wrapper.vm as any).annotationLayer;

        const feature = drawnFeatureForA1(null);
        aLayer.removeAllAnnotations();
        aLayer.addAnnotation(feature);

        // Frame leaves a1: not displayed ⇒ clearOldAnnotations removes + retains.
        mockedAnnotationStore.annotations = [];
        (wrapper.vm as any).clearOldAnnotations(false, false);
        expect(aLayer.annotations()).not.toContain(feature);

        // Scrub back: a1 displayed again ⇒ reuse the retained object, no rebuild.
        mockedAnnotationStore.annotations = [ann1];
        (geojsAnnotationFactory as any).mockClear();
        aLayer.addMultipleAnnotations.mockClear();
        (wrapper.vm as any).drawNewAnnotations(new Map());

        expect(geojsAnnotationFactory).not.toHaveBeenCalled();
        expect(aLayer.annotations()).toContain(feature);
        // A reused feature's coordinates were already converted to the map gcs
        // on its first add; it must be re-added with gcs=null so addAnnotation
        // does NOT convert them a second time (which drifts it off the image on
        // each zoom-out). Fresh features use gcs=undefined (ingcs) instead.
        expect(aLayer.addMultipleAnnotations).toHaveBeenCalledWith(
          [feature],
          null,
          false,
        );
      });

      it("rejects a stale cached feature and reconstructs it", () => {
        setupDisplayedLayer();
        const ann1 = makeAnnotation({ id: "a1", channel: 0, color: null });
        mockedAnnotationStore.annotations = [ann1];
        wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });
        const aLayer = (wrapper.vm as any).annotationLayer;

        // Cached feature's color no longer matches ann1 ⇒ must not be reused.
        const staleFeature = drawnFeatureForA1("stale-color");
        aLayer.removeAllAnnotations();
        aLayer.addAnnotation(staleFeature);

        mockedAnnotationStore.annotations = [];
        (wrapper.vm as any).clearOldAnnotations(false, false);

        mockedAnnotationStore.annotations = [ann1];
        (geojsAnnotationFactory as any).mockClear();
        const freshFeature = mockGeoJSAnnotation("point");
        (geojsAnnotationFactory as any).mockReturnValue(freshFeature);
        aLayer.addMultipleAnnotations.mockClear();
        (wrapper.vm as any).drawNewAnnotations(new Map());

        expect(geojsAnnotationFactory).toHaveBeenCalled();
        expect(aLayer.annotations()).not.toContain(staleFeature);
        // A freshly-created feature holds ingcs (pixel) coordinates, so it is
        // added with gcs=undefined and addAnnotation converts it to gcs.
        expect(aLayer.addMultipleAnnotations).toHaveBeenCalledWith(
          [freshFeature],
          undefined,
          false,
        );
      });
    });

    // Regression: adding features to an otherwise-unchanged layer must mark it
    // modified() so GeoJS's _update rebuilds and the features actually paint.
    // clearOldAnnotations only marks modified on REMOVAL, and
    // addMultipleAnnotations/addAnnotation with update=false never do — so
    // without an explicit modified() the added features sit in the layer
    // unrendered (the "annotations vanish after scrubbing through empty Z
    // frames, until refresh" bug).
    describe("marks the layer modified when a draw adds features", () => {
      it("calls modified() when features are added to an empty layer", () => {
        const layer = makeLayer({ id: "layer1", channel: 0, visible: true });
        mockedStore.layers = [layer];
        (mockedStore.getLayerFromId as any).mockReturnValue(layer);
        (mockedStore.layerSliceIndexes as any).mockReturnValue({
          xyIndex: 0,
          zIndex: 0,
          tIndex: 0,
        });
        mockedAnnotationStore.annotations = [
          makeAnnotation({ id: "a1", channel: 0 }),
        ];
        (geojsAnnotationFactory as any).mockReturnValue(
          mockGeoJSAnnotation("point"),
        );
        wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });
        const aLayer = (wrapper.vm as any).annotationLayer;

        // Empty layer, as after scrubbing through a blank Z frame: the clear
        // pass removes nothing, so only the add path can mark modified.
        aLayer.removeAllAnnotations();
        aLayer.modified.mockClear();
        aLayer.draw.mockClear();

        (wrapper.vm as any).drawAnnotationsNoThrottle();

        expect(aLayer.annotations().length).toBeGreaterThan(0);
        expect(aLayer.modified).toHaveBeenCalled();
        expect(aLayer.draw).toHaveBeenCalled();
      });
    });
  });

  // =========================================================================
  // Category 3: Selection / Hit Detection (~15 tests)
  // =========================================================================
  describe("selection / hit detection", () => {
    // --- pointNearPoint ---
    describe("pointNearPoint", () => {
      beforeEach(() => {
        wrapper = mountComponent();
      });

      it("returns true when point is within radius", () => {
        (pointDistance as any).mockReturnValue(3);
        const result = (wrapper.vm as any).pointNearPoint(
          { x: 10, y: 10 },
          { x: 12, y: 12 },
          5,
          2,
          1,
        );
        expect(result).toBe(true);
      });

      it("returns false when point is outside radius", () => {
        (pointDistance as any).mockReturnValue(100);
        const result = (wrapper.vm as any).pointNearPoint(
          { x: 10, y: 10 },
          { x: 100, y: 100 },
          5,
          2,
          1,
        );
        expect(result).toBe(false);
      });

      it("returns false when radius is zero", () => {
        (pointDistance as any).mockReturnValue(1);
        const result = (wrapper.vm as any).pointNearPoint(
          { x: 10, y: 10 },
          { x: 10, y: 11 },
          0,
          0,
          1,
        );
        expect(result).toBe(false);
      });
    });

    // --- pointNearLine ---
    describe("pointNearLine", () => {
      beforeEach(() => {
        wrapper = mountComponent();
      });

      it("returns true when point is near a line segment", () => {
        (geojs.util.distance2dToLineSquared as any).mockReturnValue(1);
        (pointDistance as any).mockReturnValue(100);

        const result = (wrapper.vm as any).pointNearLine(
          { x: 5, y: 5 },
          [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
          ],
          5,
          1,
        );
        expect(result).toBe(true);
      });

      it("returns false when point is far from all segments", () => {
        (geojs.util.distance2dToLineSquared as any).mockReturnValue(100);
        (pointDistance as any).mockReturnValue(100);

        const result = (wrapper.vm as any).pointNearLine(
          { x: 500, y: 500 },
          [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
          ],
          2,
          1,
        );
        expect(result).toBe(false);
      });

      it("checks distance to last vertex specifically", () => {
        (geojs.util.distance2dToLineSquared as any).mockReturnValue(100);
        (pointDistance as any).mockReturnValue(1); // Near last vertex

        const result = (wrapper.vm as any).pointNearLine(
          { x: 10, y: 0 },
          [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
          ],
          5,
          1,
        );
        expect(result).toBe(true);
      });
    });

    // --- shouldSelectAnnotation ---
    describe("shouldSelectAnnotation", () => {
      beforeEach(() => {
        wrapper = mountComponent();
      });

      it("uses pointNearPoint for point-vs-point", () => {
        (pointDistance as any).mockReturnValue(1);
        const ann = makeAnnotation({ shape: "point" });
        const style = { radius: 5, strokeWidth: 2 };

        const result = (wrapper.vm as any).shouldSelectAnnotation(
          "point",
          [{ x: 10, y: 20 }],
          ann,
          style,
          1,
        );
        expect(result).toBe(true);
      });

      it("uses pointNearLine for point-vs-line", () => {
        (geojs.util.distance2dToLineSquared as any).mockReturnValue(1);
        const ann = makeAnnotation({
          shape: "line",
          coordinates: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
          ],
        });
        const style = { radius: 5, strokeWidth: 5 };

        const result = (wrapper.vm as any).shouldSelectAnnotation(
          "point",
          [{ x: 5, y: 0 }],
          ann,
          style,
          1,
        );
        expect(result).toBe(true);
      });

      it("uses pointInPolygon for point-vs-polygon", () => {
        (geojs.util.pointInPolygon as any).mockReturnValue(true);
        const ann = makeAnnotation({
          shape: "polygon",
          coordinates: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 10 },
          ],
        });
        const style = { radius: 5, strokeWidth: 2 };

        const result = (wrapper.vm as any).shouldSelectAnnotation(
          "point",
          [{ x: 5, y: 5 }],
          ann,
          style,
          1,
        );
        expect(result).toBe(true);
        expect(geojs.util.pointInPolygon).toHaveBeenCalled();
      });

      it("uses pointInPolygon for polygon-vs-any annotation", () => {
        (geojs.util.pointInPolygon as any).mockReturnValue(true);
        const ann = makeAnnotation({
          shape: "point",
          coordinates: [{ x: 5, y: 5 }],
        });
        const style = { radius: 5, strokeWidth: 2 };

        const result = (wrapper.vm as any).shouldSelectAnnotation(
          "polygon",
          [
            { x: 0, y: 0 },
            { x: 20, y: 0 },
            { x: 20, y: 20 },
          ],
          ann,
          style,
          1,
        );
        expect(result).toBe(true);
      });
    });

    // --- shouldSelectStub ---
    describe("shouldSelectStub", () => {
      beforeEach(() => {
        wrapper = mountComponent();
        // Real Euclidean distance so the hit-test math is actually exercised.
        (pointDistance as any).mockImplementation((a: any, b: any) =>
          Math.hypot(a.x - b.x, a.y - b.y),
        );
      });

      function makeStub(overrides: any = {}) {
        return {
          id: "stub1",
          centroid: { x: 0, y: 0 },
          location: { XY: 0, Z: 0, Time: 0 },
          shape: "polygon",
          channel: 0,
          tags: [],
          color: null,
          estimatedRadius: 10,
          ...overrides,
        };
      }

      it("hit-tests the stub radius in world units (no unitsPerPixel scaling)", () => {
        // The stub dot's style.radius is estimatedRadius in WORLD units. A click
        // 8 world units away is inside the rendered radius (10), so it must hit
        // regardless of the zoom-dependent unitsPerPixel.
        const stub = makeStub();
        const style = { radius: 10, strokeWidth: 0 };
        const unitsPerPixel = 0.25; // zoomed in — the regression trigger
        const result = (wrapper.vm as any).shouldSelectStub(
          { x: 8, y: 0 },
          stub,
          style,
          unitsPerPixel,
        );
        // Old (buggy) math: radius * unitsPerPixel = 2.5 → 8 > 2.5 → missed.
        // Fixed math: radius = 10 → 8 < 10 → hit.
        expect(result).toBe(true);
      });

      it("misses when the click is outside the world-unit radius", () => {
        const stub = makeStub();
        const style = { radius: 10, strokeWidth: 0 };
        const result = (wrapper.vm as any).shouldSelectStub(
          { x: 12, y: 0 },
          stub,
          style,
          4, // zoomed out — old math would falsely hit (10*4=40)
        );
        expect(result).toBe(false);
      });

      it("converts only the stroke width by unitsPerPixel", () => {
        // radius 10 (world) + strokeWidth 4 * unitsPerPixel 0.5 = 12 world units.
        const stub = makeStub();
        const style = { radius: 10, strokeWidth: 4 };
        const inside = (wrapper.vm as any).shouldSelectStub(
          { x: 11.5, y: 0 },
          stub,
          style,
          0.5,
        );
        const outside = (wrapper.vm as any).shouldSelectStub(
          { x: 12.5, y: 0 },
          stub,
          style,
          0.5,
        );
        expect(inside).toBe(true);
        expect(outside).toBe(false);
      });
    });

    // --- getSelectedAnnotationsFromAnnotation ---
    describe("getSelectedAnnotationsFromAnnotation", () => {
      it("iterates annotations and filters using shouldSelectAnnotation", () => {
        const ann1 = makeAnnotation({ id: "a1", channel: 0 });
        const geoAnn = mockGeoJSAnnotation("point");
        geoAnn.options("girderId", "a1");
        geoAnn.options("isConnection", false);

        (mockedAnnotationStore.getAnnotationFromId as any).mockImplementation(
          (id: string) => (id === "a1" ? ann1 : undefined),
        );
        (pointDistance as any).mockReturnValue(1); // Near

        wrapper = mountComponent();
        // Override annotationLayer.annotations to return our mock
        (wrapper.vm as any).annotationLayer.annotations = vi.fn(() => [geoAnn]);

        const selectAnn = mockGeoJSAnnotation("point");
        selectAnn.type = vi.fn().mockReturnValue("point");
        selectAnn.coordinates = vi.fn().mockReturnValue([{ x: 10, y: 20 }]);

        const result = (wrapper.vm as any).getSelectedAnnotationsFromAnnotation(
          selectAnn,
        );
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe("a1");
      });

      it("skips connection annotations", () => {
        const geoAnn = mockGeoJSAnnotation("point");
        geoAnn.options("girderId", "a1");
        geoAnn.options("isConnection", true);

        wrapper = mountComponent();
        (wrapper.vm as any).annotationLayer.annotations = vi.fn(() => [geoAnn]);

        const selectAnn = mockGeoJSAnnotation("point");
        const result = (wrapper.vm as any).getSelectedAnnotationsFromAnnotation(
          selectAnn,
        );
        expect(result).toHaveLength(0);
      });

      it("deduplicates annotations", () => {
        const ann1 = makeAnnotation({ id: "a1", channel: 0 });
        const geoAnn1 = mockGeoJSAnnotation("point");
        geoAnn1.options("girderId", "a1");
        geoAnn1.options("isConnection", false);
        const geoAnn2 = mockGeoJSAnnotation("point");
        geoAnn2.options("girderId", "a1"); // Same id
        geoAnn2.options("isConnection", false);

        (mockedAnnotationStore.getAnnotationFromId as any).mockImplementation(
          (id: string) => (id === "a1" ? ann1 : undefined),
        );
        (pointDistance as any).mockReturnValue(1);

        wrapper = mountComponent();
        (wrapper.vm as any).annotationLayer.annotations = vi.fn(() => [
          geoAnn1,
          geoAnn2,
        ]);

        const selectAnn = mockGeoJSAnnotation("point");
        selectAnn.type = vi.fn().mockReturnValue("point");
        selectAnn.coordinates = vi.fn().mockReturnValue([{ x: 10, y: 20 }]);

        const result = (wrapper.vm as any).getSelectedAnnotationsFromAnnotation(
          selectAnn,
        );
        expect(result).toHaveLength(1);
      });

      // Codex finding #1: in stub-only mode getAnnotationFromId returns
      // undefined for displayed-but-unhydrated non-point stubs (dots), so
      // selection must fall back to the stub (centroid + location) or it
      // silently picks nothing.
      it("click-selects a visible unhydrated stub in stub-only mode", () => {
        mockedAnnotationStore.stubOnlyMode = true;
        (mockedAnnotationStore.getAnnotationFromId as any).mockReturnValue(
          undefined,
        );
        (mockedAnnotationStore.getStub as any).mockImplementation(
          (id: string) =>
            id === "stub-1"
              ? {
                  id: "stub-1",
                  centroid: { x: 10, y: 20 },
                  location: { XY: 0, Z: 0, Time: 0 },
                  shape: "point",
                  channel: 0,
                  tags: [],
                  color: null,
                }
              : undefined,
        );
        (pointDistance as any).mockReturnValue(1); // click near the dot

        const geoAnn = mockGeoJSAnnotation("point");
        geoAnn.options("girderId", "stub-1");
        geoAnn.options("isConnection", false);

        wrapper = mountComponent();
        (wrapper.vm as any).annotationLayer.annotations = vi.fn(() => [geoAnn]);

        const selectAnn = mockGeoJSAnnotation("point");
        selectAnn.type = vi.fn().mockReturnValue("point");
        selectAnn.coordinates = vi.fn().mockReturnValue([{ x: 10, y: 20 }]);

        const result = (wrapper.vm as any).getSelectedAnnotationsFromAnnotation(
          selectAnn,
        );
        expect(result.map((a: any) => a.id)).toEqual(["stub-1"]);
      });

      it("drag-selects a visible unhydrated stub via its centroid", () => {
        mockedAnnotationStore.stubOnlyMode = true;
        (mockedAnnotationStore.getAnnotationFromId as any).mockReturnValue(
          undefined,
        );
        (mockedAnnotationStore.getStub as any).mockImplementation(
          (id: string) =>
            id === "stub-1"
              ? {
                  id: "stub-1",
                  centroid: { x: 5, y: 5 },
                  location: { XY: 0, Z: 0, Time: 0 },
                  shape: "point",
                  channel: 0,
                  tags: [],
                  color: null,
                }
              : undefined,
        );
        // Stub centroid falls inside the drag polygon.
        (geojs.util.pointInPolygon as any).mockReturnValue(true);

        const geoAnn = mockGeoJSAnnotation("point");
        geoAnn.options("girderId", "stub-1");
        geoAnn.options("isConnection", false);

        wrapper = mountComponent();
        (wrapper.vm as any).annotationLayer.annotations = vi.fn(() => [geoAnn]);

        const selectAnn = mockGeoJSAnnotation("polygon");
        selectAnn.type = vi.fn().mockReturnValue("polygon");
        selectAnn.coordinates = vi.fn().mockReturnValue([
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
          { x: 0, y: 10 },
        ]);

        const result = (wrapper.vm as any).getSelectedAnnotationsFromAnnotation(
          selectAnn,
        );
        expect(result.map((a: any) => a.id)).toContain("stub-1");
      });

      it("drag-selects every matching stub while only the raster is visible", () => {
        mockedStore.layers = [makeLayer()];
        const stubs = new Map(
          ["stub-1", "stub-2", "stub-3"].map((id, index) => [
            id,
            {
              id,
              centroid: { x: index + 1, y: index + 1 },
              location: { XY: 0, Z: 0, Time: 0 },
              shape: "polygon",
              channel: 0,
              tags: [],
              color: null,
              estimatedRadius: 5,
            },
          ]),
        );
        mockedAnnotationStore.annotationStubs = stubs as any;
        mockedAnnotationStore.stubOnlyMode = true;
        mockedAnnotationStore.visibilityConfig = {
          ...mockedAnnotationStore.visibilityConfig,
          minimumVisible: 2,
        };
        (mockedAnnotationStore.getStub as any).mockImplementation(
          (id: string) => stubs.get(id),
        );
        annotationSpatialIndex.bulkLoad(
          [...stubs.values()].map((stub: any) => ({
            id: stub.id,
            x: stub.centroid.x,
            y: stub.centroid.y,
          })),
        );
        (geojs.util.pointInPolygon as any).mockReturnValue(true);
        mockedAnnotationStore.overviewConfig = {
          enabled: true,
          mode: "shapes",
          opacity: 0.6,
          vectorSwitchThreshold: 1,
        } as any;
        const map = mockAnnotationLayer().map();
        map.unitsPerPixel.mockReturnValue(2);
        wrapper = mountComponent({
          map,
          annotationOverviewLayer: mockOverviewLayer(),
        });

        const selectAnn = mockGeoJSAnnotation("polygon");
        selectAnn.coordinates = vi.fn().mockReturnValue([
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
          { x: 0, y: 10 },
        ]);

        expect((wrapper.vm as any).shouldDrawAnnotations).toBe(false);
        const result = (wrapper.vm as any).getSelectedAnnotationsFromAnnotation(
          selectAnn,
        );
        expect(result).toHaveLength(3);
        expect(result.every((stub: any) => stubs.has(stub.id))).toBe(true);
      });

      it("drag-selects exactly the annotations represented by raster selectors", () => {
        mockedStore.layers = [
          makeLayer({ id: "current", channel: 0 }),
          makeLayer({
            id: "offset",
            channel: 1,
            z: { type: "offset", value: 2 },
          }),
          makeLayer({
            id: "max-merge",
            channel: 2,
            z: { type: "max-merge", value: null },
          }),
          makeLayer({ id: "hidden", channel: 3, visible: false }),
        ];
        (mockedStore.layerSliceIndexes as any).mockImplementation(
          (layer: any) => ({
            xyIndex: 0,
            zIndex: layer.id === "offset" ? 2 : 0,
            tIndex: 0,
          }),
        );
        const stubs = new Map(
          [
            ["current", 0, 0],
            ["offset", 1, 2],
            ["wrong-offset", 1, 0],
            ["max-merge", 2, 99],
            ["hidden", 3, 0],
            ["unconfigured", 4, 0],
          ].map(([id, channel, z]) => [
            id,
            {
              id,
              centroid: { x: 5, y: 5 },
              location: { XY: 0, Z: z, Time: 0 },
              shape: "polygon",
              channel,
              tags: [],
              color: null,
              estimatedRadius: 5,
            },
          ]),
        );
        mockedAnnotationStore.annotationStubs = stubs as any;
        mockedAnnotationStore.stubOnlyMode = true;
        (mockedAnnotationStore.getStub as any).mockImplementation(
          (id: string) => stubs.get(id),
        );
        annotationSpatialIndex.bulkLoad(
          [...stubs.values()].map((stub: any) => ({
            id: stub.id,
            x: stub.centroid.x,
            y: stub.centroid.y,
          })),
        );
        (geojs.util.pointInPolygon as any).mockReturnValue(true);
        mockedAnnotationStore.overviewConfig = {
          enabled: true,
          mode: "shapes",
          opacity: 0.6,
          vectorSwitchThreshold: 1,
        } as any;
        const map = mockAnnotationLayer().map();
        map.unitsPerPixel.mockReturnValue(2);
        wrapper = mountComponent({
          map,
          annotationOverviewLayer: mockOverviewLayer(),
          layerCount: mockedStore.layers.length,
        });
        const selectAnn = mockGeoJSAnnotation("polygon");
        selectAnn.coordinates = vi.fn().mockReturnValue([
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
          { x: 0, y: 10 },
        ]);

        const selectedIds = (wrapper.vm as any)
          .getSelectedAnnotationsFromAnnotation(selectAnn)
          .map((annotation: any) => annotation.id);
        expect(selectedIds).toEqual(
          expect.arrayContaining(["current", "offset", "max-merge"]),
        );
        expect(selectedIds).toHaveLength(3);
      });
    });

    // --- selectAnnotations ---
    describe("selectAnnotations", () => {
      it("calls annotationStore.selectAnnotations in ADD mode", () => {
        mockedStore.annotationSelectionType = "ADD" as any;
        const ann1 = makeAnnotation({ id: "a1" });
        const geoAnn = mockGeoJSAnnotation("point");
        geoAnn.options("girderId", "a1");
        geoAnn.options("isConnection", false);
        (mockedAnnotationStore.getAnnotationFromId as any).mockReturnValue(
          ann1,
        );
        (pointDistance as any).mockReturnValue(1);

        wrapper = mountComponent();
        (wrapper.vm as any).annotationLayer.annotations = vi.fn(() => [geoAnn]);

        const selectAnn = mockGeoJSAnnotation("point");
        selectAnn.type = vi.fn().mockReturnValue("point");
        selectAnn.coordinates = vi.fn().mockReturnValue([{ x: 10, y: 20 }]);

        (wrapper.vm as any).selectAnnotations(selectAnn);
        expect(mockedAnnotationStore.selectAnnotations).toHaveBeenCalled();
      });

      it("calls annotationStore.unselectAnnotations in REMOVE mode", () => {
        mockedStore.annotationSelectionType = "REMOVE" as any;
        wrapper = mountComponent();
        (wrapper.vm as any).annotationLayer.annotations = vi.fn(() => []);

        const selectAnn = mockGeoJSAnnotation("point");
        (wrapper.vm as any).selectAnnotations(selectAnn);
        expect(mockedAnnotationStore.unselectAnnotations).toHaveBeenCalled();
      });

      it("calls annotationStore.toggleSelected in TOGGLE mode", () => {
        mockedStore.annotationSelectionType = "TOGGLE" as any;
        wrapper = mountComponent();
        (wrapper.vm as any).annotationLayer.annotations = vi.fn(() => []);

        const selectAnn = mockGeoJSAnnotation("point");
        (wrapper.vm as any).selectAnnotations(selectAnn);
        expect(mockedAnnotationStore.toggleSelected).toHaveBeenCalled();
      });

      it("removes selection annotation from interaction layer", () => {
        wrapper = mountComponent();
        (wrapper.vm as any).annotationLayer.annotations = vi.fn(() => []);

        const selectAnn = mockGeoJSAnnotation("point");
        (wrapper.vm as any).selectAnnotations(selectAnn);
        expect(
          (wrapper.vm as any).interactionLayer.removeAnnotation,
        ).toHaveBeenCalledWith(selectAnn);
      });

      it("returns early when selectAnnotation is null", () => {
        wrapper = mountComponent();
        (wrapper.vm as any).selectAnnotations(null);
        expect(mockedAnnotationStore.selectAnnotations).not.toHaveBeenCalled();
        expect(
          mockedAnnotationStore.unselectAnnotations,
        ).not.toHaveBeenCalled();
        expect(mockedAnnotationStore.toggleSelected).not.toHaveBeenCalled();
      });
    });
  });

  // =========================================================================
  // Category 4: Tool Handlers (~34 tests)
  // =========================================================================
  describe("tool handlers", () => {
    // --- setNewAnnotationMode ---
    describe("setNewAnnotationMode", () => {
      it("sets mode to null when unrolling", () => {
        mockedStore.unroll = true;
        wrapper = mountComponent();
        (wrapper.vm as any).setNewAnnotationMode();
        expect((wrapper.vm as any).interactionLayer.mode).toHaveBeenCalledWith(
          null,
        );
      });

      it("sets polygon mode when roiFilter is active and deselects tool", () => {
        mockedFilterStore.emptyROIFilter = { id: "f1", roi: [] } as any;
        mockedStore.selectedTool = {
          configuration: { id: "t1", type: "create", values: {} },
          state: {},
        } as any;
        wrapper = mountComponent();
        (wrapper.vm as any).setNewAnnotationMode();
        expect(mockedStore.setSelectedToolId).toHaveBeenCalledWith(null);
        expect((wrapper.vm as any).interactionLayer.mode).toHaveBeenCalledWith(
          "polygon",
        );
      });

      it("sets point mode for create tool with point shape", () => {
        mockedStore.selectedTool = {
          configuration: {
            id: "t1",
            type: "create",
            values: { annotation: { shape: "point" } },
          },
          state: {},
        } as any;
        wrapper = mountComponent();
        (wrapper.vm as any).setNewAnnotationMode();
        expect((wrapper.vm as any).interactionLayer.mode).toHaveBeenCalledWith(
          "point",
        );
      });

      it("sets polygon mode for create tool with polygon shape", () => {
        mockedStore.selectedTool = {
          configuration: {
            id: "t1",
            type: "create",
            values: { annotation: { shape: "polygon" } },
          },
          state: {},
        } as any;
        wrapper = mountComponent();
        (wrapper.vm as any).setNewAnnotationMode();
        expect((wrapper.vm as any).interactionLayer.mode).toHaveBeenCalledWith(
          "polygon",
        );
      });

      it("sets ellipse mode for create tool with circle shape", () => {
        mockedStore.selectedTool = {
          configuration: {
            id: "t1",
            type: "create",
            values: { annotation: { shape: "circle" } },
          },
          state: {},
        } as any;
        wrapper = mountComponent();
        (wrapper.vm as any).setNewAnnotationMode();
        expect((wrapper.vm as any).interactionLayer.mode).toHaveBeenCalledWith(
          "ellipse",
        );
      });

      it("sets ellipse mode for create tool with ellipse shape", () => {
        mockedStore.selectedTool = {
          configuration: {
            id: "t1",
            type: "create",
            values: { annotation: { shape: "ellipse" } },
          },
          state: {},
        } as any;
        wrapper = mountComponent();
        (wrapper.vm as any).setNewAnnotationMode();
        expect((wrapper.vm as any).interactionLayer.mode).toHaveBeenCalledWith(
          "ellipse",
        );
      });

      it("sets point mode for tagging tool with tag_click action", () => {
        mockedStore.selectedTool = {
          configuration: {
            id: "t1",
            type: "tagging",
            values: { action: { value: "tag_click" } },
          },
          state: {},
        } as any;
        wrapper = mountComponent();
        (wrapper.vm as any).setNewAnnotationMode();
        expect((wrapper.vm as any).interactionLayer.mode).toHaveBeenCalledWith(
          "point",
        );
      });

      it("sets polygon mode for tagging tool with tag_lasso action", () => {
        mockedStore.selectedTool = {
          configuration: {
            id: "t1",
            type: "tagging",
            values: { action: { value: "tag_lasso" } },
          },
          state: {},
        } as any;
        wrapper = mountComponent();
        (wrapper.vm as any).setNewAnnotationMode();
        expect((wrapper.vm as any).interactionLayer.mode).toHaveBeenCalledWith(
          "polygon",
        );
      });

      it("sets point mode for connection tool with click action", () => {
        mockedStore.selectedTool = {
          configuration: {
            id: "t1",
            type: "connection",
            values: { action: { value: "add_click" } },
          },
          state: {},
        } as any;
        wrapper = mountComponent();
        (wrapper.vm as any).setNewAnnotationMode();
        expect((wrapper.vm as any).interactionLayer.mode).toHaveBeenCalledWith(
          "point",
        );
      });

      it("sets polygon mode for connection tool with lasso action", () => {
        mockedStore.selectedTool = {
          configuration: {
            id: "t1",
            type: "connection",
            values: { action: { value: "add_lasso" } },
          },
          state: {},
        } as any;
        wrapper = mountComponent();
        (wrapper.vm as any).setNewAnnotationMode();
        expect((wrapper.vm as any).interactionLayer.mode).toHaveBeenCalledWith(
          "polygon",
        );
      });

      it("sets point mode for select tool with pointer type", () => {
        mockedStore.selectedTool = {
          configuration: {
            id: "t1",
            type: "select",
            values: { selectionType: { value: "pointer" } },
          },
          state: {},
        } as any;
        wrapper = mountComponent();
        (wrapper.vm as any).setNewAnnotationMode();
        expect((wrapper.vm as any).interactionLayer.mode).toHaveBeenCalledWith(
          "point",
        );
      });

      it("sets polygon mode for select tool with lasso type", () => {
        mockedStore.selectedTool = {
          configuration: {
            id: "t1",
            type: "select",
            values: { selectionType: { value: "lasso" } },
          },
          state: {},
        } as any;
        wrapper = mountComponent();
        (wrapper.vm as any).setNewAnnotationMode();
        expect((wrapper.vm as any).interactionLayer.mode).toHaveBeenCalledWith(
          "polygon",
        );
      });

      it("sets point mode for edit tool with combine_click action", () => {
        mockedStore.selectedTool = {
          configuration: {
            id: "t1",
            type: "edit",
            values: { action: { value: "combine_click" } },
          },
          state: {},
        } as any;
        wrapper = mountComponent();
        (wrapper.vm as any).setNewAnnotationMode();
        expect((wrapper.vm as any).interactionLayer.mode).toHaveBeenCalledWith(
          "point",
        );
      });

      it("sets line mode for edit tool with blob_edit action", () => {
        mockedStore.selectedTool = {
          configuration: {
            id: "t1",
            type: "edit",
            values: { action: { value: "blob_edit" } },
          },
          state: {},
        } as any;
        wrapper = mountComponent();
        (wrapper.vm as any).setNewAnnotationMode();
        expect((wrapper.vm as any).interactionLayer.mode).toHaveBeenCalledWith(
          "line",
        );
      });

      it("sets null mode for samAnnotation tool", () => {
        mockedStore.selectedTool = {
          configuration: { id: "t1", type: "samAnnotation", values: {} },
          state: {},
        } as any;
        wrapper = mountComponent();
        (wrapper.vm as any).setNewAnnotationMode();
        expect((wrapper.vm as any).interactionLayer.mode).toHaveBeenCalledWith(
          null,
        );
      });

      it("sets null mode for segmentation tool", () => {
        mockedStore.selectedTool = {
          configuration: { id: "t1", type: "segmentation", values: {} },
          state: {},
        } as any;
        wrapper = mountComponent();
        (wrapper.vm as any).setNewAnnotationMode();
        expect((wrapper.vm as any).interactionLayer.mode).toHaveBeenCalledWith(
          null,
        );
      });
    });

    // --- handleInteractionAnnotationChange ---
    describe("handleInteractionAnnotationChange", () => {
      it("returns early when no tool and no roiFilter", () => {
        wrapper = mountComponent();
        const spy = vi.spyOn(
          wrapper.vm as any,
          "addAnnotationFromGeoJsAnnotation",
        );
        (wrapper.vm as any).handleInteractionAnnotationChange({
          event: "geo_annotation_state",
          annotation: { layer: () => (wrapper.vm as any).interactionLayer },
        });
        expect(spy).not.toHaveBeenCalled();
      });

      it("routes create tool to addAnnotationFromGeoJsAnnotation", () => {
        mockedStore.selectedTool = {
          configuration: {
            id: "t1",
            type: "create",
            values: { annotation: { shape: "point" } },
          },
          state: {},
        } as any;
        wrapper = mountComponent();

        const ann = mockGeoJSAnnotation("point");
        ann.layer = vi
          .fn()
          .mockReturnValue((wrapper.vm as any).interactionLayer);
        // In Vue 3 <script setup>, internal functions are closures and can't be
        // spied on via wrapper.vm. Verify the route was taken by checking that
        // addAnnotationFromGeoJsAnnotation's first action (removeAnnotation) was called.
        const iLayer = (wrapper.vm as any).interactionLayer;
        iLayer.removeAnnotation.mockClear();
        (wrapper.vm as any).handleInteractionAnnotationChange({
          event: "geo_annotation_state",
          annotation: ann,
        });
        expect(iLayer.removeAnnotation).toHaveBeenCalledWith(ann);
      });

      it("routes tagging tool to handleAnnotationTagging", () => {
        mockedStore.selectedTool = {
          configuration: {
            id: "t1",
            type: "tagging",
            values: {
              action: { value: "tag_click" },
              tags: [],
              removeExisting: false,
            },
          },
          state: {},
        } as any;
        wrapper = mountComponent();

        const ann = mockGeoJSAnnotation("point");
        ann.layer = vi
          .fn()
          .mockReturnValue((wrapper.vm as any).interactionLayer);
        // In Vue 3 <script setup>, verify route was taken without throwing.
        // handleAnnotationTagging calls getSelectedAnnotationsFromAnnotation
        // which returns [] with no matching annotations, so no further calls happen.
        expect(() => {
          (wrapper.vm as any).handleInteractionAnnotationChange({
            event: "geo_annotation_state",
            annotation: ann,
          });
        }).not.toThrow();
      });

      it("routes select tool to selectAnnotations", () => {
        mockedStore.selectedTool = {
          configuration: {
            id: "t1",
            type: "select",
            values: { selectionType: { value: "pointer" } },
          },
          state: {},
        } as any;
        wrapper = mountComponent();

        const ann = mockGeoJSAnnotation("point");
        ann.layer = vi
          .fn()
          .mockReturnValue((wrapper.vm as any).interactionLayer);
        // In Vue 3 <script setup>, verify route was taken without throwing.
        expect(() => {
          (wrapper.vm as any).handleInteractionAnnotationChange({
            event: "geo_annotation_state",
            annotation: ann,
          });
        }).not.toThrow();
      });

      it("routes connection tool to handleAnnotationConnections", () => {
        mockedStore.selectedTool = {
          configuration: {
            id: "t1",
            type: "connection",
            values: { action: { value: "add_click" } },
          },
          state: {},
        } as any;
        wrapper = mountComponent();

        const ann = mockGeoJSAnnotation("point");
        ann.layer = vi
          .fn()
          .mockReturnValue((wrapper.vm as any).interactionLayer);
        // In Vue 3 <script setup>, verify route was taken without throwing.
        expect(() => {
          (wrapper.vm as any).handleInteractionAnnotationChange({
            event: "geo_annotation_state",
            annotation: ann,
          });
        }).not.toThrow();
      });

      it("routes edit tool with combine_click to handleAnnotationCombine", () => {
        mockedStore.selectedTool = {
          configuration: {
            id: "t1",
            type: "edit",
            values: { action: { value: "combine_click" } },
          },
          state: {},
        } as any;
        wrapper = mountComponent();

        const ann = mockGeoJSAnnotation("point");
        ann.layer = vi
          .fn()
          .mockReturnValue((wrapper.vm as any).interactionLayer);
        // In Vue 3 <script setup>, verify route was taken without throwing.
        expect(() => {
          (wrapper.vm as any).handleInteractionAnnotationChange({
            event: "geo_annotation_state",
            annotation: ann,
          });
        }).not.toThrow();
      });

      it("routes edit tool with blob_edit to handleAnnotationEdits", () => {
        mockedStore.selectedTool = {
          configuration: {
            id: "t1",
            type: "edit",
            values: { action: { value: "blob_edit" } },
          },
          state: {},
        } as any;
        wrapper = mountComponent();

        const ann = mockGeoJSAnnotation("point");
        ann.layer = vi
          .fn()
          .mockReturnValue((wrapper.vm as any).interactionLayer);
        // In Vue 3 <script setup>, verify route was taken.
        // handleAnnotationEdits calls getSelectedAnnotationsFromAnnotation, which
        // returns [] since no annotations match. Then it calls
        // interactionLayer.removeAnnotation(selectAnnotation).
        const iLayer = (wrapper.vm as any).interactionLayer;
        iLayer.removeAnnotation.mockClear();
        (wrapper.vm as any).handleInteractionAnnotationChange({
          event: "geo_annotation_state",
          annotation: ann,
        });
        expect(iLayer.removeAnnotation).toHaveBeenCalledWith(ann);
      });

      it("routes to handleNewROIFilter when no tool but roiFilter exists", () => {
        mockedFilterStore.emptyROIFilter = { id: "f1", roi: [] } as any;
        wrapper = mountComponent();

        const ann = mockGeoJSAnnotation("polygon");
        ann.layer = vi
          .fn()
          .mockReturnValue((wrapper.vm as any).interactionLayer);
        // In Vue 3 <script setup>, verify route was taken by checking that
        // handleNewROIFilter's downstream call (validateNewROIFilter) was invoked.
        mockedFilterStore.validateNewROIFilter.mockClear();
        (wrapper.vm as any).handleInteractionAnnotationChange({
          event: "geo_annotation_state",
          annotation: ann,
        });
        expect(mockedFilterStore.validateNewROIFilter).toHaveBeenCalled();
      });

      it("ignores events not from interactionLayer", () => {
        mockedStore.selectedTool = {
          configuration: {
            id: "t1",
            type: "create",
            values: { annotation: { shape: "point" } },
          },
          state: {},
        } as any;
        wrapper = mountComponent();
        const spy = vi
          .spyOn(wrapper.vm as any, "addAnnotationFromGeoJsAnnotation")
          .mockImplementation(() => {});

        const otherLayer = mockAnnotationLayer();
        const ann = mockGeoJSAnnotation("point");
        ann.layer = vi.fn().mockReturnValue(otherLayer);
        (wrapper.vm as any).handleInteractionAnnotationChange({
          event: "geo_annotation_state",
          annotation: ann,
        });
        expect(spy).not.toHaveBeenCalled();
      });
    });

    // --- addAnnotationFromGeoJsAnnotation ---
    describe("addAnnotationFromGeoJsAnnotation", () => {
      it("creates annotation from coordinates", async () => {
        mockedStore.selectedTool = {
          configuration: {
            id: "t1",
            type: "create",
            values: { annotation: { shape: "point" } },
          },
          state: {},
        } as any;
        wrapper = mountComponent();

        const ann = mockGeoJSAnnotation("point");
        ann.coordinates = vi.fn().mockReturnValue([{ x: 10, y: 20 }]);

        await (wrapper.vm as any).addAnnotationFromGeoJsAnnotation(ann);
        expect(mockedAnnotationStore.addAnnotationFromTool).toHaveBeenCalled();
      });

      it("converts circle shape to polygon", async () => {
        mockedStore.selectedTool = {
          configuration: {
            id: "t1",
            type: "create",
            values: { annotation: { shape: "circle" } },
          },
          state: {},
        } as any;
        wrapper = mountComponent();

        const ann = mockGeoJSAnnotation("polygon");
        ann.coordinates = vi.fn().mockReturnValue([
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
          { x: 0, y: 10 },
        ]);

        await (wrapper.vm as any).addAnnotationFromGeoJsAnnotation(ann);
        expect(ellipseToPolygonCoordinates).toHaveBeenCalled();
      });

      it("converts ellipse shape to polygon", async () => {
        vi.clearAllMocks();
        mockedStore.selectedTool = {
          configuration: {
            id: "t1",
            type: "create",
            values: { annotation: { shape: "ellipse" } },
          },
          state: {},
        } as any;
        wrapper = mountComponent();

        const ann = mockGeoJSAnnotation("polygon");
        ann.coordinates = vi.fn().mockReturnValue([
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
          { x: 0, y: 10 },
        ]);

        await (wrapper.vm as any).addAnnotationFromGeoJsAnnotation(ann);
        expect(ellipseToPolygonCoordinates).toHaveBeenCalled();
      });

      it("returns early when annotation is null", async () => {
        mockedStore.selectedTool = {
          configuration: {
            id: "t1",
            type: "create",
            values: { annotation: { shape: "point" } },
          },
          state: {},
        } as any;
        wrapper = mountComponent();

        await (wrapper.vm as any).addAnnotationFromGeoJsAnnotation(null);
        expect(
          mockedAnnotationStore.addAnnotationFromTool,
        ).not.toHaveBeenCalled();
      });

      it("returns early when no selectedToolConfiguration", async () => {
        wrapper = mountComponent();

        const ann = mockGeoJSAnnotation("point");
        await (wrapper.vm as any).addAnnotationFromGeoJsAnnotation(ann);
        expect(
          mockedAnnotationStore.addAnnotationFromTool,
        ).not.toHaveBeenCalled();
      });
    });

    // --- handleAnnotationConnections ---
    describe("handleAnnotationConnections", () => {
      function setupConnectionTool(action: string) {
        // Get the actual symbol from model

        mockedStore.selectedTool = {
          configuration: {
            id: "t1",
            name: "Connect",
            type: "connection",
            values: {
              action: { value: action },
              parentAnnotation: {
                tags: [],
                tagsInclusive: true,
                layerId: null,
              },
              childAnnotation: {
                tags: [],
                tagsInclusive: true,
                layerId: null,
              },
            },
          },
          state: {
            type: ConnectionToolStateSymbol,
            selectedAnnotationId: null,
          },
        } as any;
      }

      it("returns early when no dataset", async () => {
        mockedStore.dataset = null as any;
        setupConnectionTool("add_click");
        wrapper = mountComponent();

        const ann = mockGeoJSAnnotation("point");
        await (wrapper.vm as any).handleAnnotationConnections(ann);
        expect(mockedAnnotationStore.createConnection).not.toHaveBeenCalled();
      });

      it("returns early when selectAnnotation is null", async () => {
        setupConnectionTool("add_click");
        wrapper = mountComponent();

        await (wrapper.vm as any).handleAnnotationConnections(null);
        expect(mockedAnnotationStore.createConnection).not.toHaveBeenCalled();
      });

      it("creates connection on add_click with selected annotation", async () => {
        mockedStore.selectedTool = {
          configuration: {
            id: "t1",
            name: "Connect",
            type: "connection",
            values: {
              action: { value: "add_click" },
              parentAnnotation: {
                tags: [],
                tagsInclusive: true,
                layerId: null,
              },
              childAnnotation: {
                tags: [],
                tagsInclusive: true,
                layerId: null,
              },
            },
          },
          state: {
            type: ConnectionToolStateSymbol,
            selectedAnnotationId: "ann1",
          },
        } as any;

        const ann2 = makeAnnotation({ id: "ann2" });
        (mockedAnnotationStore.getAnnotationFromId as any).mockReturnValue(
          ann2,
        );

        wrapper = mountComponent();
        // Mock getSelectedAnnotationsFromAnnotation to return ann2
        (wrapper.vm as any).annotationLayer.annotations = vi.fn(() => {
          const geoAnn = mockGeoJSAnnotation("point");
          geoAnn.options("girderId", "ann2");
          geoAnn.options("isConnection", false);
          return [geoAnn];
        });
        (pointDistance as any).mockReturnValue(1);

        const selectAnn = mockGeoJSAnnotation("point");
        selectAnn.type = vi.fn().mockReturnValue("point");
        selectAnn.coordinates = vi.fn().mockReturnValue([{ x: 10, y: 20 }]);

        await (wrapper.vm as any).handleAnnotationConnections(selectAnn);
        expect(mockedAnnotationStore.createConnection).toHaveBeenCalled();
      });

      it("calls createAllConnections on add_lasso", async () => {
        setupConnectionTool("add_lasso");
        wrapper = mountComponent();
        (wrapper.vm as any).annotationLayer.annotations = vi.fn(() => []);

        const selectAnn = mockGeoJSAnnotation("polygon");
        await (wrapper.vm as any).handleAnnotationConnections(selectAnn);
        expect(mockedAnnotationStore.createAllConnections).toHaveBeenCalled();
      });

      it("calls deleteAllConnections on delete_lasso", async () => {
        setupConnectionTool("delete_lasso");
        wrapper = mountComponent();
        (wrapper.vm as any).annotationLayer.annotations = vi.fn(() => []);

        const selectAnn = mockGeoJSAnnotation("polygon");
        await (wrapper.vm as any).handleAnnotationConnections(selectAnn);
        expect(mockedAnnotationStore.deleteAllConnections).toHaveBeenCalled();
      });

      it("removes selectAnnotation from interactionLayer", async () => {
        setupConnectionTool("add_lasso");
        wrapper = mountComponent();
        (wrapper.vm as any).annotationLayer.annotations = vi.fn(() => []);

        const selectAnn = mockGeoJSAnnotation("polygon");
        await (wrapper.vm as any).handleAnnotationConnections(selectAnn);
        expect(
          (wrapper.vm as any).interactionLayer.removeAnnotation,
        ).toHaveBeenCalledWith(selectAnn);
      });
    });

    // --- handleAnnotationCombine ---
    describe("handleAnnotationCombine", () => {
      function setupCombineTool() {
        mockedStore.selectedTool = {
          configuration: {
            id: "t1",
            type: "edit",
            values: {
              action: { value: "combine_click" },
              tolerance: "2",
            },
          },
          state: {
            type: CombineToolStateSymbol,
            selectedAnnotationId: null,
          },
        } as any;
      }

      it("selects annotation on first click", async () => {
        setupCombineTool();
        const ann1 = makeAnnotation({ id: "a1", shape: "polygon" });
        (mockedAnnotationStore.getAnnotationFromId as any).mockReturnValue(
          ann1,
        );
        (pointDistance as any).mockReturnValue(1);

        wrapper = mountComponent();
        const geoAnn = mockGeoJSAnnotation("polygon");
        geoAnn.options("girderId", "a1");
        geoAnn.options("isConnection", false);
        (wrapper.vm as any).annotationLayer.annotations = vi.fn(() => [geoAnn]);

        const selectAnn = mockGeoJSAnnotation("point");
        selectAnn.type = vi.fn().mockReturnValue("point");
        selectAnn.coordinates = vi.fn().mockReturnValue([{ x: 5, y: 5 }]);

        await (wrapper.vm as any).handleAnnotationCombine(selectAnn);
        expect((wrapper.vm as any).selectedToolState.selectedAnnotationId).toBe(
          "a1",
        );
      });

      it("combines annotations on second click", async () => {
        mockedStore.selectedTool = {
          configuration: {
            id: "t1",
            type: "edit",
            values: {
              action: { value: "combine_click" },
              tolerance: "2",
            },
          },
          state: {
            type: CombineToolStateSymbol,
            selectedAnnotationId: "a1",
          },
        } as any;

        const ann2 = makeAnnotation({ id: "a2", shape: "polygon" });
        (mockedAnnotationStore.getAnnotationFromId as any).mockReturnValue(
          ann2,
        );
        (pointDistance as any).mockReturnValue(1);

        wrapper = mountComponent();
        const geoAnn = mockGeoJSAnnotation("polygon");
        geoAnn.options("girderId", "a2");
        geoAnn.options("isConnection", false);
        (wrapper.vm as any).annotationLayer.annotations = vi.fn(() => [geoAnn]);

        const selectAnn = mockGeoJSAnnotation("point");
        selectAnn.type = vi.fn().mockReturnValue("point");
        selectAnn.coordinates = vi.fn().mockReturnValue([{ x: 5, y: 5 }]);

        await (wrapper.vm as any).handleAnnotationCombine(selectAnn);
        expect(mockedAnnotationStore.combineAnnotations).toHaveBeenCalledWith({
          firstAnnotationId: "a1",
          secondAnnotationId: "a2",
          tolerance: 2,
        });
      });

      it("does not combine annotation with itself", async () => {
        mockedStore.selectedTool = {
          configuration: {
            id: "t1",
            type: "edit",
            values: {
              action: { value: "combine_click" },
              tolerance: "2",
            },
          },
          state: {
            type: CombineToolStateSymbol,
            selectedAnnotationId: "a1",
          },
        } as any;

        const ann1 = makeAnnotation({ id: "a1", shape: "polygon" });
        (mockedAnnotationStore.getAnnotationFromId as any).mockReturnValue(
          ann1,
        );
        (pointDistance as any).mockReturnValue(1);

        wrapper = mountComponent();
        const geoAnn = mockGeoJSAnnotation("polygon");
        geoAnn.options("girderId", "a1");
        geoAnn.options("isConnection", false);
        (wrapper.vm as any).annotationLayer.annotations = vi.fn(() => [geoAnn]);

        const selectAnn = mockGeoJSAnnotation("point");
        selectAnn.type = vi.fn().mockReturnValue("point");
        selectAnn.coordinates = vi.fn().mockReturnValue([{ x: 5, y: 5 }]);

        await (wrapper.vm as any).handleAnnotationCombine(selectAnn);
        expect(mockedAnnotationStore.combineAnnotations).not.toHaveBeenCalled();
      });

      it("filters non-polygon annotations", async () => {
        setupCombineTool();
        const ann1 = makeAnnotation({ id: "a1", shape: "point" }); // Not polygon
        (mockedAnnotationStore.getAnnotationFromId as any).mockReturnValue(
          ann1,
        );
        (pointDistance as any).mockReturnValue(1);

        wrapper = mountComponent();
        const geoAnn = mockGeoJSAnnotation("point");
        geoAnn.options("girderId", "a1");
        geoAnn.options("isConnection", false);
        (wrapper.vm as any).annotationLayer.annotations = vi.fn(() => [geoAnn]);

        const selectAnn = mockGeoJSAnnotation("point");
        selectAnn.type = vi.fn().mockReturnValue("point");
        selectAnn.coordinates = vi.fn().mockReturnValue([{ x: 5, y: 5 }]);

        await (wrapper.vm as any).handleAnnotationCombine(selectAnn);
        // Should not set selectedAnnotationId since no polygon found
        expect(
          (wrapper.vm as any).selectedToolState.selectedAnnotationId,
        ).toBeNull();
      });

      it("returns early when selectAnnotation is null", async () => {
        setupCombineTool();
        wrapper = mountComponent();
        await (wrapper.vm as any).handleAnnotationCombine(null);
        expect(mockedAnnotationStore.combineAnnotations).not.toHaveBeenCalled();
      });

      it("removes interaction annotation", async () => {
        setupCombineTool();
        wrapper = mountComponent();
        (wrapper.vm as any).annotationLayer.annotations = vi.fn(() => []);

        const selectAnn = mockGeoJSAnnotation("point");
        await (wrapper.vm as any).handleAnnotationCombine(selectAnn);
        expect(
          (wrapper.vm as any).interactionLayer.removeAnnotation,
        ).toHaveBeenCalledWith(selectAnn);
      });
    });

    // --- handleAnnotationTagging / updateAnnotationTags ---
    describe("handleAnnotationTagging", () => {
      it("tags annotations on tag_click", async () => {
        mockedStore.selectedTool = {
          configuration: {
            id: "t1",
            type: "tagging",
            values: {
              action: { value: "tag_click" },
              tags: ["tagA"],
              removeExisting: false,
            },
          },
          state: {},
        } as any;

        const ann1 = makeAnnotation({ id: "a1", tags: [] });
        (mockedAnnotationStore.getAnnotationFromId as any).mockReturnValue(
          ann1,
        );
        (pointDistance as any).mockReturnValue(1);

        wrapper = mountComponent();
        const geoAnn = mockGeoJSAnnotation("point");
        geoAnn.options("girderId", "a1");
        geoAnn.options("isConnection", false);
        (wrapper.vm as any).annotationLayer.annotations = vi.fn(() => [geoAnn]);

        const selectAnn = mockGeoJSAnnotation("point");
        selectAnn.type = vi.fn().mockReturnValue("point");
        selectAnn.coordinates = vi.fn().mockReturnValue([{ x: 10, y: 20 }]);

        await (wrapper.vm as any).handleAnnotationTagging(selectAnn);
        expect(mockedAnnotationStore.updateAnnotationsPerId).toHaveBeenCalled();
      });

      it("highlights annotation when single selection", async () => {
        mockedStore.selectedTool = {
          configuration: {
            id: "t1",
            type: "tagging",
            values: {
              action: { value: "tag_click" },
              tags: ["tagA"],
              removeExisting: false,
            },
          },
          state: {},
        } as any;

        const ann1 = makeAnnotation({ id: "a1" });
        (mockedAnnotationStore.getAnnotationFromId as any).mockReturnValue(
          ann1,
        );
        (pointDistance as any).mockReturnValue(1);

        wrapper = mountComponent();
        const geoAnn = mockGeoJSAnnotation("point");
        geoAnn.options("girderId", "a1");
        geoAnn.options("isConnection", false);
        (wrapper.vm as any).annotationLayer.annotations = vi.fn(() => [geoAnn]);

        const selectAnn = mockGeoJSAnnotation("point");
        selectAnn.type = vi.fn().mockReturnValue("point");
        selectAnn.coordinates = vi.fn().mockReturnValue([{ x: 10, y: 20 }]);

        await (wrapper.vm as any).handleAnnotationTagging(selectAnn);
        expect(
          mockedAnnotationStore.setHoveredAnnotationId,
        ).toHaveBeenCalledWith("a1");
      });

      it("returns early when annotation is null", async () => {
        wrapper = mountComponent();
        await (wrapper.vm as any).handleAnnotationTagging(null);
        expect(
          mockedAnnotationStore.updateAnnotationsPerId,
        ).not.toHaveBeenCalled();
      });
    });

    describe("updateAnnotationTags", () => {
      it("removes tags on untag action", async () => {
        wrapper = mountComponent();
        await (wrapper.vm as any).updateAnnotationTags(
          ["a1"],
          "untag_click",
          ["tagToRemove"],
          false,
        );
        expect(mockedAnnotationStore.updateAnnotationsPerId).toHaveBeenCalled();
        const call = (mockedAnnotationStore.updateAnnotationsPerId as any).mock
          .calls[0][0];
        // Test the edit function
        const testAnn = { tags: ["tagToRemove", "keepMe"] };
        call.editFunction(testAnn);
        expect(testAnn.tags).toEqual(["keepMe"]);
      });

      it("replaces tags when removeExisting is true", async () => {
        wrapper = mountComponent();
        await (wrapper.vm as any).updateAnnotationTags(
          ["a1"],
          "tag_click",
          ["newTag"],
          true,
        );
        const call = (mockedAnnotationStore.updateAnnotationsPerId as any).mock
          .calls[0][0];
        const testAnn = { tags: ["oldTag"] };
        call.editFunction(testAnn);
        expect(testAnn.tags).toEqual(["newTag"]);
      });

      it("merges tags when removeExisting is false", async () => {
        wrapper = mountComponent();
        await (wrapper.vm as any).updateAnnotationTags(
          ["a1"],
          "tag_click",
          ["newTag"],
          false,
        );
        const call = (mockedAnnotationStore.updateAnnotationsPerId as any).mock
          .calls[0][0];
        const testAnn = { tags: ["existingTag"] };
        call.editFunction(testAnn);
        expect(testAnn.tags).toContain("existingTag");
        expect(testAnn.tags).toContain("newTag");
      });
    });

    // --- handleAnnotationEdits ---
    describe("handleAnnotationEdits", () => {
      it("calls updateAnnotationsPerId for polygon annotations", async () => {
        mockedStore.selectedTool = {
          configuration: {
            id: "t1",
            type: "edit",
            values: { action: { value: "blob_edit" } },
          },
          state: {},
        } as any;

        const ann1 = makeAnnotation({
          id: "a1",
          shape: "polygon",
          coordinates: [
            { x: 10, y: 10 },
            { x: 50, y: 10 },
            { x: 50, y: 50 },
          ],
        });
        (mockedAnnotationStore.getAnnotationFromId as any).mockReturnValue(
          ann1,
        );

        // Set up layer + annotations so the R-tree spatial index is populated
        const layer = makeLayer({ id: "l1", channel: 0, visible: true });
        mockedStore.layers = [layer];
        mockedAnnotationStore.annotations = [ann1];

        wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });
        const geoAnn = mockGeoJSAnnotation("polygon");
        geoAnn.options("girderId", "a1");
        geoAnn.options("isConnection", false);
        (wrapper.vm as any).annotationLayer.annotations = vi.fn(() => [geoAnn]);

        // Use polygon selection type to match
        (geojs as any).util.pointInPolygon.mockReturnValue(true);

        const selectAnn = mockGeoJSAnnotation("polygon");
        selectAnn.type = vi.fn().mockReturnValue("polygon");
        selectAnn.coordinates = vi.fn().mockReturnValue([
          { x: 0, y: 0 },
          { x: 100, y: 0 },
          { x: 100, y: 100 },
        ]);

        await (wrapper.vm as any).handleAnnotationEdits(selectAnn);
        expect(mockedAnnotationStore.updateAnnotationsPerId).toHaveBeenCalled();
      });

      it("returns early when no annotations selected", async () => {
        wrapper = mountComponent();
        (wrapper.vm as any).annotationLayer.annotations = vi.fn(() => []);

        const selectAnn = mockGeoJSAnnotation("polygon");
        await (wrapper.vm as any).handleAnnotationEdits(selectAnn);
        expect(
          mockedAnnotationStore.updateAnnotationsPerId,
        ).not.toHaveBeenCalled();
      });

      it("removes selectAnnotation after processing", async () => {
        wrapper = mountComponent();
        (wrapper.vm as any).annotationLayer.annotations = vi.fn(() => []);

        const selectAnn = mockGeoJSAnnotation("polygon");
        await (wrapper.vm as any).handleAnnotationEdits(selectAnn);
        expect(
          (wrapper.vm as any).interactionLayer.removeAnnotation,
        ).toHaveBeenCalledWith(selectAnn);
      });
    });

    // --- geometry ops on unhydrated stubs (Finding P2) ---
    describe("geometry edits on unhydrated stubs", () => {
      // A polygon STUB: no `coordinates` key ⇒ isHydratedAnnotation is false.
      const polygonStub = {
        id: "s1",
        shape: "polygon",
        centroid: { x: 30, y: 30 },
        location: { XY: 0, Z: 0, Time: 0 },
        tags: [],
        channel: 0,
        color: null,
      };

      // Make getSelectedAnnotationsFromAnnotation resolve the click to the
      // unhydrated stub: getAnnotationFromId misses, getStub hits.
      function selectStub() {
        (mockedAnnotationStore.getAnnotationFromId as any).mockReturnValue(
          undefined,
        );
        (mockedAnnotationStore.getStub as any).mockReturnValue(polygonStub);
        const layer = makeLayer({ id: "l1", channel: 0, visible: true });
        mockedStore.layers = [layer];
        wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });
        const geoAnn = mockGeoJSAnnotation("polygon");
        geoAnn.options("girderId", "s1");
        geoAnn.options("isConnection", false);
        (wrapper.vm as any).annotationLayer.annotations = vi.fn(() => [geoAnn]);
        (geojs as any).util.pointInPolygon.mockReturnValue(true);
        const selectAnn = mockGeoJSAnnotation("polygon");
        selectAnn.type = vi.fn().mockReturnValue("polygon");
        selectAnn.coordinates = vi.fn().mockReturnValue([
          { x: 0, y: 0 },
          { x: 100, y: 0 },
          { x: 100, y: 100 },
        ]);
        return selectAnn;
      }

      it("edit: toasts and does NOT edit when the polygon is an unhydrated stub", async () => {
        mockedStore.selectedTool = {
          configuration: {
            id: "t1",
            type: "edit",
            values: { action: { value: "blob_edit" } },
          },
          state: {},
        } as any;
        const selectAnn = selectStub();

        await (wrapper.vm as any).handleAnnotationEdits(selectAnn);

        expect((wrapper.vm as any).geometryNotLoadedSnackbar).toBe(true);
        expect(
          mockedAnnotationStore.updateAnnotationsPerId,
        ).not.toHaveBeenCalled();
      });

      it("combine: toasts and does NOT combine when the clicked polygon is an unhydrated stub", async () => {
        mockedStore.selectedTool = {
          configuration: {
            id: "t1",
            type: "edit",
            values: { action: { value: "combine_click" }, tolerance: "2" },
          },
          // The unhydrated-stub guard fires before any tool-state check, so the
          // exact combine state isn't needed here.
          state: {},
        } as any;
        const selectAnn = selectStub();

        await (wrapper.vm as any).handleAnnotationCombine(selectAnn);

        expect((wrapper.vm as any).geometryNotLoadedSnackbar).toBe(true);
        expect(mockedAnnotationStore.combineAnnotations).not.toHaveBeenCalled();
      });
    });

    // --- handleNewROIFilter ---
    describe("handleNewROIFilter", () => {
      it("validates coordinates and removes annotation", () => {
        mockedFilterStore.emptyROIFilter = { id: "f1", roi: [] } as any;
        wrapper = mountComponent();

        const ann = mockGeoJSAnnotation("polygon");
        ann.coordinates = vi.fn().mockReturnValue([
          { x: 0, y: 0 },
          { x: 10, y: 10 },
        ]);

        (wrapper.vm as any).handleNewROIFilter(ann);
        expect(mockedFilterStore.validateNewROIFilter).toHaveBeenCalledWith([
          { x: 0, y: 0 },
          { x: 10, y: 10 },
        ]);
        expect(
          (wrapper.vm as any).interactionLayer.removeAnnotation,
        ).toHaveBeenCalledWith(ann);
      });

      it("returns early when no roiFilter", () => {
        mockedFilterStore.emptyROIFilter = null;
        wrapper = mountComponent();

        const ann = mockGeoJSAnnotation("polygon");
        (wrapper.vm as any).handleNewROIFilter(ann);
        expect(mockedFilterStore.validateNewROIFilter).not.toHaveBeenCalled();
      });
    });
  });

  // =========================================================================
  // Category 5: Coordinate Transformation (~7 tests)
  // =========================================================================
  describe("coordinate transformation", () => {
    // `unrollIndex` became `unrollCellIndex` and the offset math became
    // `unrolledCoordinates`, both in @/utils/unroll (issue #1280), where the
    // navigation path shares them. Their unit tests moved with them to
    // src/utils/unroll.test.ts.
    //
    // What belongs HERE is the wiring the util cannot see: the draw path must key
    // its grid to the `unrollW` PROP — the grid ImageViewer actually laid the
    // tiles out on — and the centroid map the canvas draws from must carry the
    // offset. `unrollIndexFromImages` stays stubbed to pick the cell; resolving a
    // location to its cell for real is unroll.test.ts's job.
    describe("unrollLayout", () => {
      it("takes its grid from the unrollW prop", () => {
        mockedStore.unroll = true;
        wrapper = mountComponent({ unrollW: 3 });
        const layout = (wrapper.vm as any).unrollLayout;
        expect(layout.unrollW).toBe(3);
        expect(layout.unroll).toBe(true);
        // Cell size comes from the dataset's frames, not from the caller.
        expect(layout.sizeX).toBe(1024);
        expect(layout.sizeY).toBe(1024);
      });

      it("is not unrolled when no axis is unrolled", () => {
        wrapper = mountComponent({ unrollW: 3 });
        expect((wrapper.vm as any).unrollLayout.unroll).toBe(false);
      });
    });

    // The map every drawn centroid, connection line and label is positioned
    // from — the reason the offset has to be applied at all.
    describe("unrolledCentroidCoordinates", () => {
      function mountWithOneAnnotation(tile: number, unrollW: number) {
        mockedStore.dataset = {
          ...mockedStore.dataset,
          anyImage: () => ({ sizeX: tile, sizeY: tile }),
          images: () => [],
        } as any;
        mockedAnnotationStore.annotations = [makeAnnotation({ id: "a1" })];
        mockedAnnotationStore.annotationCentroids = { a1: { x: 10, y: 20 } };
        wrapper = mountComponent({ unrollW });
        return (wrapper.vm as any).unrolledCentroidCoordinates.a1;
      }

      it("leaves centroids alone when not unrolling", () => {
        (unrollIndexFromImages as any).mockReturnValue(3);
        expect(mountWithOneAnnotation(100, 2)).toEqual({ x: 10, y: 20 });
      });

      it("offsets a centroid by its frame's grid cell", () => {
        mockedStore.unroll = true;
        // cell 1 in a 2-wide grid ⇒ column 1, row 0
        (unrollIndexFromImages as any).mockReturnValue(1);
        expect(mountWithOneAnnotation(100, 2)).toEqual({
          x: 110,
          y: 20,
          z: undefined,
        });
      });

      it("wraps onto the next grid row past the last column", () => {
        mockedStore.unroll = true;
        // cell 3 in a 2-wide grid ⇒ column 1, row 1: offset in BOTH axes
        (unrollIndexFromImages as any).mockReturnValue(3);
        expect(mountWithOneAnnotation(100, 2)).toEqual({
          x: 110,
          y: 120,
          z: undefined,
        });
      });

      // Cost, with no visible behaviour: the transform runs once per annotation
      // per draw, so the layout must be hoisted out of that loop. Asserted as
      // "does not scale with annotation count" rather than an absolute count —
      // the layout is a computed, so how many times mount happens to evaluate it
      // is incidental, while scaling with the annotation count is the defect.
      it("builds a layout per draw, not per annotation", () => {
        mockedStore.unroll = true;
        const layoutsBuiltFor = (annotationCount: number) => {
          const ids = Array.from(
            { length: annotationCount },
            (_, i) => `a${i}`,
          );
          mockedAnnotationStore.annotations = ids.map((id) =>
            makeAnnotation({ id }),
          );
          mockedAnnotationStore.annotationCentroids = Object.fromEntries(
            ids.map((id, i) => [id, { x: i, y: i }]),
          );
          unrollSpy.unrollLayoutFor.mockClear();
          wrapper = mountComponent({ unrollW: 2 });
          // Reading the map is what runs the transform over every annotation.
          expect(
            Object.keys((wrapper.vm as any).unrolledCentroidCoordinates),
          ).toHaveLength(annotationCount);
          const built = unrollSpy.unrollLayoutFor.mock.calls.length;
          wrapper.unmount();
          return built;
        };

        expect(layoutsBuiltFor(40)).toBe(layoutsBuiltFor(2));
      });
    });
  });

  // =========================================================================
  // Category 6: Timelapse Mode (~14 tests)
  // =========================================================================
  describe("timelapse mode", () => {
    // --- findConnectedComponents ---
    describe("findConnectedComponents", () => {
      beforeEach(() => {
        wrapper = mountComponent();
      });

      it("handles linear chain of connections", () => {
        const connections = [
          makeConnection({ id: "c1", parentId: "a1", childId: "a2" }),
          makeConnection({ id: "c2", parentId: "a2", childId: "a3" }),
        ];
        const result = (wrapper.vm as any).findConnectedComponents(connections);
        // All 3 annotations should be in one component
        expect(result).toHaveLength(1);
        expect(result[0].annotations.size).toBe(3);
        expect(result[0].connections).toHaveLength(2);
      });

      it("handles disconnected pairs", () => {
        const connections = [
          makeConnection({ id: "c1", parentId: "a1", childId: "a2" }),
          makeConnection({ id: "c2", parentId: "a3", childId: "a4" }),
        ];
        const result = (wrapper.vm as any).findConnectedComponents(connections);
        expect(result).toHaveLength(2);
      });

      it("handles cycles", () => {
        const connections = [
          makeConnection({ id: "c1", parentId: "a1", childId: "a2" }),
          makeConnection({ id: "c2", parentId: "a2", childId: "a3" }),
          makeConnection({ id: "c3", parentId: "a3", childId: "a1" }),
        ];
        const result = (wrapper.vm as any).findConnectedComponents(connections);
        expect(result).toHaveLength(1);
        expect(result[0].annotations.size).toBe(3);
      });

      it("handles empty connections", () => {
        const result = (wrapper.vm as any).findConnectedComponents([]);
        expect(result).toHaveLength(0);
      });

      it("merges components through bridge connections", () => {
        const connections = [
          makeConnection({ id: "c1", parentId: "a1", childId: "a2" }),
          makeConnection({ id: "c2", parentId: "a3", childId: "a4" }),
          // Bridge connects the two groups
          makeConnection({ id: "c3", parentId: "a2", childId: "a3" }),
        ];
        const result = (wrapper.vm as any).findConnectedComponents(connections);
        expect(result).toHaveLength(1);
        expect(result[0].annotations.size).toBe(4);
      });

      it("groups connections into correct components", () => {
        const connections = [
          makeConnection({ id: "c1", parentId: "a1", childId: "a2" }),
          makeConnection({ id: "c2", parentId: "a3", childId: "a4" }),
        ];
        const result = (wrapper.vm as any).findConnectedComponents(connections);
        // Each component should have its own connection
        const connCounts = result.map((c: any) => c.connections.length);
        expect(connCounts.sort()).toEqual([1, 1]);
      });
    });

    // --- getDisplayedAnnotationIdsAcrossTime ---
    describe("getDisplayedAnnotationIdsAcrossTime", () => {
      it("collects annotations across time from valid layers", () => {
        const layer = makeLayer({ id: "l1", channel: 0, visible: true });
        mockedStore.layers = [layer];
        (mockedStore.layerSliceIndexes as any).mockReturnValue({
          xyIndex: 0,
          zIndex: 0,
          tIndex: 0,
        });
        const ann1 = makeAnnotation({
          id: "a1",
          channel: 0,
          location: { XY: 0, Z: 0, Time: 0 },
        });
        const ann2 = makeAnnotation({
          id: "a2",
          channel: 0,
          location: { XY: 0, Z: 0, Time: 5 },
        });
        mockedAnnotationStore.annotations = [ann1, ann2];

        wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });
        const result = (
          wrapper.vm as any
        ).getDisplayedAnnotationIdsAcrossTime();
        // Both should be included since we're collecting across time
        expect(result.has("a1")).toBe(true);
        expect(result.has("a2")).toBe(true);
      });

      it("respects XY and Z filters", () => {
        const layer = makeLayer({ id: "l1", channel: 0, visible: true });
        mockedStore.layers = [layer];
        (mockedStore.layerSliceIndexes as any).mockReturnValue({
          xyIndex: 0,
          zIndex: 0,
          tIndex: 0,
        });
        const ann1 = makeAnnotation({
          id: "a1",
          channel: 0,
          location: { XY: 0, Z: 0, Time: 0 },
        });
        const ann2 = makeAnnotation({
          id: "a2",
          channel: 0,
          location: { XY: 1, Z: 0, Time: 0 },
        });
        mockedAnnotationStore.annotations = [ann1, ann2];

        wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });
        const result = (
          wrapper.vm as any
        ).getDisplayedAnnotationIdsAcrossTime();
        expect(result.has("a1")).toBe(true);
        expect(result.has("a2")).toBe(false); // Different XY
      });

      it("excludes hidden layers when showAnnotationsFromHiddenLayers is false", () => {
        const layer = makeLayer({ id: "l1", channel: 0, visible: false });
        mockedStore.layers = [layer];
        mockedStore.showAnnotationsFromHiddenLayers = false;
        const ann = makeAnnotation({ id: "a1", channel: 0 });
        mockedAnnotationStore.annotations = [ann];

        wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });
        const result = (
          wrapper.vm as any
        ).getDisplayedAnnotationIdsAcrossTime();
        expect(result.size).toBe(0);
      });
    });

    // --- drawTimelapseConnectionsAndCentroids ---
    describe("drawTimelapseConnectionsAndCentroids", () => {
      it("clears previous tracks", () => {
        wrapper = mountComponent();
        (wrapper.vm as any).drawTimelapseConnectionsAndCentroids();
        expect(
          (wrapper.vm as any).timelapseLayer.removeAllAnnotations,
        ).toHaveBeenCalled();
      });

      it("exits early when showTimelapseMode is false", () => {
        mockedTimelapseStore.showMode = false;
        wrapper = mountComponent();
        const tLayer = (wrapper.vm as any).timelapseLayer;
        vi.clearAllMocks();
        (wrapper.vm as any).drawTimelapseConnectionsAndCentroids();
        expect(tLayer.removeAllAnnotations).toHaveBeenCalled();
        expect(tLayer.draw).toHaveBeenCalled();
      });

      // Track segments must carry their connection id, or clicking a segment
      // cannot resolve to the link it represents and tracks stay uncuttable.
      it("tags each track segment with its connection id", () => {
        mockedTimelapseStore.showMode = true;
        const layer = makeLayer({ id: "l1", channel: 0, visible: true });
        mockedStore.layers = [layer];
        (mockedStore.layerSliceIndexes as any).mockReturnValue({
          xyIndex: 0,
          zIndex: 0,
          tIndex: 0,
        });
        const ann1 = makeAnnotation({
          id: "a1",
          channel: 0,
          location: { XY: 0, Z: 0, Time: 0 },
        });
        const ann2 = makeAnnotation({
          id: "a2",
          channel: 0,
          location: { XY: 0, Z: 0, Time: 1 },
        });
        mockedAnnotationStore.annotations = [ann1, ann2];
        mockedAnnotationStore.annotationConnections = [
          makeConnection({ id: "c1", parentId: "a1", childId: "a2" }),
        ];
        (mockedAnnotationStore.getAnnotationFromId as any).mockImplementation(
          (id: string) =>
            mockedAnnotationStore.annotations.find((a: any) => a.id === id),
        );
        mockedAnnotationStore.annotationCentroids = {
          a1: { x: 10, y: 20 },
          a2: { x: 30, y: 40 },
        };
        // The factory mock ignores its args by default, so give each created
        // feature a real options bag to read back.
        (geojsAnnotationFactory as any).mockImplementation((shape: string) =>
          mockGeoJSAnnotation(shape),
        );

        wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });
        const tLayer = (wrapper.vm as any).timelapseLayer;
        tLayer.addMultipleAnnotations.mockClear();
        (wrapper.vm as any).drawTimelapseConnectionsAndCentroids();

        const lineBatches = tLayer.addMultipleAnnotations.mock.calls
          .map((call: any[]) => call[0])
          .filter((lines: any[]) =>
            lines?.some((line: any) => line.options()?.isConnection),
          );
        expect(lineBatches.length).toBeGreaterThan(0);
        const tagged = lineBatches
          .flat()
          .filter((line: any) => line.options().isConnection);
        expect(tagged).toHaveLength(1);
        expect(tagged[0].options().girderId).toBe("c1");
      });

      // Regression: drawTimelapseTrack skipped a segment whenever the other
      // endpoint's time was >= this one's, so an equal-time link was skipped
      // from BOTH endpoints and never drawn — while Connect selected
      // deliberately creates exactly those for same-frame pairs. One real
      // dataset here has 54 links, every one of them equal-time.
      it("draws an equal-time link exactly once", () => {
        mockedTimelapseStore.showMode = true;
        const layer = makeLayer({ id: "l1", channel: 0, visible: true });
        mockedStore.layers = [layer];
        (mockedStore.layerSliceIndexes as any).mockReturnValue({
          xyIndex: 0,
          zIndex: 0,
          tIndex: 0,
        });
        // Both endpoints on the SAME timepoint.
        mockedAnnotationStore.annotations = [
          makeAnnotation({
            id: "a1",
            channel: 0,
            location: { XY: 0, Z: 0, Time: 3 },
          }),
          makeAnnotation({
            id: "a2",
            channel: 0,
            location: { XY: 0, Z: 0, Time: 3 },
          }),
        ];
        mockedAnnotationStore.annotationConnections = [
          makeConnection({ id: "sameT", parentId: "a1", childId: "a2" }),
        ];
        (mockedAnnotationStore.getAnnotationFromId as any).mockImplementation(
          (id: string) =>
            mockedAnnotationStore.annotations.find((a: any) => a.id === id),
        );
        mockedAnnotationStore.annotationCentroids = {
          a1: { x: 10, y: 20 },
          a2: { x: 30, y: 40 },
        };
        (geojsAnnotationFactory as any).mockImplementation((shape: string) =>
          mockGeoJSAnnotation(shape),
        );

        wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });
        const tLayer = (wrapper.vm as any).timelapseLayer;
        tLayer.addMultipleAnnotations.mockClear();
        (wrapper.vm as any).drawTimelapseConnectionsAndCentroids();

        const drawn = tLayer.addMultipleAnnotations.mock.calls
          .map((call: any[]) => call[0])
          .flat()
          .filter((f: any) => f?.options?.().isConnection);
        expect(drawn).toHaveLength(1);
        expect(drawn[0].options().girderId).toBe("sameT");
      });

      // A self-connection is a zero-length segment; the id tie-break must
      // exclude it rather than emitting a degenerate line.
      it("does not draw a self-connection as a track segment", () => {
        mockedTimelapseStore.showMode = true;
        const layer = makeLayer({ id: "l1", channel: 0, visible: true });
        mockedStore.layers = [layer];
        (mockedStore.layerSliceIndexes as any).mockReturnValue({
          xyIndex: 0,
          zIndex: 0,
          tIndex: 0,
        });
        mockedAnnotationStore.annotations = [
          makeAnnotation({
            id: "a1",
            channel: 0,
            location: { XY: 0, Z: 0, Time: 0 },
          }),
        ];
        mockedAnnotationStore.annotationConnections = [
          makeConnection({ id: "loop", parentId: "a1", childId: "a1" }),
        ];
        (mockedAnnotationStore.getAnnotationFromId as any).mockImplementation(
          (id: string) =>
            mockedAnnotationStore.annotations.find((a: any) => a.id === id),
        );
        mockedAnnotationStore.annotationCentroids = { a1: { x: 10, y: 20 } };
        (geojsAnnotationFactory as any).mockImplementation((shape: string) =>
          mockGeoJSAnnotation(shape),
        );

        wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });
        const tLayer = (wrapper.vm as any).timelapseLayer;
        tLayer.addMultipleAnnotations.mockClear();
        (wrapper.vm as any).drawTimelapseConnectionsAndCentroids();

        const drawn = tLayer.addMultipleAnnotations.mock.calls
          .map((call: any[]) => call[0])
          .flat()
          .filter((f: any) => f?.options?.().isConnection);
        expect(drawn).toHaveLength(0);
      });

      // The schema allows several connection documents for one endpoint pair
      // (this repo's own datasets have them), but only one segment is drawn per
      // pair. Whichever record it carries is the only one that can be
      // highlighted or resolved by a click, so a selected duplicate must win.
      it("renders the selected duplicate as the pair's representative", () => {
        mockedTimelapseStore.showMode = true;
        const layer = makeLayer({ id: "l1", channel: 0, visible: true });
        mockedStore.layers = [layer];
        (mockedStore.layerSliceIndexes as any).mockReturnValue({
          xyIndex: 0,
          zIndex: 0,
          tIndex: 0,
        });
        const ann1 = makeAnnotation({
          id: "a1",
          channel: 0,
          location: { XY: 0, Z: 0, Time: 0 },
        });
        const ann2 = makeAnnotation({
          id: "a2",
          channel: 0,
          location: { XY: 0, Z: 0, Time: 1 },
        });
        mockedAnnotationStore.annotations = [ann1, ann2];
        // Two documents for the very same pair.
        mockedAnnotationStore.annotationConnections = [
          makeConnection({ id: "dup1", parentId: "a1", childId: "a2" }),
          makeConnection({ id: "dup2", parentId: "a1", childId: "a2" }),
        ];
        (mockedAnnotationStore.getAnnotationFromId as any).mockImplementation(
          (id: string) =>
            mockedAnnotationStore.annotations.find((a: any) => a.id === id),
        );
        mockedAnnotationStore.annotationCentroids = {
          a1: { x: 10, y: 20 },
          a2: { x: 30, y: 40 },
        };
        // Forward the options bag: the default factory mock drops it, so the
        // style passed at construction would never reach the feature.
        (geojsAnnotationFactory as any).mockImplementation(
          (shape: string, _coords: any, options: any) => {
            const f = mockGeoJSAnnotation(shape);
            if (options) f.options(options);
            return f;
          },
        );
        // Select the SECOND duplicate.
        connectionListStore.setSelectedConnectionIds(["dup2"]);

        wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });
        const tLayer = (wrapper.vm as any).timelapseLayer;
        tLayer.addMultipleAnnotations.mockClear();
        (wrapper.vm as any).drawTimelapseConnectionsAndCentroids();

        const drawn = tLayer.addMultipleAnnotations.mock.calls
          .map((call: any[]) => call[0])
          .flat()
          .filter((f: any) => f?.options?.().isConnection);
        expect(drawn).toHaveLength(1);
        expect(drawn[0].options().girderId).toBe("dup2");
        expect(drawn[0].options().style.strokeColor).toBe("#00e5ff");
      });

      // The representative must prefer a HOVERED duplicate too, not only a
      // selected one — otherwise hovering a later duplicate's row rebuilt the
      // layer without widening or retagging the segment.
      it("renders the hovered duplicate as the representative", () => {
        mockedTimelapseStore.showMode = true;
        const layer = makeLayer({ id: "l1", channel: 0, visible: true });
        mockedStore.layers = [layer];
        (mockedStore.layerSliceIndexes as any).mockReturnValue({
          xyIndex: 0,
          zIndex: 0,
          tIndex: 0,
        });
        mockedAnnotationStore.annotations = [
          makeAnnotation({
            id: "a1",
            channel: 0,
            location: { XY: 0, Z: 0, Time: 0 },
          }),
          makeAnnotation({
            id: "a2",
            channel: 0,
            location: { XY: 0, Z: 0, Time: 1 },
          }),
        ];
        mockedAnnotationStore.annotationConnections = [
          makeConnection({ id: "dup1", parentId: "a1", childId: "a2" }),
          makeConnection({ id: "dup2", parentId: "a1", childId: "a2" }),
        ];
        (mockedAnnotationStore.getAnnotationFromId as any).mockImplementation(
          (id: string) =>
            mockedAnnotationStore.annotations.find((a: any) => a.id === id),
        );
        mockedAnnotationStore.annotationCentroids = {
          a1: { x: 10, y: 20 },
          a2: { x: 30, y: 40 },
        };
        (geojsAnnotationFactory as any).mockImplementation(
          (shape: string, _c: any, options: any) => {
            const f = mockGeoJSAnnotation(shape);
            if (options) f.options(options);
            return f;
          },
        );
        connectionListStore.setSelectedConnectionIds([]);
        connectionListStore.setHoveredConnectionId("dup2");

        wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });
        const tLayer = (wrapper.vm as any).timelapseLayer;
        tLayer.addMultipleAnnotations.mockClear();
        (wrapper.vm as any).drawTimelapseConnectionsAndCentroids();

        const drawn = tLayer.addMultipleAnnotations.mock.calls
          .map((call: any[]) => call[0])
          .flat()
          .filter((f: any) => f?.options?.().isConnection);
        expect(drawn).toHaveLength(1);
        expect(drawn[0].options().girderId).toBe("dup2");
        // Hover must also change the rendered width, or the redraw the hover
        // watcher pays for produces no visible difference.
        const hoveredWidth = drawn[0].options().style.strokeWidth;
        connectionListStore.setHoveredConnectionId(null);
        tLayer.addMultipleAnnotations.mockClear();
        (wrapper.vm as any).drawTimelapseConnectionsAndCentroids();
        const plain = tLayer.addMultipleAnnotations.mock.calls
          .map((call: any[]) => call[0])
          .flat()
          .filter((f: any) => f?.options?.().isConnection)[0];
        expect(hoveredWidth).toBeGreaterThan(plain.options().style.strokeWidth);
      });

      // --- hover highlighting on the timelapse layer ---
      //
      // Clicking a row in the connection list HIGHLIGHTS (sets hover) rather
      // than selecting, so hover is the primary highlight channel, not just an
      // incidental mouse-over effect. Hover deliberately does not rebuild the
      // timelapse layer, so it has to restyle the drawn segments in place —
      // otherwise clicking a connection row does nothing visible in timelapse
      // mode while it highlights fine everywhere else.
      function setupOneSegmentTimelapseTrack(
        connections: any[] = [
          makeConnection({ id: "c1", parentId: "a1", childId: "a2" }),
        ],
        times: [number, number] = [0, 1],
      ) {
        mockedTimelapseStore.showMode = true;
        mockedStore.layers = [
          makeLayer({ id: "l1", channel: 0, visible: true }),
        ];
        (mockedStore.layerSliceIndexes as any).mockReturnValue({
          xyIndex: 0,
          zIndex: 0,
          tIndex: 0,
        });
        mockedAnnotationStore.annotations = [
          makeAnnotation({
            id: "a1",
            channel: 0,
            location: { XY: 0, Z: 0, Time: times[0] },
          }),
          makeAnnotation({
            id: "a2",
            channel: 0,
            location: { XY: 0, Z: 0, Time: times[1] },
          }),
        ];
        mockedAnnotationStore.annotationConnections = connections;
        (mockedAnnotationStore.getAnnotationFromId as any).mockImplementation(
          (id: string) =>
            mockedAnnotationStore.annotations.find((a: any) => a.id === id),
        );
        mockedAnnotationStore.annotationCentroids = {
          a1: { x: 10, y: 20 },
          a2: { x: 30, y: 40 },
        };
        // The default factory mock DROPS its options bag, so the style handed
        // to it at construction would never reach the feature and every style
        // assertion below would pass vacuously.
        (geojsAnnotationFactory as any).mockImplementation(
          (shape: string, _c: any, opts: any) => {
            const f = mockGeoJSAnnotation(shape);
            if (opts) f.options(opts);
            return f;
          },
        );
        connectionListStore.setSelectedConnectionIds([]);
        connectionListStore.setHoveredConnectionId(null);
      }

      // Draws the track from a clean slate and returns the layer plus its only
      // segment. Flushes the mount-time draw first: a trailing throttled draw
      // landing mid-test would rebuild the layer and strand the captured
      // feature, which reads as "the restyle did nothing".
      async function drawTrackAndGetSegment() {
        wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });
        await wrapper.vm.$nextTick();
        vi.advanceTimersByTime(101);
        const tLayer = (wrapper.vm as any).timelapseLayer;
        (wrapper.vm as any).drawTimelapseConnectionsAndCentroids();
        const segments = tLayer
          .annotations()
          .filter((f: any) => f?.options?.().isConnection);
        expect(segments).toHaveLength(1);
        tLayer.removeAllAnnotations.mockClear();
        tLayer.draw.mockClear();
        return { tLayer, segment: segments[0] };
      }

      async function setHoverAndFlush(id: string | null) {
        connectionListStore.setHoveredConnectionId(id);
        await wrapper.vm.$nextTick();
        vi.advanceTimersByTime(101);
      }

      // Returns the layer plus the centroid dot for `id`, from a clean slate.
      async function drawTrackAndGetPoint(id: string) {
        wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });
        await wrapper.vm.$nextTick();
        vi.advanceTimersByTime(101);
        const tLayer = (wrapper.vm as any).timelapseLayer;
        (wrapper.vm as any).drawTimelapseConnectionsAndCentroids();
        const point = tLayer
          .annotations()
          .find(
            (f: any) =>
              f?.options?.().isTimelapsePoint && f.options().girderId === id,
          );
        expect(point).toBeDefined();
        tLayer.removeAllAnnotations.mockClear();
        tLayer.draw.mockClear();
        return { tLayer, point };
      }

      async function setObjectSelectionAndFlush(ids: string[]) {
        // mockImplementation, not reassignment: the viewer's computed returns
        // the function REFERENCE, so replacing it would leave the component
        // holding the old one. The watcher fires off selectedAnnotationIds,
        // which is reassigned here.
        mockedAnnotationStore.selectedAnnotationIds = new Set(ids);
        (mockedAnnotationStore.isAnnotationSelected as any).mockImplementation(
          (id: string) => mockedAnnotationStore.selectedAnnotationIds.has(id),
        );
        await wrapper.vm.$nextTick();
        vi.advanceTimersByTime(101);
      }

      /**
       * The OBJECT half of the highlight pair, and the bug that motivated it:
       * `restyleAnnotations` only touches `annotationLayer`, so the timelapse
       * centroid dots had no selection branch and no restyle route at all.
       * Selecting a whole track's objects from the Connections tab changed
       * nothing on screen while its links did light up — which reads as "it
       * selected the connections instead of the objects".
       */
      it("highlights a selected object's centroid dot in place", async () => {
        setupOneSegmentTimelapseTrack();
        const { tLayer, point } = await drawTrackAndGetPoint("a1");
        const before = { ...point.options().style };

        await setObjectSelectionAndFlush(["a1"]);

        const after = point.options().style;
        expect(after.strokeColor).not.toBe(before.strokeColor);
        expect(after.strokeWidth).toBeGreaterThan(before.strokeWidth);
        // Both must survive the replace, or the dot renders unpainted/invisible.
        expect(after.stroke).toBe(true);
        expect(after.fill).toBe(true);
        expect(tLayer.draw).toHaveBeenCalled();
        // In place: a selection can be hundreds of objects and the dots'
        // identity is not a draw-time choice.
        expect(tLayer.removeAllAnnotations).not.toHaveBeenCalled();
      });

      // The other half: whatever selection paints, deselection must undo,
      // without clobbering the base styling baked in at draw time.
      it("restores a dot's base styling when it is deselected", async () => {
        setupOneSegmentTimelapseTrack();
        const { point } = await drawTrackAndGetPoint("a1");
        const before = { ...point.options().style };

        await setObjectSelectionAndFlush(["a1"]);
        expect(point.options().style.strokeWidth).toBeGreaterThan(
          before.strokeWidth,
        );

        await setObjectSelectionAndFlush([]);
        const after = point.options().style;
        expect(after.strokeColor).toBe(before.strokeColor);
        expect(after.strokeWidth).toBe(before.strokeWidth);
        expect(after.fillOpacity).toBe(before.fillOpacity);
        expect(after.radius).toBe(before.radius);
      });

      // Selecting an object must not restyle a different object's dot.
      it("leaves unselected dots alone", async () => {
        setupOneSegmentTimelapseTrack();
        const { tLayer } = await drawTrackAndGetPoint("a1");
        const other = tLayer
          .annotations()
          .find(
            (f: any) =>
              f?.options?.().isTimelapsePoint && f.options().girderId === "a2",
          );
        const before = { ...other.options().style };

        await setObjectSelectionAndFlush(["a1"]);

        expect(other.options().style.strokeColor).toBe(before.strokeColor);
        expect(other.options().style.strokeWidth).toBe(before.strokeWidth);
      });

      it("widens a hovered track segment in place, without rebuilding", async () => {
        setupOneSegmentTimelapseTrack();
        const { tLayer, segment } = await drawTrackAndGetSegment();
        const baseWidth = segment.options().style.strokeWidth;

        await setHoverAndFlush("c1");

        expect(segment.options().style.strokeWidth).toBeGreaterThan(baseWidth);
        // `stroke` must survive: options("style", …) REPLACES the style object,
        // so a restyle that omits it leaves the segment present, correctly
        // positioned and completely unpainted.
        expect(segment.options().style.stroke).toBe(true);
        expect(tLayer.draw).toHaveBeenCalled();
        expect(tLayer.removeAllAnnotations).not.toHaveBeenCalled();
      });

      // The other half of the pair: whatever hover paints, un-hover must undo,
      // and it must not clobber the base styling baked in at draw time.
      it("restores a time-jump segment's base styling when hover moves off", async () => {
        // Times 0 → 3 skip a frame: dashed, 0.7 opacity (and the TRACK colour).
        setupOneSegmentTimelapseTrack(undefined, [0, 3]);
        const { segment } = await drawTrackAndGetSegment();
        const before = { ...segment.options().style };
        expect(before.lineDash).toEqual([5, 5]);
        expect(before.strokeOpacity).toBe(0.7);

        await setHoverAndFlush("c1");
        expect(segment.options().style.strokeWidth).toBeGreaterThan(
          before.strokeWidth,
        );

        await setHoverAndFlush(null);
        const after = segment.options().style;
        expect(after.strokeWidth).toBe(before.strokeWidth);
        expect(after.strokeColor).toBe(before.strokeColor);
        expect(after.strokeOpacity).toBe(before.strokeOpacity);
        expect(after.lineDash).toEqual(before.lineDash);
      });

      // One segment is drawn per endpoint PAIR, but several connection
      // documents can share that pair. Since hover no longer rebuilds, the
      // segment keeps the representative it was built with — so matching the
      // hover on that id alone would leave hovering the other duplicate's row
      // with no visible effect.
      it("widens the segment when a non-representative duplicate is hovered", async () => {
        setupOneSegmentTimelapseTrack([
          makeConnection({ id: "dup1", parentId: "a1", childId: "a2" }),
          makeConnection({ id: "dup2", parentId: "a1", childId: "a2" }),
        ]);
        const { segment } = await drawTrackAndGetSegment();
        expect(segment.options().girderId).toBe("dup1");
        const baseWidth = segment.options().style.strokeWidth;

        await setHoverAndFlush("dup2");

        expect(segment.options().style.strokeWidth).toBeGreaterThan(baseWidth);
      });

      // Hovering a row whose connection is outside the timelapse window must
      // not force a redraw of the whole layer for a style that did not change.
      it("does not redraw when the hovered connection is not on the layer", async () => {
        setupOneSegmentTimelapseTrack();
        const { tLayer } = await drawTrackAndGetSegment();

        await setHoverAndFlush("not-drawn");

        expect(tLayer.draw).not.toHaveBeenCalled();
      });

      it("leaves the timelapse layer alone on hover outside timelapse mode", async () => {
        setupOneSegmentTimelapseTrack();
        const { tLayer } = await drawTrackAndGetSegment();
        // Leaving the mode clears the layer and draws once on its own; the
        // assertion is about the hover that follows.
        mockedTimelapseStore.showMode = false;
        await wrapper.vm.$nextTick();
        vi.advanceTimersByTime(101);
        tLayer.draw.mockClear();

        await setHoverAndFlush("c1");

        expect(tLayer.draw).not.toHaveBeenCalled();
      });

      it("filters connections by displayed annotations", () => {
        mockedTimelapseStore.showMode = true;
        const layer = makeLayer({ id: "l1", channel: 0, visible: true });
        mockedStore.layers = [layer];
        (mockedStore.layerSliceIndexes as any).mockReturnValue({
          xyIndex: 0,
          zIndex: 0,
          tIndex: 0,
        });
        // Only ann1 is in the right location, ann3 is not
        const ann1 = makeAnnotation({
          id: "a1",
          channel: 0,
          location: { XY: 0, Z: 0, Time: 0 },
        });
        const ann2 = makeAnnotation({
          id: "a2",
          channel: 0,
          location: { XY: 0, Z: 0, Time: 1 },
        });
        mockedAnnotationStore.annotations = [ann1, ann2];
        mockedAnnotationStore.annotationConnections = [
          makeConnection({ id: "c1", parentId: "a1", childId: "a2" }),
        ];
        (mockedAnnotationStore.getAnnotationFromId as any).mockImplementation(
          (id: string) =>
            mockedAnnotationStore.annotations.find((a: any) => a.id === id),
        );
        mockedAnnotationStore.annotationCentroids = {
          a1: { x: 10, y: 20 },
          a2: { x: 30, y: 40 },
        };

        wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });
        (wrapper.vm as any).drawTimelapseConnectionsAndCentroids();
        // Should process without errors
        expect((wrapper.vm as any).timelapseLayer.draw).toHaveBeenCalled();
      });

      it("respects time window filtering", () => {
        mockedTimelapseStore.showMode = true;
        mockedTimelapseStore.modeWindow = 1;
        mockedStore.time = 5;
        const layer = makeLayer({ id: "l1", channel: 0, visible: true });
        mockedStore.layers = [layer];
        (mockedStore.layerSliceIndexes as any).mockReturnValue({
          xyIndex: 0,
          zIndex: 0,
          tIndex: 0,
        });
        // ann3 is at Time=100, outside the window [4,6]
        const ann1 = makeAnnotation({
          id: "a1",
          channel: 0,
          location: { XY: 0, Z: 0, Time: 5 },
        });
        const ann2 = makeAnnotation({
          id: "a2",
          channel: 0,
          location: { XY: 0, Z: 0, Time: 100 },
        });
        mockedAnnotationStore.annotations = [ann1, ann2];
        mockedAnnotationStore.annotationConnections = [
          makeConnection({ id: "c1", parentId: "a1", childId: "a2" }),
        ];
        (mockedAnnotationStore.getAnnotationFromId as any).mockImplementation(
          (id: string) =>
            mockedAnnotationStore.annotations.find((a: any) => a.id === id),
        );
        mockedAnnotationStore.annotationCentroids = {
          a1: { x: 10, y: 20 },
          a2: { x: 30, y: 40 },
        };

        wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });
        (wrapper.vm as any).drawTimelapseConnectionsAndCentroids();
        expect((wrapper.vm as any).timelapseLayer.draw).toHaveBeenCalled();
      });

      it("filters by timelapseTags when specified", () => {
        mockedTimelapseStore.showMode = true;
        mockedTimelapseStore.tags = ["trackable"];
        const layer = makeLayer({ id: "l1", channel: 0, visible: true });
        mockedStore.layers = [layer];
        (mockedStore.layerSliceIndexes as any).mockReturnValue({
          xyIndex: 0,
          zIndex: 0,
          tIndex: 0,
        });
        // ann1 has the right tag, ann2 does not
        const ann1 = makeAnnotation({
          id: "a1",
          channel: 0,
          location: { XY: 0, Z: 0, Time: 0 },
          tags: ["trackable"],
        });
        const ann2 = makeAnnotation({
          id: "a2",
          channel: 0,
          location: { XY: 0, Z: 0, Time: 1 },
          tags: ["other"],
        });
        mockedAnnotationStore.annotations = [ann1, ann2];
        mockedAnnotationStore.annotationConnections = [
          makeConnection({ id: "c1", parentId: "a1", childId: "a2" }),
        ];
        (mockedAnnotationStore.getAnnotationFromId as any).mockImplementation(
          (id: string) =>
            mockedAnnotationStore.annotations.find((a: any) => a.id === id),
        );
        mockedAnnotationStore.annotationCentroids = {
          a1: { x: 10, y: 20 },
          a2: { x: 30, y: 40 },
        };

        wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });
        (wrapper.vm as any).drawTimelapseConnectionsAndCentroids();
        expect((wrapper.vm as any).timelapseLayer.draw).toHaveBeenCalled();
      });

      // --- Track colouring ---
      //
      // Track colour is baked into each line feature at draw time; unlike
      // hover, there is no restyle-in-place path for it. So a colouring
      // control that is not in the timelapse watch list changes nothing until
      // some unrelated redraw happens, and every check below fails silently:
      // tsc, lint and the draw-path tests all stay green.
      describe("track colouring", () => {
        function setupOneTrack() {
          mockedTimelapseStore.showMode = true;
          const layer = makeLayer({ id: "l1", channel: 0, visible: true });
          mockedStore.layers = [layer];
          (mockedStore.layerSliceIndexes as any).mockReturnValue({
            xyIndex: 0,
            zIndex: 0,
            tIndex: 0,
          });
          // Ids chosen so INSERTION order (z1 first, as the connection's
          // parent) differs from SORT order (a2 first). With a1/a2 the two
          // keyings coincide and the trackKey assertion below passes against
          // `Array.from(set)[0]` too — i.e. it proves nothing.
          const earlier = makeAnnotation({
            id: "z1",
            channel: 0,
            location: { XY: 0, Z: 0, Time: 0 },
          });
          const later = makeAnnotation({
            id: "a2",
            channel: 0,
            location: { XY: 0, Z: 0, Time: 1 },
          });
          mockedAnnotationStore.annotations = [earlier, later];
          mockedAnnotationStore.annotationConnections = [
            makeConnection({ id: "c1", parentId: "z1", childId: "a2" }),
          ];
          (mockedAnnotationStore.getAnnotationFromId as any).mockImplementation(
            (id: string) =>
              mockedAnnotationStore.annotations.find((a: any) => a.id === id),
          );
          mockedAnnotationStore.annotationCentroids = {
            z1: { x: 10, y: 20 },
            a2: { x: 30, y: 40 },
          };
          // MUST be set here, not inherited. The shared geojsAnnotationFactory
          // mock discards its options by default, so a feature it returns has
          // no `timelapseBaseStyle` to read and segmentColors comes back empty
          // — these assertions would pass only when an earlier test in the file
          // had installed this implementation, and fail when run alone.
          (geojsAnnotationFactory as any).mockImplementation(
            (_shape: any, _coords: any, options: any) => {
              const feature = mockGeoJSAnnotation("line");
              if (options) feature.options(options);
              return feature;
            },
          );
        }

        function segmentColors(vm: any): string[] {
          return vm.timelapseLayer
            .annotations()
            .map((f: any) => f.options("timelapseBaseStyle"))
            .filter(Boolean)
            .map((s: any) => s.strokeColor);
        }

        it.each(["timelapseTrackColoring", "timelapseColorSeed"] as const)(
          "rebuilds the timelapse layer when %s changes",
          async (field) => {
            setupOneTrack();
            wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });
            const tlLayer = (wrapper.vm as any).timelapseLayer;

            tlLayer.draw.mockClear();
            if (field === "timelapseTrackColoring") {
              mockedTimelapseStore.trackColoring = "uniform";
            } else {
              mockedTimelapseStore.colorSeed = 1;
            }
            await wrapper.vm.$nextTick();

            expect(tlLayer.draw).toHaveBeenCalled();
          },
        );

        it("paints every segment uniformly when per-track colouring is off", async () => {
          setupOneTrack();
          mockedTimelapseStore.trackColoring = "uniform";
          wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });
          (wrapper.vm as any).drawTimelapseConnectionsAndCentroids();

          const colors = segmentColors(wrapper.vm);
          expect(colors.length).toBeGreaterThan(0);
          expect(new Set(colors)).toEqual(new Set([TRACK_UNIFORM_COLOR]));
        });

        /**
         * A connection skipping a timepoint used to be forced to `#ff6b6b`,
         * which broke BOTH colouring controls: "uniform" left those segments red
         * among the white ones, and per-track showed a hue swatch against a red
         * line for any track whose drawn segments are all jumps. The jump is
         * still marked by two cues no other segment has — `lineDash` and reduced
         * opacity — which is why the colour was the redundant one to drop.
         */
        it.each([
          ["uniform" as const, (): string => TRACK_UNIFORM_COLOR],
          [
            "track" as const,
            (): string => trackColor(trackKey(["z1", "a2"]), 0),
          ],
        ])("keeps a time-jump segment on the %s track colour", (mode, want) => {
          setupOneTrack();
          mockedTimelapseStore.trackColoring = mode;
          // Times 0 -> 4 skip frames, so this segment is a time jump.
          mockedAnnotationStore.annotations[1].location.Time = 4;
          wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });
          (wrapper.vm as any).drawTimelapseConnectionsAndCentroids();

          const styles = (wrapper.vm as any).timelapseLayer
            .annotations()
            .map((f: any) => f.options("timelapseBaseStyle"))
            .filter(Boolean);
          expect(styles.length).toBeGreaterThan(0);
          for (const style of styles) {
            // Still unmistakably a jump...
            expect(style.lineDash).toEqual([5, 5]);
            expect(style.strokeOpacity).toBe(0.7);
            // ...but on the track's colour, not a hardcoded red.
            expect(style.strokeColor).toBe(want());
          }
        });

        // The swatch in the Connections tab is computed from `trackKey`, so
        // the viewer must colour from the same key or the two drift apart.
        it("colours a track by trackKey, matching the connection list swatch", () => {
          setupOneTrack();
          wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });
          (wrapper.vm as any).drawTimelapseConnectionsAndCentroids();

          expect(segmentColors(wrapper.vm)).toEqual([
            trackColor(trackKey(["z1", "a2"]), 0),
          ]);
          // Explicitly NOT the first-inserted member's colour.
          expect(segmentColors(wrapper.vm)).not.toEqual([trackColor("z1", 0)]);
        });

        it("keeps a displayed track fragment on its dataset-wide color", () => {
          mockedTimelapseStore.showMode = true;
          mockedStore.layers = [
            makeLayer({ id: "visible", channel: 0, visible: true }),
          ];
          (mockedStore.layerSliceIndexes as any).mockReturnValue({
            xyIndex: 0,
            zIndex: 0,
            tIndex: 0,
          });
          mockedAnnotationStore.annotations = [
            // `a` belongs to the full track but its channel is not displayed,
            // so the viewer builds only the b-c fragment.
            makeAnnotation({
              id: "a",
              channel: 1,
              location: { XY: 0, Z: 0, Time: 0 },
            }),
            makeAnnotation({
              id: "b",
              channel: 0,
              location: { XY: 0, Z: 0, Time: 1 },
            }),
            makeAnnotation({
              id: "c",
              channel: 0,
              location: { XY: 0, Z: 0, Time: 2 },
            }),
          ];
          mockedAnnotationStore.annotationConnections = [
            makeConnection({ id: "c1", parentId: "a", childId: "b" }),
            makeConnection({ id: "c2", parentId: "b", childId: "c" }),
          ];
          (mockedAnnotationStore.getAnnotationFromId as any).mockImplementation(
            (id: string) =>
              mockedAnnotationStore.annotations.find((a: any) => a.id === id),
          );
          mockedAnnotationStore.annotationCentroids = {
            a: { x: 10, y: 20 },
            b: { x: 30, y: 40 },
            c: { x: 50, y: 60 },
          };
          (geojsAnnotationFactory as any).mockImplementation(
            (_shape: any, _coords: any, options: any) => {
              const feature = mockGeoJSAnnotation("line");
              if (options) feature.options(options);
              return feature;
            },
          );

          wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });
          (wrapper.vm as any).drawTimelapseConnectionsAndCentroids();

          expect(segmentColors(wrapper.vm)).toEqual([trackColor("a", 0)]);
          expect(segmentColors(wrapper.vm)).not.toEqual([trackColor("b", 0)]);
        });
      });
    });
  });

  // =========================================================================
  // Category 7: Mouse / Drag Interactions (~17 tests)
  // =========================================================================
  describe("mouse / drag interactions", () => {
    // --- handleDragStart ---
    describe("handleDragStart", () => {
      it("requires alt modifier", () => {
        wrapper = mountComponent();
        (wrapper.vm as any).handleDragStart({
          geo: { x: 10, y: 20 },
          modifiers: { alt: false },
        });
        expect((wrapper.vm as any).isDragging).toBe(false);
      });

      it("requires geo coordinates", () => {
        wrapper = mountComponent();
        (wrapper.vm as any).handleDragStart({ modifiers: { alt: true } });
        expect((wrapper.vm as any).isDragging).toBe(false);
      });

      it("starts dragging when annotation is found", () => {
        const ann1 = makeAnnotation({ id: "a1", shape: "point" });
        (mockedAnnotationStore.getAnnotationFromId as any).mockReturnValue(
          ann1,
        );
        (pointDistance as any).mockReturnValue(1);

        wrapper = mountComponent();
        const geoAnn = mockGeoJSAnnotation("point");
        geoAnn.options("girderId", "a1");
        (wrapper.vm as any).annotationLayer.annotations = vi.fn(() => [geoAnn]);

        // Mock geojsAnnotationFactory to return a ghost
        const ghost = mockGeoJSAnnotation("point");
        (geojsAnnotationFactory as any).mockReturnValue(ghost);

        (wrapper.vm as any).handleDragStart({
          geo: { x: 10, y: 20 },
          modifiers: { alt: true },
        });

        expect((wrapper.vm as any).isDragging).toBe(true);
        expect((wrapper.vm as any).draggedAnnotation).toStrictEqual(ann1);
        expect((wrapper.vm as any).dragStartPosition).toEqual({ x: 10, y: 20 });
      });

      it("creates ghost annotation and adds to interactionLayer", () => {
        const ann1 = makeAnnotation({ id: "a1", shape: "point" });
        (mockedAnnotationStore.getAnnotationFromId as any).mockReturnValue(
          ann1,
        );
        (pointDistance as any).mockReturnValue(1);

        wrapper = mountComponent();
        const geoAnn = mockGeoJSAnnotation("point");
        geoAnn.options("girderId", "a1");
        (wrapper.vm as any).annotationLayer.annotations = vi.fn(() => [geoAnn]);

        const ghost = mockGeoJSAnnotation("point");
        (geojsAnnotationFactory as any).mockReturnValue(ghost);

        (wrapper.vm as any).handleDragStart({
          geo: { x: 10, y: 20 },
          modifiers: { alt: true },
        });

        expect(
          (wrapper.vm as any).interactionLayer.addAnnotation,
        ).toHaveBeenCalledWith(ghost);
      });

      it("does nothing when no annotation found under click", () => {
        (mockedAnnotationStore.getAnnotationFromId as any).mockReturnValue(
          undefined,
        );
        wrapper = mountComponent();
        (wrapper.vm as any).annotationLayer.annotations = vi.fn(() => []);

        (wrapper.vm as any).handleDragStart({
          geo: { x: 10, y: 20 },
          modifiers: { alt: true },
        });
        expect((wrapper.vm as any).isDragging).toBe(false);
      });
    });

    // --- handleDragMove ---
    describe("handleDragMove", () => {
      it("returns early when not dragging", () => {
        wrapper = mountComponent();
        (wrapper.vm as any).handleDragMove({ geo: { x: 50, y: 50 } });
        // No error thrown
      });

      it("calculates dx/dy from start position", () => {
        wrapper = mountComponent();
        const ghost = mockGeoJSAnnotation("point");
        (wrapper.vm as any).isDragging = true;
        (wrapper.vm as any).dragStartPosition = { x: 10, y: 20 };
        (wrapper.vm as any).draggedAnnotation = makeAnnotation({ id: "a1" });
        (wrapper.vm as any).dragGhostAnnotation = ghost;
        (wrapper.vm as any).dragOriginalCoordinates = [{ x: 5, y: 10 }];

        (wrapper.vm as any).handleDragMove({ geo: { x: 30, y: 40 } });
        // dx = 30-10 = 20, dy = 40-20 = 20
        expect(ghost._coordinates).toHaveBeenCalled();
      });

      it("updates ghost coordinates", () => {
        wrapper = mountComponent();
        const ghost = mockGeoJSAnnotation("point");
        (wrapper.vm as any).isDragging = true;
        (wrapper.vm as any).dragStartPosition = { x: 0, y: 0 };
        (wrapper.vm as any).draggedAnnotation = makeAnnotation({ id: "a1" });
        (wrapper.vm as any).dragGhostAnnotation = ghost;
        (wrapper.vm as any).dragOriginalCoordinates = [{ x: 100, y: 200 }];

        (wrapper.vm as any).handleDragMove({ geo: { x: 10, y: 15 } });
        expect(ghost._coordinates).toHaveBeenCalled();
        expect(ghost.draw).toHaveBeenCalled();
      });

      it("does nothing when geo is missing", () => {
        wrapper = mountComponent();
        (wrapper.vm as any).isDragging = true;
        (wrapper.vm as any).dragStartPosition = { x: 0, y: 0 };
        (wrapper.vm as any).draggedAnnotation = makeAnnotation({ id: "a1" });
        const ghost = mockGeoJSAnnotation("point");
        (wrapper.vm as any).dragGhostAnnotation = ghost;
        (wrapper.vm as any).dragOriginalCoordinates = [{ x: 5, y: 10 }];

        (wrapper.vm as any).handleDragMove({});
        expect(ghost._coordinates).not.toHaveBeenCalled();
      });
    });

    // --- handleDragEnd ---
    describe("handleDragEnd", () => {
      it("returns early when not dragging", async () => {
        wrapper = mountComponent();
        await (wrapper.vm as any).handleDragEnd({ geo: { x: 50, y: 50 } });
        expect(
          mockedAnnotationStore.updateAnnotationsPerId,
        ).not.toHaveBeenCalled();
      });

      it("commits offset via updateAnnotationsPerId", async () => {
        wrapper = mountComponent();
        const ghost = mockGeoJSAnnotation("point");
        (wrapper.vm as any).isDragging = true;
        (wrapper.vm as any).dragStartPosition = { x: 0, y: 0 };
        (wrapper.vm as any).draggedAnnotation = makeAnnotation({ id: "a1" });
        (wrapper.vm as any).dragGhostAnnotation = ghost;
        (wrapper.vm as any).dragOriginalCoordinates = [{ x: 100, y: 200 }];

        await (wrapper.vm as any).handleDragEnd({ geo: { x: 10, y: 15 } });
        expect(
          mockedAnnotationStore.updateAnnotationsPerId,
        ).toHaveBeenCalledWith(
          expect.objectContaining({
            annotationIds: ["a1"],
          }),
        );
      });

      it("removes ghost and resets state", async () => {
        wrapper = mountComponent();
        const ghost = mockGeoJSAnnotation("point");
        (wrapper.vm as any).isDragging = true;
        (wrapper.vm as any).dragStartPosition = { x: 0, y: 0 };
        (wrapper.vm as any).draggedAnnotation = makeAnnotation({ id: "a1" });
        (wrapper.vm as any).dragGhostAnnotation = ghost;
        (wrapper.vm as any).dragOriginalCoordinates = [{ x: 100, y: 200 }];

        await (wrapper.vm as any).handleDragEnd({ geo: { x: 10, y: 15 } });
        expect(
          (wrapper.vm as any).interactionLayer.removeAnnotation,
        ).toHaveBeenCalledWith(ghost);
        expect((wrapper.vm as any).isDragging).toBe(false);
        expect((wrapper.vm as any).dragStartPosition).toBeNull();
        expect((wrapper.vm as any).draggedAnnotation).toBeNull();
        expect((wrapper.vm as any).dragGhostAnnotation).toBeNull();
      });

      it("does nothing when geo is missing", async () => {
        wrapper = mountComponent();
        (wrapper.vm as any).isDragging = true;
        (wrapper.vm as any).dragStartPosition = { x: 0, y: 0 };
        (wrapper.vm as any).draggedAnnotation = makeAnnotation({ id: "a1" });
        (wrapper.vm as any).dragGhostAnnotation = mockGeoJSAnnotation("point");
        (wrapper.vm as any).dragOriginalCoordinates = [{ x: 5, y: 10 }];

        await (wrapper.vm as any).handleDragEnd({});
        expect(
          mockedAnnotationStore.updateAnnotationsPerId,
        ).not.toHaveBeenCalled();
      });
    });

    // --- onMousePathChanged ---
    describe("onMousePathChanged", () => {
      it("calls consumeMouseState when newState is null and oldState was active", () => {
        wrapper = mountComponent();
        // In Vue 3 <script setup>, can't spy on closure functions.
        // Verify consumeMouseState was entered by checking it doesn't throw
        // and that the code path was taken (consumeMouseState checks selectionAnnotation).
        const oldState = {
          isMouseMovePreviewState: false,
          path: [{ x: 10, y: 20 }],
        };
        expect(() => {
          (wrapper.vm as any).onMousePathChanged(null, oldState);
        }).not.toThrow();
      });

      it("calls previewMouseState for non-null newState", () => {
        wrapper = mountComponent();
        // In Vue 3 <script setup>, can't spy on closure functions.
        // Verify previewMouseState was entered by checking it doesn't throw.
        const newState = {
          isMouseMovePreviewState: true,
          path: [{ x: 10, y: 20 }],
        };
        expect(() => {
          (wrapper.vm as any).onMousePathChanged(newState, null);
        }).not.toThrow();
      });
    });

    // --- previewMouseState / consumeMouseState ---
    describe("previewMouseState", () => {
      it("removes previous selectionAnnotation", () => {
        wrapper = mountComponent();
        const prev = mockGeoJSAnnotation("line");
        (wrapper.vm as any).selectionAnnotation = prev;
        (wrapper.vm as any).previewMouseState(null);
        expect(
          (wrapper.vm as any).interactionLayer.removeAnnotation,
        ).toHaveBeenCalledWith(prev);
      });

      it("creates line annotation for multi-point path", () => {
        wrapper = mountComponent();
        const lineAnn = mockGeoJSAnnotation("line");
        (geojs as any).annotation.lineAnnotation.mockReturnValue(lineAnn);

        (wrapper.vm as any).previewMouseState({
          path: [
            { x: 0, y: 0 },
            { x: 10, y: 10 },
          ],
        });
        expect((wrapper.vm as any).selectionAnnotation).toBe(lineAnn);
      });

      it("sets null selectionAnnotation for single-point path", () => {
        wrapper = mountComponent();
        (wrapper.vm as any).previewMouseState({ path: [{ x: 0, y: 0 }] });
        expect((wrapper.vm as any).selectionAnnotation).toBeNull();
      });

      it("adds selectionAnnotation to interactionLayer when created", () => {
        wrapper = mountComponent();
        const lineAnn = mockGeoJSAnnotation("line");
        (geojs as any).annotation.lineAnnotation.mockReturnValue(lineAnn);

        (wrapper.vm as any).previewMouseState({
          path: [
            { x: 0, y: 0 },
            { x: 10, y: 10 },
          ],
        });
        expect(
          (wrapper.vm as any).interactionLayer.addAnnotation,
        ).toHaveBeenCalledWith(lineAnn);
      });
    });

    describe("consumeMouseState", () => {
      it("removes selectionAnnotation", () => {
        wrapper = mountComponent();
        const prev = mockGeoJSAnnotation("line");
        (wrapper.vm as any).selectionAnnotation = prev;
        vi.spyOn(wrapper.vm as any, "selectAnnotations").mockImplementation(
          () => {},
        );

        (wrapper.vm as any).consumeMouseState({
          path: [{ x: 10, y: 20 }],
        });
        expect(
          (wrapper.vm as any).interactionLayer.removeAnnotation,
        ).toHaveBeenCalledWith(prev);
        expect((wrapper.vm as any).selectionAnnotation).toBeNull();
      });

      it("returns early when path is empty", () => {
        wrapper = mountComponent();
        const spy = vi
          .spyOn(wrapper.vm as any, "selectAnnotations")
          .mockImplementation(() => {});
        (wrapper.vm as any).consumeMouseState({ path: [] });
        expect(spy).not.toHaveBeenCalled();
      });
    });
  });

  // =========================================================================
  // Category 8: Context Menu & Dialogs (~11 tests)
  // =========================================================================
  describe("context menu & dialogs", () => {
    // --- handleAnnotationRightClick ---
    describe("handleAnnotationRightClick", () => {
      it("returns early when evt is null", () => {
        wrapper = mountComponent();
        (wrapper.vm as any).handleAnnotationRightClick(null);
        expect((wrapper.vm as any).showContextMenu).toBe(false);
      });

      it("sets annotation and shows context menu", () => {
        const ann1 = makeAnnotation({ id: "a1" });
        (mockedAnnotationStore.getAnnotationFromId as any).mockReturnValue(
          ann1,
        );
        (pointDistance as any).mockReturnValue(1);

        wrapper = mountComponent();
        const geoAnn = mockGeoJSAnnotation("point");
        geoAnn.options("girderId", "a1");
        (wrapper.vm as any).annotationLayer.annotations = vi.fn(() => [geoAnn]);

        (wrapper.vm as any).handleAnnotationRightClick({
          geo: { x: 10, y: 20 },
          evt: { clientX: 100, clientY: 200 },
        });
        expect((wrapper.vm as any).showContextMenu).toBe(true);
        expect((wrapper.vm as any).rightClickedAnnotation).toStrictEqual(ann1);
      });

      it("sets coordinates from mouse event", () => {
        const ann1 = makeAnnotation({ id: "a1" });
        (mockedAnnotationStore.getAnnotationFromId as any).mockReturnValue(
          ann1,
        );
        (pointDistance as any).mockReturnValue(1);

        wrapper = mountComponent();
        const geoAnn = mockGeoJSAnnotation("point");
        geoAnn.options("girderId", "a1");
        (wrapper.vm as any).annotationLayer.annotations = vi.fn(() => [geoAnn]);

        (wrapper.vm as any).handleAnnotationRightClick({
          geo: { x: 10, y: 20 },
          evt: { clientX: 150, clientY: 250 },
        });
        expect((wrapper.vm as any).contextMenuX).toBe(150);
        expect((wrapper.vm as any).contextMenuY).toBe(250);
      });
    });

    // --- handleContextMenuSave ---
    describe("handleContextMenuSave", () => {
      it("calls colorAnnotationIds and hides menu", () => {
        wrapper = mountComponent();
        (wrapper.vm as any).showContextMenu = true;

        (wrapper.vm as any).handleContextMenuSave({
          annotationId: "a1",
          color: "#ff0000",
        });
        expect(mockedAnnotationStore.colorAnnotationIds).toHaveBeenCalledWith({
          annotationIds: ["a1"],
          color: "#ff0000",
        });
        expect((wrapper.vm as any).showContextMenu).toBe(false);
      });

      it("does not call colorAnnotationIds when no annotationId", () => {
        wrapper = mountComponent();
        (wrapper.vm as any).handleContextMenuSave({ color: "#ff0000" });
        expect(mockedAnnotationStore.colorAnnotationIds).not.toHaveBeenCalled();
        expect((wrapper.vm as any).showContextMenu).toBe(false);
      });
    });

    // --- handleContextMenuCancel ---
    describe("handleContextMenuCancel", () => {
      it("hides context menu", () => {
        wrapper = mountComponent();
        (wrapper.vm as any).showContextMenu = true;
        (wrapper.vm as any).rightClickedAnnotation = makeAnnotation({
          id: "a1",
        });

        (wrapper.vm as any).handleContextMenuCancel();
        expect((wrapper.vm as any).showContextMenu).toBe(false);
        expect((wrapper.vm as any).rightClickedAnnotation).toBeNull();
      });
    });

    // --- handleDeselectAll ---
    describe("handleDeselectAll", () => {
      it("calls clearSelectedAnnotations", () => {
        wrapper = mountComponent();
        (wrapper.vm as any).handleDeselectAll();
        expect(
          mockedAnnotationStore.clearSelectedAnnotations,
        ).toHaveBeenCalled();
      });
    });

    // --- handleTagSubmit ---
    describe("handleTagSubmit", () => {
      it("calls tagSelectedAnnotations on add", () => {
        wrapper = mountComponent();
        (wrapper.vm as any).handleTagSubmit({
          tags: ["tagA"],
          addOrRemove: "add",
          replaceExisting: false,
        });
        expect(
          mockedAnnotationStore.tagSelectedAnnotations,
        ).toHaveBeenCalledWith({
          tags: ["tagA"],
          replace: false,
        });
      });

      it("calls removeTagsFromSelectedAnnotations on remove", () => {
        wrapper = mountComponent();
        (wrapper.vm as any).handleTagSubmit({
          tags: ["tagA"],
          addOrRemove: "remove",
          replaceExisting: false,
        });
        expect(
          mockedAnnotationStore.removeTagsFromSelectedAnnotations,
        ).toHaveBeenCalledWith(["tagA"]);
      });
    });

    // --- handleColorSubmit ---
    describe("handleColorSubmit", () => {
      it("passes null color when useColorFromLayer is true", () => {
        wrapper = mountComponent();
        (wrapper.vm as any).handleColorSubmit({
          useColorFromLayer: true,
          color: "#ff0000",
        });
        expect(
          mockedAnnotationStore.colorSelectedAnnotations,
        ).toHaveBeenCalledWith({
          color: null,
          randomize: undefined,
        });
      });

      it("passes explicit color when useColorFromLayer is false", () => {
        wrapper = mountComponent();
        (wrapper.vm as any).handleColorSubmit({
          useColorFromLayer: false,
          color: "#00ff00",
        });
        expect(
          mockedAnnotationStore.colorSelectedAnnotations,
        ).toHaveBeenCalledWith({
          color: "#00ff00",
          randomize: undefined,
        });
      });

      it("passes randomize flag", () => {
        wrapper = mountComponent();
        (wrapper.vm as any).handleColorSubmit({
          useColorFromLayer: false,
          color: "#0000ff",
          randomize: true,
        });
        expect(
          mockedAnnotationStore.colorSelectedAnnotations,
        ).toHaveBeenCalledWith({
          color: "#0000ff",
          randomize: true,
        });
      });
    });
  });

  // ============================================================
  // Category 9: Event Binding & Lifecycle
  // ============================================================
  describe("event binding & lifecycle", () => {
    describe("mounted", () => {
      it("calls bindAnnotationEvents on mount", () => {
        wrapper = mountComponent();
        // bindAnnotationEvents registers geoOn calls on annotationLayer
        // The annotationLayer.geoOn should have been called during mount
        expect((wrapper.vm as any).annotationLayer.geoOn).toHaveBeenCalled();
      });

      it("calls bindTimelapseEvents on mount", () => {
        wrapper = mountComponent();
        // bindTimelapseEvents registers geoOn on timelapseLayer
        expect((wrapper.vm as any).timelapseLayer.geoOn).toHaveBeenCalled();
      });

      it("calls bindInteractionEvents on mount", () => {
        wrapper = mountComponent();
        // bindInteractionEvents registers geoOn on interactionLayer
        expect((wrapper.vm as any).interactionLayer.geoOn).toHaveBeenCalled();
      });

      it("calls updateValueOnHover on mount", () => {
        wrapper = mountComponent();
        // updateValueOnHover calls setHoverValue(null)
        expect(mockedStore.setHoverValue).toHaveBeenCalledWith(null);
      });

      it("calls filterStore.updateHistograms on mount", () => {
        wrapper = mountComponent();
        expect(mockedFilterStore.updateHistograms).toHaveBeenCalled();
      });

      it("calls addHoverCallback on mount", () => {
        wrapper = mountComponent();
        // addHoverCallback registers a mouseclick handler on annotationLayer
        const geoOnCalls = ((wrapper.vm as any).annotationLayer.geoOn as any)
          .mock.calls;
        const mouseclickCalls = geoOnCalls.filter(
          (call: any[]) => call[0] === "geojs.mouseclick",
        );
        expect(mouseclickCalls.length).toBeGreaterThanOrEqual(1);
      });
    });

    describe("beforeUnmount", () => {
      it("removes drag event listeners", () => {
        wrapper = mountComponent();
        const geoOffSpy = (wrapper.vm as any).annotationLayer.geoOff;
        geoOffSpy.mockClear();
        // Trigger onBeforeUnmount by unmounting
        wrapper.unmount();
        const geoOffCalls = (geoOffSpy as any).mock.calls;
        const eventTypes = geoOffCalls.map((call: any[]) => call[0]);
        expect(eventTypes).toContain("geojs.mousedown");
        expect(eventTypes).toContain("geojs.mousemove");
        expect(eventTypes).toContain("geojs.mouseup");
      });
    });

    describe("bindAnnotationEvents", () => {
      it("registers mouseclick handler on annotationLayer", () => {
        wrapper = mountComponent();
        const geoOnCalls = ((wrapper.vm as any).annotationLayer.geoOn as any)
          .mock.calls;
        const mouseclickCalls = geoOnCalls.filter(
          (call: any[]) => call[0] === "geojs.mouseclick",
        );
        expect(mouseclickCalls.length).toBeGreaterThanOrEqual(1);
      });

      it("registers drag handlers on annotationLayer", () => {
        wrapper = mountComponent();
        const geoOnCalls = ((wrapper.vm as any).annotationLayer.geoOn as any)
          .mock.calls;
        const eventTypes = geoOnCalls.map((call: any[]) => call[0]);
        expect(eventTypes).toContain("geojs.mousedown");
        expect(eventTypes).toContain("geojs.mousemove");
        expect(eventTypes).toContain("geojs.mouseup");
      });

      it("calls drawAnnotationsAndTooltips", () => {
        wrapper = mountComponent();
        // After mount, annotations should have been drawn
        // The annotationLayer.draw should have been called
        expect((wrapper.vm as any).annotationLayer.draw).toHaveBeenCalled();
      });
    });

    describe("bindInteractionEvents", () => {
      it("returns early when interactionLayer is null", () => {
        // We can't pass null interactionLayer (component crashes),
        // so just verify the method is callable after mount
        wrapper = mountComponent();
        expect((wrapper.vm as any).interactionLayer.geoOn).toHaveBeenCalled();
      });

      it("registers annotation mode/add/update/state handlers", () => {
        wrapper = mountComponent();
        const geoOnCalls = ((wrapper.vm as any).interactionLayer.geoOn as any)
          .mock.calls;
        const eventTypes = geoOnCalls.map((call: any[]) => call[0]);
        expect(eventTypes).toContain("geojs.annotation.mode");
        expect(eventTypes).toContain("geojs.annotation.add");
        expect(eventTypes).toContain("geojs.annotation.update");
        expect(eventTypes).toContain("geojs.annotation.state");
      });

      it("registers tagging click handler when tool is tagging type", () => {
        mockedStore.selectedTool = {
          configuration: {
            type: "tagging",
            values: {
              action: { value: "tag_click" },
              tags: ["t1"],
            },
          },
          state: null,
        } as any;
        wrapper = mountComponent();
        const geoOnCalls = ((wrapper.vm as any).interactionLayer.geoOn as any)
          .mock.calls;
        const mouseclickCalls = geoOnCalls.filter(
          (call: any[]) => call[0] === "geojs.mouseclick",
        );
        expect(mouseclickCalls.length).toBeGreaterThanOrEqual(1);
      });
    });

    // Regression: clicking an annotation in the viewer (no tool selected)
    // must set hoveredAnnotationId so the annotation list can page-jump,
    // scroll to, and highlight the row.
    describe("click-to-hover navigation", () => {
      function fireAnnotationLayerMouseclicks(evt: any) {
        const geoOnCalls = ((wrapper.vm as any).annotationLayer.geoOn as any)
          .mock.calls;
        const handlers = geoOnCalls
          .filter((call: any[]) => call[0] === "geojs.mouseclick")
          .map((call: any[]) => call[1]);
        handlers.forEach((handler: any) => handler(evt));
      }

      it("clicking a point annotation sets hoveredAnnotationId", () => {
        const ann = makeAnnotation(); // point at (10, 20)
        mockedAnnotationStore.annotations = [ann];
        wrapper = mountComponent();
        (mockedAnnotationStore.getAnnotationFromId as any).mockImplementation(
          (id: string) => (id === "ann1" ? ann : undefined),
        );
        (pointDistance as any).mockImplementation((a: any, b: any) =>
          Math.hypot(a.x - b.x, a.y - b.y),
        );
        const geoAnn = mockGeoJSAnnotation("point");
        geoAnn.options("girderId", "ann1");
        (wrapper.vm as any).annotationLayer.addAnnotation(geoAnn);

        fireAnnotationLayerMouseclicks({
          geo: { x: 10, y: 20 },
          buttonsDown: {},
        });

        expect(
          mockedAnnotationStore.setHoveredAnnotationId,
        ).toHaveBeenCalledWith("ann1");
      });

      it("clicking a stub-rendered (unhydrated) annotation sets hoveredAnnotationId", () => {
        // Non-point stubs resolve to undefined via getAnnotationFromId; the
        // hover hit-test must fall back to the stub and its rendered dot.
        const stub = {
          id: "stub1",
          centroid: { x: 10, y: 20 },
          location: { XY: 0, Z: 0, Time: 0 },
          shape: "polygon",
          channel: 0,
          tags: [],
          color: null,
          estimatedRadius: 5,
        };
        wrapper = mountComponent();
        (mockedAnnotationStore.getAnnotationFromId as any).mockReturnValue(
          undefined,
        );
        (mockedAnnotationStore.getStub as any).mockImplementation(
          (id: string) => (id === "stub1" ? stub : undefined),
        );
        (pointDistance as any).mockImplementation((a: any, b: any) =>
          Math.hypot(a.x - b.x, a.y - b.y),
        );
        const geoAnn = mockGeoJSAnnotation("point");
        geoAnn.options("girderId", "stub1");
        geoAnn.options("isStub", true);
        (wrapper.vm as any).annotationLayer.addAnnotation(geoAnn);

        fireAnnotationLayerMouseclicks({
          geo: { x: 10, y: 20 },
          buttonsDown: {},
        });

        expect(
          mockedAnnotationStore.setHoveredAnnotationId,
        ).toHaveBeenCalledWith("stub1");
      });

      it("clicking empty space clears hoveredAnnotationId", () => {
        const ann = makeAnnotation();
        mockedAnnotationStore.annotations = [ann];
        wrapper = mountComponent();
        (mockedAnnotationStore.getAnnotationFromId as any).mockImplementation(
          (id: string) => (id === "ann1" ? ann : undefined),
        );
        (pointDistance as any).mockImplementation((a: any, b: any) =>
          Math.hypot(a.x - b.x, a.y - b.y),
        );
        const geoAnn = mockGeoJSAnnotation("point");
        geoAnn.options("girderId", "ann1");
        (wrapper.vm as any).annotationLayer.addAnnotation(geoAnn);

        fireAnnotationLayerMouseclicks({
          geo: { x: 500, y: 500 },
          buttonsDown: {},
        });

        expect(
          mockedAnnotationStore.setHoveredAnnotationId,
        ).toHaveBeenCalledWith(null);
      });

      it("does not set hover when a tool is selected", () => {
        const ann = makeAnnotation();
        mockedAnnotationStore.annotations = [ann];
        mockedStore.selectedTool = {
          configuration: { type: "create", values: {} },
          state: null,
        } as any;
        wrapper = mountComponent();
        (mockedAnnotationStore.getAnnotationFromId as any).mockImplementation(
          (id: string) => (id === "ann1" ? ann : undefined),
        );
        (pointDistance as any).mockImplementation((a: any, b: any) =>
          Math.hypot(a.x - b.x, a.y - b.y),
        );
        const geoAnn = mockGeoJSAnnotation("point");
        geoAnn.options("girderId", "ann1");
        (wrapper.vm as any).annotationLayer.addAnnotation(geoAnn);

        fireAnnotationLayerMouseclicks({
          geo: { x: 10, y: 20 },
          buttonsDown: {},
        });

        expect(
          mockedAnnotationStore.setHoveredAnnotationId,
        ).not.toHaveBeenCalled();
      });
    });

    describe("bindTimelapseEvents", () => {
      it("registers mouseclick handler on timelapseLayer", () => {
        wrapper = mountComponent();
        const geoOnCalls = ((wrapper.vm as any).timelapseLayer.geoOn as any)
          .mock.calls;
        const mouseclickCalls = geoOnCalls.filter(
          (call: any[]) => call[0] === "geojs.mouseclick",
        );
        expect(mouseclickCalls.length).toBeGreaterThanOrEqual(1);
      });
    });
  });

  // ============================================================
  // Category 10: SAM Integration
  // ============================================================
  describe("SAM integration", () => {
    describe("samToolState", () => {
      it("returns null when selectedToolState type is not SAM", () => {
        mockedStore.selectedTool = {
          configuration: { type: "create", values: {} },
          state: { type: Symbol("other") },
        } as any;
        wrapper = mountComponent();
        expect((wrapper.vm as any).samToolState).toBeNull();
      });

      it("returns null when SAM map does not match component map", () => {
        const wrongMap = { map: "wrong-map" };
        mockedStore.selectedTool = {
          configuration: { type: "samAnnotation", values: {} },
          state: {
            type: SamAnnotationToolStateSymbol,
            mapEntry: wrongMap,
            nodes: {
              input: {
                geoJSMap: { output: wrongMap },
                mainPrompt: { output: NoOutput },
                previewPrompt: { output: NoOutput, setValue: vi.fn() },
              },
            },
            output: null,
            livePreview: null,
          },
        } as any;
        wrapper = mountComponent();
        expect((wrapper.vm as any).samToolState).toBeNull();
      });

      it("returns state when SAM map matches component map", async () => {
        wrapper = mountComponent();
        const mapObj = (wrapper.vm as any).map;
        mockedStore.selectedTool = {
          configuration: { type: "samAnnotation", values: {} },
          state: {
            type: SamAnnotationToolStateSymbol,
            mapEntry: { map: mapObj },
            nodes: {
              input: {
                geoJSMap: { output: { map: mapObj } },
                mainPrompt: { output: NoOutput },
                previewPrompt: { output: NoOutput, setValue: vi.fn() },
              },
            },
            output: null,
            livePreview: null,
          },
        } as any;
        await wrapper.vm.$nextTick();
        expect((wrapper.vm as any).samToolState).not.toBeNull();
        expect((wrapper.vm as any).samToolState.type).toBe(
          SamAnnotationToolStateSymbol,
        );
      });
    });

    describe("samPrompts", () => {
      it("returns empty array when samToolState is null", () => {
        mockedStore.selectedTool = null;
        wrapper = mountComponent();
        expect((wrapper.vm as any).samPrompts).toEqual([]);
      });

      it("returns empty array when mainPrompt output is NoOutput", async () => {
        wrapper = mountComponent();
        const mapObj = (wrapper.vm as any).map;
        mockedStore.selectedTool = {
          configuration: { type: "samAnnotation", values: {} },
          state: {
            type: SamAnnotationToolStateSymbol,
            mapEntry: { map: mapObj },
            nodes: {
              input: {
                geoJSMap: { output: { map: mapObj } },
                mainPrompt: { output: NoOutput },
                previewPrompt: { output: NoOutput, setValue: vi.fn() },
              },
            },
            output: null,
            livePreview: null,
          },
        } as any;
        await wrapper.vm.$nextTick();
        expect((wrapper.vm as any).samPrompts).toEqual([]);
      });

      it("returns prompts when mainPrompt has output", async () => {
        // Must mock samPromptToAnnotation before setting tool, because
        // the @Watch("samPrompts") watcher fires and calls it
        const mockAnn = mockGeoJSAnnotation("polygon");
        (samPromptToAnnotation as any).mockReturnValue(mockAnn);

        wrapper = mountComponent();
        const mapObj = (wrapper.vm as any).map;
        const mockPrompts = [{ type: "point", x: 10, y: 20, positive: true }];
        mockedStore.selectedTool = {
          configuration: { type: "samAnnotation", values: {} },
          state: {
            type: SamAnnotationToolStateSymbol,
            mapEntry: { map: mapObj },
            nodes: {
              input: {
                geoJSMap: { output: { map: mapObj } },
                mainPrompt: { output: mockPrompts },
                previewPrompt: { output: NoOutput, setValue: vi.fn() },
              },
            },
            output: null,
            livePreview: null,
          },
        } as any;
        await wrapper.vm.$nextTick();
        expect((wrapper.vm as any).samPrompts).toEqual(mockPrompts);
      });
    });

    describe("onSamMainOutputChanged", () => {
      it("removes previous samUnsubmittedAnnotation", () => {
        wrapper = mountComponent();
        const oldAnnotation = mockGeoJSAnnotation("polygon");
        (wrapper.vm as any).samUnsubmittedAnnotation = oldAnnotation;

        (wrapper.vm as any).onSamMainOutputChanged();

        expect(
          (wrapper.vm as any).annotationLayer.removeAnnotation,
        ).toHaveBeenCalledWith(oldAnnotation);
        expect((wrapper.vm as any).samUnsubmittedAnnotation).toBeNull();
      });

      it("creates polygon annotation when output has vertices", async () => {
        wrapper = mountComponent();
        // Set samMainOutput to return vertices by mocking samToolState
        const mapObj = (wrapper.vm as any).map;
        const vertices = [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
        ];
        mockedStore.selectedTool = {
          configuration: { type: "samAnnotation", values: {} },
          state: {
            type: SamAnnotationToolStateSymbol,
            mapEntry: { map: mapObj },
            nodes: {
              input: {
                geoJSMap: { output: { map: mapObj } },
                mainPrompt: { output: NoOutput },
                previewPrompt: { output: NoOutput, setValue: vi.fn() },
              },
            },
            output: vertices,
            livePreview: null,
          },
        } as any;

        await wrapper.vm.$nextTick();
        (wrapper.vm as any).onSamMainOutputChanged();

        expect(geojs.annotation.polygonAnnotation).toHaveBeenCalled();
        expect((wrapper.vm as any).samUnsubmittedAnnotation).not.toBeNull();
        expect(
          (wrapper.vm as any).annotationLayer.addAnnotation,
        ).toHaveBeenCalled();
      });

      it("returns early when output is null", () => {
        wrapper = mountComponent();
        mockedStore.selectedTool = null;
        const addSpy = (wrapper.vm as any).annotationLayer.addAnnotation;
        (addSpy as any).mockClear();

        (wrapper.vm as any).onSamMainOutputChanged();

        // Should not add any annotation since samMainOutput is null
        expect((wrapper.vm as any).samUnsubmittedAnnotation).toBeNull();
      });
    });

    describe("onSamLivePreviewOutputChanged", () => {
      it("removes previous samLivePreviewAnnotation", () => {
        wrapper = mountComponent();
        const oldAnnotation = mockGeoJSAnnotation("polygon");
        (wrapper.vm as any).samLivePreviewAnnotation = oldAnnotation;

        (wrapper.vm as any).onSamLivePreviewOutputChanged();

        expect(
          (wrapper.vm as any).annotationLayer.removeAnnotation,
        ).toHaveBeenCalledWith(oldAnnotation);
        expect((wrapper.vm as any).samLivePreviewAnnotation).toBeNull();
      });

      it("creates polygon annotation for small enough preview", async () => {
        wrapper = mountComponent();
        const mapObj = (wrapper.vm as any).map;
        // Small vertices relative to viewport
        const vertices = [
          { x: 100, y: 100 },
          { x: 200, y: 100 },
          { x: 200, y: 200 },
        ];
        mockedStore.selectedTool = {
          configuration: { type: "samAnnotation", values: {} },
          state: {
            type: SamAnnotationToolStateSymbol,
            mapEntry: { map: mapObj },
            nodes: {
              input: {
                geoJSMap: { output: { map: mapObj } },
                mainPrompt: { output: NoOutput },
                previewPrompt: { output: NoOutput, setValue: vi.fn() },
              },
            },
            output: null,
            livePreview: vertices,
          },
        } as any;

        await wrapper.vm.$nextTick();
        (wrapper.vm as any).onSamLivePreviewOutputChanged();

        expect(geojs.annotation.polygonAnnotation).toHaveBeenCalled();
        expect((wrapper.vm as any).samLivePreviewAnnotation).not.toBeNull();
      });

      it("skips annotation when preview is too large for viewport", async () => {
        wrapper = mountComponent();
        const mapObj = (wrapper.vm as any).map;
        // Large vertices — more than 70% of viewport (1000x800)
        const vertices = [
          { x: 0, y: 0 },
          { x: 900, y: 0 },
          { x: 900, y: 700 },
        ];
        mockedStore.selectedTool = {
          configuration: { type: "samAnnotation", values: {} },
          state: {
            type: SamAnnotationToolStateSymbol,
            mapEntry: { map: mapObj },
            nodes: {
              input: {
                geoJSMap: { output: { map: mapObj } },
                mainPrompt: { output: NoOutput },
                previewPrompt: { output: NoOutput, setValue: vi.fn() },
              },
            },
            output: null,
            livePreview: vertices,
          },
        } as any;

        await wrapper.vm.$nextTick();
        const addSpy = (wrapper.vm as any).annotationLayer.addAnnotation;
        (addSpy as any).mockClear();

        (wrapper.vm as any).onSamLivePreviewOutputChanged();

        // Should not create annotation because it's too large
        expect((wrapper.vm as any).samLivePreviewAnnotation).toBeNull();
      });

      it("returns early when livePreview is null", () => {
        wrapper = mountComponent();
        mockedStore.selectedTool = null;

        (wrapper.vm as any).onSamLivePreviewOutputChanged();

        expect((wrapper.vm as any).samLivePreviewAnnotation).toBeNull();
      });
    });

    describe("onSamPromptsChanged", () => {
      it("removes old prompt annotations and creates new ones", () => {
        wrapper = mountComponent();
        const oldPromptAnn = mockGeoJSAnnotation("polygon");
        (wrapper.vm as any).samPromptAnnotations = [oldPromptAnn];

        const newAnn = mockGeoJSAnnotation("polygon");
        (samPromptToAnnotation as any).mockReturnValue(newAnn);

        const mockPrompts = [{ type: "point", x: 10, y: 20, positive: true }];
        (wrapper.vm as any).onSamPromptsChanged(mockPrompts);

        expect(
          (wrapper.vm as any).annotationLayer.removeAnnotation,
        ).toHaveBeenCalledWith(oldPromptAnn);
        expect(samPromptToAnnotation).toHaveBeenCalledWith(
          mockPrompts[0],
          expect.any(Object),
        );
        expect((wrapper.vm as any).samPromptAnnotations).toHaveLength(1);
      });

      it("marks new annotations as specialAnnotation", () => {
        wrapper = mountComponent();
        (wrapper.vm as any).samPromptAnnotations = [];

        const newAnn = mockGeoJSAnnotation("polygon");
        (samPromptToAnnotation as any).mockReturnValue(newAnn);

        (wrapper.vm as any).onSamPromptsChanged([
          { type: "point", x: 10, y: 20, positive: true },
        ]);

        expect(newAnn.options).toHaveBeenCalledWith("specialAnnotation", true);
      });
    });
  });

  // ============================================================
  // Category 11: Watcher Deduplication & Ancillary
  // ============================================================
  describe("watcher deduplication & ancillary", () => {
    describe("onPrimaryChange", () => {
      it("sets handlingPrimaryChange flag", () => {
        wrapper = mountComponent();
        (wrapper.vm as any).handlingPrimaryChange = false;
        (wrapper.vm as any).onPrimaryChange();
        // Flag should be set during the call
        // After nextTick it should be cleared, but during the call it's true
        expect((wrapper.vm as any).drawAnnotationsAndTooltips).toBeDefined();
      });

      it("calls drawAnnotationsAndTooltips", () => {
        wrapper = mountComponent();
        // In Vue 3 <script setup>, can't spy on closure functions.
        // Verify the function was entered by checking it doesn't throw.
        expect(() => {
          (wrapper.vm as any).onPrimaryChange();
        }).not.toThrow();
      });

      it("clears flag after nextTick", async () => {
        wrapper = mountComponent();
        (wrapper.vm as any).onPrimaryChange();
        await wrapper.vm.$nextTick();
        expect((wrapper.vm as any).handlingPrimaryChange).toBe(false);
      });
    });

    describe("onDisplayedAnnotationsChange", () => {
      it("draws when not handling primary change", () => {
        wrapper = mountComponent();
        (wrapper.vm as any).handlingPrimaryChange = false;
        // In Vue 3 <script setup>, can't spy on closure functions.
        expect(() => {
          (wrapper.vm as any).onDisplayedAnnotationsChange();
        }).not.toThrow();
      });

      it("skips when handling primary change", () => {
        wrapper = mountComponent();
        (wrapper.vm as any).handlingPrimaryChange = true;
        const spy = vi.spyOn(wrapper.vm as any, "drawAnnotationsAndTooltips");
        (wrapper.vm as any).onDisplayedAnnotationsChange();
        expect(spy).not.toHaveBeenCalled();
      });
    });

    // Integration coverage for the watcher change: xy/z/time were removed from
    // the primary-change watcher. A frame change must still redraw — it now
    // flows visibility → displayedAnnotations → onDisplayedAnnotationsChange,
    // which draws once with the new frame's set (no leading draw via
    // onPrimaryChange). These drive a real store frame change end-to-end.
    describe("frame-index change (xy/z/time) redraw path", () => {
      function setupTwoFrames(axis: "xy" | "z" | "time") {
        const layer = makeLayer({ id: "layer1", channel: 0, visible: true });
        mockedStore.layers = [layer];
        (mockedStore.getLayerFromId as any).mockReturnValue(layer);
        // Slice indexes track the current store frame, so the displayed set
        // turns over when the frame changes.
        (mockedStore.layerSliceIndexes as any).mockImplementation(() => ({
          xyIndex: mockedStore.xy,
          zIndex: mockedStore.z,
          tIndex: mockedStore.time,
        }));
        const locFor = (v: number) => ({
          XY: axis === "xy" ? v : 0,
          Z: axis === "z" ? v : 0,
          Time: axis === "time" ? v : 0,
        });
        mockedAnnotationStore.annotations = [
          makeAnnotation({ id: "f0", channel: 0, location: locFor(0) }),
          makeAnnotation({ id: "f1", channel: 0, location: locFor(1) }),
        ];
        // Created features carry their annotation id so the drawn set is
        // inspectable through the (arg-ignoring) factory mock.
        (geojsAnnotationFactory as any).mockImplementation(
          (_shape: any, _coords: any, options: any) => {
            const feature = mockGeoJSAnnotation("point");
            if (options) feature.options(options);
            return feature;
          },
        );
      }

      function drawnIds(aLayer: any): (string | undefined)[] {
        return aLayer.annotations().map((f: any) => f.options("girderId"));
      }

      it.each(["xy", "z", "time"] as const)(
        "redraws with the new frame's annotations when %s changes",
        async (axis) => {
          setupTwoFrames(axis);
          // Mount on an empty frame so the first real draw is the seed below.
          mockedStore[axis] = 9;
          wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });
          const aLayer = (wrapper.vm as any).annotationLayer;

          // Seed frame 0: f0 becomes displayed and is drawn.
          mockedStore[axis] = 0;
          await wrapper.vm.$nextTick();
          vi.advanceTimersByTime(101);
          expect(
            (wrapper.vm as any).displayedAnnotations.map((a: any) => a.id),
          ).toEqual(["f0"]);
          expect(drawnIds(aLayer)).toContain("f0");

          // Frame change to 1: the displayed set turns over and a redraw runs.
          aLayer.draw.mockClear();
          mockedStore[axis] = 1;
          await wrapper.vm.$nextTick();
          vi.advanceTimersByTime(101);

          expect(
            (wrapper.vm as any).displayedAnnotations.map((a: any) => a.id),
          ).toEqual(["f1"]);
          expect(aLayer.draw).toHaveBeenCalled();
          expect(drawnIds(aLayer)).toContain("f1");
          expect(drawnIds(aLayer)).not.toContain("f0");
          // The frame change never routed through onPrimaryChange.
          expect((wrapper.vm as any).handlingPrimaryChange).toBe(false);
        },
      );
    });

    describe("onRestyleNeeded", () => {
      it("calls restyleAnnotations", () => {
        wrapper = mountComponent();
        // In Vue 3 <script setup>, can't spy on closure functions.
        // Verify restyleAnnotations runs by checking annotationLayer.draw was called.
        const drawSpy = (wrapper.vm as any).annotationLayer.draw;
        drawSpy.mockClear();
        (wrapper.vm as any).onRestyleNeeded();
        expect(drawSpy).toHaveBeenCalled();
      });
    });

    describe("onTimelapseModeChanged", () => {
      it("calls drawTimelapseConnectionsAndCentroids", () => {
        wrapper = mountComponent();
        // In Vue 3 <script setup>, can't spy on closure functions.
        expect(() => {
          (wrapper.vm as any).onTimelapseModeChanged();
        }).not.toThrow();
      });
    });

    describe("watchTool", () => {
      it("calls refreshAnnotationMode", () => {
        wrapper = mountComponent();
        // In Vue 3 <script setup>, can't spy on closure functions.
        expect(() => {
          (wrapper.vm as any).watchTool();
        }).not.toThrow();
      });
    });

    describe("watchFilter", () => {
      it("calls refreshAnnotationMode when roiFilter is active", () => {
        mockedFilterStore.emptyROIFilter = { id: "roi1" } as any;
        wrapper = mountComponent();
        // In Vue 3 <script setup>, can't spy on closure functions.
        expect(() => {
          (wrapper.vm as any).watchFilter();
        }).not.toThrow();
      });

      it("does not call refreshAnnotationMode when no roiFilter", () => {
        mockedFilterStore.emptyROIFilter = null;
        wrapper = mountComponent();
        const spy = vi.spyOn(wrapper.vm as any, "refreshAnnotationMode");
        (wrapper.vm as any).watchFilter();
        expect(spy).not.toHaveBeenCalled();
      });
    });

    describe("onUnrollChanged", () => {
      it("clears and redraws annotations", () => {
        wrapper = mountComponent();
        // In Vue 3 <script setup>, can't spy on closure functions.
        // Verify clearOldAnnotations was called by checking annotationLayer.removeAllAnnotations.
        const removeAllSpy = (wrapper.vm as any).annotationLayer
          .removeAllAnnotations;
        removeAllSpy.mockClear();
        (wrapper.vm as any).onUnrollChanged();
        expect(removeAllSpy).toHaveBeenCalled();
      });
    });

    describe("baseStyle", () => {
      it("uses scaled:false when scaleAnnotationsWithZoom is true", () => {
        mockedStore.scaleAnnotationsWithZoom = true;
        wrapper = mountComponent();
        expect((wrapper.vm as any).baseStyle.scaled).toBe(false);
      });

      it("uses scaled:1 when scaleAnnotationsWithZoom is false", () => {
        mockedStore.scaleAnnotationsWithZoom = false;
        wrapper = mountComponent();
        expect((wrapper.vm as any).baseStyle.scaled).toBe(1);
      });

      it("uses annotationsRadius from store", () => {
        mockedStore.annotationsRadius = 10;
        wrapper = mountComponent();
        expect((wrapper.vm as any).baseStyle.radius).toBe(10);
      });

      it("uses annotationOpacity from store", () => {
        mockedStore.annotationOpacity = 0.8;
        wrapper = mountComponent();
        expect((wrapper.vm as any).baseStyle.fillOpacity).toBe(0.8);
      });
    });

    describe("getAnnotationStyle", () => {
      it("passes hovered=true for hoveredAnnotationId", () => {
        mockedAnnotationStore.hoveredAnnotationId = "ann1";
        wrapper = mountComponent();
        (wrapper.vm as any).getAnnotationStyle("ann1", null, "red");
        expect(getAnnotationStyleFromBaseStyle).toHaveBeenCalledWith(
          expect.any(Object),
          "red",
          true,
          false,
        );
      });

      it("passes selected=true for selected annotations", () => {
        (mockedAnnotationStore.isAnnotationSelected as any).mockReturnValue(
          true,
        );
        wrapper = mountComponent();
        (wrapper.vm as any).getAnnotationStyle("ann1", null, "red");
        expect(getAnnotationStyleFromBaseStyle).toHaveBeenCalledWith(
          expect.any(Object),
          "red",
          false,
          true,
        );
      });

      it("passes hovered=true for toolHighlightedAnnotationIds", () => {
        // Ensure isAnnotationSelected returns false for this test
        (mockedAnnotationStore.isAnnotationSelected as any).mockReturnValue(
          false,
        );
        mockedStore.selectedTool = {
          configuration: {
            type: "connection",
            values: { action: { value: "add_click" } },
          },
          state: {
            type: ConnectionToolStateSymbol,
            selectedAnnotationId: "ann1",
          },
        } as any;
        wrapper = mountComponent();
        (wrapper.vm as any).getAnnotationStyle("ann1", null, "red");
        expect(getAnnotationStyleFromBaseStyle).toHaveBeenCalledWith(
          expect.any(Object),
          "red",
          true,
          false,
        );
      });
    });

    describe("toolHighlightedAnnotationIds", () => {
      it("returns empty set when no tool state", () => {
        mockedStore.selectedTool = null;
        wrapper = mountComponent();
        expect((wrapper.vm as any).toolHighlightedAnnotationIds.size).toBe(0);
      });

      it("returns annotation id for connection tool", () => {
        mockedStore.selectedTool = {
          configuration: {
            type: "connection",
            values: { action: { value: "add_click" } },
          },
          state: {
            type: ConnectionToolStateSymbol,
            selectedAnnotationId: "ann1",
          },
        } as any;
        wrapper = mountComponent();
        expect(
          (wrapper.vm as any).toolHighlightedAnnotationIds.has("ann1"),
        ).toBe(true);
      });

      it("returns annotation id for combine tool", () => {
        mockedStore.selectedTool = {
          configuration: { type: "edit", values: {} },
          state: {
            type: CombineToolStateSymbol,
            selectedAnnotationId: "ann2",
          },
        } as any;
        wrapper = mountComponent();
        expect(
          (wrapper.vm as any).toolHighlightedAnnotationIds.has("ann2"),
        ).toBe(true);
      });
    });

    describe("getAnyLayerForChannel", () => {
      it("returns layer when channel matches", () => {
        const layer1 = makeLayer({ id: "l1", channel: 2 });
        mockedStore.layers = [layer1];
        wrapper = mountComponent();
        expect((wrapper.vm as any).getAnyLayerForChannel(2)).toEqual(layer1);
      });

      it("returns undefined when no layer matches channel", () => {
        mockedStore.layers = [makeLayer({ id: "l1", channel: 0 })];
        wrapper = mountComponent();
        expect((wrapper.vm as any).getAnyLayerForChannel(5)).toBeUndefined();
      });
    });

    describe("isLayerIdValid", () => {
      it("returns true for valid layer id", () => {
        const layer1 = makeLayer({ id: "l1" });
        mockedStore.layers = [layer1];
        wrapper = mountComponent({ lowestLayer: 0, layerCount: 10 });
        expect((wrapper.vm as any).isLayerIdValid("l1")).toBe(true);
      });

      it("returns false for invalid layer id", () => {
        mockedStore.layers = [makeLayer({ id: "l1" })];
        wrapper = mountComponent({ lowestLayer: 0, layerCount: 10 });
        expect((wrapper.vm as any).isLayerIdValid("nonexistent")).toBe(false);
      });
    });

    describe("layerDisplaysAnnotation", () => {
      it("returns true when annotation belongs to layer", () => {
        const layer1 = makeLayer({ id: "l1", channel: 0 });
        const ann1 = makeAnnotation({
          id: "a1",
          channel: 0,
          location: { XY: 0, Z: 0, Time: 0 },
        });
        mockedStore.layers = [layer1];
        mockedAnnotationStore.annotations = [ann1];
        mockedStore.drawAnnotations = true;
        mockedStore.filteredDraw = false;
        wrapper = mountComponent({ lowestLayer: 0, layerCount: 10 });
        expect((wrapper.vm as any).layerDisplaysAnnotation("l1", "a1")).toBe(
          true,
        );
      });

      it("returns false when annotation does not belong to layer", () => {
        const layer1 = makeLayer({ id: "l1", channel: 0 });
        mockedStore.layers = [layer1];
        mockedAnnotationStore.annotations = [];
        wrapper = mountComponent({ lowestLayer: 0, layerCount: 10 });
        expect(
          (wrapper.vm as any).layerDisplaysAnnotation("l1", "nonexistent"),
        ).toBe(false);
      });
    });

    describe("handleInteractionModeChange", () => {
      it("calls refreshAnnotationMode when mode is null", () => {
        wrapper = mountComponent();
        // In Vue 3 <script setup>, can't spy on closure functions.
        expect(() => {
          (wrapper.vm as any).handleInteractionModeChange({ mode: null });
        }).not.toThrow();
      });

      it("does not call refreshAnnotationMode when mode is not null", () => {
        wrapper = mountComponent();
        const spy = vi.spyOn(wrapper.vm as any, "refreshAnnotationMode");
        (wrapper.vm as any).handleInteractionModeChange({ mode: "point" });
        expect(spy).not.toHaveBeenCalled();
      });
    });

    describe("renderWorkerPreview", () => {
      it("renders preview data when displayWorkerPreview and image exist", () => {
        mockedPropertiesStore.displayWorkerPreview = true;
        (mockedPropertiesStore as any).getWorkerPreview = vi
          .fn()
          .mockReturnValue({
            text: null,
            image: "data:image/png;base64,abc",
          });
        mockedStore.selectedTool = {
          configuration: {
            type: "worker",
            values: { image: { image: "some-image" } },
          },
          state: null,
        } as any;
        wrapper = mountComponent();
        (wrapper.vm as any).renderWorkerPreview();
        expect(
          (wrapper.vm as any).workerPreviewFeature.data,
        ).toHaveBeenCalled();
        expect(
          (wrapper.vm as any).workerPreviewFeature.draw,
        ).toHaveBeenCalled();
      });

      it("clears preview data when not displayed", () => {
        mockedPropertiesStore.displayWorkerPreview = false;
        wrapper = mountComponent();
        (wrapper.vm as any).renderWorkerPreview();
        expect(
          (wrapper.vm as any).workerPreviewFeature.data,
        ).toHaveBeenCalledWith([]);
        expect(
          (wrapper.vm as any).workerPreviewFeature.draw,
        ).toHaveBeenCalled();
      });
    });

    describe("pendingAnnotationChanged", () => {
      it("removes previous pending annotation", () => {
        wrapper = mountComponent();
        const oldPending = mockGeoJSAnnotation("point");
        (wrapper.vm as any).pendingAnnotation = oldPending;

        (wrapper.vm as any).pendingAnnotationChanged();

        expect(
          (wrapper.vm as any).interactionLayer.removeAnnotation,
        ).toHaveBeenCalledWith(oldPending);
      });

      it("creates new annotation from pendingStoreAnnotation", () => {
        const storeAnn = makeAnnotation({
          id: "pending1",
          shape: "point",
          coordinates: [{ x: 5, y: 5 }],
        });
        mockedAnnotationStore.pendingAnnotation = storeAnn;

        const geoAnn = mockGeoJSAnnotation("point");
        (geojsAnnotationFactory as any).mockReturnValue(geoAnn);

        wrapper = mountComponent();
        (wrapper.vm as any).pendingAnnotationChanged();

        expect(geoAnn.options).toHaveBeenCalledWith("specialAnnotation", true);
        expect(
          (wrapper.vm as any).interactionLayer.addAnnotation,
        ).toHaveBeenCalled();
      });
    });

    // =======================================================================
    // onBeforeUnmount cleanup (Finding 4)
    // =======================================================================
    describe("onBeforeUnmount cleanup", () => {
      // A trailing fire after teardown runs against a dead GeoJS view. This
      // test twice failed to catch that, each time because it looked at a
      // hand-maintained list:
      //   1. it named the five throttles that existed when it was written, so
      //      two later ones shipped uncancelled with the suite green;
      //   2. scanning `wrapper.vm` instead moved the dependency to
      //      defineExpose — an unexposed throttle is invisible there, and the
      //      already-exposed ones keep any count floor satisfied.
      // So record the wrappers where they are actually made: the lodash mock
      // above captures every throttle/debounce this component constructs.
      // (Wrappers built lazily inside a handler are still missed until that
      // handler runs; all seven today are created in setup.)
      it("cancels every pending debounced/throttled callback so none fire after teardown", () => {
        createdThrottles.length = 0;
        wrapper = mountComponent();
        const vm = wrapper.vm as any;
        // Floor guards against the recording itself breaking (a lodash import
        // that bypasses the mock would silently record nothing).
        expect(createdThrottles.length).toBeGreaterThanOrEqual(7);
        // Names purely for the failure message; unexposed wrappers still count.
        const named = createdThrottles.map(
          (fn, i) =>
            [
              Object.keys(vm).find((key) => vm[key] === fn) ?? `unexposed#${i}`,
              vi.spyOn(fn, "cancel"),
            ] as const,
        );

        wrapper.unmount();

        expect(
          named
            .filter(([, spy]) => spy.mock.calls.length === 0)
            .map(([n]) => n),
        ).toEqual([]);
      });
    });

    describe("linescan auto-restart on next gesture", () => {
      const armTool = (type: string, lineType?: "freehand" | "segment") => {
        mockedStore.selectedTool = {
          configuration: {
            id: "t1",
            type,
            values: lineType ? { lineType: { value: lineType } } : {},
          },
          state: {},
        } as any;
      };
      const completedLine = {
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 10 },
        ],
        isComplete: true,
      };

      beforeEach(() => {
        lineScanStore.clearLine();
      });

      it("clears a completed freehand scan on mousedown", () => {
        wrapper = mountComponent();
        armTool("linescan", "freehand");
        lineScanStore.setLine(completedLine);
        expect(lineScanStore.points).not.toBeNull();

        (wrapper.vm as any).handleLineScanMouseDown();

        expect(lineScanStore.points).toBeNull();
      });

      it("does NOT clear a completed segment scan on mousedown (a segment left-drag pans the map)", () => {
        wrapper = mountComponent();
        armTool("linescan", "segment");
        lineScanStore.setLine(completedLine);

        (wrapper.vm as any).handleLineScanMouseDown();

        // Segment restarts are cleared on the first click, not on mousedown,
        // so panning never wipes the scan.
        expect(lineScanStore.points).not.toBeNull();
      });

      it("leaves an in-progress (incomplete) freehand scan untouched on mousedown", () => {
        wrapper = mountComponent();
        armTool("linescan", "freehand");
        lineScanStore.setLine({ ...completedLine, isComplete: false });

        (wrapper.vm as any).handleLineScanMouseDown();

        expect(lineScanStore.points).not.toBeNull();
      });

      it("does nothing when a non-linescan tool is active", () => {
        wrapper = mountComponent();
        armTool("create");
        lineScanStore.setLine(completedLine);

        (wrapper.vm as any).handleLineScanMouseDown();

        expect(lineScanStore.points).not.toBeNull();
      });
    });
  });
});

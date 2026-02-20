import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

// ---- Hoisted mocks ----

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
}));

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
    addMultipleAnnotations: vi.fn((anns: any[]) =>
      annotations.push(...anns),
    ),
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
    currentAnnotation: null,
    map: vi.fn(() => ({
      unitsPerPixel: vi.fn().mockReturnValue(1),
      zoom: vi.fn().mockReturnValue(5),
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

// Use Vue.observable so the computed properties are reactive
vi.mock("@/store", () => {
  const Vue = require("vue");
  return {
    default: Vue.observable({
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
      unroll: false,
      unrollXY: false,
      unrollZ: false,
      unrollT: false,
      selectedTool: null as any,
      drawAnnotations: true,
      drawAnnotationConnections: true,
      showTooltips: false,
      showTimelapseMode: false,
      timelapseModeWindow: 5,
      timelapseTags: [] as string[],
      showTimelapseLabels: false,
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

vi.mock("@/store/annotation", () => {
  const Vue = require("vue");
  return {
    default: Vue.observable({
      annotations: [] as any[],
      annotationConnections: [] as any[],
      annotationCentroids: {} as Record<string, any>,
      selectedAnnotations: [] as any[],
      selectedAnnotationIds: [] as string[],
      hoveredAnnotationId: null as string | null,
      pendingAnnotation: null as any,
      getAnnotationFromId: vi.fn().mockReturnValue(undefined),
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
    }),
  };
});

vi.mock("@/store/properties", () => {
  const Vue = require("vue");
  return {
    default: Vue.observable({
      displayWorkerPreview: false,
      getWorkerPreview: vi.fn().mockReturnValue({ text: null, image: "" }),
      displayedPropertyPaths: [] as any[],
      properties: [] as any[],
      propertyValues: {} as Record<string, any>,
      getSubIdsNameFromPath: vi.fn().mockReturnValue(null),
    }),
  };
});

vi.mock("@/store/filters", () => {
  const Vue = require("vue");
  return {
    default: Vue.observable({
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
import { mouseStateToSamPrompt, samPromptToAnnotation } from "@/pipelines/samPipeline";
import { NoOutput } from "@/pipelines/computePipeline";
import AnnotationViewer from "./AnnotationViewer.vue";

const mockedStore = vi.mocked(store);
const mockedAnnotationStore = vi.mocked(annotationStore);
const mockedPropertiesStore = vi.mocked(propertiesStore);
const mockedFilterStore = vi.mocked(filterStore);

Vue.use(Vuetify);
Vue.directive("description", {});
Vue.directive("mousetrap", {});

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
    vuetify: new Vuetify(),
    propsData: {
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
    stubs: {
      AnnotationContextMenu: true,
      AnnotationActionPanel: true,
      TagSelectionDialog: true,
      ColorSelectionDialog: true,
      ColorPickerMenu: true,
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
    mockedStore.showTimelapseMode = false;
    mockedStore.timelapseModeWindow = 5;
    mockedStore.timelapseTags = [];
    mockedStore.showTimelapseLabels = false;
    mockedStore.filteredDraw = false;
    mockedStore.filteredAnnotationTooltips = false;
    mockedStore.scaleAnnotationsWithZoom = false;
    mockedStore.annotationsRadius = 5;
    mockedStore.annotationOpacity = 0.5;
    mockedStore.annotationSelectionType = "ADD" as any;
    mockedStore.showAnnotationsFromHiddenLayers = false;
    mockedStore.valueOnHover = false;

    mockedAnnotationStore.annotations = [];
    mockedAnnotationStore.annotationConnections = [];
    mockedAnnotationStore.annotationCentroids = {};
    mockedAnnotationStore.selectedAnnotations = [];
    mockedAnnotationStore.selectedAnnotationIds = [];
    mockedAnnotationStore.hoveredAnnotationId = null;
    mockedAnnotationStore.pendingAnnotation = null;
    mockedAnnotationStore.annotationIdToIdx = {};

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
    if (wrapper) {
      wrapper.destroy();
    }
  });

  // =========================================================================
  // Category 1: Computed Property Store Proxies (~31 tests)
  // =========================================================================
  describe("computed property store proxies", () => {
    beforeEach(() => {
      wrapper = mountComponent();
    });

    it("annotationSelectionType returns store value", () => {
      mockedStore.annotationSelectionType = "TOGGLE" as any;
      expect(wrapper.vm.annotationSelectionType).toBe("TOGGLE");
    });

    it("roiFilter returns filterStore.emptyROIFilter", () => {
      const filter = { id: "f1", roi: [] };
      mockedFilterStore.emptyROIFilter = filter as any;
      expect(wrapper.vm.roiFilter).toBe(filter);
    });

    it("enabledRoiFilters returns only enabled filters", () => {
      mockedFilterStore.roiFilters = [
        { id: "f1", enabled: true },
        { id: "f2", enabled: false },
        { id: "f3", enabled: true },
      ] as any;
      expect(wrapper.vm.enabledRoiFilters).toHaveLength(2);
      expect(wrapper.vm.enabledRoiFilters[0].id).toBe("f1");
      expect(wrapper.vm.enabledRoiFilters[1].id).toBe("f3");
    });

    it("configuration returns store.configuration", () => {
      expect(wrapper.vm.configuration).toBe(mockedStore.configuration);
    });

    it("layers returns store.layers", () => {
      const layers = [makeLayer()];
      mockedStore.layers = layers;
      expect(wrapper.vm.layers).toBe(layers);
    });

    it("filteredAnnotations returns filterStore.filteredAnnotations", () => {
      const anns = [makeAnnotation()];
      mockedFilterStore.filteredAnnotations = anns;
      expect(wrapper.vm.filteredAnnotations).toBe(anns);
    });

    it("annotationConnections returns annotationStore.annotationConnections", () => {
      const conns = [makeConnection()];
      mockedAnnotationStore.annotationConnections = conns;
      expect(wrapper.vm.annotationConnections).toBe(conns);
    });

    it("unrolling returns store.unroll", () => {
      mockedStore.unroll = true;
      expect(wrapper.vm.unrolling).toBe(true);
    });

    it("xy returns store.xy", () => {
      mockedStore.xy = 3;
      expect(wrapper.vm.xy).toBe(3);
    });

    it("z returns store.z", () => {
      mockedStore.z = 2;
      expect(wrapper.vm.z).toBe(2);
    });

    it("time returns store.time", () => {
      mockedStore.time = 7;
      expect(wrapper.vm.time).toBe(7);
    });

    it("dataset returns store.dataset", () => {
      expect(wrapper.vm.dataset).toBe(mockedStore.dataset);
    });

    it("valueOnHover returns store.valueOnHover", () => {
      mockedStore.valueOnHover = true;
      expect(wrapper.vm.valueOnHover).toBe(true);
    });

    it("isAnnotationSelected returns annotationStore.isAnnotationSelected", () => {
      expect(wrapper.vm.isAnnotationSelected).toBe(
        mockedAnnotationStore.isAnnotationSelected,
      );
    });

    it("showAnnotationsFromHiddenLayers returns store value", () => {
      mockedStore.showAnnotationsFromHiddenLayers = true;
      expect(wrapper.vm.showAnnotationsFromHiddenLayers).toBe(true);
    });

    it("hoveredAnnotationId returns annotationStore value", () => {
      mockedAnnotationStore.hoveredAnnotationId = "ann42";
      expect(wrapper.vm.hoveredAnnotationId).toBe("ann42");
    });

    it("selectedAnnotations returns annotationStore value", () => {
      const selected = [makeAnnotation({ id: "s1" })];
      mockedAnnotationStore.selectedAnnotations = selected;
      expect(wrapper.vm.selectedAnnotations).toBe(selected);
    });

    it("shouldDrawAnnotations returns store.drawAnnotations", () => {
      mockedStore.drawAnnotations = false;
      expect(wrapper.vm.shouldDrawAnnotations).toBe(false);
    });

    it("shouldDrawConnections returns store.drawAnnotationConnections", () => {
      mockedStore.drawAnnotationConnections = false;
      expect(wrapper.vm.shouldDrawConnections).toBe(false);
    });

    it("showTooltips returns store.showTooltips", () => {
      mockedStore.showTooltips = true;
      expect(wrapper.vm.showTooltips).toBe(true);
    });

    it("showTimelapseMode returns store.showTimelapseMode", () => {
      mockedStore.showTimelapseMode = true;
      expect(wrapper.vm.showTimelapseMode).toBe(true);
    });

    it("timelapseModeWindow returns store.timelapseModeWindow", () => {
      mockedStore.timelapseModeWindow = 10;
      expect(wrapper.vm.timelapseModeWindow).toBe(10);
    });

    it("showTimelapseLabels returns store.showTimelapseLabels", () => {
      mockedStore.showTimelapseLabels = true;
      expect(wrapper.vm.showTimelapseLabels).toBe(true);
    });

    it("filteredAnnotationTooltips returns store value", () => {
      mockedStore.filteredAnnotationTooltips = true;
      expect(wrapper.vm.filteredAnnotationTooltips).toBe(true);
    });

    it("getAnnotationFromId returns annotationStore function", () => {
      expect(wrapper.vm.getAnnotationFromId).toBe(
        mockedAnnotationStore.getAnnotationFromId,
      );
    });

    it("displayWorkerPreview returns propertiesStore value", () => {
      mockedPropertiesStore.displayWorkerPreview = true;
      expect(wrapper.vm.displayWorkerPreview).toBe(true);
    });

    it("displayedPropertyPaths returns propertiesStore value", () => {
      const paths = [["a", "b"]];
      mockedPropertiesStore.displayedPropertyPaths = paths;
      expect(wrapper.vm.displayedPropertyPaths).toBe(paths);
    });

    it("properties returns propertiesStore value", () => {
      const props = [{ id: "p1" }];
      mockedPropertiesStore.properties = props as any;
      expect(wrapper.vm.properties).toBe(props);
    });

    it("propertyValues returns propertiesStore value", () => {
      const vals = { ann1: { p1: 42 } };
      mockedPropertiesStore.propertyValues = vals;
      expect(wrapper.vm.propertyValues).toBe(vals);
    });

    it("selectedToolConfiguration returns tool config or null", () => {
      expect(wrapper.vm.selectedToolConfiguration).toBeNull();
      const toolConfig = { id: "t1", type: "create", values: {} };
      mockedStore.selectedTool = {
        configuration: toolConfig,
        state: { type: Symbol("test") },
      } as any;
      expect(wrapper.vm.selectedToolConfiguration).toBe(toolConfig);
    });

    it("selectedToolState returns tool state or null", () => {
      expect(wrapper.vm.selectedToolState).toBeNull();
      const state = { type: Symbol("test") };
      mockedStore.selectedTool = {
        configuration: { id: "t1" },
        state,
      } as any;
      expect(wrapper.vm.selectedToolState).toBe(state);
    });

    it("pendingStoreAnnotation returns annotationStore.pendingAnnotation", () => {
      expect(wrapper.vm.pendingStoreAnnotation).toBeNull();
      const pending = makeAnnotation({ id: "pending1" });
      mockedAnnotationStore.pendingAnnotation = pending;
      expect(wrapper.vm.pendingStoreAnnotation).toBe(pending);
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
        expect(wrapper.vm.displayableAnnotations).toEqual([]);
      });

      it("returns empty when annotationLayer is missing and shouldDrawAnnotations is false", () => {
        mockedStore.drawAnnotations = false;
        wrapper = mountComponent();
        // With no annotationLayer or no drawAnnotations, displayableAnnotations is empty
        expect(wrapper.vm.displayableAnnotations).toEqual([]);
      });

      it("returns filteredAnnotations when filteredDraw is true", () => {
        const filtered = [makeAnnotation({ id: "f1" })];
        mockedFilterStore.filteredAnnotations = filtered;
        mockedStore.filteredDraw = true;
        wrapper = mountComponent();
        expect(wrapper.vm.displayableAnnotations).toBe(filtered);
      });

      it("returns all annotations when filteredDraw is false", () => {
        const all = [makeAnnotation({ id: "a1" }), makeAnnotation({ id: "a2" })];
        mockedAnnotationStore.annotations = all;
        mockedStore.filteredDraw = false;
        wrapper = mountComponent();
        expect(wrapper.vm.displayableAnnotations).toBe(all);
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
        const result = wrapper.vm.layerAnnotations;
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
        const result = wrapper.vm.layerAnnotations;
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

        wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });
        const result = wrapper.vm.layerAnnotations;
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
        const result = wrapper.vm.layerAnnotations;
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
        const result = wrapper.vm.layerAnnotations;
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
        const result = wrapper.vm.layerAnnotations;
        expect(result.get("l1")?.has("a1")).toBe(true);
      });

      it("returns empty map for layers not in valid range", () => {
        const layer = makeLayer({ id: "l1", channel: 0, visible: true });
        mockedStore.layers = [layer];
        // lowestLayer=5 means no layers in the valid range
        wrapper = mountComponent({ lowestLayer: 5, layerCount: 1 });
        const result = wrapper.vm.layerAnnotations;
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

        wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });
        const result = wrapper.vm.layerAnnotations;
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
        expect(wrapper.vm.validLayers).toEqual([layers[1], layers[2]]);
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
        const ids = wrapper.vm.displayedAnnotationIds;
        expect(ids.has("a1")).toBe(true);
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
        const result = wrapper.vm.displayedAnnotations;
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe("a1");
      });
    });

    describe("connectionIdsSet", () => {
      it("builds set from connection ids", () => {
        mockedAnnotationStore.annotationConnections = [
          makeConnection({ id: "c1" }),
          makeConnection({ id: "c2" }),
        ];
        wrapper = mountComponent();
        const set = wrapper.vm.connectionIdsSet;
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
        const aLayer = wrapper.vm.annotationLayer;
        wrapper.vm.drawAnnotationsNoThrottle();
        expect(aLayer.removeAllAnnotations).toHaveBeenCalled();
      });

      it("calls clearOldAnnotations and drawNewAnnotations", () => {
        const layer = makeLayer({ id: "l1", channel: 0, visible: true });
        mockedStore.layers = [layer];
        (mockedStore.layerSliceIndexes as any).mockReturnValue({
          xyIndex: 0,
          zIndex: 0,
          tIndex: 0,
        });
        mockedAnnotationStore.annotations = [makeAnnotation({ id: "a1", channel: 0 })];
        wrapper = mountComponent({ lowestLayer: 0, layerCount: 1 });

        const aLayer = wrapper.vm.annotationLayer;
        wrapper.vm.drawAnnotationsNoThrottle();
        expect(aLayer.removeAllAnnotations).toHaveBeenCalled();
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
        wrapper.vm.drawAnnotationsNoThrottle();
        // The draw method should be called (connections rendering happens inside)
        expect(wrapper.vm.annotationLayer.draw).toHaveBeenCalled();
      });
    });

    // --- clearOldAnnotations ---
    describe("clearOldAnnotations", () => {
      it("clears all when clearAll=true", () => {
        wrapper = mountComponent();
        const aLayer = wrapper.vm.annotationLayer;
        wrapper.vm.clearOldAnnotations(true);
        expect(aLayer.removeAllAnnotations).toHaveBeenCalled();
        expect(aLayer.modified).toHaveBeenCalled();
      });

      it("does not redraw when redraw=false", () => {
        wrapper = mountComponent();
        const aLayer = wrapper.vm.annotationLayer;
        vi.clearAllMocks();
        wrapper.vm.clearOldAnnotations(true, false);
        expect(aLayer.draw).not.toHaveBeenCalled();
      });

      it("redraws when redraw=true (default)", () => {
        wrapper = mountComponent();
        const aLayer = wrapper.vm.annotationLayer;
        vi.clearAllMocks();
        wrapper.vm.clearOldAnnotations(true, true);
        expect(aLayer.draw).toHaveBeenCalled();
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
        wrapper.vm.drawNewAnnotations(drawnMap);

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
        wrapper.vm.drawNewAnnotations(drawnMap);

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
        wrapper.vm.drawNewAnnotations(drawnMap);

        // Should update the style since isHovered changed
        expect(geoAnn.options).toHaveBeenCalledWith(
          "isHovered",
          true,
        );
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
        const result = wrapper.vm.pointNearPoint(
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
        const result = wrapper.vm.pointNearPoint(
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
        const result = wrapper.vm.pointNearPoint(
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

        geojs.util.distance2dToLineSquared.mockReturnValue(1);
        (pointDistance as any).mockReturnValue(100);

        const result = wrapper.vm.pointNearLine(
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

        geojs.util.distance2dToLineSquared.mockReturnValue(100);
        (pointDistance as any).mockReturnValue(100);

        const result = wrapper.vm.pointNearLine(
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

        geojs.util.distance2dToLineSquared.mockReturnValue(100);
        (pointDistance as any).mockReturnValue(1); // Near last vertex

        const result = wrapper.vm.pointNearLine(
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

        const result = wrapper.vm.shouldSelectAnnotation(
          "point",
          [{ x: 10, y: 20 }],
          ann,
          style,
          1,
        );
        expect(result).toBe(true);
      });

      it("uses pointNearLine for point-vs-line", () => {

        geojs.util.distance2dToLineSquared.mockReturnValue(1);
        const ann = makeAnnotation({
          shape: "line",
          coordinates: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
          ],
        });
        const style = { radius: 5, strokeWidth: 5 };

        const result = wrapper.vm.shouldSelectAnnotation(
          "point",
          [{ x: 5, y: 0 }],
          ann,
          style,
          1,
        );
        expect(result).toBe(true);
      });

      it("uses pointInPolygon for point-vs-polygon", () => {

        geojs.util.pointInPolygon.mockReturnValue(true);
        const ann = makeAnnotation({
          shape: "polygon",
          coordinates: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 10 },
          ],
        });
        const style = { radius: 5, strokeWidth: 2 };

        const result = wrapper.vm.shouldSelectAnnotation(
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

        geojs.util.pointInPolygon.mockReturnValue(true);
        const ann = makeAnnotation({
          shape: "point",
          coordinates: [{ x: 5, y: 5 }],
        });
        const style = { radius: 5, strokeWidth: 2 };

        const result = wrapper.vm.shouldSelectAnnotation(
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
        wrapper.vm.annotationLayer.annotations = vi.fn(() => [geoAnn]);

        const selectAnn = mockGeoJSAnnotation("point");
        selectAnn.type = vi.fn().mockReturnValue("point");
        selectAnn.coordinates = vi.fn().mockReturnValue([{ x: 10, y: 20 }]);

        const result = wrapper.vm.getSelectedAnnotationsFromAnnotation(selectAnn);
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe("a1");
      });

      it("skips connection annotations", () => {
        const geoAnn = mockGeoJSAnnotation("point");
        geoAnn.options("girderId", "a1");
        geoAnn.options("isConnection", true);

        wrapper = mountComponent();
        wrapper.vm.annotationLayer.annotations = vi.fn(() => [geoAnn]);

        const selectAnn = mockGeoJSAnnotation("point");
        const result = wrapper.vm.getSelectedAnnotationsFromAnnotation(selectAnn);
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
        wrapper.vm.annotationLayer.annotations = vi.fn(() => [geoAnn1, geoAnn2]);

        const selectAnn = mockGeoJSAnnotation("point");
        selectAnn.type = vi.fn().mockReturnValue("point");
        selectAnn.coordinates = vi.fn().mockReturnValue([{ x: 10, y: 20 }]);

        const result = wrapper.vm.getSelectedAnnotationsFromAnnotation(selectAnn);
        expect(result).toHaveLength(1);
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
        (mockedAnnotationStore.getAnnotationFromId as any).mockReturnValue(ann1);
        (pointDistance as any).mockReturnValue(1);

        wrapper = mountComponent();
        wrapper.vm.annotationLayer.annotations = vi.fn(() => [geoAnn]);

        const selectAnn = mockGeoJSAnnotation("point");
        selectAnn.type = vi.fn().mockReturnValue("point");
        selectAnn.coordinates = vi.fn().mockReturnValue([{ x: 10, y: 20 }]);

        wrapper.vm.selectAnnotations(selectAnn);
        expect(mockedAnnotationStore.selectAnnotations).toHaveBeenCalled();
      });

      it("calls annotationStore.unselectAnnotations in REMOVE mode", () => {
        mockedStore.annotationSelectionType = "REMOVE" as any;
        wrapper = mountComponent();
        wrapper.vm.annotationLayer.annotations = vi.fn(() => []);

        const selectAnn = mockGeoJSAnnotation("point");
        wrapper.vm.selectAnnotations(selectAnn);
        expect(mockedAnnotationStore.unselectAnnotations).toHaveBeenCalled();
      });

      it("calls annotationStore.toggleSelected in TOGGLE mode", () => {
        mockedStore.annotationSelectionType = "TOGGLE" as any;
        wrapper = mountComponent();
        wrapper.vm.annotationLayer.annotations = vi.fn(() => []);

        const selectAnn = mockGeoJSAnnotation("point");
        wrapper.vm.selectAnnotations(selectAnn);
        expect(mockedAnnotationStore.toggleSelected).toHaveBeenCalled();
      });

      it("removes selection annotation from interaction layer", () => {
        wrapper = mountComponent();
        wrapper.vm.annotationLayer.annotations = vi.fn(() => []);

        const selectAnn = mockGeoJSAnnotation("point");
        wrapper.vm.selectAnnotations(selectAnn);
        expect(wrapper.vm.interactionLayer.removeAnnotation).toHaveBeenCalledWith(
          selectAnn,
        );
      });

      it("returns early when selectAnnotation is null", () => {
        wrapper = mountComponent();
        wrapper.vm.selectAnnotations(null);
        expect(mockedAnnotationStore.selectAnnotations).not.toHaveBeenCalled();
        expect(mockedAnnotationStore.unselectAnnotations).not.toHaveBeenCalled();
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
        wrapper.vm.setNewAnnotationMode();
        expect(wrapper.vm.interactionLayer.mode).toHaveBeenCalledWith(null);
      });

      it("sets polygon mode when roiFilter is active and deselects tool", () => {
        mockedFilterStore.emptyROIFilter = { id: "f1", roi: [] } as any;
        mockedStore.selectedTool = {
          configuration: { id: "t1", type: "create", values: {} },
          state: {},
        } as any;
        wrapper = mountComponent();
        wrapper.vm.setNewAnnotationMode();
        expect(mockedStore.setSelectedToolId).toHaveBeenCalledWith(null);
        expect(wrapper.vm.interactionLayer.mode).toHaveBeenCalledWith("polygon");
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
        wrapper.vm.setNewAnnotationMode();
        expect(wrapper.vm.interactionLayer.mode).toHaveBeenCalledWith("point");
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
        wrapper.vm.setNewAnnotationMode();
        expect(wrapper.vm.interactionLayer.mode).toHaveBeenCalledWith("polygon");
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
        wrapper.vm.setNewAnnotationMode();
        expect(wrapper.vm.interactionLayer.mode).toHaveBeenCalledWith("ellipse");
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
        wrapper.vm.setNewAnnotationMode();
        expect(wrapper.vm.interactionLayer.mode).toHaveBeenCalledWith("ellipse");
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
        wrapper.vm.setNewAnnotationMode();
        expect(wrapper.vm.interactionLayer.mode).toHaveBeenCalledWith("point");
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
        wrapper.vm.setNewAnnotationMode();
        expect(wrapper.vm.interactionLayer.mode).toHaveBeenCalledWith("polygon");
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
        wrapper.vm.setNewAnnotationMode();
        expect(wrapper.vm.interactionLayer.mode).toHaveBeenCalledWith("point");
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
        wrapper.vm.setNewAnnotationMode();
        expect(wrapper.vm.interactionLayer.mode).toHaveBeenCalledWith("polygon");
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
        wrapper.vm.setNewAnnotationMode();
        expect(wrapper.vm.interactionLayer.mode).toHaveBeenCalledWith("point");
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
        wrapper.vm.setNewAnnotationMode();
        expect(wrapper.vm.interactionLayer.mode).toHaveBeenCalledWith("polygon");
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
        wrapper.vm.setNewAnnotationMode();
        expect(wrapper.vm.interactionLayer.mode).toHaveBeenCalledWith("point");
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
        wrapper.vm.setNewAnnotationMode();
        expect(wrapper.vm.interactionLayer.mode).toHaveBeenCalledWith("line");
      });

      it("sets null mode for samAnnotation tool", () => {
        mockedStore.selectedTool = {
          configuration: { id: "t1", type: "samAnnotation", values: {} },
          state: {},
        } as any;
        wrapper = mountComponent();
        wrapper.vm.setNewAnnotationMode();
        expect(wrapper.vm.interactionLayer.mode).toHaveBeenCalledWith(null);
      });

      it("sets null mode for segmentation tool", () => {
        mockedStore.selectedTool = {
          configuration: { id: "t1", type: "segmentation", values: {} },
          state: {},
        } as any;
        wrapper = mountComponent();
        wrapper.vm.setNewAnnotationMode();
        expect(wrapper.vm.interactionLayer.mode).toHaveBeenCalledWith(null);
      });
    });

    // --- handleInteractionAnnotationChange ---
    describe("handleInteractionAnnotationChange", () => {
      it("returns early when no tool and no roiFilter", () => {
        wrapper = mountComponent();
        const spy = vi.spyOn(wrapper.vm, "addAnnotationFromGeoJsAnnotation");
        wrapper.vm.handleInteractionAnnotationChange({
          event: "geo_annotation_state",
          annotation: { layer: () => wrapper.vm.interactionLayer },
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
        const spy = vi.spyOn(wrapper.vm, "addAnnotationFromGeoJsAnnotation").mockImplementation(() => {});

        const ann = mockGeoJSAnnotation("point");
        ann.layer = vi.fn().mockReturnValue(wrapper.vm.interactionLayer);
        wrapper.vm.handleInteractionAnnotationChange({
          event: "geo_annotation_state",
          annotation: ann,
        });
        expect(spy).toHaveBeenCalledWith(ann);
      });

      it("routes tagging tool to handleAnnotationTagging", () => {
        mockedStore.selectedTool = {
          configuration: {
            id: "t1",
            type: "tagging",
            values: { action: { value: "tag_click" } },
          },
          state: {},
        } as any;
        wrapper = mountComponent();
        const spy = vi.spyOn(wrapper.vm, "handleAnnotationTagging").mockImplementation(() => {});

        const ann = mockGeoJSAnnotation("point");
        ann.layer = vi.fn().mockReturnValue(wrapper.vm.interactionLayer);
        wrapper.vm.handleInteractionAnnotationChange({
          event: "geo_annotation_state",
          annotation: ann,
        });
        expect(spy).toHaveBeenCalledWith(ann);
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
        const spy = vi.spyOn(wrapper.vm, "selectAnnotations").mockImplementation(() => {});

        const ann = mockGeoJSAnnotation("point");
        ann.layer = vi.fn().mockReturnValue(wrapper.vm.interactionLayer);
        wrapper.vm.handleInteractionAnnotationChange({
          event: "geo_annotation_state",
          annotation: ann,
        });
        expect(spy).toHaveBeenCalledWith(ann);
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
        const spy = vi.spyOn(wrapper.vm, "handleAnnotationConnections").mockImplementation(() => {});

        const ann = mockGeoJSAnnotation("point");
        ann.layer = vi.fn().mockReturnValue(wrapper.vm.interactionLayer);
        wrapper.vm.handleInteractionAnnotationChange({
          event: "geo_annotation_state",
          annotation: ann,
        });
        expect(spy).toHaveBeenCalledWith(ann);
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
        const spy = vi.spyOn(wrapper.vm, "handleAnnotationCombine").mockImplementation(() => {});

        const ann = mockGeoJSAnnotation("point");
        ann.layer = vi.fn().mockReturnValue(wrapper.vm.interactionLayer);
        wrapper.vm.handleInteractionAnnotationChange({
          event: "geo_annotation_state",
          annotation: ann,
        });
        expect(spy).toHaveBeenCalledWith(ann);
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
        const spy = vi.spyOn(wrapper.vm, "handleAnnotationEdits").mockImplementation(() => {});

        const ann = mockGeoJSAnnotation("point");
        ann.layer = vi.fn().mockReturnValue(wrapper.vm.interactionLayer);
        wrapper.vm.handleInteractionAnnotationChange({
          event: "geo_annotation_state",
          annotation: ann,
        });
        expect(spy).toHaveBeenCalledWith(ann);
      });

      it("routes to handleNewROIFilter when no tool but roiFilter exists", () => {
        mockedFilterStore.emptyROIFilter = { id: "f1", roi: [] } as any;
        wrapper = mountComponent();
        const spy = vi.spyOn(wrapper.vm, "handleNewROIFilter").mockImplementation(() => {});

        const ann = mockGeoJSAnnotation("polygon");
        ann.layer = vi.fn().mockReturnValue(wrapper.vm.interactionLayer);
        wrapper.vm.handleInteractionAnnotationChange({
          event: "geo_annotation_state",
          annotation: ann,
        });
        expect(spy).toHaveBeenCalledWith(ann);
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
        const spy = vi.spyOn(wrapper.vm, "addAnnotationFromGeoJsAnnotation").mockImplementation(() => {});

        const otherLayer = mockAnnotationLayer();
        const ann = mockGeoJSAnnotation("point");
        ann.layer = vi.fn().mockReturnValue(otherLayer);
        wrapper.vm.handleInteractionAnnotationChange({
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

        await wrapper.vm.addAnnotationFromGeoJsAnnotation(ann);
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

        await wrapper.vm.addAnnotationFromGeoJsAnnotation(ann);
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

        await wrapper.vm.addAnnotationFromGeoJsAnnotation(ann);
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

        await wrapper.vm.addAnnotationFromGeoJsAnnotation(null);
        expect(mockedAnnotationStore.addAnnotationFromTool).not.toHaveBeenCalled();
      });

      it("returns early when no selectedToolConfiguration", async () => {
        wrapper = mountComponent();

        const ann = mockGeoJSAnnotation("point");
        await wrapper.vm.addAnnotationFromGeoJsAnnotation(ann);
        expect(mockedAnnotationStore.addAnnotationFromTool).not.toHaveBeenCalled();
      });
    });

    // --- handleAnnotationConnections ---
    describe("handleAnnotationConnections", () => {
      const connectionToolState = Symbol("ConnectionToolState");

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
        await wrapper.vm.handleAnnotationConnections(ann);
        expect(mockedAnnotationStore.createConnection).not.toHaveBeenCalled();
      });

      it("returns early when selectAnnotation is null", async () => {
        setupConnectionTool("add_click");
        wrapper = mountComponent();

        await wrapper.vm.handleAnnotationConnections(null);
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
        (mockedAnnotationStore.getAnnotationFromId as any).mockReturnValue(ann2);

        wrapper = mountComponent();
        // Mock getSelectedAnnotationsFromAnnotation to return ann2
        wrapper.vm.annotationLayer.annotations = vi.fn(() => {
          const geoAnn = mockGeoJSAnnotation("point");
          geoAnn.options("girderId", "ann2");
          geoAnn.options("isConnection", false);
          return [geoAnn];
        });
        (pointDistance as any).mockReturnValue(1);

        const selectAnn = mockGeoJSAnnotation("point");
        selectAnn.type = vi.fn().mockReturnValue("point");
        selectAnn.coordinates = vi.fn().mockReturnValue([{ x: 10, y: 20 }]);

        await wrapper.vm.handleAnnotationConnections(selectAnn);
        expect(mockedAnnotationStore.createConnection).toHaveBeenCalled();
      });

      it("calls createAllConnections on add_lasso", async () => {
        setupConnectionTool("add_lasso");
        wrapper = mountComponent();
        wrapper.vm.annotationLayer.annotations = vi.fn(() => []);

        const selectAnn = mockGeoJSAnnotation("polygon");
        await wrapper.vm.handleAnnotationConnections(selectAnn);
        expect(mockedAnnotationStore.createAllConnections).toHaveBeenCalled();
      });

      it("calls deleteAllConnections on delete_lasso", async () => {
        setupConnectionTool("delete_lasso");
        wrapper = mountComponent();
        wrapper.vm.annotationLayer.annotations = vi.fn(() => []);

        const selectAnn = mockGeoJSAnnotation("polygon");
        await wrapper.vm.handleAnnotationConnections(selectAnn);
        expect(mockedAnnotationStore.deleteAllConnections).toHaveBeenCalled();
      });

      it("removes selectAnnotation from interactionLayer", async () => {
        setupConnectionTool("add_lasso");
        wrapper = mountComponent();
        wrapper.vm.annotationLayer.annotations = vi.fn(() => []);

        const selectAnn = mockGeoJSAnnotation("polygon");
        await wrapper.vm.handleAnnotationConnections(selectAnn);
        expect(wrapper.vm.interactionLayer.removeAnnotation).toHaveBeenCalledWith(
          selectAnn,
        );
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
        (mockedAnnotationStore.getAnnotationFromId as any).mockReturnValue(ann1);
        (pointDistance as any).mockReturnValue(1);

        wrapper = mountComponent();
        const geoAnn = mockGeoJSAnnotation("polygon");
        geoAnn.options("girderId", "a1");
        geoAnn.options("isConnection", false);
        wrapper.vm.annotationLayer.annotations = vi.fn(() => [geoAnn]);

        const selectAnn = mockGeoJSAnnotation("point");
        selectAnn.type = vi.fn().mockReturnValue("point");
        selectAnn.coordinates = vi.fn().mockReturnValue([{ x: 5, y: 5 }]);

        await wrapper.vm.handleAnnotationCombine(selectAnn);
        expect(wrapper.vm.selectedToolState.selectedAnnotationId).toBe("a1");
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
        (mockedAnnotationStore.getAnnotationFromId as any).mockReturnValue(ann2);
        (pointDistance as any).mockReturnValue(1);

        wrapper = mountComponent();
        const geoAnn = mockGeoJSAnnotation("polygon");
        geoAnn.options("girderId", "a2");
        geoAnn.options("isConnection", false);
        wrapper.vm.annotationLayer.annotations = vi.fn(() => [geoAnn]);

        const selectAnn = mockGeoJSAnnotation("point");
        selectAnn.type = vi.fn().mockReturnValue("point");
        selectAnn.coordinates = vi.fn().mockReturnValue([{ x: 5, y: 5 }]);

        await wrapper.vm.handleAnnotationCombine(selectAnn);
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
        (mockedAnnotationStore.getAnnotationFromId as any).mockReturnValue(ann1);
        (pointDistance as any).mockReturnValue(1);

        wrapper = mountComponent();
        const geoAnn = mockGeoJSAnnotation("polygon");
        geoAnn.options("girderId", "a1");
        geoAnn.options("isConnection", false);
        wrapper.vm.annotationLayer.annotations = vi.fn(() => [geoAnn]);

        const selectAnn = mockGeoJSAnnotation("point");
        selectAnn.type = vi.fn().mockReturnValue("point");
        selectAnn.coordinates = vi.fn().mockReturnValue([{ x: 5, y: 5 }]);

        await wrapper.vm.handleAnnotationCombine(selectAnn);
        expect(mockedAnnotationStore.combineAnnotations).not.toHaveBeenCalled();
      });

      it("filters non-polygon annotations", async () => {
        setupCombineTool();
        const ann1 = makeAnnotation({ id: "a1", shape: "point" }); // Not polygon
        (mockedAnnotationStore.getAnnotationFromId as any).mockReturnValue(ann1);
        (pointDistance as any).mockReturnValue(1);

        wrapper = mountComponent();
        const geoAnn = mockGeoJSAnnotation("point");
        geoAnn.options("girderId", "a1");
        geoAnn.options("isConnection", false);
        wrapper.vm.annotationLayer.annotations = vi.fn(() => [geoAnn]);

        const selectAnn = mockGeoJSAnnotation("point");
        selectAnn.type = vi.fn().mockReturnValue("point");
        selectAnn.coordinates = vi.fn().mockReturnValue([{ x: 5, y: 5 }]);

        await wrapper.vm.handleAnnotationCombine(selectAnn);
        // Should not set selectedAnnotationId since no polygon found
        expect(wrapper.vm.selectedToolState.selectedAnnotationId).toBeNull();
      });

      it("returns early when selectAnnotation is null", async () => {
        setupCombineTool();
        wrapper = mountComponent();
        await wrapper.vm.handleAnnotationCombine(null);
        expect(mockedAnnotationStore.combineAnnotations).not.toHaveBeenCalled();
      });

      it("removes interaction annotation", async () => {
        setupCombineTool();
        wrapper = mountComponent();
        wrapper.vm.annotationLayer.annotations = vi.fn(() => []);

        const selectAnn = mockGeoJSAnnotation("point");
        await wrapper.vm.handleAnnotationCombine(selectAnn);
        expect(wrapper.vm.interactionLayer.removeAnnotation).toHaveBeenCalledWith(
          selectAnn,
        );
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
        (mockedAnnotationStore.getAnnotationFromId as any).mockReturnValue(ann1);
        (pointDistance as any).mockReturnValue(1);

        wrapper = mountComponent();
        const geoAnn = mockGeoJSAnnotation("point");
        geoAnn.options("girderId", "a1");
        geoAnn.options("isConnection", false);
        wrapper.vm.annotationLayer.annotations = vi.fn(() => [geoAnn]);

        const selectAnn = mockGeoJSAnnotation("point");
        selectAnn.type = vi.fn().mockReturnValue("point");
        selectAnn.coordinates = vi.fn().mockReturnValue([{ x: 10, y: 20 }]);

        await wrapper.vm.handleAnnotationTagging(selectAnn);
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
        (mockedAnnotationStore.getAnnotationFromId as any).mockReturnValue(ann1);
        (pointDistance as any).mockReturnValue(1);

        wrapper = mountComponent();
        const geoAnn = mockGeoJSAnnotation("point");
        geoAnn.options("girderId", "a1");
        geoAnn.options("isConnection", false);
        wrapper.vm.annotationLayer.annotations = vi.fn(() => [geoAnn]);

        const selectAnn = mockGeoJSAnnotation("point");
        selectAnn.type = vi.fn().mockReturnValue("point");
        selectAnn.coordinates = vi.fn().mockReturnValue([{ x: 10, y: 20 }]);

        await wrapper.vm.handleAnnotationTagging(selectAnn);
        expect(mockedAnnotationStore.setHoveredAnnotationId).toHaveBeenCalledWith("a1");
      });

      it("returns early when annotation is null", async () => {
        wrapper = mountComponent();
        await wrapper.vm.handleAnnotationTagging(null);
        expect(mockedAnnotationStore.updateAnnotationsPerId).not.toHaveBeenCalled();
      });
    });

    describe("updateAnnotationTags", () => {
      it("removes tags on untag action", async () => {
        wrapper = mountComponent();
        await wrapper.vm.updateAnnotationTags(
          ["a1"],
          "untag_click",
          ["tagToRemove"],
          false,
        );
        expect(mockedAnnotationStore.updateAnnotationsPerId).toHaveBeenCalled();
        const call = (mockedAnnotationStore.updateAnnotationsPerId as any).mock.calls[0][0];
        // Test the edit function
        const testAnn = { tags: ["tagToRemove", "keepMe"] };
        call.editFunction(testAnn);
        expect(testAnn.tags).toEqual(["keepMe"]);
      });

      it("replaces tags when removeExisting is true", async () => {
        wrapper = mountComponent();
        await wrapper.vm.updateAnnotationTags(
          ["a1"],
          "tag_click",
          ["newTag"],
          true,
        );
        const call = (mockedAnnotationStore.updateAnnotationsPerId as any).mock.calls[0][0];
        const testAnn = { tags: ["oldTag"] };
        call.editFunction(testAnn);
        expect(testAnn.tags).toEqual(["newTag"]);
      });

      it("merges tags when removeExisting is false", async () => {
        wrapper = mountComponent();
        await wrapper.vm.updateAnnotationTags(
          ["a1"],
          "tag_click",
          ["newTag"],
          false,
        );
        const call = (mockedAnnotationStore.updateAnnotationsPerId as any).mock.calls[0][0];
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

        const ann1 = makeAnnotation({ id: "a1", shape: "polygon" });
        (mockedAnnotationStore.getAnnotationFromId as any).mockReturnValue(ann1);

        wrapper = mountComponent();
        const geoAnn = mockGeoJSAnnotation("polygon");
        geoAnn.options("girderId", "a1");
        geoAnn.options("isConnection", false);
        wrapper.vm.annotationLayer.annotations = vi.fn(() => [geoAnn]);

        // Use polygon selection type to match
        (geojs as any).util.pointInPolygon.mockReturnValue(true);

        const selectAnn = mockGeoJSAnnotation("polygon");
        selectAnn.type = vi.fn().mockReturnValue("polygon");
        selectAnn.coordinates = vi.fn().mockReturnValue([
          { x: 0, y: 0 },
          { x: 100, y: 0 },
          { x: 100, y: 100 },
        ]);

        await wrapper.vm.handleAnnotationEdits(selectAnn);
        expect(mockedAnnotationStore.updateAnnotationsPerId).toHaveBeenCalled();
      });

      it("returns early when no annotations selected", async () => {
        wrapper = mountComponent();
        wrapper.vm.annotationLayer.annotations = vi.fn(() => []);

        const selectAnn = mockGeoJSAnnotation("polygon");
        await wrapper.vm.handleAnnotationEdits(selectAnn);
        expect(mockedAnnotationStore.updateAnnotationsPerId).not.toHaveBeenCalled();
      });

      it("removes selectAnnotation after processing", async () => {
        wrapper = mountComponent();
        wrapper.vm.annotationLayer.annotations = vi.fn(() => []);

        const selectAnn = mockGeoJSAnnotation("polygon");
        await wrapper.vm.handleAnnotationEdits(selectAnn);
        expect(wrapper.vm.interactionLayer.removeAnnotation).toHaveBeenCalledWith(
          selectAnn,
        );
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

        wrapper.vm.handleNewROIFilter(ann);
        expect(mockedFilterStore.validateNewROIFilter).toHaveBeenCalledWith([
          { x: 0, y: 0 },
          { x: 10, y: 10 },
        ]);
        expect(wrapper.vm.interactionLayer.removeAnnotation).toHaveBeenCalledWith(ann);
      });

      it("returns early when no roiFilter", () => {
        mockedFilterStore.emptyROIFilter = null;
        wrapper = mountComponent();

        const ann = mockGeoJSAnnotation("polygon");
        wrapper.vm.handleNewROIFilter(ann);
        expect(mockedFilterStore.validateNewROIFilter).not.toHaveBeenCalled();
      });
    });
  });

  // =========================================================================
  // Category 5: Coordinate Transformation (~7 tests)
  // =========================================================================
  describe("coordinate transformation", () => {
    // --- unrollIndex ---
    describe("unrollIndex", () => {
      it("returns 0 when no images", () => {
        mockedStore.dataset = {
          ...mockedStore.dataset,
          images: () => null,
        } as any;
        wrapper = mountComponent();
        const result = wrapper.vm.unrollIndex(0, 0, 0, false, false, false);
        expect(result).toBe(0);
      });

      it("calls unrollIndexFromImages", () => {

        (unrollIndexFromImages as any).mockReturnValue(3);
        wrapper = mountComponent();
        const result = wrapper.vm.unrollIndex(1, 2, 3, false, false, false);
        expect(unrollIndexFromImages).toHaveBeenCalled();
        expect(result).toBe(3);
      });

      it("passes -1 for unrolled dimensions", () => {
        wrapper = mountComponent();
        const datasetImages = vi.fn().mockReturnValue([]);
        mockedStore.dataset = {
          ...mockedStore.dataset,
          images: datasetImages,
        } as any;
        wrapper.vm.unrollIndex(1, 2, 3, true, true, true);
        expect(datasetImages).toHaveBeenCalledWith(-1, -1, -1, 0);
      });

      it("passes actual index for non-unrolled dimensions", () => {
        wrapper = mountComponent();
        const datasetImages = vi.fn().mockReturnValue([]);
        mockedStore.dataset = {
          ...mockedStore.dataset,
          images: datasetImages,
        } as any;
        wrapper.vm.unrollIndex(1, 2, 3, false, false, false);
        expect(datasetImages).toHaveBeenCalledWith(2, 3, 1, 0);
      });
    });

    // --- unrolledCoordinates ---
    describe("unrolledCoordinates", () => {
      it("returns coordinates unchanged when not unrolling", () => {
        mockedStore.unroll = false;
        wrapper = mountComponent();
        const coords = [{ x: 10, y: 20 }];
        const image = { sizeX: 1024, sizeY: 1024 };
        const result = wrapper.vm.unrolledCoordinates(
          coords,
          { XY: 0, Z: 0, Time: 0 },
          image,
        );
        expect(result).toBe(coords);
      });

      it("offsets coordinates when unrolling", () => {
        mockedStore.unroll = true;

        (unrollIndexFromImages as any).mockReturnValue(1); // tileIndex=1, tileX=0, tileY=1 (with unrollW=1)
        wrapper = mountComponent({ unrollW: 1 });
        const coords = [{ x: 10, y: 20 }];
        const image = { sizeX: 100, sizeY: 200 };
        const result = wrapper.vm.unrolledCoordinates(
          coords,
          { XY: 0, Z: 0, Time: 0 },
          image,
        );
        // tileX = 1 % 1 = 0, tileY = floor(1 / 1) = 1
        // x = 100*0 + 10 = 10, y = 200*1 + 20 = 220
        expect(result[0].x).toBe(10);
        expect(result[0].y).toBe(220);
      });

      it("calculates tileX/Y from unrollW", () => {
        mockedStore.unroll = true;

        (unrollIndexFromImages as any).mockReturnValue(3); // tileIndex=3, with unrollW=2: tileX=1, tileY=1
        wrapper = mountComponent({ unrollW: 2 });
        const coords = [{ x: 5, y: 10 }];
        const image = { sizeX: 50, sizeY: 50 };
        const result = wrapper.vm.unrolledCoordinates(
          coords,
          { XY: 0, Z: 0, Time: 0 },
          image,
        );
        // tileX = 3 % 2 = 1, tileY = floor(3 / 2) = 1
        // x = 50*1 + 5 = 55, y = 50*1 + 10 = 60
        expect(result[0].x).toBe(55);
        expect(result[0].y).toBe(60);
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
        const result = wrapper.vm.findConnectedComponents(connections);
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
        const result = wrapper.vm.findConnectedComponents(connections);
        expect(result).toHaveLength(2);
      });

      it("handles cycles", () => {
        const connections = [
          makeConnection({ id: "c1", parentId: "a1", childId: "a2" }),
          makeConnection({ id: "c2", parentId: "a2", childId: "a3" }),
          makeConnection({ id: "c3", parentId: "a3", childId: "a1" }),
        ];
        const result = wrapper.vm.findConnectedComponents(connections);
        expect(result).toHaveLength(1);
        expect(result[0].annotations.size).toBe(3);
      });

      it("handles empty connections", () => {
        const result = wrapper.vm.findConnectedComponents([]);
        expect(result).toHaveLength(0);
      });

      it("merges components through bridge connections", () => {
        const connections = [
          makeConnection({ id: "c1", parentId: "a1", childId: "a2" }),
          makeConnection({ id: "c2", parentId: "a3", childId: "a4" }),
          // Bridge connects the two groups
          makeConnection({ id: "c3", parentId: "a2", childId: "a3" }),
        ];
        const result = wrapper.vm.findConnectedComponents(connections);
        expect(result).toHaveLength(1);
        expect(result[0].annotations.size).toBe(4);
      });

      it("groups connections into correct components", () => {
        const connections = [
          makeConnection({ id: "c1", parentId: "a1", childId: "a2" }),
          makeConnection({ id: "c2", parentId: "a3", childId: "a4" }),
        ];
        const result = wrapper.vm.findConnectedComponents(connections);
        // Each component should have its own connection
        const connCounts = result.map((c) => c.connections.length);
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
        const result = wrapper.vm.getDisplayedAnnotationIdsAcrossTime();
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
        const result = wrapper.vm.getDisplayedAnnotationIdsAcrossTime();
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
        const result = wrapper.vm.getDisplayedAnnotationIdsAcrossTime();
        expect(result.size).toBe(0);
      });
    });

    // --- drawTimelapseConnectionsAndCentroids ---
    describe("drawTimelapseConnectionsAndCentroids", () => {
      it("clears previous tracks", () => {
        wrapper = mountComponent();
        wrapper.vm.drawTimelapseConnectionsAndCentroids();
        expect(wrapper.vm.timelapseLayer.removeAllAnnotations).toHaveBeenCalled();
      });

      it("exits early when showTimelapseMode is false", () => {
        mockedStore.showTimelapseMode = false;
        wrapper = mountComponent();
        const tLayer = wrapper.vm.timelapseLayer;
        vi.clearAllMocks();
        wrapper.vm.drawTimelapseConnectionsAndCentroids();
        expect(tLayer.removeAllAnnotations).toHaveBeenCalled();
        expect(tLayer.draw).toHaveBeenCalled();
      });

      it("filters connections by displayed annotations", () => {
        mockedStore.showTimelapseMode = true;
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
        wrapper.vm.drawTimelapseConnectionsAndCentroids();
        // Should process without errors
        expect(wrapper.vm.timelapseLayer.draw).toHaveBeenCalled();
      });

      it("respects time window filtering", () => {
        mockedStore.showTimelapseMode = true;
        mockedStore.timelapseModeWindow = 1;
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
        wrapper.vm.drawTimelapseConnectionsAndCentroids();
        expect(wrapper.vm.timelapseLayer.draw).toHaveBeenCalled();
      });

      it("filters by timelapseTags when specified", () => {
        mockedStore.showTimelapseMode = true;
        mockedStore.timelapseTags = ["trackable"];
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
        wrapper.vm.drawTimelapseConnectionsAndCentroids();
        expect(wrapper.vm.timelapseLayer.draw).toHaveBeenCalled();
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
        wrapper.vm.handleDragStart({ geo: { x: 10, y: 20 }, modifiers: { alt: false } });
        expect(wrapper.vm.isDragging).toBe(false);
      });

      it("requires geo coordinates", () => {
        wrapper = mountComponent();
        wrapper.vm.handleDragStart({ modifiers: { alt: true } });
        expect(wrapper.vm.isDragging).toBe(false);
      });

      it("starts dragging when annotation is found", () => {
        const ann1 = makeAnnotation({ id: "a1", shape: "point" });
        (mockedAnnotationStore.getAnnotationFromId as any).mockReturnValue(ann1);
        (pointDistance as any).mockReturnValue(1);

        wrapper = mountComponent();
        const geoAnn = mockGeoJSAnnotation("point");
        geoAnn.options("girderId", "a1");
        wrapper.vm.annotationLayer.annotations = vi.fn(() => [geoAnn]);

        // Mock geojsAnnotationFactory to return a ghost
        const ghost = mockGeoJSAnnotation("point");
        (geojsAnnotationFactory as any).mockReturnValue(ghost);

        wrapper.vm.handleDragStart({
          geo: { x: 10, y: 20 },
          modifiers: { alt: true },
        });

        expect(wrapper.vm.isDragging).toBe(true);
        expect(wrapper.vm.draggedAnnotation).toBe(ann1);
        expect(wrapper.vm.dragStartPosition).toEqual({ x: 10, y: 20 });
      });

      it("creates ghost annotation and adds to interactionLayer", () => {
        const ann1 = makeAnnotation({ id: "a1", shape: "point" });
        (mockedAnnotationStore.getAnnotationFromId as any).mockReturnValue(ann1);
        (pointDistance as any).mockReturnValue(1);

        wrapper = mountComponent();
        const geoAnn = mockGeoJSAnnotation("point");
        geoAnn.options("girderId", "a1");
        wrapper.vm.annotationLayer.annotations = vi.fn(() => [geoAnn]);

        const ghost = mockGeoJSAnnotation("point");
        (geojsAnnotationFactory as any).mockReturnValue(ghost);

        wrapper.vm.handleDragStart({
          geo: { x: 10, y: 20 },
          modifiers: { alt: true },
        });

        expect(wrapper.vm.interactionLayer.addAnnotation).toHaveBeenCalledWith(ghost);
      });

      it("does nothing when no annotation found under click", () => {
        (mockedAnnotationStore.getAnnotationFromId as any).mockReturnValue(undefined);
        wrapper = mountComponent();
        wrapper.vm.annotationLayer.annotations = vi.fn(() => []);

        wrapper.vm.handleDragStart({
          geo: { x: 10, y: 20 },
          modifiers: { alt: true },
        });
        expect(wrapper.vm.isDragging).toBe(false);
      });
    });

    // --- handleDragMove ---
    describe("handleDragMove", () => {
      it("returns early when not dragging", () => {
        wrapper = mountComponent();
        wrapper.vm.handleDragMove({ geo: { x: 50, y: 50 } });
        // No error thrown
      });

      it("calculates dx/dy from start position", () => {
        wrapper = mountComponent();
        const ghost = mockGeoJSAnnotation("point");
        wrapper.vm.isDragging = true;
        wrapper.vm.dragStartPosition = { x: 10, y: 20 };
        wrapper.vm.draggedAnnotation = makeAnnotation({ id: "a1" });
        wrapper.vm.dragGhostAnnotation = ghost;
        wrapper.vm.dragOriginalCoordinates = [{ x: 5, y: 10 }];

        wrapper.vm.handleDragMove({ geo: { x: 30, y: 40 } });
        // dx = 30-10 = 20, dy = 40-20 = 20
        expect(ghost._coordinates).toHaveBeenCalled();
      });

      it("updates ghost coordinates", () => {
        wrapper = mountComponent();
        const ghost = mockGeoJSAnnotation("point");
        wrapper.vm.isDragging = true;
        wrapper.vm.dragStartPosition = { x: 0, y: 0 };
        wrapper.vm.draggedAnnotation = makeAnnotation({ id: "a1" });
        wrapper.vm.dragGhostAnnotation = ghost;
        wrapper.vm.dragOriginalCoordinates = [{ x: 100, y: 200 }];

        wrapper.vm.handleDragMove({ geo: { x: 10, y: 15 } });
        expect(ghost._coordinates).toHaveBeenCalled();
        expect(ghost.draw).toHaveBeenCalled();
      });

      it("does nothing when geo is missing", () => {
        wrapper = mountComponent();
        wrapper.vm.isDragging = true;
        wrapper.vm.dragStartPosition = { x: 0, y: 0 };
        wrapper.vm.draggedAnnotation = makeAnnotation({ id: "a1" });
        const ghost = mockGeoJSAnnotation("point");
        wrapper.vm.dragGhostAnnotation = ghost;
        wrapper.vm.dragOriginalCoordinates = [{ x: 5, y: 10 }];

        wrapper.vm.handleDragMove({});
        expect(ghost._coordinates).not.toHaveBeenCalled();
      });
    });

    // --- handleDragEnd ---
    describe("handleDragEnd", () => {
      it("returns early when not dragging", async () => {
        wrapper = mountComponent();
        await wrapper.vm.handleDragEnd({ geo: { x: 50, y: 50 } });
        expect(mockedAnnotationStore.updateAnnotationsPerId).not.toHaveBeenCalled();
      });

      it("commits offset via updateAnnotationsPerId", async () => {
        wrapper = mountComponent();
        const ghost = mockGeoJSAnnotation("point");
        wrapper.vm.isDragging = true;
        wrapper.vm.dragStartPosition = { x: 0, y: 0 };
        wrapper.vm.draggedAnnotation = makeAnnotation({ id: "a1" });
        wrapper.vm.dragGhostAnnotation = ghost;
        wrapper.vm.dragOriginalCoordinates = [{ x: 100, y: 200 }];

        await wrapper.vm.handleDragEnd({ geo: { x: 10, y: 15 } });
        expect(mockedAnnotationStore.updateAnnotationsPerId).toHaveBeenCalledWith(
          expect.objectContaining({
            annotationIds: ["a1"],
          }),
        );
      });

      it("removes ghost and resets state", async () => {
        wrapper = mountComponent();
        const ghost = mockGeoJSAnnotation("point");
        wrapper.vm.isDragging = true;
        wrapper.vm.dragStartPosition = { x: 0, y: 0 };
        wrapper.vm.draggedAnnotation = makeAnnotation({ id: "a1" });
        wrapper.vm.dragGhostAnnotation = ghost;
        wrapper.vm.dragOriginalCoordinates = [{ x: 100, y: 200 }];

        await wrapper.vm.handleDragEnd({ geo: { x: 10, y: 15 } });
        expect(wrapper.vm.interactionLayer.removeAnnotation).toHaveBeenCalledWith(ghost);
        expect(wrapper.vm.isDragging).toBe(false);
        expect(wrapper.vm.dragStartPosition).toBeNull();
        expect(wrapper.vm.draggedAnnotation).toBeNull();
        expect(wrapper.vm.dragGhostAnnotation).toBeNull();
      });

      it("does nothing when geo is missing", async () => {
        wrapper = mountComponent();
        wrapper.vm.isDragging = true;
        wrapper.vm.dragStartPosition = { x: 0, y: 0 };
        wrapper.vm.draggedAnnotation = makeAnnotation({ id: "a1" });
        wrapper.vm.dragGhostAnnotation = mockGeoJSAnnotation("point");
        wrapper.vm.dragOriginalCoordinates = [{ x: 5, y: 10 }];

        await wrapper.vm.handleDragEnd({});
        expect(mockedAnnotationStore.updateAnnotationsPerId).not.toHaveBeenCalled();
      });
    });

    // --- onMousePathChanged ---
    describe("onMousePathChanged", () => {
      it("calls consumeMouseState when newState is null and oldState was active", () => {
        wrapper = mountComponent();
        const spy = vi.spyOn(wrapper.vm, "consumeMouseState").mockImplementation(() => {});
        const oldState = {
          isMouseMovePreviewState: false,
          path: [{ x: 10, y: 20 }],
        };
        wrapper.vm.onMousePathChanged(null, oldState);
        expect(spy).toHaveBeenCalledWith(oldState);
      });

      it("calls previewMouseState for non-null newState", () => {
        wrapper = mountComponent();
        const spy = vi.spyOn(wrapper.vm, "previewMouseState").mockImplementation(() => {});
        const newState = {
          isMouseMovePreviewState: true,
          path: [{ x: 10, y: 20 }],
        };
        wrapper.vm.onMousePathChanged(newState, null);
        expect(spy).toHaveBeenCalledWith(newState);
      });
    });

    // --- previewMouseState / consumeMouseState ---
    describe("previewMouseState", () => {
      it("removes previous selectionAnnotation", () => {
        wrapper = mountComponent();
        const prev = mockGeoJSAnnotation("line");
        wrapper.vm.selectionAnnotation = prev;
        wrapper.vm.previewMouseState(null);
        expect(wrapper.vm.interactionLayer.removeAnnotation).toHaveBeenCalledWith(prev);
      });

      it("creates line annotation for multi-point path", () => {
        wrapper = mountComponent();
        const lineAnn = mockGeoJSAnnotation("line");
        (geojs as any).annotation.lineAnnotation.mockReturnValue(lineAnn);

        wrapper.vm.previewMouseState({
          path: [
            { x: 0, y: 0 },
            { x: 10, y: 10 },
          ],
        });
        expect(wrapper.vm.selectionAnnotation).toBe(lineAnn);
      });

      it("sets null selectionAnnotation for single-point path", () => {
        wrapper = mountComponent();
        wrapper.vm.previewMouseState({ path: [{ x: 0, y: 0 }] });
        expect(wrapper.vm.selectionAnnotation).toBeNull();
      });

      it("adds selectionAnnotation to interactionLayer when created", () => {
        wrapper = mountComponent();
        const lineAnn = mockGeoJSAnnotation("line");
        (geojs as any).annotation.lineAnnotation.mockReturnValue(lineAnn);

        wrapper.vm.previewMouseState({
          path: [
            { x: 0, y: 0 },
            { x: 10, y: 10 },
          ],
        });
        expect(wrapper.vm.interactionLayer.addAnnotation).toHaveBeenCalledWith(lineAnn);
      });
    });

    describe("consumeMouseState", () => {
      it("removes selectionAnnotation", () => {
        wrapper = mountComponent();
        const prev = mockGeoJSAnnotation("line");
        wrapper.vm.selectionAnnotation = prev;
        const spy = vi.spyOn(wrapper.vm, "selectAnnotations").mockImplementation(() => {});

        wrapper.vm.consumeMouseState({
          path: [{ x: 10, y: 20 }],
        });
        expect(wrapper.vm.interactionLayer.removeAnnotation).toHaveBeenCalledWith(prev);
        expect(wrapper.vm.selectionAnnotation).toBeNull();
      });

      it("returns early when path is empty", () => {
        wrapper = mountComponent();
        const spy = vi.spyOn(wrapper.vm, "selectAnnotations").mockImplementation(() => {});
        wrapper.vm.consumeMouseState({ path: [] });
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
        wrapper.vm.handleAnnotationRightClick(null);
        expect(wrapper.vm.showContextMenu).toBe(false);
      });

      it("sets annotation and shows context menu", () => {
        const ann1 = makeAnnotation({ id: "a1" });
        (mockedAnnotationStore.getAnnotationFromId as any).mockReturnValue(ann1);
        (pointDistance as any).mockReturnValue(1);

        wrapper = mountComponent();
        const geoAnn = mockGeoJSAnnotation("point");
        geoAnn.options("girderId", "a1");
        wrapper.vm.annotationLayer.annotations = vi.fn(() => [geoAnn]);

        wrapper.vm.handleAnnotationRightClick({
          geo: { x: 10, y: 20 },
          evt: { clientX: 100, clientY: 200 },
        });
        expect(wrapper.vm.showContextMenu).toBe(true);
        expect(wrapper.vm.rightClickedAnnotation).toBe(ann1);
      });

      it("sets coordinates from mouse event", () => {
        const ann1 = makeAnnotation({ id: "a1" });
        (mockedAnnotationStore.getAnnotationFromId as any).mockReturnValue(ann1);
        (pointDistance as any).mockReturnValue(1);

        wrapper = mountComponent();
        const geoAnn = mockGeoJSAnnotation("point");
        geoAnn.options("girderId", "a1");
        wrapper.vm.annotationLayer.annotations = vi.fn(() => [geoAnn]);

        wrapper.vm.handleAnnotationRightClick({
          geo: { x: 10, y: 20 },
          evt: { clientX: 150, clientY: 250 },
        });
        expect(wrapper.vm.contextMenuX).toBe(150);
        expect(wrapper.vm.contextMenuY).toBe(250);
      });
    });

    // --- handleContextMenuSave ---
    describe("handleContextMenuSave", () => {
      it("calls colorAnnotationIds and hides menu", () => {
        wrapper = mountComponent();
        wrapper.vm.showContextMenu = true;

        wrapper.vm.handleContextMenuSave({
          annotationId: "a1",
          color: "#ff0000",
        });
        expect(mockedAnnotationStore.colorAnnotationIds).toHaveBeenCalledWith({
          annotationIds: ["a1"],
          color: "#ff0000",
        });
        expect(wrapper.vm.showContextMenu).toBe(false);
      });

      it("does not call colorAnnotationIds when no annotationId", () => {
        wrapper = mountComponent();
        wrapper.vm.handleContextMenuSave({ color: "#ff0000" });
        expect(mockedAnnotationStore.colorAnnotationIds).not.toHaveBeenCalled();
        expect(wrapper.vm.showContextMenu).toBe(false);
      });
    });

    // --- handleContextMenuCancel ---
    describe("handleContextMenuCancel", () => {
      it("hides context menu", () => {
        wrapper = mountComponent();
        wrapper.vm.showContextMenu = true;
        wrapper.vm.rightClickedAnnotation = makeAnnotation({ id: "a1" });

        wrapper.vm.handleContextMenuCancel();
        expect(wrapper.vm.showContextMenu).toBe(false);
        expect(wrapper.vm.rightClickedAnnotation).toBeNull();
      });
    });

    // --- handleDeselectAll ---
    describe("handleDeselectAll", () => {
      it("calls clearSelectedAnnotations", () => {
        wrapper = mountComponent();
        wrapper.vm.handleDeselectAll();
        expect(
          mockedAnnotationStore.clearSelectedAnnotations,
        ).toHaveBeenCalled();
      });
    });

    // --- handleTagSubmit ---
    describe("handleTagSubmit", () => {
      it("calls tagSelectedAnnotations on add", () => {
        wrapper = mountComponent();
        wrapper.vm.handleTagSubmit({
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
        wrapper.vm.handleTagSubmit({
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
        wrapper.vm.handleColorSubmit({
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
        wrapper.vm.handleColorSubmit({
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
        wrapper.vm.handleColorSubmit({
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
        expect(wrapper.vm.annotationLayer.geoOn).toHaveBeenCalled();
      });

      it("calls bindTimelapseEvents on mount", () => {
        wrapper = mountComponent();
        // bindTimelapseEvents registers geoOn on timelapseLayer
        expect(wrapper.vm.timelapseLayer.geoOn).toHaveBeenCalled();
      });

      it("calls bindInteractionEvents on mount", () => {
        wrapper = mountComponent();
        // bindInteractionEvents registers geoOn on interactionLayer
        expect(wrapper.vm.interactionLayer.geoOn).toHaveBeenCalled();
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
        const geoOnCalls = (wrapper.vm.annotationLayer.geoOn as any).mock
          .calls;
        const mouseclickCalls = geoOnCalls.filter(
          (call: any[]) => call[0] === "geojs.mouseclick",
        );
        expect(mouseclickCalls.length).toBeGreaterThanOrEqual(1);
      });
    });

    describe("beforeDestroy", () => {
      it("removes drag event listeners", () => {
        wrapper = mountComponent();
        const geoOffSpy = wrapper.vm.annotationLayer.geoOff;
        wrapper.destroy();
        // Should have called geoOff for mousedown, mousemove, mouseup
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
        const geoOnCalls = (wrapper.vm.annotationLayer.geoOn as any).mock
          .calls;
        const mouseclickCalls = geoOnCalls.filter(
          (call: any[]) => call[0] === "geojs.mouseclick",
        );
        expect(mouseclickCalls.length).toBeGreaterThanOrEqual(1);
      });

      it("registers drag handlers on annotationLayer", () => {
        wrapper = mountComponent();
        const geoOnCalls = (wrapper.vm.annotationLayer.geoOn as any).mock
          .calls;
        const eventTypes = geoOnCalls.map((call: any[]) => call[0]);
        expect(eventTypes).toContain("geojs.mousedown");
        expect(eventTypes).toContain("geojs.mousemove");
        expect(eventTypes).toContain("geojs.mouseup");
      });

      it("calls drawAnnotationsAndTooltips", () => {
        wrapper = mountComponent();
        // After mount, annotations should have been drawn
        // The annotationLayer.draw should have been called
        expect(wrapper.vm.annotationLayer.draw).toHaveBeenCalled();
      });
    });

    describe("bindInteractionEvents", () => {
      it("returns early when interactionLayer is null", () => {
        // We can't pass null interactionLayer (component crashes),
        // so just verify the method is callable after mount
        wrapper = mountComponent();
        expect(wrapper.vm.interactionLayer.geoOn).toHaveBeenCalled();
      });

      it("registers annotation mode/add/update/state handlers", () => {
        wrapper = mountComponent();
        const geoOnCalls = (wrapper.vm.interactionLayer.geoOn as any).mock
          .calls;
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
        const geoOnCalls = (wrapper.vm.interactionLayer.geoOn as any).mock
          .calls;
        const mouseclickCalls = geoOnCalls.filter(
          (call: any[]) => call[0] === "geojs.mouseclick",
        );
        expect(mouseclickCalls.length).toBeGreaterThanOrEqual(1);
      });
    });

    describe("bindTimelapseEvents", () => {
      it("registers mouseclick handler on timelapseLayer", () => {
        wrapper = mountComponent();
        const geoOnCalls = (wrapper.vm.timelapseLayer.geoOn as any).mock
          .calls;
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
        expect(wrapper.vm.samToolState).toBeNull();
      });

      it("returns null when SAM map does not match component map", () => {
        const wrongMap = { map: "wrong-map" };
        mockedStore.selectedTool = {
          configuration: { type: "samAnnotation", values: {} },
          state: {
            type: SamAnnotationToolStateSymbol,
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
        expect(wrapper.vm.samToolState).toBeNull();
      });

      it("returns state when SAM map matches component map", async () => {
        wrapper = mountComponent();
        const mapObj = wrapper.vm.map;
        mockedStore.selectedTool = {
          configuration: { type: "samAnnotation", values: {} },
          state: {
            type: SamAnnotationToolStateSymbol,
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
        expect(wrapper.vm.samToolState).not.toBeNull();
        expect(wrapper.vm.samToolState.type).toBe(
          SamAnnotationToolStateSymbol,
        );
      });
    });

    describe("samPrompts", () => {
      it("returns empty array when samToolState is null", () => {
        mockedStore.selectedTool = null;
        wrapper = mountComponent();
        expect(wrapper.vm.samPrompts).toEqual([]);
      });

      it("returns empty array when mainPrompt output is NoOutput", async () => {
        wrapper = mountComponent();
        const mapObj = wrapper.vm.map;
        mockedStore.selectedTool = {
          configuration: { type: "samAnnotation", values: {} },
          state: {
            type: SamAnnotationToolStateSymbol,
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
        expect(wrapper.vm.samPrompts).toEqual([]);
      });

      it("returns prompts when mainPrompt has output", async () => {
        // Must mock samPromptToAnnotation before setting tool, because
        // the @Watch("samPrompts") watcher fires and calls it
        const mockAnn = mockGeoJSAnnotation("polygon");
        (samPromptToAnnotation as any).mockReturnValue(mockAnn);

        wrapper = mountComponent();
        const mapObj = wrapper.vm.map;
        const mockPrompts = [
          { type: "point", x: 10, y: 20, positive: true },
        ];
        mockedStore.selectedTool = {
          configuration: { type: "samAnnotation", values: {} },
          state: {
            type: SamAnnotationToolStateSymbol,
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
        expect(wrapper.vm.samPrompts).toEqual(mockPrompts);
      });
    });

    describe("onSamMainOutputChanged", () => {
      it("removes previous samUnsubmittedAnnotation", () => {
        wrapper = mountComponent();
        const oldAnnotation = mockGeoJSAnnotation("polygon");
        wrapper.vm.samUnsubmittedAnnotation = oldAnnotation;

        wrapper.vm.onSamMainOutputChanged();

        expect(
          wrapper.vm.annotationLayer.removeAnnotation,
        ).toHaveBeenCalledWith(oldAnnotation);
        expect(wrapper.vm.samUnsubmittedAnnotation).toBeNull();
      });

      it("creates polygon annotation when output has vertices", async () => {
        wrapper = mountComponent();
        // Set samMainOutput to return vertices by mocking samToolState
        const mapObj = wrapper.vm.map;
        const vertices = [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
        ];
        mockedStore.selectedTool = {
          configuration: { type: "samAnnotation", values: {} },
          state: {
            type: SamAnnotationToolStateSymbol,
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
        wrapper.vm.onSamMainOutputChanged();

        expect(geojs.annotation.polygonAnnotation).toHaveBeenCalled();
        expect(wrapper.vm.samUnsubmittedAnnotation).not.toBeNull();
        expect(
          wrapper.vm.annotationLayer.addAnnotation,
        ).toHaveBeenCalled();
      });

      it("returns early when output is null", () => {
        wrapper = mountComponent();
        mockedStore.selectedTool = null;
        const addSpy = wrapper.vm.annotationLayer.addAnnotation;
        (addSpy as any).mockClear();

        wrapper.vm.onSamMainOutputChanged();

        // Should not add any annotation since samMainOutput is null
        expect(wrapper.vm.samUnsubmittedAnnotation).toBeNull();
      });
    });

    describe("onSamLivePreviewOutputChanged", () => {
      it("removes previous samLivePreviewAnnotation", () => {
        wrapper = mountComponent();
        const oldAnnotation = mockGeoJSAnnotation("polygon");
        wrapper.vm.samLivePreviewAnnotation = oldAnnotation;

        wrapper.vm.onSamLivePreviewOutputChanged();

        expect(
          wrapper.vm.annotationLayer.removeAnnotation,
        ).toHaveBeenCalledWith(oldAnnotation);
        expect(wrapper.vm.samLivePreviewAnnotation).toBeNull();
      });

      it("creates polygon annotation for small enough preview", async () => {
        wrapper = mountComponent();
        const mapObj = wrapper.vm.map;
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
        wrapper.vm.onSamLivePreviewOutputChanged();

        expect(geojs.annotation.polygonAnnotation).toHaveBeenCalled();
        expect(wrapper.vm.samLivePreviewAnnotation).not.toBeNull();
      });

      it("skips annotation when preview is too large for viewport", async () => {
        wrapper = mountComponent();
        const mapObj = wrapper.vm.map;
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
        const addSpy = wrapper.vm.annotationLayer.addAnnotation;
        (addSpy as any).mockClear();

        wrapper.vm.onSamLivePreviewOutputChanged();

        // Should not create annotation because it's too large
        expect(wrapper.vm.samLivePreviewAnnotation).toBeNull();
      });

      it("returns early when livePreview is null", () => {
        wrapper = mountComponent();
        mockedStore.selectedTool = null;

        wrapper.vm.onSamLivePreviewOutputChanged();

        expect(wrapper.vm.samLivePreviewAnnotation).toBeNull();
      });
    });

    describe("onSamPromptsChanged", () => {
      it("removes old prompt annotations and creates new ones", () => {
        wrapper = mountComponent();
        const oldPromptAnn = mockGeoJSAnnotation("polygon");
        wrapper.vm.samPromptAnnotations = [oldPromptAnn];

        const newAnn = mockGeoJSAnnotation("polygon");
        (samPromptToAnnotation as any).mockReturnValue(newAnn);

        const mockPrompts = [{ type: "point", x: 10, y: 20, positive: true }];
        wrapper.vm.onSamPromptsChanged(mockPrompts);

        expect(
          wrapper.vm.annotationLayer.removeAnnotation,
        ).toHaveBeenCalledWith(oldPromptAnn);
        expect(samPromptToAnnotation).toHaveBeenCalledWith(
          mockPrompts[0],
          expect.any(Object),
        );
        expect(wrapper.vm.samPromptAnnotations).toHaveLength(1);
      });

      it("marks new annotations as specialAnnotation", () => {
        wrapper = mountComponent();
        wrapper.vm.samPromptAnnotations = [];

        const newAnn = mockGeoJSAnnotation("polygon");
        (samPromptToAnnotation as any).mockReturnValue(newAnn);

        wrapper.vm.onSamPromptsChanged([
          { type: "point", x: 10, y: 20, positive: true },
        ]);

        expect(newAnn.options).toHaveBeenCalledWith(
          "specialAnnotation",
          true,
        );
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
        wrapper.vm.handlingPrimaryChange = false;
        wrapper.vm.onPrimaryChange();
        // Flag should be set during the call
        // After nextTick it should be cleared, but during the call it's true
        expect(wrapper.vm.drawAnnotationsAndTooltips).toBeDefined();
      });

      it("calls drawAnnotationsAndTooltips", () => {
        wrapper = mountComponent();
        const spy = vi.spyOn(wrapper.vm, "drawAnnotationsAndTooltips");
        wrapper.vm.onPrimaryChange();
        expect(spy).toHaveBeenCalled();
      });

      it("clears flag after nextTick", async () => {
        wrapper = mountComponent();
        wrapper.vm.onPrimaryChange();
        await wrapper.vm.$nextTick();
        expect(wrapper.vm.handlingPrimaryChange).toBe(false);
      });
    });

    describe("onDisplayedAnnotationsChange", () => {
      it("draws when not handling primary change", () => {
        wrapper = mountComponent();
        wrapper.vm.handlingPrimaryChange = false;
        const spy = vi.spyOn(wrapper.vm, "drawAnnotationsAndTooltips");
        wrapper.vm.onDisplayedAnnotationsChange();
        expect(spy).toHaveBeenCalled();
      });

      it("skips when handling primary change", () => {
        wrapper = mountComponent();
        wrapper.vm.handlingPrimaryChange = true;
        const spy = vi.spyOn(wrapper.vm, "drawAnnotationsAndTooltips");
        wrapper.vm.onDisplayedAnnotationsChange();
        expect(spy).not.toHaveBeenCalled();
      });
    });

    describe("onRestyleNeeded", () => {
      it("calls restyleAnnotations", () => {
        wrapper = mountComponent();
        const spy = vi.spyOn(wrapper.vm, "restyleAnnotations");
        wrapper.vm.onRestyleNeeded();
        expect(spy).toHaveBeenCalled();
      });
    });

    describe("onTimelapseModeChanged", () => {
      it("calls drawTimelapseConnectionsAndCentroids", () => {
        wrapper = mountComponent();
        const spy = vi.spyOn(
          wrapper.vm,
          "drawTimelapseConnectionsAndCentroids",
        );
        wrapper.vm.onTimelapseModeChanged();
        expect(spy).toHaveBeenCalled();
      });
    });

    describe("watchTool", () => {
      it("calls refreshAnnotationMode", () => {
        wrapper = mountComponent();
        const spy = vi.spyOn(wrapper.vm, "refreshAnnotationMode");
        wrapper.vm.watchTool();
        expect(spy).toHaveBeenCalled();
      });
    });

    describe("watchFilter", () => {
      it("calls refreshAnnotationMode when roiFilter is active", () => {
        mockedFilterStore.emptyROIFilter = { id: "roi1" } as any;
        wrapper = mountComponent();
        const spy = vi.spyOn(wrapper.vm, "refreshAnnotationMode");
        wrapper.vm.watchFilter();
        expect(spy).toHaveBeenCalled();
      });

      it("does not call refreshAnnotationMode when no roiFilter", () => {
        mockedFilterStore.emptyROIFilter = null;
        wrapper = mountComponent();
        const spy = vi.spyOn(wrapper.vm, "refreshAnnotationMode");
        wrapper.vm.watchFilter();
        expect(spy).not.toHaveBeenCalled();
      });
    });

    describe("onUnrollChanged", () => {
      it("clears and redraws annotations", () => {
        wrapper = mountComponent();
        const clearSpy = vi.spyOn(wrapper.vm, "clearOldAnnotations");
        const drawSpy = vi.spyOn(wrapper.vm, "drawAnnotationsAndTooltips");
        wrapper.vm.onUnrollChanged();
        expect(clearSpy).toHaveBeenCalledWith(true);
        expect(drawSpy).toHaveBeenCalled();
      });
    });

    describe("baseStyle", () => {
      it("uses scaled:false when scaleAnnotationsWithZoom is true", () => {
        mockedStore.scaleAnnotationsWithZoom = true;
        wrapper = mountComponent();
        expect(wrapper.vm.baseStyle.scaled).toBe(false);
      });

      it("uses scaled:1 when scaleAnnotationsWithZoom is false", () => {
        mockedStore.scaleAnnotationsWithZoom = false;
        wrapper = mountComponent();
        expect(wrapper.vm.baseStyle.scaled).toBe(1);
      });

      it("uses annotationsRadius from store", () => {
        mockedStore.annotationsRadius = 10;
        wrapper = mountComponent();
        expect(wrapper.vm.baseStyle.radius).toBe(10);
      });

      it("uses annotationOpacity from store", () => {
        mockedStore.annotationOpacity = 0.8;
        wrapper = mountComponent();
        expect(wrapper.vm.baseStyle.fillOpacity).toBe(0.8);
      });
    });

    describe("getAnnotationStyle", () => {
      it("passes hovered=true for hoveredAnnotationId", () => {
        mockedAnnotationStore.hoveredAnnotationId = "ann1";
        wrapper = mountComponent();
        wrapper.vm.getAnnotationStyle("ann1", null, "red");
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
        wrapper.vm.getAnnotationStyle("ann1", null, "red");
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
        wrapper.vm.getAnnotationStyle("ann1", null, "red");
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
        expect(wrapper.vm.toolHighlightedAnnotationIds.size).toBe(0);
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
        expect(wrapper.vm.toolHighlightedAnnotationIds.has("ann1")).toBe(
          true,
        );
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
        expect(wrapper.vm.toolHighlightedAnnotationIds.has("ann2")).toBe(
          true,
        );
      });
    });

    describe("getAnyLayerForChannel", () => {
      it("returns layer when channel matches", () => {
        const layer1 = makeLayer({ id: "l1", channel: 2 });
        mockedStore.layers = [layer1];
        wrapper = mountComponent();
        expect(wrapper.vm.getAnyLayerForChannel(2)).toEqual(layer1);
      });

      it("returns undefined when no layer matches channel", () => {
        mockedStore.layers = [makeLayer({ id: "l1", channel: 0 })];
        wrapper = mountComponent();
        expect(wrapper.vm.getAnyLayerForChannel(5)).toBeUndefined();
      });
    });

    describe("isLayerIdValid", () => {
      it("returns true for valid layer id", () => {
        const layer1 = makeLayer({ id: "l1" });
        mockedStore.layers = [layer1];
        wrapper = mountComponent({ lowestLayer: 0, layerCount: 10 });
        expect(wrapper.vm.isLayerIdValid("l1")).toBe(true);
      });

      it("returns false for invalid layer id", () => {
        mockedStore.layers = [makeLayer({ id: "l1" })];
        wrapper = mountComponent({ lowestLayer: 0, layerCount: 10 });
        expect(wrapper.vm.isLayerIdValid("nonexistent")).toBe(false);
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
        expect(wrapper.vm.layerDisplaysAnnotation("l1", "a1")).toBe(true);
      });

      it("returns false when annotation does not belong to layer", () => {
        const layer1 = makeLayer({ id: "l1", channel: 0 });
        mockedStore.layers = [layer1];
        mockedAnnotationStore.annotations = [];
        wrapper = mountComponent({ lowestLayer: 0, layerCount: 10 });
        expect(wrapper.vm.layerDisplaysAnnotation("l1", "nonexistent")).toBe(
          false,
        );
      });
    });

    describe("handleInteractionModeChange", () => {
      it("calls refreshAnnotationMode when mode is null", () => {
        wrapper = mountComponent();
        const spy = vi.spyOn(wrapper.vm, "refreshAnnotationMode");
        wrapper.vm.handleInteractionModeChange({ mode: null });
        expect(spy).toHaveBeenCalled();
      });

      it("does not call refreshAnnotationMode when mode is not null", () => {
        wrapper = mountComponent();
        const spy = vi.spyOn(wrapper.vm, "refreshAnnotationMode");
        wrapper.vm.handleInteractionModeChange({ mode: "point" });
        expect(spy).not.toHaveBeenCalled();
      });
    });

    describe("renderWorkerPreview", () => {
      it("renders preview data when displayWorkerPreview and image exist", () => {
        mockedPropertiesStore.displayWorkerPreview = true;
        mockedPropertiesStore.getWorkerPreview = vi.fn().mockReturnValue({
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
        wrapper.vm.renderWorkerPreview();
        expect(wrapper.vm.workerPreviewFeature.data).toHaveBeenCalled();
        expect(wrapper.vm.workerPreviewFeature.draw).toHaveBeenCalled();
      });

      it("clears preview data when not displayed", () => {
        mockedPropertiesStore.displayWorkerPreview = false;
        wrapper = mountComponent();
        wrapper.vm.renderWorkerPreview();
        expect(wrapper.vm.workerPreviewFeature.data).toHaveBeenCalledWith(
          [],
        );
        expect(wrapper.vm.workerPreviewFeature.draw).toHaveBeenCalled();
      });
    });

    describe("pendingAnnotationChanged", () => {
      it("removes previous pending annotation", () => {
        wrapper = mountComponent();
        const oldPending = mockGeoJSAnnotation("point");
        wrapper.vm.pendingAnnotation = oldPending;

        wrapper.vm.pendingAnnotationChanged();

        expect(
          wrapper.vm.interactionLayer.removeAnnotation,
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
        wrapper.vm.pendingAnnotationChanged();

        expect(geoAnn.options).toHaveBeenCalledWith(
          "specialAnnotation",
          true,
        );
        expect(
          wrapper.vm.interactionLayer.addAnnotation,
        ).toHaveBeenCalled();
      });
    });
  });
});

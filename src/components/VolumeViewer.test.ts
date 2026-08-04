import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { shallowMount, flushPromises, VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";

// Shared spies/stubs, accessible inside the hoisted vi.mock factories and the
// tests. (vtk.js needs WebGL, so the whole render library is mocked — the same
// approach ImageViewer.test.ts uses for GeoJS.)
const h = vi.hoisted(() => {
  const renderer = {
    addVolume: vi.fn(),
    removeVolume: vi.fn(),
    addActor: vi.fn(),
    removeActor: vi.fn(),
    resetCamera: vi.fn(),
    getActiveCamera: vi.fn(() => ({})),
  };
  const cubeAxes = {
    setCamera: vi.fn(),
    setDataBounds: vi.fn(),
    setGridLines: vi.fn(),
    setVisibility: vi.fn(),
    delete: vi.fn(),
  };
  const orientationWidget = {
    setViewportCorner: vi.fn(),
    setViewportSize: vi.fn(),
    setMinPixelSize: vi.fn(),
    setMaxPixelSize: vi.fn(),
    setEnabled: vi.fn(),
    delete: vi.fn(),
  };
  // Every property created by an actor mock is recorded so tests can assert
  // on e.g. opacity changes across all segmentation actors.
  const properties: any[] = [];
  const property = () => {
    const instance = {
      setRGBTransferFunction: vi.fn(),
      setScalarOpacity: vi.fn(),
      setInterpolationTypeToLinear: vi.fn(),
      setInterpolationToPhong: vi.fn(),
      setShade: vi.fn(),
      setOpacity: vi.fn(),
      setBackfaceCulling: vi.fn(),
      setAmbient: vi.fn(),
      setDiffuse: vi.fn(),
      setSpecular: vi.fn(),
      setSpecularPower: vi.fn(),
    };
    properties.push(instance);
    return instance;
  };
  const sphereMappers: any[] = [];
  return {
    buildVolume: vi.fn(),
    annotationsTo3D: vi.fn(),
    fetchValuesForIds: vi.fn(),
    renderer,
    orientationWidget,
    cubeAxes,
    property,
    properties,
    sphereMappers,
  };
});

// ---- vtk.js mocks ----
vi.mock("@kitware/vtk.js/Rendering/Profiles/Geometry", () => ({}));
vi.mock("@kitware/vtk.js/Rendering/Profiles/Volume", () => ({}));
vi.mock("@kitware/vtk.js/Rendering/Misc/GenericRenderWindow", () => ({
  default: {
    newInstance: vi.fn(() => ({
      setContainer: vi.fn(),
      getInteractor: vi.fn(() => ({})),
      getRenderer: vi.fn(() => h.renderer),
      getRenderWindow: vi.fn(() => ({ render: vi.fn() })),
      resize: vi.fn(),
      delete: vi.fn(),
    })),
  },
}));
vi.mock("@kitware/vtk.js/Rendering/Core/Volume", () => ({
  default: {
    newInstance: vi.fn(() => ({
      setMapper: vi.fn(),
      setVisibility: vi.fn(),
      getProperty: vi.fn(() => h.property()),
      delete: vi.fn(),
    })),
  },
}));
vi.mock("@kitware/vtk.js/Rendering/Core/VolumeMapper", () => ({
  default: {
    newInstance: vi.fn(() => ({
      setInputData: vi.fn(),
      setMaximumSamplesPerRay: vi.fn(),
      setBlendModeToMaximumIntensity: vi.fn(),
      setBlendModeToComposite: vi.fn(),
      delete: vi.fn(),
    })),
  },
}));
vi.mock("@kitware/vtk.js/Rendering/Profiles/Molecule", () => ({}));
vi.mock("@kitware/vtk.js/Rendering/Core/Actor", () => ({
  default: {
    newInstance: vi.fn(() => {
      // One stable property per actor, like the real vtkActor.
      const property = h.property();
      return {
        setMapper: vi.fn(),
        setVisibility: vi.fn(),
        getProperty: vi.fn(() => property),
        delete: vi.fn(),
      };
    }),
  },
}));
vi.mock("@kitware/vtk.js/Filters/Core/PolyDataNormals", () => ({
  default: {
    newInstance: vi.fn(() => ({
      setInputData: vi.fn(),
      getOutputData: vi.fn(() => ({})),
      delete: vi.fn(),
    })),
  },
}));
vi.mock("@kitware/vtk.js/Rendering/Core/SphereMapper", () => ({
  default: {
    newInstance: vi.fn(() => {
      const instance = {
        setInputData: vi.fn(),
        setRadius: vi.fn(),
        setScalarModeToUsePointData: vi.fn(),
        setColorModeToMapScalars: vi.fn(),
        setLookupTable: vi.fn(),
        setScalarRange: vi.fn(),
        delete: vi.fn(),
      };
      h.sphereMappers.push(instance);
      return instance;
    }),
  },
}));
vi.mock("@kitware/vtk.js/Rendering/Core/Mapper", () => ({
  default: {
    newInstance: vi.fn(() => ({
      setInputData: vi.fn(),
      setScalarModeToUseCellData: vi.fn(),
      setColorModeToMapScalars: vi.fn(),
      setLookupTable: vi.fn(),
      setScalarRange: vi.fn(),
      delete: vi.fn(),
    })),
  },
}));
vi.mock("@kitware/vtk.js/Rendering/Core/AxesActor", () => ({
  default: { newInstance: vi.fn(() => ({ delete: vi.fn() })) },
}));
vi.mock("@kitware/vtk.js/Rendering/Core/CubeAxesActor", () => ({
  default: { newInstance: vi.fn(() => h.cubeAxes) },
}));
vi.mock("@kitware/vtk.js/Interaction/Widgets/OrientationMarkerWidget", () => ({
  default: {
    newInstance: vi.fn(() => h.orientationWidget),
    Corners: { BOTTOM_LEFT: 0, BOTTOM_RIGHT: 1, TOP_LEFT: 2, TOP_RIGHT: 3 },
  },
}));

// ---- store + util mocks ----
vi.mock("@/store", () => {
  const { reactive } = require("vue");
  return {
    default: reactive({
      dataset: {
        id: "ds-1",
        time: [0, 1, 2],
        z: [0, 1, 2],
        anyImage: () => ({}),
      },
      layers: [{ id: "dapi", color: "#0000ff" }],
      layerStackImages: [
        { layer: { id: "dapi", channel: 0, visible: true }, hist: null },
      ],
      xy: 0,
      z: 0,
      time: 0,
      scales: { zStep: { value: 5, unit: "µm" } },
      girderRestProxy: {},
      api: { getLayerHistogram: vi.fn().mockResolvedValue(null) },
    }),
  };
});
vi.mock("@/store/filters", () => {
  const { reactive } = require("vue");
  return { default: reactive({ filteredAnnotations: [] }) };
});
vi.mock("@/store/properties", () => {
  const { reactive } = require("vue");
  return {
    default: reactive({
      computedPropertyPaths: [],
      getFullNameFromPath: () => "",
      propertyValues: {},
      fetchValuesForIds: h.fetchValuesForIds,
    }),
  };
});
// VolumeViewer only reads stubOnlyMode from the annotation store (to decide
// whether property values must be fetched for the rendered set).
vi.mock("@/store/annotation", () => {
  const { reactive } = require("vue");
  return { default: reactive({ stubOnlyMode: false }) };
});
vi.mock("@/store/volumeView", () => {
  const { reactive } = require("vue");
  const state = reactive({
    viewMode: "3d",
    axis: "z",
    blendMode: "composite",
    showVolume: true,
    showSegmentations: true,
    showAxes: true,
    showBoundingBox: false,
    segmentationColorMode: "tag",
    segmentationPropertyPath: [] as string[],
    segmentationOpacity: 0.55,
    loftSurfaces: true,
    loftOverlapPercent: 0,
    timeStepUmOverride: null as number | null,
    setViewMode: (v: string) => (state.viewMode = v),
    setAxis: (v: string) => (state.axis = v),
    setBlendMode: (v: string) => (state.blendMode = v),
    setShowVolume: (v: boolean) => (state.showVolume = v),
    setShowSegmentations: (v: boolean) => (state.showSegmentations = v),
    setShowAxes: (v: boolean) => (state.showAxes = v),
    setShowBoundingBox: (v: boolean) => (state.showBoundingBox = v),
    setSegmentationColorMode: (v: string) => (state.segmentationColorMode = v),
    setSegmentationPropertyPath: (v: string[]) =>
      (state.segmentationPropertyPath = v),
    setSegmentationOpacity: (v: number) => (state.segmentationOpacity = v),
    setLoftSurfaces: (v: boolean) => (state.loftSurfaces = v),
    setLoftOverlapPercent: (v: number) => (state.loftOverlapPercent = v),
    setTimeStepUmOverride: (v: number | null) => (state.timeStepUmOverride = v),
  });
  return { default: state };
});
vi.mock("@/store/VolumeAPI", () => ({
  TileFrameVolumeSource: vi.fn(() => ({ buildVolume: h.buildVolume })),
  defaultTimeStepUm: vi.fn(() => 5),
}));
vi.mock("@/utils/annotationsTo3D", () => ({
  annotationsTo3D: h.annotationsTo3D,
}));
vi.mock("@/utils/layerToVolumeTransferFunction", () => ({
  layerToVolumeTransferFunction: () => ({
    colorTransferFunction: {},
    opacityTransferFunction: {},
  }),
}));
vi.mock("@/utils/log", () => ({ logError: vi.fn(), logWarning: vi.fn() }));

import volumeViewStore from "@/store/volumeView";
import propertyStore from "@/store/properties";
import filterStore from "@/store/filters";
import annotationStore from "@/store/annotation";
import VolumeViewer from "./VolumeViewer.vue";

const fakeVolume = {
  layer: { id: "dapi" },
  imageData: {},
  geometry: {
    unit: "um",
    dimensions: [4, 4, 3],
    spacing: [1, 1, 1],
    origin: [0, 0, 0],
    sourceSize: [4, 4],
    depthStride: 1,
  },
};

function segResult() {
  return {
    surfacePolyData: { getNumberOfCells: () => 1 },
    pointsPolyData: { getNumberOfPoints: () => 1 },
    pointRadius: 2,
    lookupTable: {},
    scalarRange: [0, 1],
    usedCount: 2,
    skippedByShape: {},
  };
}

// Mounted wrappers share the module-level reactive stores, so they must be
// unmounted between tests — otherwise a store change drives every still-mounted
// component's watchers and inflates the spy call counts.
const mountedWrappers: VueWrapper[] = [];

async function mountReady() {
  const wrapper = shallowMount(VolumeViewer);
  mountedWrappers.push(wrapper);
  await flushPromises(); // let onMounted (async nextTick) + initial build run
  return wrapper;
}

afterEach(() => {
  mountedWrappers.forEach((wrapper) => wrapper.unmount());
  mountedWrappers.length = 0;
});

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  // Reset store-driven state between tests.
  volumeViewStore.setAxis("z");
  volumeViewStore.setShowAxes(true);
  volumeViewStore.setShowBoundingBox(false);
  volumeViewStore.setShowSegmentations(true);
  volumeViewStore.setSegmentationColorMode("tag");
  volumeViewStore.setSegmentationOpacity(0.55);
  volumeViewStore.setLoftSurfaces(true);
  volumeViewStore.setLoftOverlapPercent(0);
  h.properties.length = 0;
  h.sphereMappers.length = 0;
  h.cubeAxes.setVisibility.mockClear();
  h.buildVolume.mockReset().mockResolvedValue([fakeVolume]);
  h.annotationsTo3D.mockReset().mockImplementation(segResult);
  h.fetchValuesForIds.mockReset().mockResolvedValue({});
  h.renderer.resetCamera.mockClear();
  h.orientationWidget.setEnabled.mockClear();
  (annotationStore as any).stubOnlyMode = false;
  (filterStore as any).filteredAnnotations = [];
  (volumeViewStore as any).segmentationPropertyPath = [];
});

describe("VolumeViewer", () => {
  it("builds the volume once on mount", async () => {
    await mountReady();
    expect(h.buildVolume).toHaveBeenCalledTimes(1);
    expect(h.buildVolume.mock.calls[0][0]).toMatchObject({ axis: "z" });
  });

  it("enables the orientation gizmo according to showAxes on mount", async () => {
    await mountReady();
    expect(h.orientationWidget.setEnabled).toHaveBeenCalledWith(true);
  });

  it("rebuilds with the time axis and reframes the camera when the depth axis changes", async () => {
    await mountReady();
    h.buildVolume.mockClear();
    h.renderer.resetCamera.mockClear();

    volumeViewStore.setAxis("t");
    await nextTick();
    await flushPromises();

    expect(h.buildVolume).toHaveBeenCalledTimes(1);
    expect(h.buildVolume.mock.calls[0][0]).toMatchObject({ axis: "t" });
    // Geometry signature (dataset|axis) changed → camera reframed.
    expect(h.renderer.resetCamera).toHaveBeenCalled();
  });

  it("toggles the orientation gizmo when showAxes changes", async () => {
    await mountReady();
    h.orientationWidget.setEnabled.mockClear();

    volumeViewStore.setShowAxes(false);
    await nextTick();

    expect(h.orientationWidget.setEnabled).toHaveBeenCalledWith(false);
  });

  it("shows the scaled bounding box with the volume bounds when toggled", async () => {
    await mountReady();
    h.cubeAxes.setVisibility.mockClear();
    h.cubeAxes.setDataBounds.mockClear();

    volumeViewStore.setShowBoundingBox(true);
    await nextTick();

    expect(h.cubeAxes.setVisibility).toHaveBeenLastCalledWith(true);
    expect(h.cubeAxes.setDataBounds).toHaveBeenCalled();
  });

  it("rebuilds segmentations on color-mode change without rebuilding the volume", async () => {
    await mountReady();
    expect(h.annotationsTo3D).toHaveBeenCalled(); // built on mount
    h.annotationsTo3D.mockClear();
    h.buildVolume.mockClear();

    volumeViewStore.setSegmentationColorMode("property");
    await nextTick();
    await flushPromises();

    expect(h.annotationsTo3D).toHaveBeenCalledTimes(1);
    expect(h.annotationsTo3D.mock.calls[0][0]).toMatchObject({
      colorMode: "property",
    });
    expect(h.buildVolume).not.toHaveBeenCalled(); // no volume refetch
  });

  it("writes the selected property path through to the store", async () => {
    (propertyStore as any).computedPropertyPaths = [["alpha", "beta"]];
    const wrapper = await mountReady();
    // Use the component's own key encoding rather than hardcoding it.
    const key = (wrapper.vm as any).propertyItems[0].value;
    (wrapper.vm as any).selectedPropertyKey = key;
    expect(volumeViewStore.segmentationPropertyPath).toEqual(["alpha", "beta"]);
  });

  it("blendMode is backed by the store", async () => {
    const wrapper = await mountReady();
    expect((wrapper.vm as any).blendMode).toBe("composite");
    (wrapper.vm as any).blendMode = "mip";
    expect(volumeViewStore.blendMode).toBe("mip");
  });

  it("passes loft settings through and rebuilds segmentations on change", async () => {
    await mountReady();
    expect(h.annotationsTo3D.mock.calls[0][0]).toMatchObject({
      loftSurfaces: true,
      loftOverlapFraction: 0,
    });
    h.annotationsTo3D.mockClear();
    h.buildVolume.mockClear();

    volumeViewStore.setLoftOverlapPercent(50);
    await nextTick();

    expect(h.annotationsTo3D).toHaveBeenCalledTimes(1);
    expect(h.annotationsTo3D.mock.calls[0][0]).toMatchObject({
      loftOverlapFraction: 0.5,
    });
    expect(h.buildVolume).not.toHaveBeenCalled();
  });

  it("discards a segmentation build that finishes after segmentations were hidden", async () => {
    await mountReady();
    // Make the next build hang until we resolve it, like a slow worker job.
    let resolveBuild!: (value: ReturnType<typeof segResult>) => void;
    h.annotationsTo3D.mockImplementationOnce(
      () => new Promise((resolve) => (resolveBuild = resolve)),
    );
    (filterStore as any).filteredAnnotations = [{ id: "new" }];
    await nextTick();

    volumeViewStore.setShowSegmentations(false);
    await nextTick();
    h.renderer.addActor.mockClear();

    resolveBuild(segResult());
    await flushPromises();

    expect(h.renderer.addActor).not.toHaveBeenCalled();
  });

  it("renders point annotations with a sphere mapper at the suggested radius", async () => {
    await mountReady();
    expect(h.sphereMappers).toHaveLength(1);
    expect(h.sphereMappers[0].setRadius).toHaveBeenCalledWith(2);
  });

  it("applies opacity changes to actors without rebuilding anything", async () => {
    await mountReady();
    h.annotationsTo3D.mockClear();
    h.buildVolume.mockClear();

    volumeViewStore.setSegmentationOpacity(0.8);
    await nextTick();

    const opacityCalls = h.properties.flatMap((property) =>
      property.setOpacity.mock.calls.map((call: number[]) => call[0]),
    );
    expect(opacityCalls).toContain(0.8);
    expect(h.annotationsTo3D).not.toHaveBeenCalled();
    expect(h.buildVolume).not.toHaveBeenCalled();
  });
  // Phase 2 (PROPERTY_VALUE_SCALING.md): in lazy mode propertyStore.propertyValues
  // holds only the visible annotations and only the *displayed* columns, so
  // property coloring must read values for the set actually being rendered.
  // annotationsTo3D falls back to a flat neutral color if even one rendered
  // annotation lacks a value, so a silent partial read is a visible bug.
  describe("property coloring in lazy (stub-only) mode", () => {
    const hydrated = [
      {
        id: "a1",
        shape: "polygon",
        coordinates: [{ x: 0, y: 0, z: 0 }],
        location: { XY: 0, Z: 0, Time: 0 },
        tags: [],
        channel: 0,
        datasetId: "d1",
        name: null,
      },
      {
        id: "a2",
        shape: "polygon",
        coordinates: [{ x: 1, y: 1, z: 0 }],
        location: { XY: 0, Z: 0, Time: 0 },
        tags: [],
        channel: 0,
        datasetId: "d1",
        name: null,
      },
    ];

    it("fetches values for the rendered set and passes them to annotationsTo3D", async () => {
      (annotationStore as any).stubOnlyMode = true;
      (filterStore as any).filteredAnnotations = hydrated;
      (volumeViewStore as any).segmentationPropertyPath = ["propA"];
      const fetched = { a1: { propA: 1 }, a2: { propA: 2 } };
      h.fetchValuesForIds.mockResolvedValue(fetched);

      await mountReady();
      volumeViewStore.setSegmentationColorMode("property");
      await nextTick();
      await flushPromises();

      expect(h.fetchValuesForIds).toHaveBeenCalledWith({
        ids: ["a1", "a2"],
        paths: [["propA"]],
      });
      expect(h.annotationsTo3D.mock.calls.at(-1)![0]).toMatchObject({
        propertyValues: fetched,
      });
    });

    it("does not fetch when coloring by tag", async () => {
      (annotationStore as any).stubOnlyMode = true;
      (filterStore as any).filteredAnnotations = hydrated;
      (volumeViewStore as any).segmentationPropertyPath = ["propA"];

      await mountReady();
      await flushPromises();

      expect(h.fetchValuesForIds).not.toHaveBeenCalled();
    });

    it("does not fetch in wholesale mode (the resident map is complete)", async () => {
      (annotationStore as any).stubOnlyMode = false;
      (filterStore as any).filteredAnnotations = hydrated;
      (volumeViewStore as any).segmentationPropertyPath = ["propA"];

      await mountReady();
      volumeViewStore.setSegmentationColorMode("property");
      await nextTick();
      await flushPromises();

      expect(h.fetchValuesForIds).not.toHaveBeenCalled();
    });

    it("still renders geometry when the value fetch fails", async () => {
      (annotationStore as any).stubOnlyMode = true;
      (filterStore as any).filteredAnnotations = hydrated;
      (volumeViewStore as any).segmentationPropertyPath = ["propA"];
      h.fetchValuesForIds.mockRejectedValue(new Error("network"));

      await mountReady();
      h.annotationsTo3D.mockClear();
      volumeViewStore.setSegmentationColorMode("property");
      await nextTick();
      await flushPromises();

      // Falls back to the resident cache rather than aborting the rebuild.
      expect(h.annotationsTo3D).toHaveBeenCalled();
    });
  });
});

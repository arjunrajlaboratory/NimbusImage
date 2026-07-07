import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/store", () => ({
  default: {
    isLoggedIn: true,
    dataset: {
      id: "ds1",
      name: "Dataset",
      xy: [0],
      z: [0, 1, 2],
      time: [0, 1],
      channels: [0, 1],
      channelNames: new Map([
        [0, "DAPI"],
        [1, "Cy3"],
      ]),
      width: 1024,
      height: 1024,
    },
    configuration: {
      id: "conf1",
      name: "Collection",
      layers: [],
    },
    datasetView: { layerContrasts: {} },
    xy: 0,
    z: 0,
    time: 0,
    layerMode: "multiple",
    unrollXY: false,
    unrollZ: false,
    unrollT: false,
    cameraInfo: {
      center: { x: 0, y: 0 },
      zoom: 1,
      rotate: 0,
      gcsBounds: [],
    },
    layers: [],
    tools: [],
    selectedTool: null,
    maps: [],
    getLayerFromId: vi.fn(),
    getConfigurationLayerFromId: vi.fn(),
    setXY: vi.fn(),
    setZ: vi.fn(),
    setTime: vi.fn(),
    setCameraInfo: vi.fn(),
    setLayerMode: vi.fn(),
    setUnrollXY: vi.fn(),
    setUnrollZ: vi.fn(),
    setUnrollT: vi.fn(),
    changeLayer: vi.fn(),
    syncConfiguration: vi.fn(),
    saveContrastInView: vi.fn(),
    setViewContrastOverrides: vi.fn(),
    setSelectedToolId: vi.fn(),
  },
}));

vi.mock("@/store/annotation", () => ({
  default: {
    annotations: [],
    selectedAnnotationIds: new Set<string>(),
    annotationTags: new Set<string>(),
    setSelected: vi.fn(),
    selectAnnotations: vi.fn(),
    unselectAnnotations: vi.fn(),
    colorAnnotationIds: vi.fn(),
    addTagsByAnnotationIds: vi.fn(),
    removeTagsByAnnotationIds: vi.fn(),
    replaceTagsByAnnotationIds: vi.fn(),
    undoOrRedo: vi.fn(),
    computeAnnotationsWithWorker: vi.fn(),
  },
}));

vi.mock("@/store/filters", () => ({
  default: {
    tagFilter: { id: "tagFilter", exclusive: false, enabled: false, tags: [] },
    onlyCurrentFrame: false,
    filteredAnnotations: [],
    setTagFilter: vi.fn(),
    setOnlyCurrentFrame: vi.fn(),
  },
}));

vi.mock("@/store/properties", () => ({
  default: {
    workerImageList: {},
    getWorkerInterface: vi.fn(() => null),
    fetchWorkerInterface: vi.fn(),
    fetchWorkerImageList: vi.fn(),
  },
}));

vi.mock("@/store/jobs", () => ({
  default: {
    jobIdForToolId: {} as { [toolId: string]: string },
  },
}));

vi.mock("@/utils/interfaceCapture", () => ({
  captureInterfaceScreenshot: vi.fn(async () => null),
  captureViewportScreenshot: vi.fn(async () => null),
  dataUrlToBase64: vi.fn(() => null),
}));

import main from "@/store";
import annotationStore from "@/store/annotation";
import jobsStore from "@/store/jobs";
import {
  describeAgentToolCall,
  executeAgentTool,
  isGatedTool,
  restoreViewState,
  snapshotViewState,
  ToolExecutionError,
} from "./executors";

const mockMain = main as any;
const mockAnnotations = annotationStore as any;
const mockJobs = jobsStore as any;

const context = { panelElement: null, notify: vi.fn() };

function makeAnnotation(overrides: any = {}) {
  return {
    id: "a1",
    name: null,
    shape: "polygon",
    tags: [],
    channel: 0,
    location: { XY: 0, Z: 0, Time: 0 },
    coordinates: [{ x: 0, y: 0 }],
    color: null,
    datasetId: "ds1",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockMain.isLoggedIn = true;
  mockMain.tools = [];
  mockMain.layers = [];
  mockAnnotations.annotations = [];
  mockAnnotations.selectedAnnotationIds = new Set();
  mockJobs.jobIdForToolId = {};
});

describe("describeAgentToolCall", () => {
  // Tool inputs come from the model and are not schema-enforced; the
  // describe helper must never throw, whatever shape arrives.
  const malformedInputs = [
    undefined,
    null,
    "a string",
    42,
    { tags: "not-an-array" },
    { tags: { nested: true } },
    { visibleLayers: "DAPI" },
    { target: 7, tags: 0 },
    { target: { tags: "spot", ids: "abc" } },
    { query: { tags: 3 } },
  ];
  const toolNames = [
    "get_interface_state",
    "capture_screenshot",
    "list_annotations",
    "set_location",
    "set_camera",
    "set_layer_mode",
    "update_layer",
    "set_layer_visibility",
    "select_annotations",
    "color_annotations",
    "tag_annotations",
    "set_annotation_filter",
    "select_tool",
    "run_worker",
    "unknown_tool",
  ];

  it("never throws on malformed input", () => {
    for (const name of toolNames) {
      for (const input of malformedInputs) {
        expect(() => describeAgentToolCall(name, input)).not.toThrow();
        expect(typeof describeAgentToolCall(name, input)).toBe("string");
      }
    }
  });

  it("names the tool being activated", () => {
    mockMain.tools = [{ id: "t1", name: "My Blob Tool", values: {} }];
    expect(describeAgentToolCall("select_tool", { toolId: "t1" })).toContain(
      "My Blob Tool",
    );
  });
});

describe("isGatedTool", () => {
  it("gates run_worker but not view tools", () => {
    expect(isGatedTool("run_worker")).toBe(true);
    expect(isGatedTool("set_location")).toBe(false);
    expect(isGatedTool("get_interface_state")).toBe(false);
  });
});

describe("executeAgentTool", () => {
  it("throws ToolExecutionError for unknown tools", async () => {
    await expect(
      executeAgentTool("not_a_tool", {}, context),
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it("filters annotations by tags, shape, frame and ids", async () => {
    mockAnnotations.annotations = [
      makeAnnotation({ id: "a1", tags: ["nucleus"], shape: "polygon" }),
      makeAnnotation({ id: "a2", tags: ["spot"], shape: "point" }),
      makeAnnotation({
        id: "a3",
        tags: ["nucleus", "spot"],
        shape: "polygon",
        location: { XY: 0, Z: 1, Time: 0 },
      }),
    ];
    const byTag = await executeAgentTool(
      "list_annotations",
      { query: { tags: ["nucleus"] } },
      context,
    );
    expect(byTag.result.annotations.map((a: any) => a.id)).toEqual([
      "a1",
      "a3",
    ]);

    const exclusive = await executeAgentTool(
      "list_annotations",
      { query: { tags: ["nucleus", "spot"], exclusive: true } },
      context,
    );
    expect(exclusive.result.annotations.map((a: any) => a.id)).toEqual(["a3"]);

    const currentFrame = await executeAgentTool(
      "list_annotations",
      { query: { currentFrameOnly: true } },
      context,
    );
    expect(currentFrame.result.annotations.map((a: any) => a.id)).toEqual([
      "a1",
      "a2",
    ]);

    const paged = await executeAgentTool(
      "list_annotations",
      { limit: 1, offset: 1 },
      context,
    );
    expect(paged.result.totalMatching).toBe(3);
    expect(paged.result.annotations.map((a: any) => a.id)).toEqual(["a2"]);
  });

  it("routes contrast to the personal view, other fields to the config", async () => {
    const layer = {
      id: "l1",
      name: "DAPI",
      color: "#0000ff",
      visible: true,
      contrast: { mode: "percentile", blackPoint: 0, whitePoint: 100 },
    };
    mockMain.layers = [layer];
    mockMain.getLayerFromId = vi.fn(() => layer);
    const contrast = { mode: "percentile", blackPoint: 5, whitePoint: 95 };
    await executeAgentTool(
      "update_layer",
      { layer: "DAPI", color: "#ff0000", contrast },
      context,
    );
    expect(mockMain.changeLayer).toHaveBeenCalledWith({
      layerId: "l1",
      delta: { color: "#ff0000" },
    });
    expect(mockMain.saveContrastInView).toHaveBeenCalledWith({
      layerId: "l1",
      contrast,
    });
  });

  it("fails loudly on mutating tools when logged out", async () => {
    mockMain.isLoggedIn = false;
    await expect(
      executeAgentTool(
        "color_annotations",
        { target: "selection", color: "#ff0000" },
        context,
      ),
    ).rejects.toBeInstanceOf(ToolExecutionError);
    expect(mockAnnotations.colorAnnotationIds).not.toHaveBeenCalled();
  });

  it("does not double-submit a worker whose job is already running", async () => {
    mockMain.tools = [
      { id: "t1", name: "Cellpose", values: { image: { image: "img:1" } } },
    ];
    mockJobs.jobIdForToolId = { t1: "job42" };
    const { result } = await executeAgentTool(
      "run_worker",
      { toolId: "t1" },
      context,
    );
    expect(result.alreadyRunning).toBe(true);
    expect(result.jobId).toBe("job42");
    expect(mockAnnotations.computeAnnotationsWithWorker).not.toHaveBeenCalled();
  });
});

describe("snapshotViewState / restoreViewState", () => {
  it("snapshots configuration layers, not the view-merged contrast", () => {
    const configContrast = {
      mode: "percentile",
      blackPoint: 0,
      whitePoint: 100,
    };
    const viewContrast = { mode: "percentile", blackPoint: 10, whitePoint: 90 };
    mockMain.configuration.layers = [
      {
        id: "l1",
        name: "DAPI",
        color: "#0000ff",
        visible: true,
        contrast: configContrast,
      },
    ];
    // The merged view would show the override; the snapshot must not.
    mockMain.layers = [
      { ...mockMain.configuration.layers[0], contrast: viewContrast },
    ];
    mockMain.datasetView = { layerContrasts: { l1: viewContrast } };

    const snapshot = snapshotViewState();
    expect(snapshot.layers[0].contrast).toEqual(configContrast);
    expect(snapshot.viewContrasts).toEqual({ l1: viewContrast });
  });

  it("restores view overrides through the view channel, in one call", async () => {
    const snapshot = snapshotViewState();
    snapshot.viewContrasts = {
      l1: { mode: "percentile", blackPoint: 1, whitePoint: 99 } as any,
    };
    await restoreViewState(snapshot);
    expect(mockMain.setViewContrastOverrides).toHaveBeenCalledTimes(1);
    expect(mockMain.setViewContrastOverrides).toHaveBeenCalledWith(
      snapshot.viewContrasts,
    );
  });

  it("only syncs the configuration when a config layer actually changed", async () => {
    mockMain.configuration.layers = [
      {
        id: "l1",
        name: "DAPI",
        color: "#0000ff",
        visible: true,
        contrast: { mode: "percentile", blackPoint: 0, whitePoint: 100 },
      },
    ];
    mockMain.getConfigurationLayerFromId = vi.fn(
      () => mockMain.configuration.layers[0],
    );
    const snapshot = snapshotViewState();

    // Unchanged: no writes at all
    await restoreViewState(snapshot);
    expect(mockMain.changeLayer).not.toHaveBeenCalled();
    expect(mockMain.syncConfiguration).not.toHaveBeenCalled();

    // Now the live config differs from the snapshot: one batched sync
    mockMain.configuration.layers[0].color = "#00ff00";
    await restoreViewState(snapshot);
    expect(mockMain.changeLayer).toHaveBeenCalledWith(
      expect.objectContaining({ layerId: "l1", sync: false }),
    );
    expect(mockMain.syncConfiguration).toHaveBeenCalledTimes(1);
  });
});

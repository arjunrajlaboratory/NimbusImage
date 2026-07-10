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
    addToolToConfiguration: vi.fn(),
  },
}));

vi.mock("@/tools/creation/toolFromCatalog", () => ({
  MANUAL_CATALOG: [
    {
      id: "manual:blob",
      name: "Blob",
      kind: "manual",
      defaultShape: "polygon",
    },
    {
      id: "manual:point",
      name: "Point",
      kind: "manual",
      defaultShape: "point",
    },
    { id: "manual:line", name: "Line", kind: "manual", defaultShape: "line" },
  ],
  buildCatalog: vi.fn(() => [
    {
      id: "manual:blob",
      name: "Blob",
      kind: "manual",
      defaultShape: "polygon",
    },
    {
      id: "worker:img:1",
      name: "Cellpose",
      kind: "worker",
      image: "img:1",
      defaultShape: "polygon",
    },
  ]),
  buildToolConfiguration: vi.fn((entry: any, opts: any) => ({
    id: "tool-new",
    name: opts?.name ?? entry.name,
    type: entry.kind === "worker" ? "segmentation" : "create",
  })),
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
    properties: [] as any[],
    propertyValues: {} as any,
    computedPropertyPaths: [] as string[][],
    propertyStatuses: {} as any,
    fetchPropertyValues: vi.fn(),
    createProperty: vi.fn(),
    computeProperty: vi.fn(),
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
import propertyStore from "@/store/properties";
import {
  describeAgentToolCall,
  executeAgentTool,
  isGatedTool,
  restoreViewState,
  snapshotViewState,
  ToolExecutionError,
  viewIdentityChangedSince,
} from "./executors";

const mockMain = main as any;
const mockAnnotations = annotationStore as any;
const mockJobs = jobsStore as any;
const mockProperties = propertyStore as any;

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
  mockProperties.workerImageList = {};
  mockProperties.properties = [];
  mockProperties.propertyValues = {};
  mockProperties.computedPropertyPaths = [];
  mockProperties.propertyStatuses = {};
  mockProperties.getWorkerInterface = vi.fn(() => ({}));
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
    "create_tool",
    "list_properties",
    "create_property",
    "compute_property",
    "get_property_values",
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

  it("reports paging state so the model can page deliberately", async () => {
    mockAnnotations.annotations = [
      makeAnnotation({ id: "a1" }),
      makeAnnotation({ id: "a2" }),
      makeAnnotation({ id: "a3" }),
    ];

    // A page that does not reach the end signals more pages and where to
    // resume.
    const firstPage = await executeAgentTool(
      "list_annotations",
      { limit: 2, offset: 0 },
      context,
    );
    expect(firstPage.result.returned).toBe(2);
    expect(firstPage.result.hasMore).toBe(true);
    expect(firstPage.result.nextOffset).toBe(2);

    // A page that reaches the end has no more pages and omits nextOffset.
    const lastPage = await executeAgentTool(
      "list_annotations",
      { limit: 2, offset: 2 },
      context,
    );
    expect(lastPage.result.returned).toBe(1);
    expect(lastPage.result.hasMore).toBe(false);
    expect(lastPage.result.nextOffset).toBeUndefined();
  });

  it("hints toward get_annotation_summary for large result sets", async () => {
    // Small result sets carry no hint: enumerating them is fine.
    mockAnnotations.annotations = [makeAnnotation({ id: "a1" })];
    const small = await executeAgentTool("list_annotations", {}, context);
    expect(small.result.hint).toBeUndefined();

    // Large result sets nudge the model to summarize instead of paging
    // through everything and echoing it back.
    mockAnnotations.annotations = Array.from({ length: 250 }, (_unused, i) =>
      makeAnnotation({ id: `a${i}` }),
    );
    const large = await executeAgentTool("list_annotations", {}, context);
    expect(large.result.totalMatching).toBe(250);
    expect(typeof large.result.hint).toBe("string");
    expect(large.result.hint).toContain("get_annotation_summary");
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

  it("rejects malformed edit targets instead of hitting all annotations", async () => {
    mockAnnotations.annotations = [
      makeAnnotation({ id: "a1" }),
      makeAnnotation({ id: "a2" }),
    ];
    // Missing target (schema requires it, but model input is not enforced).
    await expect(
      executeAgentTool("color_annotations", { color: "#ffffff" }, context),
    ).rejects.toBeInstanceOf(ToolExecutionError);
    // A garbage string that is not "selection".
    await expect(
      executeAgentTool(
        "tag_annotations",
        { target: "everything", tags: ["x"], mode: "add" },
        context,
      ),
    ).rejects.toBeInstanceOf(ToolExecutionError);
    // An object with only an unrecognized field would otherwise match all.
    await expect(
      executeAgentTool(
        "color_annotations",
        { target: { foo: 1 }, color: "#ffffff" },
        context,
      ),
    ).rejects.toBeInstanceOf(ToolExecutionError);
    // A recognized field of the wrong type.
    await expect(
      executeAgentTool(
        "color_annotations",
        { target: { tags: "nucleus" }, color: "#ffffff" },
        context,
      ),
    ).rejects.toBeInstanceOf(ToolExecutionError);
    expect(mockAnnotations.colorAnnotationIds).not.toHaveBeenCalled();
    expect(mockAnnotations.addTagsByAnnotationIds).not.toHaveBeenCalled();
  });

  it("still resolves valid edit targets: selection, query, explicit all", async () => {
    mockAnnotations.annotations = [
      makeAnnotation({ id: "a1", tags: ["nucleus"] }),
      makeAnnotation({ id: "a2", tags: [] }),
    ];
    mockAnnotations.selectedAnnotationIds = new Set(["a2"]);

    await executeAgentTool(
      "color_annotations",
      { target: "selection", color: "#ffffff" },
      context,
    );
    expect(mockAnnotations.colorAnnotationIds).toHaveBeenLastCalledWith(
      expect.objectContaining({ annotationIds: ["a2"] }),
    );

    await executeAgentTool(
      "color_annotations",
      { target: { tags: ["nucleus"] }, color: "#ffffff" },
      context,
    );
    expect(mockAnnotations.colorAnnotationIds).toHaveBeenLastCalledWith(
      expect.objectContaining({ annotationIds: ["a1"] }),
    );

    // An explicit empty query is a legitimate "all annotations" request.
    await executeAgentTool(
      "color_annotations",
      { target: {}, color: "#ffffff" },
      context,
    );
    expect(mockAnnotations.colorAnnotationIds).toHaveBeenLastCalledWith(
      expect.objectContaining({ annotationIds: ["a1", "a2"] }),
    );
  });

  it("validates select_annotations queries but allows omitting for all", async () => {
    mockAnnotations.annotations = [
      makeAnnotation({ id: "a1" }),
      makeAnnotation({ id: "a2" }),
    ];
    // Garbage query is rejected rather than silently selecting everything.
    await expect(
      executeAgentTool(
        "select_annotations",
        { mode: "replace", query: "everything" },
        context,
      ),
    ).rejects.toBeInstanceOf(ToolExecutionError);
    expect(mockAnnotations.setSelected).not.toHaveBeenCalled();

    // Omitting the query is a legitimate "select all".
    await executeAgentTool("select_annotations", { mode: "replace" }, context);
    expect(mockAnnotations.setSelected).toHaveBeenCalledWith(["a1", "a2"]);
  });

  it("creates a manual tool bound to a channel", async () => {
    const { result } = await executeAgentTool(
      "create_tool",
      { manualShape: "polygon", channelName: "DAPI", name: "DAPI Blob" },
      context,
    );
    expect(mockMain.addToolToConfiguration).toHaveBeenCalledTimes(1);
    expect(result.type).toBe("create");
    expect(result.toolId).toBe("tool-new");
    expect(result.channelName).toBe("DAPI");
  });

  it("creates a worker tool by image", async () => {
    const { result } = await executeAgentTool(
      "create_tool",
      { workerImage: "img:1", channelName: "DAPI" },
      context,
    );
    expect(mockMain.addToolToConfiguration).toHaveBeenCalledTimes(1);
    expect(result.type).toBe("segmentation");
  });

  it("rejects providing both or neither of manualShape/workerImage", async () => {
    await expect(
      executeAgentTool(
        "create_tool",
        { manualShape: "point", workerImage: "img:1" },
        context,
      ),
    ).rejects.toBeInstanceOf(ToolExecutionError);
    await expect(
      executeAgentTool("create_tool", {}, context),
    ).rejects.toBeInstanceOf(ToolExecutionError);
    expect(mockMain.addToolToConfiguration).not.toHaveBeenCalled();
  });

  it("rejects an unknown worker image", async () => {
    await expect(
      executeAgentTool(
        "create_tool",
        { workerImage: "does-not-exist" },
        context,
      ),
    ).rejects.toBeInstanceOf(ToolExecutionError);
    expect(mockMain.addToolToConfiguration).not.toHaveBeenCalled();
  });

  it("rejects an unsupported manual shape", async () => {
    await expect(
      executeAgentTool("create_tool", { manualShape: "rectangle" }, context),
    ).rejects.toBeInstanceOf(ToolExecutionError);
    expect(mockMain.addToolToConfiguration).not.toHaveBeenCalled();
  });

  it("requires being logged in to create a tool", async () => {
    mockMain.isLoggedIn = false;
    await expect(
      executeAgentTool("create_tool", { manualShape: "point" }, context),
    ).rejects.toBeInstanceOf(ToolExecutionError);
    expect(mockMain.addToolToConfiguration).not.toHaveBeenCalled();
  });

  it("gates create_tool", () => {
    expect(isGatedTool("create_tool")).toBe(true);
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

describe("property tools", () => {
  it("gates create_property and compute_property, not the read tools", () => {
    expect(isGatedTool("create_property")).toBe(true);
    expect(isGatedTool("compute_property")).toBe(true);
    expect(isGatedTool("list_properties")).toBe(false);
    expect(isGatedTool("get_property_values")).toBe(false);
  });

  it("list_properties returns existing definitions with computed status", async () => {
    mockProperties.properties = [
      {
        id: "prop1",
        name: "DAPI Intensity",
        image: "prop:1",
        shape: "polygon",
        tags: { tags: ["nucleus"], exclusive: false },
      },
    ];
    mockProperties.computedPropertyPaths = [["prop1", "mean"]];
    const { result } = await executeAgentTool("list_properties", {}, context);
    expect(result.properties).toHaveLength(1);
    expect(result.properties[0]).toMatchObject({
      id: "prop1",
      name: "DAPI Intensity",
      image: "prop:1",
      shape: "polygon",
      computed: true,
    });
  });

  it("create_property builds a config and calls createProperty", async () => {
    mockProperties.workerImageList = {
      "prop:1": { isPropertyWorker: "x", interfaceName: "Intensity" },
    };
    mockProperties.getWorkerInterface = vi.fn(() => ({}));
    mockProperties.createProperty = vi.fn(async (config: any) => ({
      id: "prop-new",
      ...config,
    }));

    const { result } = await executeAgentTool(
      "create_property",
      {
        propertyWorkerImage: "prop:1",
        shape: "polygon",
        tags: ["nucleus"],
        name: "DAPI Intensity",
      },
      context,
    );
    expect(mockProperties.createProperty).toHaveBeenCalledTimes(1);
    const config = mockProperties.createProperty.mock.calls[0][0];
    expect(config).toMatchObject({
      name: "DAPI Intensity",
      image: "prop:1",
      shape: "polygon",
      tags: { tags: ["nucleus"], exclusive: false },
    });
    expect(result.propertyId).toBe("prop-new");
  });

  it("create_property rejects a non-property worker image", async () => {
    mockProperties.workerImageList = {
      "seg:1": { isAnnotationWorker: "x" },
    };
    await expect(
      executeAgentTool(
        "create_property",
        { propertyWorkerImage: "seg:1", shape: "polygon" },
        context,
      ),
    ).rejects.toBeInstanceOf(ToolExecutionError);
    expect(mockProperties.createProperty).not.toHaveBeenCalled();
  });

  it("compute_property runs an existing property by id", async () => {
    mockProperties.properties = [{ id: "prop1", name: "Intensity" }];
    mockProperties.computeProperty = vi.fn(async () => ({ jobId: "job1" }));
    const { result } = await executeAgentTool(
      "compute_property",
      { propertyId: "prop1" },
      context,
    );
    expect(mockProperties.computeProperty).toHaveBeenCalledTimes(1);
    expect(mockProperties.computeProperty.mock.calls[0][0].property.id).toBe(
      "prop1",
    );
    expect(result.started).toBe(true);
  });

  it("compute_property rejects an unknown property id", async () => {
    mockProperties.properties = [{ id: "prop1", name: "Intensity" }];
    await expect(
      executeAgentTool("compute_property", { propertyId: "nope" }, context),
    ).rejects.toBeInstanceOf(ToolExecutionError);
    expect(mockProperties.computeProperty).not.toHaveBeenCalled();
  });

  it("get_property_values summarizes computed values as stats", async () => {
    mockProperties.properties = [{ id: "prop1", name: "Intensity" }];
    mockAnnotations.annotations = [
      makeAnnotation({ id: "a1" }),
      makeAnnotation({ id: "a2" }),
      makeAnnotation({ id: "a3" }),
    ];
    mockProperties.propertyValues = {
      a1: { prop1: { mean: 10 } },
      a2: { prop1: { mean: 20 } },
      a3: { prop1: { mean: 30 } },
    };
    mockProperties.computedPropertyPaths = [["prop1", "mean"]];

    const { result } = await executeAgentTool(
      "get_property_values",
      {},
      context,
    );
    expect(mockProperties.fetchPropertyValues).toHaveBeenCalled();
    expect(result.stats).toHaveLength(1);
    expect(result.stats[0]).toMatchObject({
      propertyId: "prop1",
      property: "Intensity",
      count: 3,
      mean: 20,
      min: 10,
      max: 30,
    });
  });

  it("get_property_values filters by annotation query", async () => {
    mockProperties.properties = [{ id: "prop1", name: "Intensity" }];
    mockAnnotations.annotations = [
      makeAnnotation({ id: "a1", tags: ["nucleus"] }),
      makeAnnotation({ id: "a2", tags: [] }),
    ];
    mockProperties.propertyValues = {
      a1: { prop1: { mean: 10 } },
      a2: { prop1: { mean: 100 } },
    };
    mockProperties.computedPropertyPaths = [["prop1", "mean"]];

    const { result } = await executeAgentTool(
      "get_property_values",
      { query: { tags: ["nucleus"] } },
      context,
    );
    expect(result.stats[0]).toMatchObject({ count: 1, mean: 10 });
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

describe("view identity binding (finding #1)", () => {
  beforeEach(() => {
    mockMain.dataset = {
      id: "ds1",
      name: "Dataset",
      xy: [0],
      z: [0],
      time: [0],
      channels: [0],
      channelNames: new Map([[0, "DAPI"]]),
      width: 10,
      height: 10,
    };
    mockMain.configuration = { id: "conf1", name: "Collection", layers: [] };
    mockMain.datasetView = { id: "view1", layerContrasts: {} };
  });

  it("snapshotViewState captures dataset/config/view identity", () => {
    const snapshot = snapshotViewState();
    expect(snapshot.datasetId).toBe("ds1");
    expect(snapshot.configurationId).toBe("conf1");
    expect(snapshot.datasetViewId).toBe("view1");
  });

  it("viewIdentityChangedSince detects a dataset switch", () => {
    const snapshot = snapshotViewState();
    expect(viewIdentityChangedSince(snapshot)).toBe(false);
    mockMain.dataset = { ...mockMain.dataset, id: "ds2" };
    expect(viewIdentityChangedSince(snapshot)).toBe(true);
  });

  it("restoreViewState refuses to revert after the dataset changed", async () => {
    const snapshot = snapshotViewState();
    // Simulate the user navigating to a different dataset mid-response.
    mockMain.dataset = { ...mockMain.dataset, id: "ds2" };
    await expect(restoreViewState(snapshot)).rejects.toBeInstanceOf(
      ToolExecutionError,
    );
    // Must not write the old dataset's contrast into the new dataset's view.
    expect(mockMain.setViewContrastOverrides).not.toHaveBeenCalled();
  });

  it("restoreViewState proceeds when identity is unchanged", async () => {
    const snapshot = snapshotViewState();
    await restoreViewState(snapshot);
    expect(mockMain.setViewContrastOverrides).toHaveBeenCalled();
  });
});

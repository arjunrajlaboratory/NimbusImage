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
    saveContrastInConfiguration: vi.fn(),
    saveScaleInConfiguration: vi.fn(),
    saveScalesInConfiguration: vi.fn(),
    scales: {
      pixelSize: { value: 1, unit: "µm" },
      zStep: { value: 1, unit: "µm" },
      tStep: { value: 1, unit: "s" },
    },
    setViewContrastOverrides: vi.fn(),
    setSelectedToolId: vi.fn(),
    addToolToConfiguration: vi.fn(),
    drawAnnotations: true,
    annotationOpacity: 0.5,
    showScalebar: true,
    scalebarColor: "#ffffff",
    backgroundColor: "black",
    drawAnnotationConnections: true,
    setDrawAnnotations: vi.fn(),
    setAnnotationOpacity: vi.fn(),
    setShowScalebar: vi.fn(),
    setScalebarColor: vi.fn(),
    setBackgroundColor: vi.fn(),
    setDrawAnnotationConnections: vi.fn(),
    agentAPI: { getHelpTopic: vi.fn() },
  },
}));

vi.mock("@/store/volumeView", () => ({
  default: {
    viewMode: "2d",
    setViewMode: vi.fn(),
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
  layerIdForChannelName: vi.fn((name?: string) =>
    name === "DAPI" ? "layer-dapi" : undefined,
  ),
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
    propertyFilters: [] as any[],
    setTagFilter: vi.fn(),
    setOnlyCurrentFrame: vi.fn(),
    updatePropertyFilter: vi.fn(),
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
    // Real store: a getter returning (path) => "Prop / sub" | null. Default to
    // null here so propertyPathLabel falls back to the dotted path.
    getFullNameFromPath: () => null as string | null,
    fetchPropertyValues: vi.fn(),
    createProperty: vi.fn(),
    computeProperty: vi.fn(),
  },
}));

vi.mock("@/store/jobs", () => ({
  default: {
    jobIdForToolId: {} as { [toolId: string]: string },
    jobIdForPropertyId: {} as { [propertyId: string]: string },
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
import volumeViewStore from "@/store/volumeView";
import filterStore from "@/store/filters";
import {
  annotationsBoundingBox,
  describeAgentToolCall,
  executeAgentTool,
  isGatedTool,
  restoreViewState,
  snapshotViewState,
  ToolExecutionError,
  viewIdentityChangedSince,
} from "./executors";
import { MAX_BOX_POINTS, MAX_PLOT_POINTS, MAX_SAMPLE_ROWS } from "./analysis";
import { clearPlots, getPlot } from "./plotRegistry";

const mockMain = main as any;
const mockAnnotations = annotationStore as any;
const mockJobs = jobsStore as any;
const mockProperties = propertyStore as any;
const mockVolumeView = volumeViewStore as any;
const mockFilters = filterStore as any;

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
  mockMain.maps = [];
  mockAnnotations.annotations = [];
  mockAnnotations.selectedAnnotationIds = new Set();
  mockJobs.jobIdForToolId = {};
  mockJobs.jobIdForPropertyId = {};
  mockProperties.workerImageList = {};
  mockProperties.properties = [];
  mockProperties.propertyValues = {};
  mockProperties.computedPropertyPaths = [];
  mockProperties.propertyStatuses = {};
  mockProperties.getWorkerInterface = vi.fn(() => ({}));
  // Reassigned (not just cleared) by tests that make a persist reject, so
  // reset them here — clearAllMocks only resets call history.
  mockMain.syncConfiguration = vi.fn();
  mockMain.setViewContrastOverrides = vi.fn();
  mockMain.drawAnnotations = true;
  mockMain.annotationOpacity = 0.5;
  mockMain.showScalebar = true;
  mockMain.scalebarColor = "#ffffff";
  mockMain.backgroundColor = "black";
  mockMain.drawAnnotationConnections = true;
  mockProperties.getFullNameFromPath = () => null;
  mockVolumeView.viewMode = "2d";
  mockFilters.propertyFilters = [];
  clearPlots();
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
    "set_display_options",
    "set_view_mode",
    "set_scale",
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
    "get_property_histogram",
    "get_sample_values",
    "create_scatter_plot",
    "create_histogram_plot",
    "create_box_plot",
    "read_help_topic",
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

  it("describes a set_camera fit as fitting the view", () => {
    expect(describeAgentToolCall("set_camera", { fit: "annotations" })).toBe(
      "Fit the view to annotations",
    );
    // A zoom-only call keeps its own description.
    expect(describeAgentToolCall("set_camera", { zoom: 3 })).toBe(
      "Zoom to level 3",
    );
  });
});

describe("isGatedTool", () => {
  it("gates run_worker but not view tools", () => {
    expect(isGatedTool("run_worker")).toBe(true);
    expect(isGatedTool("set_location")).toBe(false);
    expect(isGatedTool("get_interface_state")).toBe(false);
  });

  it("gates set_scale (mutates the shared collection, not revertable)", () => {
    expect(isGatedTool("set_scale")).toBe(true);
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

  it("caps a single list_annotations page so it can't dump an unbounded set", async () => {
    mockAnnotations.annotations = Array.from({ length: 5000 }, (_unused, i) =>
      makeAnnotation({ id: `a${i}` }),
    );
    // A model ignoring the summary hint and asking for a huge page must still
    // get at most the hard cap (200), with paging state pointing to the rest.
    const result = (
      await executeAgentTool("list_annotations", { limit: 1000000 }, context)
    ).result;
    expect(result.returned).toBe(200);
    expect(result.annotations.length).toBe(200);
    expect(result.totalMatching).toBe(5000);
    expect(result.hasMore).toBe(true);
    expect(result.nextOffset).toBe(200);
  });

  it("floors a fractional page limit so pagination can't stall", async () => {
    mockAnnotations.annotations = Array.from({ length: 3 }, (_unused, i) =>
      makeAnnotation({ id: `a${i}` }),
    );
    // limit: 0.5 previously sliced to zero rows yet reported a fractional
    // nextOffset (0.5) that normalized back to 0 -> an infinite stall.
    const result = (
      await executeAgentTool("list_annotations", { limit: 0.5 }, context)
    ).result;
    expect(result.returned).toBe(1);
    expect(result.annotations.length).toBe(1);
    expect(result.hasMore).toBe(true);
    expect(result.nextOffset).toBe(1);
    expect(Number.isInteger(result.nextOffset)).toBe(true);
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
      throwOnError: true,
    });
    expect(mockMain.saveContrastInView).toHaveBeenCalledWith({
      layerId: "l1",
      contrast,
      throwOnError: true,
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

  it("passes tags through to the built tool configuration", async () => {
    const { buildToolConfiguration } = await import(
      "@/tools/creation/toolFromCatalog"
    );
    const { result } = await executeAgentTool(
      "create_tool",
      { manualShape: "polygon", tags: ["nucleus"] },
      context,
    );
    expect(buildToolConfiguration).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tags: ["nucleus"] }),
    );
    expect(result.tags).toEqual(["nucleus"]);
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

  it("saves resolved worker parameters on a created worker tool", async () => {
    const { buildToolConfiguration } = await import(
      "@/tools/creation/toolFromCatalog"
    );
    // Overrides land on top of interface defaults, so the saved tool has a
    // concrete value for every parameter slot.
    mockProperties.getWorkerInterface = vi.fn(() => ({
      Channel: { type: "channel", required: true },
      Diameter: { type: "number", default: 30 },
    }));
    const { result } = await executeAgentTool(
      "create_tool",
      { workerImage: "img:1", workerInterfaceValues: { Channel: 1 } },
      context,
    );
    expect(buildToolConfiguration).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workerInterfaceValues: { Channel: 1, Diameter: 30 },
      }),
    );
    expect(result.parameters).toEqual({ Channel: 1, Diameter: 30 });
  });

  it("resolves a channel name and normalizes channelCheckboxes", async () => {
    // The mock dataset has channels 0 (DAPI) and 1 (Cy3). The agent may pass a
    // channel name, an index, or an array; all normalize to the on-disk shape.
    mockProperties.getWorkerInterface = vi.fn(() => ({
      Channel: { type: "channel", required: true },
      "Channel for Slot 1": { type: "channelCheckboxes" },
    }));
    const { result } = await executeAgentTool(
      "create_tool",
      {
        workerImage: "img:1",
        workerInterfaceValues: {
          Channel: "DAPI",
          "Channel for Slot 1": ["DAPI"],
        },
      },
      context,
    );
    expect(result.parameters).toEqual({
      Channel: 0,
      "Channel for Slot 1": { 0: true, 1: false },
    });
  });

  it("rejects a channelCheckboxes value that selects nothing", async () => {
    // The original bug: {"0": 0} means "channel 0" to the model but 0 is falsy,
    // so no channel is selected and the worker fails with "No channel selected".
    mockProperties.getWorkerInterface = vi.fn(() => ({
      "Channel for Slot 1": { type: "channelCheckboxes" },
    }));
    await expect(
      executeAgentTool(
        "create_tool",
        {
          workerImage: "img:1",
          workerInterfaceValues: { "Channel for Slot 1": { 0: 0 } },
        },
        context,
      ),
    ).rejects.toBeInstanceOf(ToolExecutionError);
    expect(mockMain.addToolToConfiguration).not.toHaveBeenCalled();
  });

  it("rejects unknown worker parameters on create_tool", async () => {
    mockProperties.getWorkerInterface = vi.fn(() => ({
      Diameter: { type: "number", default: 30 },
    }));
    await expect(
      executeAgentTool(
        "create_tool",
        { workerImage: "img:1", workerInterfaceValues: { Bogus: 1 } },
        context,
      ),
    ).rejects.toBeInstanceOf(ToolExecutionError);
    expect(mockMain.addToolToConfiguration).not.toHaveBeenCalled();
  });

  it("rejects workerInterfaceValues on a manual tool", async () => {
    await expect(
      executeAgentTool(
        "create_tool",
        { manualShape: "point", workerInterfaceValues: { Diameter: 30 } },
        context,
      ),
    ).rejects.toBeInstanceOf(ToolExecutionError);
    expect(mockMain.addToolToConfiguration).not.toHaveBeenCalled();
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

  it("rejects a channelName that doesn't resolve to a layer", async () => {
    // The mocked layerIdForChannelName only resolves "DAPI"; an unknown channel
    // must error rather than silently create a channel-0 tool.
    mockMain.layers = [{ id: "l0", name: "DAPI", channel: 0 }];
    await expect(
      executeAgentTool(
        "create_tool",
        { manualShape: "polygon", channelName: "Nonexistent" },
        context,
      ),
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

  it("does not submit a worker job if the dataset changed during setup", async () => {
    mockMain.tools = [
      { id: "t1", name: "Cellpose", values: { image: { image: "img:1" } } },
    ];
    mockJobs.jobIdForToolId = {};
    // The active dataset changed while the worker interface was being fetched;
    // the job must not be submitted against the new dataset.
    await expect(
      executeAgentTool(
        "run_worker",
        { toolId: "t1" },
        {
          ...context,
          hasViewIdentityChanged: () => true,
        },
      ),
    ).rejects.toBeInstanceOf(ToolExecutionError);
    expect(mockAnnotations.computeAnnotationsWithWorker).not.toHaveBeenCalled();
  });

  it("submits the worker job when the dataset is unchanged", async () => {
    mockMain.tools = [
      { id: "t1", name: "Cellpose", values: { image: { image: "img:1" } } },
    ];
    mockJobs.jobIdForToolId = {};
    mockAnnotations.computeAnnotationsWithWorker = vi.fn(async () => ({
      jobId: "job7",
    }));
    const { result } = await executeAgentTool(
      "run_worker",
      { toolId: "t1" },
      {
        ...context,
        hasViewIdentityChanged: () => false,
      },
    );
    expect(result.started).toBe(true);
    expect(result.jobId).toBe("job7");
    expect(mockAnnotations.computeAnnotationsWithWorker).toHaveBeenCalled();
  });
});

describe("read_help_topic", () => {
  it("returns a topic's markdown", async () => {
    mockMain.agentAPI = {
      getHelpTopic: vi.fn(async () => "# Workflows\nStep one…"),
    };
    const { result } = await executeAgentTool(
      "read_help_topic",
      { topic: "workflows" },
      context,
    );
    expect(mockMain.agentAPI.getHelpTopic).toHaveBeenCalledWith("workflows");
    expect(result.topic).toBe("workflows");
    expect(result.markdown).toContain("Workflows");
  });

  it("requires a topic string", async () => {
    await expect(
      executeAgentTool("read_help_topic", {}, context),
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it("surfaces the backend's valid-slug list on an unknown topic", async () => {
    mockMain.agentAPI = {
      getHelpTopic: vi.fn(async () => {
        throw {
          response: {
            data: {
              message:
                "Unknown help topic. Available: workflows, troubleshooting",
            },
          },
        };
      }),
    };
    await expect(
      executeAgentTool("read_help_topic", { topic: "bogus" }, context),
    ).rejects.toThrow(/Available: workflows, troubleshooting/);
  });
});

describe("annotationsBoundingBox", () => {
  it("computes a padded box and returns null when empty", () => {
    expect(annotationsBoundingBox([])).toBeNull();
    const box = annotationsBoundingBox(
      [
        makeAnnotation({ coordinates: [{ x: 10, y: 20 }] }),
        makeAnnotation({
          coordinates: [
            { x: 30, y: 60 },
            { x: 0, y: 0 },
          ],
        }),
      ],
      0.1,
    );
    // raw box x:[0,30] y:[0,60]; pad 10% -> x±3, y±6
    expect(box).toEqual({ left: -3, top: -6, right: 33, bottom: 66 });
  });

  it("applies a minimum pad so a single point still frames", () => {
    const box = annotationsBoundingBox(
      [makeAnnotation({ coordinates: [{ x: 100, y: 100 }] })],
      0.1,
      20,
    );
    expect(box).toEqual({ left: 80, top: 80, right: 120, bottom: 120 });
  });
});

describe("set_camera fit", () => {
  it("errors when the map is not ready", async () => {
    mockMain.maps = [];
    await expect(
      executeAgentTool("set_camera", { fit: "full" }, context),
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it("fits to annotations with y-negated (map gcs is y-up) bounds", async () => {
    const boundsFn = vi.fn();
    mockMain.maps = [
      {
        map: {
          bounds: boundsFn,
          maxBounds: vi.fn(() => ({
            left: 0,
            right: 1024,
            top: 0,
            bottom: -1024,
          })),
        },
      },
    ];
    mockAnnotations.annotations = [
      makeAnnotation({ id: "a1", coordinates: [{ x: 100, y: 200 }] }),
      makeAnnotation({ id: "a2", coordinates: [{ x: 300, y: 600 }] }),
    ];
    await executeAgentTool("set_camera", { fit: "annotations" }, context);
    expect(boundsFn).toHaveBeenCalledTimes(1);
    const arg = boundsFn.mock.calls[0][0];
    // pixel bbox x:[100,300] (pad 20) -> left 80, right 320
    // pixel bbox y:[200,600] (pad 40) -> negated: top -160, bottom -640
    expect(arg).toEqual({ left: 80, right: 320, top: -160, bottom: -640 });
    // valid GeoJS y-up bounds: top must be greater than bottom
    expect(arg.top).toBeGreaterThan(arg.bottom);
  });

  it("fit=full applies maxBounds directly (already map gcs)", async () => {
    const boundsFn = vi.fn();
    const maxB = { left: 0, right: 1024, top: 0, bottom: -1024 };
    mockMain.maps = [
      { map: { bounds: boundsFn, maxBounds: vi.fn(() => maxB) } },
    ];
    await executeAgentTool("set_camera", { fit: "full" }, context);
    expect(boundsFn).toHaveBeenCalledWith(maxB, null);
  });
});

describe("update_layer contrast scope", () => {
  const layer = {
    id: "l1",
    name: "DAPI",
    color: "#0000ff",
    visible: true,
    contrast: { mode: "percentile", blackPoint: 0, whitePoint: 100 },
  };
  const contrast = { mode: "percentile", blackPoint: 5, whitePoint: 95 } as any;

  beforeEach(() => {
    mockMain.layers = [layer];
    mockMain.getLayerFromId = vi.fn(() => layer);
  });

  it("defaults contrast to the personal view", async () => {
    await executeAgentTool("update_layer", { layer: "l1", contrast }, context);
    expect(mockMain.saveContrastInView).toHaveBeenCalledWith({
      layerId: "l1",
      contrast,
      throwOnError: true,
    });
    expect(mockMain.saveContrastInConfiguration).not.toHaveBeenCalled();
  });

  it("saves to the shared configuration when scope is configuration", async () => {
    await executeAgentTool(
      "update_layer",
      { layer: "l1", contrast, contrastScope: "configuration" },
      context,
    );
    expect(mockMain.saveContrastInConfiguration).toHaveBeenCalledWith({
      layerId: "l1",
      contrast,
      throwOnError: true,
    });
    expect(mockMain.saveContrastInView).not.toHaveBeenCalled();
  });
});

describe("surfaces backend sync failures (#1239)", () => {
  const layer = {
    id: "l1",
    name: "DAPI",
    color: "#0000ff",
    visible: true,
    contrast: { mode: "percentile", blackPoint: 0, whitePoint: 100 },
  };
  const contrast = { mode: "percentile", blackPoint: 5, whitePoint: 95 } as any;

  beforeEach(() => {
    mockMain.layers = [layer];
    mockMain.getLayerFromId = vi.fn(() => layer);
    // Reset to benign resolving mocks (a prior test may have made one reject).
    mockMain.changeLayer = vi.fn(async () => undefined);
    mockMain.syncConfiguration = vi.fn(async () => undefined);
    mockMain.saveContrastInView = vi.fn(async () => undefined);
    mockMain.saveContrastInConfiguration = vi.fn(async () => undefined);
    mockMain.setLayerMode = vi.fn(async () => undefined);
    mockMain.saveScaleInConfiguration = vi.fn(async () => undefined);
    mockMain.saveScalesInConfiguration = vi.fn(async () => undefined);
    mockMain.addToolToConfiguration = vi.fn(async () => undefined);
    mockMain.configuration = { id: "conf1", name: "Collection", layers: [] };
    mockProperties.workerImageList = {
      "prop:1": {
        isPropertyWorker: "x",
        interfaceName: "Intensity",
        annotationShape: "polygon",
      },
    };
    mockProperties.getWorkerInterface = vi.fn(() => ({}));
  });

  it("update_layer reports a failed config save instead of success", async () => {
    // syncConfiguration with throwOnError rejects on a read-only collection;
    // changeLayer propagates it. The tool must fail, not report the layer as
    // updated.
    mockMain.changeLayer = vi.fn(async () => {
      throw new Error("Write access denied");
    });
    await expect(
      executeAgentTool(
        "update_layer",
        { layer: "l1", color: "#ff0000" },
        context,
      ),
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it("update_layer reports a failed contrast save", async () => {
    mockMain.saveContrastInView = vi.fn(async () => {
      throw new Error("network error");
    });
    await expect(
      executeAgentTool("update_layer", { layer: "l1", contrast }, context),
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it("set_layer_visibility reports a failed sync instead of success", async () => {
    mockMain.syncConfiguration = vi.fn(async () => {
      throw new Error("Write access denied");
    });
    await expect(
      executeAgentTool(
        "set_layer_visibility",
        { visibleLayers: ["l1"] },
        context,
      ),
    ).rejects.toBeInstanceOf(ToolExecutionError);
    // The failing sync is the one that opted into throwOnError.
    expect(mockMain.syncConfiguration).toHaveBeenCalledWith({
      key: "layers",
      throwOnError: true,
    });
  });

  it("update_layer still succeeds when the save succeeds", async () => {
    const { result } = await executeAgentTool(
      "update_layer",
      { layer: "l1", color: "#ff0000" },
      context,
    );
    expect(result.layer.id).toBe("l1");
    expect(mockMain.changeLayer).toHaveBeenCalledWith({
      layerId: "l1",
      delta: { color: "#ff0000" },
      throwOnError: true,
    });
  });

  it("set_layer_mode reports a failed sync instead of success", async () => {
    mockMain.setLayerMode = vi.fn(async () => {
      throw new Error("Write access denied");
    });
    await expect(
      executeAgentTool("set_layer_mode", { mode: "multiple" }, context),
    ).rejects.toBeInstanceOf(ToolExecutionError);
    expect(mockMain.setLayerMode).toHaveBeenCalledWith({
      mode: "multiple",
      throwOnError: true,
    });
  });

  it("set_scale reports a failed sync instead of success", async () => {
    mockMain.saveScalesInConfiguration = vi.fn(async () => {
      throw new Error("Write access denied");
    });
    await expect(
      executeAgentTool(
        "set_scale",
        { pixelSize: { value: 0.65, unit: "µm" } },
        context,
      ),
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it("create_tool reports a failed sync instead of success", async () => {
    mockMain.addToolToConfiguration = vi.fn(async () => {
      throw new Error("Write access denied");
    });
    await expect(
      executeAgentTool("create_tool", { manualShape: "polygon" }, context),
    ).rejects.toBeInstanceOf(ToolExecutionError);
    // The AI panel opts into error propagation via the options form.
    expect(mockMain.addToolToConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({ throwOnError: true }),
    );
  });

  it("create_property reports a failed backend save instead of success", async () => {
    mockProperties.createProperty = vi.fn(async () => {
      throw new Error("Write access denied");
    });
    await expect(
      executeAgentTool(
        "create_property",
        { propertyWorkerImage: "prop:1", shape: "polygon" },
        context,
      ),
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });
});

describe("display + view mode tools", () => {
  it("set_display_options applies only the provided settings", async () => {
    await executeAgentTool(
      "set_display_options",
      { drawAnnotations: false, annotationOpacity: 0.8 },
      context,
    );
    expect(mockMain.setDrawAnnotations).toHaveBeenCalledWith(false);
    expect(mockMain.setAnnotationOpacity).toHaveBeenCalledWith(0.8);
    expect(mockMain.setShowScalebar).not.toHaveBeenCalled();
    expect(mockMain.setBackgroundColor).not.toHaveBeenCalled();
  });

  it("set_display_options rejects an out-of-range opacity", async () => {
    await expect(
      executeAgentTool(
        "set_display_options",
        { annotationOpacity: 5 },
        context,
      ),
    ).rejects.toBeInstanceOf(ToolExecutionError);
    expect(mockMain.setAnnotationOpacity).not.toHaveBeenCalled();
  });

  it("set_display_options requires at least one option", async () => {
    await expect(
      executeAgentTool("set_display_options", {}, context),
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it("set_view_mode switches 2D/3D and rejects other values", async () => {
    await executeAgentTool("set_view_mode", { mode: "3d" }, context);
    expect(mockVolumeView.setViewMode).toHaveBeenCalledWith("3d");
    await expect(
      executeAgentTool("set_view_mode", { mode: "sideways" }, context),
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it("view snapshot captures and restores display options + view mode", async () => {
    mockMain.drawAnnotations = false;
    mockMain.annotationOpacity = 0.3;
    mockVolumeView.viewMode = "3d";
    const snapshot = snapshotViewState();
    expect(snapshot.displayOptions.drawAnnotations).toBe(false);
    expect(snapshot.displayOptions.annotationOpacity).toBe(0.3);
    expect(snapshot.viewMode).toBe("3d");

    await restoreViewState(snapshot);
    expect(mockMain.setDrawAnnotations).toHaveBeenCalledWith(false);
    expect(mockMain.setAnnotationOpacity).toHaveBeenCalledWith(0.3);
    expect(mockVolumeView.setViewMode).toHaveBeenCalledWith("3d");
  });
});

describe("set_scale", () => {
  it("sets pixel size / z-step in the configuration", async () => {
    await executeAgentTool(
      "set_scale",
      {
        pixelSize: { value: 0.65, unit: "µm" },
        zStep: { value: 2, unit: "µm" },
      },
      context,
    );
    // One backend write for all requested fields, not one per field
    // (Codex P2 on PR #1262).
    expect(mockMain.saveScalesInConfiguration).toHaveBeenCalledTimes(1);
    expect(mockMain.saveScalesInConfiguration).toHaveBeenCalledWith({
      scales: {
        pixelSize: { value: 0.65, unit: "µm" },
        zStep: { value: 2, unit: "µm" },
      },
      throwOnError: true,
    });
  });

  it("rejects a non-positive value", async () => {
    await expect(
      executeAgentTool(
        "set_scale",
        { pixelSize: { value: 0, unit: "µm" } },
        context,
      ),
    ).rejects.toBeInstanceOf(ToolExecutionError);
    expect(mockMain.saveScalesInConfiguration).not.toHaveBeenCalled();
  });

  it("rejects a length unit on the time step and vice versa", async () => {
    await expect(
      executeAgentTool(
        "set_scale",
        { tStep: { value: 1, unit: "µm" } },
        context,
      ),
    ).rejects.toBeInstanceOf(ToolExecutionError);
    await expect(
      executeAgentTool(
        "set_scale",
        { pixelSize: { value: 1, unit: "s" } },
        context,
      ),
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it("writes nothing when a later field is invalid", async () => {
    // Validation used to be interleaved with saving, so a valid pixelSize was
    // already persisted before an invalid tStep threw, leaving the shared
    // collection partially updated (Codex P2 on PR #1262).
    await expect(
      executeAgentTool(
        "set_scale",
        {
          pixelSize: { value: 0.65, unit: "µm" },
          tStep: { value: 1, unit: "µm" },
        },
        context,
      ),
    ).rejects.toBeInstanceOf(ToolExecutionError);
    expect(mockMain.saveScalesInConfiguration).not.toHaveBeenCalled();
    expect(mockMain.saveScaleInConfiguration).not.toHaveBeenCalled();
  });

  it("requires at least one dimension", async () => {
    await expect(
      executeAgentTool("set_scale", {}, context),
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });
});

describe("set_annotation_filter property filters", () => {
  it("adds a range property filter from a propertyPath", async () => {
    await executeAgentTool(
      "set_annotation_filter",
      { propertyFilters: [{ propertyPath: ["prop1", "area"], min: 100 }] },
      context,
    );
    expect(mockFilters.updatePropertyFilter).toHaveBeenCalledTimes(1);
    const filter = mockFilters.updatePropertyFilter.mock.calls[0][0];
    expect(filter).toMatchObject({
      propertyPath: ["prop1", "area"],
      enabled: true,
      valuesOrRange: "range",
    });
    expect(filter.range.min).toBe(100);
    expect(filter.range.max).toBe(Number.MAX_VALUE);
  });

  it("rejects a property filter with neither min nor max", async () => {
    await expect(
      executeAgentTool(
        "set_annotation_filter",
        { propertyFilters: [{ propertyPath: ["prop1", "area"] }] },
        context,
      ),
    ).rejects.toBeInstanceOf(ToolExecutionError);
    expect(mockFilters.updatePropertyFilter).not.toHaveBeenCalled();
  });

  it("rejects a property filter with a bad propertyPath", async () => {
    await expect(
      executeAgentTool(
        "set_annotation_filter",
        { propertyFilters: [{ propertyPath: [], min: 1 }] },
        context,
      ),
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it("clearPropertyFilters disables active property filters", async () => {
    mockFilters.propertyFilters = [
      { id: "p", enabled: true, propertyPath: ["prop1", "area"], range: {} },
    ];
    await executeAgentTool(
      "set_annotation_filter",
      { clearPropertyFilters: true },
      context,
    );
    expect(mockFilters.updatePropertyFilter).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    );
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
      "prop:1": {
        isPropertyWorker: "x",
        interfaceName: "Intensity",
        annotationShape: "polygon",
      },
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

  it("create_property rejects a worker whose shape doesn't match", async () => {
    // Worker operates on points; asking for a polygon property is unusable.
    mockProperties.workerImageList = {
      "prop:1": { isPropertyWorker: "x", annotationShape: "point" },
    };
    await expect(
      executeAgentTool(
        "create_property",
        { propertyWorkerImage: "prop:1", shape: "polygon" },
        context,
      ),
    ).rejects.toBeInstanceOf(ToolExecutionError);
    expect(mockProperties.createProperty).not.toHaveBeenCalled();
  });

  it("create_property accepts an 'any'-shape property worker", async () => {
    mockProperties.workerImageList = {
      "prop:any": { isPropertyWorker: "x", annotationShape: "any" },
    };
    mockProperties.getWorkerInterface = vi.fn(() => ({}));
    mockProperties.createProperty = vi.fn(async (config: any) => ({
      id: "prop-any",
      ...config,
    }));
    const { result } = await executeAgentTool(
      "create_property",
      { propertyWorkerImage: "prop:any", shape: "polygon" },
      context,
    );
    expect(result.propertyId).toBe("prop-any");
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

  it("compute_property does not double-submit a running property job", async () => {
    mockProperties.properties = [{ id: "prop1", name: "Intensity" }];
    mockJobs.jobIdForPropertyId = { prop1: "job99" };
    mockProperties.computeProperty = vi.fn();
    const { result } = await executeAgentTool(
      "compute_property",
      { propertyId: "prop1" },
      context,
    );
    expect(result.alreadyRunning).toBe(true);
    expect(result.jobId).toBe("job99");
    expect(mockProperties.computeProperty).not.toHaveBeenCalled();
  });

  it("compute_property reports failure when no job starts", async () => {
    mockProperties.properties = [{ id: "prop1", name: "Intensity" }];
    // computeProperty returns null when job creation fails.
    mockProperties.computeProperty = vi.fn(async () => null);
    await expect(
      executeAgentTool("compute_property", { propertyId: "prop1" }, context),
    ).rejects.toBeInstanceOf(ToolExecutionError);
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
    // Hand-computed over [10, 20, 30]: sample std sqrt(200/2)=10; inclusive
    // quantiles p25=15, median=20, p75=25.
    expect(result.stats[0]).toMatchObject({
      propertyId: "prop1",
      property: "Intensity",
      count: 3,
      mean: 20,
      std: 10,
      min: 10,
      max: 30,
      median: 20,
      p25: 15,
      p75: 25,
    });
  });

  it("get_property_values rounds stats to 6 significant digits", async () => {
    mockProperties.properties = [{ id: "prop1", name: "Intensity" }];
    mockAnnotations.annotations = [
      makeAnnotation({ id: "a1" }),
      makeAnnotation({ id: "a2" }),
    ];
    mockProperties.propertyValues = {
      a1: { prop1: { mean: 1 } },
      a2: { prop1: { mean: 2 } },
    };
    mockProperties.computedPropertyPaths = [["prop1", "mean"]];

    const { result } = await executeAgentTool(
      "get_property_values",
      {},
      context,
    );
    // Sample std of [1, 2] = sqrt(0.5) = 0.70710678… -> 6 sig digits.
    expect(result.stats[0]).toMatchObject({
      count: 2,
      mean: 1.5,
      std: 0.707107,
      min: 1,
      max: 2,
      median: 1.5,
      p25: 1.25,
      p75: 1.75,
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

  it("get_property_values handles a very large value set without RangeError", async () => {
    // Spreading an uncapped array into Math.min/max throws past the engine's
    // argument limit (~65k). Use enough values to exceed it comfortably.
    const count = 200000;
    mockProperties.properties = [{ id: "prop1", name: "Intensity" }];
    const annotations: any[] = [];
    const propertyValues: { [id: string]: any } = {};
    for (let i = 0; i < count; i++) {
      const id = `a${i}`;
      annotations.push(makeAnnotation({ id }));
      propertyValues[id] = { prop1: { mean: i } };
    }
    mockAnnotations.annotations = annotations;
    mockProperties.propertyValues = propertyValues;
    mockProperties.computedPropertyPaths = [["prop1", "mean"]];

    const { result } = await executeAgentTool(
      "get_property_values",
      {},
      context,
    );
    expect(result.stats[0]).toMatchObject({
      count,
      min: 0,
      max: count - 1,
      mean: (count - 1) / 2,
    });
  });
});

describe("data analysis tools", () => {
  // Point a1..aN each at prop1.mean = its supplied value; tag them as given.
  function seedValues(values: { [id: string]: number }, tags: string[] = []) {
    mockAnnotations.annotations = Object.keys(values).map((id) =>
      makeAnnotation({ id, tags }),
    );
    mockProperties.propertyValues = Object.fromEntries(
      Object.entries(values).map(([id, v]) => [id, { prop1: { mean: v } }]),
    );
  }

  describe("get_property_histogram", () => {
    it("bins values so bucket counts sum to the value count", async () => {
      seedValues({
        a0: 0,
        a1: 1,
        a2: 2,
        a3: 3,
        a4: 4,
        a5: 5,
        a6: 6,
        a7: 7,
        a8: 8,
        a9: 9,
      });
      const { result } = await executeAgentTool(
        "get_property_histogram",
        { propertyPath: ["prop1", "mean"], buckets: 5 },
        context,
      );
      expect(result.buckets).toHaveLength(5);
      expect(result.totalCount).toBe(10);
      const summed = result.buckets.reduce(
        (sum: number, b: any) => sum + b.count,
        0,
      );
      expect(summed).toBe(10);
    });

    it("restricts the histogram to a query", async () => {
      // a1/a2 tagged keep, a3/a4 untagged; the query keeps only the tagged two.
      mockAnnotations.annotations = [
        makeAnnotation({ id: "a1", tags: ["keep"] }),
        makeAnnotation({ id: "a2", tags: ["keep"] }),
        makeAnnotation({ id: "a3", tags: [] }),
        makeAnnotation({ id: "a4", tags: [] }),
      ];
      mockProperties.propertyValues = {
        a1: { prop1: { mean: 1 } },
        a2: { prop1: { mean: 2 } },
        a3: { prop1: { mean: 3 } },
        a4: { prop1: { mean: 4 } },
      };
      const all = await executeAgentTool(
        "get_property_histogram",
        { propertyPath: ["prop1", "mean"] },
        context,
      );
      expect(all.result.totalCount).toBe(4);
      const restricted = await executeAgentTool(
        "get_property_histogram",
        { propertyPath: ["prop1", "mean"], query: { tags: ["keep"] } },
        context,
      );
      expect(restricted.result.totalCount).toBe(2);
    });

    it("errors helpfully on a path with no numeric values", async () => {
      seedValues({ a1: 1, a2: 2 });
      await expect(
        executeAgentTool(
          "get_property_histogram",
          { propertyPath: ["prop1", "missing"] },
          context,
        ),
      ).rejects.toThrow(/prop1\.missing.*get_property_values/s);
    });

    it("aborts if the dataset changed during the property-value fetch", async () => {
      seedValues({ a1: 1, a2: 2 });
      // The user navigated to a different dataset while fetchPropertyValues
      // was in flight; the tool must not analyze the now-current dataset.
      const changedContext = { ...context, hasViewIdentityChanged: () => true };
      await expect(
        executeAgentTool(
          "get_property_histogram",
          { propertyPath: ["prop1", "mean"] },
          changedContext,
        ),
      ).rejects.toThrow(/active dataset changed/);
    });

    it("excludes property values orphaned by deleted annotations", async () => {
      // Two live annotations, but propertyValues also carries a value for
      // "ghost" — an annotation that was deleted (the backend leaves such
      // values behind). Analysis must count only the live pair, not the ghost.
      mockAnnotations.annotations = [
        makeAnnotation({ id: "a1" }),
        makeAnnotation({ id: "a2" }),
      ];
      mockProperties.propertyValues = {
        a1: { prop1: { mean: 1 } },
        a2: { prop1: { mean: 2 } },
        ghost: { prop1: { mean: 999 } },
      };
      const { result } = await executeAgentTool(
        "get_property_histogram",
        { propertyPath: ["prop1", "mean"] },
        context,
      );
      expect(result.totalCount).toBe(2);
    });

    it("clamps buckets above the maximum", async () => {
      seedValues({
        a0: 0,
        a1: 1,
        a2: 2,
        a3: 3,
        a4: 4,
        a5: 5,
        a6: 6,
        a7: 7,
        a8: 8,
        a9: 9,
      });
      const { result } = await executeAgentTool(
        "get_property_histogram",
        { propertyPath: ["prop1", "mean"], buckets: 1000 },
        context,
      );
      // MAX_HISTOGRAM_BUCKETS is 200.
      expect(result.buckets).toHaveLength(200);
    });
  });

  describe("get_sample_values", () => {
    it("returns rows of id, tags and requested path values (null if missing)", async () => {
      mockAnnotations.annotations = [
        makeAnnotation({ id: "a1", tags: ["nucleus"] }),
        makeAnnotation({ id: "a2", tags: [] }),
        makeAnnotation({ id: "a3", tags: ["spot"] }),
      ];
      mockProperties.propertyValues = {
        a1: { prop1: { mean: 10 } },
        a2: { prop1: { mean: 20 } },
        a3: {},
      };
      const { result } = await executeAgentTool(
        "get_sample_values",
        { propertyPaths: [["prop1", "mean"]] },
        context,
      );
      expect(result.totalMatching).toBe(3);
      expect(result.rows).toHaveLength(3);
      const byId = Object.fromEntries(
        result.rows.map((row: any) => [row.annotationId, row]),
      );
      expect(byId.a1).toMatchObject({
        tags: ["nucleus"],
        "prop1.mean": 10,
      });
      // a3 has no value on the path -> null, not dropped.
      expect(byId.a3["prop1.mean"]).toBeNull();
    });

    it("clamps n to MAX_SAMPLE_ROWS", async () => {
      const values: { [id: string]: any } = {};
      const annotations: any[] = [];
      for (let i = 0; i < 300; i++) {
        annotations.push(makeAnnotation({ id: `a${i}` }));
        values[`a${i}`] = { prop1: { mean: i } };
      }
      mockAnnotations.annotations = annotations;
      mockProperties.propertyValues = values;
      const { result } = await executeAgentTool(
        "get_sample_values",
        { propertyPaths: [["prop1", "mean"]], n: 1000 },
        context,
      );
      expect(result.rows).toHaveLength(MAX_SAMPLE_ROWS);
      expect(result.totalMatching).toBe(300);
    });

    it("rejects an empty propertyPaths array", async () => {
      seedValues({ a1: 1 });
      await expect(
        executeAgentTool("get_sample_values", { propertyPaths: [] }, context),
      ).rejects.toBeInstanceOf(ToolExecutionError);
    });
  });

  describe("create_scatter_plot", () => {
    it("plots only annotations with a numeric value on both axes", async () => {
      mockAnnotations.annotations = [
        makeAnnotation({ id: "a1" }),
        makeAnnotation({ id: "a2" }),
        makeAnnotation({ id: "a3" }),
      ];
      mockProperties.propertyValues = {
        a1: { px: { v: 1 }, py: { v: 2 } },
        a2: { px: { v: 3 } }, // no y -> dropped
        a3: { py: { v: 4 } }, // no x -> dropped
      };
      const { result, plots } = await executeAgentTool(
        "create_scatter_plot",
        {
          xPropertyPath: ["px", "v"],
          yPropertyPath: ["py", "v"],
          title: "x vs y",
        },
        context,
      );
      expect(result.pointCount).toBe(1);
      expect(result.downsampled).toBe(false);
      expect(plots).toHaveLength(1);
      // The plot is registered and retrievable, with full-precision points.
      const plot = getPlot(result.plotId);
      expect(plot).toBeDefined();
      const trace = (plot!.data as any[])[0];
      expect(trace.type).toBe("scattergl");
      expect(trace.x).toEqual([1]);
      expect(trace.y).toEqual([2]);
    });

    it("colors by first tag with one trace per tag plus untagged", async () => {
      mockAnnotations.annotations = [
        makeAnnotation({ id: "a1", tags: ["nucleus"] }),
        makeAnnotation({ id: "a2", tags: [] }),
        makeAnnotation({ id: "a3", tags: ["nucleus"] }),
      ];
      mockProperties.propertyValues = {
        a1: { px: { v: 1 }, py: { v: 1 } },
        a2: { px: { v: 2 }, py: { v: 2 } },
        a3: { px: { v: 3 }, py: { v: 3 } },
      };
      const { result } = await executeAgentTool(
        "create_scatter_plot",
        {
          xPropertyPath: ["px", "v"],
          yPropertyPath: ["py", "v"],
          title: "colored",
          colorByTag: true,
        },
        context,
      );
      const plot = getPlot(result.plotId)!;
      const names = (plot.data as any[]).map((trace) => trace.name);
      expect(names).toContain("nucleus");
      expect(names).toContain("untagged");
      expect(plot.data).toHaveLength(2);
    });

    it("errors with both axis counts when nothing overlaps", async () => {
      mockAnnotations.annotations = [
        makeAnnotation({ id: "a1" }),
        makeAnnotation({ id: "a2" }),
      ];
      mockProperties.propertyValues = {
        a1: { px: { v: 1 } },
        a2: { py: { v: 2 } },
      };
      await expect(
        executeAgentTool(
          "create_scatter_plot",
          {
            xPropertyPath: ["px", "v"],
            yPropertyPath: ["py", "v"],
            title: "empty",
          },
          context,
        ),
      ).rejects.toThrow(/px\.v.*py\.v/s);
    });

    it("requires a non-empty title", async () => {
      seedValues({ a1: 1 });
      await expect(
        executeAgentTool(
          "create_scatter_plot",
          {
            xPropertyPath: ["prop1", "mean"],
            yPropertyPath: ["prop1", "mean"],
            title: "",
          },
          context,
        ),
      ).rejects.toBeInstanceOf(ToolExecutionError);
    });

    it("downsamples beyond MAX_PLOT_POINTS and flags the title", async () => {
      const annotations: any[] = [];
      const propertyValues: { [id: string]: any } = {};
      const total = MAX_PLOT_POINTS + 10000;
      for (let i = 0; i < total; i++) {
        const id = `a${i}`;
        annotations.push(makeAnnotation({ id }));
        propertyValues[id] = { px: { v: i }, py: { v: i } };
      }
      mockAnnotations.annotations = annotations;
      mockProperties.propertyValues = propertyValues;
      const { result } = await executeAgentTool(
        "create_scatter_plot",
        {
          xPropertyPath: ["px", "v"],
          yPropertyPath: ["py", "v"],
          title: "big",
        },
        context,
      );
      expect(result.downsampled).toBe(true);
      expect(result.pointCount).toBeLessThanOrEqual(MAX_PLOT_POINTS);
      expect(result.title.endsWith("(downsampled)")).toBe(true);
    });
  });

  describe("create_histogram_plot", () => {
    it("builds a bar trace with matching x/width/y lengths", async () => {
      seedValues({
        a0: 0,
        a1: 1,
        a2: 2,
        a3: 3,
        a4: 4,
        a5: 5,
        a6: 6,
        a7: 7,
        a8: 8,
        a9: 9,
      });
      const { result, plots } = await executeAgentTool(
        "create_histogram_plot",
        { propertyPath: ["prop1", "mean"], title: "dist", buckets: 5 },
        context,
      );
      expect(result.bucketCount).toBe(5);
      expect(plots).toHaveLength(1);
      const trace = (getPlot(result.plotId)!.data as any[])[0];
      expect(trace.type).toBe("bar");
      expect(trace.x).toHaveLength(5);
      expect(trace.width).toHaveLength(5);
      expect(trace.y).toHaveLength(5);
    });

    it("omits bar width for constant data so the single bar is visible", async () => {
      // All values equal -> one zero-width bucket; an explicit width of 0 would
      // render an invisible bar, so width must be omitted (Plotly auto-sizes).
      seedValues({ a1: 5, a2: 5, a3: 5 });
      const { result } = await executeAgentTool(
        "create_histogram_plot",
        { propertyPath: ["prop1", "mean"], title: "const" },
        context,
      );
      const trace = (getPlot(result.plotId)!.data as any[])[0];
      expect(trace.y).toEqual([3]);
      expect(trace.width).toBeUndefined();
    });
  });

  describe("create_box_plot", () => {
    it("names one trace per property path", async () => {
      seedValues({ a1: 1, a2: 2, a3: 3 });
      const { result } = await executeAgentTool(
        "create_box_plot",
        { propertyPaths: [["prop1", "mean"]], title: "spread" },
        context,
      );
      expect(result.traceCount).toBe(1);
      const trace = (getPlot(result.plotId)!.data as any[])[0];
      expect(trace.type).toBe("box");
      // getFullNameFromPath returns null -> dotted-path fallback.
      expect(trace.name).toBe("prop1.mean");
      expect(trace.y).toEqual([1, 2, 3]);
    });

    it("rejects groupByTag with more than one path", async () => {
      seedValues({ a1: 1 });
      await expect(
        executeAgentTool(
          "create_box_plot",
          {
            propertyPaths: [
              ["prop1", "mean"],
              ["prop2", "mean"],
            ],
            title: "bad",
            groupByTag: true,
          },
          context,
        ),
      ).rejects.toBeInstanceOf(ToolExecutionError);
    });

    it("uses exact precomputed stats above the point cap, not a downsample", async () => {
      // 0..MAX_BOX_POINTS inclusive => MAX_BOX_POINTS+1 values, over the cap.
      const values: { [id: string]: number } = {};
      for (let i = 0; i <= MAX_BOX_POINTS; i++) {
        values[`a${i}`] = i;
      }
      seedValues(values);
      const { result } = await executeAgentTool(
        "create_box_plot",
        { propertyPaths: [["prop1", "mean"]], title: "big" },
        context,
      );
      const trace = (getPlot(result.plotId)!.data as any[])[0];
      // No raw y array (that path would have been downsampled); exact quartiles
      // computed from the full data instead.
      expect(trace.y).toBeUndefined();
      expect(trace.q1).toEqual([5000]);
      expect(trace.median).toEqual([10000]);
      expect(trace.q3).toEqual([15000]);
      // Uniform data has no outliers, so whiskers reach the extremes.
      expect(trace.lowerfence).toEqual([0]);
      expect(trace.upperfence).toEqual([MAX_BOX_POINTS]);
    });

    it("clamps precomputed whiskers to the Tukey fence above the cap", async () => {
      // Over-cap: a tight cluster plus one extreme value. The whisker must end
      // at the cluster (the outlier stays outside), not at the extreme.
      const values: { [id: string]: number } = {};
      for (let i = 0; i < MAX_BOX_POINTS; i++) {
        values[`a${i}`] = 10;
      }
      values.outlier = 1_000_000;
      seedValues(values);
      const { result } = await executeAgentTool(
        "create_box_plot",
        { propertyPaths: [["prop1", "mean"]], title: "outlier" },
        context,
      );
      const trace = (getPlot(result.plotId)!.data as any[])[0];
      expect(trace.y).toBeUndefined();
      expect(trace.upperfence).toEqual([10]);
      expect(trace.lowerfence).toEqual([10]);
    });

    it("groups one box per first tag when groupByTag is set", async () => {
      mockAnnotations.annotations = [
        makeAnnotation({ id: "a1", tags: ["nucleus"] }),
        makeAnnotation({ id: "a2", tags: ["spot"] }),
        makeAnnotation({ id: "a3", tags: ["nucleus"] }),
      ];
      mockProperties.propertyValues = {
        a1: { prop1: { mean: 1 } },
        a2: { prop1: { mean: 2 } },
        a3: { prop1: { mean: 3 } },
      };
      const { result } = await executeAgentTool(
        "create_box_plot",
        {
          propertyPaths: [["prop1", "mean"]],
          title: "by tag",
          groupByTag: true,
        },
        context,
      );
      const names = (getPlot(result.plotId)!.data as any[]).map((t) => t.name);
      expect(names).toContain("nucleus");
      expect(names).toContain("spot");
    });
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
    // The revert must opt into error propagation, otherwise a rejected write
    // is swallowed and revertViewChanges still reports "Reverted the view
    // changes" for a change that only applied locally (issue #1239).
    expect(mockMain.syncConfiguration).toHaveBeenCalledWith({
      key: "layers",
      throwOnError: true,
    });
  });

  it("rejects when the revert's configuration sync fails", async () => {
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
    mockMain.configuration.layers[0].color = "#00ff00";
    mockMain.syncConfiguration = vi.fn(async () => {
      throw new Error("Read-only collection");
    });

    await expect(restoreViewState(snapshot)).rejects.toBeInstanceOf(
      ToolExecutionError,
    );
  });

  it("rejects when the revert's view-contrast persist fails", async () => {
    const snapshot = snapshotViewState();
    mockMain.setViewContrastOverrides = vi.fn(async () => {
      throw new Error("Dataset view is read-only");
    });

    await expect(restoreViewState(snapshot)).rejects.toBeInstanceOf(
      ToolExecutionError,
    );
  });

  it("reverts property filters added or changed during the turn", async () => {
    const savedFilter = {
      id: "p1/area",
      enabled: true,
      exclusive: false,
      propertyPath: ["p1", "area"],
      range: { min: 10, max: 20 },
    };
    mockFilters.propertyFilters = [savedFilter];
    const snapshot = snapshotViewState();

    // During the turn the model added a second property filter.
    mockFilters.propertyFilters = [
      savedFilter,
      {
        id: "p2/mean",
        enabled: true,
        exclusive: false,
        propertyPath: ["p2", "mean"],
        range: { min: 0, max: 5 },
      },
    ];

    await restoreViewState(snapshot);

    // The filter added during the turn is disabled, and the snapshot's filter
    // is re-applied.
    expect(mockFilters.updatePropertyFilter).toHaveBeenCalledWith(
      expect.objectContaining({ propertyPath: ["p2", "mean"], enabled: false }),
    );
    expect(mockFilters.updatePropertyFilter).toHaveBeenCalledWith(
      expect.objectContaining({ propertyPath: ["p1", "area"], enabled: true }),
    );
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

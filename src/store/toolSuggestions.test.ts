import { describe, it, expect, vi, beforeEach } from "vitest";

// See codebaseDocumentation/AUTO_TOOL_SUGGESTIONS.md for the design this
// module implements.

vi.mock("@/utils/log", () => ({
  logError: vi.fn(),
}));

vi.mock("@/utils/interfaceCapture", () => ({
  captureInterfaceScreenshot: vi.fn(),
  captureViewportScreenshot: vi.fn(),
  dataUrlToBase64: vi.fn(),
}));

// Mocked relative to this file, same directory as the module under test, so
// it resolves to the same modules toolSuggestions.ts imports via "./index"
// and "./properties".
vi.mock("./index", () => ({
  default: {
    dataset: null,
    configuration: null,
    layers: [] as any[],
    toolTemplateList: [] as any[],
    maps: [] as any[],
    chatAPI: { getToolSuggestions: vi.fn() },
    addToolToConfiguration: vi.fn(),
    addToolsToConfiguration: vi.fn(),
  },
}));

vi.mock("./properties", () => ({
  default: {
    workerImageList: {} as any,
    fetchWorkerImageList: vi.fn(),
  },
}));

import toolSuggestions from "./toolSuggestions";
import main from "./index";
import properties from "./properties";
import {
  captureInterfaceScreenshot,
  captureViewportScreenshot,
  dataUrlToBase64,
} from "@/utils/interfaceCapture";
import {
  AnnotationShape,
  IDataset,
  IDatasetConfiguration,
  IDisplayLayer,
  IResolvedToolSuggestion,
  IToolConfiguration,
  IToolSuggestionCatalogEntry,
  IToolTemplate,
} from "./model";

const segmentationTemplate: IToolTemplate = {
  name: "Segmentation",
  type: "segmentation",
  description: "Run a segmentation worker.",
  interface: [
    { id: "image", name: "Docker image", type: "dockerImage", meta: {} },
    { id: "annotation", name: "Annotation", type: "annotation", meta: {} },
  ],
};

const createTemplate: IToolTemplate = {
  name: "Create",
  type: "create",
  description: "Manually draw annotations.",
  interface: [
    { id: "annotation", name: "Annotation", type: "annotation", meta: {} },
  ],
};

function makeDataset(overrides: Partial<IDataset> = {}): IDataset {
  return {
    id: "dataset-1",
    name: "Dataset",
    description: "",
    creatorId: "user-1",
    xy: [0],
    z: [0, 1],
    time: [0],
    channels: [0, 1],
    channelNames: new Map([
      [0, "DAPI"],
      [1, "GFP"],
    ]),
    width: 10,
    height: 10,
    images: () => [],
    anyImage: () => null,
    allImages: [],
    ...overrides,
  };
}

function makeLayer(overrides: Partial<IDisplayLayer> = {}): IDisplayLayer {
  return {
    id: "layer-0",
    name: "Layer 0",
    color: "#ffffff",
    channel: 0,
    xy: { type: "current", value: null },
    z: { type: "current", value: null },
    time: { type: "current", value: null },
    visible: true,
    contrast: { mode: "absolute", blackPoint: 0, whitePoint: 255 },
    layerGroup: null,
    ...overrides,
  };
}

function makeConfiguration(
  overrides: Partial<IDatasetConfiguration> = {},
): IDatasetConfiguration {
  return {
    id: "config-1",
    name: "Config",
    description: "",
    compatibility: {
      xyDimensions: "one",
      zDimensions: "one",
      tDimensions: "one",
      channels: {},
    },
    layers: [],
    tools: [],
    snapshots: [],
    propertyIds: [],
    scales: {
      pixelSize: { value: 1, unit: "µm" },
      zStep: { value: 1, unit: "µm" },
      tStep: { value: 1, unit: "s" },
    },
    ...overrides,
  };
}

function makeToolConfig(id: string): IToolConfiguration {
  return {
    id,
    name: `Tool ${id}`,
    hotkey: null,
    type: "create",
    template: createTemplate,
    values: {},
  };
}

function makeResolved(
  id: string,
  catalogEntry: IToolSuggestionCatalogEntry,
): IResolvedToolSuggestion {
  return {
    suggestion: {
      toolId: catalogEntry.id,
      reason: "reason",
      confidence: "medium",
    },
    catalogEntry,
    tool: makeToolConfig(id),
  };
}

const manualBlobEntry: IToolSuggestionCatalogEntry = {
  id: "manual:blob",
  name: "Blob",
  kind: "manual",
  description: "Manually draw blob outlines.",
  defaultShape: AnnotationShape.Polygon,
};

describe("toolSuggestions store", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
    await toolSuggestions.clear();

    Object.assign(main, {
      dataset: null,
      configuration: null,
      layers: [],
      toolTemplateList: [],
      maps: [],
      chatAPI: { getToolSuggestions: vi.fn() },
      addToolToConfiguration: vi.fn(),
      addToolsToConfiguration: vi.fn(),
    });
    Object.assign(properties, { workerImageList: {} });

    (captureInterfaceScreenshot as any).mockReset();
    (captureViewportScreenshot as any).mockReset();
    (dataUrlToBase64 as any).mockReset();
  });

  describe("maybeSuggestForCurrentConfiguration", () => {
    it("is a no-op when there is no configuration", async () => {
      main.configuration = null;
      main.dataset = makeDataset();

      await toolSuggestions.maybeSuggestForCurrentConfiguration();

      expect(main.chatAPI.getToolSuggestions).not.toHaveBeenCalled();
    });

    it("is a no-op when there is no dataset", async () => {
      main.configuration = makeConfiguration({ id: "cfg-no-dataset" });
      main.dataset = null;

      await toolSuggestions.maybeSuggestForCurrentConfiguration();

      expect(main.chatAPI.getToolSuggestions).not.toHaveBeenCalled();
    });

    it("is a no-op when the configuration already has tools", async () => {
      main.configuration = makeConfiguration({
        id: "cfg-with-tools",
        tools: [makeToolConfig("existing")],
      });
      main.dataset = makeDataset();

      await toolSuggestions.maybeSuggestForCurrentConfiguration();

      expect(main.chatAPI.getToolSuggestions).not.toHaveBeenCalled();
      expect(toolSuggestions.seenConfigurationIds).not.toContain(
        "cfg-with-tools",
      );
    });

    it("is a no-op when the configuration id was already seen this session", async () => {
      main.configuration = makeConfiguration({ id: "cfg-already-seen" });
      main.dataset = makeDataset();
      (toolSuggestions as any).markConfigurationSeen("cfg-already-seen");

      await toolSuggestions.maybeSuggestForCurrentConfiguration();

      expect(main.chatAPI.getToolSuggestions).not.toHaveBeenCalled();
    });

    it("marks the configuration seen and runs suggestForCurrentConfiguration otherwise", async () => {
      main.configuration = makeConfiguration({ id: "cfg-fresh" });
      main.dataset = makeDataset();
      (main as any).layers = [makeLayer()];
      main.toolTemplateList = [segmentationTemplate, createTemplate];
      main.maps = [{ map: {} }] as any;
      (captureInterfaceScreenshot as any).mockResolvedValue({
        data: "data:image/png;base64,AAAA",
        type: "image/png",
      });
      (captureViewportScreenshot as any).mockResolvedValue({
        data: "data:image/png;base64,AAAA",
        type: "image/png",
      });
      (dataUrlToBase64 as any).mockReturnValue({
        media_type: "image/png",
        data: "AAAA",
      });
      (main.chatAPI.getToolSuggestions as any).mockResolvedValue([]);

      await toolSuggestions.maybeSuggestForCurrentConfiguration();

      expect(toolSuggestions.seenConfigurationIds).toContain("cfg-fresh");
      expect(main.chatAPI.getToolSuggestions).toHaveBeenCalledTimes(1);
      expect(toolSuggestions.status).toBe("done");
    });

    it("un-marks the configuration seen when the request errors, so a later trigger retries", async () => {
      main.configuration = makeConfiguration({ id: "cfg-error" });
      main.dataset = makeDataset();
      (main as any).layers = [makeLayer()];
      main.toolTemplateList = [segmentationTemplate, createTemplate];
      main.maps = [{ map: {} }] as any;
      (captureInterfaceScreenshot as any).mockResolvedValue({
        data: "data:image/png;base64,AAAA",
        type: "image/png",
      });
      (captureViewportScreenshot as any).mockResolvedValue({
        data: "data:image/png;base64,AAAA",
        type: "image/png",
      });
      (dataUrlToBase64 as any).mockReturnValue({
        media_type: "image/png",
        data: "AAAA",
      });
      (main.chatAPI.getToolSuggestions as any).mockRejectedValue(
        new Error("boom"),
      );

      await toolSuggestions.maybeSuggestForCurrentConfiguration();

      expect(toolSuggestions.status).toBe("error");
      expect(toolSuggestions.seenConfigurationIds).not.toContain("cfg-error");
    });
  });

  describe("suggestForCurrentConfiguration", () => {
    beforeEach(() => {
      main.dataset = makeDataset();
      (main as any).layers = [
        makeLayer({
          id: "layer-0",
          name: "DAPI",
          channel: 0,
          color: "#007FFF",
        }),
        makeLayer({
          id: "layer-1",
          name: "GFP",
          channel: 1,
          color: "#00FF28",
        }),
      ];
      main.toolTemplateList = [segmentationTemplate, createTemplate];
      main.maps = [{ map: {} }] as any;
      properties.workerImageList = {
        "cellpose:latest": {
          isUPennContrastWorker: "true",
          isAnnotationWorker: "true",
          interfaceName: "Cellpose-SAM",
          description: "Segments nuclei.",
          annotationShape: AnnotationShape.Polygon,
        },
      };

      (captureInterfaceScreenshot as any).mockResolvedValue({
        data: "data:image/png;base64,AAAA",
        type: "image/png",
      });
      (captureViewportScreenshot as any).mockResolvedValue({
        data: "data:image/png;base64,AAAA",
        type: "image/png",
      });
      (dataUrlToBase64 as any).mockReturnValue({
        media_type: "image/png",
        data: "AAAA",
      });
      (properties.fetchWorkerImageList as any).mockClear();
    });

    it("loads the worker image list before building the catalog", async () => {
      (main.chatAPI.getToolSuggestions as any).mockResolvedValue([]);

      await toolSuggestions.suggestForCurrentConfiguration();

      expect(properties.fetchWorkerImageList).toHaveBeenCalled();
    });

    it("does not capture the full interface when the viewport screenshot succeeds", async () => {
      (main.chatAPI.getToolSuggestions as any).mockResolvedValue([]);

      await toolSuggestions.suggestForCurrentConfiguration();

      expect(captureViewportScreenshot).toHaveBeenCalled();
      expect(captureInterfaceScreenshot).not.toHaveBeenCalled();
    });

    it("falls back to an interface screenshot when no viewport screenshot is available", async () => {
      const panel = document.createElement("div");
      panel.setAttribute("data-tool-suggestions-panel", "");
      document.body.appendChild(panel);
      (captureViewportScreenshot as any).mockResolvedValue(null);
      (main.chatAPI.getToolSuggestions as any).mockResolvedValue([]);

      await toolSuggestions.suggestForCurrentConfiguration();

      expect(captureInterfaceScreenshot).toHaveBeenCalledWith(panel);
    });

    it("discards results if the configuration changed during the request", async () => {
      main.configuration = makeConfiguration({ id: "cfg-a" });
      // While the request is in flight, the user navigates to another
      // collection; the resolved suggestions must be dropped.
      (main.chatAPI.getToolSuggestions as any).mockImplementation(async () => {
        main.configuration = makeConfiguration({ id: "cfg-b" });
        return [{ toolId: "manual:blob", reason: "blobs", confidence: "high" }];
      });

      await toolSuggestions.suggestForCurrentConfiguration();

      expect(toolSuggestions.status).toBe("idle");
      expect(toolSuggestions.suggestions).toHaveLength(0);
    });

    it("sets status loading then done, and resolves suggestions from the catalog", async () => {
      (main.chatAPI.getToolSuggestions as any).mockResolvedValue([
        {
          toolId: "worker:cellpose:latest",
          channelName: "DAPI",
          reason: "Looks like nuclei",
          confidence: "high",
        },
        {
          toolId: "manual:blob",
          channelName: "GFP",
          reason: "Looks like blobs",
          confidence: "medium",
        },
      ]);

      const promise = toolSuggestions.suggestForCurrentConfiguration();
      expect(toolSuggestions.status).toBe("loading");

      await promise;

      expect(toolSuggestions.status).toBe("done");
      expect(toolSuggestions.suggestions).toHaveLength(2);

      const workerResolved = toolSuggestions.suggestions.find(
        (resolved) => resolved.catalogEntry.kind === "worker",
      );
      expect(workerResolved).toBeDefined();
      expect(workerResolved!.tool.type).toBe("segmentation");
      expect(workerResolved!.tool.name).toBe("DAPI Cellpose-SAM");
      expect(workerResolved!.tool.values.image.image).toBe("cellpose:latest");
      expect(
        workerResolved!.tool.template.interface.some(
          (elem) => elem.type === "dockerImage",
        ),
      ).toBe(false);
      expect(
        workerResolved!.tool.values.annotation.coordinateAssignments.layer,
      ).toBe("layer-0");

      const blobResolved = toolSuggestions.suggestions.find(
        (resolved) => resolved.catalogEntry.kind === "manual",
      );
      expect(blobResolved).toBeDefined();
      expect(blobResolved!.tool.type).toBe("create");
      expect(blobResolved!.tool.name).toBe("GFP Blob");
      expect(
        blobResolved!.tool.values.annotation.coordinateAssignments.layer,
      ).toBe("layer-1");
      expect(blobResolved!.tool.values.image).toBeUndefined();

      // Catalog + channels sent to the backend.
      const callArgs = (main.chatAPI.getToolSuggestions as any).mock
        .calls[0][0];
      expect(callArgs.channels).toEqual(["DAPI", "GFP"]);
      expect(callArgs.layers).toEqual([
        {
          id: "layer-0",
          name: "DAPI",
          channel: 0,
          channelName: "DAPI",
          color: "#007FFF",
          visible: true,
        },
        {
          id: "layer-1",
          name: "GFP",
          channel: 1,
          channelName: "GFP",
          color: "#00FF28",
          visible: true,
        },
      ]);
      expect(callArgs.catalog.map((entry: any) => entry.id)).toEqual(
        expect.arrayContaining(["manual:blob", "worker:cellpose:latest"]),
      );
      expect(callArgs.images).toHaveLength(1);
    });

    it("resolves synthetic Channel N names for unnamed channels", async () => {
      main.dataset = makeDataset({
        channels: [0, 3],
        channelNames: new Map([[0, "DAPI"]]),
      });
      (main as any).layers = [
        makeLayer({
          id: "layer-3",
          name: "Channel 3",
          channel: 3,
          color: "#FFFF00",
        }),
      ];
      (main.chatAPI.getToolSuggestions as any).mockResolvedValue([
        {
          toolId: "manual:blob",
          channelName: "Channel 3",
          reason: "Looks like blobs",
          confidence: "medium",
        },
      ]);

      await toolSuggestions.suggestForCurrentConfiguration();

      expect(toolSuggestions.suggestions).toHaveLength(1);
      expect(toolSuggestions.suggestions[0].tool.name).toBe("Channel 3 Blob");
      expect(
        toolSuggestions.suggestions[0].tool.values.annotation
          .coordinateAssignments.layer,
      ).toBe("layer-3");
      const callArgs = (main.chatAPI.getToolSuggestions as any).mock
        .calls[0][0];
      expect(callArgs.layers).toEqual([
        {
          id: "layer-3",
          name: "Channel 3",
          channel: 3,
          channelName: "Channel 3",
          color: "#FFFF00",
          visible: true,
        },
      ]);
    });

    it("drops suggestions that don't match any catalog entry", async () => {
      (main.chatAPI.getToolSuggestions as any).mockResolvedValue([
        { toolId: "worker:unknown-image", reason: "?", confidence: "low" },
      ]);

      await toolSuggestions.suggestForCurrentConfiguration();

      expect(toolSuggestions.status).toBe("done");
      expect(toolSuggestions.suggestions).toHaveLength(0);
    });

    it("sets status to error when the API call throws", async () => {
      (main.chatAPI.getToolSuggestions as any).mockRejectedValue(
        new Error("network down"),
      );

      await toolSuggestions.suggestForCurrentConfiguration();

      expect(toolSuggestions.status).toBe("error");
      expect(toolSuggestions.errorMessage).toBe(
        "Failed to get tool suggestions.",
      );
    });

    it("sets status to error when no screenshot could be captured", async () => {
      (captureInterfaceScreenshot as any).mockResolvedValue(null);
      (captureViewportScreenshot as any).mockResolvedValue(null);

      await toolSuggestions.suggestForCurrentConfiguration();

      expect(toolSuggestions.status).toBe("error");
      expect(main.chatAPI.getToolSuggestions).not.toHaveBeenCalled();
    });

    it("is a no-op when there is no dataset", async () => {
      main.dataset = null;

      await toolSuggestions.suggestForCurrentConfiguration();

      expect(main.chatAPI.getToolSuggestions).not.toHaveBeenCalled();
      expect(toolSuggestions.status).toBe("idle");
    });
  });

  describe("acceptSuggestion / acceptAllSuggestions", () => {
    it("acceptSuggestion adds the tool to the configuration and removes it from suggestions", async () => {
      const resolvedA = makeResolved("tool-a", manualBlobEntry);
      const resolvedB = makeResolved("tool-b", manualBlobEntry);
      (toolSuggestions as any).setSuggestions([resolvedA, resolvedB]);

      await toolSuggestions.acceptSuggestion(resolvedA);

      expect(main.addToolToConfiguration).toHaveBeenCalledWith(resolvedA.tool);
      expect(toolSuggestions.suggestions).toHaveLength(1);
      expect(toolSuggestions.suggestions[0].tool.id).toBe("tool-b");
    });

    it("acceptAllSuggestions adds every suggestion in one batch and clears the list", async () => {
      const resolvedA = makeResolved("tool-a", manualBlobEntry);
      const resolvedB = makeResolved("tool-b", manualBlobEntry);
      (toolSuggestions as any).setSuggestions([resolvedA, resolvedB]);

      await toolSuggestions.acceptAllSuggestions();

      // Single batched call, not one sync per tool.
      expect(main.addToolsToConfiguration).toHaveBeenCalledTimes(1);
      expect(main.addToolsToConfiguration).toHaveBeenCalledWith([
        resolvedA.tool,
        resolvedB.tool,
      ]);
      expect(toolSuggestions.suggestions).toHaveLength(0);
    });
  });

  describe("clear", () => {
    it("resets status, suggestions, errorMessage, and dismissed", async () => {
      const resolved = makeResolved("tool-a", manualBlobEntry);
      (toolSuggestions as any).setSuggestions([resolved]);
      (toolSuggestions as any).setStatus("error");
      (toolSuggestions as any).setErrorMessage("oops");
      toolSuggestions.setDismissed(true);

      await toolSuggestions.clear();

      expect(toolSuggestions.suggestions).toHaveLength(0);
      expect(toolSuggestions.status).toBe("idle");
      expect(toolSuggestions.errorMessage).toBeNull();
      expect(toolSuggestions.dismissed).toBe(false);
    });
  });
});

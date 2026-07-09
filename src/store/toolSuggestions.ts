import {
  VuexModule,
  Module,
  Mutation,
  Action,
  getModule,
} from "vuex-module-decorators";
import { v4 as uuidv4 } from "uuid";
import { logError } from "@/utils/log";
import store from "./root";
import main from "./index";
import properties from "./properties";
import {
  AnnotationShape,
  IResolvedToolSuggestion,
  IToolConfiguration,
  IToolSuggestion,
  IToolSuggestionCatalogEntry,
  IToolSuggestionLayerContext,
  IToolTemplate,
  TToolSuggestionStatus,
} from "./model";
import { IAnnotationSetup } from "@/tools/creation/templates/AnnotationConfiguration.vue";
import {
  captureInterfaceScreenshot,
  captureViewportScreenshot,
  dataUrlToBase64,
} from "@/utils/interfaceCapture";

// Feature flag. The whole flow is a first pass (see
// codebaseDocumentation/AUTO_TOOL_SUGGESTIONS.md); keep it easy to disable
// while it is being refined.
const AUTO_SUGGEST_ENABLED = true;
const TOOL_SUGGESTIONS_PANEL_SELECTOR = "[data-tool-suggestions-panel]";

// Manual (non-worker) tools we can offer. Currently just a blob tool, matching
// the "suggest a blob tool if you see blobs" requirement.
const MANUAL_CATALOG: IToolSuggestionCatalogEntry[] = [
  {
    id: "manual:blob",
    name: "Blob",
    kind: "manual",
    description: "Manually draw blob (polygon) outlines around objects.",
    defaultShape: AnnotationShape.Polygon,
  },
];

function buildDefaultCoordinateAssignments(
  layerId?: string,
): IAnnotationSetup["coordinateAssignments"] {
  return {
    layer: layerId,
    Z: { type: "layer", value: 1, max: (main.dataset?.z.length || 0) + 1 },
    Time: {
      type: "layer",
      value: 1,
      max: (main.dataset?.time.length || 0) + 1,
    },
  };
}

function getToolSuggestionsPanel(): HTMLElement | null {
  if (typeof document === "undefined") {
    return null;
  }
  return document.querySelector(TOOL_SUGGESTIONS_PANEL_SELECTOR);
}

// Resolve a channel name (as the model referred to it) to a configuration
// layer id, so a suggested tool runs on the right channel.
function layerIdForChannelName(channelName?: string): string | undefined {
  if (!channelName || !main.dataset) {
    return undefined;
  }
  const trimmedChannelName = channelName.trim();
  for (const layer of main.layers) {
    const resolvedChannelName =
      main.dataset.channelNames.get(layer.channel) ||
      `Channel ${layer.channel}`;
    if (resolvedChannelName === trimmedChannelName) {
      return layer.id;
    }
  }
  return undefined;
}

function buildAnnotationSetup(
  shape: AnnotationShape,
  layerId?: string,
): IAnnotationSetup {
  return {
    tags: [],
    coordinateAssignments: buildDefaultCoordinateAssignments(layerId),
    shape,
    color: undefined,
  };
}

function toolNameForSuggestion(
  entry: IToolSuggestionCatalogEntry,
  suggestion: IToolSuggestion,
  layerId?: string,
) {
  const baseName = entry.name.trim();
  const channelName = suggestion.channelName?.trim();
  if (!channelName || !layerId) {
    return baseName;
  }
  if (baseName.toLowerCase().startsWith(`${channelName.toLowerCase()} `)) {
    return baseName;
  }
  return `${channelName} ${baseName}`;
}

// Build a concrete IToolConfiguration from a catalog entry + suggestion, using
// the same templates the manual tool-creation UI uses.
function buildToolConfiguration(
  entry: IToolSuggestionCatalogEntry,
  suggestion: IToolSuggestion,
): IToolConfiguration | null {
  const templates = main.toolTemplateList as IToolTemplate[];
  const layerId = layerIdForChannelName(suggestion.channelName);
  const shape = entry.defaultShape ?? AnnotationShape.Point;
  const annotationSetup = buildAnnotationSetup(shape, layerId);
  const toolName = toolNameForSuggestion(entry, suggestion, layerId);

  if (entry.kind === "worker") {
    const template = templates.find((t) => t.type === "segmentation");
    if (!template || !entry.image) {
      return null;
    }
    // Mirror ToolTypeSelection: drop the dockerImage submenu element and seed
    // the image into values.
    const computedTemplate: IToolTemplate = {
      ...template,
      interface: template.interface.filter(
        (elem) => elem.type !== "dockerImage",
      ),
    };
    return {
      id: uuidv4(),
      name: toolName,
      hotkey: null,
      type: "segmentation",
      template: computedTemplate,
      values: {
        image: { image: entry.image },
        annotation: annotationSetup,
        jobDateTag: false,
      },
    };
  }

  // Manual blob tool.
  const template = templates.find((t) => t.type === "create");
  if (!template) {
    return null;
  }
  return {
    id: uuidv4(),
    name: toolName,
    hotkey: null,
    type: "create",
    template,
    values: {
      annotation: annotationSetup,
    },
  };
}

// Build the catalog of tools we can set up for the current dataset from the
// registered worker images plus the fixed manual tools.
function buildCatalog(): IToolSuggestionCatalogEntry[] {
  const catalog: IToolSuggestionCatalogEntry[] = [...MANUAL_CATALOG];
  const workerImages = properties.workerImageList;
  for (const image in workerImages) {
    const labels = workerImages[image];
    if (labels.isAnnotationWorker === undefined) {
      continue;
    }
    catalog.push({
      id: `worker:${image}`,
      name: labels.interfaceName || image,
      kind: "worker",
      description: labels.description || "",
      image,
      defaultShape: labels.annotationShape ?? AnnotationShape.Point,
    });
  }
  return catalog;
}

function buildLayerContext(): IToolSuggestionLayerContext[] {
  const dataset = main.dataset;
  if (!dataset) {
    return [];
  }
  return main.layers.map((layer) => ({
    id: layer.id,
    name: layer.name,
    channel: layer.channel,
    channelName:
      dataset.channelNames.get(layer.channel) || `Channel ${layer.channel}`,
    color: layer.color,
    visible: layer.visible,
  }));
}

@Module({ dynamic: true, store, name: "toolSuggestions" })
export class ToolSuggestions extends VuexModule {
  status: TToolSuggestionStatus = "idle";
  suggestions: IResolvedToolSuggestion[] = [];
  errorMessage: string | null = null;
  // Configuration ids we have already run suggestions for, so opening the same
  // collection twice in one session doesn't re-prompt.
  seenConfigurationIds: string[] = [];
  dismissed: boolean = false;

  @Mutation
  private setStatus(status: TToolSuggestionStatus) {
    this.status = status;
  }

  @Mutation
  private setSuggestions(suggestions: IResolvedToolSuggestion[]) {
    this.suggestions = suggestions;
  }

  @Mutation
  private setErrorMessage(message: string | null) {
    this.errorMessage = message;
  }

  @Mutation
  private markConfigurationSeen(configurationId: string) {
    if (!this.seenConfigurationIds.includes(configurationId)) {
      this.seenConfigurationIds.push(configurationId);
    }
  }

  @Mutation
  private unmarkConfigurationSeen(configurationId: string) {
    this.seenConfigurationIds = this.seenConfigurationIds.filter(
      (id) => id !== configurationId,
    );
  }

  @Mutation
  setDismissed(value: boolean) {
    this.dismissed = value;
  }

  @Mutation
  removeSuggestionByToolId(toolId: string) {
    this.suggestions = this.suggestions.filter((s) => s.tool.id !== toolId);
  }

  @Action
  clear() {
    this.setSuggestions([]);
    this.setStatus("idle");
    this.setErrorMessage(null);
    this.setDismissed(false);
  }

  // Run suggestions for the current configuration if it looks like a freshly
  // opened collection: it exists, has no tools yet, and we haven't already
  // suggested for it this session. Safe to call on every configuration change.
  @Action
  async maybeSuggestForCurrentConfiguration() {
    if (!AUTO_SUGGEST_ENABLED) {
      return;
    }
    const configuration = main.configuration;
    if (!configuration || !main.dataset) {
      return;
    }
    if (configuration.tools.length > 0) {
      return;
    }
    if (this.seenConfigurationIds.includes(configuration.id)) {
      return;
    }
    // Mark seen before the async call so a second layers-ready doesn't kick
    // off a duplicate request. If the request fails, un-mark it so a later
    // layers-ready can retry.
    this.markConfigurationSeen(configuration.id);
    await this.suggestForCurrentConfiguration();
    if (this.status === "error") {
      this.unmarkConfigurationSeen(configuration.id);
    }
  }

  // Capture screenshots, ask the backend, and resolve suggestions into
  // ready-to-add tool configurations.
  @Action
  async suggestForCurrentConfiguration() {
    if (!main.dataset) {
      return;
    }
    // Remember which configuration this run is for, so we can discard the
    // result if the user navigates to a different collection mid-request.
    const startConfigurationId = main.configuration?.id ?? null;
    this.setDismissed(false);
    this.setErrorMessage(null);
    this.setStatus("loading");
    this.setSuggestions([]);
    try {
      // The worker image list is otherwise only loaded by the tool-picker /
      // worker-menu UI. On a first open the user hasn't touched those, so
      // ensure it's populated here — otherwise the catalog would contain only
      // manual tools and could never suggest Cellpose/Piscis/etc.
      await properties.fetchWorkerImageList();

      const map = main.maps[0]?.map;
      const viewportShot = await captureViewportScreenshot(map);
      // Tool suggestions only need the rendered image. Avoid html2canvas's
      // full-DOM clone in the common case because browser extensions can inject
      // unsupported CSS into that clone and spam the console. Keep a fallback
      // for unusual cases where GeoJS can't produce a viewport screenshot.
      const interfaceShot = viewportShot
        ? null
        : await captureInterfaceScreenshot(getToolSuggestionsPanel());

      const images: { media_type: string; data: string }[] = [];
      for (const shot of [viewportShot, interfaceShot]) {
        if (!shot) {
          continue;
        }
        const parsed = dataUrlToBase64(shot.data);
        if (parsed) {
          images.push(parsed);
        }
      }
      if (images.length === 0) {
        this.setStatus("error");
        this.setErrorMessage("Could not capture a screenshot of the dataset.");
        return;
      }

      const catalog = buildCatalog();
      const currentDataset = main.dataset;
      if (!currentDataset) {
        this.setStatus("idle");
        this.setSuggestions([]);
        return;
      }
      const channels = [...currentDataset.channelNames.values()];
      const layers = buildLayerContext();

      const rawSuggestions: IToolSuggestion[] =
        await main.chatAPI.getToolSuggestions({
          images,
          catalog,
          channels,
          layers,
        });

      // If the user switched collections while the request was in flight,
      // discard the result: it was computed for the old configuration's
      // channels/layers and must not be applied to the new one.
      if ((main.configuration?.id ?? null) !== startConfigurationId) {
        this.setStatus("idle");
        this.setSuggestions([]);
        return;
      }

      const catalogById = new Map(catalog.map((entry) => [entry.id, entry]));
      const resolved: IResolvedToolSuggestion[] = [];
      for (const suggestion of rawSuggestions) {
        const entry = catalogById.get(suggestion.toolId);
        if (!entry) {
          continue;
        }
        const tool = buildToolConfiguration(entry, suggestion);
        if (!tool) {
          continue;
        }
        resolved.push({ suggestion, catalogEntry: entry, tool });
      }

      this.setSuggestions(resolved);
      this.setStatus("done");
    } catch (error) {
      logError("Failed to get tool suggestions:", error);
      this.setStatus("error");
      this.setErrorMessage(
        typeof error === "string" ? error : "Failed to get tool suggestions.",
      );
    }
  }

  // Add a single suggested tool to the current configuration.
  @Action
  acceptSuggestion(resolved: IResolvedToolSuggestion) {
    main.addToolToConfiguration(resolved.tool);
    this.removeSuggestionByToolId(resolved.tool.id);
  }

  // Add all remaining suggested tools in a single configuration sync.
  @Action
  async acceptAllSuggestions() {
    const tools = this.suggestions.map((resolved) => resolved.tool);
    if (tools.length > 0) {
      main.addToolsToConfiguration(tools);
    }
    this.setSuggestions([]);
  }
}

export default getModule(ToolSuggestions);

// Self-accept HMR to prevent vuex-module-decorators from re-registering
// the dynamic module (which causes duplicate getters and state overwrites).
if (import.meta.hot) {
  import.meta.hot.accept();
}

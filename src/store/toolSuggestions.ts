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

// Resolve a channel name (as the model referred to it) to a configuration
// layer id, so a suggested tool runs on the right channel.
function layerIdForChannelName(channelName?: string): string | undefined {
  if (!channelName || !main.dataset) {
    return undefined;
  }
  let matchChannel: number | undefined;
  for (const [channel, name] of main.dataset.channelNames.entries()) {
    if (name === channelName) {
      matchChannel = channel;
      break;
    }
  }
  if (matchChannel === undefined) {
    return undefined;
  }
  return main.layers.find((layer) => layer.channel === matchChannel)?.id;
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
      name: entry.name,
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
    name: entry.name,
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
    this.markConfigurationSeen(configuration.id);
    await this.suggestForCurrentConfiguration();
  }

  // Capture screenshots, ask the backend, and resolve suggestions into
  // ready-to-add tool configurations.
  @Action
  async suggestForCurrentConfiguration() {
    if (!main.dataset) {
      return;
    }
    this.setDismissed(false);
    this.setErrorMessage(null);
    this.setStatus("loading");
    this.setSuggestions([]);
    try {
      const map = main.maps[0]?.map;
      const [interfaceShot, viewportShot] = await Promise.all([
        captureInterfaceScreenshot(),
        captureViewportScreenshot(map),
      ]);

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
      const channels = main.dataset
        ? [...main.dataset.channelNames.values()]
        : [];

      const rawSuggestions: IToolSuggestion[] =
        await main.chatAPI.getToolSuggestions({ images, catalog, channels });

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

  // Add all remaining suggested tools.
  @Action
  async acceptAllSuggestions() {
    const toAdd = [...this.suggestions];
    for (const resolved of toAdd) {
      main.addToolToConfiguration(resolved.tool);
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

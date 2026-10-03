import { v4 as uuidv4 } from "uuid";
import main from "@/store";
import properties from "@/store/properties";
import {
  AnnotationShape,
  IToolConfiguration,
  IToolSuggestionCatalogEntry,
  IToolTemplate,
  IWorkerInterfaceValues,
} from "@/store/model";
import { IAnnotationSetup } from "@/tools/creation/templates/AnnotationConfiguration.vue";

// Shared tool-construction logic: build a concrete IToolConfiguration from a
// creatable-tool catalog entry, using the same templates the manual
// tool-creation UI uses. Used by both the auto tool-suggestion flow
// (store/toolSuggestions.ts) and the AI-panel agent's create_tool executor
// (agent/executors.ts), so the two paths stay in sync.

// Manual (non-worker) tools the app can set up. The blob (polygon) tool is the
// original suggestion target; point and line round out the common hand-drawn
// shapes the agent can create on request.
export const MANUAL_CATALOG: IToolSuggestionCatalogEntry[] = [
  {
    id: "manual:blob",
    name: "Blob",
    kind: "manual",
    description: "Manually draw blob (polygon) outlines around objects.",
    defaultShape: AnnotationShape.Polygon,
  },
  {
    id: "manual:point",
    name: "Point",
    kind: "manual",
    description: "Manually place point annotations.",
    defaultShape: AnnotationShape.Point,
  },
  {
    id: "manual:line",
    name: "Line",
    kind: "manual",
    description: "Manually draw line annotations.",
    defaultShape: AnnotationShape.Line,
  },
];

// Exported for reuse by the pipeline builder (PipelineEditor.vue), which also
// creates annotation setups programmatically and needs dataset-derived Z/Time
// maxima (a hardcoded max would break the step editor's "Assign" validation,
// whose rule is `value < max`).
export function buildDefaultCoordinateAssignments(
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

// Resolve a channel name (as the model or a suggestion referred to it) to a
// configuration layer id, so a created tool runs on the right channel.
export function layerIdForChannelName(
  channelName?: string,
): string | undefined {
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
  tags: string[] = [],
): IAnnotationSetup {
  return {
    tags,
    coordinateAssignments: buildDefaultCoordinateAssignments(layerId),
    shape,
    color: undefined,
  };
}

// Prefix the tool name with the channel name (e.g. "DAPI Blob") when the tool
// is bound to a resolved channel and not already prefixed.
function channelPrefixedName(
  baseName: string,
  channelName?: string,
  layerId?: string,
): string {
  const base = baseName.trim();
  const channel = channelName?.trim();
  if (!channel || !layerId) {
    return base;
  }
  if (base.toLowerCase().startsWith(`${channel.toLowerCase()} `)) {
    return base;
  }
  return `${channel} ${base}`;
}

export interface IBuildToolOptions {
  // Channel name to bind the tool to (resolved to a layer if it matches).
  channelName?: string;
  // Explicit tool name; defaults to a channel-prefixed catalog name.
  name?: string;
  // Tags applied to annotations the tool creates.
  tags?: string[];
  // Worker parameter values saved with the tool (worker entries only); read
  // back by run_worker and submitAnnotationWorkerJob as the saved values.
  workerInterfaceValues?: IWorkerInterfaceValues;
}

// Build a concrete IToolConfiguration from a catalog entry.
export function buildToolConfiguration(
  entry: IToolSuggestionCatalogEntry,
  options: IBuildToolOptions = {},
): IToolConfiguration | null {
  const templates = main.toolTemplateList as IToolTemplate[];
  const layerId = layerIdForChannelName(options.channelName);
  const shape = entry.defaultShape ?? AnnotationShape.Point;
  const annotationSetup = buildAnnotationSetup(shape, layerId, options.tags);
  const toolName =
    options.name ??
    channelPrefixedName(entry.name, options.channelName, layerId);

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
        ...(options.workerInterfaceValues
          ? { workerInterfaceValues: options.workerInterfaceValues }
          : {}),
      },
    };
  }

  // Manual tool (blob / point / line).
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

// Build the catalog of tools that can be set up for the current dataset from
// the registered annotation-worker images plus the fixed manual tools.
export function buildCatalog(): IToolSuggestionCatalogEntry[] {
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

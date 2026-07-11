import main from "@/store";
import annotationStore from "@/store/annotation";
import filterStore from "@/store/filters";
import propertyStore from "@/store/properties";
import jobsStore from "@/store/jobs";
import volumeViewStore from "@/store/volumeView";
import {
  AnnotationShape,
  IAnnotation,
  IChatImage,
  IContrast,
  IDisplayLayer,
  IErrorInfoList,
  IProgressInfo,
  IPropertyAnnotationFilter,
  IScaleInformation,
  IToolConfiguration,
  IWorkerInterfaceValues,
  PropertyFilterMode,
  TLayerMode,
  TUnitLength,
  TUnitTime,
} from "@/store/model";
import {
  captureInterfaceScreenshot,
  captureViewportScreenshot,
} from "@/utils/interfaceCapture";
import { getDefault } from "@/utils/workerInterface";
import {
  MANUAL_CATALOG,
  buildCatalog,
  buildToolConfiguration,
  layerIdForChannelName,
} from "@/tools/creation/toolFromCatalog";

// Executors for the AI-panel agent tools (see
// codebaseDocumentation/AI_PANEL_SPEC.md). Each executor is a thin wrapper
// around existing store actions — the agent can only do what a user could do
// by clicking. Tool schemas live in
// devops/girder/plugins/girder-claude-chat/agent_tools.json; the names here
// must match them.

export interface IAgentToolContext {
  // Element excluded from interface screenshots (the panel itself)
  panelElement: HTMLElement | null;
  // Append an informational note to the panel transcript, used for events
  // that happen after the tool call returned (e.g. worker job completion)
  notify: (text: string) => void;
}

export interface IToolExecutionResult {
  // JSON-serializable payload sent back to the model as a text block
  result: any;
  // Optional images sent back as image blocks (screenshots)
  images?: IChatImage[];
}

// Above this many matching annotations, list_annotations returns a hint
// steering the model toward get_annotation_summary rather than paging through
// (and echoing back) the whole set. Purely advisory — the data is unchanged.
const LARGE_ANNOTATION_RESULT = 200;

// Thrown by executors for expected failures (bad references, missing
// dataset). The message is sent to the model as an error tool result so it
// can correct its call.
export class ToolExecutionError extends Error {}

interface IAnnotationQuery {
  tags?: string[];
  exclusive?: boolean;
  shape?: string;
  channel?: number;
  currentFrameOnly?: boolean;
  ids?: string[];
}

type TAnnotationTarget = "selection" | IAnnotationQuery;

function requireDataset() {
  if (!main.dataset) {
    throw new ToolExecutionError("No dataset is currently open in the viewer");
  }
  return main.dataset;
}

// Mutating tools that sync configuration or hit the backend silently no-op
// when logged out; fail loudly instead so the model doesn't report success
// for a skipped operation.
function requireLogin() {
  if (!main.isLoggedIn) {
    throw new ToolExecutionError("This action requires being logged in");
  }
}

function resolveLayer(ref: string): IDisplayLayer {
  const layers = main.layers;
  const layer =
    layers.find((l) => l.id === ref) ??
    layers.find((l) => l.name.toLowerCase() === ref.toLowerCase());
  if (!layer) {
    const available = layers.map((l) => `${l.name} (${l.id})`).join(", ");
    throw new ToolExecutionError(
      `No layer with id or name "${ref}". Available layers: ${available}`,
    );
  }
  return layer;
}

function queryAnnotations(query: IAnnotationQuery = {}): IAnnotation[] {
  let annotations = annotationStore.annotations;
  if (query.ids) {
    const ids = new Set(query.ids);
    annotations = annotations.filter((a) => ids.has(a.id));
  }
  if (query.tags?.length) {
    const tags = query.tags;
    annotations = annotations.filter((a) =>
      query.exclusive
        ? tags.every((tag) => a.tags.includes(tag))
        : tags.some((tag) => a.tags.includes(tag)),
    );
  }
  if (query.shape) {
    annotations = annotations.filter((a) => a.shape === query.shape);
  }
  if (query.channel != null) {
    annotations = annotations.filter((a) => a.channel === query.channel);
  }
  if (query.currentFrameOnly) {
    const { xy, z, time } = main;
    annotations = annotations.filter(
      (a) =>
        a.location.XY === xy && a.location.Z === z && a.location.Time === time,
    );
  }
  return annotations;
}

// Model tool inputs are not schema-enforced at runtime. Validate an annotation
// query so a malformed one can't silently fall through to the empty (match-all)
// query — which for destructive tools (color/tag) would edit every annotation.
function validateAnnotationQuery(query: { [key: string]: unknown }) {
  for (const [key, value] of Object.entries(query)) {
    switch (key) {
      case "ids":
      case "tags":
        if (
          !Array.isArray(value) ||
          value.some((item) => typeof item !== "string")
        ) {
          throw new ToolExecutionError(
            `query.${key} must be an array of strings`,
          );
        }
        break;
      case "exclusive":
      case "currentFrameOnly":
        if (typeof value !== "boolean") {
          throw new ToolExecutionError(`query.${key} must be a boolean`);
        }
        break;
      case "shape":
        if (typeof value !== "string") {
          throw new ToolExecutionError("query.shape must be a string");
        }
        break;
      case "channel":
        if (typeof value !== "number") {
          throw new ToolExecutionError("query.channel must be a number");
        }
        break;
      default:
        throw new ToolExecutionError(`Unknown query field "${key}"`);
    }
  }
}

// Resolve an edit target to concrete annotation ids. `target` comes straight
// from the model, so reject anything that isn't the string "selection" or a
// valid query object rather than defaulting a missing/garbage target to "all".
function resolveAnnotationTargetIds(target: unknown): string[] {
  if (target === "selection") {
    return [...annotationStore.selectedAnnotationIds];
  }
  if (target === null || typeof target !== "object" || Array.isArray(target)) {
    throw new ToolExecutionError(
      'target must be "selection" or a query object (e.g. ' +
        '{"tags":["nucleus"]}); refusing to default to all annotations',
    );
  }
  validateAnnotationQuery(target as { [key: string]: unknown });
  return queryAnnotations(target as IAnnotationQuery).map((a) => a.id);
}

// Resolve the parameter values for a worker image: fetch its interface, reject
// any override key that isn't a real parameter, then fill each parameter from
// the override, else a saved value, else the interface default. Shared by
// run_worker and create_property.
async function resolveWorkerInterfaceValues(
  image: string,
  overrides: IWorkerInterfaceValues = {},
  saved: IWorkerInterfaceValues = {},
): Promise<IWorkerInterfaceValues> {
  if (!propertyStore.getWorkerInterface(image)) {
    await propertyStore.fetchWorkerInterface({ image });
  }
  const workerInterface = propertyStore.getWorkerInterface(image) ?? {};
  const unknownKeys = Object.keys(overrides).filter(
    (key) => !(key in workerInterface),
  );
  if (unknownKeys.length > 0) {
    throw new ToolExecutionError(
      `Unknown worker parameters: ${unknownKeys.join(", ")}. ` +
        `Valid parameters: ${Object.keys(workerInterface).join(", ")}`,
    );
  }
  const values: IWorkerInterfaceValues = {};
  for (const id in workerInterface) {
    if (id in overrides) {
      values[id] = overrides[id];
    } else if (id in saved) {
      values[id] = saved[id];
    } else {
      values[id] = getDefault(
        workerInterface[id].type,
        workerInterface[id].default,
      );
    }
  }
  return values;
}

// The viewer display options the agent can toggle (all local view state,
// captured in the per-turn snapshot so "revert view changes" restores them).
function currentDisplayOptions() {
  return {
    drawAnnotations: main.drawAnnotations,
    annotationOpacity: main.annotationOpacity,
    showScalebar: main.showScalebar,
    scalebarColor: main.scalebarColor,
    backgroundColor: main.backgroundColor,
    drawAnnotationConnections: main.drawAnnotationConnections,
  };
}

// Axis-aligned bounding box (in image-pixel coordinates) of the given
// annotations, padded by a fraction of its span with a minimum absolute pad
// (so a single point still frames sensibly). Returns null if there are no
// coordinates. Pure — the GeoJS camera application lives in the executor.
export function annotationsBoundingBox(
  annotations: IAnnotation[],
  padFraction = 0,
  minPad = 0,
): { left: number; top: number; right: number; bottom: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const annotation of annotations) {
    for (const point of annotation.coordinates) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  }
  if (!Number.isFinite(minX)) {
    return null;
  }
  const padX = Math.max((maxX - minX) * padFraction, minPad);
  const padY = Math.max((maxY - minY) * padFraction, minPad);
  return {
    left: minX - padX,
    top: minY - padY,
    right: maxX + padX,
    bottom: maxY + padY,
  };
}

function countBy<T>(items: T[], key: (item: T) => string | string[]) {
  const counts: { [key: string]: number } = {};
  for (const item of items) {
    const keys = key(item);
    for (const k of Array.isArray(keys) ? keys : [keys]) {
      counts[k] = (counts[k] || 0) + 1;
    }
  }
  return counts;
}

// Also injected into the first user message of each agent turn (cheap
// textual grounding, see AI_PANEL_SPEC.md §4)
export function buildInterfaceState() {
  const dataset = main.dataset;
  const configuration = main.configuration;
  return {
    dataset: dataset
      ? {
          id: dataset.id,
          name: dataset.name,
          size: {
            xy: dataset.xy.length,
            z: dataset.z.length,
            time: dataset.time.length,
            channels: dataset.channels.length,
          },
          width: dataset.width,
          height: dataset.height,
          channelNames: dataset.channels.map((channel) => ({
            channel,
            name: dataset.channelNames.get(channel) ?? `Channel ${channel}`,
          })),
        }
      : null,
    collection: configuration
      ? { id: configuration.id, name: configuration.name }
      : null,
    location: { xy: main.xy, z: main.z, time: main.time },
    layerMode: main.layerMode,
    unroll: { xy: main.unrollXY, z: main.unrollZ, t: main.unrollT },
    camera: {
      center: main.cameraInfo.center,
      zoom: main.cameraInfo.zoom,
      rotate: main.cameraInfo.rotate,
    },
    layers: main.layers.map((layer) => ({
      id: layer.id,
      name: layer.name,
      channel: layer.channel,
      color: layer.color,
      visible: layer.visible,
      contrast: layer.contrast,
    })),
    tools: main.tools.map((tool) => ({
      id: tool.id,
      name: tool.name,
      type: tool.type,
      workerImage: tool.values?.image?.image ?? null,
    })),
    selectedToolId: main.selectedTool?.configuration.id ?? null,
    annotationFilter: {
      tagFilter: {
        enabled: filterStore.tagFilter.enabled,
        tags: filterStore.tagFilter.tags,
        exclusive: filterStore.tagFilter.exclusive,
      },
      currentFrameOnly: filterStore.onlyCurrentFrame,
    },
    annotations: {
      total: annotationStore.annotations.length,
      filtered: filterStore.filteredAnnotations.length,
      selected: annotationStore.selectedAnnotationIds.size,
      tags: [...annotationStore.annotationTags],
    },
  };
}

function clamp(value: number, max: number) {
  return Math.max(0, Math.min(value, Math.max(0, max - 1)));
}

async function runWorkerTool(
  input: { toolId: string; workerInterfaceValues?: IWorkerInterfaceValues },
  context: IAgentToolContext,
): Promise<IToolExecutionResult> {
  requireLogin();
  requireDataset();
  const tool: IToolConfiguration | undefined = main.tools.find(
    (t) => t.id === input.toolId,
  );
  const runningJobId = tool && jobsStore.jobIdForToolId[tool.id];
  if (runningJobId) {
    return {
      result: {
        started: false,
        alreadyRunning: true,
        jobId: runningJobId,
        note:
          `A job for tool "${tool.name}" is already running. Wait for its ` +
          "completion note in the transcript before starting another run.",
      },
    };
  }
  if (!tool) {
    const workerTools = main.tools
      .filter((t) => t.values?.image?.image)
      .map((t) => `${t.name} (${t.id})`)
      .join(", ");
    throw new ToolExecutionError(
      `No tool with id "${input.toolId}". Worker tools in this collection: ${
        workerTools || "none — the user needs to add one to the toolset first"
      }`,
    );
  }
  const image: string | undefined = tool.values?.image?.image;
  if (!image) {
    throw new ToolExecutionError(
      `Tool "${tool.name}" is not a worker tool and cannot be run this way`,
    );
  }

  const values = await resolveWorkerInterfaceValues(
    image,
    input.workerInterfaceValues ?? {},
    tool.values?.workerInterfaceValues ?? {},
  );

  const progressInfo: IProgressInfo = {};
  const errorInfo: IErrorInfoList = { errors: [] };
  const computeJob = await annotationStore.computeAnnotationsWithWorker({
    tool,
    workerInterface: values,
    progress: progressInfo,
    error: errorInfo,
    callback: (success: boolean) => {
      const errors = errorInfo.errors
        .map((e) => e.error || e.warning || e.info)
        .filter(Boolean);
      context.notify(
        success
          ? `Worker "${tool.name}" finished successfully.`
          : `Worker "${tool.name}" failed${
              errors.length ? `: ${errors.join("; ")}` : "."
            }`,
      );
    },
  });
  if (!computeJob) {
    throw new ToolExecutionError(
      "Failed to start the worker job (are you logged in and is a dataset open?)",
    );
  }
  return {
    result: {
      started: true,
      jobId: computeJob.jobId,
      tool: { id: tool.id, name: tool.name, image },
      parameters: values,
      note:
        "The job runs in the background; its progress is shown to the user. " +
        "You will get a transcript note when it completes.",
    },
  };
}

type TAgentToolExecutor = (
  input: any,
  context: IAgentToolContext,
) => Promise<IToolExecutionResult>;

interface IAgentToolEntry {
  gated?: boolean;
  execute: TAgentToolExecutor;
}

const registry: { [name: string]: IAgentToolEntry } = {
  get_interface_state: {
    execute: async () => ({ result: buildInterfaceState() }),
  },

  capture_screenshot: {
    execute: async (input: { target?: string }, context) => {
      const target = input.target ?? "viewport";
      const images: IChatImage[] = [];
      const captured: string[] = [];
      if (target === "viewport" || target === "both") {
        const shot = await captureViewportScreenshot(main.maps[0]?.map);
        if (shot) {
          images.push(shot);
          captured.push("viewport");
        }
      }
      if (target === "interface" || target === "both") {
        const shot = await captureInterfaceScreenshot(context.panelElement);
        if (shot) {
          images.push(shot);
          captured.push("interface");
        }
      }
      if (images.length === 0) {
        throw new ToolExecutionError(
          "Could not capture a screenshot (is the viewer open?)",
        );
      }
      return { result: { captured }, images };
    },
  },

  get_annotation_summary: {
    execute: async () => {
      const annotations = annotationStore.annotations;
      return {
        result: {
          total: annotations.length,
          filtered: filterStore.filteredAnnotations.length,
          selected: annotationStore.selectedAnnotationIds.size,
          byTag: countBy(annotations, (a) => a.tags),
          byShape: countBy(annotations, (a) => a.shape),
          byChannel: countBy(annotations, (a) => `${a.channel}`),
        },
      };
    },
  },

  list_annotations: {
    execute: async (input: {
      query?: IAnnotationQuery;
      limit?: number;
      offset?: number;
    }) => {
      const matching = queryAnnotations(input.query);
      const offset = input.offset ?? 0;
      const limit = input.limit ?? 50;
      const annotations = matching.slice(offset, offset + limit).map((a) => {
        const n = a.coordinates.length || 1;
        const centroid = a.coordinates.reduce(
          (acc, p) => ({ x: acc.x + p.x / n, y: acc.y + p.y / n }),
          { x: 0, y: 0 },
        );
        return {
          id: a.id,
          name: a.name,
          shape: a.shape,
          tags: a.tags,
          channel: a.channel,
          location: a.location,
          color: a.color,
          centroid: {
            x: Math.round(centroid.x),
            y: Math.round(centroid.y),
          },
        };
      });
      const hasMore = offset + limit < matching.length;
      const result: {
        totalMatching: number;
        offset: number;
        returned: number;
        hasMore: boolean;
        annotations: typeof annotations;
        nextOffset?: number;
        hint?: string;
      } = {
        totalMatching: matching.length,
        offset,
        returned: annotations.length,
        hasMore,
        annotations,
      };
      if (hasMore) {
        result.nextOffset = offset + limit;
      }
      if (matching.length > LARGE_ANNOTATION_RESULT) {
        result.hint =
          `${matching.length} annotations match. If you only need counts ` +
          "or a breakdown by tag/shape/channel, call get_annotation_summary " +
          "instead of paging through them all. Do not list every annotation " +
          "back to the user; summarize and mention notable examples.";
      }
      return { result };
    },
  },

  list_tools: {
    execute: async () => ({
      result: {
        tools: main.tools.map((tool) => ({
          id: tool.id,
          name: tool.name,
          type: tool.type,
          description: tool.template?.description ?? null,
          workerImage: tool.values?.image?.image ?? null,
        })),
      },
    }),
  },

  list_workers: {
    execute: async () => {
      if (Object.keys(propertyStore.workerImageList).length === 0) {
        await propertyStore.fetchWorkerImageList();
      }
      return {
        result: {
          workers: Object.entries(propertyStore.workerImageList).map(
            ([image, labels]) => ({
              image,
              name: labels.interfaceName ?? image,
              description: labels.description ?? null,
              category: labels.interfaceCategory ?? null,
              annotationShape: labels.annotationShape ?? null,
              isAnnotationWorker: labels.isAnnotationWorker != null,
              isPropertyWorker: labels.isPropertyWorker != null,
            }),
          ),
        },
      };
    },
  },

  get_worker_interface: {
    execute: async (input: { image: string }) => {
      if (!propertyStore.getWorkerInterface(input.image)) {
        await propertyStore.fetchWorkerInterface({ image: input.image });
      }
      const workerInterface = propertyStore.getWorkerInterface(input.image);
      if (!workerInterface) {
        throw new ToolExecutionError(
          `Could not fetch the interface for worker "${input.image}"`,
        );
      }
      return { result: { image: input.image, interface: workerInterface } };
    },
  },

  read_help_topic: {
    execute: async (input: { topic?: string }) => {
      if (typeof input.topic !== "string" || !input.topic) {
        throw new ToolExecutionError("topic is required");
      }
      let markdown: string;
      try {
        markdown = await main.agentAPI.getHelpTopic(input.topic);
      } catch (error: any) {
        // The backend 400 carries a helpful "Unknown help topic. Available: …"
        // in its response body; surface it so the model can retry with a
        // valid slug (see AI_PANEL_SPEC.md).
        throw new ToolExecutionError(
          error?.response?.data?.message ??
            error?.message ??
            `Could not fetch help topic "${input.topic}"`,
        );
      }
      return { result: { topic: input.topic, markdown } };
    },
  },

  set_location: {
    execute: async (input: { xy?: number; z?: number; time?: number }) => {
      const dataset = requireDataset();
      if (input.xy != null) {
        await main.setXY(clamp(input.xy, dataset.xy.length));
      }
      if (input.z != null) {
        await main.setZ(clamp(input.z, dataset.z.length));
      }
      if (input.time != null) {
        await main.setTime(clamp(input.time, dataset.time.length));
      }
      return {
        result: { location: { xy: main.xy, z: main.z, time: main.time } },
      };
    },
  },

  set_camera: {
    execute: async (input: {
      center?: { x: number; y: number };
      zoom?: number;
      fit?: "annotations" | "selection" | "full";
    }) => {
      requireDataset();
      if (input.fit) {
        const map = main.maps[0]?.map;
        if (!map) {
          throw new ToolExecutionError("The viewer map is not ready yet");
        }
        if (input.fit === "full") {
          // Same path as the viewer's "recenter and fit" button.
          map.bounds(map.maxBounds(undefined, null), null);
        } else {
          const targets =
            input.fit === "selection"
              ? annotationStore.annotations.filter((a) =>
                  annotationStore.selectedAnnotationIds.has(a.id),
                )
              : annotationStore.annotations;
          const bounds = annotationsBoundingBox(targets, 0.1, 20);
          if (!bounds) {
            throw new ToolExecutionError(
              input.fit === "selection"
                ? "No annotations are selected to fit the view to"
                : "There are no annotations to fit the view to",
            );
          }
          // Annotation coordinates are image-pixel (y increases downward), but
          // the GeoJS map gcs is y-up (gcs y = -pixel y). Negate y so the
          // bounds are valid (top > bottom) instead of "Invalid bounds".
          map.bounds(
            {
              left: bounds.left,
              right: bounds.right,
              top: -bounds.top,
              bottom: -bounds.bottom,
            },
            null,
          );
        }
      } else {
        await main.setCameraInfo({
          ...main.cameraInfo,
          center: input.center ?? main.cameraInfo.center,
          zoom: input.zoom ?? main.cameraInfo.zoom,
        });
      }
      return {
        result: {
          camera: {
            center: main.cameraInfo.center,
            zoom: main.cameraInfo.zoom,
          },
        },
      };
    },
  },

  set_display_options: {
    execute: async (input: {
      drawAnnotations?: boolean;
      annotationOpacity?: number;
      showScalebar?: boolean;
      scalebarColor?: string;
      backgroundColor?: string;
      drawAnnotationConnections?: boolean;
    }) => {
      let changed = false;
      if (input.drawAnnotations != null) {
        main.setDrawAnnotations(input.drawAnnotations);
        changed = true;
      }
      if (input.annotationOpacity != null) {
        if (
          typeof input.annotationOpacity !== "number" ||
          input.annotationOpacity < 0 ||
          input.annotationOpacity > 1
        ) {
          throw new ToolExecutionError(
            "annotationOpacity must be a number between 0 and 1",
          );
        }
        main.setAnnotationOpacity(input.annotationOpacity);
        changed = true;
      }
      if (input.showScalebar != null) {
        main.setShowScalebar(input.showScalebar);
        changed = true;
      }
      if (input.scalebarColor != null) {
        main.setScalebarColor(input.scalebarColor);
        changed = true;
      }
      if (input.backgroundColor != null) {
        main.setBackgroundColor(input.backgroundColor);
        changed = true;
      }
      if (input.drawAnnotationConnections != null) {
        main.setDrawAnnotationConnections(input.drawAnnotationConnections);
        changed = true;
      }
      if (!changed) {
        throw new ToolExecutionError(
          "Provide at least one display option to change",
        );
      }
      return { result: { displayOptions: currentDisplayOptions() } };
    },
  },

  set_view_mode: {
    execute: async (input: { mode: "2d" | "3d" }) => {
      if (input.mode !== "2d" && input.mode !== "3d") {
        throw new ToolExecutionError('mode must be "2d" or "3d"');
      }
      volumeViewStore.setViewMode(input.mode);
      return { result: { viewMode: volumeViewStore.viewMode } };
    },
  },

  set_scale: {
    // Changes the shared collection's physical units for every user and
    // reprojects every physical-unit measurement, and is not captured by the
    // per-turn view snapshot (scales are configuration, not view state), so
    // it is gated like the other shared-configuration mutators.
    gated: true,
    execute: async (input: {
      pixelSize?: { value: number; unit: string };
      zStep?: { value: number; unit: string };
      tStep?: { value: number; unit: string };
    }) => {
      requireLogin();
      if (!main.configuration) {
        throw new ToolExecutionError("No collection is open to set scales on");
      }
      const LENGTH_UNITS = ["nm", "µm", "mm", "m"];
      const TIME_UNITS = ["ms", "s", "m", "h", "d"];
      const apply = (
        itemId: "pixelSize" | "zStep" | "tStep",
        scale: { value: number; unit: string },
        units: string[],
      ) => {
        if (typeof scale.value !== "number" || !(scale.value > 0)) {
          throw new ToolExecutionError(
            `${itemId} value must be a positive number`,
          );
        }
        if (!units.includes(scale.unit)) {
          throw new ToolExecutionError(
            `${itemId} unit must be one of: ${units.join(", ")}`,
          );
        }
        // scale.unit was just validated against the allowed unit list, so the
        // narrowing cast to the branded unit type is sound here.
        main.saveScaleInConfiguration({
          itemId,
          scale: {
            value: scale.value,
            unit: scale.unit as TUnitLength | TUnitTime,
          } as IScaleInformation<TUnitLength | TUnitTime>,
        });
      };
      let changed = false;
      if (input.pixelSize) {
        apply("pixelSize", input.pixelSize, LENGTH_UNITS);
        changed = true;
      }
      if (input.zStep) {
        apply("zStep", input.zStep, LENGTH_UNITS);
        changed = true;
      }
      if (input.tStep) {
        apply("tStep", input.tStep, TIME_UNITS);
        changed = true;
      }
      if (!changed) {
        throw new ToolExecutionError(
          "Provide at least one of pixelSize, zStep, tStep",
        );
      }
      return { result: { scales: main.scales } };
    },
  },

  set_layer_mode: {
    execute: async (input: {
      mode: TLayerMode;
      unrollXY?: boolean;
      unrollZ?: boolean;
      unrollT?: boolean;
    }) => {
      requireLogin();
      await main.setLayerMode(input.mode);
      if (input.unrollXY != null) {
        await main.setUnrollXY(input.unrollXY);
      }
      if (input.unrollZ != null) {
        await main.setUnrollZ(input.unrollZ);
      }
      if (input.unrollT != null) {
        await main.setUnrollT(input.unrollT);
      }
      return { result: { layerMode: main.layerMode } };
    },
  },

  update_layer: {
    execute: async (input: {
      layer: string;
      color?: string;
      visible?: boolean;
      contrast?: IContrast;
      contrastScope?: "view" | "configuration";
      name?: string;
    }) => {
      requireLogin();
      const layer = resolveLayer(input.layer);
      const delta: Partial<IDisplayLayer> = {};
      if (input.color != null) {
        delta.color = input.color;
      }
      if (input.visible != null) {
        delta.visible = input.visible;
      }
      if (input.name != null) {
        delta.name = input.name;
      }
      if (Object.keys(delta).length === 0 && input.contrast == null) {
        throw new ToolExecutionError(
          "Provide at least one of color, visible, contrast, name",
        );
      }
      if (Object.keys(delta).length > 0) {
        await main.changeLayer({ layerId: layer.id, delta });
      }
      if (input.contrast != null) {
        // Default matches the UI slider: a personal view override. Pass
        // contrastScope "configuration" to change the shared collection
        // instead (persisted for everyone using the collection).
        if (input.contrastScope === "configuration") {
          await main.saveContrastInConfiguration({
            layerId: layer.id,
            contrast: input.contrast,
          });
        } else {
          await main.saveContrastInView({
            layerId: layer.id,
            contrast: input.contrast,
          });
        }
      }
      const updated = main.getLayerFromId(layer.id)!;
      return {
        result: {
          layer: {
            id: updated.id,
            name: updated.name,
            color: updated.color,
            visible: updated.visible,
            contrast: updated.contrast,
          },
        },
      };
    },
  },

  set_layer_visibility: {
    execute: async (input: { visibleLayers: string[] }) => {
      requireLogin();
      const visibleIds = new Set(
        input.visibleLayers.map((ref) => resolveLayer(ref).id),
      );
      if (main.layerMode === "single" && visibleIds.size > 1) {
        throw new ToolExecutionError(
          "The viewer is in 'single' layer mode; switch to 'multiple' with " +
            "set_layer_mode before making several layers visible",
        );
      }
      for (const layer of main.layers) {
        const visible = visibleIds.has(layer.id);
        if (layer.visible !== visible) {
          await main.changeLayer({
            layerId: layer.id,
            delta: { visible },
            sync: false,
          });
        }
      }
      await main.syncConfiguration("layers");
      return {
        result: {
          layers: main.layers.map((l) => ({
            id: l.id,
            name: l.name,
            visible: l.visible,
          })),
        },
      };
    },
  },

  select_annotations: {
    execute: async (input: {
      query?: IAnnotationQuery;
      mode: "replace" | "add" | "remove" | "clear";
    }) => {
      if (input.mode === "clear") {
        annotationStore.setSelected([]);
      } else {
        // A missing query legitimately means "all" for selection (reversible),
        // but a provided one must be a valid object, not garbage.
        if (input.query !== undefined) {
          if (
            input.query === null ||
            typeof input.query !== "object" ||
            Array.isArray(input.query)
          ) {
            throw new ToolExecutionError(
              'query must be an object (e.g. {"tags":["nucleus"]})',
            );
          }
          validateAnnotationQuery(input.query as { [key: string]: unknown });
        }
        const ids = queryAnnotations(input.query).map((a) => a.id);
        if (input.mode === "replace") {
          annotationStore.setSelected(ids);
        } else if (input.mode === "add") {
          annotationStore.selectAnnotations(ids);
        } else {
          annotationStore.unselectAnnotations(ids);
        }
      }
      return {
        result: { selectedCount: annotationStore.selectedAnnotationIds.size },
      };
    },
  },

  color_annotations: {
    execute: async (input: {
      target: TAnnotationTarget;
      color: string | null;
      randomize?: boolean;
    }) => {
      requireLogin();
      const annotationIds = resolveAnnotationTargetIds(input.target);
      if (annotationIds.length > 0) {
        await annotationStore.colorAnnotationIds({
          annotationIds,
          color: input.color,
          randomize: input.randomize ?? false,
        });
      }
      return { result: { affectedCount: annotationIds.length } };
    },
  },

  tag_annotations: {
    execute: async (input: {
      target: TAnnotationTarget;
      tags: string[];
      mode: "add" | "remove" | "replace";
    }) => {
      requireLogin();
      const annotationIds = resolveAnnotationTargetIds(input.target);
      if (annotationIds.length > 0) {
        const payload = { annotationIds, tags: input.tags };
        if (input.mode === "add") {
          await annotationStore.addTagsByAnnotationIds(payload);
        } else if (input.mode === "remove") {
          await annotationStore.removeTagsByAnnotationIds(payload);
        } else {
          await annotationStore.replaceTagsByAnnotationIds(payload);
        }
      }
      return { result: { affectedCount: annotationIds.length } };
    },
  },

  set_annotation_filter: {
    execute: async (input: {
      tags?: string[];
      exclusive?: boolean;
      currentFrameOnly?: boolean;
      propertyFilters?: {
        propertyPath: string[];
        min?: number;
        max?: number;
      }[];
      clearPropertyFilters?: boolean;
      clearAll?: boolean;
    }) => {
      if (input.clearAll) {
        filterStore.setTagFilter({
          id: "tagFilter",
          exclusive: false,
          enabled: false,
          tags: [],
        });
        filterStore.setOnlyCurrentFrame(false);
      }
      if (input.clearAll || input.clearPropertyFilters) {
        // No bulk clear exists; disable each active property filter in place.
        for (const filter of filterStore.propertyFilters) {
          if (filter.enabled) {
            filterStore.updatePropertyFilter({ ...filter, enabled: false });
          }
        }
      }
      if (input.tags) {
        filterStore.setTagFilter({
          id: "tagFilter",
          exclusive: input.exclusive ?? false,
          enabled: input.tags.length > 0,
          tags: input.tags,
        });
      }
      if (input.currentFrameOnly != null) {
        filterStore.setOnlyCurrentFrame(input.currentFrameOnly);
      }
      for (const pf of input.propertyFilters ?? []) {
        if (
          !Array.isArray(pf.propertyPath) ||
          pf.propertyPath.length === 0 ||
          pf.propertyPath.some((key) => typeof key !== "string")
        ) {
          throw new ToolExecutionError(
            "each propertyFilter needs a non-empty propertyPath (string " +
              "array from get_property_values)",
          );
        }
        if (pf.min == null && pf.max == null) {
          throw new ToolExecutionError(
            "each propertyFilter needs a min and/or max",
          );
        }
        filterStore.updatePropertyFilter({
          id: pf.propertyPath.join("/"),
          exclusive: false,
          enabled: true,
          propertyPath: pf.propertyPath,
          range: {
            min: pf.min ?? -Number.MAX_VALUE,
            max: pf.max ?? Number.MAX_VALUE,
          },
          valuesOrRange: PropertyFilterMode.Range,
        });
      }
      return {
        result: {
          tagFilter: {
            enabled: filterStore.tagFilter.enabled,
            tags: filterStore.tagFilter.tags,
            exclusive: filterStore.tagFilter.exclusive,
          },
          currentFrameOnly: filterStore.onlyCurrentFrame,
          propertyFilters: filterStore.propertyFilters
            .filter((filter) => filter.enabled)
            .map((filter) => ({
              propertyPath: filter.propertyPath,
              range: filter.range,
            })),
          filteredCount: filterStore.filteredAnnotations.length,
        },
      };
    },
  },

  select_tool: {
    execute: async (input: { toolId: string | null }) => {
      if (
        input.toolId != null &&
        !main.tools.some((t) => t.id === input.toolId)
      ) {
        throw new ToolExecutionError(
          `No tool with id "${input.toolId}"; use list_tools to see the toolset`,
        );
      }
      await main.setSelectedToolId(input.toolId);
      return {
        result: {
          selectedToolId: main.selectedTool?.configuration.id ?? null,
        },
      };
    },
  },

  create_tool: {
    // Adds a tool to the shared collection toolset, so it is gated like
    // run_worker. Does not auto-select the new tool (the model can call
    // select_tool) and is not part of the revert snapshot (config, not view).
    gated: true,
    execute: async (input: {
      manualShape?: string;
      workerImage?: string;
      channelName?: string;
      name?: string;
    }) => {
      requireLogin();
      if (!main.configuration) {
        throw new ToolExecutionError("No collection is open to add a tool to");
      }
      const hasManual = input.manualShape != null;
      const hasWorker = input.workerImage != null;
      if (hasManual === hasWorker) {
        throw new ToolExecutionError(
          "Provide exactly one of manualShape or workerImage",
        );
      }
      let entry;
      if (hasManual) {
        entry = MANUAL_CATALOG.find(
          (e) => e.defaultShape === input.manualShape,
        );
        if (!entry) {
          throw new ToolExecutionError(
            `Unsupported manualShape "${input.manualShape}"; use one of: ` +
              MANUAL_CATALOG.map((e) => e.defaultShape).join(", "),
          );
        }
      } else {
        entry = buildCatalog().find(
          (e) => e.kind === "worker" && e.image === input.workerImage,
        );
        if (!entry) {
          throw new ToolExecutionError(
            `Unknown worker image "${input.workerImage}"; use list_workers ` +
              "to see the available worker images",
          );
        }
      }
      // A channelName that doesn't resolve to a layer would leave the tool
      // unbound, and worker execution silently defaults that to channel 0 —
      // while the result echoes the requested channel as if it bound. Reject
      // it instead so the model picks a real channel.
      if (
        input.channelName != null &&
        !layerIdForChannelName(input.channelName)
      ) {
        const available = main.layers
          .map(
            (l) =>
              main.dataset?.channelNames.get(l.channel) ??
              `Channel ${l.channel}`,
          )
          .join(", ");
        throw new ToolExecutionError(
          `No channel named "${input.channelName}". Available channels: ${
            available || "none"
          }`,
        );
      }
      const tool = buildToolConfiguration(entry, {
        channelName: input.channelName,
        name: input.name,
      });
      if (!tool) {
        throw new ToolExecutionError(
          "Could not build the requested tool (missing tool template)",
        );
      }
      await main.addToolToConfiguration(tool);
      return {
        result: {
          toolId: tool.id,
          name: tool.name,
          type: tool.type,
          channelName: input.channelName ?? null,
        },
      };
    },
  },

  list_properties: {
    execute: async () => ({
      result: {
        properties: propertyStore.properties.map((property) => ({
          id: property.id,
          name: property.name,
          image: property.image,
          shape: property.shape,
          tags: property.tags?.tags ?? [],
          // A property is "computed" if any value path for it exists.
          computed: propertyStore.computedPropertyPaths.some(
            (path) => path[0] === property.id,
          ),
        })),
      },
    }),
  },

  create_property: {
    // Defines a measurement in the shared collection, so it is gated.
    gated: true,
    execute: async (input: {
      propertyWorkerImage?: string;
      shape?: string;
      tags?: string[];
      exclusive?: boolean;
      name?: string;
      workerInterfaceValues?: IWorkerInterfaceValues;
    }) => {
      requireLogin();
      requireDataset();
      const image = input.propertyWorkerImage;
      if (typeof image !== "string" || !image) {
        throw new ToolExecutionError("propertyWorkerImage is required");
      }
      if (typeof input.shape !== "string") {
        throw new ToolExecutionError(
          "shape is required (e.g. polygon, point, line)",
        );
      }
      if (Object.keys(propertyStore.workerImageList).length === 0) {
        await propertyStore.fetchWorkerImageList();
      }
      const labels = propertyStore.workerImageList[image];
      if (labels?.isPropertyWorker == null) {
        throw new ToolExecutionError(
          `"${image}" is not a property worker; use list_workers and pick ` +
            "one whose isPropertyWorker is true",
        );
      }
      // Mirror PropertyCreation.vue's filter: a property worker only applies to
      // its declared annotationShape (or AnnotationShape.Any). Otherwise the
      // created property definition is unusable.
      const workerShape = labels.annotationShape || null;
      if (workerShape !== input.shape && workerShape !== AnnotationShape.Any) {
        throw new ToolExecutionError(
          `Property worker "${image}" operates on shape "${
            workerShape ?? "none"
          }", not "${input.shape}". Pick a worker whose annotationShape is ` +
            `"${input.shape}" or "any" (see list_workers).`,
        );
      }
      const workerInterface = await resolveWorkerInterfaceValues(
        image,
        input.workerInterfaceValues ?? {},
      );
      const property = await propertyStore.createProperty({
        name:
          input.name ??
          propertyStore.workerImageList[image]?.interfaceName ??
          "Property",
        image,
        tags: { tags: input.tags ?? [], exclusive: input.exclusive ?? false },
        shape: input.shape as AnnotationShape,
        workerInterface,
      });
      if (!property) {
        throw new ToolExecutionError("Failed to create the property");
      }
      return {
        result: {
          propertyId: property.id,
          name: property.name,
          image: property.image,
          shape: property.shape,
        },
      };
    },
  },

  compute_property: {
    // Starts a compute job, so it is gated like run_worker.
    gated: true,
    execute: async (input: { propertyId?: string }) => {
      requireLogin();
      requireDataset();
      const property = propertyStore.properties.find(
        (p) => p.id === input.propertyId,
      );
      if (!property) {
        throw new ToolExecutionError(
          `No property with id "${input.propertyId}"; use list_properties ` +
            "or create_property first",
        );
      }
      const runningJobId = jobsStore.jobIdForPropertyId[property.id];
      if (runningJobId) {
        return {
          result: {
            started: false,
            alreadyRunning: true,
            jobId: runningJobId,
            propertyId: property.id,
            note:
              `Property "${property.name}" is already computing (job ` +
              `${runningJobId}). Wait for it before starting another run.`,
          },
        };
      }
      const errorInfo: IErrorInfoList = { errors: [] };
      // computeProperty returns null when the job never started (no dataset,
      // or job creation failed); don't report success in that case.
      const computeJob = await propertyStore.computeProperty({
        property,
        errorInfo,
      });
      if (!computeJob) {
        const errors = errorInfo.errors
          .map((e) => e.error || e.warning || e.info)
          .filter(Boolean);
        throw new ToolExecutionError(
          `Failed to start computing "${property.name}"${
            errors.length ? `: ${errors.join("; ")}` : "."
          }`,
        );
      }
      return {
        result: {
          propertyId: property.id,
          name: property.name,
          started: true,
          jobId: computeJob.jobId,
          note:
            "Computation started; values populate as the job runs. Use " +
            "get_property_values to read the results.",
        },
      };
    },
  },

  get_property_values: {
    execute: async (input: { propertyId?: string; query?: unknown }) => {
      await propertyStore.fetchPropertyValues();
      let allowedIds: Set<string> | null = null;
      if (input.query !== undefined) {
        if (
          input.query === null ||
          typeof input.query !== "object" ||
          Array.isArray(input.query)
        ) {
          throw new ToolExecutionError("query must be a query object");
        }
        validateAnnotationQuery(input.query as { [key: string]: unknown });
        allowedIds = new Set(
          queryAnnotations(input.query as IAnnotationQuery).map((a) => a.id),
        );
      }
      const nameOf = (id: string) =>
        propertyStore.properties.find((p) => p.id === id)?.name ?? id;
      const stats = [];
      for (const path of propertyStore.computedPropertyPaths) {
        const propertyId = path[0];
        if (input.propertyId && propertyId !== input.propertyId) {
          continue;
        }
        const values: number[] = [];
        for (const annotationId in propertyStore.propertyValues) {
          if (allowedIds && !allowedIds.has(annotationId)) {
            continue;
          }
          let value: any = propertyStore.propertyValues[annotationId];
          for (const key of path) {
            value = value?.[key];
          }
          if (typeof value === "number" && !Number.isNaN(value)) {
            values.push(value);
          }
        }
        if (values.length === 0) {
          continue;
        }
        // Single pass rather than sum-reduce + Math.min(...values): `values`
        // has one entry per matching annotation and is uncapped, so spreading
        // it into Math.min/max throws RangeError past the engine's argument
        // limit (~65k) — reachable on the large datasets this tool targets.
        let sum = 0;
        let min = Infinity;
        let max = -Infinity;
        for (const value of values) {
          sum += value;
          if (value < min) {
            min = value;
          }
          if (value > max) {
            max = value;
          }
        }
        stats.push({
          propertyId,
          property: nameOf(propertyId),
          path: path.slice(1).join(".") || nameOf(propertyId),
          // Full path (incl. propertyId) to pass to set_annotation_filter.
          propertyPath: path,
          count: values.length,
          mean: sum / values.length,
          min,
          max,
        });
      }
      return { result: { stats } };
    },
  },

  undo: {
    execute: async () => {
      requireLogin();
      await annotationStore.undoOrRedo(true);
      return { result: { done: true } };
    },
  },

  redo: {
    execute: async () => {
      requireLogin();
      await annotationStore.undoOrRedo(false);
      return { result: { done: true } };
    },
  },

  run_worker: {
    gated: true,
    execute: runWorkerTool,
  },
};

export function isGatedTool(name: string): boolean {
  return registry[name]?.gated === true;
}

export async function executeAgentTool(
  name: string,
  input: any,
  context: IAgentToolContext,
): Promise<IToolExecutionResult> {
  const entry = registry[name];
  if (!entry) {
    throw new ToolExecutionError(`Unknown tool "${name}"`);
  }
  return entry.execute(input ?? {}, context);
}

// Human-readable one-liner for transcript cards and approval prompts.
// Tool inputs come straight from the model and are not schema-enforced, so
// this must never throw on malformed input: guard every field access that
// assumes an array/shape. Callers additionally wrap this in try/catch.
export function describeAgentToolCall(name: string, input: any): string {
  const joinList = (value: any, sep = ", ") =>
    Array.isArray(value) ? value.join(sep) : "";
  const query = (target: TAnnotationTarget | IAnnotationQuery | undefined) => {
    if (target === "selection") {
      return "the selected annotations";
    }
    if (!target || typeof target !== "object") {
      return "all annotations";
    }
    if (Object.keys(target).length === 0) {
      return "all annotations";
    }
    const parts: string[] = [];
    const q = target as IAnnotationQuery;
    if (Array.isArray(q.tags) && q.tags.length) {
      parts.push(`tagged ${q.tags.join(q.exclusive ? " and " : " or ")}`);
    }
    if (q.shape) {
      parts.push(`shape ${q.shape}`);
    }
    if (q.channel != null) {
      parts.push(`channel ${q.channel}`);
    }
    if (q.currentFrameOnly) {
      parts.push("in the current frame");
    }
    if (Array.isArray(q.ids)) {
      parts.push(`${q.ids.length} listed ids`);
    }
    return `annotations ${parts.join(", ") || "(all)"}`;
  };
  switch (name) {
    case "get_interface_state":
      return "Read the interface state";
    case "capture_screenshot":
      return `Capture ${input?.target ?? "viewport"} screenshot`;
    case "get_annotation_summary":
      return "Summarize annotations";
    case "list_annotations":
      return `List ${query(input?.query)}`;
    case "list_tools":
      return "List the toolset";
    case "list_workers":
      return "List available workers";
    case "get_worker_interface":
      return `Read parameters of ${input?.image}`;
    case "read_help_topic":
      return `Read help on "${input?.topic ?? ""}"`;
    case "set_location": {
      const parts: string[] = [];
      if (input?.xy != null) {
        parts.push(`XY=${input.xy}`);
      }
      if (input?.z != null) {
        parts.push(`Z=${input.z}`);
      }
      if (input?.time != null) {
        parts.push(`T=${input.time}`);
      }
      return `Move to ${parts.join(", ") || "current location"}`;
    }
    case "set_camera":
      if (typeof input?.fit === "string") {
        return `Fit the view to ${input.fit}`;
      }
      return input?.zoom != null && input?.center == null
        ? `Zoom to level ${input.zoom}`
        : "Move the camera";
    case "set_layer_mode":
      return `Switch to ${input?.mode} layer mode`;
    case "update_layer": {
      const changes = ["color", "visible", "contrast", "name"]
        .filter((key) => input?.[key] != null)
        .join(", ");
      return `Update layer "${input?.layer}" (${changes})`;
    }
    case "set_layer_visibility":
      return `Show only: ${joinList(input?.visibleLayers)}`;
    case "select_annotations":
      return input?.mode === "clear"
        ? "Clear the selection"
        : `Select ${query(input?.query)} (${input?.mode})`;
    case "color_annotations":
      return `Color ${query(input?.target)} ${
        input?.randomize ? "randomly" : input?.color ?? "by layer color"
      }`;
    case "tag_annotations":
      return `${
        input?.mode === "remove" ? "Untag" : "Tag"
      } ${query(input?.target)}: ${joinList(input?.tags)}`;
    case "set_annotation_filter":
      return input?.clearAll && !input?.tags
        ? "Clear annotation filters"
        : `Filter annotations${
            input?.tags ? ` by tags ${joinList(input.tags)}` : ""
          }${input?.currentFrameOnly ? " (current frame)" : ""}`;
    case "select_tool": {
      if (input?.toolId == null) {
        return "Deselect the active tool";
      }
      const tool = main.tools.find((t) => t.id === input.toolId);
      return `Activate tool "${tool?.name ?? input.toolId}"`;
    }
    case "create_tool": {
      const kind =
        typeof input?.workerImage === "string"
          ? `worker (${input.workerImage})`
          : `manual ${input?.manualShape ?? "annotation"}`;
      const channel =
        typeof input?.channelName === "string"
          ? ` on ${input.channelName}`
          : "";
      return `Set up a ${kind} tool${channel}`;
    }
    case "set_display_options":
      return "Change viewer display options";
    case "set_view_mode":
      return `Switch to ${input?.mode === "3d" ? "3D" : "2D"} view`;
    case "set_scale":
      return "Set the image scale / physical units";
    case "list_properties":
      return "List the property definitions";
    case "create_property": {
      const shape =
        typeof input?.shape === "string" ? ` on ${input.shape}` : "";
      const named = typeof input?.name === "string" ? ` "${input.name}"` : "";
      return `Set up property${named}${shape}`;
    }
    case "compute_property": {
      const property = propertyStore.properties.find(
        (p) => p.id === input?.propertyId,
      );
      return `Compute property "${property?.name ?? input?.propertyId ?? ""}"`;
    }
    case "get_property_values":
      return "Summarize computed property values";
    case "undo":
      return "Undo the last annotation change";
    case "redo":
      return "Redo the last undone change";
    case "run_worker": {
      const tool = main.tools.find((t) => t.id === input?.toolId);
      return `Run worker "${tool?.name ?? input?.toolId}" — starts a compute job that may create many annotations`;
    }
    default:
      return name;
  }
}

// Snapshot/restore of the view state the Tier-2 tools can touch, used for
// the per-turn "revert view changes" affordance. Annotation edits are NOT
// captured here — they ride the backend undo history instead.
//
// Shared vs personal state is captured separately: `layers` holds the
// SHARED configuration values (never merged with per-view overrides, so a
// revert can't bake a personal contrast into the collection), and
// `viewContrasts` holds the user's personal per-view contrast overrides.
export interface IViewStateSnapshot {
  // Identity of the dataset/collection/view this snapshot belongs to, so a
  // turn's tool execution and its revert can detect that the user navigated
  // elsewhere and refuse to act on the wrong dataset (see AI_PANEL_REVIEW #1).
  datasetId: string | null;
  configurationId: string | null;
  datasetViewId: string | null;
  location: { xy: number; z: number; time: number };
  layerMode: TLayerMode;
  unroll: { xy: boolean; z: boolean; t: boolean };
  cameraInfo: typeof main.cameraInfo;
  layers: {
    id: string;
    color: string;
    visible: boolean;
    contrast: IContrast;
    name: string;
  }[];
  viewContrasts: { [layerId: string]: IContrast };
  tagFilter: typeof filterStore.tagFilter;
  onlyCurrentFrame: boolean;
  propertyFilters: IPropertyAnnotationFilter[];
  selectedAnnotationIds: string[];
  selectedToolId: string | null;
  displayOptions: ReturnType<typeof currentDisplayOptions>;
  viewMode: string;
}

// The dataset/collection/view currently loaded in the viewer.
function currentViewIdentity() {
  return {
    datasetId: main.dataset?.id ?? null,
    configurationId: main.configuration?.id ?? null,
    datasetViewId: main.datasetView?.id ?? null,
  };
}

// True if the active dataset/collection/view differs from the snapshot's —
// i.e. the user navigated away since the snapshot was taken. Tool execution
// and revert use this to avoid mutating a dataset with another's context.
export function viewIdentityChangedSince(
  snapshot: IViewStateSnapshot,
): boolean {
  const current = currentViewIdentity();
  return (
    snapshot.datasetId !== current.datasetId ||
    snapshot.configurationId !== current.configurationId ||
    snapshot.datasetViewId !== current.datasetViewId
  );
}

export function snapshotViewState(): IViewStateSnapshot {
  return JSON.parse(
    JSON.stringify({
      ...currentViewIdentity(),
      location: { xy: main.xy, z: main.z, time: main.time },
      layerMode: main.layerMode,
      unroll: { xy: main.unrollXY, z: main.unrollZ, t: main.unrollT },
      cameraInfo: main.cameraInfo,
      layers: (main.configuration?.layers ?? []).map((l) => ({
        id: l.id,
        color: l.color,
        visible: l.visible,
        contrast: l.contrast,
        name: l.name,
      })),
      viewContrasts: main.datasetView?.layerContrasts ?? {},
      tagFilter: filterStore.tagFilter,
      onlyCurrentFrame: filterStore.onlyCurrentFrame,
      propertyFilters: filterStore.propertyFilters,
      selectedAnnotationIds: [...annotationStore.selectedAnnotationIds],
      selectedToolId: main.selectedTool?.configuration.id ?? null,
      displayOptions: currentDisplayOptions(),
      viewMode: volumeViewStore.viewMode,
    }),
  );
}

export async function restoreViewState(snapshot: IViewStateSnapshot) {
  if (viewIdentityChangedSince(snapshot)) {
    throw new ToolExecutionError(
      "The active dataset changed since these view changes were made; " +
        "not reverting to avoid altering a different dataset.",
    );
  }
  await main.setXY(snapshot.location.xy);
  await main.setZ(snapshot.location.z);
  await main.setTime(snapshot.location.time);
  if (main.layerMode !== snapshot.layerMode) {
    await main.setLayerMode(snapshot.layerMode);
  }
  await main.setUnrollXY(snapshot.unroll.xy);
  await main.setUnrollZ(snapshot.unroll.z);
  await main.setUnrollT(snapshot.unroll.t);
  let layersChanged = false;
  for (const saved of snapshot.layers) {
    // Compare against the configuration layer, not the merged view (which
    // folds in per-view contrast overrides restored separately below).
    const layer = main.getConfigurationLayerFromId(saved.id);
    if (!layer) {
      continue;
    }
    if (
      layer.color !== saved.color ||
      layer.visible !== saved.visible ||
      layer.name !== saved.name ||
      JSON.stringify(layer.contrast) !== JSON.stringify(saved.contrast)
    ) {
      layersChanged = true;
      await main.changeLayer({
        layerId: saved.id,
        delta: {
          color: saved.color,
          visible: saved.visible,
          contrast: saved.contrast,
          name: saved.name,
        },
        sync: false,
      });
    }
  }
  if (layersChanged) {
    await main.syncConfiguration("layers");
  }
  await main.setViewContrastOverrides(snapshot.viewContrasts);
  filterStore.setTagFilter(snapshot.tagFilter);
  filterStore.setOnlyCurrentFrame(snapshot.onlyCurrentFrame);
  // Restore property filters: disable any added since the snapshot (matching
  // set_annotation_filter's clear, which disables rather than removes), then
  // re-apply the snapshot's filters. updatePropertyFilter keys by propertyPath.
  const snapshotPaths = new Set(
    snapshot.propertyFilters.map((filter) => filter.propertyPath.join("/")),
  );
  for (const current of [...filterStore.propertyFilters]) {
    if (current.enabled && !snapshotPaths.has(current.propertyPath.join("/"))) {
      filterStore.updatePropertyFilter({ ...current, enabled: false });
    }
  }
  for (const saved of snapshot.propertyFilters) {
    filterStore.updatePropertyFilter(saved);
  }
  annotationStore.setSelected(snapshot.selectedAnnotationIds);
  await main.setSelectedToolId(snapshot.selectedToolId);
  const display = snapshot.displayOptions;
  if (display) {
    main.setDrawAnnotations(display.drawAnnotations);
    main.setAnnotationOpacity(display.annotationOpacity);
    main.setShowScalebar(display.showScalebar);
    main.setScalebarColor(display.scalebarColor);
    main.setBackgroundColor(display.backgroundColor);
    main.setDrawAnnotationConnections(display.drawAnnotationConnections);
  }
  if (snapshot.viewMode === "2d" || snapshot.viewMode === "3d") {
    volumeViewStore.setViewMode(snapshot.viewMode);
  }
  await main.setCameraInfo(snapshot.cameraInfo);
}

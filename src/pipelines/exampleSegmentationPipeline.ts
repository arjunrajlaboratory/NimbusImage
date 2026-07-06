/**
 * Compute pipeline for the example-based auto-segmentation ("AutoSeg") tool.
 * See codebaseDocumentation/EXAMPLE_SEGMENTATION_TOOL.md for the full spec,
 * especially §3 (architecture) and §5.2 (normative exports).
 *
 * Structure mirrors src/pipelines/samPipeline.ts: a reactive compute-DAG
 * (src/pipelines/computePipeline.ts) whose outputs are mirrored into a
 * reactive tool state consumed by AnnotationViewer.vue and the tool menu.
 * The expensive work (features, training, prediction, post-processing)
 * happens in src/workers/exampleSegmentation.worker.ts; the nodes below are
 * thin async wrappers around src/utils/exampleSegmentation/workerClient.ts.
 */
import { markRaw, reactive } from "vue";
import geojs from "geojs";
import {
  ErrorToolStateSymbol,
  ExampleSegmentationToolStateSymbol,
  IErrorToolState,
  IExampleSegmentationExample,
  IExampleSegmentationStatus,
  IExampleSegmentationToolState,
  IGeoJSPosition,
  IMapEntry,
  IToolConfiguration,
} from "@/store/model";
import {
  ComputeNode,
  ManualInputNode,
  NoOutput,
  TNoOutput,
  createComputeNode,
  readManualInputOr,
  withErrorReporting,
} from "./computePipeline";
import { ExampleSegmentationWorkerClient } from "@/utils/exampleSegmentation/workerClient";
import {
  IPostprocessParams,
  ISegmentationResultResponse,
  IWorkerExample,
  IWorkerPoint,
  IWorkerTimings,
} from "@/utils/exampleSegmentation/types";
import { dedupeProposalsAgainstAnnotations } from "@/utils/proposalDedupe";

const MAX_WORKING_DIMENSION = 1024;
const DEFAULT_THRESHOLD = 0.5;
const DEFAULT_SIZE_RANGE = { min: null, max: null } as const;
const DEFAULT_SIMPLIFICATION_TOLERANCE = 1;

type TSizeRange = { min: number | null; max: number | null };

/**
 * Take a screenshot of the visible image layers, same approach as
 * samPipeline.ts's `screenshot` (map.screenshot of visible image layers).
 */
async function screenshot({
  map,
  imageLayers,
}: IMapEntry): Promise<HTMLCanvasElement> {
  const layers = imageLayers.filter(
    (layer) => layer.node().css("visibility") !== "hidden",
  );
  return map.screenshot(layers, "canvas");
}

interface IWorkingImage {
  rgba: ArrayBuffer;
  width: number;
  height: number;
  srcWidth: number;
  srcHeight: number;
  // display (screenshot canvas) -> working (downscaled) pixel scale
  xScale: number;
  yScale: number;
}

/**
 * Downscales the screenshot canvas so its long side is at most
 * MAX_WORKING_DIMENSION and extracts its RGBA pixels. All worker computation
 * happens in this "working" resolution (spec §3).
 */
function downscaleScreenshot(canvas: HTMLCanvasElement): IWorkingImage {
  const srcWidth = canvas.width;
  const srcHeight = canvas.height;
  const longSide = Math.max(srcWidth, srcHeight);
  const scale =
    longSide > MAX_WORKING_DIMENSION ? MAX_WORKING_DIMENSION / longSide : 1;
  const width = Math.max(1, Math.round(srcWidth * scale));
  const height = Math.max(1, Math.round(srcHeight * scale));

  const workingCanvas = document.createElement("canvas");
  workingCanvas.width = width;
  workingCanvas.height = height;
  const context = workingCanvas.getContext("2d", {
    alpha: false,
    willReadFrequently: true,
  });
  if (!context) {
    throw new Error("Can't create canvas context for example segmentation");
  }
  context.drawImage(canvas, 0, 0, width, height);
  const imageData = context.getImageData(0, 0, width, height);

  return {
    rgba: imageData.data.buffer,
    width,
    height,
    srcWidth,
    srcHeight,
    xScale: width / srcWidth,
    yScale: height / srcHeight,
  };
}

interface IWorkerImageInfo {
  width: number;
  height: number;
  srcWidth: number;
  srcHeight: number;
  xScale: number;
  yScale: number;
}

function toWorkerImageInfo(workingImage: IWorkingImage): IWorkerImageInfo {
  const { width, height, srcWidth, srcHeight, xScale, yScale } = workingImage;
  return { width, height, srcWidth, srcHeight, xScale, yScale };
}

/** Converts a circled example (GCS coords) into working-pixel coordinates. */
function convertExampleToWorkingCoords(
  example: IExampleSegmentationExample,
  { map }: IMapEntry,
  workerImage: IWorkerImageInfo,
): IWorkerExample {
  const displayPoints = map.gcsToDisplay(example.coordinates);
  return {
    polarity: example.polarity,
    points: displayPoints.map(({ x, y }) => ({
      x: x * workerImage.xScale,
      y: y * workerImage.yScale,
    })),
  };
}

/** Same simplification approach as samPipeline.ts's `simplifyCoordinates`. */
function simplifyCoordinates(
  coords: IGeoJSPosition[],
  tolerance: number,
): IGeoJSPosition[] {
  if (tolerance < 0) {
    return coords;
  }
  return geojs.util.rdpLineSimplify(coords, tolerance, true);
}

/** Converts a worker contour (working coords) back to a simplified GCS polygon. */
function convertContourToGcs(
  contour: IWorkerPoint[],
  { map }: IMapEntry,
  workerImage: IWorkerImageInfo,
  simplificationTolerance: number,
): IGeoJSPosition[] {
  const displayPoints: IGeoJSPosition[] = contour.map(({ x, y }) => ({
    x: x / workerImage.xScale,
    y: y / workerImage.yScale,
  }));
  return simplifyCoordinates(
    map.displayToGcs(displayPoints),
    simplificationTolerance,
  );
}

interface IProposalsOutput {
  proposals: IGeoJSPosition[][];
  componentCount: number;
  autoSizeRange: { min: number; max: number } | null;
  timings: IWorkerTimings;
}

export type TExampleSegmentationNodes = {
  allNodes: ComputeNode<any, any>[];
  input: {
    // | TNoOutput so callers (e.g. ImageViewer's map-feeding watcher, shared
    // with SAM's identically-shaped geoJSMap node) can setValue(NoOutput)
    // when no map is available yet - same typing as samPipeline.ts's
    // geoJsMapInputNode.
    geoJSMap: ManualInputNode<IMapEntry | TNoOutput>;
    examples: ManualInputNode<IExampleSegmentationExample[]>;
    threshold: ManualInputNode<number>;
    sizeRange: ManualInputNode<TSizeRange>;
    simplificationTolerance: ManualInputNode<number>;
  };
  output: {
    proposals: ComputeNode<any, any>;
  };
  // Drops the worker's trained model, examples, and probability map, and
  // re-arms the "no model yet" guard so trainPredict resolves to NoOutput
  // (clearing the proposals) until a new example is drawn.
  reset: () => Promise<void>;
};

function createExampleSegmentationPipeline(
  toolConfiguration: IToolConfiguration<"exampleSegmentation">,
  reportError: (error: Error) => void,
): TExampleSegmentationNodes {
  const workerClient = new ExampleSegmentationWorkerClient();
  // Whether the worker currently holds a trained model. Used to avoid
  // calling trainPredict before any example has ever been drawn (spec §3:
  // "If no forest exists yet, the node outputs NoOutput").
  const modelState = { trained: false };

  const geoJSMapInputNode = new ManualInputNode<IMapEntry | TNoOutput>(
    NoOutput,
    {
      type: "debounce",
      wait: 1000,
      options: { leading: false, trailing: true },
    },
  );
  const examplesInputNode = new ManualInputNode<IExampleSegmentationExample[]>(
    [],
  );
  // Debounced inputs still get an immediately-available default value: pass
  // NoOutput to the constructor (so the debounce isn't invoked yet) then set
  // the default with `immediate: true` to bypass the debounce just once.
  const thresholdInputNode = new ManualInputNode<number>(NoOutput, {
    type: "debounce",
    wait: 100,
  });
  thresholdInputNode.setValue(DEFAULT_THRESHOLD, true);
  const sizeRangeInputNode = new ManualInputNode<TSizeRange>(NoOutput, {
    type: "debounce",
    wait: 100,
  });
  sizeRangeInputNode.setValue({ ...DEFAULT_SIZE_RANGE }, true);
  const simplificationToleranceInputNode = new ManualInputNode<number>(
    NoOutput,
    { type: "debounce", wait: 100 },
  );
  simplificationToleranceInputNode.setValue(
    DEFAULT_SIMPLIFICATION_TOLERANCE,
    true,
  );

  const screenshotNode = createComputeNode(
    withErrorReporting(screenshot, reportError),
    [geoJSMapInputNode],
  );
  const downscaleNode = createComputeNode(
    withErrorReporting(downscaleScreenshot, reportError),
    [screenshotNode],
  );
  const setImageNode = createComputeNode(
    withErrorReporting(async (workingImage: IWorkingImage) => {
      await workerClient.setImage(
        workingImage.rgba,
        workingImage.width,
        workingImage.height,
      );
      return toWorkerImageInfo(workingImage);
    }, reportError),
    [downscaleNode],
  );

  // Reference to the last examples array this node has processed, used to
  // tell "examples changed" (real retrain) apart from "only the screenshot
  // changed" (cheap re-predict with the cached model) - see spec §3/§4.5.
  // ManualInputNode.setValue is always called with a fresh array by callers
  // (AnnotationViewer pushes a new array on add/undo/clear/polarity change),
  // so reference identity is a reliable signal here.
  let lastExamples: IExampleSegmentationExample[] | null = null;
  async function trainPredictAsync(
    examples: IExampleSegmentationExample[],
    examplesChanged: boolean,
    workerImage: IWorkerImageInfo,
    mapEntry: IMapEntry,
  ): Promise<ISegmentationResultResponse> {
    const workerExamples: IWorkerExample[] = examplesChanged
      ? examples.map((example) =>
          convertExampleToWorkingCoords(example, mapEntry, workerImage),
        )
      : [];
    const response = await workerClient.trainPredict(
      workerExamples,
      currentPostprocessParams(),
    );
    modelState.trained = response.hasModel;
    return response;
  }
  const trainPredictWithErrorReporting = withErrorReporting(
    trainPredictAsync,
    reportError,
  );
  // Not declared async: the early-return branch below must resolve to the
  // literal NoOutput sentinel (spec §3: "if no forest exists yet, the node
  // outputs NoOutput"), not a resolved promise, so ComputeNode's parent-type
  // plumbing (Promise<T> | T | TNoOutput | Promise<TNoOutput>) matches.
  function trainPredict(
    examples: IExampleSegmentationExample[],
    workerImage: IWorkerImageInfo,
    mapEntry: IMapEntry,
  ): Promise<ISegmentationResultResponse> | TNoOutput {
    const examplesChanged = examples !== lastExamples;
    lastExamples = examples;
    if (examples.length === 0 && !modelState.trained) {
      // Nothing to train on, and no cached model to re-predict with.
      return NoOutput;
    }
    return trainPredictWithErrorReporting(
      examples,
      examplesChanged,
      workerImage,
      mapEntry,
    );
  }
  const trainPredictNode = createComputeNode(trainPredict, [
    examplesInputNode,
    setImageNode,
    geoJSMapInputNode,
  ]);

  function currentPostprocessParams(): IPostprocessParams {
    const threshold = readManualInputOr(thresholdInputNode, DEFAULT_THRESHOLD);
    const sizeRange = readManualInputOr(sizeRangeInputNode, DEFAULT_SIZE_RANGE);
    return { threshold, minArea: sizeRange.min, maxArea: sizeRange.max };
  }

  // Cheap, re-runnable post-processing (threshold/CC/size filter/contour
  // trace) on the worker's cached probability map - no retrain. Triggered
  // either by threshold/sizeRange changing, or by a fresh trainPredict
  // result (in which case this re-issues the same params trainPredict
  // already used; a small redundant call, kept for simplicity).
  async function postprocess(
    _trainResult: ISegmentationResultResponse,
    threshold: number,
    sizeRange: TSizeRange,
  ): Promise<ISegmentationResultResponse> {
    return workerClient.postprocess({
      threshold,
      minArea: sizeRange.min,
      maxArea: sizeRange.max,
    });
  }
  const postprocessNode = createComputeNode(
    withErrorReporting(postprocess, reportError),
    [trainPredictNode, thresholdInputNode, sizeRangeInputNode],
  );

  async function computeProposals(
    postprocessResult: ISegmentationResultResponse,
    workerImage: IWorkerImageInfo,
    mapEntry: IMapEntry,
    simplificationTolerance: number,
  ): Promise<IProposalsOutput> {
    const gcsPolygons = postprocessResult.contours.map((contour) =>
      convertContourToGcs(
        contour,
        mapEntry,
        workerImage,
        simplificationTolerance,
      ),
    );
    const proposals = await dedupeProposalsAgainstAnnotations(
      gcsPolygons,
      toolConfiguration,
    );
    return {
      proposals,
      componentCount: postprocessResult.componentCount,
      autoSizeRange: postprocessResult.autoSizeRange,
      timings: postprocessResult.timings,
    };
  }
  const proposalsNode = createComputeNode(
    withErrorReporting(computeProposals, reportError),
    [
      postprocessNode,
      setImageNode,
      geoJSMapInputNode,
      simplificationToleranceInputNode,
    ],
  );

  return {
    allNodes: [
      screenshotNode,
      downscaleNode,
      setImageNode,
      trainPredictNode,
      postprocessNode,
      proposalsNode,
    ],
    input: {
      geoJSMap: geoJSMapInputNode,
      examples: examplesInputNode,
      threshold: thresholdInputNode,
      sizeRange: sizeRangeInputNode,
      simplificationTolerance: simplificationToleranceInputNode,
    },
    output: {
      proposals: proposalsNode,
    },
    reset: async () => {
      lastExamples = null;
      modelState.trained = false;
      await workerClient.reset();
    },
  };
}

export function createExampleSegmentationToolStateFromToolConfiguration(
  configuration: IToolConfiguration<"exampleSegmentation">,
): IExampleSegmentationToolState | IErrorToolState {
  // reactive() ensures that pipeline callbacks (which capture `state` in
  // closures) mutate through Vue's Proxy, making changes visible to the UI -
  // same rationale as createSamToolStateFromToolConfiguration.
  const state = reactive({
    type: ExampleSegmentationToolStateSymbol as typeof ExampleSegmentationToolStateSymbol,
    nodes: null as unknown as TExampleSegmentationNodes,
    mapEntry: null as IExampleSegmentationToolState["mapEntry"],
    examples: [] as IExampleSegmentationExample[],
    proposals: null as IExampleSegmentationToolState["proposals"],
    nextPolarity: "foreground" as IExampleSegmentationToolState["nextPolarity"],
    status: {
      phase: "idle",
      putativeCount: 0,
      timings: {},
    } as IExampleSegmentationStatus,
  }) as unknown as IExampleSegmentationToolState;

  const reportError = (error: Error) => {
    state.status = {
      phase: "error",
      error: error.message,
      putativeCount: 0,
      timings: {},
    };
  };

  let nodes: TExampleSegmentationNodes;
  try {
    // markRaw prevents Vue 3 from wrapping pipeline nodes in reactive
    // Proxies - see createSamToolStateFromToolConfiguration for why.
    nodes = markRaw(
      createExampleSegmentationPipeline(configuration, reportError),
    );
  } catch (error) {
    return { type: ErrorToolStateSymbol, error: error as Error };
  }
  state.nodes = nodes;

  // Mirror geoJSMap output to the reactive state.mapEntry property, same
  // pattern as createSamToolStateFromToolConfiguration.
  const geoJSMapNode = nodes.input.geoJSMap;
  geoJSMapNode.onOutputUpdate(() => {
    const mapOutput = geoJSMapNode.output;
    state.mapEntry = !mapOutput || mapOutput === NoOutput ? null : mapOutput;
  });

  // Mirror the examples input node so AnnotationViewer's watcher can render
  // example outlines from reactive state rather than the markRaw'd node.
  const examplesNode = nodes.input.examples;
  examplesNode.onOutputUpdate(() => {
    const examplesOutput = examplesNode.output;
    state.examples = examplesOutput === NoOutput ? [] : examplesOutput;
  });

  // Proposals + status are reactive.
  const proposalsNode = nodes.output.proposals;
  proposalsNode.onOutputUpdate(() => {
    const rawOutput = proposalsNode.output as IProposalsOutput | TNoOutput;
    if (!rawOutput || rawOutput === NoOutput) {
      state.proposals = null;
      return;
    }
    state.proposals = rawOutput.proposals;
    state.status = {
      phase: "ready",
      putativeCount: rawOutput.proposals.length,
      timings: rawOutput.timings,
      autoSizeRange: rawOutput.autoSizeRange,
    };
  });

  // Registered after the mirrors above so that, when a node's output update
  // fires all callbacks in order, this one reads the already-mirrored
  // state.proposals rather than a stale value.
  const { allNodes } = nodes;
  const recomputeComputingPhase = () => {
    const isComputing = allNodes.some((node) => node.isComputing);
    if (isComputing) {
      state.status = { ...state.status, phase: "computing" };
    } else if (state.status.phase === "computing") {
      state.status = {
        ...state.status,
        phase: state.proposals === null ? "idle" : "ready",
      };
    }
  };
  allNodes.forEach((node) => node.onOutputUpdate(recomputeComputingPhase));

  return state;
}

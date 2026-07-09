/**
 * Compute pipeline for the unified "Segment similar objects" tool. The user
 * picks example objects by one of several SELECTION methods (SAM click, SAM
 * box, freehand circle) and propagates them to the rest of the current view
 * by one of two APPLICATION methods (SAM-embedding similarity search, or an
 * in-browser random-forest classifier). Any selection method combines with
 * any application method because both branches consume the same resolved
 * example set.
 *
 * See codebaseDocumentation/EXAMPLE_SEGMENTATION_TOOL.md (§11 for the SAM
 * similarity core, §4 for the classifier core, §12 for the unification).
 * Reuses samPipeline.ts's encoder/decoder machinery and
 * exampleSegmentation.worker.ts's classifier (via workerClient) rather than
 * sharing live tool instances - this pipeline builds its own node chains.
 *
 * Node graph:
 *   geoJSMap -> screenshot -> processCanvas -> runEncoder -> embeddingGrid
 *   (examples + embeddingGrid + decoder) -> exampleDescriptors   [SHARED: resolves
 *       every example to a GCS polygon, decoding SAM prompts; both branches use it]
 *   -- SAM branch (applicationMethod === "samSimilarity") --
 *   (exampleDescriptors + embeddingGrid + promptMode) -> candidates
 *   (candidates + decoder + exampleDescriptors) -> decodeCandidates [staleness/progress/streaming]
 *   (decodeCandidates + exampleDescriptors + threshold/size/simplification) -> samProposals
 *   -- Classifier branch (applicationMethod === "classifier") --
 *   screenshot -> downscale -> setImage (worker)
 *   (exampleDescriptors.decodedExamples + setImage) -> trainPredict -> postprocess -> classifierProposals
 * Each branch's first gated node returns NoOutput when its method is inactive,
 * so only the active branch computes. The state factory mirrors whichever
 * branch's proposals node is active into state.proposals.
 */
import { markRaw, reactive } from "vue";
import geojs from "geojs";
import { InferenceSession } from "onnxruntime-web/webgpu";
import {
  ErrorToolStateSymbol,
  IErrorToolState,
  IGeoJSPosition,
  IMapEntry,
  IObjectSegmentationExample,
  IObjectSegmentationStatus,
  IObjectSegmentationToolState,
  IToolConfiguration,
  PromptType,
  ObjectSegmentationToolStateSymbol,
  TObjectApplicationMethod,
  TSamPrompt,
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
import {
  IDecoderOutput,
  IEncoderOutput,
  IProcessCanvasOutput,
  ISamDecoderContext,
  TSamModel,
  createDecoderContext,
  createDecoderSession,
  createEncoderContext,
  createEncoderSession,
  displayToWorld,
  isSam2Model,
  processCanvas,
  processPrompt,
  rescaleMaskToDisplayCoords,
  runDecoder,
  runEncoder,
  runItkPipeline,
  screenshot,
  simplifyCoordinates,
} from "./samPipeline";
import {
  IEmbeddingGrid,
  computeSimilarityMap,
  findSimilarityPeaks,
  maskIoU,
  meanMaskSimilarity,
  normalizeEmbeddingCells,
  poolDescriptor,
  polygonToCellMask,
  scoreDescriptor,
} from "@/utils/samSimilarity/embedding";
import { rasterizePolygon } from "@/utils/exampleSegmentation/rasterize";
import { dedupeProposalsAgainstAnnotations } from "@/utils/proposalDedupe";
import { simpleCentroid } from "@/utils/annotation";
import { ExampleSegmentationWorkerClient } from "@/utils/exampleSegmentation/workerClient";
import {
  IPostprocessParams,
  ISegmentationResultResponse,
  IWorkerExample,
  IWorkerPoint,
} from "@/utils/exampleSegmentation/types";

// See §11.6: score(f) = max_i cos(f, positives[i]) - negativeWeight * max_j cos(f, negatives[j]).
const NEGATIVE_WEIGHT = 0.5;
// Peak-prompt threshold = PEAK_THRESHOLD_FACTOR * mean example self-similarity (§11.3 step 4a).
const PEAK_THRESHOLD_FACTOR = 0.6;
const PEAK_MAX_COUNT = 64;
const PEAK_MIN_SEPARATION = 1.5;
// Decoder confidence gate applied at decode time (not user-adjustable, so
// baking it into the decode node - rather than the re-runnable tail - does
// not defeat the "no redecode on slider move" requirement).
const IOU_PREDICTION_MIN = 0.7;
const NMS_IOU_MAX = 0.6;
const EXAMPLE_OVERLAP_IOU_MAX = 0.5;
const SIZE_AUTO_MIN_FACTOR = 0.25;
const SIZE_AUTO_MAX_FACTOR = 4;
const DEFAULT_GRID_SCAN_SIZE = 16;
// Guardrails for the user-configurable grid density (grid prompt mode): the
// scan decodes gridSize^2 points, so cap it to keep decode time sane.
const MIN_GRID_SCAN_SIZE = 2;
const MAX_GRID_SCAN_SIZE = 48;
// "Stream results ... every ~8 candidates" (§11.4).
const PROGRESS_STREAM_INTERVAL = 8;
const MODEL_INPUT_CELL_PX = 16;

const DEFAULT_SIMILARITY_THRESHOLD = 0.5;
type TPromptMode = "point" | "box" | "grid";
const DEFAULT_PROMPT_MODE: TPromptMode = "point";
type TSizeRange = { min: number | null; max: number | null };
const DEFAULT_SIZE_RANGE: TSizeRange = { min: null, max: null };
const DEFAULT_SIMPLIFICATION_TOLERANCE = 1;

// Shape of the `examples` input node's elements: unlike the reactive
// state's IObjectSegmentationExample, the input carries no decoded polygon (that
// is produced by the example-decode node and mirrored into state.examples).
// Exactly one of `prompt`/`polygon` is set (enforced by this discriminated
// union on `prompt`): a `prompt` example is decoded by SAM at
// example-descriptor time ("Click" input mode); a `polygon` example (`prompt:
// null`, "Circle" input mode) is already-final and rasterized directly onto
// the embedding grid with no decoder run (§11 addendum).
type TObjectSegmentationExampleInput = {
  polarity: "foreground" | "background";
} & (
  | { prompt: TSamPrompt; polygon?: undefined }
  | { prompt: null; polygon: IGeoJSPosition[] }
);

/** Median of a numeric array; 0 for an empty array. */
function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** Shoelace polygon area, in GCS (image-native pixel) units. */
function polygonAreaGcs(polygon: IGeoJSPosition[]): number {
  if (polygon.length < 3) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < polygon.length; ++i) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/** The GCS point representing an example's prompt, for containment checks. */
function getPromptAnchorGcs(prompt: TSamPrompt): IGeoJSPosition {
  switch (prompt.type) {
    case PromptType.foregroundPoint:
    case PromptType.backgroundPoint:
      return prompt.point;
    case PromptType.box:
      return {
        x: (prompt.topLeft.x + prompt.bottomRight.x) / 2,
        y: (prompt.topLeft.y + prompt.bottomRight.y) / 2,
      };
  }
}

interface IEmbeddingGridState {
  grid: IEmbeddingGrid;
  normalizedData: Float32Array;
}

// ---- Classifier branch helpers (ported from exampleSegmentationPipeline.ts) ----

// All classifier worker computation happens in this "working" resolution.
const MAX_WORKING_DIMENSION = 1024;

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

interface IWorkerImageInfo {
  width: number;
  height: number;
  srcWidth: number;
  srcHeight: number;
  xScale: number;
  yScale: number;
}

/**
 * Downscales the screenshot canvas so its long side is at most
 * MAX_WORKING_DIMENSION and extracts its RGBA pixels (classifier spec §3).
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
    throw new Error("Can't create canvas context for object segmentation");
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

function toWorkerImageInfo(workingImage: IWorkingImage): IWorkerImageInfo {
  const { width, height, srcWidth, srcHeight, xScale, yScale } = workingImage;
  return { width, height, srcWidth, srcHeight, xScale, yScale };
}

/**
 * Converts a resolved example's GCS polygon into working-pixel coordinates
 * for the classifier worker. Unlike exampleSegmentationPipeline's version
 * (which read a raw circled polygon), this reads the resolved `polygon`, so a
 * SAM-clicked or boxed example feeds the classifier just as a circled one does.
 */
function resolvedExampleToWorkerCoords(
  polygonGcs: IGeoJSPosition[],
  polarity: "foreground" | "background",
  { map }: IMapEntry,
  workerImage: IWorkerImageInfo,
): IWorkerExample {
  const displayPoints = map.gcsToDisplay(polygonGcs);
  return {
    polarity,
    points: displayPoints.map(({ x, y }) => ({
      x: x * workerImage.xScale,
      y: y * workerImage.yScale,
    })),
  };
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

/**
 * Wraps the encoder's grid embedding tensor (1, C, H, W) into an
 * IEmbeddingGrid and pre-normalizes its cells (§11.2/§11.3 step 2).
 * validGridWidth/Height are derived from the processCanvas output's
 * scaledWidth/scaledHeight (the source image occupies the top-left
 * scaledWidth x scaledHeight of the padded model input; everything beyond
 * that is padding, see samPipeline.ts processCanvas), clamped to the
 * tensor's own grid dimensions.
 *
 * The grid embedding is named differently per model family (see
 * SAM2_MIGRATION.md): SAM2's encoder emits `image_embed` (alongside
 * high_res_feats_*), while SAM1/vit_b emits the equivalent tensor as
 * `image_embeddings`. Both are the same 64x64x256-style grid this tool
 * operates on, so we accept either name.
 */
function computeEmbeddingGridState(
  encoderOutput: IEncoderOutput,
  canvasInfo: IProcessCanvasOutput,
): IEmbeddingGridState {
  const embedTensor =
    encoderOutput.image_embed ?? encoderOutput.image_embeddings;
  if (!embedTensor) {
    throw new Error(
      "SAM encoder produced no grid embedding tensor " +
        `(expected image_embed or image_embeddings; got keys: ` +
        `${Object.keys(encoderOutput).join(", ")})`,
    );
  }
  const channels = embedTensor.dims[1];
  const gridHeight = embedTensor.dims[2];
  const gridWidth = embedTensor.dims[3];
  const validGridWidth = Math.min(
    gridWidth,
    Math.ceil(canvasInfo.scaledWidth / MODEL_INPUT_CELL_PX),
  );
  const validGridHeight = Math.min(
    gridHeight,
    Math.ceil(canvasInfo.scaledHeight / MODEL_INPUT_CELL_PX),
  );
  const grid: IEmbeddingGrid = {
    data: embedTensor.data as Float32Array,
    channels,
    gridWidth,
    gridHeight,
    validGridWidth,
    validGridHeight,
  };
  return { grid, normalizedData: normalizeEmbeddingCells(grid) };
}

/**
 * Converts a decoded mask polygon (display/source-image px, as produced by
 * samPipeline's runItkPipeline + SAM1/SAM2 coordinate handling) into a
 * 64x64-style embedding-grid cell mask: display px -> model-input px
 * (multiply by the processCanvas scale) -> /16 -> grid cell coords.
 */
function displayPolygonToCellMask(
  polygonDisplay: IGeoJSPosition[],
  canvasInfo: IProcessCanvasOutput,
  grid: IEmbeddingGrid,
): Uint8Array {
  return polygonToCellMask(
    displayPolygonToCellPoints(polygonDisplay, canvasInfo),
    grid.gridWidth,
    grid.gridHeight,
  );
}

function displayPolygonToCellPoints(
  polygonDisplay: IGeoJSPosition[],
  canvasInfo: IProcessCanvasOutput,
): { x: number; y: number }[] {
  const xScale = canvasInfo.scaledWidth / canvasInfo.srcWidth;
  const yScale = canvasInfo.scaledHeight / canvasInfo.srcHeight;
  return polygonDisplay.map(({ x, y }) => ({
    x: (x * xScale) / MODEL_INPUT_CELL_PX,
    y: (y * yScale) / MODEL_INPUT_CELL_PX,
  }));
}

function cellPolygonIntersectsValidGrid(
  points: { x: number; y: number }[],
  grid: IEmbeddingGrid,
): boolean {
  if (points.length === 0) {
    return false;
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return (
    maxX >= 0 &&
    maxY >= 0 &&
    minX < grid.validGridWidth &&
    minY < grid.validGridHeight
  );
}

// True if the mask sets any cell inside the valid (on-screen, non-padding)
// region of the grid.
function maskHasCellInValidGrid(
  mask: Uint8Array,
  grid: IEmbeddingGrid,
): boolean {
  for (let row = 0; row < grid.validGridHeight; ++row) {
    const rowOffset = row * grid.gridWidth;
    for (let col = 0; col < grid.validGridWidth; ++col) {
      if (mask[rowOffset + col]) {
        return true;
      }
    }
  }
  return false;
}

// Current-encode cell mask for an example, or null when the example isn't
// meaningfully in view. Unlike displayPolygonToCellMask (which delegates to
// polygonToCellMask), this deliberately does NOT use the centroid-clamp
// fallback: rasterizePolygon clips out-of-bounds points, and the sub-cell
// fallback below only fires when the centroid genuinely lands in the valid
// grid. So an example whose bounding box merely grazes the grid - the case the
// cheap AABB pre-check can't rule out - returns null instead of a fabricated
// clamped edge cell that would poison overlap dedupe / box sizing.
function displayPolygonToVisibleCellMask(
  polygonDisplay: IGeoJSPosition[],
  canvasInfo: IProcessCanvasOutput,
  grid: IEmbeddingGrid,
): Uint8Array | null {
  const cellPoints = displayPolygonToCellPoints(polygonDisplay, canvasInfo);
  if (!cellPolygonIntersectsValidGrid(cellPoints, grid)) {
    return null;
  }
  const mask = rasterizePolygon(cellPoints, grid.gridWidth, grid.gridHeight);
  if (maskHasCellInValidGrid(mask, grid)) {
    return mask;
  }
  // Sub-cell polygon (too small to cover a cell center): mark its centroid
  // cell, but only when that centroid falls inside the valid grid.
  let sumX = 0;
  let sumY = 0;
  for (const point of cellPoints) {
    sumX += point.x;
    sumY += point.y;
  }
  const cellX = Math.floor(sumX / cellPoints.length);
  const cellY = Math.floor(sumY / cellPoints.length);
  if (
    cellX < 0 ||
    cellY < 0 ||
    cellX >= grid.validGridWidth ||
    cellY >= grid.validGridHeight
  ) {
    return null;
  }
  mask[cellY * grid.gridWidth + cellX] = 1;
  return mask;
}

/** Model-input px (0..1024ish) -> GCS, inverse of the processCanvas scale. */
function modelInputPxToGcs(
  modelX: number,
  modelY: number,
  canvasInfo: IProcessCanvasOutput,
  mapEntry: IMapEntry,
): IGeoJSPosition {
  const displayX = modelX * (canvasInfo.srcWidth / canvasInfo.scaledWidth);
  const displayY = modelY * (canvasInfo.srcHeight / canvasInfo.scaledHeight);
  return displayToWorld([{ x: displayX, y: displayY }], mapEntry)[0];
}

/**
 * Runs the decoder for a single prompt and returns its mask polygon in
 * display/source-image coordinates plus its iou_predictions confidence (if
 * the model exposes one), reusing samPipeline's exported encoder/decoder
 * helpers and the same SAM1-vs-SAM2 mask-coordinate handling as
 * createSamPipelineDecoderNodes (SAM2 masks are at a fixed resolution and
 * need rescaling; SAM1 masks are already display coords via orig_im_size).
 */
async function decodePromptToDisplayPolygon(
  model: TSamModel,
  prompt: TSamPrompt,
  canvasInfo: IProcessCanvasOutput,
  decoderContext: ISamDecoderContext,
  decoderSession: InferenceSession,
  encoderOutput: IEncoderOutput,
  mapEntry: IMapEntry,
): Promise<{ polygonDisplay: IGeoJSPosition[]; iouPrediction: number | null }> {
  const promptFeed = processPrompt(
    [prompt],
    canvasInfo,
    decoderContext,
    mapEntry,
  );
  const decoderOutput: IDecoderOutput = await runDecoder(
    decoderSession,
    promptFeed,
    encoderOutput,
  );
  const rawPolygon = await runItkPipeline(decoderOutput);
  const polygonDisplay = isSam2Model(model)
    ? rescaleMaskToDisplayCoords(rawPolygon, canvasInfo, decoderOutput)
    : rawPolygon;
  const iouData = decoderOutput.iou_predictions?.data;
  const iouPrediction = iouData && iouData.length > 0 ? iouData[0] : null;
  return { polygonDisplay, iouPrediction };
}

interface ICellBoundingBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function cellMaskBoundingBox(
  mask: Uint8Array,
  gridWidth: number,
  gridHeight: number,
): ICellBoundingBox | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let y = 0; y < gridHeight; ++y) {
    const rowOffset = y * gridWidth;
    for (let x = 0; x < gridWidth; ++x) {
      if (mask[rowOffset + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { minX, minY, maxX, maxY };
}

/**
 * Half-width/height (in model-input px) of a box sized to the median
 * foreground example's bounding box (§11.3 step 4b). Masks come from the
 * current encode for visible examples, with captured masks as the fallback for
 * examples outside the current viewport.
 */
function medianExampleBoxHalfExtentPx(
  cellMasks: Uint8Array[],
  grid: IEmbeddingGrid,
): { halfWidthPx: number; halfHeightPx: number } | null {
  const widths: number[] = [];
  const heights: number[] = [];
  for (const mask of cellMasks) {
    const bbox = cellMaskBoundingBox(mask, grid.gridWidth, grid.gridHeight);
    if (!bbox) {
      continue;
    }
    widths.push(bbox.maxX - bbox.minX + 1);
    heights.push(bbox.maxY - bbox.minY + 1);
  }
  if (widths.length === 0) {
    return null;
  }
  return {
    halfWidthPx: (median(widths) * MODEL_INPUT_CELL_PX) / 2,
    halfHeightPx: (median(heights) * MODEL_INPUT_CELL_PX) / 2,
  };
}

// The cache stores the expensive prompt decode plus the example's captured
// appearance descriptor. The descriptor is intentionally reused across
// pan/zoom: it is the reference object signature. Current-view masks are
// recomputed separately only for geometry tasks such as example-overlap dedupe.
interface IExampleDescriptorCacheEntry {
  polygonGcs: IGeoJSPosition[];
  promptAnchorGcs: IGeoJSPosition;
  descriptor: Float32Array | null;
  selfSimilarity: number;
  captureCellMask: Uint8Array;
}

interface IExampleDescriptorsOutput {
  positives: Float32Array[];
  negatives: Float32Array[];
  // Calibration reference for thresholds (§11.6): mean, over foreground
  // examples only, of each example's own mask-mean similarity to its own
  // descriptor.
  meanSelfSimilarity: number;
  exampleCellMasks: Uint8Array[]; // foreground only, current view - "already segmented" dedupe set
  exampleBoxCellMasks: Uint8Array[]; // foreground only - box-prompt sizing basis
  exampleAreasGcs: number[]; // foreground only - auto size-range basis
  examplePromptAnchorsGcs: IGeoJSPosition[]; // foreground only
  decodedExamples: IObjectSegmentationExample[]; // full input order, incl. background
}

interface IScoredCandidate {
  polygonGcs: IGeoJSPosition[]; // unsimplified; simplification applied in the tail
  cellMask: Uint8Array;
  score: number;
}

interface IProposalsResult {
  proposals: IGeoJSPosition[][];
  autoSizeRange: { min: number; max: number } | null;
  // Superset covering both branches (SAM encode/decode + classifier
  // features/train/predict/postprocess), matching the reactive status shape.
  timings: IObjectSegmentationStatus["timings"];
}

interface IHybridTrainingInput {
  ready: boolean;
  proposals: IGeoJSPosition[][];
}

function hybridTrainingPending(): IHybridTrainingInput {
  return { ready: false, proposals: [] };
}

function hybridTrainingReady(
  proposals: IGeoJSPosition[][] = [],
): IHybridTrainingInput {
  return { ready: true, proposals };
}

export type TObjectSegmentationNodes = {
  allNodes: ComputeNode<any, any>[];
  input: {
    geoJSMap: ManualInputNode<IMapEntry | TNoOutput>;
    examples: ManualInputNode<TObjectSegmentationExampleInput[]>;
    // Gates the two propagation branches (see the branch-gate nodes).
    applicationMethod: ManualInputNode<TObjectApplicationMethod>;
    similarityThreshold: ManualInputNode<number>;
    promptMode: ManualInputNode<TPromptMode>;
    // Grid density for grid prompt mode (gridSize x gridSize scan points).
    gridSize: ManualInputNode<number>;
    // SAM-proposal training polygons for the chained "samThenClassifier" mode;
    // populated by the state factory's SAM-proposals mirror.
    hybridTraining: ManualInputNode<IHybridTrainingInput>;
    sizeRange: ManualInputNode<TSizeRange>;
    simplificationTolerance: ManualInputNode<number>;
    // Hover live-preview prompt (SAM selection modes only); debounced set by
    // AnnotationViewer's mousemove handler / drag-preview path.
    previewPrompt: ManualInputNode<TSamPrompt | TNoOutput>;
  };
  output: {
    // The two propagation branches' proposal nodes; the state factory mirrors
    // whichever matches the active applicationMethod into state.proposals.
    samProposals: ComputeNode<any, any>;
    classifierProposals: ComputeNode<any, any>;
    // Exposed so the state factory can mirror resolved example polygons into
    // state.examples using the same onOutputUpdate pattern as every other
    // mirror.
    examples: ComputeNode<any, any>;
    // Hover live-preview outline, mirrored into state.livePreview the same way.
    livePreview: ComputeNode<any, any>;
  };
  // Clears the descriptor cache and internal timings; re-arms the "no
  // examples yet" guard by clearing the examples input (same role as
  // exampleSegmentationPipeline's reset).
  reset: () => Promise<void>;
};

function createObjectSegmentationPipeline(
  toolConfiguration: IToolConfiguration<"objectSegmentation">,
  model: TSamModel,
  reportError: (error: Error) => void,
  reportProgress: (progress: { done: number; total: number } | null) => void,
  reportPartialProposals: (partial: IProposalsResult) => void,
  reportLoadingMessages: (messages: string[]) => void,
): TObjectSegmentationNodes {
  if (!("gpu" in navigator)) {
    // The tool requires WebGPU for both application methods in v1 (the SAM
    // encoder resolves example prompts even when the classifier propagates
    // them). See EXAMPLE_SEGMENTATION_TOOL.md §12.
    throw new Error(
      "Can't initialize the segmentation tool: WebGPU not available " +
        "(Chrome only for now)",
    );
  }

  // Per-pipeline-instance state (must not be module-level: multiple tool
  // instances/configurations can coexist).
  const exampleDescriptorCache = new Map<
    TObjectSegmentationExampleInput,
    IExampleDescriptorCacheEntry
  >();
  const timingsState: IObjectSegmentationStatus["timings"] = {};
  // Classifier branch worker + its "has a trained model" guard (mirrors
  // exampleSegmentationPipeline's modelState). Constructed eagerly but idle
  // until the classifier branch runs setImage/trainPredict.
  const workerClient = new ExampleSegmentationWorkerClient();
  const classifierModelState = { trained: false };

  const modelNameNode = new ManualInputNode(model);
  const geoJSMapInputNode = new ManualInputNode<IMapEntry | TNoOutput>(
    NoOutput,
    {
      type: "debounce",
      wait: 1000,
      options: { leading: false, trailing: true },
    },
  );
  const examplesInputNode = new ManualInputNode<
    TObjectSegmentationExampleInput[]
  >([]);
  // Which application method is active; gates the two propagation branches.
  const applicationMethodInputNode =
    new ManualInputNode<TObjectApplicationMethod>("samSimilarity");
  const promptModeInputNode = new ManualInputNode<TPromptMode>(
    DEFAULT_PROMPT_MODE,
  );
  // Grid density for grid prompt mode (gridSize x gridSize scan points).
  const gridSizeInputNode = new ManualInputNode<number>(DEFAULT_GRID_SCAN_SIZE);
  // Extra foreground training polygons for the classifier, in GCS. In chained
  // "samThenClassifier" mode this is marked pending while SAM is still finding
  // proposals, so the classifier cannot publish an intermediate user-examples
  // only result. In plain classifier mode the value is ignored.
  const hybridTrainingInputNode = new ManualInputNode<IHybridTrainingInput>(
    hybridTrainingReady(),
  );
  const similarityThresholdInputNode = new ManualInputNode<number>(NoOutput, {
    type: "debounce",
    wait: 100,
  });
  similarityThresholdInputNode.setValue(DEFAULT_SIMILARITY_THRESHOLD, true);
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
  // Hover live-preview prompt (feature A): debounced like samPipeline's own
  // preview decoder graph (createSamPipelineDecoderNodes's previewNodes).
  const previewPromptInputNode = new ManualInputNode<TSamPrompt | TNoOutput>(
    NoOutput,
    { type: "debounce", wait: 100 },
  );

  // --- Encoder chain: mirrors samPipeline's createSamPipelineEncoderNodes,
  // built from the exported helpers rather than sharing a live SAM node
  // graph (a SAM tool instance may not even exist).
  const contextNode = createComputeNode(
    withErrorReporting(createEncoderContext, reportError),
    [modelNameNode],
  );
  const sessionNode = createComputeNode(
    withErrorReporting(createEncoderSession, reportError),
    [modelNameNode],
  );
  const screenshotNode = createComputeNode(
    withErrorReporting(screenshot, reportError),
    [geoJSMapInputNode],
  );
  const preprocessNode = createComputeNode(
    withErrorReporting(processCanvas, reportError),
    [screenshotNode, contextNode],
  );
  async function timedRunEncoder(
    encoderSession: InferenceSession,
    input: IProcessCanvasOutput,
  ): Promise<IEncoderOutput> {
    const start = performance.now();
    const result = await runEncoder(encoderSession, input);
    timingsState.encodeMs = performance.now() - start;
    return result;
  }
  const inferenceNode = createComputeNode(
    withErrorReporting(timedRunEncoder, reportError),
    [sessionNode, preprocessNode],
  );

  // --- Embedding grid: computed once per encode (§11.4).
  const embeddingGridNode = createComputeNode(
    withErrorReporting(computeEmbeddingGridState, reportError),
    [inferenceNode, preprocessNode],
  );

  // --- Decoder infra (constant context + session, keyed by model).
  const decoderContextNode = new ManualInputNode(createDecoderContext());
  const decoderSessionNode = createComputeNode(
    withErrorReporting(createDecoderSession, reportError),
    [modelNameNode],
  );

  // --- Hover live-preview decode (feature A): decodes previewPromptInputNode
  // and converts straight to a GCS outline, mirroring
  // decodePromptToDisplayPolygon + displayToWorld + simplifyCoordinates from
  // samPipeline's own preview decoder graph. Deliberately NOT added to
  // `allNodes` below: allNodes drives status.phase's "computing" indicator,
  // and a debounced hover preview firing on every mouse-move must not make
  // the status line flicker into "Computing..." the way a real
  // examples/candidates recompute does.
  async function computePreviewOutlineInner(
    previewPrompt: TSamPrompt,
    canvasInfo: IProcessCanvasOutput,
    encoderOutput: IEncoderOutput,
    decoderSession: InferenceSession,
    decoderContext: ISamDecoderContext,
    mapEntry: IMapEntry,
  ): Promise<IGeoJSPosition[]> {
    const { polygonDisplay } = await decodePromptToDisplayPolygon(
      model,
      previewPrompt,
      canvasInfo,
      decoderContext,
      decoderSession,
      encoderOutput,
      mapEntry,
    );
    const polygonGcs = displayToWorld(polygonDisplay, mapEntry);
    return simplifyCoordinates(
      polygonGcs,
      readManualInputOr(
        simplificationToleranceInputNode,
        DEFAULT_SIMPLIFICATION_TOLERANCE,
      ),
    );
  }
  const computePreviewOutlineWithErrorReporting = withErrorReporting(
    computePreviewOutlineInner,
    reportError,
  );
  function computePreviewOutline(
    previewPrompt: TSamPrompt | TNoOutput,
    canvasInfo: IProcessCanvasOutput,
    encoderOutput: IEncoderOutput,
    decoderSession: InferenceSession,
    decoderContext: ISamDecoderContext,
    mapEntry: IMapEntry,
  ): Promise<IGeoJSPosition[]> | TNoOutput {
    if (previewPrompt === NoOutput) {
      return NoOutput;
    }
    return computePreviewOutlineWithErrorReporting(
      previewPrompt,
      canvasInfo,
      encoderOutput,
      decoderSession,
      decoderContext,
      mapEntry,
    );
  }
  const previewOutlineNode = createComputeNode(computePreviewOutline, [
    previewPromptInputNode,
    preprocessNode,
    inferenceNode,
    decoderSessionNode,
    decoderContextNode,
    geoJSMapInputNode,
  ]);

  // --- Example-decode node: maintains exampleDescriptorCache keyed by
  // example object reference (ManualInputNode.setValue is always called
  // with a fresh array by callers, so reference identity is a reliable
  // per-element cache key, same convention as
  // exampleSegmentationPipeline.ts's lastExamples check).
  //
  // The cache holds the SAM-decoded object outline in GCS plus the example's
  // descriptor from the encode where it was captured. That descriptor is the
  // durable appearance signature used by the SAM-similarity branch after
  // pan/zoom. Current-view cell masks are recomputed below only when the GCS
  // polygon intersects the current encode, so off-screen examples cannot be
  // clamped into bogus edge cells.
  async function computeExampleDescriptors(
    examples: TObjectSegmentationExampleInput[],
    embeddingGridState: IEmbeddingGridState,
    canvasInfo: IProcessCanvasOutput,
    decoderSession: InferenceSession,
    decoderContext: ISamDecoderContext,
    encoderOutput: IEncoderOutput,
    mapEntry: IMapEntry,
  ): Promise<IExampleDescriptorsOutput> {
    const { grid, normalizedData } = embeddingGridState;
    const decodedExamples: IObjectSegmentationExample[] = [];
    // Pass 1: ensure each example's viewpoint-invariant outline is cached. Only
    // the SAM decode (prompt examples) is expensive; circled examples are
    // already authoritative GCS polygons and need no decode.
    for (const example of examples) {
      if (!exampleDescriptorCache.has(example)) {
        let polygonGcs: IGeoJSPosition[];
        let promptAnchorGcs: IGeoJSPosition;
        let polygonDisplay: IGeoJSPosition[];
        if (example.prompt === null) {
          // Circled example (§11 addendum): the polygon is authoritative and
          // already in GCS - skip the decoder entirely.
          polygonGcs = example.polygon;
          promptAnchorGcs = simpleCentroid(polygonGcs);
          polygonDisplay = mapEntry.map.gcsToDisplay(polygonGcs);
        } else {
          const decoded = await decodePromptToDisplayPolygon(
            model,
            example.prompt,
            canvasInfo,
            decoderContext,
            decoderSession,
            encoderOutput,
            mapEntry,
          );
          polygonDisplay = decoded.polygonDisplay;
          polygonGcs = displayToWorld(polygonDisplay, mapEntry);
          promptAnchorGcs = getPromptAnchorGcs(example.prompt);
        }
        const captureCellMask = displayPolygonToCellMask(
          polygonDisplay,
          canvasInfo,
          grid,
        );
        const descriptor = poolDescriptor(
          normalizedData,
          grid,
          captureCellMask,
        );
        const selfSimilarity = descriptor
          ? meanMaskSimilarity(
              normalizedData,
              grid,
              captureCellMask,
              descriptor,
            )
          : 0;
        exampleDescriptorCache.set(example, {
          polygonGcs,
          promptAnchorGcs,
          descriptor,
          selfSimilarity,
          captureCellMask,
        });
      }
      const entry = exampleDescriptorCache.get(
        example,
      ) as IExampleDescriptorCacheEntry;
      decodedExamples.push({
        polarity: example.polarity,
        prompt: example.prompt,
        polygon: entry.polygonGcs,
      });
    }

    // Pass 2: reuse captured descriptors for matching, and recompute only
    // geometry masks that are meaningful in the CURRENT encode.
    const positives: Float32Array[] = [];
    const negatives: Float32Array[] = [];
    const foregroundSelfSimilarities: number[] = [];
    const exampleCellMasks: Uint8Array[] = [];
    const exampleBoxCellMasks: Uint8Array[] = [];
    const exampleAreasGcs: number[] = [];
    const examplePromptAnchorsGcs: IGeoJSPosition[] = [];
    for (const example of examples) {
      // Guaranteed set by pass 1.
      const entry = exampleDescriptorCache.get(
        example,
      ) as IExampleDescriptorCacheEntry;
      if (!entry.descriptor) {
        continue;
      }
      const polygonDisplay = mapEntry.map.gcsToDisplay(entry.polygonGcs);
      const currentCellMask = displayPolygonToVisibleCellMask(
        polygonDisplay,
        canvasInfo,
        grid,
      );
      if (example.polarity === "foreground") {
        positives.push(entry.descriptor);
        foregroundSelfSimilarities.push(entry.selfSimilarity);
        if (currentCellMask) {
          exampleCellMasks.push(currentCellMask);
          exampleBoxCellMasks.push(currentCellMask);
        } else {
          // Off-screen example: fall back to the capture-time mask so box
          // sizing still has a sample. KNOWN LIMITATION: that mask is in the
          // cell scale of the encode where the example was captured, so if the
          // user has since zoomed, medianExampleBoxHalfExtentPx can mix cell
          // scales across on-screen (current) and off-screen (captured) masks
          // and mis-size the prompt box. Acceptable for a sizing heuristic;
          // see EXAMPLE_SEGMENTATION_TOOL.md §11.3 step 4b.
          exampleBoxCellMasks.push(entry.captureCellMask);
        }
        exampleAreasGcs.push(polygonAreaGcs(entry.polygonGcs));
        examplePromptAnchorsGcs.push(entry.promptAnchorGcs);
      } else {
        negatives.push(entry.descriptor);
      }
    }
    const meanSelfSimilarity =
      foregroundSelfSimilarities.length > 0
        ? foregroundSelfSimilarities.reduce((a, b) => a + b, 0) /
          foregroundSelfSimilarities.length
        : 0;

    return {
      positives,
      negatives,
      meanSelfSimilarity,
      exampleCellMasks,
      exampleBoxCellMasks,
      exampleAreasGcs,
      examplePromptAnchorsGcs,
      decodedExamples,
    };
  }
  const exampleDescriptorsNode = createComputeNode(
    withErrorReporting(computeExampleDescriptors, reportError),
    [
      examplesInputNode,
      embeddingGridNode,
      preprocessNode,
      decoderSessionNode,
      decoderContextNode,
      inferenceNode,
      geoJSMapInputNode,
    ],
  );

  // --- Candidate prompt generation (§11.3 step 4). NoOutput when there are
  // no foreground examples to search for (candidatesNode's own function is
  // NOT wrapped in withErrorReporting directly - see decodeCandidates below
  // for why an outer plain function is needed when NoOutput is a possible
  // return value).
  function generateCandidatePromptsInner(
    exampleDescriptors: IExampleDescriptorsOutput,
    embeddingGridState: IEmbeddingGridState,
    canvasInfo: IProcessCanvasOutput,
    promptMode: TPromptMode,
    mapEntry: IMapEntry,
    gridSize: number,
  ): TSamPrompt[] {
    const { grid, normalizedData } = embeddingGridState;

    if (promptMode === "grid") {
      // Thorough mode: uniform gridSize x gridSize scan, no similarity
      // pre-filter - candidates are filtered after decoding (§11.3 step 4c).
      const scan = Math.max(
        MIN_GRID_SCAN_SIZE,
        Math.min(MAX_GRID_SCAN_SIZE, Math.round(gridSize)),
      );
      const prompts: TSamPrompt[] = [];
      const regionWidthPx = grid.validGridWidth * MODEL_INPUT_CELL_PX;
      const regionHeightPx = grid.validGridHeight * MODEL_INPUT_CELL_PX;
      for (let row = 0; row < scan; ++row) {
        for (let col = 0; col < scan; ++col) {
          const modelX = ((col + 0.5) / scan) * regionWidthPx;
          const modelY = ((row + 0.5) / scan) * regionHeightPx;
          prompts.push({
            type: PromptType.foregroundPoint,
            point: modelInputPxToGcs(modelX, modelY, canvasInfo, mapEntry),
          });
        }
      }
      return prompts;
    }

    const similarityMap = computeSimilarityMap(
      normalizedData,
      grid,
      exampleDescriptors.positives,
      exampleDescriptors.negatives,
      NEGATIVE_WEIGHT,
    );
    const peakThreshold =
      PEAK_THRESHOLD_FACTOR * exampleDescriptors.meanSelfSimilarity;
    const peaks = findSimilarityPeaks(
      similarityMap,
      grid.gridWidth,
      grid.gridHeight,
      peakThreshold,
      PEAK_MAX_COUNT,
      PEAK_MIN_SEPARATION,
    );
    const boxHalfExtent =
      promptMode === "box"
        ? medianExampleBoxHalfExtentPx(
            exampleDescriptors.exampleBoxCellMasks,
            grid,
          )
        : null;

    return peaks.map((peak) => {
      const modelX = peak.cellX * MODEL_INPUT_CELL_PX + MODEL_INPUT_CELL_PX / 2;
      const modelY = peak.cellY * MODEL_INPUT_CELL_PX + MODEL_INPUT_CELL_PX / 2;
      if (boxHalfExtent) {
        return {
          type: PromptType.box,
          topLeft: modelInputPxToGcs(
            modelX - boxHalfExtent.halfWidthPx,
            modelY - boxHalfExtent.halfHeightPx,
            canvasInfo,
            mapEntry,
          ),
          bottomRight: modelInputPxToGcs(
            modelX + boxHalfExtent.halfWidthPx,
            modelY + boxHalfExtent.halfHeightPx,
            canvasInfo,
            mapEntry,
          ),
        };
      }
      return {
        type: PromptType.foregroundPoint,
        point: modelInputPxToGcs(modelX, modelY, canvasInfo, mapEntry),
      };
    });
  }
  const generateCandidatePromptsWithErrorReporting = withErrorReporting(
    generateCandidatePromptsInner,
    reportError,
  );
  function generateCandidatePrompts(
    exampleDescriptors: IExampleDescriptorsOutput,
    embeddingGridState: IEmbeddingGridState,
    canvasInfo: IProcessCanvasOutput,
    promptMode: TPromptMode,
    mapEntry: IMapEntry,
    applicationMethod: TObjectApplicationMethod,
    gridSize: number,
  ): Promise<TSamPrompt[]> | TNoOutput {
    // Branch gate: the entire SAM candidate/decode/proposals tail hangs off
    // this node, so returning NoOutput here idles it whenever SAM isn't part
    // of the active method. SAM runs for "samSimilarity" and for the chained
    // "samThenClassifier" (whose classifier trains on the SAM proposals).
    if (
      applicationMethod !== "samSimilarity" &&
      applicationMethod !== "samThenClassifier"
    ) {
      return NoOutput;
    }
    if (exampleDescriptors.positives.length === 0) {
      return NoOutput;
    }
    return generateCandidatePromptsWithErrorReporting(
      exampleDescriptors,
      embeddingGridState,
      canvasInfo,
      promptMode,
      mapEntry,
      gridSize,
    );
  }
  const candidatesNode = createComputeNode(generateCandidatePrompts, [
    exampleDescriptorsNode,
    embeddingGridNode,
    preprocessNode,
    promptModeInputNode,
    geoJSMapInputNode,
    applicationMethodInputNode,
    gridSizeInputNode,
  ]);

  /**
   * Shared verify/NMS/size-filter/dedupe tail (§11.3 steps 5-6), used both
   * by the cheap re-runnable tail ComputeNode (with the full candidate
   * list) and by decodeCandidates' progress streaming (with the
   * candidates verified so far), so the two never diverge in behavior.
   * similarityThreshold is applied here (not at decode) so moving the
   * slider re-runs only this cheap tail - decodeCandidates' output is the
   * full scored candidate list independent of threshold.
   */
  async function buildProposals(
    scoredCandidates: IScoredCandidate[],
    exampleDescriptors: IExampleDescriptorsOutput,
    similarityThreshold: number,
    sizeRange: TSizeRange,
    simplificationTolerance: number,
  ): Promise<IProposalsResult> {
    const scoreThreshold =
      similarityThreshold * exampleDescriptors.meanSelfSimilarity;
    const passingScore = scoredCandidates.filter(
      (candidate) => candidate.score >= scoreThreshold,
    );

    // Examples are already segmented: drop candidates that re-discover them.
    const notOverlappingExamples = passingScore.filter((candidate) => {
      const overlapsExampleMask = exampleDescriptors.exampleCellMasks.some(
        (exampleMask) =>
          maskIoU(candidate.cellMask, exampleMask) > EXAMPLE_OVERLAP_IOU_MAX,
      );
      if (overlapsExampleMask) {
        return false;
      }
      return !exampleDescriptors.examplePromptAnchorsGcs.some((anchor) =>
        geojs.util.pointInPolygon(anchor, candidate.polygonGcs),
      );
    });

    // Greedy NMS by descending score on the embedding-grid cell masks.
    const sortedByScore = notOverlappingExamples
      .slice()
      .sort((a, b) => b.score - a.score);
    const kept: IScoredCandidate[] = [];
    for (const candidate of sortedByScore) {
      const overlapsKept = kept.some(
        (keptCandidate) =>
          maskIoU(candidate.cellMask, keptCandidate.cellMask) > NMS_IOU_MAX,
      );
      if (!overlapsKept) {
        kept.push(candidate);
      }
    }

    // Size filter: auto range from foreground example areas, or user override.
    const autoSizeRange =
      exampleDescriptors.exampleAreasGcs.length > 0
        ? {
            min:
              SIZE_AUTO_MIN_FACTOR * median(exampleDescriptors.exampleAreasGcs),
            max:
              SIZE_AUTO_MAX_FACTOR * median(exampleDescriptors.exampleAreasGcs),
          }
        : null;
    const effectiveMin = sizeRange.min ?? autoSizeRange?.min ?? -Infinity;
    const effectiveMax = sizeRange.max ?? autoSizeRange?.max ?? Infinity;
    const sizeFiltered = kept.filter((candidate) => {
      const area = polygonAreaGcs(candidate.polygonGcs);
      return area >= effectiveMin && area <= effectiveMax;
    });

    const simplified = sizeFiltered.map((candidate) =>
      simplifyCoordinates(candidate.polygonGcs, simplificationTolerance),
    );
    const proposals = await dedupeProposalsAgainstAnnotations(
      simplified,
      toolConfiguration,
    );
    return { proposals, autoSizeRange, timings: { ...timingsState } };
  }

  // --- Decode-candidates node (§11.4): sequentially decodes each
  // candidate prompt (WebGPU sessions are already serialized per-session by
  // runOnnxSessionSerialized). Three concerns beyond a normal ComputeNode:
  //
  // STALENESS: rather than a run-token counter, this checks direct parent
  // reference equality (`candidatesNode.output !== candidates`) after every
  // candidate. Because ComputeNode.compute()'s do-while loop is fully
  // sequential (it never invokes this node's function twice concurrently -
  // a second call only ever starts after the first one's promise settles),
  // there is no re-entrant call to detect; the actual risk is candidatesNode
  // producing a *new* value (even transiently NoOutput, which ComputeNode
  // always publishes at the start of every recompute) while we are mid-loop
  // on an old one. Checking reference identity against the exact array we
  // were called with detects that immediately and lets us stop early
  // instead of finishing all K decodes on data that's about to be
  // discarded. We simply stop the loop and return whatever was verified so
  // far as NoOutput-via-early-return is unnecessary: ComputeNode's own
  // shouldRecompute flag is already set in this scenario (a parent changed
  // while `this.computing` was true), so the do-while loop immediately
  // re-runs with fresh candidates once this call resolves - our early
  // return is purely a performance optimization, never a correctness
  // requirement, and needs no special-cased error swallowing.
  //
  // PROGRESS: `reportProgress` (injected, mirrors into reactive
  // state.status.progress) is called after every candidate.
  //
  // STREAMING: every PROGRESS_STREAM_INTERVAL candidates, `buildProposals`
  // is re-run on the candidates verified so far and the result is pushed
  // via `reportPartialProposals` (mirrors into state.proposals early, before
  // the full batch finishes) - see §11.4's "stream results... every ~8
  // candidates" requirement.
  async function decodeCandidatesInner(
    candidates: TSamPrompt[],
    embeddingGridState: IEmbeddingGridState,
    canvasInfo: IProcessCanvasOutput,
    encoderOutput: IEncoderOutput,
    decoderSession: InferenceSession,
    decoderContext: ISamDecoderContext,
    mapEntry: IMapEntry,
    exampleDescriptors: IExampleDescriptorsOutput,
  ): Promise<IScoredCandidate[]> {
    const start = performance.now();
    const { grid, normalizedData } = embeddingGridState;
    const total = candidates.length;
    const results: IScoredCandidate[] = [];
    for (let i = 0; i < total; ++i) {
      if (candidatesNode.output !== candidates) {
        break; // superseded - a fresh run will redo this with new candidates
      }
      const prompt = candidates[i];
      const { polygonDisplay, iouPrediction } =
        await decodePromptToDisplayPolygon(
          model,
          prompt,
          canvasInfo,
          decoderContext,
          decoderSession,
          encoderOutput,
          mapEntry,
        );
      const passesIou =
        iouPrediction === null || iouPrediction >= IOU_PREDICTION_MIN;
      if (passesIou && polygonDisplay.length > 0) {
        const cellMask = displayPolygonToCellMask(
          polygonDisplay,
          canvasInfo,
          grid,
        );
        const descriptor = poolDescriptor(normalizedData, grid, cellMask);
        if (descriptor) {
          const score = scoreDescriptor(
            descriptor,
            exampleDescriptors.positives,
            exampleDescriptors.negatives,
            NEGATIVE_WEIGHT,
          );
          results.push({
            polygonGcs: displayToWorld(polygonDisplay, mapEntry),
            cellMask,
            score,
          });
        }
      }
      reportProgress({ done: i + 1, total });
      if ((i + 1) % PROGRESS_STREAM_INTERVAL === 0) {
        reportPartialProposals(
          await buildProposals(
            results,
            exampleDescriptors,
            readManualInputOr(
              similarityThresholdInputNode,
              DEFAULT_SIMILARITY_THRESHOLD,
            ),
            readManualInputOr(sizeRangeInputNode, DEFAULT_SIZE_RANGE),
            readManualInputOr(
              simplificationToleranceInputNode,
              DEFAULT_SIMPLIFICATION_TOLERANCE,
            ),
          ),
        );
      }
    }
    timingsState.decodeMs = performance.now() - start;
    return results;
  }
  const decodeCandidatesInnerWithErrorReporting = withErrorReporting(
    decodeCandidatesInner,
    reportError,
  );
  function decodeCandidates(
    candidates: TSamPrompt[],
    embeddingGridState: IEmbeddingGridState,
    canvasInfo: IProcessCanvasOutput,
    encoderOutput: IEncoderOutput,
    decoderSession: InferenceSession,
    decoderContext: ISamDecoderContext,
    mapEntry: IMapEntry,
    exampleDescriptors: IExampleDescriptorsOutput,
  ): Promise<IScoredCandidate[]> | TNoOutput {
    if (candidates.length === 0) {
      return NoOutput;
    }
    reportProgress({ done: 0, total: candidates.length });
    return decodeCandidatesInnerWithErrorReporting(
      candidates,
      embeddingGridState,
      canvasInfo,
      encoderOutput,
      decoderSession,
      decoderContext,
      mapEntry,
      exampleDescriptors,
    );
  }
  const decodeCandidatesNode = createComputeNode(decodeCandidates, [
    candidatesNode,
    embeddingGridNode,
    preprocessNode,
    inferenceNode,
    decoderSessionNode,
    decoderContextNode,
    geoJSMapInputNode,
    exampleDescriptorsNode,
  ]);

  // --- Verify/NMS/proposals tail: cheap, re-runs on
  // threshold/size/simplification change WITHOUT re-decoding.
  const proposalsNode = createComputeNode(
    withErrorReporting(buildProposals, reportError),
    [
      decodeCandidatesNode,
      exampleDescriptorsNode,
      similarityThresholdInputNode,
      sizeRangeInputNode,
      simplificationToleranceInputNode,
    ],
  );

  // --- Classifier branch (applicationMethod === "classifier"). Reuses the
  // shared screenshotNode and the resolved example polygons from
  // exampleDescriptorsNode; only the propagation step differs from the SAM
  // branch. Ported from exampleSegmentationPipeline.ts.
  function currentPostprocessParams(): IPostprocessParams {
    const threshold = readManualInputOr(
      similarityThresholdInputNode,
      DEFAULT_SIMILARITY_THRESHOLD,
    );
    const sizeRange = readManualInputOr(sizeRangeInputNode, DEFAULT_SIZE_RANGE);
    return { threshold, minArea: sizeRange.min, maxArea: sizeRange.max };
  }

  const downscaleWithErrorReporting = withErrorReporting(
    downscaleScreenshot,
    reportError,
  );
  // Not wrapped in withErrorReporting at the call site: the gate's NoOutput
  // early-return must reach ComputeNode as the literal sentinel (same reason
  // as generateCandidatePrompts above).
  function gatedDownscale(
    canvas: HTMLCanvasElement,
    applicationMethod: TObjectApplicationMethod,
  ): Promise<IWorkingImage> | TNoOutput {
    // Branch gate: idles the whole classifier tail (setImage/train/predict/
    // proposals) when the classifier isn't part of the active method, and
    // avoids the worker doing feature extraction it won't use. The classifier
    // runs for "classifier" and for the chained "samThenClassifier".
    if (
      applicationMethod !== "classifier" &&
      applicationMethod !== "samThenClassifier"
    ) {
      return NoOutput;
    }
    return downscaleWithErrorReporting(canvas);
  }
  const downscaleNode = createComputeNode(gatedDownscale, [
    screenshotNode,
    applicationMethodInputNode,
  ]);
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

  // Retrain vs re-predict: the forest is retrained whenever the training-set
  // reference changes (examplesChanged below) and re-predicts with the cached
  // forest otherwise. The user's example set changes by reference only on
  // add/undo/clear/polarity, but the hybrid SAM-proposal set is re-sent as a
  // fresh array each encode (and SAM re-runs on pan), so in classifier and
  // samThenClassifier modes the forest is intentionally retrained on every
  // re-encode/pan. Coordinates come from the resolved polygons so SAM-clicked
  // examples train the classifier just like circled ones.
  let lastClassifierExamples: TObjectSegmentationExampleInput[] | null = null;
  let lastHybridTraining: IGeoJSPosition[][] | null = null;
  let lastClassifierApplicationMethod: TObjectApplicationMethod | null = null;
  async function classifierTrainPredictAsync(
    descriptors: IExampleDescriptorsOutput,
    hybridTraining: IGeoJSPosition[][],
    examplesChanged: boolean,
    workerImage: IWorkerImageInfo,
    mapEntry: IMapEntry,
  ): Promise<ISegmentationResultResponse> {
    let workerExamples: IWorkerExample[] = [];
    if (examplesChanged) {
      workerExamples = descriptors.decodedExamples
        .filter((ex) => ex.polygon && ex.polygon.length >= 3)
        .map((ex) =>
          resolvedExampleToWorkerCoords(
            ex.polygon as IGeoJSPosition[],
            ex.polarity,
            mapEntry,
            workerImage,
          ),
        );
      // Chained "samThenClassifier": SAM's proposals become extra foreground
      // training, so the classifier generalizes from everything SAM found.
      for (const polygon of hybridTraining) {
        if (polygon && polygon.length >= 3) {
          workerExamples.push(
            resolvedExampleToWorkerCoords(
              polygon,
              "foreground",
              mapEntry,
              workerImage,
            ),
          );
        }
      }
    }
    const response = await workerClient.trainPredict(
      workerExamples,
      currentPostprocessParams(),
    );
    classifierModelState.trained = response.hasModel;
    timingsState.featuresMs = response.timings.featuresMs;
    timingsState.trainMs = response.timings.trainMs;
    timingsState.predictMs = response.timings.predictMs;
    timingsState.postprocessMs = response.timings.postprocessMs;
    return response;
  }
  const classifierTrainPredictWithErrorReporting = withErrorReporting(
    classifierTrainPredictAsync,
    reportError,
  );
  // Not async: the early-return branch must resolve to the literal NoOutput
  // sentinel (see exampleSegmentationPipeline's trainPredict).
  function classifierTrainPredict(
    rawExamples: TObjectSegmentationExampleInput[],
    descriptors: IExampleDescriptorsOutput,
    hybridTraining: IHybridTrainingInput,
    workerImage: IWorkerImageInfo,
    mapEntry: IMapEntry,
    applicationMethod: TObjectApplicationMethod,
  ): Promise<ISegmentationResultResponse> | TNoOutput {
    if (applicationMethod === "samThenClassifier" && !hybridTraining.ready) {
      return NoOutput;
    }
    const hybridPolygons =
      applicationMethod === "samThenClassifier" ? hybridTraining.proposals : [];
    // Retrain when the user's examples, the hybrid SAM-proposal training set,
    // or the application method changes. hybridPolygons is a fresh array each
    // encode (the `: []` literal in plain classifier mode, genuinely-new SAM
    // proposals in hybrid mode), so this is intentionally true on every
    // re-encode/pan - the forest retrains rather than re-predicting.
    const examplesChanged =
      rawExamples !== lastClassifierExamples ||
      hybridPolygons !== lastHybridTraining ||
      applicationMethod !== lastClassifierApplicationMethod;
    lastClassifierExamples = rawExamples;
    lastHybridTraining = hybridPolygons;
    lastClassifierApplicationMethod = applicationMethod;
    if (
      rawExamples.length === 0 &&
      hybridPolygons.length === 0 &&
      !classifierModelState.trained
    ) {
      return NoOutput;
    }
    return classifierTrainPredictWithErrorReporting(
      descriptors,
      hybridPolygons,
      examplesChanged,
      workerImage,
      mapEntry,
    );
  }
  const classifierTrainPredictNode = createComputeNode(classifierTrainPredict, [
    examplesInputNode,
    exampleDescriptorsNode,
    hybridTrainingInputNode,
    setImageNode,
    geoJSMapInputNode,
    applicationMethodInputNode,
  ]);

  async function classifierPostprocess(
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
  const classifierPostprocessNode = createComputeNode(
    withErrorReporting(classifierPostprocess, reportError),
    [
      classifierTrainPredictNode,
      similarityThresholdInputNode,
      sizeRangeInputNode,
    ],
  );

  async function classifierComputeProposals(
    postprocessResult: ISegmentationResultResponse,
    workerImage: IWorkerImageInfo,
    mapEntry: IMapEntry,
    simplificationTolerance: number,
  ): Promise<IProposalsResult> {
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
      autoSizeRange: postprocessResult.autoSizeRange,
      timings: { ...timingsState },
    };
  }
  const classifierProposalsNode = createComputeNode(
    withErrorReporting(classifierComputeProposals, reportError),
    [
      classifierPostprocessNode,
      setImageNode,
      geoJSMapInputNode,
      simplificationToleranceInputNode,
    ],
  );

  // In-viewer progress labels: mirror samPipeline's loadingMessages pattern,
  // mapping the long-running nodes to user-facing strings so the encode and
  // segment phases surface as "as we do normally" overlay notifications. The
  // order here is the display order (roughly the compute order). previewOutline
  // is deliberately excluded, same rationale as its exclusion from allNodes.
  const computingMessageMap: [ComputeNode<any, any>, string][] = [
    [sessionNode, "Loading SAM encoder…"],
    [decoderSessionNode, "Loading SAM decoder…"],
    [inferenceNode, "SAM encoding…"],
    [exampleDescriptorsNode, "Analyzing examples…"],
    [decodeCandidatesNode, "SAM segmenting…"],
    [classifierTrainPredictNode, "Training classifier…"],
    [classifierProposalsNode, "Classifying…"],
  ];
  const recomputeLoadingMessages = () => {
    reportLoadingMessages(
      computingMessageMap
        .filter(([node]) => node.isComputing)
        .map(([, message]) => message),
    );
  };
  computingMessageMap.forEach(([node]) => {
    node.onOutputUpdate(recomputeLoadingMessages);
  });

  return {
    // previewOutlineNode is intentionally excluded (see its declaration
    // comment): it must not affect status.phase's "computing" indicator.
    allNodes: [
      screenshotNode,
      preprocessNode,
      inferenceNode,
      embeddingGridNode,
      exampleDescriptorsNode,
      candidatesNode,
      decodeCandidatesNode,
      proposalsNode,
      downscaleNode,
      setImageNode,
      classifierTrainPredictNode,
      classifierPostprocessNode,
      classifierProposalsNode,
    ],
    input: {
      geoJSMap: geoJSMapInputNode,
      examples: examplesInputNode,
      applicationMethod: applicationMethodInputNode,
      similarityThreshold: similarityThresholdInputNode,
      promptMode: promptModeInputNode,
      gridSize: gridSizeInputNode,
      hybridTraining: hybridTrainingInputNode,
      sizeRange: sizeRangeInputNode,
      simplificationTolerance: simplificationToleranceInputNode,
      previewPrompt: previewPromptInputNode,
    },
    output: {
      // SAM-branch and classifier-branch proposal nodes; the state factory
      // mirrors whichever matches the active applicationMethod.
      samProposals: proposalsNode,
      classifierProposals: classifierProposalsNode,
      examples: exampleDescriptorsNode,
      livePreview: previewOutlineNode,
    },
    reset: async () => {
      exampleDescriptorCache.clear();
      timingsState.encodeMs = undefined;
      timingsState.decodeMs = undefined;
      timingsState.featuresMs = undefined;
      timingsState.trainMs = undefined;
      timingsState.predictMs = undefined;
      timingsState.postprocessMs = undefined;
      lastClassifierExamples = null;
      lastHybridTraining = null;
      lastClassifierApplicationMethod = null;
      classifierModelState.trained = false;
      reportProgress(null);
      await workerClient.reset();
      await hybridTrainingInputNode.setValue(hybridTrainingReady(), true);
      await examplesInputNode.setValue([], true);
      await previewPromptInputNode.setValue(NoOutput, true);
    },
  };
}

export function createObjectSegmentationToolStateFromToolConfiguration(
  configuration: IToolConfiguration<"objectSegmentation">,
): IObjectSegmentationToolState | IErrorToolState {
  const model: TSamModel = configuration.values.model.value;

  // reactive() ensures that pipeline callbacks (which capture `state` in
  // closures) mutate through Vue's Proxy, making changes visible to the UI -
  // same rationale as createSamToolStateFromToolConfiguration /
  // createExampleSegmentationToolStateFromToolConfiguration.
  const state = reactive({
    type: ObjectSegmentationToolStateSymbol as typeof ObjectSegmentationToolStateSymbol,
    nodes: null as unknown as TObjectSegmentationNodes,
    mapEntry: null as IObjectSegmentationToolState["mapEntry"],
    examples: [] as IObjectSegmentationExample[],
    proposals: null as IObjectSegmentationToolState["proposals"],
    nextPolarity: "foreground" as IObjectSegmentationToolState["nextPolarity"],
    status: {
      phase: "idle",
      putativeCount: 0,
      progress: null,
      timings: {},
    } as IObjectSegmentationStatus,
    selectionMode: "samClick" as IObjectSegmentationToolState["selectionMode"],
    applicationMethod:
      "samSimilarity" as IObjectSegmentationToolState["applicationMethod"],
    scope: "viewport" as IObjectSegmentationToolState["scope"],
    livePreview: null as IObjectSegmentationToolState["livePreview"],
    loadingMessages: [] as string[],
  }) as unknown as IObjectSegmentationToolState;

  const reportError = (error: Error) => {
    state.status = {
      phase: "error",
      error: error.message,
      putativeCount: 0,
      progress: null,
      timings: {},
    };
  };
  // Merges status updates while a run is in flight. `error` is always
  // dropped here (not spread) so a stale message from a previous failed run
  // can never leak into a subsequent successful one - reportError is the
  // only place that sets it.
  const mergeStatus = (overrides: Partial<IObjectSegmentationStatus>) => {
    state.status = { ...state.status, error: undefined, ...overrides };
  };
  const reportProgress = (progress: { done: number; total: number } | null) => {
    mergeStatus({ progress });
  };
  // Streaming SAM partials (pushed from decodeCandidatesInner every
  // PROGRESS_STREAM_INTERVAL candidates) are the SAM branch's early preview.
  // Mirror them into the displayed/committable proposal state only when SAM is
  // the displayed branch — the same gate the samProposals mirror uses below.
  // In "samThenClassifier" the SAM proposals are merely the classifier's
  // training input and the displayed final output must be the classifier's, so
  // streaming them here would let the user Accept intermediate SAM results
  // before the classifier has run.
  const reportPartialProposals = (partial: IProposalsResult) => {
    if (state.applicationMethod !== "samSimilarity") {
      return;
    }
    state.proposals = partial.proposals;
    mergeStatus({
      putativeCount: partial.proposals.length,
      autoSizeRange: partial.autoSizeRange,
      timings: partial.timings,
    });
  };
  const reportLoadingMessages = (messages: string[]) => {
    state.loadingMessages = messages;
  };

  let nodes: TObjectSegmentationNodes;
  try {
    // markRaw prevents Vue 3 from wrapping pipeline nodes in reactive
    // Proxies - see createSamToolStateFromToolConfiguration for why.
    nodes = markRaw(
      createObjectSegmentationPipeline(
        configuration,
        model,
        reportError,
        reportProgress,
        reportPartialProposals,
        reportLoadingMessages,
      ),
    );
  } catch (error) {
    return { type: ErrorToolStateSymbol, error: error as Error };
  }
  state.nodes = nodes;

  // Mirror geoJSMap output to the reactive state.mapEntry property, same
  // pattern as the other two tool state factories.
  const geoJSMapNode = nodes.input.geoJSMap;
  geoJSMapNode.onOutputUpdate(() => {
    const mapOutput = geoJSMapNode.output;
    state.mapEntry = !mapOutput || mapOutput === NoOutput ? null : mapOutput;
  });

  // Mirror decoded examples (nodes.output.examples, i.e. the
  // exampleDescriptors node's `decodedExamples` field) into state.examples,
  // so AnnotationViewer's watcher can render example outlines from reactive
  // state rather than the markRaw'd node.
  const examplesOutputNode = nodes.output.examples;
  examplesOutputNode.onOutputUpdate(() => {
    const rawOutput = examplesOutputNode.output as
      | IExampleDescriptorsOutput
      | TNoOutput;
    // Ignore the transient NoOutput that ComputeNode publishes at the START of
    // every recompute (and when a parent is momentarily NoOutput). Clearing
    // state.examples on it made the example outlines flicker away on every
    // re-encode / method switch and only reappear once the recompute settled.
    // A genuine clear produces a real output with decodedExamples: [] (the
    // examples input is emptied), which still updates correctly.
    if (!rawOutput || rawOutput === NoOutput) {
      return;
    }
    state.examples = rawOutput.decodedExamples;
  });

  // Mirror the hover live-preview outline (feature A) into state.livePreview,
  // same pattern as ISamAnnotationToolState.livePreview in samPipeline.ts.
  const livePreviewOutputNode = nodes.output.livePreview;
  livePreviewOutputNode.onOutputUpdate(() => {
    const rawOutput = livePreviewOutputNode.output as
      | IGeoJSPosition[]
      | TNoOutput;
    state.livePreview =
      !rawOutput || rawOutput === NoOutput || rawOutput.length <= 0
        ? null
        : rawOutput;
  });

  // Proposals + status are reactive. Both branches' proposal nodes are
  // mirrored, but each mirror only writes when the active method displays that
  // branch - so the idle branch (which publishes NoOutput while gated off)
  // can't clear the displayed proposals. The SAM branch is displayed only in
  // "samSimilarity"; the classifier branch is displayed in "classifier" AND in
  // the chained "samThenClassifier" (whose final output is the classifier's).
  const makeProposalsMirror = (
    proposalsNode: ComputeNode<any, any>,
    displayedFor: (method: TObjectApplicationMethod) => boolean,
  ) => {
    proposalsNode.onOutputUpdate(() => {
      if (!displayedFor(state.applicationMethod)) {
        return;
      }
      const rawOutput = proposalsNode.output as IProposalsResult | TNoOutput;
      if (!rawOutput || rawOutput === NoOutput) {
        state.proposals = null;
        return;
      }
      state.proposals = rawOutput.proposals;
      mergeStatus({
        phase: "ready",
        progress: null,
        putativeCount: rawOutput.proposals.length,
        autoSizeRange: rawOutput.autoSizeRange,
        timings: rawOutput.timings,
      });
    });
  };
  makeProposalsMirror(
    nodes.output.samProposals,
    (method) => method === "samSimilarity",
  );
  makeProposalsMirror(
    nodes.output.classifierProposals,
    (method) => method === "classifier" || method === "samThenClassifier",
  );

  // Chained "samThenClassifier": feed the SAM branch's proposals into the
  // classifier's hybrid-training input so the classifier trains on everything
  // SAM found. Ignore the transient NoOutput at recompute start (keep the last
  // training set until SAM settles).
  const samProposalsNode = nodes.output.samProposals;
  samProposalsNode.onOutputUpdate(() => {
    if (nodes.input.applicationMethod.output !== "samThenClassifier") {
      return;
    }
    const rawOutput = samProposalsNode.output as IProposalsResult | TNoOutput;
    if (!rawOutput || rawOutput === NoOutput) {
      nodes.input.hybridTraining.setValue(
        samProposalsNode.isComputing
          ? hybridTrainingPending()
          : hybridTrainingReady(),
      );
      return;
    }
    nodes.input.hybridTraining.setValue(
      hybridTrainingReady(rawOutput.proposals),
    );
  });

  // Mirror the applicationMethod input into reactive state, and clear stale
  // proposals on a method switch so the previous branch's results don't linger
  // while the newly-active branch recomputes. Leaving the chained mode also
  // clears the hybrid-training set so the classifier stops training on SAM
  // proposals.
  const applicationMethodNode = nodes.input.applicationMethod;
  applicationMethodNode.onOutputUpdate(() => {
    const method = applicationMethodNode.output;
    if (method === NoOutput) {
      return;
    }
    if (state.applicationMethod !== method) {
      const wasHybrid = state.applicationMethod === "samThenClassifier";
      state.applicationMethod = method;
      state.proposals = null;
      mergeStatus({ putativeCount: 0, progress: null });
      if (method === "samThenClassifier") {
        nodes.input.hybridTraining.setValue(hybridTrainingPending());
      }
      if (wasHybrid && method !== "samThenClassifier") {
        nodes.input.hybridTraining.setValue(hybridTrainingReady());
      }
    }
  });

  // Registered after the mirrors above so that, when a node's output update
  // fires all callbacks in order, this one reads the already-mirrored
  // state.proposals rather than a stale value.
  const { allNodes } = nodes;
  const recomputeComputingPhase = () => {
    const isComputing = allNodes.some((node) => node.isComputing);
    if (isComputing) {
      mergeStatus({ phase: "computing" });
    } else if (state.status.phase === "computing") {
      mergeStatus({ phase: state.proposals === null ? "idle" : "ready" });
    }
  };
  allNodes.forEach((node) => node.onOutputUpdate(recomputeComputingPhase));

  return state;
}

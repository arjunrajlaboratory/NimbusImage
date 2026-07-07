/**
 * Compute pipeline for the SAM-embedding similarity segmentation tool
 * ("Variant B" / shortName "SimSAM"). See
 * codebaseDocumentation/EXAMPLE_SEGMENTATION_TOOL.md §11 for the full spec
 * (normative unless a deviation is called out in §11.7, appended by this
 * implementation).
 *
 * Structure mirrors src/pipelines/exampleSegmentationPipeline.ts (state
 * factory, status phases, error reporting, dedupe, reset) and reuses
 * src/pipelines/samPipeline.ts's encoder/decoder machinery (exported for
 * this purpose) rather than sharing a live SAM tool instance - this pipeline
 * builds its own encoder/decoder node chain from the exported helpers.
 *
 * Node graph (§11.4):
 *   geoJSMap -> screenshot -> processCanvas -> runEncoder -> embeddingGrid
 *   (examples + embeddingGrid + decoder) -> exampleDescriptors
 *   (exampleDescriptors + embeddingGrid + promptMode) -> candidates
 *   (candidates + decoder + exampleDescriptors) -> decodeCandidates [staleness/progress/streaming, see below]
 *   (decodeCandidates + exampleDescriptors + threshold/size/simplification) -> proposals
 */
import { markRaw, reactive } from "vue";
import geojs from "geojs";
import { InferenceSession } from "onnxruntime-web/webgpu";
import {
  ErrorToolStateSymbol,
  IErrorToolState,
  IGeoJSPosition,
  IMapEntry,
  ISamSimilarityExample,
  ISamSimilarityStatus,
  ISamSimilarityToolState,
  IToolConfiguration,
  PromptType,
  SamSimilarityToolStateSymbol,
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
import { dedupeProposalsAgainstAnnotations } from "@/utils/proposalDedupe";
import { simpleCentroid } from "@/utils/annotation";

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
const GRID_SCAN_SIZE = 16;
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
// state's ISamSimilarityExample, the input carries no decoded polygon (that
// is produced by the example-decode node and mirrored into state.examples).
// Exactly one of `prompt`/`polygon` is set (enforced by this discriminated
// union on `prompt`): a `prompt` example is decoded by SAM at
// example-descriptor time ("Click" input mode); a `polygon` example (`prompt:
// null`, "Circle" input mode) is already-final and rasterized directly onto
// the embedding grid with no decoder run (§11 addendum).
type TSamSimilarityExampleInput = { polarity: "foreground" | "background" } & (
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

/**
 * Wraps the encoder's image_embed tensor (1, C, H, W) into an IEmbeddingGrid
 * and pre-normalizes its cells (§11.2/§11.3 step 2). validGridWidth/Height
 * are derived from the processCanvas output's scaledWidth/scaledHeight (the
 * source image occupies the top-left scaledWidth x scaledHeight of the
 * padded model input; everything beyond that is padding, see samPipeline.ts
 * processCanvas), clamped to the tensor's own grid dimensions.
 */
function computeEmbeddingGridState(
  encoderOutput: IEncoderOutput,
  canvasInfo: IProcessCanvasOutput,
): IEmbeddingGridState {
  const embedTensor = encoderOutput.image_embed;
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
  const xScale = canvasInfo.scaledWidth / canvasInfo.srcWidth;
  const yScale = canvasInfo.scaledHeight / canvasInfo.srcHeight;
  const cellPoints = polygonDisplay.map(({ x, y }) => ({
    x: (x * xScale) / MODEL_INPUT_CELL_PX,
    y: (y * yScale) / MODEL_INPUT_CELL_PX,
  }));
  return polygonToCellMask(cellPoints, grid.gridWidth, grid.gridHeight);
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
 * foreground example's bounding box, derived from cached cellMasks (§11.3
 * step 4b). Using cellMask bounding boxes rather than the examples' display
 * polygons keeps the size embedding-space (grid cells), which stays valid
 * across re-encodes/zoom levels the way cached descriptors already do.
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

interface IExampleDescriptorCacheEntry {
  polarity: "foreground" | "background";
  descriptor: Float32Array | null;
  selfSimilarity: number;
  polygonGcs: IGeoJSPosition[];
  cellMask: Uint8Array;
  promptAnchorGcs: IGeoJSPosition;
}

interface IExampleDescriptorsOutput {
  positives: Float32Array[];
  negatives: Float32Array[];
  // Calibration reference for thresholds (§11.6): mean, over foreground
  // examples only, of each example's own mask-mean similarity to its own
  // descriptor.
  meanSelfSimilarity: number;
  exampleCellMasks: Uint8Array[]; // foreground only - "already segmented" dedupe set
  exampleAreasGcs: number[]; // foreground only - auto size-range basis
  examplePromptAnchorsGcs: IGeoJSPosition[]; // foreground only
  decodedExamples: ISamSimilarityExample[]; // full input order, incl. background
}

interface IScoredCandidate {
  polygonGcs: IGeoJSPosition[]; // unsimplified; simplification applied in the tail
  cellMask: Uint8Array;
  score: number;
}

interface IProposalsResult {
  proposals: IGeoJSPosition[][];
  autoSizeRange: { min: number; max: number } | null;
  timings: { encodeMs?: number; decodeMs?: number };
}

export type TSamSimilarityNodes = {
  allNodes: ComputeNode<any, any>[];
  input: {
    geoJSMap: ManualInputNode<IMapEntry | TNoOutput>;
    examples: ManualInputNode<TSamSimilarityExampleInput[]>;
    similarityThreshold: ManualInputNode<number>;
    promptMode: ManualInputNode<TPromptMode>;
    sizeRange: ManualInputNode<TSizeRange>;
    simplificationTolerance: ManualInputNode<number>;
    // Hover live-preview prompt (feature A, click mode only); debounced set
    // by AnnotationViewer's mousemove handler / drag-preview path.
    previewPrompt: ManualInputNode<TSamPrompt | TNoOutput>;
  };
  output: {
    proposals: ComputeNode<any, any>;
    // Not in the original §11.4 sketch: exposed so the state factory can
    // mirror decoded example polygons into state.examples using the same
    // onOutputUpdate pattern as every other mirror (see §11.7 deviations).
    examples: ComputeNode<any, any>;
    // Hover live-preview outline (feature A), mirrored into
    // state.livePreview the same way.
    livePreview: ComputeNode<any, any>;
  };
  // Clears the descriptor cache and internal timings; re-arms the "no
  // examples yet" guard by clearing the examples input (same role as
  // exampleSegmentationPipeline's reset).
  reset: () => Promise<void>;
};

function createSamSimilarityPipeline(
  toolConfiguration: IToolConfiguration<"samSimilarity">,
  model: TSamModel,
  reportError: (error: Error) => void,
  reportProgress: (progress: { done: number; total: number } | null) => void,
  reportPartialProposals: (partial: IProposalsResult) => void,
): TSamSimilarityNodes {
  if (!("gpu" in navigator)) {
    throw new Error(
      "Can't initialize SAM similarity tool: WebGPU not available",
    );
  }

  // Per-pipeline-instance state (must not be module-level: multiple tool
  // instances/configurations can coexist).
  const exampleDescriptorCache = new Map<
    TSamSimilarityExampleInput,
    IExampleDescriptorCacheEntry
  >();
  const timingsState: { encodeMs?: number; decodeMs?: number } = {};

  const modelNameNode = new ManualInputNode(model);
  const geoJSMapInputNode = new ManualInputNode<IMapEntry | TNoOutput>(
    NoOutput,
    {
      type: "debounce",
      wait: 1000,
      options: { leading: false, trailing: true },
    },
  );
  const examplesInputNode = new ManualInputNode<TSamSimilarityExampleInput[]>(
    [],
  );
  const promptModeInputNode = new ManualInputNode<TPromptMode>(
    DEFAULT_PROMPT_MODE,
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
  // exampleSegmentationPipeline.ts's lastExamples check). Cached entries
  // survive pans/re-encodes: descriptors are embedding-space vectors, not
  // pixel coordinates (§11.4).
  async function computeExampleDescriptors(
    examples: TSamSimilarityExampleInput[],
    embeddingGridState: IEmbeddingGridState,
    canvasInfo: IProcessCanvasOutput,
    decoderSession: InferenceSession,
    decoderContext: ISamDecoderContext,
    encoderOutput: IEncoderOutput,
    mapEntry: IMapEntry,
  ): Promise<IExampleDescriptorsOutput> {
    const { grid, normalizedData } = embeddingGridState;
    const decodedExamples: ISamSimilarityExample[] = [];
    for (const example of examples) {
      let entry = exampleDescriptorCache.get(example);
      if (!entry) {
        let polygonGcs: IGeoJSPosition[];
        let cellMask: Uint8Array;
        let promptAnchorGcs: IGeoJSPosition;
        if (example.prompt === null) {
          // Circled example (§11 addendum): the polygon is authoritative and
          // already in GCS - skip the decoder entirely, just rasterize it
          // onto the embedding grid (via display coords, same as a decoded
          // mask) for the descriptor.
          polygonGcs = example.polygon;
          const polygonDisplay = mapEntry.map.gcsToDisplay(polygonGcs);
          cellMask = displayPolygonToCellMask(polygonDisplay, canvasInfo, grid);
          promptAnchorGcs = simpleCentroid(polygonGcs);
        } else {
          const { polygonDisplay } = await decodePromptToDisplayPolygon(
            model,
            example.prompt,
            canvasInfo,
            decoderContext,
            decoderSession,
            encoderOutput,
            mapEntry,
          );
          cellMask = displayPolygonToCellMask(polygonDisplay, canvasInfo, grid);
          polygonGcs = displayToWorld(polygonDisplay, mapEntry);
          promptAnchorGcs = getPromptAnchorGcs(example.prompt);
        }
        const descriptor = poolDescriptor(normalizedData, grid, cellMask);
        const selfSimilarity = descriptor
          ? meanMaskSimilarity(normalizedData, grid, cellMask, descriptor)
          : 0;
        entry = {
          polarity: example.polarity,
          descriptor,
          selfSimilarity,
          polygonGcs,
          cellMask,
          promptAnchorGcs,
        };
        exampleDescriptorCache.set(example, entry);
      }
      decodedExamples.push({
        polarity: example.polarity,
        prompt: example.prompt,
        polygon: entry.polygonGcs,
      });
    }

    const positives: Float32Array[] = [];
    const negatives: Float32Array[] = [];
    const foregroundSelfSimilarities: number[] = [];
    const exampleCellMasks: Uint8Array[] = [];
    const exampleAreasGcs: number[] = [];
    const examplePromptAnchorsGcs: IGeoJSPosition[] = [];
    for (const example of examples) {
      // Guaranteed set by the loop above.
      const entry = exampleDescriptorCache.get(
        example,
      ) as IExampleDescriptorCacheEntry;
      if (!entry.descriptor) {
        continue; // decoder produced an empty mask; nothing to pool
      }
      if (entry.polarity === "foreground") {
        positives.push(entry.descriptor);
        foregroundSelfSimilarities.push(entry.selfSimilarity);
        exampleCellMasks.push(entry.cellMask);
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
  ): TSamPrompt[] {
    const { grid, normalizedData } = embeddingGridState;

    if (promptMode === "grid") {
      // Thorough mode: uniform grid scan, no similarity pre-filter -
      // candidates are filtered after decoding (§11.3 step 4c).
      const prompts: TSamPrompt[] = [];
      const regionWidthPx = grid.validGridWidth * MODEL_INPUT_CELL_PX;
      const regionHeightPx = grid.validGridHeight * MODEL_INPUT_CELL_PX;
      for (let row = 0; row < GRID_SCAN_SIZE; ++row) {
        for (let col = 0; col < GRID_SCAN_SIZE; ++col) {
          const modelX = ((col + 0.5) / GRID_SCAN_SIZE) * regionWidthPx;
          const modelY = ((row + 0.5) / GRID_SCAN_SIZE) * regionHeightPx;
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
            exampleDescriptors.exampleCellMasks,
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
  ): Promise<TSamPrompt[]> | TNoOutput {
    if (exampleDescriptors.positives.length === 0) {
      return NoOutput;
    }
    return generateCandidatePromptsWithErrorReporting(
      exampleDescriptors,
      embeddingGridState,
      canvasInfo,
      promptMode,
      mapEntry,
    );
  }
  const candidatesNode = createComputeNode(generateCandidatePrompts, [
    exampleDescriptorsNode,
    embeddingGridNode,
    preprocessNode,
    promptModeInputNode,
    geoJSMapInputNode,
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
    ],
    input: {
      geoJSMap: geoJSMapInputNode,
      examples: examplesInputNode,
      similarityThreshold: similarityThresholdInputNode,
      promptMode: promptModeInputNode,
      sizeRange: sizeRangeInputNode,
      simplificationTolerance: simplificationToleranceInputNode,
      previewPrompt: previewPromptInputNode,
    },
    output: {
      proposals: proposalsNode,
      examples: exampleDescriptorsNode,
      livePreview: previewOutlineNode,
    },
    reset: async () => {
      exampleDescriptorCache.clear();
      timingsState.encodeMs = undefined;
      timingsState.decodeMs = undefined;
      reportProgress(null);
      await examplesInputNode.setValue([], true);
      await previewPromptInputNode.setValue(NoOutput, true);
    },
  };
}

export function createSamSimilarityToolStateFromToolConfiguration(
  configuration: IToolConfiguration<"samSimilarity">,
): ISamSimilarityToolState | IErrorToolState {
  const model: TSamModel = configuration.values.model.value;

  // reactive() ensures that pipeline callbacks (which capture `state` in
  // closures) mutate through Vue's Proxy, making changes visible to the UI -
  // same rationale as createSamToolStateFromToolConfiguration /
  // createExampleSegmentationToolStateFromToolConfiguration.
  const state = reactive({
    type: SamSimilarityToolStateSymbol as typeof SamSimilarityToolStateSymbol,
    nodes: null as unknown as TSamSimilarityNodes,
    mapEntry: null as ISamSimilarityToolState["mapEntry"],
    examples: [] as ISamSimilarityExample[],
    proposals: null as ISamSimilarityToolState["proposals"],
    nextPolarity: "foreground" as ISamSimilarityToolState["nextPolarity"],
    status: {
      phase: "idle",
      putativeCount: 0,
      progress: null,
      timings: {},
    } as ISamSimilarityStatus,
    exampleInputMode: "click" as ISamSimilarityToolState["exampleInputMode"],
    livePreview: null as ISamSimilarityToolState["livePreview"],
  }) as unknown as ISamSimilarityToolState;

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
  const mergeStatus = (overrides: Partial<ISamSimilarityStatus>) => {
    state.status = { ...state.status, error: undefined, ...overrides };
  };
  const reportProgress = (progress: { done: number; total: number } | null) => {
    mergeStatus({ progress });
  };
  const reportPartialProposals = (partial: IProposalsResult) => {
    state.proposals = partial.proposals;
    mergeStatus({
      putativeCount: partial.proposals.length,
      autoSizeRange: partial.autoSizeRange,
      timings: partial.timings,
    });
  };

  let nodes: TSamSimilarityNodes;
  try {
    // markRaw prevents Vue 3 from wrapping pipeline nodes in reactive
    // Proxies - see createSamToolStateFromToolConfiguration for why.
    nodes = markRaw(
      createSamSimilarityPipeline(
        configuration,
        model,
        reportError,
        reportProgress,
        reportPartialProposals,
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
    state.examples =
      !rawOutput || rawOutput === NoOutput ? [] : rawOutput.decodedExamples;
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

  // Proposals + status are reactive.
  const proposalsNode = nodes.output.proposals;
  proposalsNode.onOutputUpdate(() => {
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

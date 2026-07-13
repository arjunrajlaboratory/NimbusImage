// Web worker for the example-based auto-segmentation tool ("AutoSeg").
// Owns the expensive state (RGBA image, feature stack, trained forest,
// probability map) and answers a simple request/response RPC protocol.
// See codebaseDocumentation/EXAMPLE_SEGMENTATION_TOOL.md §3-4.5 (normative).
/// <reference lib="webworker" />

import {
  IPostprocessParams,
  IPostprocessRequest,
  IResetRequest,
  ISegmentationResultResponse,
  ISetImageRequest,
  ITrainPredictRequest,
  IWorkerExample,
  IWorkerTimings,
  TWorkerRequest,
  TWorkerResponse,
} from "@/utils/exampleSegmentation/types";
import {
  buildFeatureStack,
  IFeatureStack,
} from "@/utils/exampleSegmentation/features";
import {
  computeAnnulusMask,
  computeAnnulusRingWidth,
  computeMaskArea,
  dilateMask,
  rasterizePolygon,
  sampleFarFieldBackground,
} from "@/utils/exampleSegmentation/rasterize";
import {
  IFlattenedForest,
  predictDense,
  trainForest,
} from "@/utils/exampleSegmentation/forest";
import {
  computeAutoSizeRange,
  computeComponentAreas,
  filterComponentsBySize,
  labelConnectedComponents,
  thresholdProbabilityMap,
  traceAllContours,
} from "@/utils/exampleSegmentation/postprocess";

// Caps from spec §4.3.
const MAX_FOREGROUND_SAMPLES = 4000;
const MAX_BACKGROUND_SAMPLES = 8000;
// Ring width used when there are no foreground examples to derive one from
// (e.g. a trainPredict call carrying only background examples).
const DEFAULT_RING_WIDTH = 10;

interface IWorkerState {
  width: number;
  height: number;
  featureStack: IFeatureStack | null;
  forest: IFlattenedForest | null;
  probabilityMap: Float32Array | null;
  // Foreground example areas from the last training pass, kept for the auto
  // size range even when postprocess-only requests re-run without retraining.
  foregroundExampleAreas: number[];
}

const state: IWorkerState = {
  width: 0,
  height: 0,
  featureStack: null,
  forest: null,
  probabilityMap: null,
  foregroundExampleAreas: [],
};

let cachedRgba: Uint8ClampedArray | null = null;

function respond(response: TWorkerResponse): void {
  workerContext.postMessage(response);
}

function resetState(): void {
  cachedRgba = null;
  state.width = 0;
  state.height = 0;
  state.featureStack = null;
  state.forest = null;
  state.probabilityMap = null;
  state.foregroundExampleAreas = [];
}

function ensureFeatureStack(): {
  featureStack: IFeatureStack;
  featuresMs?: number;
} {
  if (state.featureStack) {
    return { featureStack: state.featureStack };
  }
  if (!cachedRgba) {
    throw new Error("No image has been set");
  }
  const start = performance.now();
  const featureStack = buildFeatureStack(cachedRgba, state.width, state.height);
  const featuresMs = performance.now() - start;
  state.featureStack = featureStack;
  return { featureStack, featuresMs };
}

/**
 * Deterministically shrinks a candidate pixel index list to at most `cap`
 * entries, evenly spread across the original list (stride subsampling, no
 * RNG - spec §4.3).
 */
function subsampleIndices(indices: number[], cap: number): number[] {
  if (indices.length <= cap) {
    return indices;
  }
  const stride = indices.length / cap;
  const result = new Array<number>(cap);
  for (let i = 0; i < cap; ++i) {
    result[i] = indices[Math.floor(i * stride)];
  }
  return result;
}

function maskToIndices(mask: Uint8Array): number[] {
  const indices: number[] = [];
  for (let i = 0; i < mask.length; ++i) {
    if (mask[i]) {
      indices.push(i);
    }
  }
  return indices;
}

function unionMaskInPlace(target: Uint8Array, source: Uint8Array): void {
  for (let i = 0; i < target.length; ++i) {
    if (source[i]) {
      target[i] = 1;
    }
  }
}

interface ITrainingData {
  trainingSet: number[][];
  labels: number[];
  foregroundExampleAreas: number[];
  autoSizeRange: { min: number; max: number } | null;
}

/**
 * Assembles a balanced, subsampled training set from example polygons plus
 * automatic background sampling (§1, §4.2, §4.3): foreground examples get
 * label 1; explicit background examples, per-example annulus rings, and
 * far-field uniform samples all get label 0.
 */
function buildTrainingData(
  examples: IWorkerExample[],
  featureStack: IFeatureStack,
): ITrainingData {
  const { width, height, planes } = featureStack;
  const pixelCount = width * height;

  const foregroundMask = new Uint8Array(pixelCount);
  const explicitBackgroundMask = new Uint8Array(pixelCount);
  const annulusMask = new Uint8Array(pixelCount);
  const foregroundExampleAreas: number[] = [];
  let maxRingWidth = 0;

  for (const example of examples) {
    const exampleMask = rasterizePolygon(example.points, width, height);
    if (example.polarity === "foreground") {
      const area = computeMaskArea(exampleMask);
      foregroundExampleAreas.push(area);
      const ringWidth = computeAnnulusRingWidth(area);
      maxRingWidth = Math.max(maxRingWidth, ringWidth);
      unionMaskInPlace(
        annulusMask,
        computeAnnulusMask(exampleMask, width, height, ringWidth),
      );
      unionMaskInPlace(foregroundMask, exampleMask);
    } else {
      unionMaskInPlace(explicitBackgroundMask, exampleMask);
    }
  }
  // Ring pixels must never overlap a (possibly different, overlapping) foreground example.
  for (let i = 0; i < pixelCount; ++i) {
    if (foregroundMask[i]) {
      annulusMask[i] = 0;
      explicitBackgroundMask[i] = 0;
    }
  }

  const ringWidth = maxRingWidth || DEFAULT_RING_WIDTH;
  const nearMask = new Uint8Array(pixelCount);
  unionMaskInPlace(nearMask, foregroundMask);
  unionMaskInPlace(nearMask, explicitBackgroundMask);
  unionMaskInPlace(nearMask, annulusMask);
  // Far-field samples must be at least ~2x the annulus width from any example.
  const farFieldExcludeMask = dilateMask(nearMask, width, height, ringWidth);
  const farFieldSamples = sampleFarFieldBackground(
    farFieldExcludeMask,
    width,
    height,
    MAX_BACKGROUND_SAMPLES,
  );

  const foregroundIndices = subsampleIndices(
    maskToIndices(foregroundMask),
    MAX_FOREGROUND_SAMPLES,
  );
  const backgroundCandidateIndices = maskToIndices(explicitBackgroundMask)
    .concat(maskToIndices(annulusMask))
    .concat(Array.from(farFieldSamples));
  const backgroundIndices = subsampleIndices(
    backgroundCandidateIndices,
    MAX_BACKGROUND_SAMPLES,
  );

  const trainingSet: number[][] = new Array(
    foregroundIndices.length + backgroundIndices.length,
  );
  const labels: number[] = new Array(trainingSet.length);
  let row = 0;
  for (const pixel of foregroundIndices) {
    trainingSet[row] = planes.map((plane) => plane[pixel]);
    labels[row] = 1;
    row++;
  }
  for (const pixel of backgroundIndices) {
    trainingSet[row] = planes.map((plane) => plane[pixel]);
    labels[row] = 0;
    row++;
  }

  return {
    trainingSet,
    labels,
    foregroundExampleAreas,
    autoSizeRange: computeAutoSizeRange(foregroundExampleAreas),
  };
}

interface IPostprocessOutcome {
  contours: { x: number; y: number }[][];
  componentCount: number;
  autoSizeRange: { min: number; max: number } | null;
  postprocessMs: number;
}

function runPostprocess(params: IPostprocessParams): IPostprocessOutcome {
  const start = performance.now();
  const autoSizeRange = computeAutoSizeRange(state.foregroundExampleAreas);

  if (!state.probabilityMap) {
    return {
      contours: [],
      componentCount: 0,
      autoSizeRange,
      postprocessMs: performance.now() - start,
    };
  }

  const { width, height } = state;
  const binaryMask = thresholdProbabilityMap(
    state.probabilityMap,
    params.threshold,
  );
  const { labels, componentCount } = labelConnectedComponents(
    binaryMask,
    width,
    height,
  );
  const areas = computeComponentAreas(labels, componentCount);

  const minArea = params.minArea ?? autoSizeRange?.min ?? 0;
  const maxArea = params.maxArea ?? autoSizeRange?.max ?? Infinity;
  const keep = filterComponentsBySize(areas, minArea, maxArea);
  const contours = traceAllContours(
    labels,
    width,
    height,
    componentCount,
    keep,
  );

  return {
    contours,
    componentCount,
    autoSizeRange,
    postprocessMs: performance.now() - start,
  };
}

function handleSetImage(request: ISetImageRequest): void {
  // A new screenshot invalidates cached features and the probability map,
  // but the trained forest (and what it learned) is kept.
  cachedRgba = new Uint8ClampedArray(request.rgba);
  state.width = request.width;
  state.height = request.height;
  state.featureStack = null;
  state.probabilityMap = null;
  respond({ type: "ack", requestId: request.requestId });
}

function handleTrainPredict(request: ITrainPredictRequest): void {
  const timings: IWorkerTimings = {};

  if (request.examples.length > 0) {
    const { featureStack, featuresMs } = ensureFeatureStack();
    timings.featuresMs = featuresMs;

    const trainStart = performance.now();
    const trainingData = buildTrainingData(request.examples, featureStack);
    state.forest = trainForest(trainingData.trainingSet, trainingData.labels);
    state.foregroundExampleAreas = trainingData.foregroundExampleAreas;
    timings.trainMs = performance.now() - trainStart;

    const predictStart = performance.now();
    state.probabilityMap = predictDense(
      state.forest,
      featureStack.planes,
      featureStack.width * featureStack.height,
    );
    timings.predictMs = performance.now() - predictStart;
  } else if (state.forest) {
    // Re-predict with the cached model on (possibly new) features - e.g. after a pan.
    const { featureStack, featuresMs } = ensureFeatureStack();
    timings.featuresMs = featuresMs;
    const predictStart = performance.now();
    state.probabilityMap = predictDense(
      state.forest,
      featureStack.planes,
      featureStack.width * featureStack.height,
    );
    timings.predictMs = performance.now() - predictStart;
  } else {
    state.probabilityMap = null;
  }

  const outcome = runPostprocess(request.params);
  timings.postprocessMs = outcome.postprocessMs;

  const response: ISegmentationResultResponse = {
    type: "result",
    requestId: request.requestId,
    contours: outcome.contours,
    componentCount: outcome.componentCount,
    autoSizeRange: outcome.autoSizeRange,
    hasModel: state.forest !== null,
    timings,
  };
  respond(response);
}

function handlePostprocess(request: IPostprocessRequest): void {
  const outcome = runPostprocess(request.params);
  const response: ISegmentationResultResponse = {
    type: "result",
    requestId: request.requestId,
    contours: outcome.contours,
    componentCount: outcome.componentCount,
    autoSizeRange: outcome.autoSizeRange,
    hasModel: state.forest !== null,
    timings: { postprocessMs: outcome.postprocessMs },
  };
  respond(response);
}

function handleReset(request: IResetRequest): void {
  resetState();
  respond({ type: "ack", requestId: request.requestId });
}

function handleRequest(request: TWorkerRequest): void {
  switch (request.type) {
    case "setImage":
      handleSetImage(request);
      break;
    case "trainPredict":
      handleTrainPredict(request);
      break;
    case "postprocess":
      handlePostprocess(request);
      break;
    case "reset":
      handleReset(request);
      break;
  }
}

const workerContext = self as unknown as DedicatedWorkerGlobalScope;

workerContext.onmessage = (event: MessageEvent<TWorkerRequest>) => {
  const request = event.data;
  try {
    handleRequest(request);
  } catch (error) {
    respond({
      type: "error",
      requestId: request.requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

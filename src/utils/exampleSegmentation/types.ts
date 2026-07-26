// Shared types for the example-based auto-segmentation tool worker protocol.
// See codebaseDocumentation/EXAMPLE_SEGMENTATION_TOOL.md for the full spec.
// All coordinates in this protocol are working-resolution pixel coordinates
// (the downscaled screenshot the worker operates on).

export interface IWorkerPoint {
  x: number;
  y: number;
}

export type TExamplePolarity = "foreground" | "background";

export interface IWorkerExample {
  polarity: TExamplePolarity;
  points: IWorkerPoint[];
}

export interface IPostprocessParams {
  // Probability threshold in [0, 1]
  threshold: number;
  // Component area bounds in working pixels; null = auto from example areas
  minArea: number | null;
  maxArea: number | null;
}

export interface ISetImageRequest {
  type: "setImage";
  requestId: number;
  // RGBA bytes, transferred; length = width * height * 4
  rgba: ArrayBuffer;
  width: number;
  height: number;
}

export interface ITrainPredictRequest {
  type: "trainPredict";
  requestId: number;
  // Empty array = re-predict with the cached model (e.g. after a pan)
  examples: IWorkerExample[];
  params: IPostprocessParams;
}

export interface IPostprocessRequest {
  type: "postprocess";
  requestId: number;
  params: IPostprocessParams;
}

// Drops the trained model, cached examples, and probability map
export interface IResetRequest {
  type: "reset";
  requestId: number;
}

export type TWorkerRequest =
  | ISetImageRequest
  | ITrainPredictRequest
  | IPostprocessRequest
  | IResetRequest;

export interface IWorkerTimings {
  featuresMs?: number;
  trainMs?: number;
  predictMs?: number;
  postprocessMs?: number;
}

export interface ISegmentationResultResponse {
  type: "result";
  requestId: number;
  // Outer contours of surviving components, working-resolution coords
  contours: IWorkerPoint[][];
  // Number of connected components before size filtering
  componentCount: number;
  // Auto size range derived from foreground example areas, if computable
  autoSizeRange: { min: number; max: number } | null;
  // Whether a trained model is currently cached in the worker
  hasModel: boolean;
  timings: IWorkerTimings;
}

export interface IAckResponse {
  type: "ack";
  requestId: number;
}

export interface IErrorResponse {
  type: "error";
  requestId: number;
  error: string;
}

export type TWorkerResponse =
  | ISegmentationResultResponse
  | IAckResponse
  | IErrorResponse;

import { describe, it, expect, vi, beforeAll } from "vitest";

// The real tool-state factory and pipeline nodes, with model loading, the
// ONNX runtime, ITK and the classifier worker stubbed out: these tests are
// about the status the panel reads, not about inference.
vi.mock("@/utils/log", () => ({ logError: vi.fn(), logWarning: vi.fn() }));
vi.mock("./onnxModels", () => ({
  createOnnxInferenceSession: vi.fn(async () => ({})),
  runOnnxSessionSerialized: vi.fn(),
  warmModelCache: vi.fn(),
}));
vi.mock("onnxruntime-web/webgpu", () => ({
  Tensor: class {},
  InferenceSession: class {},
}));
vi.mock("itk-wasm", () => ({
  InterfaceTypes: {},
  runPipeline: vi.fn(),
}));
vi.mock("geojs", () => ({ default: { annotation: {} } }));
vi.mock("@/utils/exampleSegmentation/workerClient", () => ({
  ExampleSegmentationWorkerClient: class {
    reset = vi.fn(async () => {});
  },
}));

import { createObjectSegmentationToolStateFromToolConfiguration } from "./objectSegmentationPipeline";
import { IObjectSegmentationToolState } from "@/store/model";

beforeAll(() => {
  (navigator as any).gpu = {};
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    {} as any,
  );
});

async function createState() {
  const state = createObjectSegmentationToolStateFromToolConfiguration({
    values: { model: { value: "vit_b" } },
  } as any);
  if (!("nodes" in state)) {
    throw new Error("expected an object segmentation tool state");
  }
  // Let the model-loading nodes settle
  for (let i = 0; i < 5; i++) await Promise.resolve();
  return state as IObjectSegmentationToolState;
}

describe("object segmentation status", () => {
  it("clears scan progress when computing ends without proposals", async () => {
    const state = await createState();
    expect(state.nodes.allNodes.some((node) => node.isComputing)).toBe(false);

    // A SAM scan was under way (e.g. 3 of 10 candidates decoded) when its
    // input went away (the last example undone): the decode node publishes
    // NoOutput and never reports progress again.
    state.status = {
      ...state.status,
      phase: "computing",
      progress: { done: 3, total: 10 },
    };
    await state.nodes.input.gridSize.setValue(12);
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(state.status.phase).toBe("idle");
    // The panel shows "Scanning candidates… 3/10" whenever progress is set
    expect(state.status.progress).toBeNull();
  });
});

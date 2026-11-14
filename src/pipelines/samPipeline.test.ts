import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { computed, nextTick } from "vue";

// The real tool-state factory and pipeline nodes, with the model loading,
// ONNX runtime and ITK stubbed out: these tests are about how prompt state
// reaches Vue, not about inference.
vi.mock("@/utils/log", () => ({ logError: vi.fn(), logWarning: vi.fn() }));
vi.mock("./onnxModels", () => ({
  createOnnxInferenceSession: vi.fn(() => new Promise(() => {})),
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

import {
  createSamFailureTracker,
  createSamToolStateFromToolConfiguration,
  TSamToolFailure,
} from "./samPipeline";
import { ManualInputNode, NoOutput } from "./computePipeline";
import { createOnnxInferenceSession } from "./onnxModels";
import { logError } from "@/utils/log";
import { ISamAnnotationToolState, PromptType, TSamPrompt } from "@/store/model";

beforeAll(() => {
  // createSamPipeline refuses to build without WebGPU.
  (navigator as any).gpu = {};
  // jsdom has no canvas. A stand-in context: nothing here draws, and a
  // failing context node would itself be reported as a load failure.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    {} as any,
  );
});

function createState() {
  const state = createSamToolStateFromToolConfiguration({
    values: { model: { value: "vit_b" } },
  } as any);
  if (!("nodes" in state)) {
    throw new Error("expected a SAM tool state");
  }
  return state as ISamAnnotationToolState;
}

const prompt: TSamPrompt = {
  type: PromptType.foregroundPoint,
  point: { x: 1, y: 2 },
};

describe("SAM tool state prompts", () => {
  it("a computed over the markRaw'd prompt node does not see a new prompt", async () => {
    // Why the mirror exists: the nodes are markRaw'd, so reading the prompt
    // node's output registers no dependency.
    const state = createState();
    const fromNode = computed(() => {
      const output = state.nodes.input.mainPrompt.output;
      return output === NoOutput ? [] : output;
    });
    expect(fromNode.value).toEqual([]);
    await state.nodes.input.mainPrompt.setValue([prompt]);
    await nextTick();
    expect(fromNode.value).toEqual([]);
  });

  it("mirrors the prompt list into reactive state", async () => {
    const state = createState();
    const fromState = computed(() => state.prompts.length);
    expect(fromState.value).toBe(0);
    await state.nodes.input.mainPrompt.setValue([prompt]);
    expect(fromState.value).toBe(1);
    await state.nodes.input.mainPrompt.setValue(NoOutput);
    expect(fromState.value).toBe(0);
  });
});

// Lets the session promises settle and the nodes recompute.
async function flushPipeline() {
  for (let i = 0; i < 5; ++i) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("SAM tool state failures", () => {
  const mockedCreateSession = vi.mocked(createOnnxInferenceSession);
  afterEach(() => {
    mockedCreateSession.mockImplementation(() => new Promise(() => {}));
  });

  it("reports a failed model load as a reactive failure, and a retry that succeeds clears it", async () => {
    mockedCreateSession.mockImplementation(() =>
      Promise.reject(new Error("model fetch failed")),
    );
    mockedCreateSession.mockClear();
    const state = createState();
    const failure = computed(() => state.failure);
    expect(failure.value).toBeNull();

    await flushPipeline();
    expect(failure.value).toEqual({
      stage: "load",
      message: "model fetch failed",
      canRetry: true,
    });
    // Still logged, not swallowed
    expect(logError).toHaveBeenCalledWith("model fetch failed");

    mockedCreateSession.mockImplementation(() => Promise.resolve({} as any));
    state.nodes.retryLoad();
    await flushPipeline();
    expect(failure.value).toBeNull();
    // Every failed session was re-created (encoder, decoder, preview)
    expect(mockedCreateSession).toHaveBeenCalledTimes(6);
  });

  it("a retry that fails again keeps the failure", async () => {
    mockedCreateSession.mockImplementation(() =>
      Promise.reject(new Error("no WebGPU adapter")),
    );
    const state = createState();
    await flushPipeline();
    state.nodes.retryLoad();
    await flushPipeline();
    expect(state.failure?.stage).toBe("load");
    expect(state.failure?.message).toBe("no WebGPU adapter");
  });
});

describe("SAM failure tracker", () => {
  function trackFailures() {
    const tracker = createSamFailureTracker();
    const seen: (TSamToolFailure | null)[] = [];
    tracker.setListener((failure) => seen.push(failure));
    return { tracker, seen };
  }

  it("reports a failed run and clears it when the next run succeeds", async () => {
    const { tracker, seen } = trackFailures();
    const input = new ManualInputNode<string>();
    tracker.trackedNode(
      "run",
      async (value: string) => {
        if (value === "bad") {
          throw new Error("decode failed");
        }
        return value;
      },
      [input],
    );

    await input.setValue("bad");
    await flushPipeline();
    expect(seen.at(-1)).toEqual({
      stage: "run",
      message: "decode failed",
      canRetry: false,
    });

    await input.setValue("good");
    await flushPipeline();
    expect(seen.at(-1)).toBeNull();
  });

  it("clears a run failure whose input went away while it ran", async () => {
    // e.g. Reset prompts during a decode: the decode rejects, and with no
    // prompts left the node is not run again.
    const { tracker, seen } = trackFailures();
    const input = new ManualInputNode<string>();
    let fail!: () => void;
    const decode = vi.fn(
      (prompt: string) =>
        new Promise<string>((_resolve, reject) => {
          fail = () => reject(new Error(`decode failed for ${prompt}`));
        }),
    );
    tracker.trackedNode("run", decode, [input]);

    await input.setValue("prompt");
    await input.setValue(NoOutput as any);
    fail();
    await flushPipeline();

    expect(decode).toHaveBeenCalledTimes(1);
    expect(seen.at(-1) ?? null).toBeNull();
  });

  it("logs a failed node under its own function's name", async () => {
    const { tracker } = trackFailures();
    const input = new ManualInputNode<string>();
    tracker.trackedNode(
      "run",
      async function runDecoder(prompt: string) {
        throw new Error(`decode failed for ${prompt}`);
      },
      [input],
    );

    await input.setValue("prompt");
    await flushPipeline();

    expect(logError).toHaveBeenCalledWith(
      "Computation of pipeline node failed [runDecoder]",
    );
  });
});

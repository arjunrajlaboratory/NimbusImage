import { InferenceSession, env } from "onnxruntime-web/webgpu";

env.wasm.wasmPaths = "onnx-wasm/";

const modelBufferCache: Record<string, Promise<ArrayBuffer>> = {};
const sessionCache: Record<string, Promise<InferenceSession>> = {};

async function fetchModelBuffer(modelPath: string): Promise<ArrayBuffer> {
  const response = await fetch(modelPath);
  const buffer = await response.arrayBuffer();
  return buffer;
}

export async function createOnnxInferenceSession(
  modelPath: string,
  options?: InferenceSession.SessionOptions,
) {
  if (!(modelPath in sessionCache)) {
    if (!(modelPath in modelBufferCache)) {
      modelBufferCache[modelPath] = fetchModelBuffer(modelPath);
    }
    sessionCache[modelPath] = modelBufferCache[modelPath].then((buffer) =>
      InferenceSession.create(buffer, options),
    );
  }
  return sessionCache[modelPath];
}

// Serialize session.run() calls to prevent ONNX "Session already started" errors.
// The WebGPU backend does not support concurrent runs on the same session.
const sessionRunQueues = new WeakMap<InferenceSession, Promise<unknown>>();

export async function runOnnxSessionSerialized(
  session: InferenceSession,
  feeds: InferenceSession.FeedsType,
): Promise<InferenceSession.ReturnType> {
  const prev = sessionRunQueues.get(session) ?? Promise.resolve();
  const run = prev.then(
    () => session.run(feeds),
    () => session.run(feeds),
  );
  sessionRunQueues.set(session, run.catch(() => {}));
  return run;
}

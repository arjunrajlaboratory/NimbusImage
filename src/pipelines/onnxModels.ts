import { InferenceSession, env } from "onnxruntime-web/webgpu";

env.wasm.wasmPaths = "onnx-wasm/";
// On dual-GPU machines (e.g. laptops with integrated + discrete GPU), the
// browser may hand WebGPU the low-power adapter by default, which makes the
// SAM encoder several times slower. Explicitly request the fast one.
env.webgpu.powerPreference = "high-performance";

// Persistent cache for model files (SAM encoders are hundreds of MB, so
// skipping the download dominates tool load time on repeat visits).
// Bump the version suffix when the model files at a given path change.
const MODEL_CACHE_NAME = "onnx-model-cache-v1";

const sessionCache: Record<string, Promise<InferenceSession>> = {};

async function fetchModelBuffer(modelPath: string): Promise<ArrayBuffer> {
  let cache: Cache | null = null;
  try {
    cache = await caches.open(MODEL_CACHE_NAME);
    const cachedResponse = await cache.match(modelPath);
    if (cachedResponse) {
      return await cachedResponse.arrayBuffer();
    }
  } catch {
    // Cache API unavailable (insecure context, storage restrictions...):
    // fall through and fetch from the network without caching
  }
  const response = await fetch(modelPath);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch ONNX model ${modelPath}: ${response.status} ${response.statusText}`,
    );
  }
  if (cache) {
    try {
      await cache.put(modelPath, response.clone());
    } catch {
      // Quota exceeded or similar: still return the fetched buffer
    }
  }
  return await response.arrayBuffer();
}

export async function createOnnxInferenceSession(
  modelPath: string,
  options?: InferenceSession.SessionOptions,
) {
  if (!(modelPath in sessionCache)) {
    const sessionPromise = fetchModelBuffer(modelPath).then((buffer) =>
      InferenceSession.create(buffer, options),
    );
    // Don't cache failures: a transient network error would otherwise
    // permanently break the tool until the page is reloaded
    sessionPromise.catch(() => {
      if (sessionCache[modelPath] === sessionPromise) {
        delete sessionCache[modelPath];
      }
    });
    sessionCache[modelPath] = sessionPromise;
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
  sessionRunQueues.set(
    session,
    run.catch(() => {}),
  );
  return run;
}

import { InferenceSession, env } from "onnxruntime-web/webgpu";

// Must be root-absolute: onnxruntime-web resolves this prefix with a dynamic
// import() for the .mjs loader, and a bare "onnx-wasm/..." specifier is not a
// valid module specifier (it would also resolve against the SPA route path).
env.wasm.wasmPaths = "/onnx-wasm/";
// On dual-GPU machines (e.g. laptops with integrated + discrete GPU), the
// browser may hand WebGPU the low-power adapter by default, which makes the
// SAM encoder several times slower. Explicitly request the fast one.
env.webgpu.powerPreference = "high-performance";

// Persistent cache for model files (SAM encoders are hundreds of MB, so
// skipping the download dominates tool load time on repeat visits).
// Bump the version suffix when the model files at a given path change.
const MODEL_CACHE_NAME = "onnx-model-cache-v1";

const sessionCache: Record<string, Promise<InferenceSession>> = {};

// The Vite dev server — and some production SPA setups — answer a request for a
// missing static file with the index.html app shell at HTTP 200 rather than a
// 404. A bare `response.ok` check treats that HTML page as the model; once it
// lands in the persistent cache the SAM tool is permanently broken (ONNX
// Runtime reports "Failed to load model because protobuf parsing failed",
// INVALID_PROTOBUF) until the cache is cleared. Detect the HTML shell so we
// neither cache it nor feed it to InferenceSession.create.
function isHtmlAppShell(
  contentType: string | null,
  buffer?: ArrayBuffer,
): boolean {
  if (contentType && contentType.toLowerCase().includes("text/html")) {
    return true;
  }
  // Content-type is unreliable (the dev server serves the real models with an
  // empty content-type), so also sniff the first byte when we have the body:
  // an HTML document starts with "<" (0x3c); ONNX (protobuf) and ORT
  // (flatbuffer) model files never do.
  if (buffer && buffer.byteLength > 0) {
    return new Uint8Array(buffer, 0, 1)[0] === 0x3c;
  }
  return false;
}

async function fetchModelBuffer(modelPath: string): Promise<ArrayBuffer> {
  let cache: Cache | null = null;
  try {
    cache = await caches.open(MODEL_CACHE_NAME);
    const cachedResponse = await cache.match(modelPath);
    if (cachedResponse) {
      // Only trust the cheap content-type check here: re-reading the body of a
      // hundreds-of-MB cached model just to sniff bytes would defeat the point
      // of caching. A poisoned entry (the HTML shell) is always text/html.
      if (!isHtmlAppShell(cachedResponse.headers.get("content-type"))) {
        return await cachedResponse.arrayBuffer();
      }
      // Self-heal: drop a previously poisoned entry (cached before the model
      // file existed) and re-fetch below instead of serving the shell forever.
      await cache.delete(modelPath);
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
  // Clone for the cache before consuming the body for validation/return.
  const responseForCache = cache ? response.clone() : null;
  const buffer = await response.arrayBuffer();
  if (isHtmlAppShell(response.headers.get("content-type"), buffer)) {
    throw new Error(
      `ONNX model ${modelPath} was served as the HTML app shell instead of a ` +
        `model file — is the model present at that path? Refusing to cache it.`,
    );
  }
  if (cache && responseForCache) {
    try {
      await cache.put(modelPath, responseForCache);
    } catch {
      // Quota exceeded or similar: still return the fetched buffer
    }
  }
  return buffer;
}

/**
 * Best-effort: download the model at the given path into the persistent
 * cache so that a later `createOnnxInferenceSession` doesn't pay for the
 * network fetch. No-op if already cached or if the Cache API is unavailable.
 */
export async function warmModelCache(modelPath: string): Promise<void> {
  try {
    const cache = await caches.open(MODEL_CACHE_NAME);
    const existing = await cache.match(modelPath);
    if (existing) {
      if (!isHtmlAppShell(existing.headers.get("content-type"))) {
        return;
      }
      // Drop a poisoned entry so the fetch below can re-populate it.
      await cache.delete(modelPath);
    }
    const response = await fetch(modelPath);
    if (response.ok && !isHtmlAppShell(response.headers.get("content-type"))) {
      await cache.put(modelPath, response);
    }
  } catch {
    // Warming the cache is only an optimization: never let it throw
  }
}

// onnxruntime-web lazily initializes its shared WASM/WebGPU backend on the
// first InferenceSession.create() call, and that initialization is NOT
// reentrant: if a second create() begins while the first is still initializing
// the backend, ORT throws "multiple calls to 'initWasm()' detected." The SAM
// pipeline creates the encoder and decoder sessions from two independent
// compute nodes that fire concurrently, so their create() calls race. The
// window is tiny on localhost (the .mjs/.wasm loaders are served instantly) but
// wide in production (each is a network fetch), which is why this only surfaced
// once deployed. Serialize create() so the backend initializes exactly once.
let sessionCreateChain: Promise<unknown> = Promise.resolve();

export async function createOnnxInferenceSession(
  modelPath: string,
  options?: InferenceSession.SessionOptions,
) {
  if (!(modelPath in sessionCache)) {
    // Kick off the (slow) model download immediately so concurrent requests
    // still fetch their models in parallel — only the backend init is gated.
    // Settle it into a promise that never rejects on its own: the create()
    // step below is queued behind sessionCreateChain, so a bare fetch promise
    // could reject while still waiting its turn — before any handler is
    // attached — which the runtime reports as an unhandled rejection. Re-throw
    // inside the chain, where sessionPromise's consumers handle it.
    const bufferSettled = fetchModelBuffer(modelPath).then(
      (buffer) => ({ ok: true as const, buffer }),
      (error) => ({ ok: false as const, error }),
    );
    // Chain the create() step behind any in-flight create so no two run at
    // once. Once the first has fully initialized the backend, the rest are
    // safe; serializing them all is the simplest way to guarantee that.
    const sessionPromise = sessionCreateChain.then(() =>
      bufferSettled.then((result) => {
        if (!result.ok) {
          throw result.error;
        }
        return InferenceSession.create(result.buffer, options);
      }),
    );
    // Advance the chain regardless of this session's outcome (and without
    // retaining the session object), so one failed create can't wedge the
    // rest.
    sessionCreateChain = sessionPromise.then(
      () => {},
      () => {},
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

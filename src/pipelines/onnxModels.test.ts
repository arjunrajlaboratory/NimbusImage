import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const createMock = vi.fn();

vi.mock("onnxruntime-web/webgpu", () => ({
  env: { wasm: {}, webgpu: {} },
  InferenceSession: {
    get create() {
      return createMock;
    },
  },
}));

// The module keeps a session cache at module scope, so each test re-imports a
// fresh copy.
async function importFreshModule() {
  vi.resetModules();
  return await import("./onnxModels");
}

function makeResponse(
  body: ArrayBuffer,
  { ok = true, status = 200, statusText = "OK", contentType = "" } = {},
) {
  return {
    ok,
    status,
    statusText,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type" ? contentType : null,
    },
    arrayBuffer: () => Promise.resolve(body),
    clone() {
      return makeResponse(body, { ok, status, statusText, contentType });
    },
  };
}

// The 920-byte index.html the Vite dev server returns (at HTTP 200) for a
// missing model path: begins with "<!DOCTYPE html".
function makeHtmlShellResponse({ contentType = "text/html" } = {}) {
  const html = new TextEncoder().encode("<!DOCTYPE html><html></html>");
  return makeResponse(html.buffer, { contentType });
}

describe("createOnnxInferenceSession", () => {
  const modelBuffer = new ArrayBuffer(8);
  let fetchMock: ReturnType<typeof vi.fn>;
  let cacheMatch: ReturnType<typeof vi.fn>;
  let cachePut: ReturnType<typeof vi.fn>;
  let cacheDelete: ReturnType<typeof vi.fn>;
  let cachesOpen: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    createMock.mockReset();
    createMock.mockResolvedValue({ fake: "session" });
    fetchMock = vi.fn().mockResolvedValue(makeResponse(modelBuffer));
    cacheMatch = vi.fn().mockResolvedValue(undefined);
    cachePut = vi.fn().mockResolvedValue(undefined);
    cacheDelete = vi.fn().mockResolvedValue(true);
    cachesOpen = vi.fn().mockResolvedValue({
      match: cacheMatch,
      put: cachePut,
      delete: cacheDelete,
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("caches", { open: cachesOpen });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches the model, stores it in the cache and creates a session", async () => {
    const { createOnnxInferenceSession } = await importFreshModule();
    const session = await createOnnxInferenceSession("/models/encoder.onnx");
    expect(session).toEqual({ fake: "session" });
    expect(fetchMock).toHaveBeenCalledWith("/models/encoder.onnx");
    expect(cachePut).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledWith(modelBuffer, undefined);
  });

  it("uses the cached response without fetching when available", async () => {
    cacheMatch.mockResolvedValue(makeResponse(modelBuffer));
    const { createOnnxInferenceSession } = await importFreshModule();
    await createOnnxInferenceSession("/models/encoder.onnx");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cachePut).not.toHaveBeenCalled();
    expect(createMock).toHaveBeenCalledWith(modelBuffer, undefined);
  });

  it("returns the same session promise for the same path", async () => {
    const { createOnnxInferenceSession } = await importFreshModule();
    const [first, second] = await Promise.all([
      createOnnxInferenceSession("/models/encoder.onnx"),
      createOnnxInferenceSession("/models/encoder.onnx"),
    ]);
    expect(first).toBe(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to a plain fetch when the Cache API is unavailable", async () => {
    cachesOpen.mockRejectedValue(new Error("no cache for you"));
    const { createOnnxInferenceSession } = await importFreshModule();
    const session = await createOnnxInferenceSession("/models/encoder.onnx");
    expect(session).toEqual({ fake: "session" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still resolves when writing to the cache fails", async () => {
    cachePut.mockRejectedValue(new Error("quota exceeded"));
    const { createOnnxInferenceSession } = await importFreshModule();
    const session = await createOnnxInferenceSession("/models/encoder.onnx");
    expect(session).toEqual({ fake: "session" });
  });

  it("rejects on a non-ok response", async () => {
    fetchMock.mockResolvedValue(
      makeResponse(modelBuffer, {
        ok: false,
        status: 404,
        statusText: "Not Found",
      }),
    );
    const { createOnnxInferenceSession } = await importFreshModule();
    await expect(
      createOnnxInferenceSession("/models/encoder.onnx"),
    ).rejects.toThrow("404");
    expect(createMock).not.toHaveBeenCalled();
  });

  it("warmModelCache downloads and stores the model without creating a session", async () => {
    const { warmModelCache } = await importFreshModule();
    await warmModelCache("/models/encoder.onnx");
    expect(fetchMock).toHaveBeenCalledWith("/models/encoder.onnx");
    expect(cachePut).toHaveBeenCalledTimes(1);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("warmModelCache skips the download when the model is already cached", async () => {
    cacheMatch.mockResolvedValue(makeResponse(modelBuffer));
    const { warmModelCache } = await importFreshModule();
    await warmModelCache("/models/encoder.onnx");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cachePut).not.toHaveBeenCalled();
  });

  it("warmModelCache never throws", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const { warmModelCache } = await importFreshModule();
    await expect(
      warmModelCache("/models/encoder.onnx"),
    ).resolves.toBeUndefined();
  });

  it("rejects and does not cache when the server returns the HTML app shell at 200", async () => {
    // Vite answers a missing /onnx-models/... path with index.html at HTTP 200.
    fetchMock.mockResolvedValue(makeHtmlShellResponse());
    const { createOnnxInferenceSession } = await importFreshModule();
    await expect(
      createOnnxInferenceSession("/models/encoder.onnx"),
    ).rejects.toThrow(/HTML app shell/);
    expect(cachePut).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  it("rejects an HTML shell served with an empty content-type (byte sniff)", async () => {
    fetchMock.mockResolvedValue(makeHtmlShellResponse({ contentType: "" }));
    const { createOnnxInferenceSession } = await importFreshModule();
    await expect(
      createOnnxInferenceSession("/models/encoder.onnx"),
    ).rejects.toThrow(/HTML app shell/);
    expect(cachePut).not.toHaveBeenCalled();
  });

  it("self-heals a poisoned cache entry: drops the cached HTML and re-fetches", async () => {
    cacheMatch.mockResolvedValue(makeHtmlShellResponse());
    fetchMock.mockResolvedValue(makeResponse(modelBuffer));
    const { createOnnxInferenceSession } = await importFreshModule();
    const session = await createOnnxInferenceSession("/models/encoder.onnx");
    expect(session).toEqual({ fake: "session" });
    expect(cacheDelete).toHaveBeenCalledWith("/models/encoder.onnx");
    expect(fetchMock).toHaveBeenCalledWith("/models/encoder.onnx");
    expect(createMock).toHaveBeenCalledWith(modelBuffer, undefined);
  });

  it("warmModelCache does not store the HTML app shell", async () => {
    fetchMock.mockResolvedValue(makeHtmlShellResponse());
    const { warmModelCache } = await importFreshModule();
    await warmModelCache("/models/encoder.onnx");
    expect(cachePut).not.toHaveBeenCalled();
  });

  it("warmModelCache drops a poisoned cache entry and re-warms", async () => {
    cacheMatch.mockResolvedValue(makeHtmlShellResponse());
    fetchMock.mockResolvedValue(makeResponse(modelBuffer));
    const { warmModelCache } = await importFreshModule();
    await warmModelCache("/models/encoder.onnx");
    expect(cacheDelete).toHaveBeenCalledWith("/models/encoder.onnx");
    expect(fetchMock).toHaveBeenCalledWith("/models/encoder.onnx");
    expect(cachePut).toHaveBeenCalledTimes(1);
  });

  it("serializes InferenceSession.create so the backend only initializes once", async () => {
    // Two distinct model paths (encoder + decoder) requested concurrently, as
    // the SAM pipeline does. ORT's backend init is not reentrant, so the second
    // create() must not start until the first has resolved.
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    let resolveFirstCreate!: (value: unknown) => void;
    const firstCreate = new Promise((resolve) => {
      resolveFirstCreate = resolve;
    });
    createMock
      .mockReturnValueOnce(firstCreate)
      .mockResolvedValueOnce({ fake: "decoder" });

    const { createOnnxInferenceSession } = await importFreshModule();
    const encoderPromise = createOnnxInferenceSession("/models/encoder.onnx");
    const decoderPromise = createOnnxInferenceSession("/models/decoder.onnx");

    // Let both downloads settle. Only the first create() should have started;
    // the second is queued behind it even though its buffer is ready.
    await flush();
    expect(createMock).toHaveBeenCalledTimes(1);

    // Finishing the first create() lets the second proceed.
    resolveFirstCreate({ fake: "encoder" });
    await expect(encoderPromise).resolves.toEqual({ fake: "encoder" });
    await expect(decoderPromise).resolves.toEqual({ fake: "decoder" });
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it("a failed create does not wedge later session creation", async () => {
    createMock
      .mockRejectedValueOnce(new Error("create blew up"))
      .mockResolvedValueOnce({ fake: "session" });

    const { createOnnxInferenceSession } = await importFreshModule();
    await expect(
      createOnnxInferenceSession("/models/encoder.onnx"),
    ).rejects.toThrow("create blew up");
    // The chain must recover so the next model still loads.
    const session = await createOnnxInferenceSession("/models/decoder.onnx");
    expect(session).toEqual({ fake: "session" });
  });

  it("does not cache failures: a retry after an error attempts a new fetch", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    const { createOnnxInferenceSession } = await importFreshModule();
    await expect(
      createOnnxInferenceSession("/models/encoder.onnx"),
    ).rejects.toThrow("network down");
    const session = await createOnnxInferenceSession("/models/encoder.onnx");
    expect(session).toEqual({ fake: "session" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

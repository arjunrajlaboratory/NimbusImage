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
  { ok = true, status = 200, statusText = "OK" } = {},
) {
  return {
    ok,
    status,
    statusText,
    arrayBuffer: () => Promise.resolve(body),
    clone() {
      return makeResponse(body, { ok, status, statusText });
    },
  };
}

describe("createOnnxInferenceSession", () => {
  const modelBuffer = new ArrayBuffer(8);
  let fetchMock: ReturnType<typeof vi.fn>;
  let cacheMatch: ReturnType<typeof vi.fn>;
  let cachePut: ReturnType<typeof vi.fn>;
  let cachesOpen: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    createMock.mockReset();
    createMock.mockResolvedValue({ fake: "session" });
    fetchMock = vi.fn().mockResolvedValue(makeResponse(modelBuffer));
    cacheMatch = vi.fn().mockResolvedValue(undefined);
    cachePut = vi.fn().mockResolvedValue(undefined);
    cachesOpen = vi
      .fn()
      .mockResolvedValue({ match: cacheMatch, put: cachePut });
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

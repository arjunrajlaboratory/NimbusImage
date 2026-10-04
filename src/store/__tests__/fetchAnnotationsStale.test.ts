/**
 * fetchAnnotations stale-response guard (issue #1379).
 *
 * Switching dataset views overlaps two fetchAnnotations calls. Without a
 * sequence guard, whichever resolves LAST commits — usually the larger, slower
 * fetch of the dataset being left — so the new dataset shows the old one's
 * annotations. This imports the REAL annotation store so the guard under test
 * is the shipped one, not a replica.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  main: {
    dataset: null as { id: string } | null,
    configuration: null as { id: string } | null,
    isLoggedIn: true,
    xy: 0,
    z: 0,
    time: 0,
    layers: [],
    annotationsAPI: {
      getConnectionsForDatasetId: vi.fn(),
      getAnnotationCount: vi.fn(),
      getAnnotationsForDatasetId: vi.fn(),
      getAnnotationStubs: vi.fn(),
    },
  },
}));

vi.mock("@/store/index", () => ({ default: h.main }));
vi.mock("@/store/sync", () => ({
  default: { setSaving: vi.fn() },
}));
vi.mock("@/store/jobs", () => ({
  default: {},
  jobStates: {},
  createProgressEventCallback: () => () => {},
}));
vi.mock("@/store/progress", () => ({
  default: { create: vi.fn().mockResolvedValue("p"), complete: vi.fn() },
  ProgressType: {},
}));
vi.mock("@/tools/creation/templates/AnnotationConfiguration.vue", () => ({}));
vi.mock("geojs", () => ({
  default: { util: { pointInPolygon: () => false } },
}));
vi.mock("@/utils/log", () => ({ logError: vi.fn(), logWarning: vi.fn() }));

import annotationStore from "@/store/annotation";
import { AnnotationShape, IAnnotation, IAnnotationStub } from "@/store/model";

const api = h.main.annotationsAPI;

function makeAnnotation(id: string, datasetId: string): IAnnotation {
  return {
    id,
    name: null,
    tags: [],
    shape: AnnotationShape.Point,
    channel: 0,
    location: { XY: 0, Z: 0, Time: 0 },
    coordinates: [{ x: 0, y: 0 }],
    datasetId,
    color: null,
  };
}

function makeStub(id: string): IAnnotationStub {
  return {
    id,
    centroid: { x: 0, y: 0 },
    location: { XY: 0, Z: 0, Time: 0 },
    shape: AnnotationShape.Point,
    channel: 0,
    tags: [],
    color: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function openDataset(id: string) {
  h.main.dataset = { id };
  h.main.configuration = { id: `config-${id}` };
}

describe("fetchAnnotations stale-response guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    annotationStore.setAnnotations([]);
    annotationStore.replaceVisibilityConfig({ stubThreshold: 10 });
    api.getConnectionsForDatasetId.mockResolvedValue([]);
    api.getAnnotationCount.mockResolvedValue(1);
  });

  it("a full fetch for the old dataset that resolves last does not overwrite the new one", async () => {
    const oldFetch = deferred<IAnnotation[]>();
    api.getAnnotationsForDatasetId.mockImplementation((datasetId: string) =>
      datasetId === "old"
        ? oldFetch.promise
        : Promise.resolve([makeAnnotation("n1", "new")]),
    );

    openDataset("old");
    const first = annotationStore.fetchAnnotations();
    await flush(); // the old fetch is now awaiting its annotations
    openDataset("new");
    const second = annotationStore.fetchAnnotations();
    expect(await second).toBe(true);

    oldFetch.resolve([
      makeAnnotation("o1", "old"),
      makeAnnotation("o2", "old"),
    ]);
    expect(await first).toBe(false);

    expect(annotationStore.annotations.map((a) => a.datasetId)).toEqual([
      "new",
    ]);
  });

  it("a stub fetch for the old dataset that resolves last does not reinstate stub mode", async () => {
    const oldStubs = deferred<IAnnotationStub[]>();
    api.getAnnotationCount.mockImplementation(async (datasetId: string) =>
      datasetId === "old" ? 100 : 1,
    );
    api.getAnnotationStubs.mockReturnValue(oldStubs.promise);
    api.getAnnotationsForDatasetId.mockResolvedValue([
      makeAnnotation("n1", "new"),
    ]);

    openDataset("old");
    const first = annotationStore.fetchAnnotations();
    await flush();
    expect(api.getAnnotationStubs).toHaveBeenCalledWith("old");
    openDataset("new");
    await annotationStore.fetchAnnotations();

    oldStubs.resolve([makeStub("s1"), makeStub("s2")]);
    expect(await first).toBe(false);

    expect(annotationStore.stubOnlyMode).toBe(false);
    expect(annotationStore.annotationStubs.has("s1")).toBe(false);
    expect(annotationStore.annotations.map((a) => a.id)).toEqual(["n1"]);
  });

  it("an error from a superseded fetch does not clear the current dataset's annotations", async () => {
    const oldFetch = deferred<IAnnotation[]>();
    api.getAnnotationsForDatasetId.mockImplementation((datasetId: string) =>
      datasetId === "old"
        ? oldFetch.promise
        : Promise.resolve([makeAnnotation("n1", "new")]),
    );

    openDataset("old");
    const first = annotationStore.fetchAnnotations();
    await flush();
    openDataset("new");
    await annotationStore.fetchAnnotations();

    oldFetch.reject(new Error("network"));
    expect(await first).toBe(false);

    expect(annotationStore.annotations.map((a) => a.id)).toEqual(["n1"]);
  });

  it("a call superseded by a refetch of the same dataset resolves true only once the newer one committed", async () => {
    const firstFetch = deferred<IAnnotation[]>();
    const secondFetch = deferred<IAnnotation[]>();
    api.getAnnotationsForDatasetId
      .mockReturnValueOnce(firstFetch.promise)
      .mockReturnValueOnce(secondFetch.promise);

    openDataset("same");
    let firstResult: boolean | undefined;
    const first = annotationStore.fetchAnnotations().then((committed) => {
      firstResult = committed;
      // What a chained caller (Viewer's property fetch) would read.
      return annotationStore.annotations.map((a) => a.id);
    });
    await flush();
    const second = annotationStore.fetchAnnotations();
    await flush();

    firstFetch.resolve([makeAnnotation("stale", "same")]);
    await flush();
    expect(firstResult).toBeUndefined(); // still waiting on the newer call

    secondFetch.resolve([makeAnnotation("fresh", "same")]);
    expect(await second).toBe(true);
    expect(await first).toEqual(["fresh"]);
    expect(firstResult).toBe(true);
  });

  it("a bail-out (no dataset) supersedes a slow fetch already in flight", async () => {
    const oldFetch = deferred<IAnnotation[]>();
    api.getAnnotationsForDatasetId.mockReturnValue(oldFetch.promise);

    openDataset("old");
    const first = annotationStore.fetchAnnotations();
    await flush();
    h.main.dataset = null;
    await annotationStore.fetchAnnotations();

    oldFetch.resolve([makeAnnotation("o1", "old")]);
    expect(await first).toBe(false);

    expect(annotationStore.annotations).toEqual([]);
  });

  it("does not commit when the dataset changed under a fetch with no newer call", async () => {
    const oldFetch = deferred<IAnnotation[]>();
    api.getAnnotationsForDatasetId.mockReturnValue(oldFetch.promise);

    openDataset("old");
    const first = annotationStore.fetchAnnotations();
    await flush();
    openDataset("new");

    oldFetch.resolve([makeAnnotation("o1", "old")]);
    expect(await first).toBe(false);

    expect(annotationStore.annotations).toEqual([]);
  });
});

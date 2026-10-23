/**
 * Failure rollback of updateAnnotationsPerId's optimistic edits.
 *
 * The action stores each edit before awaiting the save. It used to restore,
 * on failure, the objects it replaced at the indices it captured before the
 * await. Anything that ran during the await made that wrong: a
 * fetchAnnotations rebuilt annotations[] (so the indices pointed at other
 * annotations), or a later edit of the same annotation sat on top of the
 * failed one (and was thrown away, or an earlier failed edit came back).
 *
 * These tests use the REAL store module with the save request held open, so
 * the interleavings are deterministic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { api, mainState } = vi.hoisted(() => ({
  api: {
    updateAnnotations: vi.fn(),
    hydrateAnnotations: vi.fn(),
    getAnnotationCount: vi.fn(),
    getAnnotationsForDatasetId: vi.fn(),
    getConnectionsForDatasetId: vi.fn(),
  },
  mainState: {
    // The live Girder client: replaced on login, server switch, share link.
    girderRest: {} as object,
    isLoggedIn: true,
    dataset: { id: "ds" } as { id: string } | null,
    configuration: {},
  },
}));

vi.mock("./index", () => ({
  default: Object.assign(mainState, { annotationsAPI: api }),
}));
vi.mock("./sync", () => ({
  default: { setSaving: vi.fn() },
}));
vi.mock("./jobs", () => ({
  default: {},
  createProgressEventCallback: () => () => {},
  createErrorEventCallback: () => () => {},
}));
vi.mock("./progress", () => ({
  default: {
    create: vi.fn().mockResolvedValue("progress-1"),
    complete: vi.fn(),
  },
}));
vi.mock("geojs", () => ({
  default: { util: { pointInPolygon: () => false } },
}));
vi.mock("@/tools/creation/templates/AnnotationConfiguration.vue", () => ({}));
vi.mock("@/utils/log", () => ({
  logError: vi.fn(),
  logWarning: vi.fn(),
}));

import annotationStore, { pendingReadBackCount } from "./annotation";
import { AnnotationShape, IAnnotation } from "./model";

function makeAnnotation(
  id: string,
  overrides: Partial<IAnnotation> = {},
): IAnnotation {
  return {
    id,
    channel: 0,
    location: { XY: 0, Z: 0, Time: 0 },
    coordinates: [{ x: 0, y: 0 }],
    shape: AnnotationShape.Point,
    tags: [],
    datasetId: "ds",
    name: null,
    color: null,
    ...overrides,
  };
}

// Saves a test left held: settled after each test, so a failing test does
// not leave a save pending that the next test's saves would queue behind.
const heldSaves: { resolve: () => void; reject: (e: Error) => void }[] = [];

// Hold each updateAnnotations call open until the test settles it.
function holdSaves() {
  const saves = heldSaves;
  saves.length = 0;
  api.updateAnnotations.mockImplementation(
    () =>
      new Promise<void>((resolve, reject) => saves.push({ resolve, reject })),
  );
  return saves;
}

function rename(id: string, name: string) {
  return annotationStore.updateAnnotationsPerId({
    annotationIds: [id],
    editFunction: (annotation) => {
      annotation.name = name;
    },
  });
}

function recolor(id: string, color: string) {
  return annotationStore.updateAnnotationsPerId({
    annotationIds: [id],
    editFunction: (annotation) => {
      annotation.color = color;
    },
  });
}

// An annotation's saves go out one at a time: wait until the next queued one
// has been sent.
async function sent(saves: unknown[], count: number) {
  await vi.waitFor(() => expect(saves).toHaveLength(count));
}

function stored(id: string) {
  return annotationStore.annotations[annotationStore.annotationIdToIdx[id]];
}

describe("updateAnnotationsPerId failure rollback", () => {
  afterEach(async () => {
    // A save queued behind a settled one is sent a few ticks later: keep
    // settling until none is left.
    for (let round = 0; round < 10; round++) {
      for (const save of heldSaves.splice(0)) {
        save.resolve();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // The read-back after a failed edit: by default the server returns
    // nothing, so the restored estimate stands.
    api.hydrateAnnotations.mockResolvedValue([]);
    mainState.dataset = { id: "ds" };
    annotationStore.setStubOnlyMode(false);
    annotationStore.setAnnotations([
      makeAnnotation("a", { name: "A" }),
      makeAnnotation("b", { name: "B" }),
    ]);
  });

  it("restores the annotation when its only edit fails", async () => {
    const saves = holdSaves();
    const original = stored("a");
    const pending = rename("a", "renamed");
    expect(stored("a").name).toBe("renamed");

    saves[0].reject(new Error("offline"));
    await expect(pending).rejects.toThrow("offline");
    expect(stored("a")).toBe(original);
  });

  it("reverts a failed edit in the stubs and hydrated copies the canvas draws from", async () => {
    // With the stub system active, layers render from the stub map and the
    // hydrated map, not annotations[].
    annotationStore.setStubsFromServer([
      {
        id: "a",
        centroid: { x: 0, y: 0 },
        location: { XY: 0, Z: 0, Time: 0 },
        shape: AnnotationShape.Point,
        channel: 0,
        tags: [],
        color: null,
      },
    ]);
    annotationStore.mergeHydratedAnnotations({
      newEntries: [{ id: "a", annotation: stored("a") }],
      touchedIds: [],
    });
    const saves = holdSaves();
    const pending = recolor("a", "#ff0000");
    expect(annotationStore.annotationStubs.get("a")!.color).toBe("#ff0000");
    expect(annotationStore.hydratedAnnotations.get("a")!.color).toBe("#ff0000");

    saves[0].reject(new Error("offline"));
    await expect(pending).rejects.toThrow("offline");

    expect(annotationStore.annotationStubs.get("a")!.color).toBeNull();
    expect(annotationStore.hydratedAnnotations.get("a")!.color).toBeNull();
  });

  it("does not write over annotations a fetch reloaded during a failed save", async () => {
    const saves = holdSaves();
    const pending = rename("a", "renamed");

    // The server returns the annotations in a different order, so the edit's
    // captured index (0) now holds "b".
    const fetchedB = makeAnnotation("b", { name: "B (server)" });
    const fetchedA = makeAnnotation("a", { name: "A (server)" });
    api.getAnnotationCount.mockResolvedValue(2);
    api.getAnnotationsForDatasetId.mockResolvedValue([fetchedB, fetchedA]);
    api.getConnectionsForDatasetId.mockResolvedValue([]);
    await annotationStore.fetchAnnotations();

    saves[0].reject(new Error("offline"));
    await expect(pending).rejects.toThrow("offline");

    expect(annotationStore.annotations).toEqual([fetchedB, fetchedA]);
    expect(stored("a")).toBe(fetchedA);
    expect(stored("b")).toBe(fetchedB);
  });

  it("keeps a later edit of the same annotation when an earlier one fails", async () => {
    const saves = holdSaves();
    const first = rename("a", "renamed");
    const second = recolor("a", "#ff0000");

    saves[0].reject(new Error("offline"));
    await expect(first).rejects.toThrow("offline");
    // The recolor is still in flight and may succeed: leave it on screen.
    expect(stored("a").color).toBe("#ff0000");

    await sent(saves, 2);
    saves[1].resolve();
    await second;
    // The server holds the recolor but not the failed rename.
    expect(stored("a").color).toBe("#ff0000");
    expect(stored("a").name).toBe("A");
    expect(stored("b").name).toBe("B");
  });

  it("does not bring back an earlier failed edit when a later one fails too", async () => {
    const saves = holdSaves();
    const original = stored("a");
    const first = rename("a", "renamed");
    const second = recolor("a", "#ff0000");

    saves[0].reject(new Error("offline"));
    await expect(first).rejects.toThrow("offline");
    await sent(saves, 2);
    saves[1].reject(new Error("offline"));
    await expect(second).rejects.toThrow("offline");

    expect(stored("a")).toEqual(original);
  });

  it("restores what the server holds when saves fail out of order", async () => {
    const saves = holdSaves();
    const first = rename("a", "renamed");
    const second = recolor("a", "#ff0000");

    saves[1].reject(new Error("offline"));
    await expect(second).rejects.toThrow("offline");
    // The rename is still in flight: keep it.
    expect(stored("a").name).toBe("renamed");

    saves[0].resolve();
    await first;
    expect(stored("a").name).toBe("renamed");
    expect(stored("a").color).toBeNull();
  });

  it("reads a failed edit's annotation back and shows the server's copy", async () => {
    // Overlapping saves can be applied in another order than their responses
    // arrive: the restored value is only an estimate.
    const serverCopy = makeAnnotation("a", {
      name: "server",
      color: "#123456",
    });
    api.hydrateAnnotations.mockResolvedValue([serverCopy]);
    const saves = holdSaves();
    const pending = rename("a", "renamed");

    saves[0].reject(new Error("offline"));
    await expect(pending).rejects.toThrow("offline");

    await vi.waitFor(() => expect(stored("a")).toEqual(serverCopy));
    expect(api.hydrateAnnotations).toHaveBeenCalledWith(["a"]);
  });

  it("keeps a newer edit when the read-back lands after it", async () => {
    let finishRead!: (copies: IAnnotation[]) => void;
    api.hydrateAnnotations.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
    const saves = holdSaves();
    const failed = rename("a", "renamed");
    saves[0].reject(new Error("offline"));
    await expect(failed).rejects.toThrow("offline");

    // A new edit before the read-back returns.
    const newer = recolor("a", "#00ff00");
    finishRead([makeAnnotation("a", { name: "A" })]);
    await Promise.resolve();
    await Promise.resolve();

    expect(stored("a").color).toBe("#00ff00");
    saves[1].resolve();
    await newer;
  });

  it("does not apply a read-back that lands after a session change", async () => {
    let finishRead!: (copies: IAnnotation[]) => void;
    api.hydrateAnnotations.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
    const saves = holdSaves();
    const original = stored("a");
    const pending = rename("a", "renamed");
    saves[0].reject(new Error("offline"));
    await expect(pending).rejects.toThrow("offline");

    // Another server or a share link opens before the read-back returns.
    mainState.girderRest = {};
    finishRead([makeAnnotation("a", { name: "other server" })]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stored("a")).toBe(original);
  });

  it("applies only the latest read-back when two failed edits' read-backs overlap", async () => {
    const reads: ((copies: IAnnotation[]) => void)[] = [];
    api.hydrateAnnotations.mockImplementation(
      () => new Promise((resolve) => reads.push(resolve)),
    );
    const saves = holdSaves();
    const first = rename("a", "renamed");
    saves[0].reject(new Error("offline"));
    await expect(first).rejects.toThrow("offline");
    // A second edit fails too; both rollbacks restore the same object.
    const second = recolor("a", "#ff0000");
    saves[1].reject(new Error("offline"));
    await expect(second).rejects.toThrow("offline");
    await vi.waitFor(() => expect(reads).toHaveLength(2));

    reads[0]([makeAnnotation("a", { name: "older read" })]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    reads[1]([makeAnnotation("a", { name: "newer read" })]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stored("a").name).toBe("newer read");
  });

  it("does not let an older read-back apply after a newer one failed", async () => {
    const reads: {
      resolve: (copies: IAnnotation[]) => void;
      reject: (error: Error) => void;
    }[] = [];
    api.hydrateAnnotations.mockImplementation(
      () => new Promise((resolve, reject) => reads.push({ resolve, reject })),
    );
    const saves = holdSaves();
    const failEdit = async (index: number) => {
      const edit = rename("a", `renamed ${index}`);
      saves[index].reject(new Error("offline"));
      await expect(edit).rejects.toThrow("offline");
    };
    await failEdit(0);
    await failEdit(1);
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    // The second read-back fails, then a third edit fails and reads back.
    reads[1].reject(new Error("offline"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await failEdit(2);
    await vi.waitFor(() => expect(reads).toHaveLength(3));

    reads[0].resolve([makeAnnotation("a", { name: "oldest read" })]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    reads[2].resolve([makeAnnotation("a", { name: "newest read" })]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stored("a").name).toBe("newest read");
  });

  it("does not let a read-back undo a color assignment that changed nothing on screen", async () => {
    let finishRead!: (copies: IAnnotation[]) => void;
    api.hydrateAnnotations.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
    const saves = holdSaves();
    const failed = rename("a", "renamed");
    saves[0].reject(new Error("offline"));
    await expect(failed).rejects.toThrow("offline");
    // The server clears colors after the read-back was sent; the restored
    // color is already null, so nothing changes on screen.
    annotationStore.applyColorAssignment([]);
    // The read-back reports a color someone else set before the clear.
    finishRead([makeAnnotation("a", { name: "A", color: "#abcdef" })]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stored("a").color).toBeNull();
  });

  it("forgets a read-back that a color assignment superseded", async () => {
    let finishRead!: (copies: IAnnotation[]) => void;
    api.hydrateAnnotations.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
    const saves = holdSaves();
    const failed = rename("a", "renamed");
    saves[0].reject(new Error("offline"));
    await expect(failed).rejects.toThrow("offline");
    annotationStore.applyColorAssignment([]);
    finishRead([makeAnnotation("a", { name: "A" })]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(pendingReadBackCount()).toBe(0);
  });

  it("keeps the restored value when the read-back fails", async () => {
    api.hydrateAnnotations.mockRejectedValue(new Error("still offline"));
    const saves = holdSaves();
    const original = stored("a");
    const pending = rename("a", "renamed");
    saves[0].reject(new Error("offline"));
    await expect(pending).rejects.toThrow("offline");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stored("a")).toBe(original);
  });

  it("keeps an assigned color that matched a failed edit's color", async () => {
    const saves = holdSaves();
    const first = recolor("a", "#ff0000");
    const second = rename("a", "renamed");

    saves[0].reject(new Error("offline"));
    await expect(first).rejects.toThrow("offline");
    // Color-by-property assigns the same red server-side while the rename is
    // pending: nothing changes on screen, but the server now holds it.
    annotationStore.applyColorAssignment([{ color: "#ff0000", ids: ["a"] }]);
    await sent(saves, 2);
    saves[1].resolve();
    await second;

    expect(stored("a").color).toBe("#ff0000");
    expect(stored("a").name).toBe("renamed");
  });

  it("does not restore an annotation deleted during a failed save", async () => {
    const saves = holdSaves();
    const pending = rename("a", "renamed");
    annotationStore.setAnnotations([stored("b")]);

    saves[0].reject(new Error("offline"));
    await expect(pending).rejects.toThrow("offline");
    expect(annotationStore.annotations.map(({ id }) => id)).toEqual(["b"]);
  });

  it("reverts a failed edit after a color assignment copied it forward", async () => {
    const saves = holdSaves();
    const pending = rename("a", "renamed");
    // Color-by-property writes colors server-side and copies each stored
    // annotation forward with its new color, unsaved rename included.
    annotationStore.applyColorAssignment([{ color: "#0000ff", ids: ["a"] }]);

    saves[0].reject(new Error("offline"));
    await expect(pending).rejects.toThrow("offline");
    expect(stored("a").name).toBe("A");
    expect(stored("a").color).toBe("#0000ff");
  });

  it("restores the original when an edit listing an id twice fails after an earlier failed edit", async () => {
    const saves = holdSaves();
    const original = stored("a");
    const first = rename("a", "renamed");
    const second = annotationStore.updateAnnotationsPerId({
      annotationIds: ["a", "a"],
      editFunction: (annotation) => {
        annotation.color = "#ff0000";
      },
    });

    saves[0].reject(new Error("offline"));
    await expect(first).rejects.toThrow("offline");
    await sent(saves, 2);
    saves[1].reject(new Error("offline"));
    await expect(second).rejects.toThrow("offline");

    expect(stored("a")).toEqual(original);
  });
});

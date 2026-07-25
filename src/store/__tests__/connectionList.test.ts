import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  AnnotationShape,
  IAnnotation,
  IAnnotationConnection,
} from "@/store/model";
import { MAX_CONNECT_SELECTED } from "@/store/constants";

// Exercise the real module against mocked neighbours. ./root stays real — the
// dynamic module registers on it.
const {
  mainMock,
  annotationMock,
  filtersMock,
  deleteConnections,
  createFromBases,
} = vi.hoisted(() => ({
  mainMock: {
    isLoggedIn: true,
    dataset: { id: "ds1" },
    currentLocation: { xy: 0, z: 0, time: 0 },
  },
  annotationMock: {
    annotationConnections: [] as any[],
    annotationsForIteration: [] as any[],
    selectedAnnotationIds: new Set<string>(),
    getAnnotationFromId: () => undefined as any,
    getStub: () => undefined as any,
  } as any,
  filtersMock: { filteredAnnotations: [] as any[] },
  deleteConnections: vi.fn(),
  createFromBases: vi.fn(),
}));

// The mocked neighbours must be REACTIVE: connectionList's getters are Vuex
// getters, so they cache until a tracked dependency changes. Against plain
// objects they would compute once (against empty state) and never recompute,
// making every assertion below pass or fail for the wrong reason.
vi.mock("@/store/index", async () => {
  const { reactive } = await import("vue");
  return { default: reactive(mainMock) };
});
vi.mock("@/store/annotation", async () => {
  const { reactive } = await import("vue");
  annotationMock.deleteConnections = (...a: any[]) => deleteConnections(...a);
  annotationMock.createConnectionsFromBases = (...a: any[]) =>
    createFromBases(...a);
  return { default: reactive(annotationMock) };
});
vi.mock("@/store/filters", async () => {
  const { reactive } = await import("vue");
  return { default: reactive(filtersMock) };
});

import connectionList from "@/store/connectionList";
// Mutate through the reactive proxies, not the raw hoisted objects, or the
// getters won't see the change.
import main from "@/store/index";
import annotationStore from "@/store/annotation";

function makeConnection(
  id: string,
  parentId: string,
  childId: string,
): IAnnotationConnection {
  return { id, parentId, childId, tags: [], label: "", datasetId: "ds1" };
}

function makeAnnotation(id: string, time: number): IAnnotation {
  return {
    id,
    name: null,
    tags: [],
    shape: AnnotationShape.Point,
    channel: 0,
    location: { XY: 0, Z: 0, Time: time },
    coordinates: [{ x: 0, y: 0 }],
    datasetId: "ds1",
    color: null,
  };
}

function setAnnotations(annotations: IAnnotation[]) {
  const byId = new Map(annotations.map((a) => [a.id, a]));
  (annotationStore as any).annotationsForIteration = annotations;
  (annotationStore as any).getAnnotationFromId = (id: string) => byId.get(id);
}

beforeEach(() => {
  vi.clearAllMocks();
  deleteConnections.mockResolvedValue(undefined);
  createFromBases.mockResolvedValue([]);
  (main as any).isLoggedIn = true;
  (annotationStore as any).annotationConnections = [];
  (annotationStore as any).selectedAnnotationIds = new Set();
  setAnnotations([]);
  connectionList.setScope("all");
  connectionList.setGrouping("flat");
  connectionList.setSelectedConnectionIds([]);
});

describe("connectionList scoping", () => {
  it("returns every connection under the 'all' scope", () => {
    (annotationStore as any).annotationConnections = [
      makeConnection("c1", "a", "b"),
      makeConnection("c2", "x", "y"),
    ];
    expect(connectionList.scopedConnections).toHaveLength(2);
  });

  it("keeps a connection when EITHER endpoint is in scope", () => {
    (annotationStore as any).annotationConnections = [
      makeConnection("c1", "a", "outside"),
      makeConnection("c2", "x", "y"),
    ];
    (annotationStore as any).selectedAnnotationIds = new Set(["a"]);
    connectionList.setScope("selected");
    expect(connectionList.scopedConnections.map((c) => c.id)).toEqual(["c1"]);
  });

  it("scopes to the current location by either endpoint", () => {
    setAnnotations([makeAnnotation("here", 0), makeAnnotation("elsewhere", 5)]);
    (annotationStore as any).annotationConnections = [
      makeConnection("c1", "here", "elsewhere"),
      makeConnection("c2", "elsewhere", "elsewhere"),
    ];
    connectionList.setScope("location");
    expect(connectionList.scopedConnections.map((c) => c.id)).toEqual(["c1"]);
  });
});

describe("connectionList selection safety", () => {
  // Regression: a selection made under one scope must not survive to feed
  // "Delete selected" under another, or the user deletes rows they can't see.
  it("clears the selection when the scope changes", () => {
    connectionList.setSelectedConnectionIds(["c1", "c2"]);
    expect(connectionList.selectedConnectionIds.size).toBe(2);

    connectionList.setScope("location");
    expect(connectionList.selectedConnectionIds.size).toBe(0);
  });

  it("keeps the selection across a flat/track grouping toggle", () => {
    connectionList.setSelectedConnectionIds(["c1", "c2"]);
    connectionList.setGrouping("track");
    expect(connectionList.selectedConnectionIds.size).toBe(2);
    connectionList.setGrouping("flat");
    expect(connectionList.selectedConnectionIds.size).toBe(2);
  });

  // Clearing on setScope is not enough: the inputs a dynamic scope reads can
  // change without setScope ever firing, silently replacing the visible rows.
  // The list's bulk delete is therefore derived from the intersection.
  describe("stale selection when scope INPUTS change", () => {
    it("drops rows that leave scope when the current location changes", async () => {
      setAnnotations([makeAnnotation("here", 0), makeAnnotation("gone", 0)]);
      (annotationStore as any).annotationConnections = [
        makeConnection("c1", "here", "here"),
        makeConnection("c2", "gone", "gone"),
      ];
      connectionList.setScope("location");
      connectionList.setSelectedConnectionIds(["c1", "c2"]);
      expect(connectionList.selectedInScopeConnectionIds).toEqual(["c1", "c2"]);

      // Scrub to another timepoint: "gone" is no longer at the location.
      setAnnotations([makeAnnotation("here", 0), makeAnnotation("gone", 7)]);
      expect(connectionList.selectedInScopeConnectionIds).toEqual(["c1"]);

      await connectionList.deleteSelectedInScopeConnections();
      expect(deleteConnections).toHaveBeenCalledWith(["c1"]);
    });

    it("drops rows that leave scope when the object selection changes", async () => {
      setAnnotations([makeAnnotation("a", 0), makeAnnotation("b", 0)]);
      (annotationStore as any).annotationConnections = [
        makeConnection("c1", "a", "a"),
        makeConnection("c2", "b", "b"),
      ];
      (annotationStore as any).selectedAnnotationIds = new Set(["a", "b"]);
      connectionList.setScope("selected");
      connectionList.setSelectedConnectionIds(["c1", "c2"]);
      expect(connectionList.selectedInScopeConnectionIds).toHaveLength(2);

      (annotationStore as any).selectedAnnotationIds = new Set(["a"]);
      expect(connectionList.selectedInScopeConnectionIds).toEqual(["c1"]);

      await connectionList.deleteSelectedInScopeConnections();
      expect(deleteConnections).toHaveBeenCalledWith(["c1"]);
    });

    it("still deletes the raw selection from the viewer action panel", async () => {
      setAnnotations([makeAnnotation("a", 0)]);
      (annotationStore as any).annotationConnections = [
        makeConnection("c1", "a", "a"),
      ];
      (annotationStore as any).selectedAnnotationIds = new Set();
      connectionList.setScope("selected");
      // Out of scope, but the user clicked this line in the viewer.
      connectionList.setSelectedConnectionIds(["c1"]);
      expect(connectionList.selectedInScopeConnectionIds).toEqual([]);

      await connectionList.deleteSelectedConnections();
      expect(deleteConnections).toHaveBeenCalledWith(["c1"]);
    });
  });

  // Connections can be deleted by paths that never touch this module — the
  // bulk Delete-connections dialog, deleteAllTimelapseConnections. Existence is
  // therefore derived, not maintained by reacting to each deletion path.
  it("ignores selected ids whose connection no longer exists", async () => {
    (annotationStore as any).annotationConnections = [
      makeConnection("c1", "a", "b"),
      makeConnection("c2", "b", "c"),
    ];
    connectionList.setSelectedConnectionIds(["c1", "c2"]);
    expect(connectionList.selectedExistingConnectionIds).toEqual(["c1", "c2"]);

    // Something else deleted c2 straight from the annotation store.
    (annotationStore as any).annotationConnections = [
      makeConnection("c1", "a", "b"),
    ];
    expect(connectionList.selectedExistingConnectionIds).toEqual(["c1"]);

    // The viewer panel's delete must not re-request the vanished id.
    await connectionList.deleteSelectedConnections();
    expect(deleteConnections).toHaveBeenCalledWith(["c1"]);
  });

  it("prunes deleted ids from the selection", async () => {
    connectionList.setSelectedConnectionIds(["c1", "c2", "c3"]);
    await connectionList.deleteConnectionsById(["c1", "c3"]);
    expect(deleteConnections).toHaveBeenCalledWith(["c1", "c3"]);
    expect([...connectionList.selectedConnectionIds]).toEqual(["c2"]);
  });

  it("deletes in a single batched call, never one request per id", async () => {
    (annotationStore as any).annotationConnections = [
      makeConnection("c1", "a", "b"),
      makeConnection("c2", "b", "c"),
      makeConnection("c3", "c", "d"),
    ];
    connectionList.setSelectedConnectionIds(["c1", "c2", "c3"]);
    await connectionList.deleteSelectedConnections();
    expect(deleteConnections).toHaveBeenCalledTimes(1);
    expect(deleteConnections).toHaveBeenCalledWith(["c1", "c2", "c3"]);
  });

  it("does not call the backend for an empty delete", async () => {
    await connectionList.deleteConnectionsById([]);
    expect(deleteConnections).not.toHaveBeenCalled();
  });
});

describe("connectionList connect selected", () => {
  function selectAnnotations(count: number) {
    const annotations = Array.from({ length: count }, (_, i) =>
      makeAnnotation(`a${i}`, i),
    );
    setAnnotations(annotations);
    (annotationStore as any).selectedAnnotationIds = new Set(
      annotations.map((a) => a.id),
    );
  }

  it("requires at least two selected annotations", () => {
    selectAnnotations(1);
    expect(connectionList.canConnectSelected).toBe(false);
    selectAnnotations(2);
    expect(connectionList.canConnectSelected).toBe(true);
  });

  it("requires being logged in", () => {
    selectAnnotations(2);
    (main as any).isLoggedIn = false;
    expect(connectionList.canConnectSelected).toBe(false);
  });

  // Regression: without a cap, a select-all in the Objects tab would POST tens
  // of thousands of connections in one request.
  it("refuses a selection larger than the cap", () => {
    selectAnnotations(MAX_CONNECT_SELECTED + 1);
    expect(connectionList.canConnectSelected).toBe(false);
    expect(connectionList.connectSelectedExceedsMax).toBe(true);
  });

  it("allows a selection exactly at the cap", () => {
    selectAnnotations(MAX_CONNECT_SELECTED);
    expect(connectionList.canConnectSelected).toBe(true);
    expect(connectionList.connectSelectedExceedsMax).toBe(false);
  });

  it("creates nothing when the cap is exceeded", async () => {
    selectAnnotations(MAX_CONNECT_SELECTED + 1);
    expect(await connectionList.connectSelectedAnnotations()).toEqual([]);
    expect(createFromBases).not.toHaveBeenCalled();
  });

  // Regression: createConnectionsFromBases sets the app-wide saving flag and is
  // rawError, so a rejection propagates — without try/finally the indicator
  // stuck on forever.
  it("clears the saving state when the create request rejects", async () => {
    selectAnnotations(2);
    createFromBases.mockRejectedValueOnce(new Error("backend said no"));
    await expect(connectionList.connectSelectedAnnotations()).rejects.toThrow(
      "backend said no",
    );
    // The action must not swallow it either — the caller shows the reason.
  });

  // Regression: an empty RESULT cannot mean dedupe, because the API layer turns
  // HTTP failures into []. Only an empty CHAIN means "already connected".
  it("flags dedupe only when the chain was empty before the request", async () => {
    selectAnnotations(2);
    const [a0, a1] = [...(annotationStore as any).selectedAnnotationIds];
    (annotationStore as any).annotationConnections = [
      makeConnection("existing", a0, a1),
    ];
    await connectionList.connectSelectedAnnotations();
    expect(connectionList.lastConnectSkippedAsDuplicate).toBe(true);

    (annotationStore as any).annotationConnections = [];
    createFromBases.mockResolvedValueOnce([]); // request failed, not dedupe
    await connectionList.connectSelectedAnnotations();
    expect(connectionList.lastConnectSkippedAsDuplicate).toBe(false);
  });

  it("chains earlier→later and tags the result", async () => {
    selectAnnotations(3);
    await connectionList.connectSelectedAnnotations();
    const bases = createFromBases.mock.calls[0][0];
    expect(bases.map((b: any) => [b.parentId, b.childId])).toEqual([
      ["a0", "a1"],
      ["a1", "a2"],
    ]);
    expect(bases[0].tags).toEqual(["Time lapse connection"]);
  });
});

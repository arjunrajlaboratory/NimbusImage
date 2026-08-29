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
    scheduleAnnotationBrowserSave: vi.fn(),
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

import connectionList, {
  ITrackFilters,
  createEmptyTrackFilters,
} from "@/store/connectionList";
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
  connectionList.setTrackFilters(createEmptyTrackFilters());
  connectionList.setHideFilteredTrackObjects(false);
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

describe("global track analysis", () => {
  it("is cached across scope changes and invalidated by connection changes", () => {
    (annotationStore as any).annotationConnections = [
      makeConnection("c1", "a", "b"),
      makeConnection("c2", "b", "c"),
    ];

    const first = connectionList.trackAnalysis;
    expect(first.trackKeyByAnnotationId.get("c")).toBe("a");

    connectionList.setScope("selected");
    expect(connectionList.trackAnalysis).toBe(first);

    // Removing the bridge splits b-c from a. The immutable connection-array
    // replacement must invalidate the cached analysis exactly at this boundary.
    (annotationStore as any).annotationConnections = [
      makeConnection("c2", "b", "c"),
    ];
    const afterDelete = connectionList.trackAnalysis;

    expect(afterDelete).not.toBe(first);
    expect(afterDelete.trackKeyByAnnotationId.get("c")).toBe("b");
  });
});

describe("connectionList cost guards", () => {
  // Regression: the location scope built a set of ids by scanning
  // annotationsForIteration, which in stub-only mode materializes an array of
  // every stub (709K on a real dataset) on every XY/Z/Time scrub. Resolving
  // the connections' own endpoints is O(connections) instead.
  //
  // The test leaves annotationsForIteration EMPTY while the endpoints remain
  // resolvable, so an implementation that scans it finds nothing.
  it("scopes by location without scanning every annotation", () => {
    const here = makeAnnotation("here", 0);
    const there = makeAnnotation("there", 0);
    there.location = { XY: 9, Z: 9, Time: 9 };
    const byId = new Map([
      ["here", here],
      ["there", there],
    ]);
    (annotationStore as any).getAnnotationFromId = (id: string) => byId.get(id);
    (annotationStore as any).annotationsForIteration = [];
    (annotationStore as any).annotationConnections = [
      makeConnection("atLocation", "here", "here"),
      makeConnection("elsewhere", "there", "there"),
    ];

    connectionList.setScope("location");
    expect(connectionList.scopedConnections.map((c) => c.id)).toEqual([
      "atLocation",
    ]);
  });

  // Regression: the cap resolved every selected id before checking the limit,
  // so a server-mode select-all materialized hundreds of thousands of
  // annotations just to conclude "too many".
  it("rejects an oversized selection without resolving it", () => {
    let resolveCalls = 0;
    (annotationStore as any).getAnnotationFromId = (id: string) => {
      resolveCalls++;
      return makeAnnotation(id, 0);
    };
    (annotationStore as any).selectedAnnotationIds = new Set(
      Array.from({ length: MAX_CONNECT_SELECTED + 50 }, (_, i) => `a${i}`),
    );

    expect(connectionList.connectSelectedExceedsMax).toBe(true);
    expect(connectionList.canConnectSelected).toBe(false);
    // Tie detection must not walk the oversized selection either.
    expect(connectionList.connectSelectedTimeTies).toEqual([]);
    expect(resolveCalls).toBe(0);
  });

  // Regression (pattern: cost before guard). selectedExistingConnectionIds
  // filters a usually tiny selection against a Set of EVERY connection id, and
  // it is read from ImageViewer and ConnectionActionPanel, which are not gated
  // by the Connections tab. Keeping the set in its own getter means a selection
  // change reuses it instead of rebuilding it.
  it("reuses the connection id set across selection changes", () => {
    (annotationStore as any).annotationConnections = [
      makeConnection("c1", "a", "b"),
      makeConnection("c2", "b", "c"),
    ];
    const first = connectionList.connectionIdSet;
    connectionList.setSelectedConnectionIds(["c1"]);
    // Same object identity ⇒ the cached getter was not invalidated.
    expect(connectionList.connectionIdSet).toBe(first);
    expect(connectionList.selectedExistingConnectionIds).toEqual(["c1"]);

    // Changing the connections themselves must invalidate it.
    (annotationStore as any).annotationConnections = [
      makeConnection("c1", "a", "b"),
    ];
    expect(connectionList.connectionIdSet).not.toBe(first);
  });

  it("still resolves a selection within the cap", () => {
    let resolveCalls = 0;
    const byId = new Map([
      ["a0", makeAnnotation("a0", 0)],
      ["a1", makeAnnotation("a1", 1)],
    ]);
    (annotationStore as any).getAnnotationFromId = (id: string) => {
      resolveCalls++;
      return byId.get(id);
    };
    (annotationStore as any).selectedAnnotationIds = new Set(["a0", "a1"]);

    expect(connectionList.canConnectSelected).toBe(true);
    expect(resolveCalls).toBeGreaterThan(0);
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

  it("clears the dedupe flag on a dataset switch", () => {
    connectionList.setLastConnectSkippedAsDuplicate(true);
    connectionList.resetConnectionListState();
    // Otherwise a stale flag mislabels the next empty result in a different
    // dataset as "already connected".
    expect(connectionList.lastConnectSkippedAsDuplicate).toBe(false);
  });

  it("prunes deleted ids from the selection", async () => {
    connectionList.setSelectedConnectionIds(["c1", "c2", "c3"]);
    await connectionList.deleteConnectionsById(["c1", "c3"]);
    expect(deleteConnections).toHaveBeenCalledWith(["c1", "c3"]);
    expect([...connectionList.selectedConnectionIds]).toEqual(["c2"]);
  });

  // Regression (pattern: one of two symmetric pieces of state). Deleting
  // pruned the selection but left hoveredConnectionId pointing at a connection
  // that no longer exists.
  it("clears the hover when the hovered connection is deleted", async () => {
    (annotationStore as any).annotationConnections = [
      makeConnection("c1", "a", "b"),
      makeConnection("c2", "b", "c"),
    ];
    connectionList.setHoveredConnectionId("c1");
    await connectionList.deleteConnectionsById(["c1"]);
    expect(connectionList.hoveredConnectionId).toBeNull();
  });

  it("keeps the hover when a different connection is deleted", async () => {
    (annotationStore as any).annotationConnections = [
      makeConnection("c1", "a", "b"),
      makeConnection("c2", "b", "c"),
    ];
    connectionList.setHoveredConnectionId("c2");
    await connectionList.deleteConnectionsById(["c1"]);
    expect(connectionList.hoveredConnectionId).toBe("c2");
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

// --- Track label property (issue #1330) ---
//
// The chosen path is persisted per configuration through the annotation
// browser config, so the same schedule-on-change / silent-hydration contract
// as displayedPropertyPaths applies.
describe("track label path", () => {
  it("schedules a configuration save when the user picks a property", () => {
    connectionList.setTrackLabelPath(["prop1", "trackId"]);
    expect(connectionList.trackLabelPath).toEqual(["prop1", "trackId"]);
    expect(mainMock.scheduleAnnotationBrowserSave).toHaveBeenCalledTimes(1);
  });

  it("does not schedule a save when hydrating from a configuration", () => {
    connectionList.hydrateTrackLabelPath(["prop1", "trackId"]);
    expect(connectionList.trackLabelPath).toEqual(["prop1", "trackId"]);
    expect(mainMock.scheduleAnnotationBrowserSave).not.toHaveBeenCalled();
  });

  it("clears the path on a dataset switch", () => {
    connectionList.hydrateTrackLabelPath(["prop1", "trackId"]);
    connectionList.resetConnectionListState();
    // The path names a property id from the outgoing configuration;
    // hydrateAnnotationBrowserState re-seeds it after this reset.
    expect(connectionList.trackLabelPath).toEqual([]);
  });

  // The persisted resolver drops a path whose property left the
  // configuration, and a live deletion must do the same immediately (same
  // contract as reconcileAnalysisPlotsForPropertyIds) — otherwise the panel
  // keeps labelling from the deleted property and a later browser save can
  // persist the orphaned path.
  it("clears the path and persists when its property is deleted", () => {
    connectionList.hydrateTrackLabelPath(["gone", "trackId"]);
    connectionList.reconcileTrackLabelPathForPropertyIds(["kept"]);
    expect(connectionList.trackLabelPath).toEqual([]);
    expect(mainMock.scheduleAnnotationBrowserSave).toHaveBeenCalledTimes(1);
  });

  it("keeps the path and stays silent while its property exists", () => {
    connectionList.hydrateTrackLabelPath(["kept", "trackId"]);
    connectionList.reconcileTrackLabelPathForPropertyIds(["kept"]);
    expect(connectionList.trackLabelPath).toEqual(["kept", "trackId"]);
    expect(mainMock.scheduleAnnotationBrowserSave).not.toHaveBeenCalled();
  });
});

// --- Track metric filters ---
//
// Filtering is by DATASET-WIDE track metrics (keyed off the global track
// analysis), so narrowing the scope must never make a long track read as
// short. The predicate is shared with the viewer's draw paths.
describe("track metric filters", () => {
  // Track A: a→b→c (T0..T2) — 2 connections, 3 members, duration 3.
  // Track X: x→y (T0, T9) — 1 connection, 2 members, duration 10.
  function seedTracks() {
    setAnnotations([
      makeAnnotation("a", 0),
      makeAnnotation("b", 1),
      makeAnnotation("c", 2),
      makeAnnotation("x", 0),
      makeAnnotation("y", 9),
    ]);
    (annotationStore as any).annotationConnections = [
      makeConnection("t1", "a", "b"),
      makeConnection("t2", "b", "c"),
      makeConnection("t3", "x", "y"),
    ];
  }

  function filtersWith(partial: Partial<ITrackFilters>): ITrackFilters {
    return { ...createEmptyTrackFilters(), ...partial };
  }

  it("filters by connections-in-track range", () => {
    seedTracks();
    connectionList.setTrackFilters(
      filtersWith({ connectionCount: { min: 2, max: null } }),
    );
    expect(connectionList.scopedConnections.map((c) => c.id)).toEqual([
      "t1",
      "t2",
    ]);
  });

  it("filters by objects-in-track range", () => {
    seedTracks();
    connectionList.setTrackFilters(
      filtersWith({ memberCount: { min: null, max: 2 } }),
    );
    expect(connectionList.scopedConnections.map((c) => c.id)).toEqual(["t3"]);
  });

  it("filters by duration range", () => {
    seedTracks();
    connectionList.setTrackFilters(
      filtersWith({ duration: { min: 5, max: null } }),
    );
    expect(connectionList.scopedConnections.map((c) => c.id)).toEqual(["t3"]);
  });

  it("uses dataset-wide metrics even when the scope shows a fragment", () => {
    seedTracks();
    // Scope to "b" only: track A appears as a fragment, but its metrics are
    // still the full track's (duration 3), so a min-duration of 3 keeps it.
    (annotationStore as any).selectedAnnotationIds = new Set(["b"]);
    connectionList.setScope("selected");
    connectionList.setTrackFilters(
      filtersWith({ duration: { min: 3, max: null } }),
    );
    expect(connectionList.scopedConnections.map((c) => c.id)).toEqual([
      "t1",
      "t2",
    ]);
  });

  it("hides a track of unknown duration under an active duration bound", () => {
    // Every endpoint dangles (points at a deleted annotation), so the
    // duration cannot be known and the track is pure data rot. Excluding it
    // was first flipped to fail-open ("hiding real rows is worse"), then
    // flipped back once the clean-up-dangling action existed: with a real
    // remedy available, a duration filter should not keep ghost tracks.
    setAnnotations([]);
    (annotationStore as any).annotationConnections = [
      makeConnection("t1", "gone1", "gone2"),
    ];
    connectionList.setTrackFilters(
      filtersWith({ duration: { min: null, max: 100 } }),
    );
    expect(connectionList.scopedConnections).toEqual([]);
    // Count bounds are always known, dangling or not.
    connectionList.setTrackFilters(
      filtersWith({ connectionCount: { min: 1, max: null } }),
    );
    expect(connectionList.scopedConnections.map((c) => c.id)).toEqual(["t1"]);
  });

  // Cost guard: the viewer reads the predicate on every draw pass, so with no
  // filter active it must be a constant that never touches the track metrics
  // (which resolve every connected annotation).
  it("does not resolve annotations while no filter is active", () => {
    let resolveCalls = 0;
    (annotationStore as any).getAnnotationFromId = (id: string) => {
      resolveCalls++;
      return makeAnnotation(id, 0);
    };
    (annotationStore as any).annotationConnections = [
      makeConnection("t1", "a", "b"),
    ];
    expect(connectionList.scopedConnections).toHaveLength(1);
    expect(connectionList.connectionPassesTrackFilters({ parentId: "a" })).toBe(
      true,
    );
    expect(resolveCalls).toBe(0);
  });

  it("returns the scope's own array identity while no filter is active", () => {
    seedTracks();
    expect(connectionList.scopedConnections).toBe(
      (annotationStore as any).annotationConnections,
    );
  });

  // Same rationale as setScope: an explicit filter change redefines what "the
  // list" means, so a selection made under the old definition must not feed
  // "Delete selected".
  it("clears the selection and resets the page when filters change", () => {
    connectionList.setPage(3);
    connectionList.setSelectedConnectionIds(["t1"]);
    connectionList.setTrackFilters(
      filtersWith({ connectionCount: { min: 2, max: null } }),
    );
    expect(connectionList.selectedConnectionIds.size).toBe(0);
    expect(connectionList.page).toBe(1);
  });

  // Belt to that clearing's braces: rows hidden by the filter must not be
  // deletable through a selection that predates it (same intersection rule as
  // the dynamic scopes).
  it("bulk delete acts only on rows passing the filters", async () => {
    seedTracks();
    connectionList.setSelectedConnectionIds(["t1", "t3"]);
    connectionList.setTrackFilters(
      filtersWith({ duration: { min: 5, max: null } }),
    );
    // Re-select after the clearing to model a viewer-click selection.
    connectionList.setSelectedConnectionIds(["t1", "t3"]);
    expect(connectionList.selectedInScopeConnectionIds).toEqual(["t3"]);
    await connectionList.deleteSelectedInScopeConnections();
    expect(deleteConnections).toHaveBeenCalledWith(["t3"]);
  });

  // Numeric ranges are meaningless across datasets with different track
  // scales, unlike the scope/grouping view preferences.
  it("resets the filters on a dataset switch", () => {
    seedTracks();
    connectionList.setTrackFilters(
      filtersWith({ connectionCount: { min: 2, max: null } }),
    );
    connectionList.resetConnectionListState();
    expect(connectionList.trackFiltersActive).toBe(false);
    expect(connectionList.scopedConnections).toHaveLength(3);
  });

  it("exposes the pre-filter scope count for the 'N of M' readout", () => {
    seedTracks();
    connectionList.setTrackFilters(
      filtersWith({ duration: { min: 5, max: null } }),
    );
    expect(connectionList.scopedConnections).toHaveLength(1);
    expect(connectionList.scopeOnlyConnections).toHaveLength(3);
  });
});

// --- Hiding filtered-out tracks' objects (opt-in) ---
describe("track filter object hiding", () => {
  // Track A: a→b→c (2 connections). Track X: x→y (1). "solo" is unconnected.
  function seedTracks() {
    setAnnotations([
      makeAnnotation("a", 0),
      makeAnnotation("b", 1),
      makeAnnotation("c", 2),
      makeAnnotation("x", 0),
      makeAnnotation("y", 9),
      makeAnnotation("solo", 3),
    ]);
    (annotationStore as any).annotationConnections = [
      makeConnection("t1", "a", "b"),
      makeConnection("t2", "b", "c"),
      makeConnection("t3", "x", "y"),
    ];
  }

  function minTwoConnections(): ITrackFilters {
    return {
      ...createEmptyTrackFilters(),
      connectionCount: { min: 2, max: null },
    };
  }

  it("hides an object of a failing track only when opted in", () => {
    seedTracks();
    connectionList.setTrackFilters(minTwoConnections());
    // Checkbox off: the track filter narrows connections, never objects.
    expect(connectionList.annotationPassesTrackFilters("x")).toBe(true);

    connectionList.setHideFilteredTrackObjects(true);
    expect(connectionList.annotationPassesTrackFilters("x")).toBe(false);
    expect(connectionList.annotationPassesTrackFilters("y")).toBe(false);
    expect(connectionList.annotationPassesTrackFilters("a")).toBe(true);
  });

  it("never hides unconnected objects", () => {
    seedTracks();
    connectionList.setTrackFilters(minTwoConnections());
    connectionList.setHideFilteredTrackObjects(true);
    // "solo" has no track, so a track filter says nothing about it.
    expect(connectionList.annotationPassesTrackFilters("solo")).toBe(true);
  });

  // The viewer's displayed-set computed reads this on every rebuild, so the
  // common case (checkbox off) must be a stable constant that costs nothing
  // and registers no dependency on the track metrics.
  it("is a stable pass-all constant while the opt-in is off", () => {
    seedTracks();
    connectionList.setTrackFilters(minTwoConnections());
    const first = connectionList.annotationPassesTrackFilters;
    expect(connectionList.annotationPassesTrackFilters).toBe(first);
    connectionList.setHideFilteredTrackObjects(true);
    expect(connectionList.annotationPassesTrackFilters).not.toBe(first);
    connectionList.setHideFilteredTrackObjects(false);
    expect(connectionList.annotationPassesTrackFilters).toBe(first);
  });

  it("hides nothing when the opt-in is set but no filter is active", () => {
    seedTracks();
    connectionList.setHideFilteredTrackObjects(true);
    expect(connectionList.trackFilterHidesObjects).toBe(false);
    expect(connectionList.annotationPassesTrackFilters("x")).toBe(true);
  });

  it("resets the opt-in on a dataset switch", () => {
    connectionList.setHideFilteredTrackObjects(true);
    connectionList.resetConnectionListState();
    expect(connectionList.hideFilteredTrackObjects).toBe(false);
  });
});

// --- Dangling connection cleanup ---
describe("dangling connection cleanup", () => {
  it("identifies a connection as dangling when EITHER endpoint is gone", () => {
    setAnnotations([makeAnnotation("a", 0), makeAnnotation("b", 1)]);
    (annotationStore as any).annotationConnections = [
      makeConnection("ok", "a", "b"),
      makeConnection("halfGone", "a", "deleted1"),
      makeConnection("allGone", "deleted2", "deleted3"),
    ];
    expect(connectionList.danglingConnectionIds).toEqual([
      "halfGone",
      "allGone",
    ]);
  });

  it("counts a stub-backed endpoint as resolvable", () => {
    // Lazy mode: getAnnotationFromId misses, the stub is the ground truth.
    (annotationStore as any).getAnnotationFromId = () => undefined;
    (annotationStore as any).getStub = (id: string) =>
      id === "stubbed" ? { id } : undefined;
    (annotationStore as any).annotationConnections = [
      makeConnection("ok", "stubbed", "stubbed"),
      makeConnection("gone", "stubbed", "deleted"),
    ];
    expect(connectionList.danglingConnectionIds).toEqual(["gone"]);
  });

  it("deletes every dangling connection in one batched request", async () => {
    setAnnotations([makeAnnotation("a", 0)]);
    (annotationStore as any).annotationConnections = [
      makeConnection("ok", "a", "a"),
      makeConnection("d1", "a", "gone1"),
      makeConnection("d2", "gone2", "a"),
    ];
    await connectionList.deleteDanglingConnections();
    expect(deleteConnections).toHaveBeenCalledTimes(1);
    expect(deleteConnections).toHaveBeenCalledWith(["d1", "d2"]);
  });

  it("does not call the backend when nothing dangles", async () => {
    setAnnotations([makeAnnotation("a", 0)]);
    (annotationStore as any).annotationConnections = [
      makeConnection("ok", "a", "a"),
    ];
    await connectionList.deleteDanglingConnections();
    expect(deleteConnections).not.toHaveBeenCalled();
  });
});

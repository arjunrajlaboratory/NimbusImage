import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Exercises the local color apply that replaces the post-recolor refetch, and
// the hydration race it has to survive. Uses the REAL store module (no "@/store"
// mock) so the mutations under test are the ones that ship.
import annotationStore from "./annotation";
import store from "./root";
import { IAnnotation, IAnnotationStub } from "./model";

function stub(id: string, color: string | null): IAnnotationStub {
  return {
    id,
    shape: "polygon",
    tags: [],
    channel: 0,
    location: { XY: 0, Z: 0, Time: 0 },
    color,
    centroid: { x: 0, y: 0 },
    estimatedRadius: 1,
  } as unknown as IAnnotationStub;
}

function annotation(id: string, color: string | null): IAnnotation {
  return {
    ...stub(id, color),
    coordinates: [{ x: 0, y: 0, z: 0 }],
    datasetId: "ds1",
    name: null,
  } as unknown as IAnnotation;
}

function setState(partial: Record<string, unknown>) {
  Object.assign((store.state as any).annotation, partial);
}

describe("applyColorAssignment", () => {
  beforeEach(() => {
    setState({
      annotationStubs: new Map(),
      hydratedAnnotations: new Map(),
      annotations: [],
      selectedAnnotationIds: [],
      mutationCounter: 0,
    });
  });

  afterEach(() => {
    setState({
      annotationStubs: new Map(),
      hydratedAnnotations: new Map(),
      annotations: [],
    });
    vi.restoreAllMocks();
  });

  it("colors listed stubs and nulls the ones the backend cleared", () => {
    setState({
      annotationStubs: new Map([
        ["a1", stub("a1", null)],
        ["a2", stub("a2", "#oldold")],
        // a3 has no value for the property, so the backend cleared it.
        ["a3", stub("a3", "#staleee")],
      ]),
    });
    annotationStore.applyColorAssignment([
      { color: "#111111", ids: ["a1"] },
      { color: "#222222", ids: ["a2"] },
    ]);
    const stubs = annotationStore.annotationStubs;
    expect(stubs.get("a1")!.color).toBe("#111111");
    expect(stubs.get("a2")!.color).toBe("#222222");
    expect(stubs.get("a3")!.color).toBeNull();
  });

  it("replaces the stub map reference so watchers fire", () => {
    const before = new Map([["a1", stub("a1", null)]]);
    setState({ annotationStubs: before });
    annotationStore.applyColorAssignment([{ color: "#111111", ids: ["a1"] }]);
    expect(annotationStore.annotationStubs).not.toBe(before);
  });

  it("patches hydrated copies and full annotations too", () => {
    setState({
      annotationStubs: new Map([["a1", stub("a1", null)]]),
      hydratedAnnotations: new Map([["a1", annotation("a1", null)]]),
      annotations: [annotation("a1", null), annotation("a9", "#staleee")],
    });
    annotationStore.applyColorAssignment([{ color: "#111111", ids: ["a1"] }]);
    expect(annotationStore.hydratedAnnotations.get("a1")!.color).toBe(
      "#111111",
    );
    expect(annotationStore.annotations[0].color).toBe("#111111");
    // Not in the assignment -> cleared, same as the backend did.
    expect(annotationStore.annotations[1].color).toBeNull();
  });

  it("an empty assignment clears every color (the clear path)", () => {
    setState({
      annotationStubs: new Map([
        ["a1", stub("a1", "#111111")],
        ["a2", stub("a2", "#222222")],
      ]),
      annotations: [annotation("a1", "#111111")],
    });
    annotationStore.applyColorAssignment([]);
    expect(
      [...annotationStore.annotationStubs.values()].map((s) => s.color),
    ).toEqual([null, null]);
    expect(annotationStore.annotations[0].color).toBeNull();
  });

  it("bumps mutationCounter so the overview raster refetches its tiles", () => {
    // The overview is a server-rendered image of these colors, and its tile
    // URLs carry mutationCounter as the cache buster. Skipping the local
    // refetch is only safe because this bump replaces it.
    setState({ annotationStubs: new Map([["a1", stub("a1", null)]]) });
    annotationStore.applyColorAssignment([{ color: "#111111", ids: ["a1"] }]);
    expect(annotationStore.mutationCounter).toBe(1);
  });

  it("bumps mutationCounter on the clear path too", () => {
    setState({ annotationStubs: new Map([["a1", stub("a1", "#111111")]]) });
    annotationStore.applyColorAssignment([]);
    expect(annotationStore.mutationCounter).toBe(1);
  });

  it("does not bump when no color actually moved", () => {
    // Re-applying an identical assignment must not make the overview discard
    // and re-fetch every tile for a byte-identical image.
    setState({ annotationStubs: new Map([["a1", stub("a1", "#111111")]]) });
    annotationStore.applyColorAssignment([{ color: "#111111", ids: ["a1"] }]);
    expect(annotationStore.mutationCounter).toBe(0);
  });

  it("leaves geometry alone (colors don't move anything)", () => {
    // Identity can't be asserted through Vuex's reactive proxy, but content
    // can: the centroid index must survive a recolor intact, since skipping
    // the refetch relies on the geometry indexes staying valid.
    setState({
      annotationStubs: new Map([["a1", stub("a1", null)]]),
      annotationCentroids: { a1: { x: 5, y: 6 } },
    });
    annotationStore.applyColorAssignment([{ color: "#111111", ids: ["a1"] }]);
    expect((store.state as any).annotation.annotationCentroids).toEqual({
      a1: { x: 5, y: 6 },
    });
    expect(annotationStore.annotationStubs.get("a1")!.centroid).toEqual({
      x: 0,
      y: 0,
    });
    expect(annotationStore.annotationStubs.get("a1")!.estimatedRadius).toBe(1);
  });
});

describe("mergeHydratedAnnotations color precedence", () => {
  beforeEach(() => {
    setState({
      annotationStubs: new Map(),
      hydratedAnnotations: new Map(),
      annotations: [],
      selectedAnnotationIds: [],
    });
  });

  afterEach(() => {
    setState({
      annotationStubs: new Map(),
      hydratedAnnotations: new Map(),
    });
  });

  it("a hydration that predates a recolor cannot reinstate the old color", () => {
    // The race: a hydration request issued before color-by-property lands
    // after it, carrying the pre-recolor color for that annotation.
    setState({ annotationStubs: new Map([["a1", stub("a1", "#newnew")]]) });
    annotationStore.mergeHydratedAnnotations({
      newEntries: [{ id: "a1", annotation: annotation("a1", "#oldold") }],
      touchedIds: [],
    });
    expect(annotationStore.hydratedAnnotations.get("a1")!.color).toBe(
      "#newnew",
    );
  });

  it("keeps the fetched annotation as-is when there is no stub", () => {
    // Non-stub mode: nothing local to prefer, so trust the response.
    annotationStore.mergeHydratedAnnotations({
      newEntries: [{ id: "a1", annotation: annotation("a1", "#fetchd") }],
      touchedIds: [],
    });
    expect(annotationStore.hydratedAnnotations.get("a1")!.color).toBe(
      "#fetchd",
    );
  });

  it("passes the fetched object through untouched when colors agree", () => {
    const fetched = annotation("a1", "#samesa");
    setState({ annotationStubs: new Map([["a1", stub("a1", "#samesa")]]) });
    annotationStore.mergeHydratedAnnotations({
      newEntries: [{ id: "a1", annotation: fetched }],
      touchedIds: [],
    });
    // Same reference: no needless copy on the hot hydration path.
    expect(annotationStore.hydratedAnnotations.get("a1")).toBe(fetched);
  });

  it("preserves geometry from the fetch while overriding color", () => {
    setState({ annotationStubs: new Map([["a1", stub("a1", "#newnew")]]) });
    const fetched = annotation("a1", "#oldold");
    (fetched as any).coordinates = [
      { x: 1, y: 2, z: 0 },
      { x: 3, y: 4, z: 0 },
    ];
    annotationStore.mergeHydratedAnnotations({
      newEntries: [{ id: "a1", annotation: fetched }],
      touchedIds: [],
    });
    const merged = annotationStore.hydratedAnnotations.get("a1")!;
    expect(merged.color).toBe("#newnew");
    expect(merged.coordinates).toEqual(fetched.coordinates);
  });
});

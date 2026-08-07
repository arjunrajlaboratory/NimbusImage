/**
 * Regression tests for deletion-state cleanup in the annotation store.
 *
 * Bug (PR #1299 review, finding F5): `deleteAnnotations` removed the
 * annotation/stub but left the deleted id in `selectedAnnotationIds` (only
 * the `deleteSelectedAnnotations` wrapper cleared the selection) and left a
 * dangling `hoveredAnnotationId`. A stale selected id then counted toward
 * the CSV export's subset-vs-whole-dataset comparison and could silently
 * widen a subset export to the whole dataset.
 *
 * These tests exercise the REAL store module (the CSV dialog test mocks the
 * store, so it cannot catch a regression in the pruning itself), in both
 * full and stub-only modes — a direct `deleteAnnotations([id])` is exactly
 * what the context-menu delete dispatches.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// deleteAnnotations only touches these dependencies; mock them to avoid
// pulling in the full store/geojs graph.
vi.mock("./index", () => ({
  default: {
    isLoggedIn: true,
    dataset: null,
    annotationsAPI: {
      deleteMultipleAnnotations: vi.fn().mockResolvedValue(undefined),
    },
  },
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
// Imported for a type only, but the import is not type-only, so it would
// pull the tool-creation component graph into this unit test.
vi.mock("@/tools/creation/templates/AnnotationConfiguration.vue", () => ({}));

import annotationStore from "./annotation";
import { AnnotationShape } from "./model";

function makeAnnotation(id: string) {
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
  };
}

function makeStub(id: string) {
  return {
    id,
    centroid: { x: 0, y: 0 },
    location: { XY: 0, Z: 0, Time: 0 },
    shape: AnnotationShape.Polygon,
    channel: 0,
    tags: [],
    color: null,
  };
}

describe("deleteAnnotations state cleanup", () => {
  beforeEach(() => {
    annotationStore.setAnnotations([]);
    annotationStore.setStubOnlyMode(false);
    annotationStore.setSelected([]);
    annotationStore.setHoveredAnnotationId(null);
  });

  it("prunes deleted ids from the selection in full mode", async () => {
    annotationStore.setAnnotations([
      makeAnnotation("a"),
      makeAnnotation("b"),
      makeAnnotation("c"),
    ]);
    annotationStore.setSelected(["a", "c"]);
    await annotationStore.deleteAnnotations(["c"]);
    expect([...annotationStore.selectedAnnotationIds]).toEqual(["a"]);
    expect(annotationStore.annotations.map((a) => a.id)).toEqual(["a", "b"]);
  });

  it("clears the hovered id when the hovered annotation is deleted", async () => {
    annotationStore.setAnnotations([makeAnnotation("a"), makeAnnotation("b")]);
    annotationStore.setHoveredAnnotationId("b");
    await annotationStore.deleteAnnotations(["b"]);
    expect(annotationStore.hoveredAnnotationId).toBeNull();
  });

  it("keeps an unrelated hovered id and selection", async () => {
    annotationStore.setAnnotations([makeAnnotation("a"), makeAnnotation("b")]);
    annotationStore.setSelected(["a"]);
    annotationStore.setHoveredAnnotationId("a");
    await annotationStore.deleteAnnotations(["b"]);
    expect([...annotationStore.selectedAnnotationIds]).toEqual(["a"]);
    expect(annotationStore.hoveredAnnotationId).toBe("a");
  });

  it("prunes selection, hover, and the stub map in stub-only mode", async () => {
    annotationStore.setStubsFromServer([makeStub("s1"), makeStub("s2")]);
    annotationStore.setStubOnlyMode(true);
    annotationStore.setSelected(["s1", "s2"]);
    annotationStore.setHoveredAnnotationId("s2");
    await annotationStore.deleteAnnotations(["s2"]);
    expect([...annotationStore.selectedAnnotationIds]).toEqual(["s1"]);
    expect(annotationStore.hoveredAnnotationId).toBeNull();
    expect(annotationStore.annotationStubs.has("s2")).toBe(false);
    expect(annotationStore.annotationCount).toBe(1);
  });
});

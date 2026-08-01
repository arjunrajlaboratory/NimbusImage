/**
 * contentRevision: the annotation store's cheap change identity.
 *
 * Above the analysis plot cap, gate resolution happens server-side and the
 * refresh trigger cannot hash a 700K-stub population per reactive touch
 * (SERVER_GATING.md). Instead it watches this counter: every mutation that
 * changes annotation CONTENT or MEMBERSHIP must bump it, and view-only
 * mutations (hover, selection, activation) must not — they would refetch
 * server gates on every click.
 *
 * This imports the REAL annotation store: a replicated mock would pass no
 * matter which real mutations forgot their bump (the shared-mock trap —
 * see MEMORY: a test that passes before its fix is worse than no test).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/store/index", () => ({
  default: {
    dataset: null,
    isLoggedIn: false,
    xy: 0,
    z: 0,
    time: 0,
    layers: [],
  },
}));
vi.mock("@/store/sync", () => ({
  default: { setSaving: vi.fn() },
}));
vi.mock("@/store/jobs", () => ({
  default: {},
  jobStates: {},
  createProgressEventCallback: () => () => {},
}));
vi.mock("@/store/progress", () => ({
  default: { create: vi.fn(), complete: vi.fn() },
  ProgressType: {},
}));
vi.mock("@/tools/creation/templates/AnnotationConfiguration.vue", () => ({}));
vi.mock("geojs", () => ({
  default: { util: { pointInPolygon: () => false } },
}));

import annotationStore from "@/store/annotation";
import {
  AnnotationShape,
  IAnnotation,
  IAnnotationStub,
} from "@/store/model";

function makeAnnotation(id: string, tags: string[] = []): IAnnotation {
  return {
    id,
    name: null,
    tags,
    shape: AnnotationShape.Point,
    channel: 0,
    location: { XY: 0, Z: 0, Time: 0 },
    coordinates: [{ x: 0, y: 0 }],
    datasetId: "ds1",
    color: null,
  };
}

function makeStub(id: string, tags: string[] = []): IAnnotationStub {
  return {
    id,
    centroid: { x: 0, y: 0 },
    location: { XY: 0, Z: 0, Time: 0 },
    shape: AnnotationShape.Point,
    channel: 0,
    tags,
    color: null,
  };
}

describe("annotation contentRevision", () => {
  beforeEach(() => {
    annotationStore.setAnnotations([]);
  });

  function bumped(mutate: () => void): boolean {
    const before = annotationStore.contentRevision;
    mutate();
    return annotationStore.contentRevision > before;
  }

  it("bumps on wholesale load (setAnnotations)", () => {
    expect(bumped(() => annotationStore.setAnnotations([makeAnnotation("a")])))
      .toBe(true);
  });

  it("bumps on stub load (setStubsFromServer)", () => {
    expect(bumped(() => annotationStore.setStubsFromServer([makeStub("s1")])))
      .toBe(true);
  });

  it("bumps on stub removal (removeAnnotationStubs)", () => {
    annotationStore.setStubsFromServer([makeStub("s1")]);
    expect(bumped(() => annotationStore.removeAnnotationStubs(["s1"]))).toBe(
      true,
    );
  });

  it("bumps on stub field updates (applyStubFieldUpdates)", () => {
    annotationStore.setStubsFromServer([makeStub("s1")]);
    expect(
      bumped(() =>
        annotationStore.applyStubFieldUpdates([
          { id: "s1", tags: ["edited"] },
        ]),
      ),
    ).toBe(true);
  });

  it("does NOT bump on view-only mutations", () => {
    annotationStore.setAnnotations([makeAnnotation("a")]);
    expect(
      bumped(() => {
        annotationStore.setHoveredAnnotationId("a");
        annotationStore.setSelected(["a"]);
        annotationStore.selectAnnotation("a");
        annotationStore.unselectAnnotation("a");
        annotationStore.activateAnnotations(["a"]);
        annotationStore.deactivateAnnotations(["a"]);
      }),
    ).toBe(false);
  });

  it("strictly increases across successive edits", () => {
    const first = annotationStore.contentRevision;
    annotationStore.setAnnotations([makeAnnotation("a")]);
    const second = annotationStore.contentRevision;
    annotationStore.setAnnotations([makeAnnotation("b")]);
    expect(second).toBeGreaterThan(first);
    expect(annotationStore.contentRevision).toBeGreaterThan(second);
  });

  /**
   * Completeness guard for the private mutations that public actions route
   * through (addAnnotationImpl, setAnnotation, setAnnotationsAtIndices,
   * resetAnnotationStateImpl...). They are not callable from here, so pin
   * them at the source level: every mutation that rebuilds the annotations
   * array or the stub map must contain the bump. A new content-changing
   * mutation that forgets it fails this test by name.
   */
  it("every content-changing mutation bumps (source scan)", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(__dirname, "../annotation.ts"),
      "utf8",
    );
    const mutations = [
      "resetAnnotationStateImpl",
      "addAnnotationImpl",
      "addAnnotationsImpl",
      "setAnnotation",
      "setAnnotationsAtIndices",
      "setAnnotations",
      "setStubsFromServer",
      "removeAnnotationStubs",
      "applyStubFieldUpdates",
    ];
    for (const name of mutations) {
      // Anchor on the DECLARATION (visibility modifier + name), not the
      // first occurrence — call sites like `this.addAnnotationImpl(...)`
      // appear earlier in the file.
      const declaration = new RegExp(
        `(?:public|private|protected) ${name}\\(`,
      );
      const match = declaration.exec(source);
      expect(match, `${name} not found in annotation.ts`).not.toBeNull();
      const start = match!.index;
      // The bump must appear within the mutation body — approximate the body
      // as the source until the next @Mutation/@Action decorator.
      const nextDecorator = source.slice(start).search(/@(Mutation|Action)/);
      const body = source.slice(
        start,
        nextDecorator > 0 ? start + nextDecorator : undefined,
      );
      expect(
        body.includes("this.contentRevision++"),
        `${name} does not bump contentRevision`,
      ).toBe(true);
    }
  });

});

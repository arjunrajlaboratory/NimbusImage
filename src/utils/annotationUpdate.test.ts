import { describe, expect, it } from "vitest";

import { AnnotationShape, IAnnotation, IAnnotationStub } from "@/store/model";
import { buildStubUpdates, getAnnotationUpdatePatch } from "./annotationUpdate";

function makeAnnotation(overrides: Partial<IAnnotation> = {}): IAnnotation {
  return {
    id: "ann-1",
    name: null,
    tags: ["cell"],
    shape: AnnotationShape.Polygon,
    channel: 0,
    location: { XY: 0, Z: 0, Time: 0 },
    coordinates: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ],
    datasetId: "dataset-1",
    color: null,
    ...overrides,
  };
}

describe("getAnnotationUpdatePatch", () => {
  it("returns null when an edit leaves the annotation unchanged", () => {
    const before = makeAnnotation();
    const after = structuredClone(before);

    expect(getAnnotationUpdatePatch(before, after)).toBeNull();
  });

  it("sends only changed geometry for coordinate edits", () => {
    const before = makeAnnotation({ name: null });
    const after = makeAnnotation({
      name: null,
      coordinates: [
        { x: 1, y: 2 },
        { x: 11, y: 2 },
        { x: 11, y: 12 },
      ],
    });

    expect(getAnnotationUpdatePatch(before, after)).toEqual({
      id: "ann-1",
      coordinates: after.coordinates,
    });
  });

  it("includes each changed metadata field without copying the full annotation", () => {
    const before = makeAnnotation();
    const after = makeAnnotation({
      tags: ["cell", "edited"],
      color: "#ff0000",
    });

    expect(getAnnotationUpdatePatch(before, after)).toEqual({
      id: "ann-1",
      tags: ["cell", "edited"],
      color: "#ff0000",
    });
  });
});

describe("buildStubUpdates", () => {
  function makeStub(overrides: Partial<IAnnotationStub> = {}): IAnnotationStub {
    return {
      id: "s1",
      centroid: { x: 0, y: 0 },
      location: { XY: 0, Z: 0, Time: 0 },
      shape: AnnotationShape.Polygon,
      channel: 0,
      tags: ["cell"],
      color: null,
      estimatedRadius: 1,
      ...overrides,
    };
  }

  it("builds tag patches and stub field updates from stubs", () => {
    const stubs: Record<string, IAnnotationStub> = {
      s1: makeStub({ id: "s1", tags: ["cell"] }),
      s2: makeStub({ id: "s2", tags: ["nucleus"] }),
    };
    const addTag = (a: IAnnotation) => {
      a.tags = [...a.tags, "edited"];
    };

    const { patches, stubFieldUpdates } = buildStubUpdates(
      ["s1", "s2"],
      (id) => stubs[id],
      addTag,
    );

    expect(patches).toEqual([
      { id: "s1", tags: ["cell", "edited"] },
      { id: "s2", tags: ["nucleus", "edited"] },
    ]);
    expect(stubFieldUpdates).toEqual([
      { id: "s1", tags: ["cell", "edited"] },
      { id: "s2", tags: ["nucleus", "edited"] },
    ]);
  });

  it("builds color patches and stub field updates", () => {
    const stubs: Record<string, IAnnotationStub> = {
      s1: makeStub({ id: "s1", color: null }),
    };
    const setColor = (a: IAnnotation) => {
      a.color = "#ff0000";
    };

    const { patches, stubFieldUpdates } = buildStubUpdates(
      ["s1"],
      (id) => stubs[id],
      setColor,
    );

    expect(patches).toEqual([{ id: "s1", color: "#ff0000" }]);
    expect(stubFieldUpdates).toEqual([{ id: "s1", color: "#ff0000" }]);
  });

  it("persists a name change but records no stub field update", () => {
    // Stubs do not carry `name`, so the patch still reaches the backend but
    // there is no local stub field to refresh.
    const stubs: Record<string, IAnnotationStub> = {
      s1: makeStub({ id: "s1" }),
    };
    const setName = (a: IAnnotation) => {
      a.name = "Renamed";
    };

    const { patches, stubFieldUpdates } = buildStubUpdates(
      ["s1"],
      (id) => stubs[id],
      setName,
    );

    expect(patches).toEqual([{ id: "s1", name: "Renamed" }]);
    expect(stubFieldUpdates).toEqual([]);
  });

  it("skips ids without a stub and unchanged edits", () => {
    const stubs: Record<string, IAnnotationStub> = {
      s1: makeStub({ id: "s1", tags: ["cell"] }),
    };
    const noop = () => {};

    const { patches, stubFieldUpdates } = buildStubUpdates(
      ["s1", "missing"],
      (id) => stubs[id],
      noop,
    );

    expect(patches).toEqual([]);
    expect(stubFieldUpdates).toEqual([]);
  });
});

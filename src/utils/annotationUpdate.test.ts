import { describe, expect, it } from "vitest";

import { AnnotationShape, IAnnotation } from "@/store/model";
import { getAnnotationUpdatePatch } from "./annotationUpdate";

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

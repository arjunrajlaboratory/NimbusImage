import { describe, expect, it, vi } from "vitest";
import { annotationsTo3D } from "@/utils/annotationsTo3D";
import { AnnotationShape, IAnnotation } from "@/store/model";
import type { VolumeGeometry } from "@/store/VolumeAPI";

vi.mock("@/utils/log", () => ({
  logWarning: vi.fn(),
  logError: vi.fn(),
}));

const geometry: VolumeGeometry = {
  unit: "um",
  spacing: [2, 4, 5],
  origin: [0, 0, 0],
  dimensions: [8, 4, 3],
  sourceSize: [16, 8],
};

function annotation(delta: Partial<IAnnotation>): IAnnotation {
  return {
    id: delta.id ?? "ann",
    name: null,
    datasetId: "dataset",
    channel: 0,
    color: null,
    tags: delta.tags ?? ["nucleus"],
    shape: delta.shape ?? AnnotationShape.Polygon,
    location: delta.location ?? { XY: 0, Z: 1, Time: 0 },
    coordinates: delta.coordinates ?? [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 2 },
      { x: 0, y: 2 },
    ],
  };
}

describe("annotationsTo3D", () => {
  it("extrudes current XY/time polygons into micrometer prism geometry", () => {
    const result = annotationsTo3D({
      annotations: [
        annotation({ id: "included" }),
        annotation({ id: "other-xy", location: { XY: 1, Z: 1, Time: 0 } }),
        annotation({ id: "spot", shape: AnnotationShape.Point }),
      ],
      geometry,
      currentXY: 0,
      currentTime: 0,
      colorMode: "tag",
      propertyPath: [],
      propertyValues: {},
    });

    expect(result.usedCount).toBe(1);
    expect(result.skippedByShape.point).toBe(1);
    expect(result.polyData.getNumberOfPoints()).toBe(8);
    expect(result.polyData.getNumberOfCells()).toBe(12);

    const points = Array.from(result.polyData.getPoints().getData());
    expect(points.slice(0, 12)).toEqual([
      0, 0, 2.5, 2, 0, 2.5, 2, 4, 2.5, 0, 4, 2.5,
    ]);
    expect(points.slice(12, 24)).toEqual([
      0, 0, 7.5, 2, 0, 7.5, 2, 4, 7.5, 0, 4, 7.5,
    ]);

    const scalars = result.polyData.getCellData().getScalars();
    expect(Array.from(scalars.getData())).toEqual(Array(12).fill(0));
  });

  it("uses numeric property values as per-cell scalars", () => {
    const result = annotationsTo3D({
      annotations: [annotation({ id: "ann-a" })],
      geometry,
      currentXY: 0,
      currentTime: 0,
      colorMode: "property",
      propertyPath: ["area"],
      propertyValues: { "ann-a": { area: 42 } },
    });

    expect(result.scalarRange).toEqual([42, 43]);
    expect(
      Array.from(result.polyData.getCellData().getScalars().getData()),
    ).toEqual(Array(12).fill(42));
  });

  it("falls back to neutral scalars when property values are missing", () => {
    const result = annotationsTo3D({
      annotations: [annotation({ id: "ann-a", tags: ["tag-a"] })],
      geometry,
      currentXY: 0,
      currentTime: 0,
      colorMode: "property",
      propertyPath: ["area"],
      propertyValues: {},
    });

    expect(result.scalarRange).toEqual([0, 1]);
    expect(
      Array.from(result.polyData.getCellData().getScalars().getData()),
    ).toEqual(Array(12).fill(0));
  });
});

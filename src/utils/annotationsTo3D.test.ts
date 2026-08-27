import { describe, expect, it, vi } from "vitest";
import {
  IAnnotationsTo3DOptions,
  annotationsTo3D,
} from "@/utils/annotationsTo3D";
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

function convert(
  annotations: IAnnotation[],
  delta: Partial<IAnnotationsTo3DOptions> = {},
) {
  return annotationsTo3D({
    annotations,
    geometry,
    currentXY: 0,
    currentTime: 0,
    colorMode: "tag",
    propertyPath: [],
    propertyValues: {},
    ...delta,
  });
}

describe("annotationsTo3D", () => {
  it("extrudes current XY/time polygons into micrometer prism geometry", async () => {
    const result = await convert([
      annotation({ id: "included" }),
      annotation({ id: "other-xy", location: { XY: 1, Z: 1, Time: 0 } }),
      annotation({ id: "unsupported", shape: AnnotationShape.Circle }),
    ]);

    expect(result.usedCount).toBe(1);
    expect(result.skippedByShape.circle).toBe(1);
    expect(result.surfacePolyData.getNumberOfPoints()).toBe(8);
    expect(result.surfacePolyData.getNumberOfCells()).toBe(12);

    const points = Array.from(result.surfacePolyData.getPoints().getData());
    expect(points.slice(0, 12)).toEqual([
      0, 0, 2.5, 2, 0, 2.5, 2, 4, 2.5, 0, 4, 2.5,
    ]);
    expect(points.slice(12, 24)).toEqual([
      0, 0, 7.5, 2, 0, 7.5, 2, 4, 7.5, 0, 4, 7.5,
    ]);

    const scalars = result.surfacePolyData.getCellData().getScalars();
    expect(Array.from(scalars.getData())).toEqual(Array(12).fill(0));
  });

  it("extrudes rectangles like polygons", async () => {
    const result = await convert([
      annotation({ shape: AnnotationShape.Rectangle }),
    ]);

    expect(result.usedCount).toBe(1);
    expect(result.surfacePolyData.getNumberOfCells()).toBe(12);
    expect(result.skippedByShape).toEqual({});
  });

  it("turns point annotations into sphere centers at the slice depth", async () => {
    const result = await convert([
      annotation({
        shape: AnnotationShape.Point,
        coordinates: [{ x: 2, y: 1 }],
      }),
    ]);

    expect(result.usedCount).toBe(1);
    expect(result.surfacePolyData.getNumberOfCells()).toBe(0);
    expect(result.pointsPolyData.getNumberOfPoints()).toBe(1);
    // Source pixel (2, 1) maps to (2 µm, 2 µm); z index 1 maps to 5 µm.
    expect(Array.from(result.pointsPolyData.getPoints().getData())).toEqual([
      2, 2, 5,
    ]);
    expect(
      Array.from(result.pointsPolyData.getPointData().getScalars().getData()),
    ).toEqual([0]);
    // 3 × in-plane source spacing and 0.6 × slice thickness both exceed the
    // volume-diagonal cap for this tiny volume, so the cap wins.
    expect(result.pointRadius).toBeCloseTo(Math.hypot(16, 16, 15) / 50, 6);
  });

  it("extrudes line annotations into ribbons through the slice", async () => {
    const result = await convert([
      annotation({
        shape: AnnotationShape.Line,
        coordinates: [
          { x: 0, y: 0 },
          { x: 2, y: 0 },
          { x: 4, y: 0 },
        ],
      }),
    ]);

    expect(result.usedCount).toBe(1);
    expect(result.surfacePolyData.getNumberOfPoints()).toBe(6);
    // Two triangles per segment.
    expect(result.surfacePolyData.getNumberOfCells()).toBe(4);

    const points = Array.from(result.surfacePolyData.getPoints().getData());
    expect(points.slice(0, 9)).toEqual([0, 0, 2.5, 2, 0, 2.5, 4, 0, 2.5]);
    expect(points.slice(9, 18)).toEqual([0, 0, 7.5, 2, 0, 7.5, 4, 0, 7.5]);
  });

  it("assigns consistent tag scalars across shapes", async () => {
    const result = await convert([
      annotation({ id: "blob", tags: ["nucleus"] }),
      annotation({
        id: "spot",
        tags: ["spot"],
        shape: AnnotationShape.Point,
        coordinates: [{ x: 1, y: 1 }],
      }),
    ]);

    expect(result.usedCount).toBe(2);
    expect(result.scalarRange).toEqual([0, 1]);
    // The polygon got tag scalar 0, so the differently-tagged point gets 1.
    expect(
      Array.from(result.pointsPolyData.getPointData().getScalars().getData()),
    ).toEqual([1]);
  });

  it("lofts overlapping same-tag polygons on adjacent slices", async () => {
    const result = await convert(
      [
        annotation({ id: "slice-0", location: { XY: 0, Z: 0, Time: 0 } }),
        annotation({ id: "slice-1", location: { XY: 0, Z: 1, Time: 0 } }),
      ],
      { loftSurfaces: true },
    );

    expect(result.usedCount).toBe(2);
    // Four rings (bottom skirt, two slice centers, top skirt) of 24 points.
    expect(result.surfacePolyData.getNumberOfPoints()).toBe(96);
    // Three bands of 2×24 triangles plus two end caps.
    expect(result.surfacePolyData.getNumberOfCells()).toBeGreaterThan(144);

    const points = Array.from(result.surfacePolyData.getPoints().getData());
    // The bottom skirt ring extends half a slice below the first center.
    expect(points[2]).toBe(-2.5);
    // The last pushed ring is the top skirt, half a slice above z index 1.
    expect(points[points.length - 1]).toBe(7.5);
  });

  it("keeps separate prisms when overlap is below the loft threshold", async () => {
    const annotations = [
      annotation({ id: "slice-0", location: { XY: 0, Z: 0, Time: 0 } }),
      annotation({
        id: "slice-1",
        location: { XY: 0, Z: 1, Time: 0 },
        // Shifted by half the width: 50% overlap of the smaller polygon.
        coordinates: [
          { x: 1, y: 0 },
          { x: 3, y: 0 },
          { x: 3, y: 2 },
          { x: 1, y: 2 },
        ],
      }),
    ];

    const lofted = await convert(annotations, {
      loftSurfaces: true,
      loftOverlapFraction: 0.25,
    });
    expect(lofted.surfacePolyData.getNumberOfPoints()).toBe(96);

    const separate = await convert(annotations, {
      loftSurfaces: true,
      loftOverlapFraction: 0.75,
    });
    expect(separate.surfacePolyData.getNumberOfPoints()).toBe(16);
    expect(separate.surfacePolyData.getNumberOfCells()).toBe(24);
  });

  it("does not loft across z gaps or across different tags", async () => {
    const gapped = await convert(
      [
        annotation({ id: "slice-0", location: { XY: 0, Z: 0, Time: 0 } }),
        annotation({ id: "slice-2", location: { XY: 0, Z: 2, Time: 0 } }),
      ],
      { loftSurfaces: true },
    );
    expect(gapped.surfacePolyData.getNumberOfCells()).toBe(24);

    const mixedTags = await convert(
      [
        annotation({
          id: "slice-0",
          tags: ["nucleus"],
          location: { XY: 0, Z: 0, Time: 0 },
        }),
        annotation({
          id: "slice-1",
          tags: ["cell"],
          location: { XY: 0, Z: 1, Time: 0 },
        }),
      ],
      { loftSurfaces: true },
    );
    expect(mixedTags.surfacePolyData.getNumberOfCells()).toBe(24);
  });

  it("uses numeric property values as per-cell scalars", async () => {
    const result = await convert([annotation({ id: "ann-a" })], {
      colorMode: "property",
      propertyPath: ["area"],
      propertyValues: { "ann-a": { area: 42 } },
    });

    expect(result.scalarRange).toEqual([42, 43]);
    expect(
      Array.from(result.surfacePolyData.getCellData().getScalars().getData()),
    ).toEqual(Array(12).fill(42));
  });

  it("falls back to neutral scalars when property values are missing", async () => {
    const result = await convert(
      [
        annotation({ id: "ann-a", tags: ["tag-a"] }),
        annotation({
          id: "spot",
          shape: AnnotationShape.Point,
          coordinates: [{ x: 1, y: 1 }],
        }),
      ],
      {
        colorMode: "property",
        propertyPath: ["area"],
        propertyValues: { "ann-a": { area: 42 } },
      },
    );

    // The point has no property value, so all shapes drop to neutral scalars.
    expect(result.scalarRange).toEqual([0, 1]);
    expect(
      Array.from(result.surfacePolyData.getCellData().getScalars().getData()),
    ).toEqual(Array(12).fill(0));
    expect(
      Array.from(result.pointsPolyData.getPointData().getScalars().getData()),
    ).toEqual([0]);
  });
});

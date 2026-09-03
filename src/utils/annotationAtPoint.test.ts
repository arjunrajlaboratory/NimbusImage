import { describe, expect, it, vi } from "vitest";

vi.mock("geojs", () => ({
  default: {
    util: {
      // Even-odd ray casting, enough for convex test shapes.
      pointInPolygon: (
        point: { x: number; y: number },
        polygon: { x: number; y: number }[],
      ) => {
        let inside = false;
        for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
          const a = polygon[i];
          const b = polygon[j];
          if (
            a.y > point.y !== b.y > point.y &&
            point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
          ) {
            inside = !inside;
          }
        }
        return inside;
      },
    },
  },
}));

import { annotationIdAtPoint } from "./annotationAtPoint";

function annotation(
  type: string,
  coordinates: { x: number; y: number }[],
  girderId: string | null = "id",
) {
  return {
    type: () => type,
    coordinates: () => coordinates,
    options: (key: string) => (key === "girderId" ? girderId : undefined),
  };
}

const square = (x0: number, y0: number, size: number) => [
  { x: x0, y: y0 },
  { x: x0 + size, y: y0 },
  { x: x0 + size, y: y0 + size },
  { x: x0, y: y0 + size },
];

describe("annotationIdAtPoint", () => {
  it("returns the polygon containing the point and skips the rest", () => {
    const layer = {
      annotations: () => [
        annotation("point", [{ x: 5, y: 5 }], "pt"),
        annotation("polygon", square(0, 0, 10), "a"),
        annotation("polygon", square(20, 20, 10), "b"),
        annotation("polygon", square(10, 0, 10), null),
      ],
    } as any;
    expect(annotationIdAtPoint(layer, { x: 25, y: 25 })).toBe("b");
    expect(annotationIdAtPoint(layer, { x: 5, y: 5 })).toBe("a");
    // Inside a polygon without a girder id, and outside every polygon.
    expect(annotationIdAtPoint(layer, { x: 15, y: 5 })).toBeNull();
    expect(annotationIdAtPoint(layer, { x: 50, y: 50 })).toBeNull();
  });

  it("uses the bounding box before the polygon test", () => {
    const coordinates = square(0, 0, 10);
    const layer = {
      annotations: () => [annotation("polygon", coordinates, "a")],
    } as any;
    expect(annotationIdAtPoint(layer, { x: 11, y: 5 })).toBeNull();
    expect(annotationIdAtPoint(layer, { x: 9.5, y: 5 })).toBe("a");
  });
});

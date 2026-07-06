import { describe, expect, it } from "vitest";
import {
  computeAnnulusMask,
  computeAnnulusRingWidth,
  computeMaskArea,
  dilateMask,
  rasterizePolygon,
  sampleFarFieldBackground,
} from "@/utils/exampleSegmentation/rasterize";
import { IWorkerPoint } from "@/utils/exampleSegmentation/types";

/** Brute-force even-odd point-in-polygon test, used as an oracle for rasterizePolygon. */
function pointInPolygonEvenOdd(
  point: IWorkerPoint,
  polygon: IWorkerPoint[],
): boolean {
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const crosses = a.y > point.y !== b.y > point.y;
    if (crosses) {
      const xIntersect = ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
      if (point.x < xIntersect) {
        inside = !inside;
      }
    }
  }
  return inside;
}

function bruteForceMask(
  polygon: IWorkerPoint[],
  width: number,
  height: number,
): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; ++y) {
    for (let x = 0; x < width; ++x) {
      const center = { x: x + 0.5, y: y + 0.5 };
      mask[y * width + x] = pointInPolygonEvenOdd(center, polygon) ? 1 : 0;
    }
  }
  return mask;
}

describe("rasterizePolygon", () => {
  const width = 20;
  const height = 20;

  it("matches brute-force point-in-polygon for a convex square", () => {
    const square: IWorkerPoint[] = [
      { x: 3, y: 3 },
      { x: 12, y: 3 },
      { x: 12, y: 12 },
      { x: 3, y: 12 },
    ];
    const mask = rasterizePolygon(square, width, height);
    const expected = bruteForceMask(square, width, height);
    expect(Array.from(mask)).toEqual(Array.from(expected));
    expect(computeMaskArea(mask)).toBe(9 * 9);
  });

  it("matches brute-force point-in-polygon for a concave (arrow) polygon", () => {
    const arrow: IWorkerPoint[] = [
      { x: 2, y: 2 },
      { x: 18, y: 2 },
      { x: 18, y: 18 },
      { x: 10, y: 10 },
      { x: 2, y: 18 },
    ];
    const mask = rasterizePolygon(arrow, width, height);
    const expected = bruteForceMask(arrow, width, height);
    expect(Array.from(mask)).toEqual(Array.from(expected));
  });

  it("matches brute-force point-in-polygon for a triangle", () => {
    const triangle: IWorkerPoint[] = [
      { x: 5, y: 2 },
      { x: 15, y: 8 },
      { x: 4, y: 17 },
    ];
    const mask = rasterizePolygon(triangle, width, height);
    const expected = bruteForceMask(triangle, width, height);
    expect(Array.from(mask)).toEqual(Array.from(expected));
  });

  it("clips polygons that extend outside the canvas", () => {
    const overflowing: IWorkerPoint[] = [
      { x: -10, y: -10 },
      { x: 10, y: -10 },
      { x: 10, y: 10 },
      { x: -10, y: 10 },
    ];
    const mask = rasterizePolygon(overflowing, width, height);
    expect(computeMaskArea(mask)).toBe(10 * 10);
  });

  it("produces an empty mask for a fully out-of-bounds polygon", () => {
    const outside: IWorkerPoint[] = [
      { x: 100, y: 100 },
      { x: 110, y: 100 },
      { x: 110, y: 110 },
      { x: 100, y: 110 },
    ];
    const mask = rasterizePolygon(outside, width, height);
    expect(computeMaskArea(mask)).toBe(0);
  });

  it("returns an empty mask for degenerate (< 3 point) input", () => {
    const mask = rasterizePolygon(
      [
        { x: 1, y: 1 },
        { x: 2, y: 2 },
      ],
      width,
      height,
    );
    expect(computeMaskArea(mask)).toBe(0);
  });
});

describe("computeAnnulusRingWidth", () => {
  it("is at least 5px for small areas", () => {
    expect(computeAnnulusRingWidth(1)).toBe(5);
    expect(computeAnnulusRingWidth(0)).toBe(5);
  });

  it("scales with 0.5*sqrt(area) for large areas", () => {
    const area = 10000; // sqrt = 100, 0.5*100 = 50 > 5
    expect(computeAnnulusRingWidth(area)).toBeCloseTo(50, 5);
  });
});

describe("dilateMask", () => {
  it("grows a single pixel into a (2r+1)x(2r+1) square", () => {
    const width = 21;
    const height = 21;
    const mask = new Uint8Array(width * height);
    mask[10 * width + 10] = 1;
    const dilated = dilateMask(mask, width, height, 3);
    expect(computeMaskArea(dilated)).toBe(7 * 7);
    for (let y = 7; y <= 13; ++y) {
      for (let x = 7; x <= 13; ++x) {
        expect(dilated[y * width + x]).toBe(1);
      }
    }
    expect(dilated[6 * width + 10]).toBe(0);
    expect(dilated[10 * width + 6]).toBe(0);
  });

  it("is a no-op for radius <= 0", () => {
    const width = 5;
    const height = 5;
    const mask = new Uint8Array(width * height);
    mask[12] = 1;
    const dilated = dilateMask(mask, width, height, 0);
    expect(Array.from(dilated)).toEqual(Array.from(mask));
  });
});

describe("computeAnnulusMask", () => {
  it("produces a ring that stays outside the original foreground mask", () => {
    const width = 30;
    const height = 30;
    const square: IWorkerPoint[] = [
      { x: 10, y: 10 },
      { x: 20, y: 10 },
      { x: 20, y: 20 },
      { x: 10, y: 20 },
    ];
    const foreground = rasterizePolygon(square, width, height);
    const ring = computeAnnulusMask(foreground, width, height, 3);

    expect(computeMaskArea(ring)).toBeGreaterThan(0);
    for (let i = 0; i < ring.length; ++i) {
      // Ring pixels must never overlap the foreground mask.
      expect(ring[i] === 1 && foreground[i] === 1).toBe(false);
    }
    // The ring should hug the boundary: a pixel just outside the square is in the ring.
    expect(ring[10 * width + 9]).toBe(1);
    // A pixel far away from the square is not in the ring.
    expect(ring[0]).toBe(0);
  });
});

describe("sampleFarFieldBackground", () => {
  it("only samples pixels outside the exclude mask", () => {
    const width = 40;
    const height = 40;
    const exclude = new Uint8Array(width * height);
    // Exclude the left half of the image.
    for (let y = 0; y < height; ++y) {
      for (let x = 0; x < width / 2; ++x) {
        exclude[y * width + x] = 1;
      }
    }
    const samples = sampleFarFieldBackground(exclude, width, height, 200);
    expect(samples.length).toBeGreaterThan(0);
    for (const pixel of samples) {
      expect(exclude[pixel]).toBe(0);
    }
  });

  it("is deterministic across repeated calls", () => {
    const width = 32;
    const height = 32;
    const exclude = new Uint8Array(width * height);
    const first = sampleFarFieldBackground(exclude, width, height, 50);
    const second = sampleFarFieldBackground(exclude, width, height, 50);
    expect(Array.from(first)).toEqual(Array.from(second));
  });

  it("returns an empty array when maxSamples is 0", () => {
    const exclude = new Uint8Array(10 * 10);
    expect(sampleFarFieldBackground(exclude, 10, 10, 0).length).toBe(0);
  });
});

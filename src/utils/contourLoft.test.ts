import { describe, expect, it } from "vitest";
import {
  alignRingToReference,
  overlapFraction,
  polygonArea,
  resampleClosedContour,
  signedArea,
} from "@/utils/contourLoft";

const unitSquare = [
  { x: 0, y: 0 },
  { x: 2, y: 0 },
  { x: 2, y: 2 },
  { x: 0, y: 2 },
];

function translated(points: { x: number; y: number }[], dx: number, dy = 0) {
  return points.map((point) => ({ x: point.x + dx, y: point.y + dy }));
}

describe("signedArea / polygonArea", () => {
  it("is positive for counter-clockwise rings and matches the area", () => {
    expect(signedArea(unitSquare)).toBe(4);
    expect(signedArea([...unitSquare].reverse())).toBe(-4);
    expect(polygonArea([...unitSquare].reverse())).toBe(4);
  });
});

describe("overlapFraction", () => {
  it("is 1 for identical polygons", () => {
    expect(overlapFraction(unitSquare, unitSquare)).toBeCloseTo(1, 6);
  });

  it("is the intersection area over the smaller polygon", () => {
    // Shifted by half the width: intersection 2, smaller area 4.
    expect(overlapFraction(unitSquare, translated(unitSquare, 1))).toBeCloseTo(
      0.5,
      6,
    );
    // A small square fully inside a big one overlaps 100% of itself.
    const small = [
      { x: 0.5, y: 0.5 },
      { x: 1, y: 0.5 },
      { x: 1, y: 1 },
      { x: 0.5, y: 1 },
    ];
    expect(overlapFraction(unitSquare, small)).toBeCloseTo(1, 6);
  });

  it("is 0 for disjoint or degenerate polygons", () => {
    expect(overlapFraction(unitSquare, translated(unitSquare, 5))).toBe(0);
    const degenerate = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ];
    expect(overlapFraction(unitSquare, degenerate)).toBe(0);
  });
});

describe("resampleClosedContour", () => {
  it("spaces points uniformly along the perimeter", () => {
    expect(resampleClosedContour(unitSquare, 8)).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 1 },
      { x: 2, y: 2 },
      { x: 1, y: 2 },
      { x: 0, y: 2 },
      { x: 0, y: 1 },
    ]);
  });

  it("forces counter-clockwise winding", () => {
    const resampled = resampleClosedContour([...unitSquare].reverse(), 8);
    expect(signedArea(resampled)).toBeGreaterThan(0);
  });
});

describe("alignRingToReference", () => {
  it("rotates a ring back onto its reference", () => {
    const reference = resampleClosedContour(unitSquare, 8);
    const rotated = reference.map(
      (_, index) => reference[(index + 3) % reference.length],
    );
    expect(alignRingToReference(rotated, reference)).toEqual(reference);
  });
});

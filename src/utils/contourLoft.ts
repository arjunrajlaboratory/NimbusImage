import polygonClipping from "polygon-clipping";

// 2D contour helpers used to loft stacked annotations into 3D surfaces
// (see annotationsTo3D.ts).

export interface IPlanarPoint {
  x: number;
  y: number;
}

// Shoelace formula; positive for counter-clockwise rings.
export function signedArea(points: IPlanarPoint[]): number {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

export function polygonArea(points: IPlanarPoint[]): number {
  return Math.abs(signedArea(points));
}

function toRing(points: IPlanarPoint[]): [number, number][] {
  return points.map((point) => [point.x, point.y]);
}

// Area of the xy intersection of two polygons as a fraction of the smaller
// polygon's area, in [0, 1]. Degenerate polygons yield 0.
export function overlapFraction(a: IPlanarPoint[], b: IPlanarPoint[]): number {
  const smallerArea = Math.min(polygonArea(a), polygonArea(b));
  if (smallerArea === 0) {
    return 0;
  }
  let intersection: [number, number][][][];
  try {
    intersection = polygonClipping.intersection([toRing(a)], [toRing(b)]);
  } catch {
    // polygon-clipping can fail on pathological rings (e.g. self-crossing
    // hand annotations); treat those as non-overlapping.
    return 0;
  }
  let intersectionArea = 0;
  for (const polygon of intersection) {
    polygon.forEach((ring, ringIndex) => {
      // The first ring is the outer boundary; later rings are holes.
      const ringArea = polygonArea(ring.map(([x, y]) => ({ x, y })));
      intersectionArea += ringIndex === 0 ? ringArea : -ringArea;
    });
  }
  return Math.min(1, intersectionArea / smallerArea);
}

// Resamples a closed contour to exactly `count` points, uniformly spaced by
// arc length, with counter-clockwise winding enforced so that resampled
// rings of different contours correspond point-for-point when lofting.
export function resampleClosedContour(
  points: IPlanarPoint[],
  count: number,
): IPlanarPoint[] {
  const ring = signedArea(points) >= 0 ? points : [...points].reverse();
  const edgeLengths: number[] = [];
  let perimeter = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const a = ring[index];
    const b = ring[(index + 1) % ring.length];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    edgeLengths.push(length);
    perimeter += length;
  }
  if (perimeter === 0) {
    return Array.from({ length: count }, () => ({ ...ring[0] }));
  }

  const step = perimeter / count;
  const result: IPlanarPoint[] = [];
  let edgeIndex = 0;
  let lengthBeforeEdge = 0;
  for (let index = 0; index < count; index += 1) {
    const target = index * step;
    while (
      edgeIndex < ring.length - 1 &&
      lengthBeforeEdge + edgeLengths[edgeIndex] <= target
    ) {
      lengthBeforeEdge += edgeLengths[edgeIndex];
      edgeIndex += 1;
    }
    const a = ring[edgeIndex];
    const b = ring[(edgeIndex + 1) % ring.length];
    const t =
      edgeLengths[edgeIndex] > 0
        ? (target - lengthBeforeEdge) / edgeLengths[edgeIndex]
        : 0;
    result.push({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
  }
  return result;
}

// Rotates `ring` (same length as `reference`) so that its points line up
// with the reference ring as closely as possible, preventing twisted bands
// between lofted slices. Both rings must have the same winding.
export function alignRingToReference(
  ring: IPlanarPoint[],
  reference: IPlanarPoint[],
): IPlanarPoint[] {
  const count = ring.length;
  let bestOffset = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let offset = 0; offset < count; offset += 1) {
    let score = 0;
    for (let index = 0; index < count && score < bestScore; index += 1) {
      const a = ring[(index + offset) % count];
      const b = reference[index];
      score += (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
    }
    if (score < bestScore) {
      bestScore = score;
      bestOffset = offset;
    }
  }
  if (bestOffset === 0) {
    return ring;
  }
  return ring.map((_, index) => ring[(index + bestOffset) % count]);
}

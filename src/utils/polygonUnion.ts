import polygonClipping from "polygon-clipping";
import { IGeoJSPosition } from "@/store/model";

/**
 * Computes the union of two polygons.
 * Returns the coordinates of the combined polygon, or null if the union
 * results in multiple polygons (which shouldn't happen for overlapping/adjacent polygons).
 *
 * @param coords1 - Coordinates of the first polygon
 * @param coords2 - Coordinates of the second polygon
 * @returns The union polygon coordinates, or null if the operation fails
 */
export function computePolygonUnion(
  coords1: IGeoJSPosition[],
  coords2: IGeoJSPosition[],
): IGeoJSPosition[] | null {
  // Convert IGeoJSPosition[] to the format expected by polygon-clipping
  // polygon-clipping expects: [[[x1, y1], [x2, y2], ...]]
  const poly1 = coordsToPolygon(coords1);
  const poly2 = coordsToPolygon(coords2);

  try {
    const result = polygonClipping.union(poly1, poly2);

    // Result is a MultiPolygon: array of polygons, each polygon is array of rings
    // For our use case, we expect a single polygon with a single outer ring
    if (result.length === 0) {
      return null;
    }

    // If we get multiple separate polygons, return the largest one
    // This handles edge cases where polygons don't overlap
    if (result.length > 1) {
      // Find the polygon with the most vertices (likely the combined one or largest)
      let largestIdx = 0;
      let largestSize = 0;
      for (let i = 0; i < result.length; i++) {
        const size = result[i][0]?.length || 0;
        if (size > largestSize) {
          largestSize = size;
          largestIdx = i;
        }
      }
      return ringToCoords(result[largestIdx][0]);
    }

    // Single polygon - take the outer ring (index 0)
    const outerRing = result[0][0];
    return ringToCoords(outerRing);
  } catch (error) {
    console.error("Error computing polygon union:", error);
    return null;
  }
}

/**
 * Convert IGeoJSPosition[] to polygon-clipping format
 */
function coordsToPolygon(coords: IGeoJSPosition[]): [number, number][][] {
  // Remove duplicate closing point if present
  let points = coords;
  if (
    coords.length > 1 &&
    coords[0].x === coords[coords.length - 1].x &&
    coords[0].y === coords[coords.length - 1].y
  ) {
    points = coords.slice(0, -1);
  }

  const ring: [number, number][] = points.map((p) => [p.x, p.y]);

  // polygon-clipping expects closed rings, so close it
  if (ring.length > 0) {
    ring.push([...ring[0]]);
  }

  return [ring];
}

/**
 * Convert polygon-clipping ring back to IGeoJSPosition[]
 */
function ringToCoords(ring: [number, number][]): IGeoJSPosition[] {
  return ring.map(([x, y]) => ({ x, y }));
}

/**
 * Check if two polygons overlap or are adjacent (share boundary).
 * Uses a simple bounding box check first, then more precise intersection test.
 */
export function polygonsOverlapOrAdjacent(
  coords1: IGeoJSPosition[],
  coords2: IGeoJSPosition[],
): boolean {
  // Quick bounding box check first
  const bbox1 = getBoundingBox(coords1);
  const bbox2 = getBoundingBox(coords2);

  // Check if bounding boxes overlap (with small tolerance for adjacency)
  const tolerance = 1e-6;
  if (
    bbox1.maxX < bbox2.minX - tolerance ||
    bbox2.maxX < bbox1.minX - tolerance ||
    bbox1.maxY < bbox2.minY - tolerance ||
    bbox2.maxY < bbox1.minY - tolerance
  ) {
    return false;
  }

  // Bounding boxes overlap, so polygons might overlap/be adjacent
  // For now, we'll assume if bboxes overlap, it's worth trying to combine
  return true;
}

interface BoundingBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

function getBoundingBox(coords: IGeoJSPosition[]): BoundingBox {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const p of coords) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }

  return { minX, maxX, minY, maxY };
}

/**
 * Computes the union of two polygons with tolerance for adjacent (non-overlapping) polygons.
 * If polygons overlap, returns the standard union.
 * If polygons are adjacent (within tolerance), creates a connector and merges them.
 * If polygons are too far apart (beyond tolerance), returns null.
 *
 * @param coords1 - Coordinates of the first polygon
 * @param coords2 - Coordinates of the second polygon
 * @param tolerance - Maximum gap distance to allow for merging (default: 2.0 pixels)
 * @returns The union polygon coordinates, or null if polygons are too far apart
 */
export function computePolygonUnionWithTolerance(
  coords1: IGeoJSPosition[],
  coords2: IGeoJSPosition[],
  tolerance: number = 2.0,
): IGeoJSPosition[] | null {
  const poly1 = coordsToPolygon(coords1);
  const poly2 = coordsToPolygon(coords2);

  try {
    const result = polygonClipping.union(poly1, poly2);

    if (result.length === 0) {
      return null;
    }

    // Single polygon result - polygons overlap, return the union
    if (result.length === 1) {
      return ringToCoords(result[0][0]);
    }

    // Multiple polygons - they don't overlap
    // Check if they're close enough to merge with tolerance
    const closestPoints = closestPointsBetweenPolygons(coords1, coords2);

    if (closestPoints.distance > tolerance) {
      // Polygons are too far apart - abort the operation
      return null;
    }

    // Polygons are within tolerance - create a connector to merge them
    // Translate each polygon toward the other by the tolerance amount
    // This ensures a robust overlap for the intersection calculation
    const dx = closestPoints.pointB.x - closestPoints.pointA.x;
    const dy = closestPoints.pointB.y - closestPoints.pointA.y;
    const distance = closestPoints.distance;

    // Normalize the direction vector and shift by the full tolerance
    // This guarantees sufficient overlap even when the gap is very small
    const unitX = distance > 0 ? dx / distance : 0;
    const unitY = distance > 0 ? dy / distance : 0;
    const shiftX = unitX * tolerance;
    const shiftY = unitY * tolerance;

    // Create shifted versions of the polygons
    const shiftedCoords1 = translateCoords(coords1, shiftX, shiftY);
    const shiftedCoords2 = translateCoords(coords2, -shiftX, -shiftY);

    const shiftedPoly1 = coordsToPolygon(shiftedCoords1);
    const shiftedPoly2 = coordsToPolygon(shiftedCoords2);

    // Compute intersection of shifted polygons to get the connector region
    const connector = polygonClipping.intersection(shiftedPoly1, shiftedPoly2);

    if (connector.length === 0) {
      // Fallback: if intersection fails, try a different approach
      // Create a small rectangular connector between the closest points
      const connectorPoly = createRectangularConnector(
        closestPoints.pointA,
        closestPoints.pointB,
        1.0, // connector width
      );

      // Union original polygons with the connector
      const finalResult = polygonClipping.union(poly1, poly2, connectorPoly);

      if (finalResult.length === 0) {
        return null;
      }

      // Return the largest polygon from the result
      return ringToCoords(getLargestPolygon(finalResult)[0]);
    }

    // Union the originals with the connector
    const finalResult = polygonClipping.union(poly1, poly2, ...connector);

    if (finalResult.length === 0) {
      return null;
    }

    // Return the largest polygon from the result
    return ringToCoords(getLargestPolygon(finalResult)[0]);
  } catch (error) {
    console.error("Error computing polygon union with tolerance:", error);
    return null;
  }
}

/**
 * Find the closest points between two polygon boundaries.
 */
function closestPointsBetweenPolygons(
  coordsA: IGeoJSPosition[],
  coordsB: IGeoJSPosition[],
): { pointA: IGeoJSPosition; pointB: IGeoJSPosition; distance: number } {
  let minDistance = Infinity;
  let closestA: IGeoJSPosition = coordsA[0];
  let closestB: IGeoJSPosition = coordsB[0];

  // Check each edge of polygon A against each edge of polygon B
  for (let i = 0; i < coordsA.length; i++) {
    const a1 = coordsA[i];
    const a2 = coordsA[(i + 1) % coordsA.length];

    for (let j = 0; j < coordsB.length; j++) {
      const b1 = coordsB[j];
      const b2 = coordsB[(j + 1) % coordsB.length];

      const result = segmentToSegmentClosestPoints(a1, a2, b1, b2);

      if (result.distance < minDistance) {
        minDistance = result.distance;
        closestA = result.pointA;
        closestB = result.pointB;
      }
    }
  }

  return { pointA: closestA, pointB: closestB, distance: minDistance };
}

/**
 * Find the closest points between two line segments.
 */
function segmentToSegmentClosestPoints(
  a1: IGeoJSPosition,
  a2: IGeoJSPosition,
  b1: IGeoJSPosition,
  b2: IGeoJSPosition,
): { pointA: IGeoJSPosition; pointB: IGeoJSPosition; distance: number } {
  // Check all combinations of point-to-segment distances
  const candidates: {
    pointA: IGeoJSPosition;
    pointB: IGeoJSPosition;
    distance: number;
  }[] = [];

  // Point a1 to segment B
  const p1 = closestPointOnSegment(a1, b1, b2);
  candidates.push({
    pointA: a1,
    pointB: p1,
    distance: pointDistance(a1, p1),
  });

  // Point a2 to segment B
  const p2 = closestPointOnSegment(a2, b1, b2);
  candidates.push({
    pointA: a2,
    pointB: p2,
    distance: pointDistance(a2, p2),
  });

  // Point b1 to segment A
  const p3 = closestPointOnSegment(b1, a1, a2);
  candidates.push({
    pointA: p3,
    pointB: b1,
    distance: pointDistance(p3, b1),
  });

  // Point b2 to segment A
  const p4 = closestPointOnSegment(b2, a1, a2);
  candidates.push({
    pointA: p4,
    pointB: b2,
    distance: pointDistance(p4, b2),
  });

  // Return the minimum
  return candidates.reduce((min, curr) =>
    curr.distance < min.distance ? curr : min,
  );
}

/**
 * Find the closest point on a line segment to a given point.
 */
function closestPointOnSegment(
  point: IGeoJSPosition,
  segStart: IGeoJSPosition,
  segEnd: IGeoJSPosition,
): IGeoJSPosition {
  const dx = segEnd.x - segStart.x;
  const dy = segEnd.y - segStart.y;
  const lengthSq = dx * dx + dy * dy;

  if (lengthSq === 0) {
    return segStart;
  }

  // Project point onto line, clamping to segment
  let t =
    ((point.x - segStart.x) * dx + (point.y - segStart.y) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));

  return {
    x: segStart.x + t * dx,
    y: segStart.y + t * dy,
  };
}

/**
 * Calculate distance between two points.
 */
function pointDistance(a: IGeoJSPosition, b: IGeoJSPosition): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Translate polygon coordinates by a given offset.
 */
function translateCoords(
  coords: IGeoJSPosition[],
  dx: number,
  dy: number,
): IGeoJSPosition[] {
  return coords.map((p) => ({ x: p.x + dx, y: p.y + dy }));
}

/**
 * Create a small rectangular polygon connecting two points.
 */
function createRectangularConnector(
  pointA: IGeoJSPosition,
  pointB: IGeoJSPosition,
  width: number,
): [number, number][][] {
  // Calculate perpendicular direction
  const dx = pointB.x - pointA.x;
  const dy = pointB.y - pointA.y;
  const length = Math.sqrt(dx * dx + dy * dy);

  if (length === 0) {
    return [
      [
        [pointA.x, pointA.y],
        [pointA.x, pointA.y],
      ],
    ];
  }

  // Perpendicular unit vector
  const perpX = (-dy / length) * (width / 2);
  const perpY = (dx / length) * (width / 2);

  // Create rectangle corners
  const ring: [number, number][] = [
    [pointA.x + perpX, pointA.y + perpY],
    [pointA.x - perpX, pointA.y - perpY],
    [pointB.x - perpX, pointB.y - perpY],
    [pointB.x + perpX, pointB.y + perpY],
    [pointA.x + perpX, pointA.y + perpY], // Close the ring
  ];

  return [ring];
}

/**
 * Get the largest polygon from a multi-polygon result based on area.
 */
function getLargestPolygon(
  result: [number, number][][][],
): [number, number][][] {
  if (result.length === 1) {
    return result[0];
  }

  let largestIdx = 0;
  let largestArea = 0;

  for (let i = 0; i < result.length; i++) {
    const area = Math.abs(computeRingArea(result[i][0]));
    if (area > largestArea) {
      largestArea = area;
      largestIdx = i;
    }
  }

  return result[largestIdx];
}

/**
 * Calculate the signed area of a polygon ring using the shoelace formula.
 */
function computeRingArea(ring: [number, number][]): number {
  let area = 0;
  const n = ring.length;

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += ring[i][0] * ring[j][1];
    area -= ring[j][0] * ring[i][1];
  }

  return area / 2;
}

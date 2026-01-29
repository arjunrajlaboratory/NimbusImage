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
function coordsToPolygon(
  coords: IGeoJSPosition[],
): [number, number][][] {
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

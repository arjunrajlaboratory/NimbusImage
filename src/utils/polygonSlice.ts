import { IGeoJSPosition } from "@/store/model";

// This function finds the intersection between a line and a line segment.
// It returns the intersection point if it exists, or null if the lines do not intersect.
export function findIntersection(
  lineStart: IGeoJSPosition,
  lineEnd: IGeoJSPosition,
  segStart: IGeoJSPosition,
  segEnd: IGeoJSPosition,
): IGeoJSPosition | null {
  const denom =
    (segEnd.y - segStart.y) * (lineEnd.x - lineStart.x) -
    (segEnd.x - segStart.x) * (lineEnd.y - lineStart.y);

  if (Math.abs(denom) < 1e-10) return null; // parallel lines

  const ua =
    ((segEnd.x - segStart.x) * (lineStart.y - segStart.y) -
      (segEnd.y - segStart.y) * (lineStart.x - segStart.x)) /
    denom;
  const ub =
    ((lineEnd.x - lineStart.x) * (lineStart.y - segStart.y) -
      (lineEnd.y - lineStart.y) * (lineStart.x - segStart.x)) /
    denom;

  if (ua < 0 || ua > 1 || ub < 0 || ub > 1) return null;

  return {
    x: lineStart.x + ua * (lineEnd.x - lineStart.x),
    y: lineStart.y + ua * (lineEnd.y - lineStart.y),
  };
}

// This function finds all intersections between a polygon and a line.
// It returns an array of objects, each containing a point, the index of the line segment,
// and the index of the polygon edge.
export function findAllIntersections(
  polygon: IGeoJSPosition[],
  newLine: IGeoJSPosition[],
): Array<{ point: IGeoJSPosition; index: number; lineSegmentIndex: number }> {
  const intersections: Array<{
    point: IGeoJSPosition;
    index: number;
    lineSegmentIndex: number;
  }> = [];

  // Check each line segment against each polygon edge
  for (let i = 0; i < newLine.length - 1; i++) {
    const lineStart = newLine[i];
    const lineEnd = newLine[i + 1];

    for (let j = 0; j < polygon.length - 1; j++) {
      const intersection = findIntersection(
        lineStart,
        lineEnd,
        polygon[j],
        polygon[j + 1],
      );

      if (intersection) {
        intersections.push({
          point: intersection,
          index: j + 1,
          lineSegmentIndex: i,
        });
      }
    }
  }

  return intersections;
}

// Helper function to check if two points are equal
export function pointsEqual(a: IGeoJSPosition, b: IGeoJSPosition): boolean {
  return Math.abs(a.x - b.x) < 1e-10 && Math.abs(a.y - b.y) < 1e-10;
}

// This function edits the polygon annotation by "carving" with a line.
// It finds the first and last intersections between the polygon and the line,
// and then reverses the line if the first intersection is after the last intersection
// (i.e., the line is in the reverse orientation of the polygon).
// It then splices in the line vertices between the first and last intersections.
export function editPolygonAnnotation(
  annotation: { coordinates: IGeoJSPosition[] },
  newLine: IGeoJSPosition[],
): IGeoJSPosition[] {
  if (newLine.length < 2) {
    return annotation.coordinates;
  }

  let polygon = annotation.coordinates;

  // Find all intersections
  const intersections = findAllIntersections(polygon, newLine);

  // Group intersections by line segment
  const intersectionsBySegment = intersections.reduce(
    (acc, intersection) => {
      if (!acc[intersection.lineSegmentIndex]) {
        acc[intersection.lineSegmentIndex] = [];
      }
      acc[intersection.lineSegmentIndex].push(intersection);
      return acc;
    },
    {} as Record<number, typeof intersections>,
  );

  // Find first and last intersection
  let firstIntersection: (typeof intersections)[0] | null = null;
  let lastIntersection: (typeof intersections)[0] | null = null;

  // Find the first valid intersection
  for (let i = 0; i < newLine.length - 1; i++) {
    const segmentIntersections = intersectionsBySegment[i];
    if (segmentIntersections?.length > 0) {
      firstIntersection = segmentIntersections[0];
      break;
    }
  }

  // Find the last valid intersection
  for (let i = newLine.length - 2; i >= 0; i--) {
    const segmentIntersections = intersectionsBySegment[i];
    if (segmentIntersections?.length > 0) {
      lastIntersection = segmentIntersections[segmentIntersections.length - 1];
      break;
    }
  }

  if (!firstIntersection || !lastIntersection) {
    return polygon;
  }

  // If the first intersection is after the last intersection, we need to rotate the polygon
  // to avoid the "seam" of the polygon.
  if (firstIntersection.index > lastIntersection.index) {
    // Rotate the polygon to have the first intersection before the last intersection
    polygon = polygon
      .slice(lastIntersection.index)
      .concat(polygon.slice(0, lastIntersection.index));

    firstIntersection.index = firstIntersection.index - lastIntersection.index;
    lastIntersection.index = 0; // Leave the last intersection index as 0 so that
    // the conditional reversal of the line based on the intersection order is
    // not affected by the rotation
  }

  // Determine if we need to reverse the line points based on intersection order
  const shouldReverseLine = firstIntersection.index > lastIntersection.index;

  // Get the centroid of the original polygon. Ultimately, we will choose the "direction"
  // of editing that results in the smallest change to the centroid.
  const centroid = getCentroid(polygon);

  const linePoints = [
    firstIntersection.point,
    ...newLine.slice(
      firstIntersection.lineSegmentIndex + 1,
      lastIntersection.lineSegmentIndex + 1,
    ),
    lastIntersection.point,
  ];

  // Create new coordinates array
  // This is what the edit would look like if we do not go over the seam
  let newCoordinates: IGeoJSPosition[] = [
    ...polygon.slice(
      0,
      Math.min(firstIntersection.index, lastIntersection.index),
    ),
    ...(shouldReverseLine ? [...linePoints].reverse() : linePoints),
    ...polygon.slice(Math.max(firstIntersection.index, lastIntersection.index)),
  ];

  // This is what the edit would look like if we go around the seam in the "forward" direction
  const newCoordinatesSeamForward = [
    ...polygon.slice(firstIntersection.index, lastIntersection.index),
    ...[...linePoints].reverse(),
  ];

  // This is what the edit would look like if we go around the seam in the "reverse" direction
  const newCoordinatesSeamReverse = [
    ...polygon.slice(
      0,
      Math.max(firstIntersection.index, lastIntersection.index),
    ),
    ...linePoints,
  ];

  const centroid0 = getCentroid(newCoordinates);
  const centroidSeamForward = getCentroid(newCoordinatesSeamForward);
  const centroidSeamReverse = getCentroid(newCoordinatesSeamReverse);

  // Distance between centroid0 and centroid
  const distance0 = Math.sqrt(
    (centroid0.x - centroid.x) ** 2 + (centroid0.y - centroid.y) ** 2,
  );

  // Distance between centroidSeamForward and centroid
  const distanceSeamForward = Math.sqrt(
    (centroidSeamForward.x - centroid.x) ** 2 +
      (centroidSeamForward.y - centroid.y) ** 2,
  );

  // Distance between centroidSeamReverse and centroid
  const distanceSeamReverse = Math.sqrt(
    (centroidSeamReverse.x - centroid.x) ** 2 +
      (centroidSeamReverse.y - centroid.y) ** 2,
  );

  // Logic here is: check if the order of the intersections is backwards or forwards
  // and then choose the edit that results in the smallest change to the centroid
  if (firstIntersection.index > lastIntersection.index) {
    if (distance0 > distanceSeamReverse) {
      newCoordinates = newCoordinatesSeamReverse;
    }
  } else {
    if (distance0 > distanceSeamForward) {
      newCoordinates = newCoordinatesSeamForward;
    }
  }

  // Ensure the polygon is closed
  if (
    !pointsEqual(newCoordinates[0], newCoordinates[newCoordinates.length - 1])
  ) {
    newCoordinates.push({ ...newCoordinates[0] });
  }

  return newCoordinates;
}

export function getCentroid(points: IGeoJSPosition[]) {
  let sumX = 0;
  let sumY = 0;
  for (const p of points) {
    sumX += p.x;
    sumY += p.y;
  }
  return { x: sumX / points.length, y: sumY / points.length };
}

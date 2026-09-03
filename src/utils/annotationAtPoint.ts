import geojs from "geojs";
import { IGeoJSAnnotationLayer, IGeoJSPosition } from "@/store/model";

/**
 * The id of the drawn annotation whose polygon contains `point` (map/image
 * pixels), or null. Used by the transcript overlay to say which cell a
 * clicked molecule sits in: the transcript store carries no cell reference,
 * so the question is geometric, and the outlines already on the annotation
 * layer are the cells the user is looking at.
 *
 * A linear pass with a bounding-box prefilter: clicks are rare and the layer
 * holds at most the visible outlines (tens of thousands), so this is a few
 * milliseconds. Non-polygon annotations (points, lines) are skipped.
 */
export function annotationIdAtPoint(
  layer: IGeoJSAnnotationLayer,
  point: IGeoJSPosition,
): string | null {
  for (const annotation of layer.annotations()) {
    const type = annotation.type();
    if (type !== "polygon" && type !== "rectangle") {
      continue;
    }
    const coordinates = annotation.coordinates();
    if (coordinates.length < 3 || !bboxContains(coordinates, point)) {
      continue;
    }
    if (geojs.util.pointInPolygon(point, coordinates)) {
      const id = annotation.options("girderId");
      return typeof id === "string" ? id : null;
    }
  }
  return null;
}

function bboxContains(coordinates: IGeoJSPosition[], point: IGeoJSPosition) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const { x, y } of coordinates) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return (
    point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY
  );
}

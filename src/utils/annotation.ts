import {
  IAnnotation,
  IImage,
  IGeoJSPosition,
  AnnotationShape,
  IAnnotationProperty,
  TGeoJSColor,
  IGeoJSLineFeatureStyle,
  IGeoJSPointFeatureStyle,
  IGeoJSPolygonFeatureStyle,
} from "@/store/model";
import geojs from "geojs";
import { logError } from "@/utils/log";

export type TAnnotationStyle = IGeoJSLineFeatureStyle &
  IGeoJSPointFeatureStyle &
  IGeoJSPolygonFeatureStyle;

// Which style an annotation should have, depending on its layer (color change)
export function getAnnotationStyleFromBaseStyle(
  baseStyle: { [key: string]: any; color?: TGeoJSColor },
  annotationColor?: string,
  isHovered: boolean = false,
  isSelected: boolean = false,
): TAnnotationStyle {
  const style: TAnnotationStyle = {
    stroke: true,
    strokeColor: "black",
    strokeOpacity: 1,
    strokeWidth: 4,
    fillColor: "white",
    fillOpacity: 0.5,
    fill: true,
    ...baseStyle,
  };

  if (annotationColor) {
    const geoColor = { ...geojs.util.convertColor(annotationColor) };
    geoColor.r *= 0.75;
    geoColor.g *= 0.75;
    geoColor.b *= 0.75;
    style.fillColor = annotationColor;
    style.strokeColor = geoColor;
  }
  if (isSelected) {
    style.strokeWidth = 6;
    if (annotationColor) {
      const geoColor = { ...geojs.util.convertColor(annotationColor) };
      style.strokeColor = geoColor;
    }
  }
  if (isHovered) {
    style.fillOpacity = 0;
    style.strokeWidth = 5;
    style.strokeColor = {
      r: 1,
      g: 0.9,
      b: 0.9,
    };
  }
  return style;
}

// Get the tile's index in unrolled layer based on its XY/Z/Time location
export function unrollIndexFromImages(
  XY: number,
  Z: number,
  Time: number,
  images: IImage[],
) {
  const matchingImage = images.find((image) => {
    return (
      (image.frame.IndexZ === undefined || image.frame.IndexZ === Z) &&
      (image.frame.IndexT === undefined || image.frame.IndexT === Time) &&
      (image.frame.IndexXY === undefined || image.frame.IndexXY === XY)
    );
  });

  return matchingImage?.keyOffset || 0;
}

// Create a geojs annotation depending on its shape
export function geojsAnnotationFactory(
  shape: string,
  coordinates: IGeoJSPosition[],
  options: any,
) {
  const annotationOptions = { ...options };

  switch (shape) {
    case AnnotationShape.Point:
      annotationOptions.position = coordinates[0];
      return geojs.annotation.pointAnnotation(annotationOptions);

    case AnnotationShape.Polygon:
      annotationOptions.vertices = coordinates;
      return geojs.annotation.polygonAnnotation(annotationOptions);

    case AnnotationShape.Line:
      annotationOptions.vertices = coordinates;
      return geojs.annotation.lineAnnotation(annotationOptions);

    case AnnotationShape.Rectangle:
      annotationOptions.corners = coordinates;
      return geojs.annotation.rectangleAnnotation(annotationOptions);

    default:
      logError(`Unsupported annotation shape: ${shape}`);
      return null;
  }
}

export function simpleCentroid(coordinates: IGeoJSPosition[]): IGeoJSPosition {
  if (coordinates.length === 1) {
    return coordinates[0];
  }
  const sums = { x: 0, y: 0, z: 0 };
  let hasZ = true;
  coordinates.forEach(({ x, y, z }) => {
    sums.x += x;
    sums.y += y;
    if (z !== undefined) {
      sums.z += z;
    } else {
      hasZ = false;
    }
  });
  const centroid: IGeoJSPosition = {
    x: sums.x / coordinates.length,
    y: sums.y / coordinates.length,
  };
  if (hasZ) {
    centroid.z = sums.z / coordinates.length;
  }
  return centroid;
}

// Points to use for spatial containment tests (e.g. ROI polygon filtering).
// Hydrated annotations expose their full coordinate list; stubs have no
// coordinates, so we fall back to the centroid (matching how stub-based
// drag-select hit-tests against the centroid index).
export function annotationTestPoints(
  annotation: { coordinates?: IGeoJSPosition[] },
  centroid: IGeoJSPosition | undefined,
): IGeoJSPosition[] {
  if (annotation.coordinates && annotation.coordinates.length > 0) {
    return annotation.coordinates;
  }
  return centroid ? [centroid] : [];
}

export function pointDistance(a: IGeoJSPosition, b: IGeoJSPosition) {
  return Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y));
}

export function annotationDistance(a: IAnnotation, b: IAnnotation) {
  // For now, polyLines are treated as polygons for the sake of computing distances

  // Point to point
  if (a.shape === AnnotationShape.Point && b.shape === AnnotationShape.Point) {
    return pointDistance(a.coordinates[0], b.coordinates[0]);
  }

  // Point to poly
  if (
    (a.shape === AnnotationShape.Point &&
      (b.shape === AnnotationShape.Polygon ||
        b.shape === AnnotationShape.Line ||
        b.shape === AnnotationShape.Rectangle)) ||
    ((a.shape === AnnotationShape.Polygon ||
      a.shape === AnnotationShape.Line ||
      a.shape === AnnotationShape.Rectangle) &&
      b.shape === AnnotationShape.Point)
  ) {
    const point = a.shape === AnnotationShape.Point ? a : b;
    const poly = a.shape === AnnotationShape.Point ? b : a;

    // Go through all vertices to find the closest
    const shortestDistance = poly.coordinates
      .map((val) => pointDistance(val, point.coordinates[0]))
      .sort()[0];
    return shortestDistance;
  }

  // Poly to poly
  // TODO: add support for rectangle
  if (
    (a.shape === AnnotationShape.Polygon || b.shape === AnnotationShape.Line) &&
    (b.shape === AnnotationShape.Polygon || b.shape === AnnotationShape.Line)
  ) {
    // Use centroids for now
    const centroidA = simpleCentroid(a.coordinates);
    const centroidB = simpleCentroid(b.coordinates);
    return pointDistance(centroidA, centroidB);
  }

  // Should not happen
  logError("Unsupported annotation shapes for distance calculations");
  return Number.POSITIVE_INFINITY;
}

export function canComputeAnnotationProperty(
  property: IAnnotationProperty,
  annotation: IAnnotation,
) {
  return (
    property.shape === annotation.shape &&
    tagFilterFunction(
      annotation.tags,
      property.tags.tags,
      property.tags.exclusive,
    )
  );
}

// Return wether the list of tags match the filter
// Exclusive filter: the lists of tags are exactly equals
// Inclusive filter: the input list of tags is included in the filter list of tags
export function tagFilterFunction(
  inputTags: string[],
  filterTags: string[],
  exclusive: boolean,
) {
  if (exclusive && inputTags.length !== filterTags.length) {
    return false;
  }
  return filterTags.every((filterTag) => inputTags.includes(filterTag));
}

// Same as above, except the inclusive filter is less restrictive
// Inclusive filter: some tag of the input list of tags is also in the filter list of tags
export function tagCloudFilterFunction(
  inputTags: string[],
  filterTags: string[],
  exclusive: boolean,
) {
  if (exclusive) {
    if (inputTags.length !== filterTags.length) {
      return false;
    }
    return filterTags.every((filterTag) => inputTags.includes(filterTag));
  }
  return inputTags.some((inputTag) => filterTags.includes(inputTag));
}

/**
 * Convert ellipse bounding box coordinates to polygon vertices.
 * Uses separate semi-axes to fill the full bounding box.
 * Also handles circles: pass a square bounding box for equal semi-axes.
 *
 * @param corners - The bounding box corners from an ellipse annotation
 * @param numSamples - Number of vertices to generate (default 64)
 * @returns Array of polygon vertices approximating the ellipse
 */
export function ellipseToPolygonCoordinates(
  corners: IGeoJSPosition[],
  numSamples: number = 64,
): IGeoJSPosition[] {
  if (corners.length < 2) {
    logError("Ellipse annotation requires at least 2 corner coordinates");
    return corners;
  }

  const center = simpleCentroid(corners);

  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const semiX = (Math.max(...xs) - Math.min(...xs)) / 2;
  const semiY = (Math.max(...ys) - Math.min(...ys)) / 2;

  const vertices: IGeoJSPosition[] = [];
  for (let i = 0; i < numSamples; i++) {
    const angle = (2 * Math.PI * i) / numSamples;
    const vertex: IGeoJSPosition = {
      x: center.x + semiX * Math.cos(angle),
      y: center.y + semiY * Math.sin(angle),
    };
    if (center.z !== undefined) {
      vertex.z = center.z;
    }
    vertices.push(vertex);
  }

  return vertices;
}

// --- Stub annotation utilities ---

export function hashString(str: string): number {
  // Accumulate with djb2, then apply a finalizer mix
  // to break sequential correlation in MongoDB ObjectIDs.
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) + h + str.charCodeAt(i);
  }
  // murmurhash3 32-bit finalizer — avalanche mix
  h = h >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

export function selectRandomSubset(ids: string[], maxCount: number): string[] {
  if (ids.length <= maxCount) return ids;
  const sorted = [...ids].sort((a, b) => hashString(a) - hashString(b));
  return sorted.slice(0, maxCount);
}

export function estimateAnnotationRadius(
  coordinates: IGeoJSPosition[],
): number {
  if (coordinates.length <= 1) return 5;
  let minX = Infinity,
    maxX = -Infinity;
  let minY = Infinity,
    maxY = -Infinity;
  for (const coord of coordinates) {
    minX = Math.min(minX, coord.x);
    maxX = Math.max(maxX, coord.x);
    minY = Math.min(minY, coord.y);
    maxY = Math.max(maxY, coord.y);
  }
  // TODO: stub circles appear ~2× too large for small annotations (~2px radius).
  // Works correctly for larger annotations. Suspect GeoJS has an internal minimum
  // radius or a scaling behavior for very small point features that inflates them.
  // Needs investigation — possibly related to baseStyle.radius (global setting)
  // or a GeoJS point feature minimum size.
  return Math.max(maxX - minX, maxY - minY) / 2;
}

export function getStubStyleFromBaseStyle(
  annotationColor?: string,
  isHovered: boolean = false,
  isSelected: boolean = false,
  estimatedRadius: number = 5,
): TAnnotationStyle {
  const style: TAnnotationStyle = {
    stroke: true,
    strokeColor: "black",
    strokeOpacity: 0.8,
    strokeWidth: 2,
    fillColor: "white",
    fillOpacity: 0.4,
    fill: true,
    radius: estimatedRadius,
    scaled: 1,
  };

  if (annotationColor) {
    const geoColor = { ...geojs.util.convertColor(annotationColor) };
    geoColor.r *= 0.75;
    geoColor.g *= 0.75;
    geoColor.b *= 0.75;
    style.fillColor = annotationColor;
    style.strokeColor = geoColor;
  }
  if (isSelected) {
    style.strokeWidth = 4;
    if (annotationColor) {
      style.strokeColor = { ...geojs.util.convertColor(annotationColor) };
    }
  }
  if (isHovered) {
    style.fillOpacity = 0;
    style.strokeWidth = 3;
    style.strokeColor = { r: 1, g: 0.9, b: 0.9 };
  }
  return style;
}

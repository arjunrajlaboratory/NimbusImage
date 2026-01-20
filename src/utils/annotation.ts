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

type TAnnotationStyle = IGeoJSLineFeatureStyle &
  IGeoJSPointFeatureStyle &
  IGeoJSPolygonFeatureStyle;

/**
 * Stub-specific styling - fixed pixel size, thinner strokes.
 * Stubs render as small dots that don't change size with zoom.
 */
export function getStubStyleFromBaseStyle(
  annotationColor?: string,
  isHovered: boolean = false,
  isSelected: boolean = false,
): TAnnotationStyle {
  const style: TAnnotationStyle = {
    stroke: true,
    strokeColor: "black",
    strokeOpacity: 0.8,
    strokeWidth: 2, // Thinner than full (4)
    fillColor: "white",
    fillOpacity: 0.4,
    fill: true,
    radius: 5, // Fixed small radius
    scaled: 1, // Always scale with zoom (fixed world size)
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
    style.strokeWidth = 3;
    if (annotationColor) {
      style.strokeColor = geojs.util.convertColor(annotationColor);
    }
  }

  if (isHovered) {
    style.fillOpacity = 0.1;
    style.strokeWidth = 3;
    style.strokeColor = { r: 1, g: 0.9, b: 0.9 };
  }

  return style;
}

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
 * Simple hash function for strings (djb2 algorithm)
 */
function hashString(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) + hash + str.charCodeAt(i);
  }
  return hash >>> 0;
}

/**
 * Seeded random selection - deterministic based on ID hashes.
 * Provides consistent "random" ordering for good spatial distribution.
 */
export function selectRandomSubset(ids: string[], maxCount: number): string[] {
  if (ids.length <= maxCount) return ids;

  // Sort by hash of ID for consistent pseudo-random ordering
  const sorted = [...ids].sort((a, b) => hashString(a) - hashString(b));
  return sorted.slice(0, maxCount);
}

/**
 * Estimate annotation radius from coordinates (bounding box diagonal / 2)
 */
export function estimateAnnotationRadius(
  coordinates: IGeoJSPosition[],
): number {
  if (coordinates.length <= 1) return 5; // Point - use default

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

  return Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2) / 2;
}

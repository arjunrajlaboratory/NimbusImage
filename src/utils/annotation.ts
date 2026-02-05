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
 * Convert circle bounding box coordinates to polygon vertices.
 * GeoJS circle annotations store coordinates as bounding box corners.
 * This function samples the circle uniformly and returns polygon vertices.
 *
 * @param corners - The 4 bounding box corners from a circle annotation
 * @param numSamples - Number of vertices to generate (default 64 for smooth circles)
 * @returns Array of polygon vertices approximating the circle
 */
export function circleToPolygonCoordinates(
  corners: IGeoJSPosition[],
  numSamples: number = 64,
): IGeoJSPosition[] {
  if (corners.length < 2) {
    logError("Circle annotation requires at least 2 corner coordinates");
    return corners;
  }

  // Calculate center from corners (average of all corners)
  const center = simpleCentroid(corners);

  // Calculate radius as distance from center to first corner
  const radius = pointDistance(center, corners[0]);

  // Generate polygon vertices around the circle
  const vertices: IGeoJSPosition[] = [];
  for (let i = 0; i < numSamples; i++) {
    const angle = (2 * Math.PI * i) / numSamples;
    const vertex: IGeoJSPosition = {
      x: center.x + radius * Math.cos(angle),
      y: center.y + radius * Math.sin(angle),
    };
    if (center.z !== undefined) {
      vertex.z = center.z;
    }
    vertices.push(vertex);
  }

  return vertices;
}

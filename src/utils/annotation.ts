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

  // TEMPORARY WORKAROUND for an upstream GeoJS bug:
  // https://github.com/OpenGeoscience/geojs/issues/1486
  // Our viewer is a 2D parallel-projection map, but annotation coordinates
  // carry a `z` equal to the Z-slice index they were drawn on. GeoJS's polygon
  // *fill* feature zeroes vertex z before building its geometry, but its *line*
  // feature (which draws the stroke) computes its float-precision `origin` from
  // the un-zeroed coordinates and only zeroes the per-vertex z afterward
  // (webgl/lineFeature.js). The origin's z is then re-applied via the modelView
  // translation, pushing the stroke outside the fixed parallel clipbounds
  // (near:1 / far:-1, i.e. visible z ~[-1, 3]). The result: polygon/line strokes
  // silently vanish for annotations on higher Z-slices while the fill still
  // renders. Flattening z to 0 here keeps strokes inside the clip volume; z is
  // not used for 2D rendering (the slice is tracked via location/channel).
  // Remove once GeoJS zeroes the line feature's origin z like the polygon does.
  //
  // This runs once per annotation and is a hot path at high annotation counts,
  // so build the flattened array with an indexed loop and an explicit object
  // literal rather than map()/spread, which allocate a closure and copy every
  // property per vertex.
  const numCoordinates = coordinates.length;
  const flatCoordinates: IGeoJSPosition[] = new Array(numCoordinates);
  for (let i = 0; i < numCoordinates; i++) {
    const coordinate = coordinates[i];
    flatCoordinates[i] = { x: coordinate.x, y: coordinate.y, z: 0 };
  }

  switch (shape) {
    case AnnotationShape.Point:
      annotationOptions.position = flatCoordinates[0];
      return geojs.annotation.pointAnnotation(annotationOptions);

    case AnnotationShape.Polygon:
      annotationOptions.vertices = flatCoordinates;
      return geojs.annotation.polygonAnnotation(annotationOptions);

    case AnnotationShape.Line:
      annotationOptions.vertices = flatCoordinates;
      return geojs.annotation.lineAnnotation(annotationOptions);

    case AnnotationShape.Rectangle:
      annotationOptions.corners = flatCoordinates;
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

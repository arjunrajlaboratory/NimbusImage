import {
  AnnotationShape,
  IAnnotationBase,
  IAnnotationLocation,
  IGeoJSPosition,
  TAnnotationOrStub,
} from "@/store/model";

/**
 * GeoJSON <-> annotation conversion (codebaseDocumentation/ANNOTATION_IMPORT_EXPORT.md).
 *
 * Coordinates are this image's pixels with the origin at the top-left and y
 * pointing down: QuPath's convention, and the one the server-side export
 * (`POST export/geojson`) writes. Nothing here reprojects.
 */

// Largest number of annotations one import may create. Above this the
// preview, the batched create, and the post-import refresh all get slow
// enough that a server-side import would be the better tool.
export const MAX_GEOJSON_IMPORT_ANNOTATIONS = 100_000;

export class GeoJsonParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeoJsonParseError";
  }
}

export interface IParsedGeoJsonAnnotation {
  shape: AnnotationShape.Point | AnnotationShape.Line | AnnotationShape.Polygon;
  coordinates: IGeoJSPosition[];
  // Tags read from the feature: its `properties.tags` (NimbusImage's own
  // export) followed by its class name, deduplicated.
  tags: string[];
  // The feature's class (`properties.classification.name`, else
  // `properties.name`), or null. Kept separately for the per-class preview.
  className: string | null;
}

export interface IGeoJsonParseResult {
  annotations: IParsedGeoJsonAnnotation[];
  featureCount: number;
  // Polygon holes (inner rings) dropped; only outer rings are imported.
  holesSkipped: number;
  // Geometries not imported, keyed by reason: an unsupported geometry type
  // ("GeometryCollection"), "no geometry", or "invalid <Type>" for a
  // supported type with malformed or too few coordinates.
  skipped: Record<string, number>;
}

export interface IParseGeoJsonOptions {
  maxAnnotations?: number;
}

type TJsonObject = Record<string, unknown>;

function isObject(value: unknown): value is TJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// A GeoJSON position is [x, y] or [x, y, z]; z (or anything past it) is
// dropped because the annotation's z-slice comes from its location.
function toPosition(value: unknown): IGeoJSPosition | null {
  if (!Array.isArray(value) || value.length < 2) {
    return null;
  }
  const [x, y] = value;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y)
  ) {
    return null;
  }
  return { x, y };
}

function toPositions(value: unknown, minimum: number): IGeoJSPosition[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const positions: IGeoJSPosition[] = [];
  for (const entry of value) {
    const position = toPosition(entry);
    if (!position) {
      return null;
    }
    positions.push(position);
  }
  return positions.length >= minimum ? positions : null;
}

// Outer ring of a Polygon's coordinates, with the closing duplicate vertex
// dropped (annotations store open rings). Null if it has under 3 vertices.
function toOuterRing(value: unknown): IGeoJSPosition[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  const ring = toPositions(value[0], 1);
  if (!ring) {
    return null;
  }
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (ring.length > 1 && first.x === last.x && first.y === last.y) {
    ring.pop();
  }
  return ring.length >= 3 ? ring : null;
}

export function geoJsonClassName(properties: unknown): string | null {
  if (!isObject(properties)) {
    return null;
  }
  const classification = properties.classification;
  if (isObject(classification)) {
    const name = nonEmptyString(classification.name);
    if (name) {
      return name;
    }
    // QuPath 0.4+ can write a derived class as a `names` list.
    if (Array.isArray(classification.names)) {
      const names = classification.names
        .map(nonEmptyString)
        .filter((part): part is string => part !== null);
      if (names.length > 0) {
        return names.join(": ");
      }
    }
  }
  return nonEmptyString(properties.name);
}

function featureTags(properties: unknown, className: string | null): string[] {
  const tags: string[] = [];
  if (isObject(properties) && Array.isArray(properties.tags)) {
    for (const tag of properties.tags) {
      const name = nonEmptyString(tag);
      if (name) {
        tags.push(name);
      }
    }
  }
  if (className) {
    tags.push(className);
  }
  return [...new Set(tags)];
}

interface IGeometryParts {
  shape: IParsedGeoJsonAnnotation["shape"];
  parts: IGeoJSPosition[][];
  holes: number;
}

// The annotation parts of one geometry, or a skip reason.
function geometryParts(geometry: unknown): IGeometryParts | string {
  if (!isObject(geometry)) {
    return "no geometry";
  }
  const type = geometry.type;
  const coordinates = geometry.coordinates;
  const invalid = `invalid ${type}`;
  const holesIn = (polygon: unknown) =>
    Array.isArray(polygon) ? Math.max(polygon.length - 1, 0) : 0;

  switch (type) {
    case "Point": {
      const point = toPosition(coordinates);
      return point
        ? { shape: AnnotationShape.Point, parts: [[point]], holes: 0 }
        : invalid;
    }
    case "MultiPoint": {
      const points = toPositions(coordinates, 1);
      return points
        ? {
            shape: AnnotationShape.Point,
            parts: points.map((point) => [point]),
            holes: 0,
          }
        : invalid;
    }
    case "LineString": {
      const line = toPositions(coordinates, 2);
      return line
        ? { shape: AnnotationShape.Line, parts: [line], holes: 0 }
        : invalid;
    }
    case "MultiLineString": {
      if (!Array.isArray(coordinates) || coordinates.length === 0) {
        return invalid;
      }
      const lines = coordinates.map((line) => toPositions(line, 2));
      return lines.every((line) => line !== null)
        ? {
            shape: AnnotationShape.Line,
            parts: lines as IGeoJSPosition[][],
            holes: 0,
          }
        : invalid;
    }
    case "Polygon": {
      const ring = toOuterRing(coordinates);
      return ring
        ? {
            shape: AnnotationShape.Polygon,
            parts: [ring],
            holes: holesIn(coordinates),
          }
        : invalid;
    }
    case "MultiPolygon": {
      if (!Array.isArray(coordinates) || coordinates.length === 0) {
        return invalid;
      }
      const rings = coordinates.map(toOuterRing);
      return rings.every((ring) => ring !== null)
        ? {
            shape: AnnotationShape.Polygon,
            parts: rings as IGeoJSPosition[][],
            holes: coordinates.reduce(
              (total: number, polygon) => total + holesIn(polygon),
              0,
            ),
          }
        : invalid;
    }
    default:
      return typeof type === "string" && type.length > 0
        ? type
        : "unknown geometry";
  }
}

const GEOMETRY_TYPES = new Set([
  "Point",
  "MultiPoint",
  "LineString",
  "MultiLineString",
  "Polygon",
  "MultiPolygon",
  "GeometryCollection",
]);

// The input's features as [geometry, properties] pairs.
function inputFeatures(input: unknown): [unknown, unknown][] {
  if (!isObject(input)) {
    throw new GeoJsonParseError(
      "Not a GeoJSON object: expected a FeatureCollection, Feature, or Geometry.",
    );
  }
  if (input.type === "FeatureCollection") {
    if (!Array.isArray(input.features)) {
      throw new GeoJsonParseError(
        "This FeatureCollection has no features array.",
      );
    }
    return input.features.map((feature) =>
      isObject(feature) && feature.type === "Feature"
        ? [feature.geometry, feature.properties]
        : [undefined, undefined],
    );
  }
  if (input.type === "Feature") {
    return [[input.geometry, input.properties]];
  }
  if (typeof input.type === "string" && GEOMETRY_TYPES.has(input.type)) {
    return [[input, undefined]];
  }
  throw new GeoJsonParseError(
    typeof input.type === "string"
      ? `Unsupported GeoJSON type "${input.type}": expected a FeatureCollection, Feature, or Geometry.`
      : "Not a GeoJSON object: it has no type.",
  );
}

function tooManyAnnotations(maxAnnotations: number): GeoJsonParseError {
  return new GeoJsonParseError(
    `This file holds more than ${maxAnnotations.toLocaleString()} ` +
      "annotations, the most one GeoJSON import can create. Split the file " +
      "and import it in parts.",
  );
}

/**
 * Parse GeoJSON (already JSON-decoded) into annotation shapes.
 *
 * Accepts a FeatureCollection, a single Feature, or a bare Geometry.
 * Polygon -> polygon (outer ring only, closing vertex dropped; holes are
 * counted and skipped); MultiPolygon -> one polygon per part; LineString ->
 * line; MultiLineString -> one line per part; Point -> point; MultiPoint ->
 * one point per position. Anything else is counted in `skipped`.
 *
 * Throws GeoJsonParseError for input that is not GeoJSON, or that would
 * create more than `maxAnnotations` annotations.
 */
export function parseGeoJson(
  input: unknown,
  {
    maxAnnotations = MAX_GEOJSON_IMPORT_ANNOTATIONS,
  }: IParseGeoJsonOptions = {},
): IGeoJsonParseResult {
  const features = inputFeatures(input);
  // Every feature yields at least one annotation or a skip, so a collection
  // this long is over the cap whatever it holds; bail before walking it.
  if (features.length > maxAnnotations) {
    throw tooManyAnnotations(maxAnnotations);
  }

  const result: IGeoJsonParseResult = {
    annotations: [],
    featureCount: features.length,
    holesSkipped: 0,
    skipped: {},
  };
  for (const [geometry, properties] of features) {
    const parsed = geometryParts(geometry);
    if (typeof parsed === "string") {
      result.skipped[parsed] = (result.skipped[parsed] ?? 0) + 1;
      continue;
    }
    if (result.annotations.length + parsed.parts.length > maxAnnotations) {
      throw tooManyAnnotations(maxAnnotations);
    }
    const className = geoJsonClassName(properties);
    const tags = featureTags(properties, className);
    result.holesSkipped += parsed.holes;
    for (const coordinates of parsed.parts) {
      result.annotations.push({
        shape: parsed.shape,
        coordinates,
        tags: [...tags],
        className,
      });
    }
  }
  return result;
}

/** Parse GeoJSON text; a JSON syntax error becomes a GeoJsonParseError. */
export function parseGeoJsonText(
  text: string,
  options: IParseGeoJsonOptions = {},
): IGeoJsonParseResult {
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    throw new GeoJsonParseError(
      `This file is not valid JSON (${(error as Error).message}).`,
    );
  }
  return parseGeoJson(input, options);
}

export interface IGeoJsonPreview {
  byShape: Record<string, number>;
  // Class name -> annotation count; unclassified features count under "".
  byClass: Record<string, number>;
  // Annotations with at least one vertex outside [0, width] x [0, height].
  outOfBounds: number;
}

export function summarizeGeoJsonImport(
  annotations: IParsedGeoJsonAnnotation[],
  bounds: { width: number; height: number } | null,
): IGeoJsonPreview {
  const preview: IGeoJsonPreview = { byShape: {}, byClass: {}, outOfBounds: 0 };
  for (const annotation of annotations) {
    preview.byShape[annotation.shape] =
      (preview.byShape[annotation.shape] ?? 0) + 1;
    const className = annotation.className ?? "";
    preview.byClass[className] = (preview.byClass[className] ?? 0) + 1;
    if (
      bounds &&
      annotation.coordinates.some(
        ({ x, y }) => x < 0 || y < 0 || x > bounds.width || y > bounds.height,
      )
    ) {
      preview.outOfBounds++;
    }
  }
  return preview;
}

export interface IGeoJsonAnnotationTarget {
  datasetId: string;
  location: IAnnotationLocation;
  channel: number;
  // Added to every annotation's tags (e.g. "region"); blank adds nothing.
  extraTag?: string;
}

export function toAnnotationBases(
  annotations: IParsedGeoJsonAnnotation[],
  { datasetId, location, channel, extraTag }: IGeoJsonAnnotationTarget,
): IAnnotationBase[] {
  const extra = nonEmptyString(extraTag);
  return annotations.map(({ shape, coordinates, tags }) => ({
    tags: extra && !tags.includes(extra) ? [...tags, extra] : [...tags],
    shape,
    channel,
    location: { ...location },
    coordinates,
    datasetId,
    color: null,
  }));
}

/**
 * Split annotation bases into create batches bounded by both annotation
 * count and total vertex count, so a file of very detailed polygons cannot
 * build one enormous request body. Every batch holds at least one
 * annotation, even one alone over the vertex budget.
 */
export function batchAnnotationBases(
  bases: IAnnotationBase[],
  { maxAnnotations = 5_000, maxVertices = 250_000 } = {},
): IAnnotationBase[][] {
  const batches: IAnnotationBase[][] = [];
  let batch: IAnnotationBase[] = [];
  let vertices = 0;
  for (const base of bases) {
    const count = base.coordinates.length;
    if (
      batch.length > 0 &&
      (batch.length >= maxAnnotations || vertices + count > maxVertices)
    ) {
      batches.push(batch);
      batch = [];
      vertices = 0;
    }
    batch.push(base);
    vertices += count;
  }
  if (batch.length > 0) {
    batches.push(batch);
  }
  return batches;
}

/**
 * The annotation ids a GeoJSON export should send, mirroring the Export CSV
 * dialog's scopes: a selection wins, then an active filter, else undefined
 * ("every annotation", so the server needs no dataset-sized $in). An active
 * filter that matches nothing is an empty list, which exports nothing.
 */
export function geoJsonExportAnnotationIds({
  selectedIds,
  filteredAnnotations,
  annotationCount,
}: {
  selectedIds: string[];
  filteredAnnotations: TAnnotationOrStub[];
  annotationCount: number;
}): string[] | undefined {
  if (selectedIds.length > 0) {
    return selectedIds.length < annotationCount ? selectedIds : undefined;
  }
  if (filteredAnnotations.length < annotationCount) {
    return filteredAnnotations.map(({ id }) => id);
  }
  return undefined;
}

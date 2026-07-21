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
  IAnnotationStub,
  TAnnotationOrStub,
  isHydratedAnnotation,
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

// Points to use for spatial containment tests (e.g. ROI polygon filtering).
// Hydrated annotations expose their full coordinate list; stubs have no
// coordinates, so we fall back to the centroid (matching how stub-based
// drag-select hit-tests against the centroid index).
export function annotationTestPoints(
  annotation: TAnnotationOrStub,
  centroid: IGeoJSPosition | undefined,
): IGeoJSPosition[] {
  if (isHydratedAnnotation(annotation) && annotation.coordinates.length > 0) {
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

/**
 * Up to `maxCount` ids chosen deterministically by lowest hash. NOT a uniform
 * random sample — the same id set always yields the same subset (the murmur
 * finalizer in hashString disperses ids well), which is the point: the chosen
 * set stays stable across pans instead of reshuffling each frame.
 */
export function selectStableSubset(ids: string[], maxCount: number): string[] {
  if (maxCount <= 0) return [];
  if (ids.length <= maxCount) return ids;
  // Pick the `maxCount` lowest-hash ids (a deterministic, order-independent
  // pseudo-random subset). Quickselect partitions the candidates in O(N), then
  // only the retained subset is sorted. Full-sorting every candidate made the
  // 708K-annotation zoomed-out case pay O(N log N) even when it kept only 5K.
  const n = ids.length;
  const hashes = new Uint32Array(n);
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    hashes[i] = hashString(ids[i]);
    order[i] = i;
  }

  // The id tie-break makes the result independent of input order even in the
  // rare event of a 32-bit hash collision.
  const compareIndices = (a: number, b: number): number => {
    const hashDifference = hashes[a] - hashes[b];
    if (hashDifference !== 0) return hashDifference;
    return ids[a] < ids[b] ? -1 : ids[a] > ids[b] ? 1 : 0;
  };

  let left = 0;
  let right = n - 1;
  const target = maxCount - 1;
  while (left < right) {
    let low = left;
    let high = right;
    const pivot = order[left + ((right - left) >> 1)];
    while (low <= high) {
      while (compareIndices(order[low], pivot) < 0) low += 1;
      while (compareIndices(order[high], pivot) > 0) high -= 1;
      if (low <= high) {
        const swap = order[low];
        order[low] = order[high];
        order[high] = swap;
        low += 1;
        high -= 1;
      }
    }
    if (target <= high) {
      right = high;
    } else if (target >= low) {
      left = low;
    } else {
      break;
    }
  }

  const selected = order.slice(0, maxCount);
  selected.sort(compareIndices);
  const result: string[] = new Array(maxCount);
  for (let i = 0; i < maxCount; i++) {
    result[i] = ids[selected[i]];
  }
  return result;
}

/**
 * Return up to `count` ids with the LARGEST `sizeOf(id)`, breaking size ties by
 * ascending `hashString(id)`. The hash tie-break makes the selection a
 * deterministic, order-independent function of the id set — critical when sizes
 * are near-uniform (e.g. cell annotations), so the chosen set stays stable
 * across pans instead of reshuffling at every tie boundary.
 *
 * Each id's size and hash are computed exactly once into parallel typed arrays
 * and the top `count` are taken with a bounded min-heap (O(n log count)) — vs.
 * the old approach of allocating an object per id and full-sorting all n with a
 * key-recomputing comparator, which cost ~0.4-0.5 s per refresh at ~700K ids.
 */
export function selectLargestBySize(
  ids: string[],
  sizeOf: (id: string) => number,
  count: number,
): string[] {
  if (count <= 0) return [];
  if (ids.length <= count) return ids;
  const n = ids.length;
  const sizes = new Float64Array(n);
  const hashes = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    sizes[i] = sizeOf(ids[i]);
    hashes[i] = hashString(ids[i]);
  }
  // Keep the `count` best in a bounded MIN-heap keyed by "evictability": the
  // root is the worst kept element, so a new candidate replaces it iff it beats
  // it. O(n log count) — ~4× faster than sorting all n at 700K — and avoids the
  // O(n log n) full sort the old object-sort paid. `worse(a, b)` ⇒ a is more
  // evictable than b: smaller size, or (size tie) larger hash — so the smaller
  // hash survives ties, matching the deterministic tie-break above.
  const worse = (a: number, b: number) =>
    sizes[a] !== sizes[b] ? sizes[a] < sizes[b] : hashes[a] > hashes[b];
  const heap = new Int32Array(count);
  let size = 0;
  for (let i = 0; i < n; i++) {
    if (size < count) {
      // sift up
      let c = size++;
      heap[c] = i;
      while (c > 0) {
        const p = (c - 1) >> 1;
        if (worse(heap[c], heap[p])) {
          const t = heap[c];
          heap[c] = heap[p];
          heap[p] = t;
          c = p;
        } else break;
      }
    } else if (worse(heap[0], i)) {
      // i beats the current worst — replace root and sift down
      heap[0] = i;
      let p = 0;
      for (;;) {
        const l = 2 * p + 1;
        const r = 2 * p + 2;
        let m = p;
        if (l < count && worse(heap[l], heap[m])) m = l;
        if (r < count && worse(heap[r], heap[m])) m = r;
        if (m === p) break;
        const t = heap[p];
        heap[p] = heap[m];
        heap[m] = t;
        p = m;
      }
    }
  }
  const result: string[] = new Array(size);
  for (let i = 0; i < size; i++) {
    result[i] = ids[heap[i]];
  }
  return result;
}

/**
 * Whether an already-drawn GeoJS feature still matches the desired render state,
 * so the incremental draw path can keep it instead of removing + recreating it.
 *
 * `layerData` is the annotation/stub currently assigned to this feature's id on
 * its layer (undefined ⇒ no longer displayed there). A feature is unchanged iff
 * its layer still exists, it's still displayed, its color is unchanged, and its
 * dot/shape state still matches — i.e. a drawn stub is kept only while layerData
 * is still a stub, and a drawn shape only while layerData is still hydrated.
 *
 * Stub-awareness is the fix that makes incremental drawing viable in stub-only
 * mode: the old keep-check used `getAnnotationFromId`, which returns undefined
 * for non-hydrated non-point stubs (point stubs now materialize from their
 * centroid; the full annotations[] array is empty otherwise), so every dot
 * feature was dropped on each pass and nothing could be reused.
 */
export function drawnFeatureUnchanged(
  layerExists: boolean,
  layerData: TAnnotationOrStub | undefined,
  drawnColor: string | null,
  drawnIsStub: boolean,
  drawnGeometryKey: number,
): boolean {
  if (!layerExists || !layerData) return false;
  if (layerData.color !== drawnColor) return false;
  if (!isHydratedAnnotation(layerData) !== drawnIsStub) return false;
  // Geometry guard (Finding 1): the keep-check previously ignored coordinates,
  // so an in-place edit (polygon-slice, vertex drag) kept the stale feature and
  // never repainted. Compare the rendered-geometry key so a coordinate change
  // (or a stub dot whose centroid moved) forces a redraw.
  return geometryKeyForRender(layerData) === drawnGeometryKey;
}

/**
 * Order-sensitive, float-safe fingerprint of a coordinate list. Folds each
 * vertex (x, y, and z when present) into a 32-bit FNV-1a-style hash, scaling by
 * 1000 first so sub-pixel edits are still detected. Used by the incremental
 * draw path to tell whether a feature's geometry changed since it was drawn.
 */
export function coordinatesFingerprint(coordinates: IGeoJSPosition[]): number {
  let h = 0x811c9dc5 ^ coordinates.length;
  const fold = (value: number): void => {
    const v = Math.round(value * 1000) | 0;
    h = Math.imul(h ^ (v & 0xffff), 0x01000193);
    h = Math.imul(h ^ (v >>> 16), 0x01000193);
  };
  for (let i = 0; i < coordinates.length; i++) {
    const c = coordinates[i];
    fold(c.x);
    fold(c.y);
    if (c.z !== undefined) fold(c.z);
  }
  return h >>> 0;
}

/**
 * The geometry key the incremental draw path stores on a feature and compares
 * on each refresh: a hydrated annotation is keyed off its full coordinates; a
 * stub (drawn as a dot) is keyed off its centroid.
 */
export function geometryKeyForRender(data: TAnnotationOrStub): number {
  return isHydratedAnnotation(data)
    ? coordinatesFingerprint(data.coordinates)
    : coordinatesFingerprint([data.centroid]);
}

// Fields read off a drawn GeoJS feature to decide whether it may be stashed in
// the retained-feature cache (the per-(layer, annotation) LRU in
// AnnotationViewer that lets a frame scrub reuse torn-down features instead of
// reconstructing them via createGeoJSAnnotation).
export interface IRetainableFeatureOptions {
  girderId?: string | null;
  layerId?: string | null;
  isConnection?: boolean;
  specialAnnotation?: boolean;
}

/**
 * Whether a torn-down feature is eligible to be retained for later reuse.
 *
 * Retainable only when the feature has a stable (layer, annotation) identity to
 * key on (both `layerId` and `girderId` present) AND is an ordinary annotation
 * feature. Connections are rebuilt cheaply from their endpoints
 * (drawNewConnections), and special / in-progress features have no reusable
 * identity — both are skipped. The current edit annotation is excluded by the
 * caller via object identity, which can't be expressed from options alone.
 *
 * This is the single source of truth for the cache's skip list: extend it here
 * (with a matching test) rather than re-deriving the predicate at call sites.
 */
export function shouldRetainFeature(
  options: IRetainableFeatureOptions,
): boolean {
  return Boolean(
    options.girderId &&
      options.layerId &&
      !options.isConnection &&
      !options.specialAnnotation,
  );
}

// Membership-only view of a collection: communicates that only key presence is
// read (a Map or Set both satisfy it), and that values are never touched.
interface IHasKey {
  has(id: string): boolean;
}

/**
 * Of `requestedIds`, return the (deduplicated) ids that must be fetched to
 * hydrate them: ids that are known stubs but not already in the hydration cache.
 * Used by the hydrate-on-selection / hydrate-on-navigation path so a selected or
 * navigated-to stub gets its full coordinates without waiting for a viewport pan.
 */
export function idsNeedingHydration(
  requestedIds: Iterable<string>,
  hydrated: IHasKey,
  stubs: IHasKey,
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of requestedIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (!hydrated.has(id) && stubs.has(id)) {
      result.push(id);
    }
  }
  return result;
}

/**
 * Decide which hydration-cache entries to evict to honor `cap`.
 *
 * `orderedIds` is the cache's key order, oldest (LRU) first. Selected ids are
 * protected: non-selected LRU entries are evicted first. But `cap` is a HARD
 * ceiling — if the selected set alone exceeds it (e.g. "select all" on a huge
 * dataset), selected LRU entries are evicted too, so the cache can never grow
 * unbounded. Returns the ids to evict and how many selected ids survived.
 */
export function planHydrationEvictions(
  orderedIds: string[],
  selected: ReadonlySet<string>,
  cap: number,
): { evict: string[]; protectedSkipped: number } {
  const evict: string[] = [];
  if (cap > 0 && orderedIds.length > cap) {
    let toEvict = orderedIds.length - cap;
    // Pass 1: evict non-selected LRU first (protect the user's selection).
    for (const id of orderedIds) {
      if (toEvict <= 0) break;
      if (selected.has(id)) continue;
      evict.push(id);
      toEvict -= 1;
    }
    // Pass 2 (hard ceiling): if the protected set alone still exceeds the cap,
    // evict selected LRU too rather than letting the cache overflow.
    if (toEvict > 0) {
      const evicted = new Set(evict);
      for (const id of orderedIds) {
        if (toEvict <= 0) break;
        if (evicted.has(id)) continue;
        evict.push(id);
        toEvict -= 1;
      }
    }
  }
  const evictSet = new Set(evict);
  let protectedSkipped = 0;
  for (const id of orderedIds) {
    if (selected.has(id) && !evictSet.has(id)) {
      protectedSkipped += 1;
    }
  }
  return { evict, protectedSkipped };
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
  // Returned in world (image-pixel) units. The renderer feeds this into a GeoJS
  // point feature with `scaled = log2(unitsPerPixel(0))` so the stub circle
  // matches the annotation's real footprint at every zoom (see
  // getStubStyleFromBaseStyle).
  return Math.max(maxX - minX, maxY - minY) / 2;
}

// Whether annotations of this shape need backend hydration. Points do NOT: a
// point's centroid IS its single coordinate, so a point stub already holds its
// full geometry. Such stubs render with the regular point style (not the dot
// placeholder) and are never fetched from /hydrate. Polygons/lines/rectangles
// load as dot stubs and hydrate on demand.
export function shapeNeedsHydration(shape: AnnotationShape): boolean {
  return shape !== AnnotationShape.Point;
}

// A drawn feature uses the dot placeholder style only when it is an unhydrated
// stub of a shape that still needs hydration. Point stubs use the regular point
// style — identical to a hydrated point — because they are already complete.
export function drawnFeatureUsesDotStyle(
  isStub: boolean,
  shape: AnnotationShape,
): boolean {
  return isStub && shapeNeedsHydration(shape);
}

// True when the stub for `id` exists and is a shape that still needs hydration
// (i.e. not a point). Single-sources the "drop self-complete points from
// hydration" guard used by both the viewport hydration budget and
// ensureHydrated.
export function idHasHydratableShape(
  id: string,
  stubs: Map<string, IAnnotationStub>,
): boolean {
  const stub = stubs.get(id);
  return !!stub && shapeNeedsHydration(stub.shape);
}

// Resolve a stub to a full annotation WITHOUT hydration, when possible. A point
// stub is self-complete — its centroid IS its only coordinate — so it
// materializes to a full IAnnotation (coordinates = [centroid]). This lets
// resolution paths (connection rendering, copy/paste, timelapse linking) treat a
// point stub as a complete annotation, since points never hydrate. Other shapes
// carry real coordinate lists a stub doesn't hold, so they return undefined
// (they genuinely need backend hydration). datasetId is supplied by the caller
// (all stubs belong to the loaded dataset) rather than stored per-stub. The
// centroid is cloned so a consumer mutating the coordinate can't corrupt the
// stub or the spatial index.
export function materializeStubAnnotation(
  stub: IAnnotationStub,
  datasetId: string,
): IAnnotation | undefined {
  if (shapeNeedsHydration(stub.shape)) {
    return undefined;
  }
  return {
    id: stub.id,
    name: null,
    coordinates: [{ ...stub.centroid }],
    location: stub.location,
    shape: stub.shape,
    channel: stub.channel,
    tags: stub.tags,
    color: stub.color,
    datasetId,
  };
}

/**
 * Build an annotation stub (centroid + metadata, no coordinates) from a full
 * annotation and its precomputed centroid. Single source for the stub field set
 * that the annotation store builds when ingesting full annotations (add / set /
 * setAnnotations), so the shape can't drift between those sites.
 */
export function stubFromAnnotation(
  annotation: IAnnotation,
  centroid: IGeoJSPosition,
): IAnnotationStub {
  return {
    id: annotation.id,
    centroid,
    location: annotation.location,
    shape: annotation.shape,
    channel: annotation.channel,
    tags: annotation.tags,
    color: annotation.color,
    estimatedRadius: estimateAnnotationRadius(annotation.coordinates),
  };
}

export function getStubStyleFromBaseStyle(
  annotationColor?: string,
  isHovered: boolean = false,
  isSelected: boolean = false,
  estimatedRadius: number = 5,
  // `estimatedRadius` is in world (image-pixel) units. A GeoJS point feature with
  // `scaled: N` renders `radius * 2^(zoom - N)` display pixels; a world-locked
  // size is `radius / unitsPerPixel(zoom) = radius * 2^zoom / unitsPerPixel(0)`.
  // These match when `N = log2(unitsPerPixel(0))` (the tile pyramid's 1:1 zoom
  // level), so the caller passes that value and the stub circle then tracks the
  // annotation's real footprint at every zoom. Defaults to 1 only for callers
  // without a map (e.g. tests); the renderer always supplies the real value.
  scaled: number = 1,
  // Fill opacity, matching the full annotation (the caller passes
  // store.annotationOpacity so the stub tracks the opacity slider). Defaults to
  // the full-annotation default (0.5) for callers without a store (e.g. tests).
  fillOpacity: number = 0.5,
): TAnnotationStyle {
  // Stroke and fill match the full-annotation style
  // (getAnnotationStyleFromBaseStyle: stroke width 4 / opacity 1, selected 6,
  // hovered 5; fill opacity from the same source) so a stub reads like the real
  // annotation's outline. Only the shape (circle) distinguishes a stub from its
  // hydrated form.
  const style: TAnnotationStyle = {
    stroke: true,
    strokeColor: "black",
    strokeOpacity: 1,
    strokeWidth: 4,
    fillColor: "white",
    fillOpacity,
    fill: true,
    radius: estimatedRadius,
    scaled,
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
      style.strokeColor = { ...geojs.util.convertColor(annotationColor) };
    }
  }
  if (isHovered) {
    style.fillOpacity = 0;
    style.strokeWidth = 5;
    style.strokeColor = { r: 1, g: 0.9, b: 0.9 };
  }
  return style;
}

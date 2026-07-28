import store from "@/store";
import annotationStore from "@/store/annotation";
import { simpleCentroid } from "@/utils/annotation";
import {
  frameCameraInfo,
  frameCameraInfoToExtent,
  recenterCameraInfo,
} from "@/utils/camera";

/** Fraction of the viewport a framed connection should occupy. */
const CONNECTION_FRAME_PADDING = 1.6;

/**
 * Fraction of the viewport a framed track should occupy. Deliberately well
 * under 1: a track filling the frame edge to edge loses the surrounding context
 * that makes it interpretable — neighbouring cells, which way it is heading.
 */
const TRACK_VIEWPORT_FRACTION = 0.2;

/**
 * Move the viewer to an annotation's location and recenter on it.
 *
 * Shared by the Objects and Connections tabs of the Object Browser — both need
 * the same stub-aware behavior, and the centroid/hydration handling below is
 * too subtle to duplicate.
 */
export function goToAnnotationLocation(annotationId: string) {
  // In stub-only mode getAnnotationFromId returns undefined for non-hydrated
  // non-point annotations, so fall back to the stub (which carries location +
  // centroid).
  const annotation = annotationStore.getAnnotationFromId(annotationId);
  const stub = annotationStore.getStub(annotationId);
  const location = annotation?.location ?? stub?.location;
  if (!location) {
    return;
  }
  store.setXY(location.XY);
  store.setZ(location.Z);
  store.setTime(location.Time);
  // Stubs have no coordinates — recenter on the stub centroid (or the centroid
  // map); full annotations use their actual coordinate centroid.
  const center = annotation?.coordinates
    ? simpleCentroid(annotation.coordinates)
    : stub?.centroid ?? annotationStore.annotationCentroids[annotationId];
  if (center) {
    // Recenter as a pure pan and translate gcsBounds with it. The new location
    // must be hydrated against the *new* viewport, not the stale pre-click one
    // (this path bypasses the GeoJS map, so nothing else re-syncs gcsBounds).
    store.setCameraInfo(recenterCameraInfo(store.cameraInfo, center));
  }
  annotationStore.setHoveredAnnotationId(annotationId);
  // Guarantee the navigated-to annotation renders as a full shape, even if it
  // falls outside the viewport hydration budget at the destination (C3).
  annotationStore.ensureHydrated([annotationId]);
}

function resolveEndpoint(id: string) {
  const annotation = annotationStore.getAnnotationFromId(id);
  const stub = annotationStore.getStub(id);
  const location = annotation?.location ?? stub?.location;
  if (!location) {
    return null;
  }
  const centroid = annotation?.coordinates
    ? simpleCentroid(annotation.coordinates)
    : stub?.centroid ?? annotationStore.annotationCentroids[id];
  return centroid ? { id, location, centroid } : null;
}

/**
 * Navigate to a connection, framing BOTH endpoints rather than centering on one.
 *
 * A connection is only drawn when both of its endpoints are displayed, so
 * recentering on a single endpoint while zoomed in leaves the other outside the
 * viewport and the user sees no connection at all — the exact thing they clicked
 * the row to look at. Measured on the Xenium dataset at max zoom: viewport span
 * 51 world units, endpoints 139 apart, line not drawn.
 *
 * Endpoints on DIFFERENT frames can't both be displayed in normal mode no matter
 * the zoom — that is what timelapse mode is for — so this only zooms to fit when
 * the two share a frame, and otherwise behaves like a plain navigate.
 */
export function goToConnection(parentId: string, childId: string) {
  const parent = resolveEndpoint(parentId);
  const child = resolveEndpoint(childId);
  const target = child ?? parent;
  if (!target) {
    return;
  }
  const sameFrame =
    parent !== null &&
    child !== null &&
    parent.location.XY === child.location.XY &&
    parent.location.Z === child.location.Z &&
    parent.location.Time === child.location.Time;

  if (!sameFrame) {
    // Nothing to frame — one endpoint is missing, or they live on different
    // frames and only one can ever be on screen here.
    goToAnnotationLocation(target.id);
    return;
  }

  store.setXY(target.location.XY);
  store.setZ(target.location.Z);
  store.setTime(target.location.Time);
  const midpoint = {
    x: (parent!.centroid.x + child!.centroid.x) / 2,
    y: (parent!.centroid.y + child!.centroid.y) / 2,
  };
  store.setCameraInfo(
    frameCameraInfo(
      store.cameraInfo,
      midpoint,
      // Signed delta: frameCameraInfo projects it onto the camera axes, and
      // under rotation the sign changes the result.
      (child!.centroid.x - parent!.centroid.x) * CONNECTION_FRAME_PADDING,
      (child!.centroid.y - parent!.centroid.y) * CONNECTION_FRAME_PADDING,
    ),
  );
  annotationStore.setHoveredAnnotationId(target.id);
  annotationStore.ensureHydrated([parentId, childId]);
}

/**
 * Frame a whole track: centre on its members' bounding box and size the camera
 * so the track occupies `TRACK_VIEWPORT_FRACTION` of the viewport.
 *
 * XY and Z come from the members, because a track on a different XY/Z is not
 * drawn at all and framing it would show empty image. TIME is deliberately left
 * alone unless the current frame lies outside the track's range — in timelapse
 * mode Time is the window's centre and the user scrubs it on purpose, so moving
 * it would fight them. When it IS outside, the track is entirely off-window and
 * would render as nothing, so Time is clamped to the nearest end of the range
 * rather than jumped to the middle: the smallest move that makes the click do
 * something.
 *
 * Unlike `goToConnection` this zooms in as well as out — clicking a track from a
 * zoomed-out view should bring it up to a usable size, which is the whole point.
 */
export function goToTrack(annotationIds: string[]) {
  const members = annotationIds
    .map((id) => resolveEndpoint(id))
    .filter((member): member is NonNullable<typeof member> => member !== null);
  if (members.length === 0) {
    return;
  }

  const xs = members.map((m) => m.centroid.x);
  const ys = members.map((m) => m.centroid.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  // A track's members share an XY/Z in every dataset this supports; take the
  // first rather than inventing a rule for a mixed track.
  store.setXY(members[0].location.XY);
  store.setZ(members[0].location.Z);

  const times = members.map((m) => m.location.Time);
  const startTime = Math.min(...times);
  const endTime = Math.max(...times);
  if (store.time < startTime) {
    store.setTime(startTime);
  } else if (store.time > endTime) {
    store.setTime(endTime);
  }

  // Clamp to what the map can actually show. Without a max, a track whose
  // members sit within a pixel of each other asks for effectively infinite
  // zoom; GeoJS would clamp `map.zoom()` silently and leave the store's zoom and
  // gcsBounds describing a viewport that never existed.
  const zoomRange = store.maps[0]?.map?.zoomRange?.();
  store.setCameraInfo(
    frameCameraInfoToExtent(
      store.cameraInfo,
      { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
      maxX - minX,
      maxY - minY,
      TRACK_VIEWPORT_FRACTION,
      { maxZoom: zoomRange?.max, minZoom: zoomRange?.min },
    ),
  );
  annotationStore.ensureHydrated(annotationIds);
}

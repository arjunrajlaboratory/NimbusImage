import store from "@/store";
import annotationStore from "@/store/annotation";
import timelapse from "@/store/timelapse";
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
 * XY and Z come from an ANCHOR member — the one nearest the current frame —
 * because a track on a different XY/Z is not drawn at all and framing it would
 * show empty image. The bounding box and the time range then come from that
 * member's slice only: a track can legitimately span slices (`Connect selected`
 * chains by time with no slice constraint), and mixing slices means framing a box
 * inflated by members that aren't drawn, possibly on a frame where none is.
 *
 * TIME depends on the mode, because what "visible" means does:
 *
 * - **Timelapse mode** draws a whole window of timepoints at once, so a track
 *   spanning T1–T5 is on screen from anywhere inside that range. Time is the
 *   window's centre and the user scrubs it deliberately, so leave it alone; only
 *   when the current frame is OUTSIDE the range is the track entirely off-window,
 *   and then clamp to the nearest end — the smallest move that makes the click do
 *   something.
 * - **Normal mode** draws one timepoint. Leaving Time alone there frames a region
 *   containing nothing: a track with members at T1 and T5 viewed at T3 has no
 *   member and no link on screen, so the row expands and the camera moves to
 *   empty image. The By-track view is available with the mode off, so this is
 *   reachable. Snap to the member nearest the current frame instead — the
 *   smallest move that puts a real object in view.
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

  // Pick ONE member first, then derive everything from its slice.
  //
  // A track is not guaranteed to sit on a single XY/Z: "Connect selected" chains
  // whatever is selected by ascending time with no slice constraint, so a
  // cross-slice track is reachable. Taking XY/Z from one member while computing
  // the time and bounding box from ALL of them mixes two slices together — the
  // nearest time can belong to a member on the slice we did NOT navigate to, so
  // the row expands onto empty image, and the box is inflated by members that
  // aren't drawn.
  //
  // The anchor is the member nearest the current frame, which for the common
  // single-slice track is the same navigation as before.
  const anchor = members.reduce((best, member) =>
    Math.abs(member.location.Time - store.time) <
    Math.abs(best.location.Time - store.time)
      ? member
      : best,
  );
  const onAnchorSlice = members.filter(
    (member) =>
      member.location.XY === anchor.location.XY &&
      member.location.Z === anchor.location.Z,
  );

  store.setXY(anchor.location.XY);
  store.setZ(anchor.location.Z);

  // Bounds and times from the anchor's slice only: the rest is not drawn there.
  const xs = onAnchorSlice.map((m) => m.centroid.x);
  const ys = onAnchorSlice.map((m) => m.centroid.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const times = onAnchorSlice.map((m) => m.location.Time);
  if (timelapse.showMode) {
    // A window of frames is drawn, so anywhere inside the range already shows it.
    const startTime = Math.min(...times);
    const endTime = Math.max(...times);
    if (store.time < startTime) {
      store.setTime(startTime);
    } else if (store.time > endTime) {
      store.setTime(endTime);
    }
  } else {
    // One frame is drawn, so land on an actual member or nothing is visible.
    // `anchor` is by construction the nearest member on this slice.
    if (anchor.location.Time !== store.time) {
      store.setTime(anchor.location.Time);
    }
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

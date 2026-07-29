import store from "@/store";
import annotationStore from "@/store/annotation";
import { simpleCentroid } from "@/utils/annotation";
import { frameCameraInfo, recenterCameraInfo } from "@/utils/camera";
import { IUnrollLayout, unrollLayoutFor, unrolledPoint } from "@/utils/unroll";

/** Fraction of the viewport a framed connection should occupy. */
const CONNECTION_FRAME_PADDING = 1.6;

/**
 * The grid an annotation is currently DRAWN on, for turning a stored centroid
 * into a position the camera can be aimed at.
 *
 * With an axis unrolled every frame along it is on screen at once, side by side,
 * and the viewer offsets each annotation by the grid cell its frame occupies. So
 * the camera has to be aimed at the offset position: centring on the raw
 * centroid put it a whole tile-width away from the object the user clicked, on
 * the equivalent spot of the first tile (issue #1280).
 *
 * Read once per navigation and passed down — `unrollGrid` derives from
 * `layerStackImages`, so it is not something to re-fetch per endpoint. Off the
 * unrolled path the resulting transform is the identity.
 */
function currentUnrollLayout(): IUnrollLayout {
  return unrollLayoutFor({
    flags: {
      unrollXY: store.unrollXY,
      unrollZ: store.unrollZ,
      unrollT: store.unrollT,
    },
    // The grid the tiles are laid out on, mirrored from ImageViewer.
    unrollW: store.unrollGrid.unrollW,
    image: store.dataset?.anyImage(),
    dataset: store.dataset,
  });
}

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
    // Resolved AFTER the frame is set so the grid is the one being navigated to.
    store.setCameraInfo(
      recenterCameraInfo(
        store.cameraInfo,
        unrolledPoint(center, location, currentUnrollLayout()),
      ),
    );
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
 * Endpoints on different frames usually can't both be displayed no matter the
 * zoom — that is what timelapse mode is for — so this only zooms to fit when both
 * are on screen, and otherwise behaves like a plain navigate.
 *
 * "On screen" is NOT the same as "on the same frame", though. An unrolled axis
 * puts every one of its frames on screen simultaneously, and a connection across
 * them is genuinely drawn as a line between two grid cells — so a differing
 * index on an unrolled axis is no reason to give up on framing (issue #1280).
 * The framing then has to use the endpoints' drawn positions, which is what makes
 * a cross-tile span come out tile-widths wide instead of collapsing to the
 * distance between two raw centroids.
 */
export function goToConnection(parentId: string, childId: string) {
  const parent = resolveEndpoint(parentId);
  const child = resolveEndpoint(childId);
  const target = child ?? parent;
  if (!target) {
    return;
  }
  // An axis that is unrolled shows all of its frames at once, so the endpoints
  // only have to agree on the axes that still select a single frame.
  const bothDisplayed =
    parent !== null &&
    child !== null &&
    (store.unrollXY || parent.location.XY === child.location.XY) &&
    (store.unrollZ || parent.location.Z === child.location.Z) &&
    (store.unrollT || parent.location.Time === child.location.Time);

  if (!bothDisplayed) {
    // Nothing to frame — one endpoint is missing, or they live on different
    // frames and only one can ever be on screen here.
    goToAnnotationLocation(target.id);
    return;
  }

  store.setXY(target.location.XY);
  store.setZ(target.location.Z);
  store.setTime(target.location.Time);
  // Frame where the endpoints are DRAWN. Unrolled, these differ from the raw
  // centroids by a cell offset each, and for a cross-tile connection that offset
  // is the bulk of the span.
  const layout = currentUnrollLayout();
  const parentAt = unrolledPoint(parent!.centroid, parent!.location, layout);
  const childAt = unrolledPoint(child!.centroid, child!.location, layout);
  const midpoint = {
    x: (parentAt.x + childAt.x) / 2,
    y: (parentAt.y + childAt.y) / 2,
  };
  store.setCameraInfo(
    frameCameraInfo(
      store.cameraInfo,
      midpoint,
      // Signed delta: frameCameraInfo projects it onto the camera axes, and
      // under rotation the sign changes the result.
      (childAt.x - parentAt.x) * CONNECTION_FRAME_PADDING,
      (childAt.y - parentAt.y) * CONNECTION_FRAME_PADDING,
    ),
  );
  annotationStore.setHoveredAnnotationId(target.id);
  annotationStore.ensureHydrated([parentId, childId]);
}

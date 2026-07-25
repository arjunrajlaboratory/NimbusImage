import store from "@/store";
import annotationStore from "@/store/annotation";
import { simpleCentroid } from "@/utils/annotation";
import { recenterCameraInfo } from "@/utils/camera";

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

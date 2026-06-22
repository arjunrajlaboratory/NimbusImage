import type { ICameraInfo, IGeoJSPosition } from "@/store/model";

/**
 * Recenter the camera as a pure pan, keeping gcsBounds in sync with the center.
 *
 * A pan leaves zoom and rotation unchanged, so the four gcsBounds corners
 * translate by exactly the center delta. Keeping gcsBounds consistent with the
 * center matters because viewport-driven annotation hydration
 * (`updateVisibilityAndHydration`) reads `cameraInfo.gcsBounds` to decide which
 * annotations are in view and should be hydrated/rendered.
 *
 * Recenters that go through the GeoJS map recompute gcsBounds from the real map
 * via `synchroniseCameraFromMap`. This helper is for programmatic recenters that
 * bypass the map (e.g. clicking "Go to annotation location" in the annotation
 * list): without translating gcsBounds, the new location would be hydrated
 * against the stale pre-recenter viewport, leaving the destination empty until
 * the user manually pans or zooms.
 */
/**
 * Zoom hysteresis for the camera-driven visibility refresh.
 *
 * Recomputing the render budget + re-hydrating on every tiny zoom change causes
 * constant loading churn. This gates the refresh: a pan (any center move) always
 * refreshes, but a *centered* zoom refreshes only once the magnification has
 * changed by at least `zoomFraction` (e.g. 0.2 = 20%) since the last refresh.
 *
 * Zoom is logarithmic (one level = 2x linear magnification), so a 20% change is
 * `log2(1.2)` ≈ 0.263 zoom levels. Scroll-wheel zoom shifts the center toward the
 * cursor, so it counts as a pan and still refreshes — this is the deliberate
 * "zoom-only" hysteresis: it quantizes centered zooms (buttons, pinch) without
 * touching pan behavior.
 */
export function cameraRefreshNeeded(
  current: { zoom: number; center: IGeoJSPosition },
  last: { zoom: number; center: IGeoJSPosition } | null,
  zoomFraction: number,
): boolean {
  if (!last || !current.center || !last.center) {
    return true;
  }
  // A pan (any center movement) always refreshes.
  if (
    current.center.x !== last.center.x ||
    current.center.y !== last.center.y
  ) {
    return true;
  }
  // Centered zoom: refresh only past the magnification threshold.
  return Math.abs(current.zoom - last.zoom) >= Math.log2(1 + zoomFraction);
}

export function recenterCameraInfo(
  info: ICameraInfo,
  center: IGeoJSPosition,
): ICameraInfo {
  const dx = center.x - info.center.x;
  const dy = center.y - info.center.y;
  return {
    ...info,
    center,
    gcsBounds: info.gcsBounds.map((pt) => ({
      ...pt,
      x: pt.x + dx,
      y: pt.y + dy,
    })),
  };
}

import type { ICameraInfo, IGeoJSPosition } from "@/store/model";

/**
 * Unified pan + zoom hysteresis for the camera-driven visibility refresh.
 *
 * Recomputing the render budget + re-hydrating on every tiny camera change causes
 * constant loading churn. This gates the refresh on a single sensitivity
 * `fraction` (e.g. 0.2 = 20%): refresh once EITHER
 *   - the zoom magnification changed by >= the fraction (zoom is logarithmic, so
 *     a 20% change is `log2(1.2)` ≈ 0.263 zoom levels), OR
 *   - the center moved by >= the fraction of the viewport extent (world units).
 * Skip only when BOTH are below threshold. Covering pan too is what actually
 * suppresses scroll-wheel zoom (which shifts the center toward the cursor) — a
 * zoom-only gate would still refresh on its center drift.
 *
 * `viewportExtent` is a world-unit scale for the pan threshold (the viewport
 * diagonal); when it is unknown (<= 0) any pan refreshes, which is the safe
 * default.
 */
export function cameraRefreshNeeded(
  current: { zoom: number; center: IGeoJSPosition },
  last: { zoom: number; center: IGeoJSPosition } | null,
  fraction: number,
  viewportExtent: number,
): boolean {
  if (!last || !current.center || !last.center) {
    return true;
  }
  // Pan: refresh if the center moved by >= fraction of the viewport extent.
  if (
    current.center.x !== last.center.x ||
    current.center.y !== last.center.y
  ) {
    // Written as `!(x > 0)` rather than `x <= 0` so it also catches NaN (an
    // unknown/uninitialized extent): NaN comparisons are always false, so
    // `!(NaN > 0)` is true → refresh on any pan, the safe default.
    if (!(viewportExtent > 0)) {
      return true; // can't scale the move → refresh on any pan (safe)
    }
    const panDistance = Math.hypot(
      current.center.x - last.center.x,
      current.center.y - last.center.y,
    );
    if (panDistance >= fraction * viewportExtent) {
      return true;
    }
  }
  // Zoom: refresh only past the magnification threshold.
  return Math.abs(current.zoom - last.zoom) >= Math.log2(1 + fraction);
}

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

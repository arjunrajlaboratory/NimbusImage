import type { ICameraInfo, IGeoJSPosition } from "@/store/model";

/**
 * Camera-driven visibility refresh gate: PAN refreshes on any amount, ZOOM keeps
 * a hysteresis.
 *
 * Recomputing the render budget + re-hydrating on every tiny zoom nudge causes
 * loading churn, so a zoom change refreshes only past a magnification threshold
 * measured against the LAST REFRESH (`zoomFraction`, e.g. 0.2 = 20% →
 * `log2(1.2)` ≈ 0.263 zoom levels). Panning reveals a genuinely new region, so
 * ANY center movement refreshes — there is no pan threshold.
 *
 * The trick that keeps the two apart (and keeps zoom hysteresis intact for
 * scroll-wheel zoom, which drifts the center toward the cursor): a center move
 * counts as a pan only when THIS EVENT didn't change the zoom (`lastEvent` is
 * the previous camera event). A center drift accompanying a zoom stays gated by
 * the zoom threshold. Comparing the pan against the last EVENT rather than the
 * last REFRESH is essential: a sub-threshold zoom leaves the refresh baseline
 * frozen at the old zoom, so a "zoom unchanged vs last refresh" test would treat
 * every following pan as a zoom and never refresh.
 */
export function cameraRefreshNeeded(
  current: { zoom: number; center: IGeoJSPosition },
  lastRefresh: { zoom: number; center: IGeoJSPosition } | null,
  lastEvent: { zoom: number; center: IGeoJSPosition } | null,
  zoomFraction: number,
): boolean {
  if (!lastRefresh || !current.center || !lastRefresh.center) {
    return true;
  }
  // Zoom: refresh past the magnification threshold since the last refresh.
  if (
    Math.abs(current.zoom - lastRefresh.zoom) >= Math.log2(1 + zoomFraction)
  ) {
    return true;
  }
  // Pan: the center moved since the last refresh AND this event isn't a zoom
  // (zoom unchanged vs the previous event → it's a pure pan). Fall back to the
  // last-refresh zoom when there's no prior event, so the very first camera
  // event after a non-camera refresh (e.g. a frame change) doesn't misread a
  // sub-threshold cursor-centered zoom — which drifts the center — as a pan.
  const centerMoved =
    current.center.x !== lastRefresh.center.x ||
    current.center.y !== lastRefresh.center.y;
  const previousZoom = lastEvent?.zoom ?? lastRefresh.zoom;
  const zoomUnchangedThisEvent = current.zoom === previousZoom;
  return centerMoved && zoomUnchangedThisEvent;
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

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

/**
 * Recenter, and zoom OUT if needed so a span of `spanX`×`spanY` around the new
 * center fits in the viewport. Never zooms in.
 *
 * `spanX`/`spanY` are a **signed vector**, not absolute extents. Under rotation
 * the projection onto the camera axes depends on the sign: for a 45-degree
 * viewport a delta of `(-23, 11)` needs ~2.4x while `(23, 11)` needs only
 * ~1.2x, so passing absolute values would under-scale and leave an endpoint
 * off screen. At zero rotation the sign cancels and it makes no difference.
 *
 * Needed when navigating to something that occupies two points rather than one —
 * a connection between annotations. Recentering alone leaves the far endpoint
 * off-screen at high zoom, and an endpoint that isn't displayed isn't drawn, so
 * the connection the user asked to see renders as nothing at all.
 *
 * Corners are scaled about the new center rather than recomputed from a
 * width/height, so any camera rotation is preserved.
 */
export function frameCameraInfo(
  info: ICameraInfo,
  center: IGeoJSPosition,
  spanX: number,
  spanY: number,
): ICameraInfo {
  const recentered = recenterCameraInfo(info, center);
  // Work in the camera's OWN basis, not axis-aligned min/max. Under rotation
  // gcsBounds is a rotated quadrilateral whose bounding box is larger than the
  // usable viewport, so an axis-aligned comparison under-scales — a span along
  // the diamond's diagonal would still fall outside the real viewport.
  const [c0, c1, , c3] = info.gcsBounds;
  const u = { x: c1.x - c0.x, y: c1.y - c0.y };
  const v = { x: c3.x - c0.x, y: c3.y - c0.y };
  const uLen = Math.hypot(u.x, u.y);
  const vLen = Math.hypot(v.x, v.y);
  if (uLen <= 0 || vLen <= 0) {
    return recentered;
  }
  // Project the required span onto each viewport edge direction.
  const alongU = Math.abs((spanX * u.x + spanY * u.y) / uLen);
  const alongV = Math.abs((spanX * v.x + spanY * v.y) / vLen);
  const scale = Math.max(alongU / uLen, alongV / vLen, 1);
  if (scale === 1) {
    return recentered;
  }
  return {
    ...recentered,
    // Each zoom level halves the visible span.
    zoom: info.zoom - Math.log2(scale),
    gcsBounds: recentered.gcsBounds.map((pt) => ({
      ...pt,
      x: center.x + (pt.x - center.x) * scale,
      y: center.y + (pt.y - center.y) * scale,
    })),
  };
}

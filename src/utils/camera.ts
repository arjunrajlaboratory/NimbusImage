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

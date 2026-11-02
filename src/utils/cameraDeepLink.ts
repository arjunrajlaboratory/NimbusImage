/**
 * Camera deep links: `#/datasetView/<viewId>/view?x=&y=&zoom=` opens the
 * viewer centered on an image point (see codebaseDocumentation/DATASET_LOCATION.md,
 * "Camera deep links").
 *
 * - `x`, `y`: full-resolution image pixel coordinates, origin top-left, the
 *   same coordinates annotations are stored in. Both are required.
 * - `width`: optional image pixels to show across the viewport, for callers
 *   that know a region but not the map (an MCP image result links its crop's
 *   width; a crop taller than the viewport's aspect is then cut off).
 * - `zoom`: optional GeoJS zoom level, the value `store.cameraInfo.zoom`
 *   holds; it wins over `width`. Without either the viewer zooms so about
 *   `DEFAULT_DEEP_LINK_VIEW_WIDTH` image pixels span the viewport's width.
 *
 * Invalid values (missing, empty, non-numeric, non-finite) are ignored: a link
 * with an unusable `x` or `y` opens the view as if neither were given, and an
 * unusable `zoom` falls back to the default.
 */

export interface ICameraDeepLink {
  x: number;
  y: number;
  zoom: number | null;
  /** Image pixels across the viewport; set only when the link gives one. */
  width?: number;
}

/** A parsed link, tied to the dataset it was made for. */
export interface IPendingCameraDeepLink extends ICameraDeepLink {
  datasetId: string;
}

export const CAMERA_DEEP_LINK_QUERY_KEYS = ["x", "y", "zoom", "width"] as const;

/** Image pixels across the viewport when a link gives no `zoom`. */
export const DEFAULT_DEEP_LINK_VIEW_WIDTH = 512;

type TRouteQuery = Record<string, string | null | (string | null)[]>;

function finiteQueryNumber(
  value: string | null | (string | null)[] | undefined,
): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw == null || raw.trim() === "") {
    return null;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseCameraDeepLink(
  query: TRouteQuery | null | undefined,
): ICameraDeepLink | null {
  if (!query) {
    return null;
  }
  const x = finiteQueryNumber(query.x);
  const y = finiteQueryNumber(query.y);
  if (x === null || y === null) {
    return null;
  }
  const link: ICameraDeepLink = { x, y, zoom: finiteQueryNumber(query.zoom) };
  const width = finiteQueryNumber(query.width);
  if (width !== null && width > 0) {
    link.width = width;
  }
  return link;
}

/** `query` without the camera deep-link keys, for links that change view. */
export function omitCameraDeepLinkQuery<T extends Record<string, unknown>>(
  query: T,
): Partial<T> {
  const rest: Partial<T> = { ...query };
  for (const key of CAMERA_DEEP_LINK_QUERY_KEYS) {
    delete rest[key];
  }
  return rest;
}

/**
 * The zoom at which `imageWidth` map units (image pixels) span
 * `viewportWidth` screen pixels. GeoJS halves units-per-pixel per zoom level:
 * `unitsPerPixel(z) = unitsPerPixel(0) / 2^z`.
 */
export function zoomToShowImageWidth(
  unitsPerPixelAtZoom0: number,
  viewportWidth: number,
  imageWidth: number = DEFAULT_DEEP_LINK_VIEW_WIDTH,
): number {
  return Math.log2((unitsPerPixelAtZoom0 * viewportWidth) / imageWidth);
}

/**
 * The zoom a deep link should open at: its own `zoom`, else its `width` (or
 * the default width) across the viewport, clamped to the map's zoom range.
 */
export function cameraDeepLinkZoom(
  link: ICameraDeepLink,
  map: {
    unitsPerPixelAtZoom0: number;
    viewportWidth: number;
    zoomRange: { min: number; max: number };
  },
): number {
  const zoom =
    link.zoom ??
    zoomToShowImageWidth(
      map.unitsPerPixelAtZoom0,
      map.viewportWidth,
      link.width ?? DEFAULT_DEEP_LINK_VIEW_WIDTH,
    );
  return Math.min(map.zoomRange.max, Math.max(map.zoomRange.min, zoom));
}

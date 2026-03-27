"""Coordinate convention handling for NimbusImage annotations.

Three coordinate systems:
1. Annotation: {'x': pixel_x, 'y': pixel_y} — x horizontal, y vertical
2. Numpy: array[row, col] = array[y, x]
3. Shapely: Point(x, y) — x horizontal, y vertical

Convention in this package:
- Shapely x = annotation x = image column (horizontal)
- Shapely y = annotation y = image row (vertical)
- No x/y swap for shapely conversions
- For numpy masks: row = annotation y, col = annotation x
- 0.5 offset: annotation coords are at pixel top-left corners;
  scikit-image draws at pixel centers
"""

from __future__ import annotations

import numpy as np
from shapely.geometry import Point, Polygon


def annotation_to_polygon(coordinates: list[dict]) -> Polygon | None:
    """Convert annotation coordinate dicts to a shapely Polygon.

    No x/y swap — annotation x maps to shapely x (horizontal).
    """
    if len(coordinates) < 3:
        return None
    points = [(c["x"], c["y"]) for c in coordinates]
    return Polygon(points)


def annotation_to_point(coordinates: list[dict]) -> Point | None:
    """Convert annotation coordinate dicts to a shapely Point.

    For single-coordinate annotations, returns that point.
    For multi-coordinate (polygons), returns the centroid.
    """
    if not coordinates:
        return None
    if len(coordinates) == 1:
        return Point(coordinates[0]["x"], coordinates[0]["y"])
    poly = annotation_to_polygon(coordinates)
    if poly is None:
        return None
    centroid = poly.centroid
    return Point(centroid.x, centroid.y)


def polygon_to_coordinates(polygon: Polygon) -> list[dict]:
    """Convert a shapely Polygon to annotation coordinate dicts.

    Strips the duplicate closing point that shapely adds.
    """
    xs, ys = polygon.exterior.xy
    # shapely repeats the first point at the end; exclude it
    coords = [{"x": float(x), "y": float(y)} for x, y in zip(xs, ys)]
    if len(coords) > 1 and coords[-1] == coords[0]:
        coords = coords[:-1]
    return coords


def point_to_coordinates(point: Point) -> list[dict]:
    """Convert a shapely Point to annotation coordinate dicts."""
    return [{"x": float(point.x), "y": float(point.y)}]


def coordinates_to_mask(
    coordinates: list[dict], shape: tuple[int, int]
) -> np.ndarray:
    """Convert annotation coordinates to a boolean mask.

    Applies the 0.5 offset: annotation coords are at pixel top-left
    corners, but rasterization uses pixel centers.

    Args:
        coordinates: List of {'x': ..., 'y': ...} dicts.
        shape: (height, width) of the output mask.

    Returns:
        Boolean numpy array of the given shape.
    """
    from skimage.draw import polygon as draw_polygon

    mask = np.zeros(shape, dtype=bool)
    if len(coordinates) < 3:
        return mask

    # rows = annotation y - 0.5, cols = annotation x - 0.5
    rows = np.array([c["y"] - 0.5 for c in coordinates])
    cols = np.array([c["x"] - 0.5 for c in coordinates])

    rr, cc = draw_polygon(rows, cols, shape=shape)
    mask[rr, cc] = True
    return mask


def mask_to_coordinates(mask: np.ndarray) -> list[dict]:
    """Convert a boolean mask to annotation coordinates.

    Uses contour finding and adds the 0.5 offset back.

    Returns:
        List of {'x': ..., 'y': ...} dicts forming the polygon boundary.
    """
    from skimage.measure import find_contours

    contours = find_contours(mask.astype(np.uint8), 0.5)
    if not contours:
        return []

    # Take the longest contour
    contour = max(contours, key=len)

    # contour is (N, 2) array of (row, col) at pixel centers
    # Add 0.5 to convert back to annotation coords (top-left corner)
    coords = []
    for row, col in contour:
        coords.append({"x": float(col + 0.5), "y": float(row + 0.5)})
    return coords


# --- Methods to attach to Annotation class ---


def _annotation_polygon(self) -> Polygon | None:
    """Return this annotation as a shapely Polygon."""
    return annotation_to_polygon(self.coordinates)


def _annotation_point(self) -> Point | None:
    """Return this annotation as a shapely Point (or centroid)."""
    return annotation_to_point(self.coordinates)


def _annotation_centroid(self) -> tuple[float, float]:
    """Return the centroid as (x, y) in annotation space."""
    pt = annotation_to_point(self.coordinates)
    if pt is None:
        return (0.0, 0.0)
    return (pt.x, pt.y)


def _annotation_get_mask(self, shape: tuple[int, int]) -> np.ndarray:
    """Return a boolean mask for this annotation."""
    return coordinates_to_mask(self.coordinates, shape)


def _annotation_get_pixels(
    self, shape: tuple[int, int]
) -> tuple[np.ndarray, np.ndarray]:
    """Return (rows, cols) arrays of pixels inside this annotation."""
    mask = coordinates_to_mask(self.coordinates, shape)
    return np.where(mask)


def _annotation_from_polygon(
    polygon: Polygon,
    channel: int,
    tags: list[str],
    dataset_id: str,
    location=None,
    color: str | None = None,
):
    """Create an Annotation from a shapely Polygon."""
    from nimbusimage.models import Annotation, Location as Loc

    return Annotation(
        id=None,
        shape="polygon",
        tags=tags,
        channel=channel,
        location=location or Loc(),
        coordinates=polygon_to_coordinates(polygon),
        dataset_id=dataset_id,
        color=color,
    )


def _annotation_from_mask(
    mask: np.ndarray,
    channel: int,
    tags: list[str],
    dataset_id: str,
    location=None,
    color: str | None = None,
):
    """Create an Annotation from a boolean mask."""
    from nimbusimage.models import Annotation, Location as Loc

    return Annotation(
        id=None,
        shape="polygon",
        tags=tags,
        channel=channel,
        location=location or Loc(),
        coordinates=mask_to_coordinates(mask),
        dataset_id=dataset_id,
        color=color,
    )


def attach_geometry_methods():
    """Attach geometry methods to the Annotation class.

    Called once during package initialization.
    """
    from nimbusimage.models import Annotation

    Annotation.polygon = _annotation_polygon
    Annotation.point = _annotation_point
    Annotation.centroid = _annotation_centroid
    Annotation.get_mask = _annotation_get_mask
    Annotation.get_pixels = _annotation_get_pixels
    Annotation.from_polygon = classmethod(
        lambda cls, *a, **kw: _annotation_from_polygon(*a, **kw)
    )
    Annotation.from_mask = classmethod(
        lambda cls, *a, **kw: _annotation_from_mask(*a, **kw)
    )

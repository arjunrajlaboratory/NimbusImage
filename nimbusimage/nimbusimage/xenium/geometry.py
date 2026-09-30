"""Coordinate transforms between Xenium microns and NimbusImage pixels.

NimbusImage annotation coordinates are image pixels (origin top-left, +y
down). Xenium vertices are microns, and the H&E image sits on its own pixel
grid, related to the morphology grid by the bundle's
``*_he_imagealignment.csv`` (a 3x3 affine, H&E px -> morphology px).
"""

from __future__ import annotations

from pathlib import Path
from typing import Callable, Iterator

import numpy as np

from nimbusimage.xenium.errors import XeniumError

REGION_FRAMES = ("he", "morphology", "microns")
REGION_TARGETS = ("morphology", "he")


def load_alignment(
    alignment: str | Path | np.ndarray | None,
) -> np.ndarray | None:
    """The 3x3 H&E alignment (H&E px -> morphology px) AS SHIPPED, or None.

    Takes the ``*_he_imagealignment.csv`` path or the matrix itself.
    """
    if alignment is None:
        return None
    if isinstance(alignment, np.ndarray):
        matrix = alignment
    else:
        try:
            matrix = np.loadtxt(alignment, delimiter=",")
        except (OSError, ValueError) as exc:
            raise XeniumError(
                f"cannot read alignment {alignment}: {exc}"
            ) from exc
    if matrix.shape != (3, 3):
        raise XeniumError(f"alignment matrix must be 3x3, got {matrix.shape}")
    return matrix


def inverse_alignment(
    alignment: str | Path | np.ndarray | None,
) -> np.ndarray | None:
    """The inverse of the H&E alignment (path or matrix), or None.

    Annotations live in morphology px, so drawing them on the H&E image
    needs the INVERSE of the shipped matrix.
    """
    matrix = load_alignment(alignment)
    if matrix is None:
        return None
    try:
        return np.linalg.inv(matrix)
    except np.linalg.LinAlgError as exc:
        raise XeniumError("alignment matrix is singular") from exc


def _apply_affine(matrix: np.ndarray, xy: np.ndarray) -> np.ndarray:
    homogeneous = np.column_stack([xy, np.ones(len(xy))])
    return (matrix @ homogeneous.T).T[:, :2]


def microns_to_pixels(
    xy_um: np.ndarray,
    pixel_size: float,
    inverse_alignment_matrix: np.ndarray | None = None,
) -> np.ndarray:
    """[K, 2] microns -> [K, 2] pixels of the target image.

    Morphology: ``px = um / pixel_size``. H&E: pass the inverse alignment,
    ``he_px = M^-1 @ [um / pixel_size, 1]``.
    """
    xy = xy_um / pixel_size
    if inverse_alignment_matrix is None:
        return xy
    return _apply_affine(inverse_alignment_matrix, xy)


def polygon_coordinates(
    vertices_um: np.ndarray,
    n_vertices: int,
    pixel_size: float,
    inverse_alignment_matrix: np.ndarray | None = None,
) -> list[dict]:
    """One polygon's NimbusImage coordinate list from its interleaved
    micron vertices (``[x0, y0, x1, y1, ...]``, padded past ``n_vertices``)."""
    xy_um = vertices_um[: 2 * n_vertices].reshape(-1, 2)
    xy = microns_to_pixels(xy_um, pixel_size, inverse_alignment_matrix)
    return [{"x": float(x), "y": float(y)} for x, y in xy]


def region_transform(
    frame: str,
    target: str,
    alignment: np.ndarray | None = None,
    pixel_size: float | None = None,
) -> Callable[[np.ndarray], np.ndarray]:
    """[K, 2] region coordinates in ``frame`` -> [K, 2] ``target`` pixels.

    ========== ========== ==============================
    frame      target     transform
    ========== ========== ==============================
    he         he         identity
    he         morphology alignment ``M``
    morphology morphology identity
    morphology he         ``M^-1``
    microns    morphology ``/ pixel_size``
    microns    he         ``/ pixel_size``, then ``M^-1``
    ========== ========== ==============================

    ``alignment`` is the matrix as shipped (not inverted).
    """
    if frame not in REGION_FRAMES:
        raise XeniumError(
            f"frame must be one of {REGION_FRAMES}, got {frame!r}"
        )
    if target not in REGION_TARGETS:
        raise XeniumError(
            f"target must be one of {REGION_TARGETS}, got {target!r}"
        )
    if frame == "microns" and not pixel_size:
        raise XeniumError("frame 'microns' needs the bundle's pixel_size")

    def needs_alignment() -> np.ndarray:
        if alignment is None:
            raise XeniumError(
                f"an alignment is required for {frame} -> {target}"
            )
        return alignment

    if frame == "he":
        if target == "he":
            return lambda xy: xy
        matrix = needs_alignment()
        return lambda xy: _apply_affine(matrix, xy)

    def scale(xy: np.ndarray) -> np.ndarray:
        return xy / pixel_size if frame == "microns" else xy

    if target == "morphology":
        return scale
    inverse = np.linalg.inv(needs_alignment())
    return lambda xy: _apply_affine(inverse, scale(xy))


def geojson_class_name(properties: dict) -> str | None:
    """QuPath's ``classification.name``, else a plain ``name``."""
    classification = properties.get("classification") or {}
    return classification.get("name") or properties.get("name")


def geojson_outer_rings(geometry: dict) -> Iterator[list]:
    """Outer ring of a Polygon, or of every polygon of a MultiPolygon."""
    if geometry.get("type") == "Polygon":
        yield geometry["coordinates"][0]
    elif geometry.get("type") == "MultiPolygon":
        for polygon in geometry["coordinates"]:
            yield polygon[0]

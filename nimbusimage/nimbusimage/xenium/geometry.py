"""How Xenium microns land on a NimbusImage dataset's pixels.

NimbusImage annotation coordinates are image pixels (origin top-left, +y
down). Xenium vertices and molecules are microns, and the H&E image sits on
its own pixel grid, related to the morphology grid by the bundle's
``*_he_imagealignment.csv`` (a 3x3 affine, H&E px -> morphology px).

``ImageFrame`` is the single description of that mapping for one dataset:
every step that produces or checks coordinates (polygons, the id check,
transcripts, regions) takes the same frame, so a pixel-size override or an
alignment is given once and cannot reach one step but not another.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import TYPE_CHECKING, Callable, Iterator

import numpy as np

from nimbusimage.xenium.errors import XeniumError

if TYPE_CHECKING:
    from nimbusimage.xenium.bundle import XeniumBundle

IMAGES = ("morphology", "he")
REGION_FRAMES = ("he", "morphology", "microns")


def load_alignment(
    alignment: str | Path | np.ndarray | None,
) -> np.ndarray | None:
    """The 3x3 H&E alignment (H&E px -> morphology px) AS SHIPPED, or None.

    Takes the ``*_he_imagealignment.csv`` path or the matrix itself, and
    checks it is a 3x3 invertible matrix.
    """
    if alignment is None:
        return None
    if isinstance(alignment, np.ndarray):
        matrix = alignment.astype(float)
    else:
        try:
            matrix = np.loadtxt(alignment, delimiter=",")
        except (OSError, ValueError) as exc:
            raise XeniumError(
                f"cannot read alignment {alignment}: {exc}"
            ) from exc
    if matrix.shape != (3, 3):
        raise XeniumError(f"alignment matrix must be 3x3, got {matrix.shape}")
    if not np.all(np.isfinite(matrix)) or abs(np.linalg.det(matrix)) < 1e-12:
        raise XeniumError("alignment matrix is singular")
    return matrix


def same_value(a, b) -> bool:
    """The one comparison of frame values (pixel sizes, matrices): both
    None, or equal within 1e-9."""
    if a is None or b is None:
        return a is None and b is None
    return bool(np.allclose(a, b, rtol=1e-9, atol=1e-9))


def _apply_affine(matrix: np.ndarray, xy: np.ndarray) -> np.ndarray:
    homogeneous = np.column_stack([xy, np.ones(len(xy))])
    return (matrix @ homogeneous.T).T[:, :2]


def _check_pixel_size(pixel_size) -> float | None:
    if pixel_size is None:
        return None
    try:
        value = float(pixel_size)
    except (TypeError, ValueError) as exc:
        raise XeniumError(
            f"pixel size {pixel_size!r} is not a number"
        ) from exc
    if not math.isfinite(value) or value <= 0:
        raise XeniumError(f"pixel size must be > 0 um/px, got {pixel_size!r}")
    return value


class ImageFrame:
    """How bundle microns map onto one dataset's image pixels.

    Args:
        image: ``"morphology"`` or ``"he"`` — which image the dataset shows.
        pixel_size: microns per MORPHOLOGY pixel (the bundle's
            ``pixel_size`` unless deliberately overridden). None only for a
            frame that never converts microns (regions drawn in pixels).
        alignment: the shipped H&E alignment (path or matrix). Required for
            ``"he"``; optional for morphology, where only regions drawn in
            H&E pixels need it.

    Everything is validated on construction, so a bad value fails before any
    step that uses the frame touches the server.
    """

    def __init__(
        self,
        image: str,
        pixel_size: float | None,
        alignment: str | Path | np.ndarray | None = None,
    ):
        if image not in IMAGES:
            raise XeniumError(f"image must be one of {IMAGES}, got {image!r}")
        self.image = image
        self.pixel_size = _check_pixel_size(pixel_size)
        self.alignment = load_alignment(alignment)
        if image == "he" and self.alignment is None:
            raise XeniumError("an H&E dataset needs the H&E alignment")
        # Morphology px -> this image's px, computed once (it is applied to
        # every polygon of an upload).
        self._transform = (
            None if image == "morphology" else np.linalg.inv(self.alignment)
        )

    @classmethod
    def create(
        cls,
        *,
        bundle: XeniumBundle | None = None,
        alignment=None,
        pixel_size: float | None = None,
        image: str | None = None,
    ) -> ImageFrame:
        """The frame for a dataset: H&E when an alignment is given (unless
        ``image`` says otherwise), the bundle's pixel size unless
        ``pixel_size`` overrides it. ``bundle`` is only read when no
        ``pixel_size`` is given."""
        if image is None:
            image = "he" if alignment is not None else "morphology"
        if pixel_size is None and bundle is not None:
            pixel_size = bundle.pixel_size
        return cls(image, pixel_size, alignment)

    # --- equality and storage (a CellMap saves the frame it was made with)

    def matches(self, other: ImageFrame) -> bool:
        return (
            self.image == other.image
            and same_value(self.pixel_size, other.pixel_size)
            and same_value(self.alignment, other.alignment)
        )

    def with_alignment(self, alignment) -> ImageFrame:
        """This frame plus an alignment it lacks (e.g. so regions drawn in
        H&E pixels can go on the morphology image). An alignment that
        differs from the frame's own is an error, never a replacement."""
        matrix = load_alignment(alignment)
        if matrix is None:
            return self
        if self.alignment is not None:
            if not same_value(matrix, self.alignment):
                raise XeniumError(
                    f"that alignment differs from the one in {self}"
                )
            return self
        return ImageFrame(self.image, self.pixel_size, matrix)

    def to_dict(self) -> dict:
        return {
            "image": self.image,
            "pixelSize": self.pixel_size,
            "alignment": (
                None if self.alignment is None else self.alignment.tolist()
            ),
        }

    @classmethod
    def from_dict(cls, data: dict) -> ImageFrame:
        alignment = data.get("alignment")
        return cls(
            data["image"],
            data.get("pixelSize"),
            None if alignment is None else np.asarray(alignment, float),
        )

    def __repr__(self) -> str:
        return (
            f"ImageFrame(image={self.image!r}, pixel_size={self.pixel_size}, "
            f"alignment={'yes' if self.alignment is not None else 'no'})"
        )

    # --- transforms

    def require_pixel_size(self) -> float:
        """The pixel size; raises if this frame can't convert microns."""
        if self.pixel_size is None:
            raise XeniumError("converting microns needs a pixel size")
        return self.pixel_size

    @property
    def transform(self) -> np.ndarray | None:
        """Morphology px -> this image's px: the INVERSE alignment for H&E,
        None (identity) for morphology."""
        return self._transform

    def microns_to_pixels(self, xy_um: np.ndarray) -> np.ndarray:
        """[K, 2] microns -> [K, 2] pixels of this image."""
        xy = np.asarray(xy_um, dtype=float) / self.require_pixel_size()
        transform = self.transform
        return xy if transform is None else _apply_affine(transform, xy)

    def polygon_coordinates(
        self, vertices_um: np.ndarray, n_vertices: int
    ) -> list[dict]:
        """One polygon's coordinate list from its interleaved micron
        vertices (``[x0, y0, x1, y1, ...]``, padded past ``n_vertices``)."""
        xy = self.microns_to_pixels(
            vertices_um[: 2 * n_vertices].reshape(-1, 2)
        )
        return [{"x": float(x), "y": float(y)} for x, y in xy]

    def region_transform(
        self, drawn_in: str
    ) -> Callable[[np.ndarray], np.ndarray]:
        """[K, 2] coordinates drawn in ``drawn_in`` -> this image's pixels.

        ========== ========== ==============================
        drawn_in   image      transform
        ========== ========== ==============================
        he         he         identity
        he         morphology alignment ``M``
        morphology morphology identity
        morphology he         ``M^-1``
        microns    morphology ``/ pixel_size``
        microns    he         ``/ pixel_size``, then ``M^-1``
        ========== ========== ==============================
        """
        if drawn_in not in REGION_FRAMES:
            raise XeniumError(
                f"drawn_in must be one of {REGION_FRAMES}, got {drawn_in!r}"
            )
        if drawn_in == "he":
            if self.image == "he":
                return lambda xy: xy
            if self.alignment is None:
                raise XeniumError(
                    "regions drawn in H&E pixels need the H&E alignment "
                    "to go on the morphology image"
                )
            matrix = self.alignment
            return lambda xy: _apply_affine(matrix, xy)
        if drawn_in == "microns":
            pixel_size = self.require_pixel_size()

            def scale(xy):
                return xy / pixel_size

        else:

            def scale(xy):
                return xy

        transform = self.transform
        if transform is None:
            return scale
        return lambda xy: _apply_affine(transform, scale(xy))


def geojson_features(geojson) -> list[dict]:
    """The features of any GeoJSON shape a tool writes: a FeatureCollection,
    a bare array of Features (QuPath without "Export as FeatureCollection"),
    one Feature, or one bare geometry."""
    if isinstance(geojson, list):
        features = geojson
    elif isinstance(geojson, dict) and "features" in geojson:
        features = geojson["features"]
    elif isinstance(geojson, dict) and geojson.get("type") == "Feature":
        features = [geojson]
    elif isinstance(geojson, dict) and "coordinates" in geojson:
        features = [{"geometry": geojson}]
    else:
        raise XeniumError("the GeoJSON is not a feature or a collection")
    if not isinstance(features, list) or not all(
        isinstance(feature, dict) for feature in features
    ):
        raise XeniumError("GeoJSON features must be a list of objects")
    return features


def geojson_class_name(properties: dict) -> str | None:
    """QuPath's ``classification.name``, else a plain ``name``."""
    if not isinstance(properties, dict):
        return None
    classification = properties.get("classification")
    if isinstance(classification, dict) and classification.get("name"):
        return str(classification["name"])
    name = properties.get("name")
    return str(name) if name else None


def geojson_outer_rings(geometry: dict) -> Iterator[list]:
    """Outer ring of a Polygon, or of every polygon of a MultiPolygon, as a
    [K, 2] float array."""
    kind = geometry.get("type")
    if kind not in ("Polygon", "MultiPolygon"):
        return
    try:
        polygons = geometry["coordinates"]
        if kind == "Polygon":
            rings = [polygons[0]]
        else:
            rings = [polygon[0] for polygon in polygons]
        arrays = [np.asarray(ring, dtype=np.float64) for ring in rings]
    except (KeyError, IndexError, TypeError, ValueError) as exc:
        raise XeniumError(f"malformed GeoJSON {kind}: {exc}") from exc
    for xy in arrays:
        if xy.ndim != 2 or xy.shape[1] < 2:
            raise XeniumError(f"malformed GeoJSON {kind} ring")
        yield xy[:, :2]

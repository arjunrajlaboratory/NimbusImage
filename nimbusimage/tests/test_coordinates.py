"""Tests for coordinate convention handling."""

import numpy as np
import pytest
from shapely.geometry import Point, Polygon

from nimbusimage.coordinates import (
    annotation_to_polygon,
    annotation_to_point,
    polygon_to_coordinates,
    point_to_coordinates,
    coordinates_to_mask,
    mask_to_coordinates,
)
from nimbusimage.models import Annotation, Location


class TestAnnotationToPolygon:
    """annotation coords → shapely Polygon (no swap, just extract)."""

    def test_basic_rectangle(self):
        coords = [
            {"x": 100.5, "y": 200.5},
            {"x": 150.5, "y": 200.5},
            {"x": 150.5, "y": 250.5},
            {"x": 100.5, "y": 250.5},
        ]
        poly = annotation_to_polygon(coords)
        assert isinstance(poly, Polygon)
        # shapely x = annotation x, shapely y = annotation y
        xs, ys = poly.exterior.xy
        assert min(xs) == pytest.approx(100.5)
        assert max(xs) == pytest.approx(150.5)
        assert min(ys) == pytest.approx(200.5)
        assert max(ys) == pytest.approx(250.5)

    def test_empty_coords_returns_none(self):
        assert annotation_to_polygon([]) is None

    def test_single_point_returns_none(self):
        assert annotation_to_polygon([{"x": 1.0, "y": 2.0}]) is None


class TestAnnotationToPoint:
    """annotation coords → shapely Point (no swap)."""

    def test_basic(self):
        coords = [{"x": 100.5, "y": 200.5}]
        pt = annotation_to_point(coords)
        assert isinstance(pt, Point)
        assert pt.x == pytest.approx(100.5)
        assert pt.y == pytest.approx(200.5)

    def test_polygon_centroid(self):
        coords = [
            {"x": 0.0, "y": 0.0},
            {"x": 10.0, "y": 0.0},
            {"x": 10.0, "y": 10.0},
            {"x": 0.0, "y": 10.0},
        ]
        pt = annotation_to_point(coords)
        assert pt.x == pytest.approx(5.0)
        assert pt.y == pytest.approx(5.0)

    def test_empty_returns_none(self):
        assert annotation_to_point([]) is None


class TestPolygonToCoordinates:
    """shapely Polygon → annotation coordinate dicts (no swap)."""

    def test_round_trip(self):
        original = [
            {"x": 100.5, "y": 200.5},
            {"x": 150.5, "y": 200.5},
            {"x": 150.5, "y": 250.5},
            {"x": 100.5, "y": 250.5},
        ]
        poly = annotation_to_polygon(original)
        result = polygon_to_coordinates(poly)
        # Should have same number of coords (shapely closes the ring,
        # but we strip the duplicate closing point)
        assert len(result) == 4
        for orig, res in zip(original, result):
            assert res["x"] == pytest.approx(orig["x"])
            assert res["y"] == pytest.approx(orig["y"])


class TestPointToCoordinates:
    """shapely Point → annotation coordinate dict (no swap)."""

    def test_basic(self):
        pt = Point(100.5, 200.5)
        result = point_to_coordinates(pt)
        assert len(result) == 1
        assert result[0]["x"] == pytest.approx(100.5)
        assert result[0]["y"] == pytest.approx(200.5)


class TestCoordinatesToMask:
    """annotation coords → boolean numpy mask (with 0.5 offset)."""

    def test_small_square(self):
        # A 3x3 square from pixel (10,20) to pixel (12,22)
        # Annotation coords at top-left corners: add 0.5 for centers
        coords = [
            {"x": 10.0, "y": 20.0},
            {"x": 13.0, "y": 20.0},
            {"x": 13.0, "y": 23.0},
            {"x": 10.0, "y": 23.0},
        ]
        mask = coordinates_to_mask(coords, (100, 100))
        assert mask.shape == (100, 100)
        assert mask.dtype == bool
        # Pixels inside: rows 20-22, cols 10-12
        assert mask[20, 10] is np.True_
        assert mask[22, 12] is np.True_
        # Pixel outside
        assert mask[19, 10] is np.False_
        assert mask[23, 13] is np.False_

    def test_returns_correct_shape(self):
        coords = [
            {"x": 0.0, "y": 0.0},
            {"x": 5.0, "y": 0.0},
            {"x": 5.0, "y": 5.0},
            {"x": 0.0, "y": 5.0},
        ]
        mask = coordinates_to_mask(coords, (50, 80))
        assert mask.shape == (50, 80)


class TestMaskToCoordinates:
    """boolean numpy mask → annotation coords (with 0.5 offset back)."""

    def test_round_trip_approximate(self):
        # Create a mask, convert to coords, convert back to mask
        original_mask = np.zeros((50, 50), dtype=bool)
        original_mask[10:20, 15:25] = True

        coords = mask_to_coordinates(original_mask)
        assert len(coords) > 0

        reconstructed = coordinates_to_mask(coords, (50, 50))
        # Should overlap substantially (rasterization may differ at edges)
        intersection = np.sum(original_mask & reconstructed)
        union = np.sum(original_mask | reconstructed)
        iou = intersection / union
        assert iou > 0.9  # Allow some edge rasterization difference


class TestAnnotationGeometryMethods:
    """Test the convenience methods attached to Annotation."""

    def test_polygon_method(self):
        ann = Annotation(
            id=None, shape="polygon", tags=[], channel=0,
            location=Location(), dataset_id="ds",
            coordinates=[
                {"x": 0.0, "y": 0.0},
                {"x": 10.0, "y": 0.0},
                {"x": 10.0, "y": 10.0},
                {"x": 0.0, "y": 10.0},
            ],
        )
        poly = ann.polygon()
        assert isinstance(poly, Polygon)
        assert poly.area == pytest.approx(100.0)

    def test_point_method(self):
        ann = Annotation(
            id=None, shape="point", tags=[], channel=0,
            location=Location(), dataset_id="ds",
            coordinates=[{"x": 50.5, "y": 60.5}],
        )
        pt = ann.point()
        assert isinstance(pt, Point)
        assert pt.x == pytest.approx(50.5)
        assert pt.y == pytest.approx(60.5)

    def test_centroid_method(self):
        ann = Annotation(
            id=None, shape="polygon", tags=[], channel=0,
            location=Location(), dataset_id="ds",
            coordinates=[
                {"x": 0.0, "y": 0.0},
                {"x": 10.0, "y": 0.0},
                {"x": 10.0, "y": 10.0},
                {"x": 0.0, "y": 10.0},
            ],
        )
        cx, cy = ann.centroid()
        assert cx == pytest.approx(5.0)
        assert cy == pytest.approx(5.0)

    def test_get_mask(self):
        ann = Annotation(
            id=None, shape="polygon", tags=[], channel=0,
            location=Location(), dataset_id="ds",
            coordinates=[
                {"x": 5.0, "y": 5.0},
                {"x": 15.0, "y": 5.0},
                {"x": 15.0, "y": 15.0},
                {"x": 5.0, "y": 15.0},
            ],
        )
        mask = ann.get_mask((50, 50))
        assert mask.shape == (50, 50)
        assert mask.dtype == bool
        assert mask[10, 10] is np.True_  # center of the square
        assert mask[0, 0] is np.False_   # outside

    def test_get_pixels(self):
        ann = Annotation(
            id=None, shape="polygon", tags=[], channel=0,
            location=Location(), dataset_id="ds",
            coordinates=[
                {"x": 5.0, "y": 5.0},
                {"x": 15.0, "y": 5.0},
                {"x": 15.0, "y": 15.0},
                {"x": 5.0, "y": 15.0},
            ],
        )
        rows, cols = ann.get_pixels((50, 50))
        assert len(rows) == len(cols)
        assert len(rows) > 0

    def test_from_polygon(self):
        poly = Polygon([(0, 0), (10, 0), (10, 10), (0, 10)])
        ann = Annotation.from_polygon(
            poly, channel=0, tags=["cell"], dataset_id="ds",
            location=Location(),
        )
        assert ann.shape == "polygon"
        assert len(ann.coordinates) == 4

    def test_from_mask(self):
        mask = np.zeros((50, 50), dtype=bool)
        mask[10:20, 15:25] = True
        ann = Annotation.from_mask(
            mask, channel=0, tags=["cell"], dataset_id="ds",
            location=Location(),
        )
        assert ann.shape == "polygon"
        assert len(ann.coordinates) > 0

    def test_polygon_to_annotation_round_trip(self):
        """annotation → polygon → annotation preserves coordinates."""
        original_coords = [
            {"x": 100.5, "y": 200.5},
            {"x": 150.5, "y": 200.5},
            {"x": 150.5, "y": 250.5},
            {"x": 100.5, "y": 250.5},
        ]
        ann = Annotation(
            id=None, shape="polygon", tags=[], channel=0,
            location=Location(), dataset_id="ds",
            coordinates=original_coords,
        )
        poly = ann.polygon()
        ann2 = Annotation.from_polygon(
            poly, channel=0, tags=[], dataset_id="ds", location=Location(),
        )
        for orig, result in zip(original_coords, ann2.coordinates):
            assert result["x"] == pytest.approx(orig["x"])
            assert result["y"] == pytest.approx(orig["y"])

"""Tests for ImageAccessor."""

import pickle
from unittest.mock import MagicMock

import numpy as np
from nimbusimage.images import ImageAccessor, _parse_color
from nimbusimage.models import FrameInfo


def _make_dataset(mock_gc, tiles_meta):
    """Create a mock Dataset with tiles metadata."""
    from nimbusimage.dataset import Dataset
    ds = Dataset.__new__(Dataset)
    ds._gc = mock_gc
    ds._id = "folder_001"
    ds._item_id = "item_001"
    ds._tiles = tiles_meta
    ds._folder_data = {"_id": "folder_001", "name": "Test"}
    ds.images = ImageAccessor(ds)
    return ds


class TestFrameIndexResolution:
    def test_build_frame_map(self, mock_gc, sample_tiles_metadata):
        ds = _make_dataset(mock_gc, sample_tiles_metadata)
        accessor = ds.images
        accessor._ensure_frame_map()

        # channel=0, time=0, z=0, xy=0 -> frame 0
        assert accessor._frame_index(channel=0, time=0, z=0, xy=0) == 0
        # channel=1, time=0, z=0, xy=0 -> frame 1
        assert accessor._frame_index(channel=1, time=0, z=0, xy=0) == 1
        # channel=0, time=0, z=1, xy=0 -> frame 2
        assert accessor._frame_index(channel=0, time=0, z=1, xy=0) == 2

    def test_no_frames_defaults(self, mock_gc):
        tiles = {"sizeX": 100, "sizeY": 100, "dtype": "uint8"}
        ds = _make_dataset(mock_gc, tiles)
        accessor = ds.images
        accessor._ensure_frame_map()
        assert accessor._frame_index(channel=0, time=0, z=0, xy=0) == 0


class TestImageGet:
    def test_get_returns_squeezed_2d(self, mock_gc, sample_tiles_metadata):
        # Mock getRegion to return a 3D array (with singleton dimension)
        img_3d = np.random.randint(0, 1000, (1, 768, 1024), dtype=np.uint16)
        mock_response = MagicMock()
        mock_response.content = pickle.dumps(img_3d)
        mock_gc.get.return_value = mock_response

        ds = _make_dataset(mock_gc, sample_tiles_metadata)
        result = ds.images.get(xy=0, z=0, time=0, channel=0)

        assert result.ndim == 2
        assert result.shape == (768, 1024)

    def test_get_all_channels(self, mock_gc, sample_tiles_metadata):
        img = np.zeros((768, 1024), dtype=np.uint16)
        mock_response = MagicMock()
        mock_response.content = pickle.dumps(img)
        mock_gc.get.return_value = mock_response

        ds = _make_dataset(mock_gc, sample_tiles_metadata)
        result = ds.images.get_all_channels(xy=0, z=0, time=0)

        # 2 channels in sample metadata
        assert len(result) == 2
        assert all(r.shape == (768, 1024) for r in result)

    def test_get_stack_z(self, mock_gc, sample_tiles_metadata):
        img = np.zeros((768, 1024), dtype=np.uint16)
        mock_response = MagicMock()
        mock_response.content = pickle.dumps(img)
        mock_gc.get.return_value = mock_response

        ds = _make_dataset(mock_gc, sample_tiles_metadata)
        result = ds.images.get_stack(xy=0, time=0, channel=0, axis="z")

        # 2 z-slices in sample metadata
        assert result.shape == (2, 768, 1024)


class TestGetComposite:
    def test_composite_with_percentile_contrast(
        self, mock_gc, sample_tiles_metadata,
    ):
        """Test get_composite with percentile contrast."""
        from nimbusimage.collections import CollectionAccessor

        # Gradient image for percentile contrast
        img = np.linspace(
            0, 1000, 768 * 1024, dtype=np.uint16,
        ).reshape(768, 1024)
        mock_response = MagicMock()
        mock_response.content = pickle.dumps(img)
        mock_gc.get.return_value = mock_response

        ds = _make_dataset(mock_gc, sample_tiles_metadata)

        # Mock config with real layer format (hex color, percentile contrast)
        ds.collections = CollectionAccessor.__new__(CollectionAccessor)
        ds.collections._gc = mock_gc
        ds.collections._dataset_id = "folder_001"
        ds.collections._cache = {
            "meta": {
                "layers": [
                    {
                        "channel": 0,
                        "color": "#FF0000",
                        "visible": True,
                        "contrast": {
                            "blackPoint": 1,
                            "whitePoint": 99,
                            "mode": "percentile",
                        },
                    },
                    {
                        "channel": 1,
                        "color": "#00FF00",
                        "visible": True,
                        "contrast": {
                            "blackPoint": 0,
                            "whitePoint": 100,
                            "mode": "percentile",
                        },
                    },
                ],
                "propertyIds": [],
            }
        }

        result = ds.images.get_composite(
            xy=0, z=0, time=0, dtype="uint8",
        )
        assert result.shape == (768, 1024, 3)
        assert result.dtype == np.uint8
        # Should have red and green channels with non-zero values
        assert result[:, :, 0].max() > 0  # red from channel 0
        assert result[:, :, 1].max() > 0  # green from channel 1

    def test_composite_hidden_layer_excluded(
        self, mock_gc, sample_tiles_metadata,
    ):
        img = np.ones((768, 1024), dtype=np.uint16) * 500
        mock_response = MagicMock()
        mock_response.content = pickle.dumps(img)
        mock_gc.get.return_value = mock_response

        ds = _make_dataset(mock_gc, sample_tiles_metadata)

        from nimbusimage.collections import CollectionAccessor
        ds.collections = CollectionAccessor.__new__(CollectionAccessor)
        ds.collections._gc = mock_gc
        ds.collections._dataset_id = "folder_001"
        ds.collections._cache = {
            "meta": {
                "layers": [
                    {
                        "channel": 0, "color": "#FF0000", "visible": True,
                        "contrast": {
                            "blackPoint": 0,
                            "whitePoint": 100,
                            "mode": "percentile",
                        },
                    },
                    {
                        "channel": 1,
                        "color": "#00FF00",
                        "visible": False,
                        "contrast": {
                            "blackPoint": 0,
                            "whitePoint": 100,
                            "mode": "percentile",
                        },
                    },
                ],
                "propertyIds": [],
            }
        }

        result = ds.images.get_composite(
            xy=0, z=0, time=0, dtype="float64",
        )
        # Green channel should be zero (layer hidden)
        assert result[:, :, 1].max() == 0.0
        # Red should be non-zero
        assert result[:, :, 0].max() > 0.0


class TestIterFrames:
    def test_iter_frames(self, mock_gc, sample_tiles_metadata):
        img = np.zeros((768, 1024), dtype=np.uint16)
        mock_response = MagicMock()
        mock_response.content = pickle.dumps(img)
        mock_gc.get.return_value = mock_response

        ds = _make_dataset(mock_gc, sample_tiles_metadata)
        frames = list(ds.images.iter_frames())

        assert len(frames) == 4  # 2 channels x 2 z-slices
        assert isinstance(frames[0][0], FrameInfo)
        assert frames[0][1].shape == (768, 1024)


def _mock_gradient_region_endpoint(mock_gc):
    """Serve tiles/region requests from a synthetic linear gradient.

    The master image has pixel values master[r, c] = 2*c + 3*r, i.e. the
    continuous field g(x, y) = 2*(x - 0.5) + 3*(y - 0.5) at pixel centers.
    Linear fields are reproduced exactly by bilinear interpolation and by
    center-aligned downsampling, so tests can assert exact values.

    Returns the list of captured request parameter dicts.
    """
    captured = []

    def side_effect(path, parameters=None, jsonResp=True):
        captured.append(parameters)
        p = parameters
        left, top = p["left"], p["top"]
        width = p.get("width", int(round(p["right"] - left)))
        height = p.get("height", int(round(p["bottom"] - top)))
        scale_x = width / (p["right"] - left)
        scale_y = height / (p["bottom"] - top)
        cols, rows = np.meshgrid(np.arange(width), np.arange(height))
        x = left + (cols + 0.5) / scale_x
        y = top + (rows + 0.5) / scale_y
        arr = 2.0 * (x - 0.5) + 3.0 * (y - 0.5)
        response = MagicMock()
        response.content = pickle.dumps(arr)
        return response

    mock_gc.get.side_effect = side_effect
    return captured


def _gradient(x, y):
    """The continuous field matching _mock_gradient_region_endpoint."""
    return 2.0 * (np.asarray(x) - 0.5) + 3.0 * (np.asarray(y) - 0.5)


class TestLineScan:
    def test_straight_line_values_and_distances(
        self, mock_gc, sample_tiles_metadata,
    ):
        ds = _make_dataset(mock_gc, sample_tiles_metadata)
        _mock_gradient_region_endpoint(mock_gc)

        result = ds.images.line_scan([(5, 10), (15, 10)])

        # ~1 sample per pixel of length: 10 px -> 11 samples
        assert len(result.distances) == 11
        np.testing.assert_allclose(result.distances, np.arange(11.0))
        np.testing.assert_allclose(
            result.values, _gradient(np.linspace(5, 15, 11), 10)
        )
        np.testing.assert_allclose(result.points[:, 1], 10.0)

    def test_polyline_distances_and_corner(
        self, mock_gc, sample_tiles_metadata,
    ):
        ds = _make_dataset(mock_gc, sample_tiles_metadata)
        _mock_gradient_region_endpoint(mock_gc)

        result = ds.images.line_scan([(10, 10), (20, 10), (20, 20)])

        assert result.distances[-1] == 20.0
        assert np.all(np.diff(result.distances) > 0)
        # Sample at distance 10 is the corner vertex (20, 10)
        corner = np.argmin(np.abs(result.distances - 10.0))
        np.testing.assert_allclose(result.points[corner], [20.0, 10.0])
        np.testing.assert_allclose(
            result.values[corner], _gradient(20.0, 10.0)
        )

    def test_outside_image_is_nan(self, mock_gc, sample_tiles_metadata):
        ds = _make_dataset(mock_gc, sample_tiles_metadata)
        _mock_gradient_region_endpoint(mock_gc)

        result = ds.images.line_scan([(-20, 5), (10, 5)])

        outside = result.points[:, 0] < 0
        assert outside.any()
        assert np.isnan(result.values[outside]).all()
        inside = result.points[:, 0] >= 1
        assert np.isfinite(result.values[inside]).all()
        np.testing.assert_allclose(
            result.values[inside],
            _gradient(result.points[inside, 0], 5),
        )

    def test_large_region_downsampled(self, mock_gc):
        tiles = {
            "sizeX": 5000, "sizeY": 4000, "dtype": "uint16",
            "frames": [],
        }
        ds = _make_dataset(mock_gc, tiles)
        captured = _mock_gradient_region_endpoint(mock_gc)

        result = ds.images.line_scan([(0, 0), (4000, 3000)])

        # 5000 px long line, capped at 2000 samples
        assert len(result.distances) == 2000
        # The region request must be capped to max_region_dim per side
        params = captured[0]
        assert params["width"] == 2048
        assert max(params["width"], params["height"]) == 2048
        # Values still map back to image coordinates exactly
        finite = np.isfinite(result.values)
        np.testing.assert_allclose(
            result.values[finite],
            _gradient(
                result.points[finite, 0], result.points[finite, 1]
            ),
        )

    def test_short_line_sample_count(self, mock_gc, sample_tiles_metadata):
        ds = _make_dataset(mock_gc, sample_tiles_metadata)
        _mock_gradient_region_endpoint(mock_gc)

        result = ds.images.line_scan([(10, 10), (14.2, 10)])
        # ceil(4.2) + 1 = 6 samples
        assert len(result.distances) == 6

    def test_frame_selection(self, mock_gc, sample_tiles_metadata):
        ds = _make_dataset(mock_gc, sample_tiles_metadata)
        captured = _mock_gradient_region_endpoint(mock_gc)

        ds.images.line_scan([(5, 10), (15, 10)], channel=1, z=1)

        # channel=1, z=1 -> frame 3 in sample metadata
        assert captured[0]["frame"] == 3

    def test_multiband_region_averaged(
        self, mock_gc, sample_tiles_metadata,
    ):
        ds = _make_dataset(mock_gc, sample_tiles_metadata)

        def side_effect(path, parameters=None, jsonResp=True):
            p = parameters
            width = int(round(p["right"] - p["left"]))
            height = int(round(p["bottom"] - p["top"]))
            cols, rows = np.meshgrid(np.arange(width), np.arange(height))
            band = _gradient(p["left"] + cols + 0.5, p["top"] + rows + 0.5)
            # Three bands offset by 0, 3, 6 -> mean is band + 3
            arr = np.stack([band, band + 3, band + 6], axis=-1)
            response = MagicMock()
            response.content = pickle.dumps(arr)
            return response

        mock_gc.get.side_effect = side_effect
        result = ds.images.line_scan([(5, 10), (15, 10)])
        np.testing.assert_allclose(
            result.values, _gradient(result.points[:, 0], 10) + 3
        )

    def test_invalid_inputs_raise(self, mock_gc, sample_tiles_metadata):
        import pytest

        ds = _make_dataset(mock_gc, sample_tiles_metadata)
        with pytest.raises(ValueError, match="at least 2"):
            ds.images.line_scan([(5, 10)])
        with pytest.raises(ValueError, match="zero length"):
            ds.images.line_scan([(5, 10), (5, 10)])
        with pytest.raises(ValueError, match="at least 2"):
            ds.images.line_scan([5, 10])
        with pytest.raises(ValueError, match="outside the image"):
            ds.images.line_scan([(-50, -50), (-10, -10)])


class TestParseColor:
    def test_white(self):
        assert _parse_color("white") == (1.0, 1.0, 1.0)

    def test_rgb(self):
        assert _parse_color("rgb(255,0,0)") == (1.0, 0.0, 0.0)

    def test_rgb_with_spaces(self):
        assert _parse_color("rgb(0, 255, 0)") == (0.0, 1.0, 0.0)

    def test_hex(self):
        assert _parse_color("#FF0000") == (1.0, 0.0, 0.0)

    def test_hex_lowercase(self):
        r, g, b = _parse_color("#00ff00")
        assert r == 0.0
        assert g == 1.0
        assert b == 0.0

    def test_unknown_warns(self):
        import warnings
        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter("always")
            result = _parse_color("red")
            assert result == (1.0, 1.0, 1.0)
            assert len(w) == 1
            assert "Unrecognized color format" in str(w[0].message)

    def test_short_hex_warns(self):
        import warnings
        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter("always")
            _parse_color("#F00")
            assert len(w) == 1


class TestImageWriterGuard:
    """Test that ImageWriter prevents double-write."""

    def test_write_sets_written_flag(self):
        """Verify that write() sets _written to prevent double-write."""
        from nimbusimage.images import ImageWriter

        writer = ImageWriter.__new__(ImageWriter)
        writer._written = False
        writer._filename = "test.tiff"
        writer._metadata = {}

        # Mock the internals
        writer._sink = MagicMock()
        writer._dataset = MagicMock()
        writer._dataset._gc = MagicMock()
        writer._dataset._id = "ds_001"

        import tempfile
        import os
        path = os.path.join(tempfile.gettempdir(), "test.tiff")
        # Create a dummy file so os.remove doesn't fail
        with open(path, "w") as f:
            f.write("dummy")

        writer.write("test.tiff")
        assert writer._written is True

        # Second call should be a no-op
        writer._sink.write.reset_mock()
        writer.write("test.tiff")
        writer._sink.write.assert_not_called()

    def test_context_manager_no_double_write(self):
        """Verify __exit__ doesn't write again after explicit write()."""
        from nimbusimage.images import ImageWriter

        writer = ImageWriter.__new__(ImageWriter)
        writer._written = True  # simulate already written
        writer._filename = "test.tiff"
        writer._sink = MagicMock()
        writer._dataset = MagicMock()

        writer.__exit__(None, None, None)
        # write() should not be called on the sink since _written is True
        writer._sink.write.assert_not_called()

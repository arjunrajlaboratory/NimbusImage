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

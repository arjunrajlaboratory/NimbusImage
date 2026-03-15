"""Tests for ImageAccessor."""

import pickle
from unittest.mock import MagicMock, patch, PropertyMock

import numpy as np
import pytest

from nimbusimage.images import ImageAccessor
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
    def test_composite_with_percentile_contrast(self, mock_gc, sample_tiles_metadata):
        """Test that get_composite handles the real layer format with
        percentile-based contrast (blackPoint/whitePoint)."""
        from nimbusimage.config import ConfigAccessor

        # Create a gradient image so percentile contrast produces a visible result
        img = np.linspace(0, 1000, 768 * 1024, dtype=np.uint16).reshape(768, 1024)
        mock_response = MagicMock()
        mock_response.content = pickle.dumps(img)
        mock_gc.get.return_value = mock_response

        ds = _make_dataset(mock_gc, sample_tiles_metadata)

        # Mock config with real layer format (hex color, percentile contrast)
        ds.config = ConfigAccessor.__new__(ConfigAccessor)
        ds.config._gc = mock_gc
        ds.config._dataset_id = "folder_001"
        ds.config._config_cache = {
            "meta": {
                "layers": [
                    {
                        "channel": 0,
                        "color": "#FF0000",
                        "visible": True,
                        "contrast": {"blackPoint": 1, "whitePoint": 99, "mode": "percentile"},
                    },
                    {
                        "channel": 1,
                        "color": "#00FF00",
                        "visible": True,
                        "contrast": {"blackPoint": 0, "whitePoint": 100, "mode": "percentile"},
                    },
                ],
                "propertyIds": [],
            }
        }

        result = ds.images.get_composite(xy=0, z=0, time=0, dtype="uint8")
        assert result.shape == (768, 1024, 3)
        assert result.dtype == np.uint8
        # Should have red and green channels with non-zero values
        assert result[:, :, 0].max() > 0  # red from channel 0
        assert result[:, :, 1].max() > 0  # green from channel 1

    def test_composite_hidden_layer_excluded(self, mock_gc, sample_tiles_metadata):
        img = np.ones((768, 1024), dtype=np.uint16) * 500
        mock_response = MagicMock()
        mock_response.content = pickle.dumps(img)
        mock_gc.get.return_value = mock_response

        ds = _make_dataset(mock_gc, sample_tiles_metadata)

        from nimbusimage.config import ConfigAccessor
        ds.config = ConfigAccessor.__new__(ConfigAccessor)
        ds.config._gc = mock_gc
        ds.config._dataset_id = "folder_001"
        ds.config._config_cache = {
            "meta": {
                "layers": [
                    {
                        "channel": 0, "color": "#FF0000", "visible": True,
                        "contrast": {"blackPoint": 0, "whitePoint": 100, "mode": "percentile"},
                    },
                    {
                        "channel": 1, "color": "#00FF00", "visible": False,
                        "contrast": {"blackPoint": 0, "whitePoint": 100, "mode": "percentile"},
                    },
                ],
                "propertyIds": [],
            }
        }

        result = ds.images.get_composite(xy=0, z=0, time=0, dtype="float64")
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

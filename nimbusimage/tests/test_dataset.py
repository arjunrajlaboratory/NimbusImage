"""Tests for Dataset class."""

import pytest

from nimbusimage.dataset import Dataset
from nimbusimage.models import FrameInfo, PixelSize


class TestDatasetMetadata:
    def test_lazy_no_http_on_init(self, mock_gc):
        ds = Dataset(mock_gc, "folder_123")
        assert ds.id == "folder_123"
        mock_gc.get.assert_not_called()

    def test_metadata_fetched_on_first_access(self, mock_gc, sample_tiles_metadata):
        # Mock the folder endpoint (to find the large image item)
        mock_gc.get.side_effect = [
            # GET /folder/{id}
            {"_id": "folder_123", "name": "Test Dataset", "meta": {}},
            # GET /item?folderId={id}&limit=0
            [{"_id": "item_456", "largeImage": {"fileId": "f1"}}],
            # GET /item/{id}/tiles
            sample_tiles_metadata,
        ]

        ds = Dataset(mock_gc, "folder_123")
        assert ds.name == "Test Dataset"
        assert ds.num_channels == 2
        assert ds.num_z == 2
        assert ds.num_time == 1
        assert ds.num_xy == 1
        assert ds.channels == ["DAPI", "GFP"]
        assert ds.shape == (768, 1024)
        assert ds.dtype == "uint16"

    def test_pixel_size(self, mock_gc, sample_tiles_metadata):
        mock_gc.get.side_effect = [
            {"_id": "folder_123", "name": "Test", "meta": {}},
            [{"_id": "item_456", "largeImage": {"fileId": "f1"}}],
            sample_tiles_metadata,
        ]
        ds = Dataset(mock_gc, "folder_123")
        ps = ds.pixel_size
        assert isinstance(ps, PixelSize)
        assert ps.unit == "mm"
        assert ps.value == pytest.approx(0.000219)

    def test_frames(self, mock_gc, sample_tiles_metadata):
        mock_gc.get.side_effect = [
            {"_id": "folder_123", "name": "Test", "meta": {}},
            [{"_id": "item_456", "largeImage": {"fileId": "f1"}}],
            sample_tiles_metadata,
        ]
        ds = Dataset(mock_gc, "folder_123")
        frames = ds.frames
        assert len(frames) == 4
        assert isinstance(frames[0], FrameInfo)
        assert frames[0].channel == 0
        assert frames[0].channel_name == "DAPI"

    def test_metadata_cached_after_first_access(self, mock_gc, sample_tiles_metadata):
        mock_gc.get.side_effect = [
            {"_id": "folder_123", "name": "Test", "meta": {}},
            [{"_id": "item_456", "largeImage": {"fileId": "f1"}}],
            sample_tiles_metadata,
        ]
        ds = Dataset(mock_gc, "folder_123")
        _ = ds.name
        _ = ds.num_channels
        _ = ds.shape
        # Only 3 calls total (folder, items, tiles), not re-fetched
        assert mock_gc.get.call_count == 3


class TestDatasetAccessors:
    def test_has_all_accessors(self, mock_gc):
        ds = Dataset(mock_gc, "folder_123")
        assert hasattr(ds, "images")
        assert hasattr(ds, "annotations")
        assert hasattr(ds, "connections")
        assert hasattr(ds, "properties")
        assert hasattr(ds, "config")
        assert hasattr(ds, "export")
        assert hasattr(ds, "history")
        assert hasattr(ds, "sharing")

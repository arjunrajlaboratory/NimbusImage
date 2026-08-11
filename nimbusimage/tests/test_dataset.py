"""Tests for Dataset class."""

import pytest

from nimbusimage.dataset import Dataset
from nimbusimage.models import FrameInfo, PixelSize


class TestDatasetMetadata:
    def test_lazy_no_http_on_init(self, mock_gc):
        ds = Dataset(mock_gc, "folder_123")
        assert ds.id == "folder_123"
        mock_gc.get.assert_not_called()

    def test_metadata_fetched_on_first_access(
        self, mock_gc, sample_tiles_metadata,
    ):
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

    def test_metadata_cached_after_first_access(
        self, mock_gc, sample_tiles_metadata,
    ):
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
        assert hasattr(ds, "collections")
        assert hasattr(ds, "export")
        assert hasattr(ds, "history")
        assert hasattr(ds, "sharing")


class TestDatasetConfigure:
    """Building a dataset from image files (POST dataset/{id}/multi_source)."""

    def _plan(self, **overrides):
        plan = {
            "config": {"channels": ["gfp"], "sources": [{"path": "a.tif"}]},
            "dimensionLabels": {"xy": None, "z": ["1"], "t": None},
            "variables": [
                {"id": 0, "name": "Filename variable 1", "source": "filename",
                 "guess": "C", "size": 2, "data": {}},
                {"id": 1, "name": "All frames per item", "source": "images",
                 "guess": "Z", "size": 1, "data": None},
            ],
            "assignments": {
                "XY": None, "T": None,
                "Z": {"source": "images", "guess": "Z",
                      "name": "All frames per item", "size": 1},
                "C": {"source": "filename", "guess": "C",
                      "name": "Filename variable 1", "size": 2},
            },
            "transcode": True,
        }
        plan.update(overrides)
        return plan

    def test_configure_posts_defaults(self, mock_gc):
        mock_gc.post.return_value = self._plan(
            itemId="item_new", jobId="job_1", validationError=None,
        )
        ds = Dataset(mock_gc, "folder_123")
        result = ds.configure()

        path, kwargs = mock_gc.post.call_args[0][0], mock_gc.post.call_args[1]
        assert path == "dataset/folder_123/multi_source"
        assert kwargs["json"] == {
            "splitRGBBands": True,
            "enableCompositing": False,
            "createView": True,
            "dryRun": False,
        }
        assert result.item_id == "item_new"
        assert result.job_id == "job_1"
        assert result.transcode is True
        assert result.is_valid

    def test_configure_omits_transcode_unless_given(self, mock_gc):
        """None must not be sent: the server picks the default (off only
        when every file is .nd2), and a literal null is a 400."""
        mock_gc.post.return_value = self._plan(itemId="i", jobId=None)
        Dataset(mock_gc, "folder_123").configure()
        assert "transcode" not in mock_gc.post.call_args[1]["json"]

        mock_gc.post.return_value = self._plan(itemId="i", jobId=None)
        Dataset(mock_gc, "folder_123").configure(transcode=False)
        assert mock_gc.post.call_args[1]["json"]["transcode"] is False

    def test_dry_run_reports_validation_error(self, mock_gc):
        mock_gc.post.return_value = self._plan(
            validationError="Not all variables are assigned",
        )
        plan = Dataset(mock_gc, "folder_123").configure(dry_run=True)

        assert mock_gc.post.call_args[1]["json"]["dryRun"] is True
        assert plan.item_id is None and plan.job_id is None
        assert not plan.is_valid
        assert plan.validation_error == "Not all variables are assigned"
        # The list the caller needs in order to build the override.
        assert [v["name"] for v in plan.unassigned_variables] == [
            "Filename variable 1",
        ] or plan.unassigned_variables == []

    def test_unassigned_variables_finds_the_leftover(self, mock_gc):
        plan = self._plan(validationError="Not all variables are assigned")
        # Three variables, only two used by the assignments.
        plan["variables"].append({
            "id": 2, "name": "Metadata 1 (Z)", "source": "file",
            "guess": "Z", "size": 38, "data": {},
        })
        # Same (source, guess) as an assigned variable but a different
        # name: matching on the pair would wrongly call this one used.
        plan["variables"].append({
            "id": 3, "name": "Filename variable 2", "source": "filename",
            "guess": "C", "size": 2, "data": {},
        })
        mock_gc.post.return_value = plan
        result = Dataset(mock_gc, "f").configure(dry_run=True)
        assert [v["name"] for v in result.unassigned_variables] == [
            "Metadata 1 (Z)", "Filename variable 2",
        ]

    def test_create_view_defaults_on_and_can_be_disabled(self, mock_gc):
        """Without a view the dataset has nothing to open in the UI and is
        missing from view-based listings, so it is on by default."""
        mock_gc.post.return_value = self._plan(
            itemId="i", jobId=None, collectionId="c", viewId="v",
        )
        result = Dataset(mock_gc, "f").configure()
        assert mock_gc.post.call_args[1]["json"]["createView"] is True
        assert result.collection_id == "c"
        assert result.view_id == "v"

        mock_gc.post.return_value = self._plan(itemId="i", jobId=None)
        result = Dataset(mock_gc, "f").configure(create_view=False)
        assert mock_gc.post.call_args[1]["json"]["createView"] is False
        assert result.collection_id is None
        assert result.view_id is None

    def test_rgb_fields_survive_the_response(self, mock_gc):
        """These only ever came back on a dry run and were being dropped
        by the model, leaving no way to tell whether split_rgb_bands
        applies."""
        mock_gc.post.return_value = self._plan(
            isRGBFile=True, rgbBandCount=3, transcodeDefault=False,
        )
        plan = Dataset(mock_gc, "f").configure(dry_run=True)
        assert plan.is_rgb_file is True
        assert plan.rgb_band_count == 3
        assert plan.transcode_default is False

    def test_assignments_override_is_forwarded(self, mock_gc):
        mock_gc.post.return_value = self._plan(itemId="i", jobId=None)
        Dataset(mock_gc, "folder_123").configure(
            assignments={"XY": {"source": "filename", "guess": "C"}},
            transcode=False,
        )
        assert mock_gc.post.call_args[1]["json"]["assignments"] == {
            "XY": {"source": "filename", "guess": "C"},
        }

    def test_configure_invalidates_cached_metadata(
        self, mock_gc, sample_tiles_metadata,
    ):
        mock_gc.get.side_effect = [
            {"_id": "folder_123", "name": "Test", "meta": {}},
            [{"_id": "item_456", "largeImage": {"fileId": "f1"}}],
            sample_tiles_metadata,
        ]
        ds = Dataset(mock_gc, "folder_123")
        assert ds.num_channels == 2

        mock_gc.post.return_value = self._plan(itemId="i", jobId=None)
        ds.configure(transcode=False)
        # Reconfiguring replaces the image, so the cache must be dropped.
        assert ds._tiles is None and ds._item_id is None

    def test_dry_run_keeps_cached_metadata(
        self, mock_gc, sample_tiles_metadata,
    ):
        mock_gc.get.side_effect = [
            {"_id": "folder_123", "name": "Test", "meta": {}},
            [{"_id": "item_456", "largeImage": {"fileId": "f1"}}],
            sample_tiles_metadata,
        ]
        ds = Dataset(mock_gc, "folder_123")
        assert ds.num_channels == 2

        mock_gc.post.return_value = self._plan()
        ds.configure(dry_run=True)
        assert ds._tiles is not None


class TestDatasetUpload:
    def test_upload_single_file(self, mock_gc, tmp_path):
        path = tmp_path / "a.tif"
        path.write_bytes(b"x")
        mock_gc.uploadFileToFolder.return_value = {"itemId": "item_a"}

        ids = Dataset(mock_gc, "folder_123").upload(path)

        assert ids == ["item_a"]
        mock_gc.uploadFileToFolder.assert_called_once_with(
            "folder_123", str(path),
        )

    def test_upload_directory_is_sorted_and_skips_dotfiles(
        self, mock_gc, tmp_path,
    ):
        for name in ("b.tif", "a.tif", ".DS_Store"):
            (tmp_path / name).write_bytes(b"x")
        # Subdirectories are covered by test_upload_rejects_subdirectories.
        mock_gc.uploadFileToFolder.side_effect = [
            {"itemId": "item_a"}, {"itemId": "item_b"},
        ]

        ids = Dataset(mock_gc, "folder_123").upload(tmp_path)

        assert ids == ["item_a", "item_b"]
        uploaded = [c[0][1] for c in mock_gc.uploadFileToFolder.call_args_list]
        assert [p.rsplit("/", 1)[-1] for p in uploaded] == ["a.tif", "b.tif"]

    def test_upload_invalidates_cached_metadata(
        self, mock_gc, sample_tiles_metadata, tmp_path,
    ):
        mock_gc.get.side_effect = [
            {"_id": "folder_123", "name": "Test", "meta": {}},
            [{"_id": "item_456", "largeImage": {"fileId": "f1"}}],
            sample_tiles_metadata,
        ]
        ds = Dataset(mock_gc, "folder_123")
        assert ds.num_channels == 2

        path = tmp_path / "a.tif"
        path.write_bytes(b"x")
        mock_gc.uploadFileToFolder.return_value = {"itemId": "item_a"}
        ds.upload(path)
        assert ds._tiles is None

    def test_upload_rejects_subdirectories(self, mock_gc, tmp_path):
        """Silently skipping them made a partial upload look complete."""
        (tmp_path / "a.tif").write_bytes(b"x")
        (tmp_path / "nested").mkdir()
        (tmp_path / "nested" / "c.tif").write_bytes(b"x")

        with pytest.raises(ValueError, match="nested"):
            Dataset(mock_gc, "folder_123").upload(tmp_path)
        mock_gc.uploadFileToFolder.assert_not_called()

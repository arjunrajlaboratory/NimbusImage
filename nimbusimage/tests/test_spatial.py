"""Tests for SpatialAccessor."""

import girder_client
import pytest

from nimbusimage.spatial import SpatialAccessor


class TestSpatialAccessor:
    def test_info_returns_none_when_unregistered(self, mock_gc):
        mock_gc.get.side_effect = girder_client.HttpError(
            404, "no table", "url", "GET"
        )
        assert SpatialAccessor(mock_gc, "ds_001").info() is None

    def test_info_reraises_other_errors(self, mock_gc):
        mock_gc.get.side_effect = girder_client.HttpError(
            403, "denied", "url", "GET"
        )
        with pytest.raises(girder_client.HttpError):
            SpatialAccessor(mock_gc, "ds_001").info()

    def test_info_passes_verify_only_when_asked(self, mock_gc):
        mock_gc.get.return_value = {"nObs": 6}
        accessor = SpatialAccessor(mock_gc, "ds_001")
        accessor.info()
        mock_gc.get.assert_called_with("spatial/ds_001", parameters=None)
        accessor.info(verify=True)
        mock_gc.get.assert_called_with(
            "spatial/ds_001", parameters={"verify": "true"}
        )

    def test_upload_and_register(self, mock_gc):
        # uploadFileToFolder returns the FILE; the item is what gets registered.
        mock_gc.uploadFileToFolder.return_value = {
            "_id": "file_1", "itemId": "item_1",
        }
        mock_gc.getItem.return_value = {"_id": "item_1"}
        mock_gc.post.return_value = {"nObs": 6, "nVar": 4}
        result = SpatialAccessor(mock_gc, "ds_001").upload_and_register(
            "/tmp/spatial.zarr.zip"
        )
        mock_gc.uploadFileToFolder.assert_called_once_with(
            "ds_001", "/tmp/spatial.zarr.zip"
        )
        mock_gc.post.assert_called_once_with(
            "spatial/ds_001/register", json={"itemId": "item_1"}
        )
        assert result == {"nObs": 6, "nVar": 4}

    def test_reads_hit_the_expected_routes(self, mock_gc):
        accessor = SpatialAccessor(mock_gc, "ds_001")
        mock_gc.get.return_value = [{"symbol": "CD3E"}]
        assert accessor.features("cd", limit=5) == [{"symbol": "CD3E"}]
        mock_gc.get.assert_called_with(
            "spatial/ds_001/features",
            parameters={"search": "cd", "limit": 5},
        )
        mock_gc.get.return_value = {"values": {"CD3E": 3}}
        assert accessor.row("ann_1") == {"CD3E": 3}
        mock_gc.get.assert_called_with(
            "spatial/ds_001/row", parameters={"annotationId": "ann_1"}
        )

    def test_aggregate_sends_filters_or_empty_object(self, mock_gc):
        accessor = SpatialAccessor(mock_gc, "ds_001")
        accessor.aggregate(["CD3E"])
        mock_gc.post.assert_called_with(
            "spatial/ds_001/aggregate",
            json={"features": ["CD3E"], "filters": {}},
        )
        filters = {"tags": {"values": ["B"], "exclusive": False}}
        accessor.aggregate(["CD3E"], filters)
        mock_gc.post.assert_called_with(
            "spatial/ds_001/aggregate",
            json={"features": ["CD3E"], "filters": filters},
        )

    def test_materialize_waits_for_job_only_when_scheduled(self, mock_gc):
        accessor = SpatialAccessor(mock_gc, "ds_001")
        mock_gc.post.return_value = {
            "propertyId": "p1", "written": 6, "jobId": None,
        }
        assert accessor.materialize(["CD3E"])["written"] == 6
        mock_gc.get.assert_not_called()

        mock_gc.post.return_value = {
            "propertyId": "p1", "written": 0, "jobId": "job_1",
        }
        mock_gc.get.return_value = {"_id": "job_1", "status": 3}
        result = accessor.materialize(["CD3E"], property_name="Panel")
        assert result["jobId"] == "job_1"
        mock_gc.post.assert_called_with(
            "spatial/ds_001/materialize",
            json={"features": ["CD3E"], "propertyName": "Panel"},
        )
        mock_gc.get.assert_any_call("job/job_1")

    def test_score_posts_name_and_method(self, mock_gc):
        mock_gc.post.return_value = {
            "propertyId": "p1", "written": 6, "jobId": None,
        }
        SpatialAccessor(mock_gc, "ds_001").score(
            ["CD3E", "CD2"], "T cell", method="sum"
        )
        mock_gc.post.assert_called_with(
            "spatial/ds_001/score",
            json={
                "features": ["CD3E", "CD2"], "name": "T cell",
                "method": "sum", "propertyName": "Gene set scores",
            },
        )

    def test_differential_waits_and_returns_the_ranked_table(self, mock_gc):
        mock_gc.post.return_value = {"jobId": "job_1", "nA": 3}
        table = {"nA": 3, "nB": 3, "featuresTested": 4, "features": []}
        mock_gc.get.return_value = {
            "_id": "job_1", "status": 3, "spatialResult": table,
        }
        filters = {"tags": {"values": ["B"], "exclusive": False}}
        result = SpatialAccessor(mock_gc, "ds_001").differential(filters)
        mock_gc.post.assert_called_with(
            "spatial/ds_001/differential",
            json={"filtersA": filters, "filtersB": None, "maxFeatures": 50},
        )
        assert result == table
        assert SpatialAccessor(mock_gc, "ds_001").virtual_path("CD3E") == [
            "spatial", "CD3E",
        ]


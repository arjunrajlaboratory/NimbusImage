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
            json={"filtersA": filters, "filtersB": None, "maxFeatures": 50,
                  "method": "welch"},
        )
        assert result == table
        assert SpatialAccessor(mock_gc, "ds_001").virtual_path("CD3E") == [
            "spatial", "CD3E",
        ]



class TestTranscripts:
    def test_transcripts_none_when_unregistered(self, mock_gc):
        mock_gc.get.side_effect = girder_client.HttpError(
            404, "none", "url", "GET"
        )
        assert SpatialAccessor(mock_gc, "ds_001").transcripts() is None

    def test_register_sends_pixel_size_and_transform(self, mock_gc):
        mock_gc.uploadFileToFolder.return_value = {"itemId": "item_t"}
        mock_gc.getItem.return_value = {"_id": "item_t"}
        accessor = SpatialAccessor(mock_gc, "ds_001")
        item = accessor.upload_transcripts("/tmp/transcripts.zarr.zip")
        accessor.register_transcripts(item["_id"], 0.2125)
        mock_gc.post.assert_called_with(
            "spatial/ds_001/transcripts/register",
            json={"itemId": "item_t", "pixelSize": 0.2125},
        )
        accessor.register_transcripts(
            "item_t", 0.5, transform=[[1, 0, 2], [0, 1, 3], [0, 0, 1]]
        )
        assert mock_gc.post.call_args.kwargs["json"]["transform"] == [
            [1.0, 0.0, 2.0], [0.0, 1.0, 3.0], [0.0, 0.0, 1.0],
        ]
        accessor.unregister_transcripts()
        mock_gc.delete.assert_called_with("spatial/ds_001/transcripts")

    def test_points_decode_the_binary_body(self, mock_gc):
        import struct

        import numpy as np

        body = struct.pack("<I", 2) + bytes([1])
        body += np.array([1.5, 2.5, 3.5, 4.5], "<f4").tobytes()
        body += bytes([0, 1])
        body += np.array([30.0, 15.0], "<f4").tobytes()
        mock_gc.sendRestRequest.return_value.content = body
        result = SpatialAccessor(mock_gc, "ds_001").transcript_points(
            ["CD3E", "MS4A1"], ["0,0"], level=0, min_qv=10
        )
        mock_gc.sendRestRequest.assert_called_once_with(
            "POST", "spatial/ds_001/transcripts/points",
            json={"genes": ["CD3E", "MS4A1"], "tiles": ["0,0"], "level": 0,
                  "minQv": 10},
            jsonResp=False,
        )
        assert result["x"].tolist() == [1.5, 3.5]
        assert result["y"].tolist() == [2.5, 4.5]
        assert result["gene"].tolist() == [0, 1]
        assert result["quality"].tolist() == [30.0, 15.0]

    def test_gene_search_route(self, mock_gc):
        accessor = SpatialAccessor(mock_gc, "ds_001")
        mock_gc.get.return_value = ["CD3E"]
        assert accessor.transcript_genes("cd", limit=3) == ["CD3E"]
        mock_gc.get.assert_called_with(
            "spatial/ds_001/transcripts/genes",
            parameters={"search": "cd", "limit": 3},
        )


class TestVersions:
    def test_version_routes(self, mock_gc):
        accessor = SpatialAccessor(mock_gc, "ds_001")
        mock_gc.get.return_value = {"active": {}, "versions": []}
        assert accessor.versions() == {"active": {}, "versions": []}
        mock_gc.get.assert_called_with("spatial/ds_001/versions")
        accessor.activate_version("item_9")
        mock_gc.post.assert_called_with(
            "spatial/ds_001/versions/item_9/activate"
        )
        accessor.forget_version("item_9")
        mock_gc.delete.assert_called_with("spatial/ds_001/versions/item_9")
        accessor.staleness()
        mock_gc.get.assert_called_with("spatial/ds_001/staleness")

    def test_recompute_waits_for_the_job_result(self, mock_gc):
        accessor = SpatialAccessor(mock_gc, "ds_001")
        mock_gc.post.return_value = {"jobId": "j1"}
        assert accessor.recompute(scope="dirty", wait=False) == {
            "jobId": "j1"
        }
        mock_gc.post.assert_called_with(
            "spatial/ds_001/recompute",
            json={"label": "Recomputed", "scope": "dirty", "minQv": 20,
                  "recomputeEmbeddings": False},
        )
        mock_gc.get.return_value = {
            "_id": "j1", "status": 3, "spatialResult": {"nObs": 4},
        }
        assert accessor.recompute(tags=["cell"]) == {"nObs": 4}
        assert mock_gc.post.call_args.kwargs["json"]["tags"] == ["cell"]
        mock_gc.get.return_value = {"_id": "j1", "status": 4}
        with pytest.raises(RuntimeError):
            accessor.recompute()


class TestNeighbourhoodAndRegions:
    def test_neighbourhood_none_until_computed(self, mock_gc):
        mock_gc.get.side_effect = girder_client.HttpError(
            404, "none", "url", "GET"
        )
        assert SpatialAccessor(mock_gc, "ds_001").neighbourhood() is None

    def test_compute_neighbourhood_posts_and_waits(self, mock_gc):
        accessor = SpatialAccessor(mock_gc, "ds_001")
        mock_gc.post.return_value = {"jobId": "j1", "propertyId": "p1"}
        mock_gc.get.return_value = {
            "_id": "j1", "status": 3, "spatialResult": {"types": ["B"]},
        }
        assert accessor.compute_neighbourhood(141, exclude_tags=["cell"]) == {
            "types": ["B"]
        }
        mock_gc.post.assert_called_with(
            "spatial/ds_001/neighbourhood",
            json={"radius": 141, "propertyName": "Neighbourhood",
                  "excludeTags": ["cell"]},
        )
        assert accessor.compute_neighbourhood(10, wait=False) == {
            "jobId": "j1", "propertyId": "p1"
        }

    def test_region_summary_bodies(self, mock_gc):
        accessor = SpatialAccessor(mock_gc, "ds_001")
        mock_gc.post.return_value = []
        accessor.region_summary("region", features=["CD3E"])
        mock_gc.post.assert_called_with(
            "spatial/ds_001/regions/summary",
            json={"regionTag": "region", "features": ["CD3E"]},
        )
        accessor.region_summary(region_ids=["r1"])
        mock_gc.post.assert_called_with(
            "spatial/ds_001/regions/summary", json={"regionIds": ["r1"]},
        )

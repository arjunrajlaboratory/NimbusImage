"""Phase 6: neighborhood composition/enrichment and region statistics."""

import numpy as np
import pytest
from pytest_girder.assertions import assertStatus, assertStatusOk

from girder_jobs.constants import JobStatus
from girder_jobs.models.job import Job

from upenncontrast_annotation.server.models.annotation import Annotation
from upenncontrast_annotation.server.models.propertyValues import (
    AnnotationPropertyValues,
)

from upenncontrast_spatial.server import neighborhood as module

from .test_spatial import TestSpatial, request


def square(datasetId, x, y, size, tags, name=None):
    document = {
        "tags": tags, "shape": "polygon", "channel": 0,
        "location": {"XY": 0, "Z": 0, "Time": 0},
        "coordinates": [
            {"x": x, "y": y}, {"x": x + size, "y": y},
            {"x": x + size, "y": y + size}, {"x": x, "y": y + size},
        ],
        "datasetId": datasetId,
    }
    if name:
        document["name"] = name
    return Annotation().create(document)


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_spatial")
class TestAnalysis(TestSpatial):
    def testNeighborhoodUnits(self):
        # Three cells on a line 10 apart: T, B, T; radius 15 links neighbors
        # only.
        centroids = np.array([[0, 0], [10, 0], [20, 0]], dtype=float)
        names, codes = module.typeIndex(np.array(["T", "B", "T"], object))
        assert names == ["B", "T"]
        counts, pairs = module.neighborhood(centroids, codes, 2, 15)
        # Cell 0 sees B; cell 1 sees two T; cell 2 sees B.
        assert counts.tolist() == [[1, 0], [0, 2], [1, 0]]
        # Pairs (i around j), symmetric: B-T twice each way.
        assert pairs.tolist() == [[0, 2], [2, 0]]
        matrix = module.enrichment(pairs)
        assert matrix[0][0] < 0 and matrix[0][1] > 0
        assert module.neighborhood(centroids, codes, 2, 5)[1].sum() == 0
        # Untyped cells count neighbors but appear in no pair.
        names, codes = module.typeIndex(np.array(["T", None, "T"], object))
        counts, pairs = module.neighborhood(centroids, codes, 1, 15)
        assert counts.tolist() == [[0], [2], [0]]
        assert pairs.tolist() == [[0]]
        assert module.enrichment(np.zeros((1, 1), int)).tolist() == [[0.0]]

    def testNeighborhoodJobWritesFractionsAndMatrix(
        self, admin, server, tmp_path, fsAssetstore
    ):
        folder, annotations, item = self._setup(admin, tmp_path)
        self._configure(admin, folder)
        # The six fixture triangles sit at the origin (types T, B, B, Endo,
        # T, B). Add two far-away cells that only see each other.
        a = square(folder["_id"], 1000, 1000, 10, ["cell", "Endo"])
        b = square(folder["_id"], 1012, 1000, 10, ["cell", "T"])
        resp = request(
            server, admin, "POST",
            "/spatial/%s/neighborhood" % folder["_id"],
            body={"radius": 20},
        )
        assertStatusOk(resp)
        job = Job().load(resp.json["jobId"], force=True)
        module.run(job)
        job = Job().load(resp.json["jobId"], force=True)
        assert job["status"] == JobStatus.SUCCESS, job.get("log")
        result = job["spatialResult"]
        assert result["types"] == ["B", "Endo", "T"]
        assert result["cells"] == 8 and result["typed"] == 8
        assert result["written"] == 8
        stored = request(
            server, admin, "GET", "/spatial/%s/neighborhood" % folder["_id"]
        )
        assertStatusOk(stored)
        assert stored.json["matrix"] == result["matrix"]
        assert stored.json["counts"] == [3, 2, 3]

        propertyKey = resp.json["propertyId"]
        values = {
            str(doc["annotationId"]): doc["values"][propertyKey]
            for doc in AnnotationPropertyValues().find({
                "datasetId": folder["_id"]
            })
        }
        # The far pair: a (Endo) has one neighbor, all T; b the reverse.
        assert values[str(a["_id"])] == {
            "neighbors": 1, "B": 0.0, "Endo": 0.0, "T": 1.0
        }
        assert values[str(b["_id"])]["Endo"] == 1.0
        # A triangle at the origin sees the other five.
        origin = values[str(annotations[0]["_id"])]
        assert origin["neighbors"] == 5
        assert abs(origin["B"] - 3 / 5) < 1e-9

    def testNeighborhoodValidation(
        self, admin, user, server, tmp_path, fsAssetstore
    ):
        folder, _, _ = self._setup(admin, tmp_path)
        path = "/spatial/%s/neighborhood" % folder["_id"]
        assertStatus(request(server, admin, "GET", path), 404)
        # No configuration yet: the property cannot be registered.
        assertStatus(
            request(server, admin, "POST", path, body={"radius": 10}), 400
        )
        self._configure(admin, folder)
        for body in (
            {}, {"radius": 0}, {"radius": -3}, {"radius": "wide"},
            {"radius": 10, "excludeTags": "cell"},
            {"radius": 10, "excludeTags": [""]},
            {"radius": 10, "propertyName": 7},
        ):
            assertStatus(request(server, admin, "POST", path, body=body), 400)
        assertStatus(
            request(server, user, "POST", path, body={"radius": 10}), 403
        )

    def testRegionSummary(self, admin, server, tmp_path, fsAssetstore):
        folder, annotations, item = self._setup(admin, tmp_path)
        self._register(server, admin, folder, item)
        # The six triangles (centroid ~ (6.7, 3.3)) fall in region R1 over
        # (0-50, 0-50); region R2 far away holds the two new cells.
        r1 = square(folder["_id"], 0, 0, 50, ["region"], name="follicle")
        r2 = square(folder["_id"], 900, 900, 300, ["region"])
        square(folder["_id"], 1000, 1000, 10, ["cell", "Endo"])
        square(folder["_id"], 1012, 1000, 10, ["cell", "T"])
        path = "/spatial/%s/regions/summary" % folder["_id"]
        resp = request(server, admin, "POST", path, body={
            "regionTag": "region", "features": ["CD3E", "MS4A1"],
        })
        assertStatusOk(resp)
        assert [r["name"] for r in resp.json] == ["follicle", str(r2["_id"])]
        first = resp.json[0]
        assert first["cells"] == 6 and first["rows"] == 6
        assert first["composition"] == [
            {"type": "B", "count": 3}, {"type": "T", "count": 2},
            {"type": "Endo", "count": 1},
        ]
        means = {f["symbol"]: f["mean"] for f in first["expression"]}
        # Fixture COUNTS column means over all six rows.
        from .test_spatial import COUNTS, SYMBOLS
        for symbol in ("CD3E", "MS4A1"):
            assert means[symbol] == pytest.approx(
                float(COUNTS[:, SYMBOLS.index(symbol)].mean())
            )
        second = resp.json[1]
        assert second["cells"] == 2 and second["rows"] == 0
        assert second["composition"] == [
            {"type": "Endo", "count": 1}, {"type": "T", "count": 1},
        ]
        # By id, without features: no table needed.
        module._centroidCache.clear()
        resp = request(server, admin, "POST", path, body={
            "regionIds": [str(r1["_id"])],
        })
        assertStatusOk(resp)
        assert len(resp.json) == 1 and resp.json[0]["expression"] == []
        # A different selection reuses the cached centroid pass: the cache
        # is keyed on the dataset and tags, not on the excluded ids.
        request(server, admin, "POST", path, body={
            "regionIds": [str(r2["_id"])],
        })
        assert len(module._centroidCache) == 1

    def testRegionSummaryValidation(
        self, admin, server, tmp_path, fsAssetstore
    ):
        folder, _, item = self._setup(admin, tmp_path)
        path = "/spatial/%s/regions/summary" % folder["_id"]
        for body in (
            {}, {"regionTag": ""}, {"regionIds": []}, {"regionIds": ["x"]},
            {"regionTag": "region", "excludeTags": [1]},
            {"regionIds": ["0" * 24] * 51},
        ):
            assertStatus(request(server, admin, "POST", path, body=body), 400)
        # Features without a registered table.
        assertStatus(request(server, admin, "POST", path, body={
            "regionTag": "region", "features": ["CD3E"],
        }), 400)
        # An unknown tag is simply no regions.
        resp = request(server, admin, "POST", path, body={"regionTag": "nope"})
        assertStatusOk(resp)
        assert resp.json == []

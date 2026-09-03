"""Phase 2: the `spatial` value provider through the annotation endpoints,
gene-set scores, and differential expression."""

import json
import math

import numpy as np
import pytest
from pytest_girder.assertions import assertStatus, assertStatusOk

from girder_jobs.constants import JobStatus
from girder_jobs.models.job import Job

from upenncontrast_annotation.server.models.propertyValues import (
    AnnotationPropertyValues,
)

from upenncontrast_spatial.server import differential as differentialModule
from upenncontrast_spatial.server import store as storeModule
from upenncontrast_spatial.server.provider import SpatialValueProvider

from .test_spatial import (
    COUNTS,
    SYMBOLS,
    TestSpatial,
    makeAnnotation,
    request,
)


def postJson(server, user, path, body):
    return server.request(
        path=path, method="POST", user=user,
        body=json.dumps(body), type="application/json", isJson=False,
    )


def streamed(resp):
    return json.loads(b"".join(resp.body))


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_spatial")
class TestSpatialProvider(TestSpatial):
    # Inherit the fixtures/helpers; the parent's tests re-run here too, which
    # is cheap and keeps the two files in step.

    def testVirtualPathFilterAndGate(
        self, admin, server, tmp_path, fsAssetstore
    ):
        folder, annotations, item = self._setup(admin, tmp_path)
        self._register(server, admin, folder, item)
        # CD3E >= 3: cells 0 (3) and 4 (5).
        resp = postJson(server, admin, "/upenn_annotation/list/ids", {
            "datasetId": str(folder["_id"]),
            "filters": {"propertyFilters": [
                {"path": ["spatial", "CD3E"], "mode": "range", "min": 3},
            ]},
        })
        assertStatusOk(resp)
        assert set(streamed(resp)["ids"]) == {
            str(annotations[0]["_id"]), str(annotations[4]["_id"]),
        }
        # A gate on the (CD3E, MS4A1) plane: MS4A1 > 0 catches cells 1, 2.
        resp = postJson(server, admin, "/upenn_annotation/analysis/gate_ids", {
            "datasetId": str(folder["_id"]),
            "plots": [{
                "id": "p",
                "xAxis": {"type": "property", "path": ["spatial", "CD3E"]},
                "yAxis": {"type": "property", "path": ["spatial", "MS4A1"]},
                "gate": {
                    "categoryKeyVersion": 1,
                    "xCategories": None,
                    "yCategories": None,
                    "vertices": [
                        {"x": -1, "y": 0.5}, {"x": 10, "y": 0.5},
                        {"x": 10, "y": 10}, {"x": -1, "y": 10},
                    ],
                },
            }],
        })
        assertStatusOk(resp)
        assert set(streamed(resp)["gateIds"]["p"]) == {
            str(annotations[1]["_id"]), str(annotations[2]["_id"]),
        }
        # Unknown gene is a 400 wherever the path is used.
        resp = postJson(server, admin, "/upenn_annotation/list/ids", {
            "datasetId": str(folder["_id"]),
            "filters": {"propertyFilters": [
                {"path": ["spatial", "NOPE"], "mode": "range", "min": 1},
            ]},
        })
        assertStatus(resp, 400)

    def testVirtualPathInListPageAndSummary(
        self, admin, server, tmp_path, fsAssetstore
    ):
        folder, annotations, item = self._setup(admin, tmp_path)
        self._register(server, admin, folder, item)
        resp = postJson(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]), "filters": {}, "sort": None,
            "propertyPaths": [["spatial", "CD19"]], "offset": 0, "limit": 10,
        })
        assertStatusOk(resp)
        values = {str(r["_id"]): r["values"] for r in streamed(resp)["rows"]}
        # Dense: every cell has a value, zeros included, as ints.
        assert values[str(annotations[1]["_id"])] == {"spatial": {"CD19": 2}}
        assert values[str(annotations[0]["_id"])] == {"spatial": {"CD19": 0}}
        resp = postJson(server, admin, "/upenn_annotation/summary", {
            "datasetId": str(folder["_id"]),
            "filters": {"tags": {"values": ["B"], "exclusive": False}},
            "propertyPaths": [["spatial", "MS4A1"]],
        })
        assertStatusOk(resp)
        stats = streamed(resp)["properties"][0]
        assert stats["count"] == 3
        assert math.isclose(stats["mean"], 5 / 3)

    def testProviderWithoutStoreAnswersNothing(self, tmp_path):
        provider = SpatialValueProvider()
        missing = "6a0000000000000000000000"
        assert provider.values(missing, ["spatial", "CD3E"]) == {}
        assert provider.valuesForIds(missing, ["spatial", "CD3E"], ["a"]) == [
            None,
        ]
        assert provider.matchingIds(
            missing, ["spatial", "CD3E"], {"mode": "range", "min": 0}
        ) == []

    # ---- score ----------------------------------------------------------

    def testScoreWritesOneSubValue(
        self, admin, server, tmp_path, fsAssetstore
    ):
        folder, annotations, item = self._setup(admin, tmp_path)
        self._register(server, admin, folder, item)
        self._configure(admin, folder)
        resp = request(
            server, admin, "POST", "/spatial/%s/score" % folder["_id"],
            body={"features": ["MS4A1", "CD19"], "name": "B score"},
        )
        assertStatusOk(resp)
        propertyId = resp.json["propertyId"]
        doc = AnnotationPropertyValues().findOne({
            "annotationId": annotations[1]["_id"],
        })
        # mean of MS4A1=4 and CD19=2
        assert doc["values"][propertyId] == {"B score": 3}
        zero = AnnotationPropertyValues().findOne({
            "annotationId": annotations[0]["_id"],
        })
        assert zero["values"][propertyId] == {"B score": 0}
        for body in (
            {"features": ["MS4A1"], "name": ""},
            {"features": ["MS4A1"], "name": "a.b"},
            {"features": ["MS4A1"], "name": "ok", "method": "median"},
        ):
            assertStatus(request(
                server, admin, "POST", "/spatial/%s/score" % folder["_id"],
                body=body,
            ), 400)

    # ---- differential ---------------------------------------------------

    def testDifferentialRanksAndSchedules(
        self, admin, server, tmp_path, fsAssetstore
    ):
        folder, annotations, item = self._setup(admin, tmp_path)
        self._register(server, admin, folder, item)
        ids = [str(a["_id"]) for a in annotations]
        path = str(tmp_path / "spatial.zarr.zip")
        spatialStore = storeModule.SpatialStore(path)

        # Direct: T cells (rows 0, 4) vs the rest.
        result = differentialModule.differential(
            spatialStore, np.array([0, 4]), None, 10
        )
        assert result["nA"] == 2 and result["nB"] == 4
        top = result["features"][0]
        assert top["symbol"] == "CD3E"
        assert top["meanA"] == 4 and top["meanB"] == 0
        assert top["fractionA"] == 1 and top["fractionB"] == 0
        assert top["log2FoldChange"] > 8
        assert top["t"] > 0 and 0 <= top["pValue"] <= 1
        # A constant feature contributes t=0, p=1, not a NaN.
        never = next(f for f in result["features"] if f["symbol"] == "PECAM1")
        assert never["fractionA"] == 0
        # Too small a group is a domain error.
        with pytest.raises(ValueError):
            differentialModule.differential(
                spatialStore, np.array([0]), None, 10
            )

        # Endpoint: validates, schedules, and the job stores the table.
        resp = request(
            server, admin, "POST", "/spatial/%s/differential" % folder["_id"],
            body={
                "filtersA": {"tags": {"values": ["T"], "exclusive": False}},
                "filtersB": {"tags": {"values": ["B"], "exclusive": False}},
                "maxFeatures": 2,
            },
        )
        assertStatusOk(resp)
        assert resp.json["nA"] == 2
        job = Job().load(resp.json["jobId"], force=True)
        differentialModule.run(job)
        job = Job().load(resp.json["jobId"], force=True)
        assert job["status"] == JobStatus.SUCCESS
        table = job["spatialResult"]
        assert table["nA"] == 2 and table["nB"] == 3
        assert len(table["features"]) == 2
        assert {f["symbol"] for f in table["features"]} <= set(SYMBOLS)
        assert ids  # ids resolved through the store, not carried in the job
        assert "rowsA" not in job["kwargs"]
        # The table survives the job model's field whitelist (what GET
        # job/{id} returns), not only the raw document.
        assert Job().filter(job, admin)["spatialResult"]["nA"] == 2

        # Group A must narrow the dataset.
        assertStatus(request(
            server, admin, "POST", "/spatial/%s/differential" % folder["_id"],
            body={"filtersA": {}},
        ), 400)


def testCountsFixtureIsWhatTheAssertionsAssume():
    """The differential assertions above read COUNTS by row; pin the fixture
    so a future edit to test_spatial.py's matrix fails here, not there."""
    assert COUNTS.shape == (6, 4)
    assert COUNTS[0, 0] == 3 and COUNTS[4, 0] == 5
    assert COUNTS[:, 3].tolist() == [0, 0, 0, 7, 0, 0]
    assert makeAnnotation is not None

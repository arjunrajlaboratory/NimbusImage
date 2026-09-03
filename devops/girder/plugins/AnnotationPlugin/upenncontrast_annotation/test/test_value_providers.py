"""The valueProviders hook, exercised with a fake provider: a virtual path
must behave like a stored property path in every consumer."""

import json

import pytest

from pytest_girder.assertions import assertStatus, assertStatusOk

from upenncontrast_annotation.server.helpers import valueProviders
from upenncontrast_annotation.server.models.annotation import Annotation
from upenncontrast_annotation.server.models.propertyValues import (
    AnnotationPropertyValues,
)

from . import girder_utilities as utilities
from . import upenn_testing_utilities as upenn_utilities
from .test_server_list import makeAnnotation, parseStreaming, postList

PREFIX = "fake"


class FakeProvider:
    """Value = the annotation's position in `self.order` * 10 for key "x";
    unknown keys raise, like the spatial provider does."""

    def __init__(self):
        self.order = []
        self.calls = []

    def _check(self, path):
        if path[1] != "x":
            raise ValueError("unknown key %r" % path[1])

    def values(self, datasetId, path):
        self._check(path)
        self.calls.append("values")
        return {annotationId: 10 * index
                for index, annotationId in enumerate(self.order)}

    def valuesForIds(self, datasetId, path, annotationIds):
        self._check(path)
        values = self.values(datasetId, path)
        return [values.get(annotationId) for annotationId in annotationIds]

    def matchingIds(self, datasetId, path, propertyFilter):
        self._check(path)
        values = self.values(datasetId, path)
        if propertyFilter.get("mode") == "values":
            return [a for a, v in values.items()
                    if v in propertyFilter.get("values", [])]
        low = propertyFilter.get("min")
        high = propertyFilter.get("max")
        return [
            a for a, v in values.items()
            if (low is None or v >= low) and (high is None or v <= high)
        ]


@pytest.fixture
def provider():
    fake = FakeProvider()
    valueProviders.registerValueProvider(PREFIX, fake)
    yield fake
    valueProviders._providers.pop(PREFIX, None)


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestValueProviders:
    def _setup(self, admin, provider):
        folder = utilities.createFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        anns = [makeAnnotation(folder["_id"], tags=[t]) for t in "abcd"]
        provider.order = [str(a["_id"]) for a in anns]
        # Only the first two have a stored value document.
        pv = AnnotationPropertyValues()
        pv.appendValues({"p": {"Area": 5}}, anns[0]["_id"], folder["_id"])
        pv.appendValues({"p": {"Area": 15}}, anns[1]["_id"], folder["_id"])
        return folder, anns

    def testVirtualPropertyFilterResolvesLikeAGate(
        self, admin, server, provider
    ):
        folder, anns = self._setup(admin, provider)
        resp = postList(server, admin, "/upenn_annotation/list/ids", {
            "datasetId": str(folder["_id"]),
            "filters": {"propertyFilters": [
                {"path": [PREFIX, "x"], "mode": "range", "min": 15},
            ]},
        })
        assertStatusOk(resp)
        # x = 0, 10, 20, 30 -> the last two.
        assert set(parseStreaming(resp)["ids"]) == {
            str(anns[2]["_id"]), str(anns[3]["_id"]),
        }
        # Combined with a stored-path filter: the virtual half becomes an id
        # clause, the stored half stays a Mongo match.
        resp = postList(server, admin, "/upenn_annotation/list/ids", {
            "datasetId": str(folder["_id"]),
            "filters": {"propertyFilters": [
                {"path": [PREFIX, "x"], "mode": "range", "max": 10},
                {"path": ["p", "Area"], "mode": "range", "min": 10},
            ]},
        })
        assertStatusOk(resp)
        assert parseStreaming(resp)["ids"] == [str(anns[1]["_id"])]
        # Unknown virtual key is a 400, not a 500.
        resp = postList(server, admin, "/upenn_annotation/list/ids", {
            "datasetId": str(folder["_id"]),
            "filters": {"propertyFilters": [
                {"path": [PREFIX, "nope"], "mode": "range", "min": 1},
            ]},
        })
        assertStatus(resp, 400)

    def testListPageCarriesVirtualValues(self, admin, server, provider):
        folder, anns = self._setup(admin, provider)
        resp = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]),
            "filters": {},
            "sort": None,
            "propertyPaths": [["p", "Area"], [PREFIX, "x"]],
            "offset": 0,
            "limit": 10,
        })
        assertStatusOk(resp)
        rows = {str(r["_id"]): r.get("values", {})
                for r in parseStreaming(resp)["rows"]}
        assert rows[str(anns[0]["_id"])] == {"p": {"Area": 5},
                                             PREFIX: {"x": 0}}
        # A row with no stored value document still gets the virtual value
        # (the stored path projects to an empty shell, as it always has).
        assert rows[str(anns[3]["_id"])][PREFIX] == {"x": 30}
        assert rows[str(anns[3]["_id"])].get("p") in ({}, None)
        # Sorting by a virtual column is refused.
        resp = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]),
            "filters": {},
            "sort": {"type": "property", "key": [PREFIX, "x"], "dir": 1},
            "propertyPaths": [],
            "offset": 0,
            "limit": 10,
        })
        assertStatus(resp, 400)

    def testAnalysisGateOnVirtualAxis(self, admin, server, provider):
        folder, anns = self._setup(admin, provider)
        resp = postList(server, admin, "/upenn_annotation/analysis/gate_ids", {
            "datasetId": str(folder["_id"]),
            "plots": [{
                "id": "plot",
                "xAxis": {"type": "property", "path": [PREFIX, "x"]},
                "yAxis": {"type": "property", "path": ["p", "Area"]},
                "gate": {
                    "categoryKeyVersion": 1,
                    "xCategories": None,
                    "yCategories": None,
                    "vertices": [
                        {"x": -1, "y": 0}, {"x": 12, "y": 0},
                        {"x": 12, "y": 20}, {"x": -1, "y": 20},
                    ],
                },
            }],
        })
        assertStatusOk(resp)
        # x in [-1, 12] and Area in [0, 20]: annotations 0 (x=0, Area=5) and
        # 1 (x=10, Area=15); 2 and 3 have no Area value.
        assert set(parseStreaming(resp)["gateIds"]["plot"]) == {
            str(anns[0]["_id"]), str(anns[1]["_id"]),
        }

    def testColorByVirtualPath(self, admin, server, provider):
        folder, anns = self._setup(admin, provider)
        resp = postList(server, admin, "/upenn_annotation/color_by_property", {
            "datasetId": str(folder["_id"]),
            "propertyPath": [PREFIX, "x"],
            "mode": "categorical",
        })
        assertStatusOk(resp)
        result = parseStreaming(resp)
        assert result["colored"] == 4
        assert result["uncolored"] == 0

    def testSummaryStatisticsOnVirtualPath(self, admin, server, provider):
        folder, anns = self._setup(admin, provider)
        resp = postList(server, admin, "/upenn_annotation/summary", {
            "datasetId": str(folder["_id"]),
            "filters": {"tags": {"values": ["c", "d"], "exclusive": False}},
            "propertyPaths": [[PREFIX, "x"], ["p", "Area"]],
        })
        assertStatusOk(resp)
        byPath = {
            ".".join(p["path"]): p for p in parseStreaming(resp)["properties"]
        }
        assert byPath[PREFIX + ".x"]["count"] == 2
        assert byPath[PREFIX + ".x"]["mean"] == 25
        assert byPath["p.Area"]["count"] == 0

    def testBatchValuesIncludeVirtualPath(self, admin, server, provider):
        folder, anns = self._setup(admin, provider)
        resp = server.request(
            path="/annotation_property_values/batch", method="POST",
            user=admin, type="application/json",
            body=json.dumps({
                "datasetId": str(folder["_id"]),
                "annotationIds": [str(a["_id"]) for a in anns[:3]],
                "propertyPaths": [["p", "Area"], [PREFIX, "x"]],
            }),
        )
        assertStatusOk(resp)
        byId = {str(d["annotationId"]): d["values"] for d in resp.json}
        assert byId[str(anns[0]["_id"])] == {"p": {"Area": 5},
                                             PREFIX: {"x": 0}}
        assert byId[str(anns[2]["_id"])] == {PREFIX: {"x": 20}}

    def testStoredPathsUntouchedWithoutProviders(self, admin, server):
        """No provider registered: the model treats every path as stored."""
        assert valueProviders.providerFor(["p", "Area"]) is None
        assert valueProviders.splitPaths([["p", "Area"]]) == (
            [["p", "Area"]], []
        )
        assert Annotation().resolveProviderFilters(
            None, {"propertyFilters": [{"path": ["p", "Area"],
                                        "mode": "range", "min": 1}]}
        ) == {"propertyFilters": [{"path": ["p", "Area"], "mode": "range",
                                   "min": 1}]}

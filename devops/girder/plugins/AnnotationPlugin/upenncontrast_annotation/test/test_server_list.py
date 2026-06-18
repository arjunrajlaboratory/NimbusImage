import json
import pytest

from pytest_girder.assertions import assertStatus, assertStatusOk

from upenncontrast_annotation.server.models.annotation import Annotation
from upenncontrast_annotation.server.models.propertyValues import (
    AnnotationPropertyValues,
)

from . import girder_utilities as utilities
from . import upenn_testing_utilities as upenn_utilities


def makeAnnotation(datasetId, coords=None, tags=None, shape="polygon",
                   location=None):
    ann = upenn_utilities.getSampleAnnotation(datasetId)
    ann["coordinates"] = coords or [
        {"x": 0, "y": 0}, {"x": 10, "y": 0},
        {"x": 10, "y": 10}, {"x": 0, "y": 10},
    ]
    ann["shape"] = shape
    if tags is not None:
        ann["tags"] = tags
    if location is not None:
        ann["location"] = location
    return Annotation().create(ann)


def parseStreaming(resp):
    return json.loads(b"".join(resp.body))


def postList(server, user, path, body):
    return server.request(
        path=path, method="POST", user=user,
        body=json.dumps(body), type="application/json", isJson=False,
    )


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestServerListIds:
    def testListIdsFilterByTagsInclusive(self, admin, server):
        folder = utilities.createFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        a = makeAnnotation(folder["_id"], tags=["A"])
        b = makeAnnotation(folder["_id"], tags=["B"])
        makeAnnotation(folder["_id"], tags=["C"])

        resp = postList(server, admin, "/upenn_annotation/list/ids", {
            "datasetId": str(folder["_id"]),
            "filters": {"tags": {"values": ["A", "B"], "exclusive": False}},
        })
        assertStatusOk(resp)
        result = parseStreaming(resp)
        assert set(result["ids"]) == {str(a["_id"]), str(b["_id"])}
        assert result["total"] == 2

    def testListIdsFilterByTagsExclusive(self, admin, server):
        folder = utilities.createFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        exact = makeAnnotation(folder["_id"], tags=["A", "B"])
        makeAnnotation(folder["_id"], tags=["A", "B", "C"])  # superset, excl
        makeAnnotation(folder["_id"], tags=["A"])             # subset, excl

        resp = postList(server, admin, "/upenn_annotation/list/ids", {
            "datasetId": str(folder["_id"]),
            "filters": {"tags": {"values": ["A", "B"], "exclusive": True}},
        })
        assertStatusOk(resp)
        result = parseStreaming(resp)
        assert result["ids"] == [str(exact["_id"])]

    def testListIdsRequiresReadAccess(self, admin, user, server):
        folder = utilities.createPrivateFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        makeAnnotation(folder["_id"])
        resp = postList(server, user, "/upenn_annotation/list/ids", {
            "datasetId": str(folder["_id"]),
            "filters": {},
        })
        assertStatus(resp, 403)


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestServerListPage:
    def testListPaginatesAndCounts(self, admin, server):
        folder = utilities.createFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        for i in range(5):
            makeAnnotation(
                folder["_id"], location={"XY": i, "Z": 0, "Time": 0}
            )

        resp = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]),
            "filters": {},
            "sort": {"type": "field", "key": "location.XY", "order": "asc"},
            "propertyPaths": [],
            "offset": 0, "limit": 2,
        })
        assertStatusOk(resp)
        result = parseStreaming(resp)
        assert result["total"] == 5
        assert len(result["rows"]) == 2
        assert result["rows"][0]["location"]["XY"] == 0
        assert result["rows"][1]["location"]["XY"] == 1
        assert "centroid" in result["rows"][0]
        assert "coordinates" not in result["rows"][0]

    def testListFieldSortDescending(self, admin, server):
        folder = utilities.createFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        for i in range(3):
            makeAnnotation(
                folder["_id"], location={"XY": i, "Z": 0, "Time": 0}
            )
        resp = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]),
            "filters": {},
            "sort": {"type": "field", "key": "location.XY", "order": "desc"},
            "propertyPaths": [], "offset": 0, "limit": 10,
        })
        result = parseStreaming(resp)
        xys = [r["location"]["XY"] for r in result["rows"]]
        assert xys == [2, 1, 0]

    def testInvalidFieldSortReturns400(self, admin, server):
        folder = utilities.createFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        makeAnnotation(folder["_id"])
        resp = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]),
            "filters": {},
            "sort": {"type": "field", "key": "evil; drop", "order": "asc"},
            "propertyPaths": [], "offset": 0, "limit": 10,
        })
        assertStatus(resp, 400)


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestServerListProperties:
    def _setup(self, admin):
        folder = utilities.createFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        pv = AnnotationPropertyValues()
        anns = []
        for val in (30, 10, 20):
            a = makeAnnotation(folder["_id"])
            pv.appendValues({"p": {"Area": val}}, a["_id"], folder["_id"])
            anns.append(a)
        noval = makeAnnotation(folder["_id"])
        return folder, anns, noval

    def testSortByPropertyAscMissingLast(self, admin, server):
        folder, anns, noval = self._setup(admin)
        resp = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]),
            "filters": {},
            "sort": {"type": "property", "key": ["p", "Area"],
                     "order": "asc"},
            "propertyPaths": [["p", "Area"]],
            "offset": 0, "limit": 10,
        })
        result = parseStreaming(resp)
        vals = [r["values"]["p"]["Area"] for r in result["rows"][:3]]
        assert vals == [10, 20, 30]
        # Annotation with no value sorts to the end regardless of
        # direction. Its projected `values` has no Area (the
        # $ifNull/$$REMOVE drops the leaf; the `p` wrapper may remain
        # as {}).
        last = result["rows"][-1]
        assert str(last["_id"]) == str(noval["_id"])
        assert "Area" not in last.get("values", {}).get("p", {})

    def testSortByPropertyDescMissingStillLast(self, admin, server):
        folder, anns, noval = self._setup(admin)
        resp = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]),
            "filters": {},
            "sort": {"type": "property", "key": ["p", "Area"],
                     "order": "desc"},
            "propertyPaths": [["p", "Area"]],
            "offset": 0, "limit": 10,
        })
        result = parseStreaming(resp)
        vals = [r["values"]["p"]["Area"] for r in result["rows"][:3]]
        assert vals == [30, 20, 10]
        assert str(result["rows"][-1]["_id"]) == str(noval["_id"])

    def testPropertyRangeFilterAffectsCountAndRows(self, admin, server):
        folder, anns, noval = self._setup(admin)
        body = {
            "datasetId": str(folder["_id"]),
            "filters": {"propertyFilters": [
                {"path": ["p", "Area"], "mode": "range",
                 "min": 15, "max": 100}
            ]},
            "sort": {"type": "property", "key": ["p", "Area"],
                     "order": "asc"},
            "propertyPaths": [["p", "Area"]], "offset": 0, "limit": 10,
        }
        resp = postList(server, admin, "/upenn_annotation/list", body)
        result = parseStreaming(resp)
        assert result["total"] == 2  # 20 and 30
        rowVals = [r["values"]["p"]["Area"] for r in result["rows"]]
        assert rowVals == [20, 30]

        resp2 = postList(server, admin, "/upenn_annotation/list/ids", {
            "datasetId": str(folder["_id"]), "filters": body["filters"],
        })
        assert parseStreaming(resp2)["total"] == 2

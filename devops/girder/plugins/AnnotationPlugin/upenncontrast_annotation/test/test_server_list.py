import json
import pytest

from bson import ObjectId
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


def assertAnchorPagesSelfConsistent(server, admin, datasetId, annotationIds,
                                    sort, limit, filters=None,
                                    propertyPaths=None):
    """For every annotation: the anchor page must be page-aligned, contain
    the anchor, and be byte-identical to the plain offset-paged request at
    the returned offset — i.e. listPosition agrees with listPage ordering."""
    base = {
        "datasetId": str(datasetId),
        "filters": filters or {},
        "sort": sort,
        "propertyPaths": propertyPaths or [],
        "limit": limit,
    }
    for annotationId in annotationIds:
        resp = postList(server, admin, "/upenn_annotation/list", {
            **base, "offset": 0, "anchorId": str(annotationId),
        })
        assertStatusOk(resp)
        anchored = parseStreaming(resp)
        assert anchored["offset"] is not None
        assert anchored["offset"] % limit == 0
        anchoredIds = [str(r["_id"]) for r in anchored["rows"]]
        assert str(annotationId) in anchoredIds
        resp = postList(server, admin, "/upenn_annotation/list", {
            **base, "offset": anchored["offset"],
        })
        assertStatusOk(resp)
        paged = [str(r["_id"]) for r in parseStreaming(resp)["rows"]]
        assert anchoredIds == paged


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

    def testListAnchorReturnsContainingPage(self, admin, server):
        folder = utilities.createFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        annotations = []
        for i in range(5):
            annotations.append(makeAnnotation(
                folder["_id"], location={"XY": i, "Z": 0, "Time": 0}
            ))

        resp = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]),
            "filters": {},
            "sort": {"type": "field", "key": "location.XY",
                     "order": "asc"},
            "propertyPaths": [], "offset": 0, "limit": 2,
            "anchorId": str(annotations[3]["_id"]),
        })
        assertStatusOk(resp)
        result = parseStreaming(resp)
        assert result["offset"] == 2
        assert [r["location"]["XY"] for r in result["rows"]] == [2, 3]

    def testListAnchorOutsideFiltersReturnsNoPage(self, admin, server):
        folder = utilities.createFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        target = makeAnnotation(folder["_id"], tags=["excluded"])
        makeAnnotation(folder["_id"], tags=["included"])

        resp = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]),
            "filters": {"tags": {
                "values": ["included"], "exclusive": False,
            }},
            "sort": None, "propertyPaths": [], "offset": 0, "limit": 10,
            "anchorId": str(target["_id"]),
        })
        assertStatusOk(resp)
        result = parseStreaming(resp)
        assert result["total"] == 1
        assert result["offset"] is None
        assert result["rows"] == []

    def testListAnchorFieldSortDescending(self, admin, server):
        folder = utilities.createFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        annotations = [
            makeAnnotation(folder["_id"], location={"XY": i, "Z": 0,
                                                    "Time": 0})
            for i in range(5)
        ]

        resp = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]),
            "filters": {},
            "sort": {"type": "field", "key": "location.XY",
                     "order": "desc"},
            "propertyPaths": [], "offset": 0, "limit": 2,
            # Descending order is 4,3,2,1,0 so XY=1 is at position 3.
            "anchorId": str(annotations[1]["_id"]),
        })
        assertStatusOk(resp)
        result = parseStreaming(resp)
        assert result["offset"] == 2
        assert [r["location"]["XY"] for r in result["rows"]] == [2, 1]

    def testListAnchorEqualSortValuesTieBrokenById(self, admin, server):
        folder = utilities.createFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        annotations = [
            makeAnnotation(folder["_id"], location={"XY": 7, "Z": 0,
                                                    "Time": 0})
            for _ in range(3)
        ]

        resp = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]),
            "filters": {},
            "sort": {"type": "field", "key": "location.XY", "order": "asc"},
            "propertyPaths": [], "offset": 0, "limit": 1,
            # All XY equal: order falls back to _id asc (creation order).
            "anchorId": str(annotations[1]["_id"]),
        })
        assertStatusOk(resp)
        result = parseStreaming(resp)
        assert result["offset"] == 1
        assert str(result["rows"][0]["_id"]) == str(annotations[1]["_id"])

    def testListAnchorNameSortWithMissingNames(self, admin, server):
        # `name` is a nullable sort field: a missing name must order
        # identically in the anchor position query and in the page sort
        # (both treat missing as null).
        folder = utilities.createFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        annotations = [makeAnnotation(folder["_id"]) for _ in range(6)]
        for unnamed in annotations[::2]:
            Annotation().collection.update_one(
                {"_id": unnamed["_id"]}, {"$unset": {"name": ""}}
            )

        for order in ("asc", "desc"):
            assertAnchorPagesSelfConsistent(
                server, admin, folder["_id"],
                [a["_id"] for a in annotations],
                {"type": "field", "key": "name", "order": order},
                limit=2,
            )

    def testListRejectsInvalidAnchorId(self, admin, server):
        folder = utilities.createFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        resp = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]),
            "filters": {}, "offset": 0, "limit": 10,
            "anchorId": "not-an-object-id",
        })
        assertStatus(resp, 400)

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

    def testInvalidFieldSortSkipsCount(self, admin, server, monkeypatch):
        # Finding #5: an invalid sort field must be rejected (400) BEFORE the
        # expensive count aggregation runs. Make listCount blow up to prove it
        # is never reached on the invalid-sort path.
        folder = utilities.createFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        makeAnnotation(folder["_id"])

        def boom(*args, **kwargs):
            raise AssertionError("listCount ran before sort validation")

        monkeypatch.setattr(Annotation, "listCount", boom)
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

    def testPropertySortAnchorReturnsContainingPage(self, admin, server):
        folder, anns, noval = self._setup(admin)
        resp = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]),
            "filters": {},
            "sort": {"type": "property", "key": ["p", "Area"],
                     "order": "asc"},
            "propertyPaths": [["p", "Area"]],
            "offset": 0, "limit": 2,
            # anns[0] has Area=30, at position 2 after 10 and 20.
            "anchorId": str(anns[0]["_id"]),
        })
        assertStatusOk(resp)
        result = parseStreaming(resp)
        assert result["offset"] == 2
        assert str(result["rows"][0]["_id"]) == str(anns[0]["_id"])
        assert str(result["rows"][1]["_id"]) == str(noval["_id"])

    def testPropertySortAnchorWithoutValueLandsOnTailPage(
            self, admin, server):
        folder, anns, noval = self._setup(admin)
        resp = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]),
            "filters": {},
            "sort": {"type": "property", "key": ["p", "Area"],
                     "order": "asc"},
            "propertyPaths": [["p", "Area"]],
            "offset": 0, "limit": 2,
            # noval has no Area value, so it sorts last: position 3.
            "anchorId": str(noval["_id"]),
        })
        assertStatusOk(resp)
        result = parseStreaming(resp)
        assert result["offset"] == 2
        assert str(result["rows"][1]["_id"]) == str(noval["_id"])

    def testPropertySortDescAnchorsSelfConsistent(self, admin, server):
        folder, anns, noval = self._setup(admin)
        assertAnchorPagesSelfConsistent(
            server, admin, folder["_id"],
            [a["_id"] for a in anns] + [noval["_id"]],
            {"type": "property", "key": ["p", "Area"], "order": "desc"},
            limit=2, propertyPaths=[["p", "Area"]],
        )

    def testPropertyFilterWithAnchor(self, admin, server):
        folder, anns, noval = self._setup(admin)
        propertyFilters = [{
            "path": ["p", "Area"], "mode": "range", "min": 15,
        }]
        resp = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]),
            "filters": {"propertyFilters": propertyFilters},
            "sort": {"type": "property", "key": ["p", "Area"],
                     "order": "asc"},
            "propertyPaths": [["p", "Area"]],
            "offset": 0, "limit": 1,
            # Filtered set is Area 20, 30 (asc): anns[0] (30) is position 1.
            "anchorId": str(anns[0]["_id"]),
        })
        assertStatusOk(resp)
        result = parseStreaming(resp)
        assert result["offset"] == 1
        assert str(result["rows"][0]["_id"]) == str(anns[0]["_id"])

    def testPureSortNoDuplicateWhenPvDocLacksSortKey(self, admin, server):
        # Regression (Codex finding #4): on a pure property sort, an annotation
        # whose PV doc EXISTS but lacks the sort key must appear exactly once,
        # in the missing-value tail. The buggy version returned it from both
        # the PV-driven first segment (_hasSortValue == 0) AND the no-value
        # tail (which matches _pv.values.<key> == None), duplicating that row
        # and omitting a different no-PV-doc annotation.
        folder = utilities.createFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        pv = AnnotationPropertyValues()
        hasArea = makeAnnotation(folder["_id"])
        pv.appendValues({"p": {"Area": 42}}, hasArea["_id"], folder["_id"])
        otherPv = makeAnnotation(folder["_id"])  # PV doc exists, no p.Area
        pv.appendValues({"q": {"Other": 7}}, otherPv["_id"], folder["_id"])
        noPv = makeAnnotation(folder["_id"])  # no PV doc at all

        resp = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]),
            "filters": {},
            "sort": {"type": "property", "key": ["p", "Area"],
                     "order": "asc"},
            "propertyPaths": [["p", "Area"]],
            "offset": 0, "limit": 10,
        })
        result = parseStreaming(resp)
        ids = [str(r["_id"]) for r in result["rows"]]
        expected = {
            str(hasArea["_id"]), str(otherPv["_id"]), str(noPv["_id"])
        }
        # Exactly three unique rows: no duplicate, no omission.
        assert len(ids) == 3
        assert set(ids) == expected
        assert result["total"] == 3
        # Present value first; the two missing-value annotations follow.
        assert ids[0] == str(hasArea["_id"])
        assert set(ids[1:]) == {str(otherPv["_id"]), str(noPv["_id"])}

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

    def testEmptyValuesFilterIsPassAll(self, admin, server):
        # A cleared values-mode filter (values: []) is a no-op: it must NOT
        # route into the PV-driven path (which drops the annotation that has no
        # value document). All 4 annotations (3 with a value + 1 without) must
        # come back, matching "no filter".
        folder, anns, noval = self._setup(admin)
        emptyFilter = {
            "datasetId": str(folder["_id"]),
            "filters": {"propertyFilters": [
                {"path": ["p", "Area"], "mode": "values", "values": []}
            ]},
            "offset": 0, "limit": 10,
        }
        resp = postList(
            server, admin, "/upenn_annotation/list", emptyFilter
        )
        result = parseStreaming(resp)
        assert result["total"] == 4
        ids = {str(r["_id"]) for r in result["rows"]}
        assert str(noval["_id"]) in ids

        # /list/ids (select-all) must see the same 4.
        resp2 = postList(server, admin, "/upenn_annotation/list/ids", {
            "datasetId": str(folder["_id"]),
            "filters": emptyFilter["filters"],
        })
        assert parseStreaming(resp2)["total"] == 4


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestServerListRefactorCharacterization:
    """Lock the exact /list behavior that the A2 (pipeline reorder) and C
    (PV-driven filter path) optimizations must preserve. These pass on the
    pre-refactor code and act as the safety net for the rewrite."""

    def testDisplayOnlyPropertyColumnWithFieldSortPaginates(
        self, admin, server
    ):
        # propertyPaths requested for DISPLAY only (field sort, no property
        # sort/filter) -> A2 defers the $lookup until after pagination. The
        # paged rows must still carry the correct per-row property value.
        folder = utilities.createFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        pv = AnnotationPropertyValues()
        for i in range(4):
            a = makeAnnotation(
                folder["_id"], location={"XY": i, "Z": 0, "Time": 0}
            )
            pv.appendValues({"p": {"Area": (i + 1) * 10}}, a["_id"],
                            folder["_id"])

        resp = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]),
            "filters": {},
            "sort": {"type": "field", "key": "location.XY", "order": "asc"},
            "propertyPaths": [["p", "Area"]],
            "offset": 2, "limit": 2,
        })
        assertStatusOk(resp)
        result = parseStreaming(resp)
        assert result["total"] == 4
        assert [r["location"]["XY"] for r in result["rows"]] == [2, 3]
        # The display value must be joined to the correct row.
        assert [r["values"]["p"]["Area"] for r in result["rows"]] == [30, 40]
        assert "centroid" in result["rows"][0]
        assert "coordinates" not in result["rows"][0]

    def _taggedWithValues(self, admin):
        folder = utilities.createFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        pv = AnnotationPropertyValues()
        a = makeAnnotation(folder["_id"], tags=["A"])
        pv.appendValues({"p": {"Area": 30}}, a["_id"], folder["_id"])
        b = makeAnnotation(folder["_id"], tags=["B"])
        pv.appendValues({"p": {"Area": 10}}, b["_id"], folder["_id"])
        c = makeAnnotation(folder["_id"], tags=["A"])
        pv.appendValues({"p": {"Area": 20}}, c["_id"], folder["_id"])
        d = makeAnnotation(folder["_id"], tags=["A"])  # tag A, no value
        return folder, a, b, c, d

    def testPropertySortCombinedWithTagFilter(self, admin, server):
        # Annotation-field filter (tags) + property sort. The PV collection
        # does not carry tags, so C must fall back to the annotation-driven
        # path. Within the tag-filtered set, missing values still sort last.
        folder, a, b, c, d = self._taggedWithValues(admin)
        resp = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]),
            "filters": {"tags": {"values": ["A"], "exclusive": False}},
            "sort": {"type": "property", "key": ["p", "Area"],
                     "order": "asc"},
            "propertyPaths": [["p", "Area"]],
            "offset": 0, "limit": 10,
        })
        assertStatusOk(resp)
        result = parseStreaming(resp)
        assert result["total"] == 3  # a, c, d (tag A); b excluded
        ids = [str(r["_id"]) for r in result["rows"]]
        assert ids == [str(c["_id"]), str(a["_id"]), str(d["_id"])]
        assert "Area" not in result["rows"][-1].get("values", {}).get("p", {})

    def testPropertyRangeFilterCombinedWithTagFilter(self, admin, server):
        # Combined annotation-field filter + property range filter.
        folder, a, b, c, d = self._taggedWithValues(admin)
        body = {
            "datasetId": str(folder["_id"]),
            "filters": {
                "tags": {"values": ["A"], "exclusive": False},
                "propertyFilters": [
                    {"path": ["p", "Area"], "mode": "range",
                     "min": 15, "max": 100}
                ],
            },
            "sort": {"type": "property", "key": ["p", "Area"],
                     "order": "asc"},
            "propertyPaths": [["p", "Area"]], "offset": 0, "limit": 10,
        }
        resp = postList(server, admin, "/upenn_annotation/list", body)
        assertStatusOk(resp)
        result = parseStreaming(resp)
        # tag A -> {a(30), c(20), d(noval)}; range [15,100] -> {c, a}
        assert result["total"] == 2
        assert [r["values"]["p"]["Area"] for r in result["rows"]] == [20, 30]

        resp2 = postList(server, admin, "/upenn_annotation/list/ids", {
            "datasetId": str(folder["_id"]), "filters": body["filters"],
        })
        assert parseStreaming(resp2)["total"] == 2

    def testPropertySortEqualValuesTieBreakByAnnotationId(
        self, admin, server
    ):
        # Equal sort values tie-break by annotation _id ascending. The
        # PV-driven path reproduces this by tie-breaking on annotationId.
        folder = utilities.createFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        pv = AnnotationPropertyValues()
        made = []
        for _ in range(3):
            a = makeAnnotation(folder["_id"])
            pv.appendValues({"p": {"Area": 42}}, a["_id"], folder["_id"])
            made.append(a)
        expected = [
            str(a["_id"]) for a in sorted(made, key=lambda x: x["_id"])
        ]
        resp = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]),
            "filters": {},
            "sort": {"type": "property", "key": ["p", "Area"],
                     "order": "asc"},
            "propertyPaths": [["p", "Area"]], "offset": 0, "limit": 10,
        })
        result = parseStreaming(resp)
        assert [str(r["_id"]) for r in result["rows"]] == expected

    def testPropertySortTotalIncludesNoValueAndDeepOffsetTail(
        self, admin, server
    ):
        # Pure property sort (no filter): the no-value annotation is part of
        # the result (sorted last) and counts toward total. A deep offset
        # must page into that no-value tail rather than dropping it.
        folder = utilities.createFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        pv = AnnotationPropertyValues()
        for val in (30, 10, 20):
            a = makeAnnotation(folder["_id"])
            pv.appendValues({"p": {"Area": val}}, a["_id"], folder["_id"])
        noval = makeAnnotation(folder["_id"])

        full = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]),
            "filters": {},
            "sort": {"type": "property", "key": ["p", "Area"],
                     "order": "asc"},
            "propertyPaths": [["p", "Area"]], "offset": 0, "limit": 10,
        })
        fullResult = parseStreaming(full)
        assert fullResult["total"] == 4
        assert len(fullResult["rows"]) == 4

        tail = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]),
            "filters": {},
            "sort": {"type": "property", "key": ["p", "Area"],
                     "order": "asc"},
            "propertyPaths": [["p", "Area"]], "offset": 3, "limit": 10,
        })
        tailResult = parseStreaming(tail)
        assert [str(r["_id"]) for r in tailResult["rows"]] == [
            str(noval["_id"])
        ]


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestPropertyValueCleanup:
    """A PV-driven count counts property-value docs directly, so they must
    not be orphaned when their annotations are deleted."""

    def testBulkDeleteRemovesPropertyValues(self, admin):
        folder = utilities.createFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        pv = AnnotationPropertyValues()
        a = makeAnnotation(folder["_id"])
        b = makeAnnotation(folder["_id"])
        pv.appendValues({"p": {"Area": 1}}, a["_id"], folder["_id"])
        pv.appendValues({"p": {"Area": 2}}, b["_id"], folder["_id"])

        Annotation().deleteMultiple([str(a["_id"]), str(b["_id"])])

        remaining = list(pv.find(
            {"annotationId": {"$in": [a["_id"], b["_id"]]}}
        ))
        assert remaining == []


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestServerListValidation:
    def _folder(self, admin):
        folder = utilities.createFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        makeAnnotation(folder["_id"])
        return folder

    def testPropertyFilterMissingPathReturns400(self, admin, server):
        folder = self._folder(admin)
        resp = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]),
            "filters": {"propertyFilters": [{"mode": "range", "min": 1}]},
            "sort": None, "propertyPaths": [], "offset": 0, "limit": 10,
        })
        assertStatus(resp, 400)

    def testPropertySortKeyNotListReturns400(self, admin, server):
        folder = self._folder(admin)
        resp = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]),
            "filters": {},
            "sort": {"type": "property", "key": "p.Area", "order": "asc"},
            "propertyPaths": [], "offset": 0, "limit": 10,
        })
        assertStatus(resp, 400)

    def testPropertyPathWithDollarReturns400(self, admin, server):
        folder = self._folder(admin)
        resp = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]),
            "filters": {}, "sort": None,
            "propertyPaths": [["$where"]], "offset": 0, "limit": 10,
        })
        assertStatus(resp, 400)

    def testListIdsBadPropertyFilterPathReturns400(self, admin, server):
        folder = self._folder(admin)
        resp = postList(server, admin, "/upenn_annotation/list/ids", {
            "datasetId": str(folder["_id"]),
            "filters": {"propertyFilters": [
                {"path": "notalist", "mode": "values", "values": [1]}
            ]},
        })
        assertStatus(resp, 400)

    def testPropertyFilterValuesNotListReturns400(self, admin, server):
        # Finding #10: a non-list `values` would become `{"$in": "x"}` and
        # raise a 500 in the aggregation; reject it at the boundary.
        folder = self._folder(admin)
        resp = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]),
            "filters": {"propertyFilters": [
                {"path": ["p", "Area"], "mode": "values",
                 "values": "notalist"}
            ]},
            "sort": None, "propertyPaths": [], "offset": 0, "limit": 10,
        })
        assertStatus(resp, 400)

    def testPropertyFilterRangeNonNumericReturns400(self, admin, server):
        # Finding #10: range bounds must be numbers.
        folder = self._folder(admin)
        resp = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]),
            "filters": {"propertyFilters": [
                {"path": ["p", "Area"], "mode": "range", "min": "x"}
            ]},
            "sort": None, "propertyPaths": [], "offset": 0, "limit": 10,
        })
        assertStatus(resp, 400)

    def testNonStringIdSubstringReturns400(self, admin, server):
        # Finding #7: a non-string idSubstring would reach the $regexMatch
        # regex unchecked and raise a 500.
        folder = self._folder(admin)
        resp = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]),
            "filters": {"idSubstring": 123},
            "sort": None, "propertyPaths": [], "offset": 0, "limit": 10,
        })
        assertStatus(resp, 400)

    def testNonStringIdSubstringReturns400OnIds(self, admin, server):
        folder = self._folder(admin)
        resp = postList(server, admin, "/upenn_annotation/list/ids", {
            "datasetId": str(folder["_id"]),
            "filters": {"idSubstring": 123},
        })
        assertStatus(resp, 400)

    def testMalformedDatasetIdReturns400OnList(self, admin, server):
        # A non-ObjectId datasetId must be a clean 400, not an uncaught
        # bson.InvalidId -> 500.
        resp = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": "not-an-object-id",
            "filters": {}, "sort": None, "propertyPaths": [],
            "offset": 0, "limit": 10,
        })
        assertStatus(resp, 400)

    def testMalformedDatasetIdReturns400OnIds(self, admin, server):
        resp = postList(server, admin, "/upenn_annotation/list/ids", {
            "datasetId": "not-an-object-id", "filters": {},
        })
        assertStatus(resp, 400)

    def testNonIntegerOffsetReturns400(self, admin, server):
        # Finding 3: int(offset) on a public endpoint must be a clean 400, not
        # an uncaught ValueError -> 500.
        folder = self._folder(admin)
        resp = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]),
            "filters": {}, "sort": None, "propertyPaths": [],
            "offset": "abc", "limit": 10,
        })
        assertStatus(resp, 400)

    def testNonIntegerLimitReturns400(self, admin, server):
        # Finding 3: int(limit) on a public endpoint must be a clean 400.
        folder = self._folder(admin)
        resp = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]),
            "filters": {}, "sort": None, "propertyPaths": [],
            "offset": 0, "limit": [1, 2],
        })
        assertStatus(resp, 400)

    def testNonDictFiltersReturns400OnList(self, admin, server):
        # Finding 4: a truthy non-dict `filters` must be a clean 400, not an
        # AttributeError (filters.get(...)) -> 500.
        folder = self._folder(admin)
        resp = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]),
            "filters": "not-a-dict", "sort": None, "propertyPaths": [],
            "offset": 0, "limit": 10,
        })
        assertStatus(resp, 400)

    def testNonDictFiltersReturns400OnIds(self, admin, server):
        # Finding 4: same guard on the /list/ids endpoint.
        folder = self._folder(admin)
        resp = postList(server, admin, "/upenn_annotation/list/ids", {
            "datasetId": str(folder["_id"]),
            "filters": [1, 2, 3],
        })
        assertStatus(resp, 400)

    def testArrayBodyReturns400OnList(self, admin, server):
        # P2: a non-object (JSON array) body would reach bodyJson.get(...) and
        # raise AttributeError -> 500. requireObjectBody makes it a clean 400.
        self._folder(admin)
        resp = postList(server, admin, "/upenn_annotation/list", [1, 2, 3])
        assertStatus(resp, 400)

    def testArrayBodyReturns400OnIds(self, admin, server):
        self._folder(admin)
        resp = postList(server, admin, "/upenn_annotation/list/ids", [1, 2, 3])
        assertStatus(resp, 400)

    def testNonDictTagsFilterReturns400(self, admin, server):
        # P2: filters.tags must be a dict. A truthy non-dict (e.g. a string)
        # would reach tags.get("values") in _buildListMatchStages and raise
        # AttributeError -> 500.
        folder = self._folder(admin)
        resp = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]),
            "filters": {"tags": "bad"},
            "sort": None, "propertyPaths": [], "offset": 0, "limit": 10,
        })
        assertStatus(resp, 400)

    def testNonListTagsValuesReturns400(self, admin, server):
        # P2: filters.tags.values must be a list (the model iterates/$in's it).
        folder = self._folder(admin)
        resp = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]),
            "filters": {"tags": {"values": "bad"}},
            "sort": None, "propertyPaths": [], "offset": 0, "limit": 10,
        })
        assertStatus(resp, 400)

    def testNonDictLocationFilterReturns400(self, admin, server):
        # P2: filters.location must be a dict. A truthy non-dict would reach
        # location.get("XY") in _buildListMatchStages -> AttributeError -> 500.
        folder = self._folder(admin)
        resp = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]),
            "filters": {"location": "bad"},
            "sort": None, "propertyPaths": [], "offset": 0, "limit": 10,
        })
        assertStatus(resp, 400)

    def testNonDictTagsFilterReturns400OnIds(self, admin, server):
        folder = self._folder(admin)
        resp = postList(server, admin, "/upenn_annotation/list/ids", {
            "datasetId": str(folder["_id"]),
            "filters": {"tags": "bad"},
        })
        assertStatus(resp, 400)

    def testOversizedLimitIsClampedNot500(self, admin, server):
        # P3: an unbounded limit lets a public caller stream arbitrarily many
        # full rows. The limit is clamped to MAX_LIST_LIMIT, so an enormous
        # request succeeds (clamped), it does not 400/500.
        folder = self._folder(admin)
        resp = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]),
            "filters": {}, "sort": None, "propertyPaths": [],
            "offset": 0, "limit": 10 ** 12,
        })
        assertStatusOk(resp)
        # Only one annotation exists; clamping the page size does not drop it.
        assert parseStreaming(resp)["total"] == 1


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestServerListIdConstraints:
    def _setup(self, admin):
        folder = utilities.createFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        a = makeAnnotation(folder["_id"], tags=["A"])
        b = makeAnnotation(folder["_id"], tags=["B"])
        c = makeAnnotation(folder["_id"], tags=["A"])
        d = makeAnnotation(folder["_id"], tags=["B"])
        return folder, a, b, c, d

    def testSingleConstraintFiltersListAndIds(self, admin, server):
        folder, a, b, c, d = self._setup(admin)
        constraint = [[str(a["_id"]), str(c["_id"])]]

        resp = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]),
            "filters": {"idConstraints": constraint},
            "sort": {"type": "field", "key": "_id", "order": "asc"},
            "propertyPaths": [], "offset": 0, "limit": 10,
        })
        assertStatusOk(resp)
        result = parseStreaming(resp)
        assert result["total"] == 2
        assert {str(r["_id"]) for r in result["rows"]} == {
            str(a["_id"]), str(c["_id"])
        }

        resp2 = postList(server, admin, "/upenn_annotation/list/ids", {
            "datasetId": str(folder["_id"]),
            "filters": {"idConstraints": constraint},
        })
        assertStatusOk(resp2)
        idsResult = parseStreaming(resp2)
        assert idsResult["total"] == 2
        assert set(idsResult["ids"]) == {str(a["_id"]), str(c["_id"])}

    def testTwoConstraintsIntersect(self, admin, server):
        folder, a, b, c, d = self._setup(admin)
        constraints = [
            [str(a["_id"]), str(b["_id"]), str(c["_id"])],
            [str(b["_id"]), str(c["_id"]), str(d["_id"])],
        ]
        resp = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]),
            "filters": {"idConstraints": constraints},
            "sort": None, "propertyPaths": [], "offset": 0, "limit": 10,
        })
        assertStatusOk(resp)
        result = parseStreaming(resp)
        assert result["total"] == 2
        assert {str(r["_id"]) for r in result["rows"]} == {
            str(b["_id"]), str(c["_id"])
        }

    def testIdConstraintsAndedWithTagFilter(self, admin, server):
        folder, a, b, c, d = self._setup(admin)
        # idConstraints picks {a, b}; tag filter "A" picks {a, c}.
        # The AND of the two narrows to {a}.
        resp = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]),
            "filters": {
                "idConstraints": [[str(a["_id"]), str(b["_id"])]],
                "tags": {"values": ["A"], "exclusive": False},
            },
            "sort": None, "propertyPaths": [], "offset": 0, "limit": 10,
        })
        assertStatusOk(resp)
        result = parseStreaming(resp)
        assert result["total"] == 1
        assert str(result["rows"][0]["_id"]) == str(a["_id"])

    def testMalformedIdConstraintsReturns400(self, admin, server):
        folder, a, b, c, d = self._setup(admin)
        resp = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]),
            "filters": {"idConstraints": ["notalist"]},
            "sort": None, "propertyPaths": [], "offset": 0, "limit": 10,
        })
        assertStatus(resp, 400)

    def testNonStringIdConstraintsReturns400(self, admin, server):
        folder, a, b, c, d = self._setup(admin)
        resp = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]),
            "filters": {"idConstraints": [[123]]},
            "sort": None, "propertyPaths": [], "offset": 0, "limit": 10,
        })
        assertStatus(resp, 400)

    def testInvalidObjectIdInConstraintsReturns400(self, admin, server):
        # Finding #2: well-formed shape (list of lists of strings) but the
        # string is not a valid ObjectId. The model's ObjectId() conversion
        # would raise bson.InvalidId -> uncaught 500 on this public endpoint.
        # It must be rejected at the API boundary as 400.
        folder, a, b, c, d = self._setup(admin)
        resp = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]),
            "filters": {"idConstraints": [["notanobjectid"]]},
            "sort": None, "propertyPaths": [], "offset": 0, "limit": 10,
        })
        assertStatus(resp, 400)

    def testInvalidObjectIdInConstraintsReturns400OnIds(self, admin, server):
        folder, a, b, c, d = self._setup(admin)
        resp = postList(server, admin, "/upenn_annotation/list/ids", {
            "datasetId": str(folder["_id"]),
            "filters": {"idConstraints": [["notanobjectid"]]},
        })
        assertStatus(resp, 400)

    def testEmptyInnerIdConstraintReturns400(self, admin, server):
        # Finding 17: an empty inner constraint [[]] passes the vacuous `all`
        # check and becomes {"_id": {"$in": []}} (an unconditional match-none).
        # That silent "returns nothing" is ambiguous; reject at the boundary.
        folder, a, b, c, d = self._setup(admin)
        resp = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]),
            "filters": {"idConstraints": [[]]},
            "sort": None, "propertyPaths": [], "offset": 0, "limit": 10,
        })
        assertStatus(resp, 400)


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestServerListIdSubstring:
    def testIdSubstringMatchesById(self, admin, server):
        folder = utilities.createFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        a = makeAnnotation(folder["_id"])
        makeAnnotation(folder["_id"])
        resp = postList(server, admin, "/upenn_annotation/list/ids", {
            "datasetId": str(folder["_id"]),
            "filters": {"idSubstring": str(a["_id"])},
        })
        assertStatusOk(resp)
        assert parseStreaming(resp)["ids"] == [str(a["_id"])]

    def testIdSubstringIsEscapedNotRegex(self, admin, server):
        # Finding #7/#11: idSubstring is a literal substring match (matching
        # the client's String.includes), so regex metacharacters are escaped.
        # "." is regex "any char"; hex object ids contain no literal dot, so
        # an escaped "." matches nothing (an unescaped regex would match all).
        folder = utilities.createFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        makeAnnotation(folder["_id"])
        makeAnnotation(folder["_id"])
        resp = postList(server, admin, "/upenn_annotation/list/ids", {
            "datasetId": str(folder["_id"]),
            "filters": {"idSubstring": "."},
        })
        assertStatusOk(resp)
        assert parseStreaming(resp)["ids"] == []


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestServerListCountConsistency:
    """The page `total` must equal the number of rows actually returnable."""

    def testPropertyFilterCountExcludesOrphanValueDocs(self, admin, server):
        # Finding 7: on the PV-driven property-filter path, listCount counts
        # matching property-value docs directly, but listPage joins each back
        # its annotation with a non-preserving $unwind (dropping value docs
        # whose annotation no longer exists). An orphan value doc therefore
        # inflates `total` above the number of returnable rows.
        folder = utilities.createFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        pv = AnnotationPropertyValues()

        real = makeAnnotation(folder["_id"])
        pv.appendValues({"p": {"Area": 42}}, real["_id"], folder["_id"])
        # Orphan value doc: annotationId points at a non-existent annotation.
        pv.appendValues({"p": {"Area": 99}}, ObjectId(), folder["_id"])

        resp = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]),
            "filters": {"propertyFilters": [
                {"path": ["p", "Area"], "mode": "range", "min": 0}
            ]},
            "sort": None, "propertyPaths": [["p", "Area"]],
            "offset": 0, "limit": 10,
        })
        assertStatusOk(resp)
        result = parseStreaming(resp)
        assert result["total"] == len(result["rows"])
        assert result["total"] == 1


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestServerListAnalysisGates:
    """Gate definitions as first-class list filter terms (SERVER_GATING.md,
    Phase 3): the client sends polygons, the server resolves them once per
    request as pure predicates and ANDs them into the query — no gate id
    lists round-trip on page fetches."""

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

    @staticmethod
    def gateFilter(low, high):
        return {
            "xAxis": {"type": "property", "path": ["p", "Area"]},
            "yAxis": {"type": "property", "path": ["p", "Area"]},
            "gate": {
                "categoryKeyVersion": 1,
                "vertices": [
                    {"x": low, "y": low}, {"x": high, "y": low},
                    {"x": high, "y": high}, {"x": low, "y": high},
                ],
                "xCategories": None,
                "yCategories": None,
            },
        }

    def testGateNarrowsListIds(self, admin, server):
        folder, anns, _ = self._setup(admin)
        resp = postList(server, admin, "/upenn_annotation/list/ids", {
            "datasetId": str(folder["_id"]),
            "filters": {"analysisGates": [self.gateFilter(5, 25)]},
        })
        assertStatusOk(resp)
        result = parseStreaming(resp)
        # Area 10 and 20 fall inside [5,25]²; 30 and the no-values
        # annotation do not.
        assert result["total"] == 2
        assert sorted(result["ids"]) == sorted(
            [str(anns[1]["_id"]), str(anns[2]["_id"])]
        )

    def testGateComposesWithPropertyFilter(self, admin, server):
        folder, anns, _ = self._setup(admin)
        resp = postList(server, admin, "/upenn_annotation/list/ids", {
            "datasetId": str(folder["_id"]),
            "filters": {
                "analysisGates": [self.gateFilter(5, 25)],
                "propertyFilters": [
                    {"path": ["p", "Area"], "mode": "range",
                     "min": 15, "max": 100},
                ],
            },
        })
        assertStatusOk(resp)
        assert parseStreaming(resp)["ids"] == [str(anns[2]["_id"])]

    def testZeroMatchGateIsZeroRowsNot400(self, admin, server):
        folder, _, _ = self._setup(admin)
        resp = postList(server, admin, "/upenn_annotation/list/ids", {
            "datasetId": str(folder["_id"]),
            "filters": {"analysisGates": [self.gateFilter(1000, 1001)]},
        })
        assertStatusOk(resp)
        assert parseStreaming(resp)["total"] == 0

    def testGateAppliesToPageAndCount(self, admin, server):
        folder, anns, _ = self._setup(admin)
        resp = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]),
            "filters": {"analysisGates": [self.gateFilter(5, 25)]},
            "sort": {"type": "property", "key": ["p", "Area"],
                     "order": "asc"},
            "propertyPaths": [["p", "Area"]],
            "offset": 0,
            "limit": 10,
        })
        assertStatusOk(resp)
        result = parseStreaming(resp)
        assert result["total"] == 2
        assert [r["values"]["p"]["Area"] for r in result["rows"]] == [10, 20]

    def testTwoGatesAnd(self, admin, server):
        folder, anns, _ = self._setup(admin)
        resp = postList(server, admin, "/upenn_annotation/list/ids", {
            "datasetId": str(folder["_id"]),
            "filters": {"analysisGates": [
                self.gateFilter(5, 25),   # keeps 10, 20
                self.gateFilter(15, 25),  # keeps 20
            ]},
        })
        assertStatusOk(resp)
        assert parseStreaming(resp)["ids"] == [str(anns[2]["_id"])]

    def testMalformedGateIs400(self, admin, server):
        folder, _, _ = self._setup(admin)
        bad = self.gateFilter(0, 1)
        bad["xAxis"] = {"type": "nope"}
        resp = postList(server, admin, "/upenn_annotation/list/ids", {
            "datasetId": str(folder["_id"]),
            "filters": {"analysisGates": [bad]},
        })
        assertStatus(resp, 400)

    def testNonListAnalysisGatesIs400(self, admin, server):
        folder, _, _ = self._setup(admin)
        resp = postList(server, admin, "/upenn_annotation/list/ids", {
            "datasetId": str(folder["_id"]),
            "filters": {"analysisGates": {"gate": None}},
        })
        assertStatus(resp, 400)

    def testMajorityGateUsesComplementNotAGiantIn(self, admin, server):
        """A gate matching most of the dataset must not materialize every
        match into one `$in`: near a million objects that array alone
        approaches MongoDB's 16 MB command limit. Excluding the complement is
        equivalent inside a dataset-scoped pipeline and is strictly smaller.
        """
        from upenncontrast_annotation.server.models.annotation import (
            Annotation as AnnotationModel,
        )
        folder, anns, noval = self._setup(admin)
        # Areas 30/10/20 plus one annotation without values. A gate over
        # [5, 100] keeps 3 of 4 — a majority, so the complement is smaller.
        filters = {"analysisGates": [self.gateFilter(5, 100)]}
        AnnotationModel().resolveListGateConstraints(folder["_id"], filters)
        clauses = filters.get("gateMatchClauses") or []
        assert len(clauses) == 1
        assert "$nin" in clauses[0]["_id"], clauses
        # The complement is the one annotation with no values.
        assert clauses[0]["_id"]["$nin"] == [noval["_id"]]
        assert not filters.get("idConstraints")

    def testMinorityGateStillUsesIn(self, admin, server):
        from upenncontrast_annotation.server.models.annotation import (
            Annotation as AnnotationModel,
        )
        folder, anns, _ = self._setup(admin)
        filters = {"analysisGates": [self.gateFilter(5, 15)]}  # keeps Area 10
        AnnotationModel().resolveListGateConstraints(folder["_id"], filters)
        clauses = filters.get("gateMatchClauses") or []
        assert len(clauses) == 1
        assert clauses[0]["_id"]["$in"] == [anns[1]["_id"]]

    def testComplementAndInAgreeThroughTheEndpoint(self, admin, server):
        """Whichever representation is chosen, the answer is the same."""
        folder, anns, _ = self._setup(admin)
        for low, high, expected in ((5, 100, 3), (5, 15, 1)):
            resp = postList(server, admin, "/upenn_annotation/list/ids", {
                "datasetId": str(folder["_id"]),
                "filters": {"analysisGates": [self.gateFilter(low, high)]},
            })
            assertStatusOk(resp)
            assert parseStreaming(resp)["total"] == expected, (low, high)

    def testOversizedGateConstraintIs400NotAMongoFailure(
        self, admin, server, monkeypatch
    ):
        """Past the budget the request must fail with a comprehensible 400
        rather than an opaque BSON-limit error from MongoDB."""
        from upenncontrast_annotation.server.models import annotation as mod
        folder, _, _ = self._setup(admin)
        monkeypatch.setattr(mod, "MAX_GATE_CONSTRAINT_IDS", 1)
        resp = postList(server, admin, "/upenn_annotation/list/ids", {
            "datasetId": str(folder["_id"]),
            "filters": {"analysisGates": [self.gateFilter(5, 25)]},
        })
        assertStatus(resp, 400)

    def testMarginalMajorityStaysWithIn(self, admin, server):
        """`$nin` costs ~1.4x per element, so a barely-smaller complement is
        a loss, not a win. Only switch when it at least halves the payload —
        measured crossover is near 0.67 (see resolveListGateConstraints).
        """
        from upenncontrast_annotation.server.models.annotation import (
            Annotation as AnnotationModel,
        )
        folder = utilities.createFolder(
            admin, "marginal", upenn_utilities.datasetMetadata
        )
        pv = AnnotationPropertyValues()
        # 3 inside the gate, 2 outside: a majority, but the complement is
        # 0.67 of the matches — not worth the per-element penalty.
        for val in (10, 10, 10, 90, 90):
            a = makeAnnotation(folder["_id"])
            pv.appendValues({"p": {"Area": val}}, a["_id"], folder["_id"])
        filters = {"analysisGates": [self.gateFilter(5, 25)]}
        AnnotationModel().resolveListGateConstraints(folder["_id"], filters)
        clause = filters["gateMatchClauses"][0]["_id"]
        assert "$in" in clause, clause
        assert len(clause["$in"]) == 3

    def testBudgetIsCheckedBeforeRetainingClauses(self, admin, server):
        """Codex round 2: the budget must be enforced as ids accumulate, not
        after. Checking at the end still materialized every gate's ObjectIds
        first — 20 gates x ~350K on a 700K dataset is ~7M ObjectIds held
        before the 400 is finally returned, i.e. the guard against a memory
        blowup could itself blow memory."""
        from upenncontrast_annotation.server.models import annotation as mod
        folder, _, _ = self._setup(admin)
        seen = []
        realResolve = mod.analysis.resolve_gate_ids

        def counting(docs, valuesById, gate):
            ids = realResolve(docs, valuesById, gate)
            seen.append(len(ids))
            return ids

        mod.analysis.resolve_gate_ids = counting
        mod_max = mod.MAX_GATE_CONSTRAINT_IDS
        mod.MAX_GATE_CONSTRAINT_IDS = 2
        try:
            filters = {"analysisGates": [self.gateFilter(5, 100)] * 5}
            with pytest.raises(ValueError):
                mod.Annotation().resolveListGateConstraints(
                    folder["_id"], filters
                )
            # Must stop at the gate that crosses the budget, not resolve all
            # five and check afterwards.
            assert len(seen) < 5, seen
            # And nothing oversized may be left retained on the filters.
            retained = sum(
                len(list(c["_id"].values())[0])
                for c in filters.get("gateMatchClauses", [])
            )
            assert retained <= 2, retained
        finally:
            mod.analysis.resolve_gate_ids = realResolve
            mod.MAX_GATE_CONSTRAINT_IDS = mod_max

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

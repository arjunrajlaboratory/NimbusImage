import json
import math

import pytest

from pytest_girder.assertions import assertStatus, assertStatusOk

from upenncontrast_annotation.server.models import (
    annotation as annotationModule,
)
from upenncontrast_annotation.server.models.annotation import Annotation
from upenncontrast_annotation.server.models.propertyValues import (
    AnnotationPropertyValues,
)

from . import girder_utilities as utilities
from . import upenn_testing_utilities as upenn_utilities


def makeAnnotation(datasetId, tags):
    ann = upenn_utilities.getSampleAnnotation(datasetId)
    ann["shape"] = "polygon"
    ann["tags"] = tags
    return Annotation().create(ann)


def postSummary(server, user, body):
    return server.request(
        path="/upenn_annotation/summary", method="POST", user=user,
        body=json.dumps(body), type="application/json",
    )


def statsByPath(result):
    return {".".join(entry["path"]): entry for entry in result["properties"]}


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestAnnotationSummary:
    def _setup(self, admin):
        """Four cells: Area 5 / 15 / "bad" / no value; tags A, A+B, C, A."""
        folder = utilities.createFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        pv = AnnotationPropertyValues()
        a = makeAnnotation(folder["_id"], ["A"])
        pv.appendValues({"p": {"Area": 5, "Mean": 1}}, a["_id"], folder["_id"])
        b = makeAnnotation(folder["_id"], ["A", "B"])
        pv.appendValues({"p": {"Area": 15}}, b["_id"], folder["_id"])
        c = makeAnnotation(folder["_id"], ["C"])
        pv.appendValues({"p": {"Area": "bad"}}, c["_id"], folder["_id"])
        makeAnnotation(folder["_id"], ["A"])
        return folder

    def testTotalAndTagComposition(self, admin, server):
        folder = self._setup(admin)
        resp = postSummary(server, admin, {
            "datasetId": str(folder["_id"]), "filters": {},
        })
        assertStatusOk(resp)
        assert resp.json["total"] == 4
        # Sorted by count descending, then tag name.
        assert resp.json["tags"] == [
            {"tag": "A", "count": 3},
            {"tag": "B", "count": 1},
            {"tag": "C", "count": 1},
        ]
        assert resp.json["properties"] == []

    def testPropertyStatsSkipNonNumericAndMissing(self, admin, server):
        folder = self._setup(admin)
        resp = postSummary(server, admin, {
            "datasetId": str(folder["_id"]),
            "filters": {},
            "propertyPaths": [["p", "Area"], ["p", "Mean"], ["p", "Nope"]],
        })
        assertStatusOk(resp)
        stats = statsByPath(resp.json)
        area = stats["p.Area"]
        assert area["count"] == 2
        assert area["mean"] == 10
        assert area["min"] == 5
        assert area["max"] == 15
        assert math.isclose(area["std"], math.sqrt(50))
        mean = stats["p.Mean"]
        assert mean["count"] == 1
        assert mean["mean"] == 1
        # A single value has no sample standard deviation.
        assert mean["std"] is None
        nope = stats["p.Nope"]
        assert nope["count"] == 0
        assert nope["mean"] is None
        assert nope["min"] is None

    def testStatsFollowAnnotationFieldFilters(self, admin, server):
        folder = self._setup(admin)
        resp = postSummary(server, admin, {
            "datasetId": str(folder["_id"]),
            "filters": {"tags": {"values": ["B"], "exclusive": False}},
            "propertyPaths": [["p", "Area"]],
        })
        assertStatusOk(resp)
        assert resp.json["total"] == 1
        assert resp.json["tags"] == [
            {"tag": "A", "count": 1}, {"tag": "B", "count": 1},
        ]
        area = statsByPath(resp.json)["p.Area"]
        assert area == {
            "path": ["p", "Area"], "count": 1,
            "mean": 15, "std": None, "min": 15, "max": 15,
        }

    def testStatsFollowPropertyFilters(self, admin, server):
        folder = self._setup(admin)
        resp = postSummary(server, admin, {
            "datasetId": str(folder["_id"]),
            "filters": {"propertyFilters": [
                {"path": ["p", "Area"], "mode": "range", "max": 10},
            ]},
            "propertyPaths": [["p", "Area"]],
        })
        assertStatusOk(resp)
        assert resp.json["total"] == 1
        assert resp.json["tags"] == [{"tag": "A", "count": 1}]
        assert statsByPath(resp.json)["p.Area"]["mean"] == 5

    def testStatsFollowMixedFieldAndPropertyFilters(self, admin, server):
        """Tags + property range takes the annotation-driven join path; the
        orphan-free PV scan cannot apply once a tag narrows the population."""
        folder = self._setup(admin)
        resp = postSummary(server, admin, {
            "datasetId": str(folder["_id"]),
            "filters": {
                "tags": {"values": ["A"], "exclusive": False},
                "propertyFilters": [
                    {"path": ["p", "Area"], "mode": "range", "min": 10},
                ],
            },
            "propertyPaths": [["p", "Area"]],
        })
        assertStatusOk(resp)
        assert resp.json["total"] == 1
        assert resp.json["tags"] == [
            {"tag": "A", "count": 1}, {"tag": "B", "count": 1},
        ]
        assert statsByPath(resp.json)["p.Area"]["mean"] == 15

    def testNaNIsMissingButInfinityIsAValue(self, admin, server):
        """The user's rule: NaN counts as no value, Infinity is a number."""
        folder = utilities.createFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        pv = AnnotationPropertyValues()
        for area in (5, float("nan"), 15):
            a = makeAnnotation(folder["_id"], ["A"])
            pv.appendValues(
                {"p": {"Area": area}}, a["_id"], folder["_id"]
            )
        resp = postSummary(server, admin, {
            "datasetId": str(folder["_id"]),
            "propertyPaths": [["p", "Area"]],
        })
        assertStatusOk(resp)
        area = statsByPath(resp.json)["p.Area"]
        assert area["count"] == 2
        assert area["mean"] == 10
        # Infinity survives the aggregation (serialization of the response
        # is the client's concern; JSON ingestion cannot produce it).
        inf = makeAnnotation(folder["_id"], ["A"])
        pv.appendValues(
            {"p": {"Area": float("inf")}}, inf["_id"], folder["_id"]
        )
        stats = Annotation().summarize(
            folder["_id"], {}, [["p", "Area"]]
        )["properties"][0]
        assert stats["count"] == 3
        assert stats["max"] == float("inf")

    def testMajorityMatchUsesComplementAndStaysCorrect(self, admin, server):
        """A filter keeping most of the dataset is expressed as $nin of the
        complement (2x rule); the answer must not depend on which side."""
        folder = self._setup(admin)
        # Area >= 0 keeps the two numeric cells of four -> $in side.
        # Tag A keeps three of four -> complement (1) * 2 <= 3 -> $nin side.
        model = Annotation()
        matching = model._matchingObjectIds(
            folder["_id"], {"tags": {"values": ["A"], "exclusive": False}}
        )
        selector = model._idSelector(folder["_id"], matching)
        assert list(selector) == ["$nin"]
        assert len(selector["$nin"]) == 1
        resp = postSummary(server, admin, {
            "datasetId": str(folder["_id"]),
            "filters": {
                "tags": {"values": ["A"], "exclusive": False},
                "propertyFilters": [
                    {"path": ["p", "Area"], "mode": "range", "min": 0},
                ],
            },
            "propertyPaths": [["p", "Area"]],
        })
        assertStatusOk(resp)
        assert resp.json["total"] == 2
        assert statsByPath(resp.json)["p.Area"]["mean"] == 10
        # Everything matches -> no clause at all.
        assert model._idSelector(
            folder["_id"], model._matchingObjectIds(folder["_id"], {})
        ) is None

    def testOverBudgetIdClauseIs400(self, admin, server, monkeypatch):
        folder = self._setup(admin)
        monkeypatch.setattr(
            annotationModule, "MAX_SUMMARY_CONSTRAINT_IDS", 1
        )
        resp = postSummary(server, admin, {
            "datasetId": str(folder["_id"]),
            "filters": {"propertyFilters": [
                {"path": ["p", "Area"], "mode": "range", "min": 0},
            ]},
        })
        assertStatus(resp, 400)
        assert "narrow the filters" in resp.json["message"]

    def testEmptyMatchIsZeroNotError(self, admin, server):
        folder = self._setup(admin)
        resp = postSummary(server, admin, {
            "datasetId": str(folder["_id"]),
            "filters": {"tags": {"values": ["nope"], "exclusive": False}},
            "propertyPaths": [["p", "Area"]],
        })
        assertStatusOk(resp)
        assert resp.json["total"] == 0
        assert resp.json["tags"] == []
        assert statsByPath(resp.json)["p.Area"] == {
            "path": ["p", "Area"], "count": 0,
            "mean": None, "std": None, "min": None, "max": None,
        }

    def testRequiresReadAccess(self, admin, user, server):
        folder = utilities.createPrivateFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        makeAnnotation(folder["_id"], ["A"])
        resp = postSummary(server, user, {
            "datasetId": str(folder["_id"]), "filters": {},
        })
        assertStatus(resp, 403)

    def testRejectsMalformedInput(self, admin, server):
        folder = self._setup(admin)
        resp = postSummary(server, admin, {
            "datasetId": str(folder["_id"]),
            "propertyPaths": [["p", "$where"]],
        })
        assertStatus(resp, 400)
        resp = postSummary(server, admin, {
            "datasetId": str(folder["_id"]), "filters": "tags",
        })
        assertStatus(resp, 400)
        resp = postSummary(server, admin, {
            "datasetId": str(folder["_id"]),
            "propertyPaths": [["p", "Area"]] * 201,
        })
        assertStatus(resp, 400)

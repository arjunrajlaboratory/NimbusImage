"""Server-side analysis gating (SERVER_GATING.md).

The pure gating maths in ``server/helpers/analysis.py`` is the Python half of
a two-implementation feature: the TypeScript client resolves gates below the
plot cap, this module resolves them above it, and a dataset that grows past
the cap must not change gate membership by switching resolvers. Parity is
pinned by ``fixtures/analysis_gating_parity.json``, GENERATED from the
TypeScript reference implementation (see analysisGatingParity.test.ts) — if a
test here disagrees with the fixture, fix this module, not the fixture.
"""

import json
import math
import os

import numpy as np
import pytest

from bson import ObjectId
from pytest_girder.assertions import assertStatus, assertStatusOk

from upenncontrast_annotation.server.helpers import analysis
from upenncontrast_annotation.server.models.annotation import Annotation
from upenncontrast_annotation.server.models.propertyValues import (
    AnnotationPropertyValues,
)

from . import girder_utilities as utilities
from . import upenn_testing_utilities as upenn_utilities


FIXTURE_PATH = os.path.join(
    os.path.dirname(__file__), "fixtures", "analysis_gating_parity.json"
)


def loadFixture():
    with open(FIXTURE_PATH) as fixtureFile:
        return json.load(fixtureFile)


def fixtureDocs(case):
    # Fixture annotations already have the doc shape the helpers consume:
    # id, tags, shape, channel, location.
    return case["annotations"]


class TestJitterParity:
    def testScalarJitterMatchesFixtureBitExactly(self):
        for case in loadFixture()["jitterCases"]:
            actual = analysis.jitter_from_id(case["id"], case["salt"])
            assert actual == case["expected"], (
                f"jitter({case['id']!r}, {case['salt']}) = {actual!r}, "
                f"TS reference says {case['expected']!r}"
            )

    def testVectorizedJitterMatchesScalar(self):
        cases = loadFixture()["jitterCases"]
        for salt in (analysis.X_JITTER_SALT, analysis.Y_JITTER_SALT):
            ids = [case["id"] for case in cases]
            vectorized = analysis.jitter_from_ids(ids, salt)
            for annotationId, value in zip(ids, vectorized):
                assert value == analysis.jitter_from_id(annotationId, salt)

    def testEmptyIdListYieldsEmptyArray(self):
        assert analysis.jitter_from_ids([], 17).shape == (0,)

    def testJitterIsBounded(self):
        for case in loadFixture()["jitterCases"]:
            assert abs(case["expected"]) < 0.29


class TestEncodeCategoryKey:
    def testMatchesJavascriptJsonStringify(self):
        assert analysis.encode_category_key(["A", "B"]) == 'v1:["A","B"]'
        assert analysis.encode_category_key([]) == "v1:[]"
        assert analysis.encode_category_key("polygon") == 'v1:"polygon"'
        assert analysis.encode_category_key(3) == "v1:3"

    def testDoesNotEscapeNonAscii(self):
        # JSON.stringify emits astral characters raw; json.dumps must not
        # \u-escape them or the keys stop matching the client's.
        assert analysis.encode_category_key(["💥boom"]) == 'v1:["💥boom"]'

    def testTagSortUsesUtf16CodeUnits(self):
        # JS Array.sort compares UTF-16 code units: an astral character
        # (surrogate pair, first unit 0xD83D) sorts BELOW U+FFFD. Python's
        # code-point comparison would order these the other way around.
        tags = ["�", "💥"]
        assert analysis.sort_tags(tags) == ["💥", "�"]

    def testTagSortMatchesPlainSortForBmpStrings(self):
        tags = ["beta", "alpha", "Alpha", "0"]
        assert analysis.sort_tags(tags) == sorted(tags)


class TestPointsInPolygon:
    SQUARE = [
        {"x": 0, "y": 0},
        {"x": 10, "y": 0},
        {"x": 10, "y": 10},
        {"x": 0, "y": 10},
    ]

    def testInsideAndOutside(self):
        xs = np.array([5.0, 50.0, -1.0])
        ys = np.array([5.0, 5.0, 5.0])
        assert analysis.points_in_polygon(xs, ys, self.SQUARE).tolist() == [
            True,
            False,
            False,
        ]

    def testConcavePolygonUsesContainmentNotBoundingBox(self):
        vShape = [
            {"x": 0, "y": 0},
            {"x": 10, "y": 0},
            {"x": 10, "y": 10},
            {"x": 5, "y": 2},
            {"x": 0, "y": 10},
        ]
        xs = np.array([1.0, 5.0, 9.0])
        ys = np.array([8.0, 8.0, 8.0])
        assert analysis.points_in_polygon(xs, ys, vShape).tolist() == [
            True,
            False,
            True,
        ]

    def testDegeneratePolygonMatchesNothing(self):
        xs = np.array([5.0])
        ys = np.array([5.0])
        assert analysis.points_in_polygon(
            xs, ys, self.SQUARE[:2]
        ).tolist() == [False]

    def testNanCoordinatesNeverMatch(self):
        xs = np.array([np.nan, 5.0])
        ys = np.array([5.0, np.nan])
        assert analysis.points_in_polygon(xs, ys, self.SQUARE).tolist() == [
            False,
            False,
        ]

    def testEmptyInput(self):
        empty = np.empty(0)
        assert analysis.points_in_polygon(empty, empty, self.SQUARE).shape == (
            0,
        )


class TestAxisCoordinates:
    DOCS = [
        {
            "id": "0123456789abcdef01234567",
            "tags": ["A"],
            "shape": "point",
            "channel": 2,
            "location": {"XY": 0, "Z": 4, "Time": 1},
        }
    ]

    def testNestedPropertyPath(self):
        values = {
            "0123456789abcdef01234567": {"p": {"Centroid": {"x": 7.5}}}
        }
        coords = analysis.axis_coordinates(
            self.DOCS,
            values,
            {"type": "property", "path": ["p", "Centroid", "x"]},
            None,
            analysis.X_JITTER_SALT,
        )
        assert coords.tolist() == [7.5]

    @pytest.mark.parametrize(
        "value", [None, "5", True, False, float("nan"), float("inf"), [5]]
    )
    def testNonNumericPropertyValuesAreMissing(self, value):
        values = {"0123456789abcdef01234567": {"p": {"Area": value}}}
        coords = analysis.axis_coordinates(
            self.DOCS,
            values,
            {"type": "property", "path": ["p", "Area"]},
            None,
            analysis.X_JITTER_SALT,
        )
        assert math.isnan(coords[0])

    def testMissingValueDocIsMissing(self):
        coords = analysis.axis_coordinates(
            self.DOCS,
            {},
            {"type": "property", "path": ["p", "Area"]},
            None,
            analysis.X_JITTER_SALT,
        )
        assert math.isnan(coords[0])

    def testCategoricalCoordinateIsIndexPlusJitter(self):
        pinned = [
            analysis.encode_category_key(["Z-other"]),
            analysis.encode_category_key(["A"]),
        ]
        coords = analysis.axis_coordinates(
            self.DOCS,
            {},
            {"type": "categorical", "key": "tags"},
            pinned,
            analysis.X_JITTER_SALT,
        )
        expected = 1 + analysis.jitter_from_id(
            "0123456789abcdef01234567", analysis.X_JITTER_SALT
        )
        assert coords.tolist() == [expected]

    def testUnknownCategoryIsMissing(self):
        pinned = [analysis.encode_category_key(["something-else"])]
        coords = analysis.axis_coordinates(
            self.DOCS,
            {},
            {"type": "categorical", "key": "tags"},
            pinned,
            analysis.X_JITTER_SALT,
        )
        assert math.isnan(coords[0])

    @pytest.mark.parametrize(
        ("key", "expectedRaw"),
        [
            ("tags", ["A"]),
            ("shape", "point"),
            ("channel", 2),
            ("xy", 0),
            ("z", 4),
            ("time", 1),
        ],
    )
    def testEveryCategoricalKeyReadsItsField(self, key, expectedRaw):
        pinned = [analysis.encode_category_key(expectedRaw)]
        coords = analysis.axis_coordinates(
            self.DOCS,
            {},
            {"type": "categorical", "key": key},
            pinned,
            analysis.Y_JITTER_SALT,
        )
        assert not math.isnan(coords[0])


class TestGateResolutionParity:
    def testEveryFixtureCaseResolvesIdentically(self):
        fixture = loadFixture()
        assert len(fixture["gateCases"]) >= 7
        for case in fixture["gateCases"]:
            docs = fixtureDocs(case)
            for plotIndex, plot in enumerate(case["plots"]):
                resolved = analysis.resolve_gate_ids(
                    docs, case["values"], plot
                )
                assert resolved == case["expected"][plotIndex], (
                    f"{case['name']} plot {plotIndex}: {resolved} != "
                    f"{case['expected'][plotIndex]}"
                )


# --- Endpoint: POST /upenn_annotation/analysis/gate_ids ---


def postJson(server, user, path, body):
    return server.request(
        path=path, method="POST", user=user,
        body=json.dumps(body), type="application/json",
    )


def makeAnnotation(datasetId, tags=None, channel=0, location=None):
    ann = upenn_utilities.getSampleAnnotation(datasetId)
    if tags is not None:
        ann["tags"] = tags
    ann["channel"] = channel
    if location is not None:
        ann["location"] = location
    return Annotation().create(ann)


def propertyPlot(plotId, vertices):
    return {
        "id": plotId,
        "xAxis": {"type": "property", "path": ["p", "Area"]},
        "yAxis": {"type": "property", "path": ["p", "Mean"]},
        "gate": {
            "categoryKeyVersion": 1,
            "vertices": vertices,
            "xCategories": None,
            "yCategories": None,
        },
    }


BOX_0_10 = [
    {"x": 0, "y": 0}, {"x": 10, "y": 0},
    {"x": 10, "y": 10}, {"x": 0, "y": 10},
]


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestAnalysisGateIdsEndpoint:
    def _setup(self, admin):
        folder = utilities.createFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        pv = AnnotationPropertyValues()
        anns = []
        for area, mean, tags in (
            (5, 5, ["in"]),
            (50, 5, ["out"]),
            (5, 50, ["in"]),
        ):
            a = makeAnnotation(folder["_id"], tags=tags)
            pv.appendValues(
                {"p": {"Area": area, "Mean": mean}}, a["_id"], folder["_id"]
            )
            anns.append(a)
        noValues = makeAnnotation(folder["_id"], tags=["in"])
        return folder, anns, noValues

    def testPropertyGateResolvesPureMembership(self, admin, server):
        folder, anns, _ = self._setup(admin)
        resp = postJson(
            server, admin, "/upenn_annotation/analysis/gate_ids",
            {
                "datasetId": str(folder["_id"]),
                "plots": [propertyPlot("plot-1", BOX_0_10)],
            },
        )
        assertStatusOk(resp)
        assert resp.json["gateIds"] == {"plot-1": [str(anns[0]["_id"])]}

    def testPlotsResolveIndependentlyNotChained(self, admin, server):
        # Two plots whose polygons overlap on one annotation: each answer is
        # the pure predicate over the whole dataset — the second plot's list
        # is NOT narrowed by the first plot's gate.
        folder, anns, _ = self._setup(admin)
        wideBox = [
            {"x": 0, "y": 0}, {"x": 100, "y": 0},
            {"x": 100, "y": 100}, {"x": 0, "y": 100},
        ]
        resp = postJson(
            server, admin, "/upenn_annotation/analysis/gate_ids",
            {
                "datasetId": str(folder["_id"]),
                "plots": [
                    propertyPlot("narrow", BOX_0_10),
                    propertyPlot("wide", wideBox),
                ],
            },
        )
        assertStatusOk(resp)
        assert resp.json["gateIds"]["narrow"] == [str(anns[0]["_id"])]
        assert sorted(resp.json["gateIds"]["wide"]) == sorted(
            str(a["_id"]) for a in anns
        )

    def testCategoricalGateReadsAnnotationFields(self, admin, server):
        folder, anns, noValues = self._setup(admin)
        inKey = analysis.encode_category_key(["in"])
        outKey = analysis.encode_category_key(["out"])
        resp = postJson(
            server, admin, "/upenn_annotation/analysis/gate_ids",
            {
                "datasetId": str(folder["_id"]),
                "plots": [{
                    "id": "cat",
                    "xAxis": {"type": "categorical", "key": "tags"},
                    "yAxis": {"type": "categorical", "key": "channel"},
                    "gate": {
                        "categoryKeyVersion": 1,
                        "vertices": [
                            {"x": -0.4, "y": -0.4},
                            {"x": 0.4, "y": -0.4},
                            {"x": 0.4, "y": 0.4},
                            {"x": -0.4, "y": 0.4},
                        ],
                        "xCategories": [inKey, outKey],
                        "yCategories": [analysis.encode_category_key(0)],
                    },
                }],
            },
        )
        assertStatusOk(resp)
        expected = sorted(
            [str(anns[0]["_id"]), str(anns[2]["_id"]),
             str(noValues["_id"])]
        )
        assert sorted(resp.json["gateIds"]["cat"]) == expected

    def testOrphanValueDocNeverProducesAnId(self, admin, server):
        # A property-value doc whose annotation is gone must not resolve:
        # annotation docs anchor existence (unlike listIds' PV-driven path).
        folder, anns, _ = self._setup(admin)
        AnnotationPropertyValues().appendValues(
            {"p": {"Area": 5, "Mean": 5}}, ObjectId(), folder["_id"]
        )
        resp = postJson(
            server, admin, "/upenn_annotation/analysis/gate_ids",
            {
                "datasetId": str(folder["_id"]),
                "plots": [propertyPlot("plot-1", BOX_0_10)],
            },
        )
        assertStatusOk(resp)
        assert resp.json["gateIds"] == {"plot-1": [str(anns[0]["_id"])]}

    def testEmptyGateIsARealAnswer(self, admin, server):
        folder, _, _ = self._setup(admin)
        farBox = [
            {"x": 1000, "y": 1000}, {"x": 1001, "y": 1000},
            {"x": 1001, "y": 1001}, {"x": 1000, "y": 1001},
        ]
        resp = postJson(
            server, admin, "/upenn_annotation/analysis/gate_ids",
            {
                "datasetId": str(folder["_id"]),
                "plots": [propertyPlot("empty", farBox)],
            },
        )
        assertStatusOk(resp)
        assert resp.json["gateIds"] == {"empty": []}

    def testDegenerateGateMatchesNothingWithoutError(self, admin, server):
        folder, _, _ = self._setup(admin)
        resp = postJson(
            server, admin, "/upenn_annotation/analysis/gate_ids",
            {
                "datasetId": str(folder["_id"]),
                "plots": [propertyPlot("degenerate", BOX_0_10[:2])],
            },
        )
        assertStatusOk(resp)
        assert resp.json["gateIds"] == {"degenerate": []}

    def testEmptyPlotsResolvesToNothing(self, admin, server):
        folder, _, _ = self._setup(admin)
        resp = postJson(
            server, admin, "/upenn_annotation/analysis/gate_ids",
            {"datasetId": str(folder["_id"]), "plots": []},
        )
        assertStatusOk(resp)
        assert resp.json["gateIds"] == {}

    def testRequiresReadAccess(self, admin, user, server):
        folder = utilities.createPrivateFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        resp = postJson(
            server, user, "/upenn_annotation/analysis/gate_ids",
            {
                "datasetId": str(folder["_id"]),
                "plots": [propertyPlot("plot-1", BOX_0_10)],
            },
        )
        assertStatus(resp, 403)

    def testUnknownDatasetIs400(self, admin, server):
        resp = postJson(
            server, admin, "/upenn_annotation/analysis/gate_ids",
            {"datasetId": "not-an-id", "plots": []},
        )
        assertStatus(resp, 400)

    @pytest.mark.parametrize("mutate", [
        lambda p: p.pop("id"),
        lambda p: p.update(id=7),
        lambda p: p.update(xAxis="Area"),
        lambda p: p.update(xAxis={"type": "nope"}),
        lambda p: p.update(
            xAxis={"type": "property", "path": ["bad.dot"]}
        ),
        lambda p: p.update(
            xAxis={"type": "categorical", "key": "name"}
        ),
        lambda p: p.update(gate=None),
        lambda p: p["gate"].update(categoryKeyVersion=2),
        lambda p: p["gate"].update(vertices="nope"),
        lambda p: p["gate"].update(vertices=[{"x": 0, "y": True}] * 3),
        lambda p: p["gate"].update(vertices=[{"x": 0}] * 3),
        lambda p: p["gate"].update(xCategories=["k"]),
        lambda p: p["gate"].pop("vertices"),
    ])
    def testMalformedPlotIs400Not500(self, admin, server, mutate):
        folder, _, _ = self._setup(admin)
        plot = propertyPlot("plot-1", BOX_0_10)
        mutate(plot)
        resp = postJson(
            server, admin, "/upenn_annotation/analysis/gate_ids",
            {"datasetId": str(folder["_id"]), "plots": [plot]},
        )
        assertStatus(resp, 400)

    def testCategoricalAxisRequiresPinnedCategories(self, admin, server):
        folder, _, _ = self._setup(admin)
        resp = postJson(
            server, admin, "/upenn_annotation/analysis/gate_ids",
            {
                "datasetId": str(folder["_id"]),
                "plots": [{
                    "id": "cat",
                    "xAxis": {"type": "categorical", "key": "tags"},
                    "yAxis": {"type": "property", "path": ["p", "Mean"]},
                    "gate": {
                        "categoryKeyVersion": 1,
                        "vertices": BOX_0_10,
                        "xCategories": None,
                        "yCategories": None,
                    },
                }],
            },
        )
        assertStatus(resp, 400)

    def testNonListPlotsIs400(self, admin, server):
        folder, _, _ = self._setup(admin)
        resp = postJson(
            server, admin, "/upenn_annotation/analysis/gate_ids",
            {"datasetId": str(folder["_id"]), "plots": {"id": "x"}},
        )
        assertStatus(resp, 400)

    def testTooManyPlotsIs400(self, admin, server, monkeypatch):
        from upenncontrast_annotation.server.helpers import validation
        monkeypatch.setattr(validation, "MAX_ANALYSIS_PLOTS", 1)
        folder, _, _ = self._setup(admin)
        resp = postJson(
            server, admin, "/upenn_annotation/analysis/gate_ids",
            {
                "datasetId": str(folder["_id"]),
                "plots": [
                    propertyPlot("a", BOX_0_10),
                    propertyPlot("b", BOX_0_10),
                ],
            },
        )
        assertStatus(resp, 400)


# --- Endpoint: POST /upenn_annotation/analysis/histogram2d ---


def histogramBody(datasetId, **overrides):
    body = {
        "datasetId": str(datasetId),
        "xAxis": {"type": "property", "path": ["p", "Area"]},
        "yAxis": {"type": "property", "path": ["p", "Mean"]},
        "xCategories": None,
        "yCategories": None,
        "bins": {"x": 2, "y": 2},
        "upstreamGates": [],
        "filters": {},
        "gate": None,
    }
    body.update(overrides)
    return body


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestAnalysisHistogramEndpoint:
    def _setup(self, admin):
        folder = utilities.createFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        pv = AnnotationPropertyValues()
        anns = []
        # Four quadrants of the (Area, Mean) plane in [0,10]²: one point per
        # quadrant, plus one annotation with no values at all.
        for area, mean, tags in (
            (1, 1, ["low"]),
            (9, 1, ["high"]),
            (1, 9, ["low"]),
            (9, 9, ["high"]),
        ):
            a = makeAnnotation(folder["_id"], tags=tags)
            pv.appendValues(
                {"p": {"Area": area, "Mean": mean}}, a["_id"], folder["_id"]
            )
            anns.append(a)
        noValues = makeAnnotation(folder["_id"], tags=["low"])
        return folder, anns, noValues

    def testNumericHistogramBinsAndCounts(self, admin, server):
        folder, _, _ = self._setup(admin)
        resp = postJson(
            server, admin, "/upenn_annotation/analysis/histogram2d",
            histogramBody(folder["_id"]),
        )
        assertStatusOk(resp)
        result = resp.json
        assert result["inputCount"] == 5
        assert result["plottedCount"] == 4
        assert len(result["xEdges"]) == 3
        assert len(result["yEdges"]) == 3
        assert result["xCategories"] is None
        # counts rows are y bins, columns are x bins; one point per cell.
        assert result["counts"] == [[1, 1], [1, 1]]
        assert result["gateCount"] is None

    def testCategoricalAxisBinsPerCategory(self, admin, server):
        folder, _, _ = self._setup(admin)
        lowKey = analysis.encode_category_key(["low"])
        highKey = analysis.encode_category_key(["high"])
        resp = postJson(
            server, admin, "/upenn_annotation/analysis/histogram2d",
            histogramBody(
                folder["_id"],
                xAxis={"type": "categorical", "key": "tags"},
                xCategories=[lowKey, highKey],
                bins={"x": 7, "y": 1},
            ),
        )
        assertStatusOk(resp)
        result = resp.json
        # A categorical axis bins one category per index, ignoring bins.x.
        assert result["xCategories"] == [lowKey, highKey]
        assert result["xEdges"] is None
        # Rows = the single y bin; columns = categories. The no-values
        # annotation is plottable on tags x but not on Mean y.
        assert result["counts"] == [[2, 2]]
        assert result["inputCount"] == 5
        assert result["plottedCount"] == 4

    def testUnknownCategoriesAppendSortedByKey(self, admin, server):
        folder, _, _ = self._setup(admin)
        lowKey = analysis.encode_category_key(["low"])
        highKey = analysis.encode_category_key(["high"])
        resp = postJson(
            server, admin, "/upenn_annotation/analysis/histogram2d",
            histogramBody(
                folder["_id"],
                xAxis={"type": "categorical", "key": "tags"},
                xCategories=[lowKey],
                bins={"x": 1, "y": 1},
            ),
        )
        assertStatusOk(resp)
        # Pinned first, then unknowns in deterministic (key) order.
        assert resp.json["xCategories"] == [lowKey, highKey]

    def testUpstreamGatesNarrowTheInput(self, admin, server):
        folder, _, _ = self._setup(admin)
        # Upstream gate keeps only Area < 5 (the two "low x" quadrants).
        leftHalf = {
            "xAxis": {"type": "property", "path": ["p", "Area"]},
            "yAxis": {"type": "property", "path": ["p", "Mean"]},
            "gate": {
                "categoryKeyVersion": 1,
                "vertices": [
                    {"x": 0, "y": 0}, {"x": 5, "y": 0},
                    {"x": 5, "y": 10}, {"x": 0, "y": 10},
                ],
                "xCategories": None,
                "yCategories": None,
            },
        }
        resp = postJson(
            server, admin, "/upenn_annotation/analysis/histogram2d",
            histogramBody(folder["_id"], upstreamGates=[leftHalf]),
        )
        assertStatusOk(resp)
        assert resp.json["inputCount"] == 2
        assert resp.json["plottedCount"] == 2

    def testFiltersNarrowTheInput(self, admin, server):
        folder, _, _ = self._setup(admin)
        resp = postJson(
            server, admin, "/upenn_annotation/analysis/histogram2d",
            histogramBody(
                folder["_id"],
                filters={"tags": {"values": ["high"], "exclusive": False}},
            ),
        )
        assertStatusOk(resp)
        assert resp.json["inputCount"] == 2

    def testOwnGateCountUsesChainedInput(self, admin, server):
        folder, _, _ = self._setup(admin)
        ownGate = {
            "categoryKeyVersion": 1,
            "vertices": [
                {"x": 0, "y": 0}, {"x": 5, "y": 0},
                {"x": 5, "y": 10}, {"x": 0, "y": 10},
            ],
            "xCategories": None,
            "yCategories": None,
        }
        resp = postJson(
            server, admin, "/upenn_annotation/analysis/histogram2d",
            histogramBody(
                folder["_id"],
                gate=ownGate,
                filters={"tags": {"values": ["low"], "exclusive": False}},
            ),
        )
        assertStatusOk(resp)
        # Filters keep the two valued "low" annotations (plus the no-values
        # one); the gate keeps the two with Area < 5.
        assert resp.json["inputCount"] == 3
        assert resp.json["gateCount"] == 2

    def testDegenerateNumericRangeIsASingleBin(self, admin, server):
        folder = utilities.createFolder(
            admin, "flat", upenn_utilities.datasetMetadata
        )
        pv = AnnotationPropertyValues()
        for _ in range(3):
            a = makeAnnotation(folder["_id"])
            pv.appendValues(
                {"p": {"Area": 7, "Mean": 7}}, a["_id"], folder["_id"]
            )
        resp = postJson(
            server, admin, "/upenn_annotation/analysis/histogram2d",
            histogramBody(folder["_id"], bins={"x": 128, "y": 128}),
        )
        assertStatusOk(resp)
        assert resp.json["counts"] == [[3]]
        assert len(resp.json["xEdges"]) == 2

    def testEmptyPopulationIsARealAnswer(self, admin, server):
        folder = utilities.createFolder(
            admin, "empty", upenn_utilities.datasetMetadata
        )
        resp = postJson(
            server, admin, "/upenn_annotation/analysis/histogram2d",
            histogramBody(folder["_id"], bins={"x": 2, "y": 2}),
        )
        assertStatusOk(resp)
        assert resp.json["inputCount"] == 0
        assert resp.json["plottedCount"] == 0
        assert sum(sum(row) for row in resp.json["counts"]) == 0

    def testBinsAreClamped(self, admin, server):
        folder, _, _ = self._setup(admin)
        resp = postJson(
            server, admin, "/upenn_annotation/analysis/histogram2d",
            histogramBody(folder["_id"], bins={"x": 100000, "y": 1}),
        )
        assertStatusOk(resp)
        assert len(resp.json["xEdges"]) - 1 <= 512

    def testRequiresReadAccess(self, admin, user, server):
        folder = utilities.createPrivateFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        resp = postJson(
            server, user, "/upenn_annotation/analysis/histogram2d",
            histogramBody(folder["_id"]),
        )
        assertStatus(resp, 403)

    @pytest.mark.parametrize("mutate", [
        lambda b: b.update(xAxis={"type": "nope"}),
        lambda b: b.update(bins="many"),
        lambda b: b.update(bins={"x": "many", "y": 1}),
        lambda b: b.update(xCategories=["k"]),
        lambda b: b.update(upstreamGates={"gate": None}),
        lambda b: b.update(filters={"idConstraints": [[]]}),
        lambda b: b.update(gate={"vertices": "nope"}),
        # Display categories may be null (the server derives them for a
        # gateless categorical plot) but never a non-list value.
        lambda b: b.update(
            xAxis={"type": "categorical", "key": "tags"},
            xCategories=42,
        ),
    ])
    def testMalformedRequestIs400Not500(self, admin, server, mutate):
        folder, _, _ = self._setup(admin)
        body = histogramBody(folder["_id"])
        mutate(body)
        resp = postJson(
            server, admin, "/upenn_annotation/analysis/histogram2d", body,
        )
        assertStatus(resp, 400)


# --- Codex review findings (PR #1302) ---


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestAnalysisGatingReviewFindings:
    """Regression tests for the three findings on PR #1302."""

    def _setup(self, admin):
        folder = utilities.createFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        return folder

    def testGateCountExcludesAppendedCategories(self, admin, server):
        """P2: the histogram's gateCount fast path must apply the same
        unknown-category exclusion resolve_gate_ids does.

        A gate pinned to one category, on a dataset that has since gained a
        second: the appended category is display-only and can never be inside
        the gate, however far the polygon reaches.
        """
        folder = self._setup(admin)
        makeAnnotation(folder["_id"], tags=["known"])
        makeAnnotation(folder["_id"], tags=["appeared-later"])
        knownKey = analysis.encode_category_key(["known"])
        gate = {
            "categoryKeyVersion": 1,
            # Spans well past the pinned column, over the appended one too.
            "vertices": [
                {"x": -0.5, "y": -0.5}, {"x": 9, "y": -0.5},
                {"x": 9, "y": 0.5}, {"x": -0.5, "y": 0.5},
            ],
            "xCategories": [knownKey],
            "yCategories": [analysis.encode_category_key(0)],
        }
        resp = postJson(
            server, admin, "/upenn_annotation/analysis/histogram2d",
            histogramBody(
                folder["_id"],
                xAxis={"type": "categorical", "key": "tags"},
                yAxis={"type": "categorical", "key": "channel"},
                xCategories=[knownKey],
                yCategories=[analysis.encode_category_key(0)],
                bins={"x": 1, "y": 1},
                gate=gate,
            ),
        )
        assertStatusOk(resp)
        # Both plot (the unknown is appended for display)...
        assert resp.json["plottedCount"] == 2
        assert len(resp.json["xCategories"]) == 2
        # ...but only the pinned one is inside the gate.
        assert resp.json["gateCount"] == 1
        # And it must agree with the authoritative resolver.
        gateResp = postJson(
            server, admin, "/upenn_annotation/analysis/gate_ids",
            {"datasetId": str(folder["_id"]), "plots": [{
                "id": "p", "xAxis": {"type": "categorical", "key": "tags"},
                "yAxis": {"type": "categorical", "key": "channel"},
                "gate": gate}]},
        )
        assertStatusOk(gateResp)
        assert len(gateResp.json["gateIds"]["p"]) == resp.json["gateCount"]

    def testHugeCategoricalGridIsRejected(self, admin, server):
        """P1: a public request must not be able to allocate a 10k x 10k
        histogram (~800MB) just by listing many categories."""
        folder = self._setup(admin)
        makeAnnotation(folder["_id"], tags=["a"])
        many = [analysis.encode_category_key([f"c{i}"]) for i in range(3000)]
        resp = postJson(
            server, admin, "/upenn_annotation/analysis/histogram2d",
            histogramBody(
                folder["_id"],
                xAxis={"type": "categorical", "key": "tags"},
                yAxis={"type": "categorical", "key": "shape"},
                xCategories=many,
                yCategories=many,
                bins={"x": 1, "y": 1},
            ),
        )
        assertStatus(resp, 400)

    def testDataDerivedCategoriesAreAlsoBounded(self, admin, server):
        """The same explosion is reachable without a hostile request: a
        dataset whose annotations each carry a distinct tag makes
        derive_axis_categories produce one column per annotation."""
        folder = self._setup(admin)
        for i in range(40):
            makeAnnotation(folder["_id"], tags=[f"tag{i}"])
        # Bound well below the real cap so the test stays fast.
        original = analysis.MAX_HISTOGRAM_CELLS
        analysis.MAX_HISTOGRAM_CELLS = 100
        try:
            resp = postJson(
                server, admin, "/upenn_annotation/analysis/histogram2d",
                histogramBody(
                    folder["_id"],
                    xAxis={"type": "categorical", "key": "tags"},
                    yAxis={"type": "categorical", "key": "tags"},
                    xCategories=None, yCategories=None,
                    bins={"x": 1, "y": 1},
                ),
            )
            # 40 x 40 = 1600 cells > 100: must degrade, not allocate.
            assertStatus(resp, 400)
        finally:
            analysis.MAX_HISTOGRAM_CELLS = original

    def testSingleCategoricalAxisIsCappedIndependently(self, admin, server):
        """Codex round 2: a product-only cell check lets one axis carry
        MAX_HISTOGRAM_CELLS categories when the other collapses to a single
        bin. The response returns every category and the client installs
        each as an explicit Plotly tick, so an ordinary distinct-tag dataset
        against a constant property could ship hundreds of thousands of
        labels and lock the browser while staying inside the cell budget."""
        from upenncontrast_annotation.server.helpers import analysis as an
        folder = self._setup(admin)
        pv = AnnotationPropertyValues()
        for i in range(40):
            a = makeAnnotation(folder["_id"], tags=[f"tag{i}"])
            # Constant property value => the numeric axis collapses to 1 bin.
            pv.appendValues({"p": {"Area": 7}}, a["_id"], folder["_id"])
        original = an.MAX_HISTOGRAM_AXIS_CATEGORIES
        an.MAX_HISTOGRAM_AXIS_CATEGORIES = 10
        try:
            resp = postJson(
                server, admin, "/upenn_annotation/analysis/histogram2d",
                histogramBody(
                    folder["_id"],
                    xAxis={"type": "categorical", "key": "tags"},
                    yAxis={"type": "property", "path": ["p", "Area"]},
                    xCategories=None, yCategories=None,
                    bins={"x": 1, "y": 1},
                ),
            )
            # 40 categories x 1 numeric bin = 40 cells, well inside the cell
            # budget — only a per-axis limit catches this.
            assertStatus(resp, 400)
        finally:
            an.MAX_HISTOGRAM_AXIS_CATEGORIES = original

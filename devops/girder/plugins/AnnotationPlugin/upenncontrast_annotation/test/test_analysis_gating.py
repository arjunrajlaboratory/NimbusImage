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

from upenncontrast_annotation.server.helpers import analysis


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

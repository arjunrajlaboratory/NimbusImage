import json

import pytest

from bson.objectid import ObjectId
from pytest_girder.assertions import assertStatus, assertStatusOk

from upenncontrast_annotation.server.helpers.colormaps import (
    CATEGORICAL_PALETTE,
    CONTINUOUS_COLORMAPS,
    categoricalColor,
    colormapTable,
    sampleColormap,
)
from upenncontrast_annotation.server.models.annotation import Annotation
from upenncontrast_annotation.server.models.propertyValues import (
    AnnotationPropertyValues,
)

from . import girder_utilities as utilities
from . import upenn_testing_utilities as upenn_utilities


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestColorByProperty:
    """POST /upenn_annotation/color_by_property — bulk color assignment."""

    def _makeDatasetWithValues(self, admin, valuesById, name="test_dataset"):
        """Create a dataset with one annotation per entry of valuesById.
        Entries that are None create an annotation with no property values."""
        folder = utilities.createFolder(
            admin, name, upenn_utilities.datasetMetadata
        )
        ids = []
        for values in valuesById:
            annotation = Annotation().create(
                upenn_utilities.getSampleAnnotation(folder["_id"])
            )
            if values is not None:
                AnnotationPropertyValues().appendValues(
                    values, annotation["_id"], folder["_id"]
                )
            ids.append(str(annotation["_id"]))
        return folder, ids

    def _colorBy(self, server, user, body):
        return server.request(
            path="/upenn_annotation/color_by_property",
            method="POST",
            user=user,
            body=json.dumps(body),
            type="application/json",
        )

    def _colorsById(self, folder):
        return {
            str(annotation["_id"]): annotation.get("color")
            for annotation in Annotation().find(
                {"datasetId": folder["_id"]}
            )
        }

    def testContinuousAutoMapsExtremesAndSkipsMissing(self, admin, server):
        # percentileLow/High 0/100 asks for the full extent, so this test
        # covers extremes → first/last colormap color independently of the
        # percentile-clipping default (see testDefaultRangeClipsOutliers...).
        folder, ids = self._makeDatasetWithValues(
            admin,
            [{"propA": 0}, {"propA": 5}, {"propA": 10}, None],
        )
        resp = self._colorBy(
            server,
            admin,
            {
                "datasetId": str(folder["_id"]),
                "propertyPath": ["propA"],
                "percentileLow": 0,
                "percentileHigh": 100,
            },
        )
        assertStatusOk(resp)
        assert resp.json["colored"] == 3
        assert resp.json["uncolored"] == 1
        legend = resp.json["legend"]
        assert legend["type"] == "continuous"
        assert legend["min"] == 0
        assert legend["max"] == 10
        assert legend["colormap"] == "viridis"
        assert legend["stops"] == CONTINUOUS_COLORMAPS["viridis"]

        colors = self._colorsById(folder)
        assert colors[ids[0]] == sampleColormap("viridis", 0.0)
        assert colors[ids[1]] == colormapTable(
            "viridis", Annotation.CONTINUOUS_COLOR_LEVELS
        )[Annotation.CONTINUOUS_COLOR_LEVELS // 2]
        assert colors[ids[2]] == sampleColormap("viridis", 1.0)
        assert colors[ids[3]] is None

    def testExplicitRangeClampsOutOfRangeValues(self, admin, server):
        folder, ids = self._makeDatasetWithValues(
            admin,
            [{"propA": 0}, {"propA": 10}],
        )
        resp = self._colorBy(
            server,
            admin,
            {
                "datasetId": str(folder["_id"]),
                "propertyPath": ["propA"],
                "colormap": "plasma",
                "rangeMin": 2,
                "rangeMax": 8,
            },
        )
        assertStatusOk(resp)
        legend = resp.json["legend"]
        assert legend["min"] == 2
        assert legend["max"] == 8
        colors = self._colorsById(folder)
        assert colors[ids[0]] == sampleColormap("plasma", 0.0)
        assert colors[ids[1]] == sampleColormap("plasma", 1.0)

    def testNestedPropertyPath(self, admin, server):
        folder, ids = self._makeDatasetWithValues(
            admin,
            [
                {"propA": {"Mean": {"Ch1": 1}}},
                {"propA": {"Mean": {"Ch1": 3}}},
            ],
        )
        resp = self._colorBy(
            server,
            admin,
            {
                "datasetId": str(folder["_id"]),
                "propertyPath": ["propA", "Mean", "Ch1"],
            },
        )
        assertStatusOk(resp)
        assert resp.json["colored"] == 2
        colors = self._colorsById(folder)
        assert colors[ids[0]] == sampleColormap("viridis", 0.0)
        assert colors[ids[1]] == sampleColormap("viridis", 1.0)

    def testCategoricalAutoAssignsPaletteByCountDesc(self, admin, server):
        folder, ids = self._makeDatasetWithValues(
            admin,
            [{"propA": "b"}, {"propA": "a"}, {"propA": "a"}],
        )
        resp = self._colorBy(
            server,
            admin,
            {"datasetId": str(folder["_id"]), "propertyPath": ["propA"]},
        )
        assertStatusOk(resp)
        legend = resp.json["legend"]
        assert legend["type"] == "categorical"
        assert legend["categories"] == [
            {"value": "a", "color": CATEGORICAL_PALETTE[0], "count": 2},
            {"value": "b", "color": CATEGORICAL_PALETTE[1], "count": 1},
        ]
        colors = self._colorsById(folder)
        assert colors[ids[0]] == CATEGORICAL_PALETTE[1]
        assert colors[ids[1]] == CATEGORICAL_PALETTE[0]
        assert colors[ids[2]] == CATEGORICAL_PALETTE[0]

    def testTooManyCategoriesIsA400(self, admin, server, monkeypatch):
        monkeypatch.setattr(Annotation, "MAX_CATEGORIES", 2)
        folder, _ = self._makeDatasetWithValues(
            admin,
            [{"propA": "a"}, {"propA": "b"}, {"propA": "c"}],
        )
        resp = self._colorBy(
            server,
            admin,
            {
                "datasetId": str(folder["_id"]),
                "propertyPath": ["propA"],
                "mode": "categorical",
            },
        )
        assertStatus(resp, 400)
        assert "Too many distinct values" in resp.json["message"]

    def testDefaultRangeClipsOutliersByPercentile(self, admin, server):
        # Real data is skewed: on a 708K-cell dataset, 99% of Area values
        # occupied 14.2% of the min..max span, so a full-extent default put
        # nearly every annotation in the same dark colormap bucket. Default
        # to the 1st..99th percentile and report the true extent alongside.
        values = [{"propA": v} for v in list(range(1, 100)) + [100000]]
        folder, ids = self._makeDatasetWithValues(admin, values)
        resp = self._colorBy(
            server,
            admin,
            {"datasetId": str(folder["_id"]), "propertyPath": ["propA"]},
        )
        assertStatusOk(resp)
        legend = resp.json["legend"]
        # p1/p99 over the 100 sorted values [1..99, 100000]: p1 interpolates
        # between values[0]=1 and values[1]=2 at 0.99 -> 1.99; p99 between
        # values[98]=99 and values[99]=100000 at 0.01 -> 1098.01.
        assert legend["min"] == pytest.approx(1.99, abs=0.01)
        assert legend["max"] == pytest.approx(1098.01, abs=0.01)
        # The full extent stays visible so the legend can say it clipped.
        assert legend["dataMin"] == 1
        assert legend["dataMax"] == 100000
        assert legend["clippedLow"] is True
        assert legend["clippedHigh"] is True
        # The outlier clamps to the top color instead of stretching the ramp.
        colors = self._colorsById(folder)
        assert colors[ids[-1]] == sampleColormap("viridis", 1.0)

    def testExplicitBoundsOverridePercentiles(self, admin, server):
        folder, _ = self._makeDatasetWithValues(
            admin, [{"propA": v} for v in range(0, 101)]
        )
        resp = self._colorBy(
            server,
            admin,
            {
                "datasetId": str(folder["_id"]),
                "propertyPath": ["propA"],
                "rangeMin": 0,
                "rangeMax": 100,
            },
        )
        assertStatusOk(resp)
        legend = resp.json["legend"]
        assert (legend["min"], legend["max"]) == (0, 100)
        assert legend["clippedLow"] is False
        assert legend["clippedHigh"] is False

    def testCustomPercentilesAreHonoured(self, admin, server):
        folder, _ = self._makeDatasetWithValues(
            admin, [{"propA": v} for v in range(0, 101)]
        )
        resp = self._colorBy(
            server,
            admin,
            {
                "datasetId": str(folder["_id"]),
                "propertyPath": ["propA"],
                "percentileLow": 0,
                "percentileHigh": 100,
            },
        )
        assertStatusOk(resp)
        legend = resp.json["legend"]
        assert (legend["min"], legend["max"]) == (0, 100)

    def testInvalidPercentilesAreClean400s(self, admin, server):
        folder, _ = self._makeDatasetWithValues(admin, [{"propA": 1}])
        datasetId = str(folder["_id"])
        cases = [
            ({"percentileLow": -1}, "percentileLow must be between 0 and 100"),
            ({"percentileHigh": 101},
             "percentileHigh must be between 0 and 100"),
            ({"percentileLow": "a"},
             "percentileLow must be a finite number"),
            (
                {"percentileLow": 90, "percentileHigh": 10},
                "percentileLow must be less than percentileHigh",
            ),
        ]
        for extra, message in cases:
            resp = self._colorBy(
                server,
                admin,
                {
                    "datasetId": datasetId,
                    "propertyPath": ["propA"],
                    **extra,
                },
            )
            assertStatus(resp, 400)
            assert message in resp.json["message"], extra

    def testCategoriesBeyondThePaletteStayDistinct(self, admin, server):
        # A 36-cluster graph clustering (real case) cycled a 20-colour
        # palette, so clusters 1 and 21 rendered identically. Colours must
        # stay distinct until MAX_CATEGORIES.
        folder, _ = self._makeDatasetWithValues(
            admin, [{"propA": "c%03d" % i} for i in range(45)]
        )
        resp = self._colorBy(
            server,
            admin,
            {
                "datasetId": str(folder["_id"]),
                "propertyPath": ["propA"],
                "mode": "categorical",
            },
        )
        assertStatusOk(resp)
        colors = [c["color"] for c in resp.json["legend"]["categories"]]
        assert len(colors) == 45
        assert len(set(colors)) == 45
        # The first cycle still uses the palette as-is.
        assert colors[: len(CATEGORICAL_PALETTE)] == CATEGORICAL_PALETTE

    def testTooManyCategoriesBailsBeforeGroupingEverything(self, admin):
        # Guard against the cost-before-guard shape: forcing categorical on a
        # continuous property must stop as soon as the cap is exceeded, not
        # build a label entry for every distinct value first (observed live:
        # 555,479 groups built before the cap was checked).
        #
        # Feeding a GENERATOR is what makes this a real guard: how many pairs
        # were consumed is observable, so moving the cap check after the
        # grouping loop fails here. Asserting only the message does not —
        # the message is identical either way.
        folder = utilities.createFolder(
            admin, "cap_dataset", upenn_utilities.datasetMetadata
        )
        model = Annotation()
        consumed = []

        def pairs():
            for i in range(50000):
                consumed.append(i)
                yield ObjectId(), "c%d" % i

        with pytest.raises(ValueError) as excinfo:
            model._colorCategorical(folder["_id"], ["propA"], pairs())
        message = str(excinfo.value)
        assert "Too many distinct values" in message
        # The message reports the cap, not a total, because counting past the
        # cap is exactly the work being avoided.
        assert "more than %d" % model.MAX_CATEGORIES in message
        assert "50000" not in message
        # Stopped at the cap rather than draining the source.
        assert len(consumed) == model.MAX_CATEGORIES + 1, len(consumed)

    def testCategoricalCapMatchesThePaletteCapacity(self):
        # The cap exists because the palette repeats past this many
        # categories; if they drift apart, categories beyond the palette
        # render identically with nothing in the legend to tell them apart.
        colors = {
            categoricalColor(i) for i in range(Annotation.MAX_CATEGORIES)
        }
        assert len(colors) == Annotation.MAX_CATEGORIES
        # And one past the cap is where repetition starts.
        assert categoricalColor(Annotation.MAX_CATEGORIES) in colors

    def testASinglePercentileCannotInvertTheRange(self, admin, server):
        # The twin of testEmptyExplicitRangeIsA400 on the percentile pair:
        # percentileLow alone, above the default high of 99, resolved to
        # low > high and painted every annotation the middle colour under a
        # legend whose min exceeded its max — HTTP 200, no error.
        folder, _ = self._makeDatasetWithValues(
            admin, [{"propA": v} for v in range(1000)]
        )
        for bounds in ({"percentileLow": 99.5}, {"percentileHigh": 0.5}):
            resp = self._colorBy(
                server,
                admin,
                {
                    "datasetId": str(folder["_id"]),
                    "propertyPath": ["propA"],
                    **bounds,
                },
            )
            assertStatus(resp, 400)
            assert "range" in resp.json["message"], bounds

    def testZeroWidthRangeStillClampsOutliers(self, admin, server):
        # p1 == p99 on sparse data (199 zeros and one outlier). A zero-width
        # range still has an outside: the outlier must take the top colour, not
        # the middle one, or the ramp contradicts the legend's clippedHigh.
        folder, ids = self._makeDatasetWithValues(
            admin, [{"propA": 0}] * 199 + [{"propA": 1000}]
        )
        resp = self._colorBy(
            server,
            admin,
            {"datasetId": str(folder["_id"]), "propertyPath": ["propA"]},
        )
        assertStatusOk(resp)
        legend = resp.json["legend"]
        assert legend["min"] == legend["max"] == 0
        assert legend["clippedHigh"] is True
        colors = self._colorsById(folder)
        table = colormapTable(
            "viridis", Annotation.CONTINUOUS_COLOR_LEVELS
        )
        assert colors[ids[-1]] == table[-1]
        # The zeros sit on the collapsed bound, so they take the middle.
        assert colors[ids[0]] == table[
            Annotation.CONTINUOUS_COLOR_LEVELS // 2
        ]

    def testAnExplicitBoundResolvesItsPartnerFromTheDataExtent(
        self, admin, server
    ):
        # Giving one absolute bound means the caller is choosing the range;
        # resolving the other from a percentile rejected legitimate requests
        # against a bound the caller never sent.
        folder, _ = self._makeDatasetWithValues(
            admin, [{"propA": v} for v in range(1, 101)]
        )
        resp = self._colorBy(
            server,
            admin,
            {
                "datasetId": str(folder["_id"]),
                "propertyPath": ["propA"],
                "rangeMax": 1.5,
            },
        )
        assertStatusOk(resp)
        legend = resp.json["legend"]
        assert (legend["min"], legend["max"]) == (1, 1.5)

    def testAnExplicitBoundEqualToTheOnlyValueIsAccepted(self, admin, server):
        folder, _ = self._makeDatasetWithValues(
            admin, [{"propA": 5}, {"propA": 5}]
        )
        resp = self._colorBy(
            server,
            admin,
            {
                "datasetId": str(folder["_id"]),
                "propertyPath": ["propA"],
                "rangeMin": 5,
            },
        )
        assertStatusOk(resp)
        assert resp.json["colored"] == 2

    def testNonFiniteBoundsAreClean400s(self, admin, server):
        # Bare NaN/Infinity are rejected by girder's JSON parsing before they
        # reach the handler, but an overflowing exponent is VALID JSON that
        # parses to infinity. Unguarded it reached the range arithmetic and
        # surfaced an internal ValueError ("cannot convert float NaN to
        # integer") to the client as if it were input validation.
        folder, _ = self._makeDatasetWithValues(admin, [{"propA": 1}])
        # The third case is an integer too large to convert to float: JSON
        # ints are unbounded, and math.isfinite raises OverflowError on one
        # (it is not a ValueError), which unguarded became a 500.
        for raw in ("1e999", "-1e999", "1" + "0" * 400):
            resp = server.request(
                path="/upenn_annotation/color_by_property",
                method="POST",
                user=admin,
                body='{"datasetId": "%s", "propertyPath": ["propA"], '
                     '"rangeMin": %s}' % (str(folder["_id"]), raw),
                type="application/json",
            )
            assertStatus(resp, 400)
            assert "finite number" in resp.json["message"], raw[:20]

    def testDuplicatePropertyValueDocsDoNotHideAStaleColor(self, admin):
        # An annotation with two property-value documents used to land in two
        # colour groups, which inflated the covered-id count that decides the
        # clearing pass can be skipped — so an annotation with no value kept
        # its previous colour and the response still reported uncolored: 0.
        folder = utilities.createFolder(
            admin, "dupes", upenn_utilities.datasetMetadata
        )
        first = Annotation().create(
            upenn_utilities.getSampleAnnotation(folder["_id"])
        )
        second = Annotation().create(
            upenn_utilities.getSampleAnnotation(folder["_id"])
        )
        stale = Annotation().create(
            upenn_utilities.getSampleAnnotation(folder["_id"])
        )
        Annotation().update(
            {"_id": stale["_id"]}, {"$set": {"color": "#ff0000"}}
        )
        pv = AnnotationPropertyValues()
        # Two documents for `first`, bypassing the merge in validateMultiple.
        pv.save({"annotationId": first["_id"], "datasetId": folder["_id"],
                 "values": {"propA": 1}}, validate=False)
        pv.save({"annotationId": first["_id"], "datasetId": folder["_id"],
                 "values": {"propA": 100}}, validate=False)
        pv.appendValues({"propA": 50}, second["_id"], folder["_id"])

        result = Annotation().colorByProperty(folder["_id"], ["propA"])
        colors = {
            str(a["_id"]): a.get("color")
            for a in Annotation().find({"datasetId": folder["_id"]})
        }
        # The value-less annotation lost its stale colour...
        assert colors[str(stale["_id"])] is None
        # ...and is reported as uncoloured.
        assert result["colored"] == 2
        assert result["uncolored"] == 1

    def testEmptyExplicitRangeIsA400(self, admin, server):
        # A single explicit bound can invert the resolved range (e.g.
        # rangeMin above the data maximum). That must be a clean 400, not a
        # silent everything-gets-the-middle-color with an inverted legend.
        folder, _ = self._makeDatasetWithValues(
            admin,
            [{"propA": 0}, {"propA": 10}],
        )
        for bounds in ({"rangeMin": 100}, {"rangeMax": -5}):
            resp = self._colorBy(
                server,
                admin,
                {
                    "datasetId": str(folder["_id"]),
                    "propertyPath": ["propA"],
                    **bounds,
                },
            )
            assertStatus(resp, 400)
            assert "range" in resp.json["message"], bounds

    def testForcedCategoricalMergesIntAndIntegralFloat(self, admin, server):
        # Workers disagree on numeric types: one writes 1 (int32), another
        # 1.0 (double). Forced categorical must not split them into two
        # categories "1" and "1.0".
        folder, ids = self._makeDatasetWithValues(
            admin,
            [{"propA": 1}, {"propA": 1.0}, {"propA": 1.5}],
        )
        resp = self._colorBy(
            server,
            admin,
            {
                "datasetId": str(folder["_id"]),
                "propertyPath": ["propA"],
                "mode": "categorical",
            },
        )
        assertStatusOk(resp)
        legend = resp.json["legend"]
        assert legend["categories"] == [
            {"value": "1", "color": CATEGORICAL_PALETTE[0], "count": 2},
            {"value": "1.5", "color": CATEGORICAL_PALETTE[1], "count": 1},
        ]
        colors = self._colorsById(folder)
        assert colors[ids[0]] == colors[ids[1]] == CATEGORICAL_PALETTE[0]

    def testNoValuesIsA400(self, admin, server):
        folder, _ = self._makeDatasetWithValues(admin, [None])
        resp = self._colorBy(
            server,
            admin,
            {"datasetId": str(folder["_id"]), "propertyPath": ["nothing"]},
        )
        assertStatus(resp, 400)
        assert "No values found" in resp.json["message"]

    def testClearResetsColorsAndReturnsNullLegend(self, admin, server):
        folder, ids = self._makeDatasetWithValues(
            admin,
            [{"propA": 1}, {"propA": 2}],
        )
        assertStatusOk(
            self._colorBy(
                server,
                admin,
                {"datasetId": str(folder["_id"]), "propertyPath": ["propA"]},
            )
        )
        resp = self._colorBy(
            server,
            admin,
            {"datasetId": str(folder["_id"]), "clear": True},
        )
        assertStatusOk(resp)
        assert resp.json == {"colored": 0, "uncolored": 2, "legend": None}
        assert all(
            color is None for color in self._colorsById(folder).values()
        )

    def testReapplyOverwritesPreviousColoring(self, admin, server):
        # Annotations colored by a first apply but missing the second
        # property must end up null, not keep the stale first color.
        folder, ids = self._makeDatasetWithValues(
            admin,
            [{"propA": 1, "propB": "x"}, {"propA": 2}],
        )
        assertStatusOk(
            self._colorBy(
                server,
                admin,
                {"datasetId": str(folder["_id"]), "propertyPath": ["propA"]},
            )
        )
        resp = self._colorBy(
            server,
            admin,
            {"datasetId": str(folder["_id"]), "propertyPath": ["propB"]},
        )
        assertStatusOk(resp)
        colors = self._colorsById(folder)
        assert colors[ids[0]] == CATEGORICAL_PALETTE[0]
        assert colors[ids[1]] is None

    def testWriteAccessIsRequired(self, admin, user, server):
        folder, _ = self._makeDatasetWithValues(admin, [{"propA": 1}])
        resp = self._colorBy(
            server,
            user,
            {"datasetId": str(folder["_id"]), "propertyPath": ["propA"]},
        )
        assertStatus(resp, 403)

    def testMalformedInputsAreClean400s(self, admin, server):
        folder, _ = self._makeDatasetWithValues(admin, [{"propA": 1}])
        datasetId = str(folder["_id"])

        cases = [
            ({"propertyPath": ["propA"]}, "datasetId is required"),
            (
                {"datasetId": datasetId, "propertyPath": "propA"},
                "propertyPath must be a non-empty list of key strings",
            ),
            (
                {"datasetId": datasetId, "propertyPath": ["bad.path"]},
                "propertyPath must be a non-empty list of key strings",
            ),
            (
                {
                    "datasetId": datasetId,
                    "propertyPath": ["propA"],
                    "mode": "rainbow",
                },
                "mode must be",
            ),
            (
                {
                    "datasetId": datasetId,
                    "propertyPath": ["propA"],
                    "colormap": "sparkles",
                },
                "colormap must be one of",
            ),
            (
                {
                    "datasetId": datasetId,
                    "propertyPath": ["propA"],
                    "rangeMin": True,
                },
                "rangeMin must be a finite number",
            ),
            (
                {
                    "datasetId": datasetId,
                    "propertyPath": ["propA"],
                    "rangeMin": 5,
                    "rangeMax": 5,
                },
                "rangeMin must be less than rangeMax",
            ),
        ]
        for body, message in cases:
            resp = self._colorBy(server, admin, body)
            assertStatus(resp, 400)
            assert message in resp.json["message"], body

    def testAssignmentIsOmittedUnlessRequested(self, admin, server):
        folder, _ = self._makeDatasetWithValues(admin, [{"propA": 1}])
        resp = self._colorBy(
            server,
            admin,
            {"datasetId": str(folder["_id"]), "propertyPath": ["propA"]},
        )
        assertStatusOk(resp)
        assert "assignment" not in resp.json

    def testAssignmentListsExactlyWhatWasWritten(self, admin, server):
        # The assignment lets a client repaint without refetching, so it must
        # match the database exactly: same ids, same colours, and annotations
        # with no value must be absent (their colour was cleared to null).
        folder, ids = self._makeDatasetWithValues(
            admin,
            [{"propA": "a"}, {"propA": "a"}, {"propA": "b"}, None],
        )
        resp = self._colorBy(
            server,
            admin,
            {
                "datasetId": str(folder["_id"]),
                "propertyPath": ["propA"],
                "mode": "categorical",
                "returnAssignment": True,
            },
        )
        assertStatusOk(resp)
        assignment = resp.json["assignment"]
        fromAssignment = {
            annotationId: group["color"]
            for group in assignment
            for annotationId in group["ids"]
        }
        stored = {
            annotationId: color
            for annotationId, color in self._colorsById(folder).items()
            if color is not None
        }
        assert fromAssignment == stored
        # The value-less annotation is in neither.
        assert ids[3] not in fromAssignment
        assert self._colorsById(folder)[ids[3]] is None
        # Ids are strings, ready for JSON/the client's id keys.
        assert all(isinstance(i, str) for g in assignment for i in g["ids"])

    def testClearReturnsAnEmptyAssignmentWhenRequested(self, admin, server):
        folder, _ = self._makeDatasetWithValues(admin, [{"propA": 1}])
        resp = self._colorBy(
            server,
            admin,
            {
                "datasetId": str(folder["_id"]),
                "clear": True,
                "returnAssignment": True,
            },
        )
        assertStatusOk(resp)
        # Empty (not absent): "everything was cleared", which the client
        # applies as "null every colour".
        assert resp.json["assignment"] == []

    def testAssignmentCoversEveryColouredAnnotationAtScale(
        self, admin, server
    ):
        # Continuous colouring quantizes into many groups; every coloured
        # annotation must appear exactly once across them.
        folder, ids = self._makeDatasetWithValues(
            admin, [{"propA": v} for v in range(60)]
        )
        resp = self._colorBy(
            server,
            admin,
            {
                "datasetId": str(folder["_id"]),
                "propertyPath": ["propA"],
                "returnAssignment": True,
            },
        )
        assertStatusOk(resp)
        assigned = [
            annotationId
            for group in resp.json["assignment"]
            for annotationId in group["ids"]
        ]
        assert len(assigned) == len(set(assigned)) == resp.json["colored"]
        assert set(assigned) == set(ids)

    def testFullCoverageSkipsTheClearingPass(self, admin, monkeypatch):
        # The clear exists so value-less annotations fall back to their layer
        # colour. When every annotation gets a colour it is pure waste, and an
        # expensive one: 4.8s directly plus ~4.5s of write contention on a
        # 708K dataset (80% of the request). Pin the skip so it can't
        # silently regress.
        folder, ids = self._makeDatasetWithValues(
            admin, [{"propA": 1}, {"propA": 2}]
        )
        calls = []
        realClear = Annotation.clearColors
        monkeypatch.setattr(
            Annotation,
            "clearColors",
            lambda self, datasetId: (
                calls.append(datasetId), realClear(self, datasetId)
            )[1],
        )
        result = Annotation().colorByProperty(folder["_id"], ["propA"])
        assert result["colored"] == 2
        assert result["uncolored"] == 0
        assert calls == []
        colors = self._colorsById(folder)
        assert all(color is not None for color in colors.values())

    def testPartialCoverageStillClears(self, admin, monkeypatch):
        # The twin of the case above: one annotation has no value, so the
        # clear must still run or it would keep a stale colour.
        folder, ids = self._makeDatasetWithValues(
            admin, [{"propA": 1}, {"propA": 2}, None]
        )
        Annotation().update(
            {"_id": ObjectId(ids[2])}, {"$set": {"color": "#123456"}}
        )
        calls = []
        realClear = Annotation.clearColors
        monkeypatch.setattr(
            Annotation,
            "clearColors",
            lambda self, datasetId: (
                calls.append(datasetId), realClear(self, datasetId)
            )[1],
        )
        result = Annotation().colorByProperty(folder["_id"], ["propA"])
        assert result["colored"] == 2
        assert result["uncolored"] == 1
        assert calls == [folder["_id"]]
        assert self._colorsById(folder)[ids[2]] is None

    def testValuesForPathResolvesNestedNullAndMalformed(self, admin):
        # Characterization test for the read path (it was rewritten from a
        # nested find() projection to a flat $project aggregation for speed).
        # Fixes the contract: nested paths resolve, nulls and missing paths
        # are skipped, and a scalar where a sub-object is expected is skipped
        # rather than raising.
        folder, ids = self._makeDatasetWithValues(
            admin,
            [
                {"propA": {"sub": 5}},        # nested hit
                {"propA": {"sub": None}},     # explicit null -> skipped
                {"propA": {"other": 1}},      # missing leaf -> skipped
                {"propA": 7},                 # scalar where dict expected
                {"propB": {"sub": 9}},        # unrelated property
                None,                          # no values document at all
            ],
        )
        pairs = dict(
            AnnotationPropertyValues().valuesForPath(
                folder["_id"], ["propA", "sub"]
            )
        )
        assert {str(k): v for k, v in pairs.items()} == {ids[0]: 5}

    def testValuesForPathReturnsScalarsAtTopLevel(self, admin):
        folder, ids = self._makeDatasetWithValues(
            admin, [{"propA": 3}, {"propA": None}, {"propB": 4}]
        )
        pairs = dict(
            AnnotationPropertyValues().valuesForPath(folder["_id"], ["propA"])
        )
        assert {str(k): v for k, v in pairs.items()} == {ids[0]: 3}

    def testOptionsListsColormapsAndPalette(self, server):
        resp = server.request(
            path="/upenn_annotation/color_by_property/options",
            method="GET",
        )
        assertStatusOk(resp)
        assert resp.json["default"] == "viridis"
        assert resp.json["palette"] == CATEGORICAL_PALETTE
        assert resp.json["colormaps"]["viridis"] == (
            CONTINUOUS_COLORMAPS["viridis"]
        )

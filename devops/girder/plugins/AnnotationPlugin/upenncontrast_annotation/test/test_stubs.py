import json
import pytest

from bson.objectid import ObjectId

from pytest_girder.assertions import assertStatus, assertStatusOk

from upenncontrast_annotation.server.helpers import validation
from upenncontrast_annotation.server.models.annotation import Annotation

from . import girder_utilities as utilities
from . import upenn_testing_utilities as upenn_utilities


def createPolygonAnnotation(datasetId, coords, tags=None,
                            shape="polygon", location=None):
    """Create a polygon annotation with specific coordinates."""
    ann = upenn_utilities.getSampleAnnotation(datasetId)
    ann["coordinates"] = coords
    ann["shape"] = shape
    if tags is not None:
        ann["tags"] = tags
    if location is not None:
        ann["location"] = location
    return Annotation().create(ann)


def parseStreamingResponse(resp):
    """Parse a streaming JSON response from a generator endpoint.

    Girder test server collapses generator responses into
    resp.body, which is a list of byte chunks.
    """
    body = b"".join(resp.body)
    return json.loads(body)


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestStubs:
    def testStubsEmpty(self, admin, server):
        """Stubs endpoint returns empty list for dataset with
        no annotations."""
        folder = utilities.createFolder(
            admin, "test_dataset", upenn_utilities.datasetMetadata
        )
        resp = server.request(
            path="/upenn_annotation/stubs",
            method="GET",
            user=admin,
            params={"datasetId": str(folder["_id"])},
            isJson=False,
        )
        assertStatusOk(resp)
        stubs = parseStreamingResponse(resp)
        assert stubs == []

    def testStubsReturnsCentroidAndRadius(self, admin, server):
        """Stubs include centroid and estimatedRadius, exclude
        coordinates."""
        folder = utilities.createFolder(
            admin, "test_dataset", upenn_utilities.datasetMetadata
        )
        coords = [
            {"x": 0, "y": 0},
            {"x": 10, "y": 0},
            {"x": 10, "y": 10},
            {"x": 0, "y": 10},
        ]
        createPolygonAnnotation(folder["_id"], coords)

        resp = server.request(
            path="/upenn_annotation/stubs",
            method="GET",
            user=admin,
            params={"datasetId": str(folder["_id"])},
            isJson=False,
        )
        assertStatusOk(resp)
        stubs = parseStreamingResponse(resp)
        assert len(stubs) == 1
        stub = stubs[0]

        # Has computed fields
        assert "centroid" in stub
        assert "estimatedRadius" in stub

        # No coordinates
        assert "coordinates" not in stub

        # Centroid is average of coords: (5, 5)
        assert stub["centroid"]["x"] == pytest.approx(5.0)
        assert stub["centroid"]["y"] == pytest.approx(5.0)

        # estimatedRadius = half the larger bbox side = max(10, 10) / 2 = 5.
        # (Matches the frontend estimateAnnotationRadius so the stub circle
        # tracks the annotation's footprint instead of its circumscribed
        # bbox-diagonal, which overshot by up to sqrt(2).)
        expected_radius = max(10, 10) / 2
        assert stub["estimatedRadius"] == pytest.approx(
            expected_radius
        )

        # Preserves metadata fields
        assert "tags" in stub
        assert "shape" in stub
        assert "channel" in stub
        assert "location" in stub
        assert "_id" in stub
        assert "datasetId" in stub

    def testStubsMultiple(self, admin, server):
        """Returns stubs for all annotations in dataset."""
        folder = utilities.createFolder(
            admin, "test_dataset", upenn_utilities.datasetMetadata
        )
        for i in range(5):
            coords = [
                {"x": i * 10, "y": 0},
                {"x": i * 10 + 10, "y": 0},
                {"x": i * 10 + 10, "y": 10},
                {"x": i * 10, "y": 10},
            ]
            createPolygonAnnotation(folder["_id"], coords)

        resp = server.request(
            path="/upenn_annotation/stubs",
            method="GET",
            user=admin,
            params={"datasetId": str(folder["_id"])},
            isJson=False,
        )
        assertStatusOk(resp)
        stubs = parseStreamingResponse(resp)
        assert len(stubs) == 5

    def testStubsShapeFilter(self, admin, server):
        """Shape filter works on stubs endpoint."""
        folder = utilities.createFolder(
            admin, "test_dataset", upenn_utilities.datasetMetadata
        )
        coords = [
            {"x": 0, "y": 0},
            {"x": 10, "y": 0},
            {"x": 10, "y": 10},
            {"x": 0, "y": 10},
        ]
        createPolygonAnnotation(
            folder["_id"], coords, shape="polygon"
        )
        createPolygonAnnotation(
            folder["_id"],
            [{"x": 5, "y": 5}],
            shape="point",
        )

        resp = server.request(
            path="/upenn_annotation/stubs",
            method="GET",
            user=admin,
            params={
                "datasetId": str(folder["_id"]),
                "shape": "polygon",
            },
            isJson=False,
        )
        assertStatusOk(resp)
        stubs = parseStreamingResponse(resp)
        assert len(stubs) == 1
        assert stubs[0]["shape"] == "polygon"

    def testStubsTagFilter(self, admin, server):
        """Tags filter works on stubs endpoint."""
        folder = utilities.createFolder(
            admin, "test_dataset", upenn_utilities.datasetMetadata
        )
        coords = [
            {"x": 0, "y": 0},
            {"x": 10, "y": 10},
        ]
        createPolygonAnnotation(
            folder["_id"], coords, tags=["alpha", "beta"]
        )
        createPolygonAnnotation(
            folder["_id"], coords, tags=["gamma"]
        )

        resp = server.request(
            path="/upenn_annotation/stubs",
            method="GET",
            user=admin,
            params={
                "datasetId": str(folder["_id"]),
                "tags": json.dumps(["alpha"]),
            },
            isJson=False,
        )
        assertStatusOk(resp)
        stubs = parseStreamingResponse(resp)
        assert len(stubs) == 1
        assert "alpha" in stubs[0]["tags"]

    def testStubsMatchPreviousPipeline(self, admin):
        """The $let pipeline returns exactly what the one that evaluated
        $coordinates.x/.y per operator did: same documents, field order and
        values (ints, a z, empty/missing/null coordinates, NaN, a stored
        `centroid` overwritten in place), in _id order, filters included."""
        folder = utilities.createFolder(
            admin, "stubs_equivalence", upenn_utilities.datasetMetadata
        )
        other = utilities.createFolder(
            admin, "stubs_equivalence_other", upenn_utilities.datasetMetadata
        )
        base = {"datasetId": folder["_id"], "tags": ["cell"], "channel": 0,
                "location": {"XY": 0, "Z": 0, "Time": 0},
                "shape": "polygon", "color": "#112233"}
        coordinateCases = [
            [
                {"x": 1.5, "y": 2.25}, {"x": 3.0, "y": 8.0},
                {"x": 0.1, "y": 0.7},
            ],
            [{"x": 1, "y": 2}, {"x": 4, "y": 10}],
            [{"x": 1.0, "y": 2.0, "z": 5.0}, {"x": 7.0, "y": 3.0, "z": 1.0}],
            [{"y": 2.0, "x": 1.0}, {"y": 6.0, "x": 9.0}],
            [{"x": float("nan"), "y": 1.0}, {"x": 2.0, "y": 3.0}],
            [],
            None,
        ]
        documents = [dict(base, coordinates=c) for c in coordinateCases]
        documents.append(dict(base))  # no coordinates at all
        documents.append(dict(
            base, centroid="stale", tags=["B Cell"], shape="point",
            coordinates=[{"x": 5.0, "y": 5.0}],
        ))
        documents.append(dict(
            base, datasetId=other["_id"], coordinates=[{"x": 1, "y": 1}]
        ))
        Annotation().collection.insert_many(documents)

        def previous(match):
            return list(Annotation().collection.aggregate([
                {"$match": match},
                {"$addFields": {
                    "centroid": {
                        "x": {"$avg": "$coordinates.x"},
                        "y": {"$avg": "$coordinates.y"},
                    },
                    "estimatedRadius": {"$divide": [
                        {"$max": [
                            {"$subtract": [
                                {"$max": "$coordinates.x"},
                                {"$min": "$coordinates.x"},
                            ]},
                            {"$subtract": [
                                {"$max": "$coordinates.y"},
                                {"$min": "$coordinates.y"},
                            ]},
                        ]},
                        2,
                    ]},
                }},
                {"$project": {"coordinates": 0}},
            ], hint={"datasetId": 1, "_id": 1}))

        def encoded(documents):
            return [json.dumps(d, default=str) for d in documents]

        stubs = list(Annotation().stubs(folder["_id"]))
        assert len(stubs) == 9
        assert encoded(stubs) == encoded(
            previous({"datasetId": folder["_id"]})
        )
        assert [s["_id"] for s in stubs] == sorted(s["_id"] for s in stubs)
        filtered = list(Annotation().stubs(
            folder["_id"], shape="point", tags=["B Cell"]
        ))
        assert encoded(filtered) == encoded(previous({
            "datasetId": folder["_id"], "shape": "point",
            "tags": {"$all": ["B Cell"]},
        }))
        # The stored `centroid` is replaced where it stood, not appended.
        assert filtered[0]["centroid"] == {"x": 5.0, "y": 5.0}

    def testStubsInvalidDataset(self, admin, server):
        """Returns 400 for nonexistent dataset."""
        resp = server.request(
            path="/upenn_annotation/stubs",
            method="GET",
            user=admin,
            params={
                "datasetId": "012345678901234567890123"
            },
        )
        assertStatus(resp, 400)

    def testStubsMalformedDatasetReturns400(self, admin, server):
        """A non-ObjectId datasetId is a clean 400, not a 500."""
        resp = server.request(
            path="/upenn_annotation/stubs",
            method="GET",
            user=admin,
            params={"datasetId": "not-an-object-id"},
        )
        assertStatus(resp, 400)

    def testStubsPointAnnotation(self, admin, server):
        """Single-coordinate point has zero radius and centroid
        at that point."""
        folder = utilities.createFolder(
            admin, "test_dataset", upenn_utilities.datasetMetadata
        )
        createPolygonAnnotation(
            folder["_id"],
            [{"x": 42, "y": 99}],
            shape="point",
        )

        resp = server.request(
            path="/upenn_annotation/stubs",
            method="GET",
            user=admin,
            params={"datasetId": str(folder["_id"])},
            isJson=False,
        )
        assertStatusOk(resp)
        stubs = parseStreamingResponse(resp)
        assert len(stubs) == 1
        assert stubs[0]["centroid"]["x"] == pytest.approx(42)
        assert stubs[0]["centroid"]["y"] == pytest.approx(99)
        assert stubs[0]["estimatedRadius"] == pytest.approx(0)


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestHydrate:
    def testHydrateEmpty(self, admin, server):
        """Empty ID list returns empty array."""
        resp = server.request(
            path="/upenn_annotation/hydrate",
            method="POST",
            user=admin,
            body=json.dumps([]),
            type="application/json",
            isJson=False,
        )
        assertStatusOk(resp)
        result = parseStreamingResponse(resp)
        assert result == []

    def testHydrateReturnsFullDocuments(self, admin, server):
        """Hydrate returns full annotations with coordinates."""
        folder = utilities.createFolder(
            admin, "test_dataset", upenn_utilities.datasetMetadata
        )
        coords = [
            {"x": 0, "y": 0},
            {"x": 10, "y": 0},
            {"x": 10, "y": 10},
            {"x": 0, "y": 10},
        ]
        ann = createPolygonAnnotation(folder["_id"], coords)
        ann_id = str(ann["_id"])

        resp = server.request(
            path="/upenn_annotation/hydrate",
            method="POST",
            user=admin,
            body=json.dumps([ann_id]),
            type="application/json",
            isJson=False,
        )
        assertStatusOk(resp)
        result = parseStreamingResponse(resp)
        assert len(result) == 1
        assert result[0]["_id"] == ann_id
        assert "coordinates" in result[0]
        assert len(result[0]["coordinates"]) == 4

    def testHydrateMultiple(self, admin, server):
        """Can hydrate multiple annotations at once."""
        folder = utilities.createFolder(
            admin, "test_dataset", upenn_utilities.datasetMetadata
        )
        ids = []
        for i in range(5):
            coords = [
                {"x": i * 10, "y": 0},
                {"x": i * 10 + 10, "y": 10},
            ]
            ann = createPolygonAnnotation(
                folder["_id"], coords, shape="line"
            )
            ids.append(str(ann["_id"]))

        resp = server.request(
            path="/upenn_annotation/hydrate",
            method="POST",
            user=admin,
            body=json.dumps(ids),
            type="application/json",
            isJson=False,
        )
        assertStatusOk(resp)
        result = parseStreamingResponse(resp)
        assert len(result) == 5
        returned_ids = {r["_id"] for r in result}
        assert returned_ids == set(ids)

    def testHydrateSubset(self, admin, server):
        """Can hydrate a subset of annotations in a dataset."""
        folder = utilities.createFolder(
            admin, "test_dataset", upenn_utilities.datasetMetadata
        )
        ids = []
        for i in range(5):
            ann = createPolygonAnnotation(
                folder["_id"],
                [{"x": i, "y": i}],
                shape="point",
            )
            ids.append(str(ann["_id"]))

        # Only hydrate first 2
        resp = server.request(
            path="/upenn_annotation/hydrate",
            method="POST",
            user=admin,
            body=json.dumps(ids[:2]),
            type="application/json",
            isJson=False,
        )
        assertStatusOk(resp)
        result = parseStreamingResponse(resp)
        assert len(result) == 2

    def testHydrateAccessDenied(self, admin, user, server):
        """User without access to the dataset cannot hydrate."""
        folder = utilities.createPrivateFolder(
            admin, "private_dataset",
            upenn_utilities.datasetMetadata,
        )
        ann = createPolygonAnnotation(
            folder["_id"],
            [{"x": 1, "y": 2}],
            shape="point",
        )

        resp = server.request(
            path="/upenn_annotation/hydrate",
            method="POST",
            user=user,
            body=json.dumps([str(ann["_id"])]),
            type="application/json",
            isJson=False,
        )
        assertStatus(resp, 403)

    def testHydrateNonexistentIds(self, admin, server):
        """Nonexistent IDs return empty result (no error)."""
        resp = server.request(
            path="/upenn_annotation/hydrate",
            method="POST",
            user=admin,
            body=json.dumps(["012345678901234567890123"]),
            type="application/json",
            isJson=False,
        )
        assertStatusOk(resp)
        result = parseStreamingResponse(resp)
        # No matching annotations, and no datasets to check
        # access on — returns empty
        assert result == []

    def testHydrateAnnotationIdsCapRejectsOversized(
        self, admin, server, monkeypatch
    ):
        # A degenerate id list is rejected (a sanity ceiling; the cap is read
        # at call time so we can shrink it for the test).
        monkeypatch.setattr(validation, "MAX_ANNOTATION_IDS", 2)
        ids = ["012345678901234567890123"] * 3
        resp = server.request(
            path="/upenn_annotation/hydrate",
            method="POST",
            user=admin,
            body=json.dumps(ids),
            type="application/json",
            isJson=False,
        )
        assertStatus(resp, 400)

    def testHydrateMalformedIdReturns400(self, admin, server):
        # A non-ObjectId in the id list is a clean 400, not an uncaught
        # bson.InvalidId -> 500.
        resp = server.request(
            path="/upenn_annotation/hydrate",
            method="POST",
            user=admin,
            body=json.dumps(["not-an-object-id"]),
            type="application/json",
            isJson=False,
        )
        assertStatus(resp, 400)


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestDistinctDatasetIds:
    """Model helper backing the hydrate/deleteMultiple access checks."""

    def testReturnsDistinctDatasetsForIds(self, admin):
        folderA = utilities.createFolder(
            admin, "ds_a", upenn_utilities.datasetMetadata
        )
        folderB = utilities.createFolder(
            admin, "ds_b", upenn_utilities.datasetMetadata
        )
        idsA = [
            createPolygonAnnotation(folderA["_id"], [{"x": 0, "y": 0}])["_id"]
            for _ in range(3)
        ]
        idsB = [
            createPolygonAnnotation(folderB["_id"], [{"x": 0, "y": 0}])["_id"]
            for _ in range(2)
        ]
        result = Annotation().distinctDatasetIds(idsA + idsB)
        assert set(result) == {folderA["_id"], folderB["_id"]}

    def testEmptyInputReturnsEmpty(self, admin):
        assert Annotation().distinctDatasetIds([]) == []

    def testNonexistentIdsReturnEmpty(self, admin):
        assert (
            Annotation().distinctDatasetIds(
                [ObjectId("012345678901234567890123")]
            )
            == []
        )

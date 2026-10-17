import json

import pytest

from pytest_girder.assertions import assertStatus, assertStatusOk

from upenncontrast_annotation.server.models.annotation import Annotation
from upenncontrast_annotation.server.models.connections import (
    AnnotationConnection,
)
from upenncontrast_annotation.server.models.propertyValues import (
    AnnotationPropertyValues,
)
from upenncontrast_annotation.server.models.collection import Collection

from . import girder_utilities as utilities
from . import upenn_testing_utilities as upenn_utilities


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestAnnotationCount:
    def testAnnotationCountEmpty(self, admin, server):
        """Test count returns 0 for empty dataset"""
        folder = utilities.createFolder(
            admin, "test_dataset", upenn_utilities.datasetMetadata
        )
        datasetId = str(folder["_id"])

        resp = server.request(
            path="/upenn_annotation/count",
            method="GET",
            user=admin,
            params={"datasetId": datasetId},
        )
        assertStatusOk(resp)
        assert resp.json["count"] == 0

    def testAnnotationCountMultiple(self, admin, server):
        """Test count returns correct number after creating annotations"""
        folder = utilities.createFolder(
            admin, "test_dataset", upenn_utilities.datasetMetadata
        )
        datasetId = str(folder["_id"])

        # Create 5 annotations
        for _ in range(5):
            annotation = upenn_utilities.getSampleAnnotation(folder["_id"])
            Annotation().create(annotation)

        resp = server.request(
            path="/upenn_annotation/count",
            method="GET",
            user=admin,
            params={"datasetId": datasetId},
        )
        assertStatusOk(resp)
        assert resp.json["count"] == 5

    def testAnnotationCountWithShapeFilter(self, admin, server):
        """Test count with shape filter"""
        folder = utilities.createFolder(
            admin, "test_dataset", upenn_utilities.datasetMetadata
        )
        datasetId = str(folder["_id"])

        # Create annotations with different shapes
        for _ in range(3):
            annotation = upenn_utilities.getSampleAnnotation(folder["_id"])
            annotation["shape"] = "point"
            Annotation().create(annotation)

        for _ in range(2):
            annotation = upenn_utilities.getSampleAnnotation(folder["_id"])
            annotation["shape"] = "polygon"
            Annotation().create(annotation)

        # Count all
        resp = server.request(
            path="/upenn_annotation/count",
            method="GET",
            user=admin,
            params={"datasetId": datasetId},
        )
        assertStatusOk(resp)
        assert resp.json["count"] == 5

        # Count points only
        resp = server.request(
            path="/upenn_annotation/count",
            method="GET",
            user=admin,
            params={"datasetId": datasetId, "shape": "point"},
        )
        assertStatusOk(resp)
        assert resp.json["count"] == 3

        # Count polygons only
        resp = server.request(
            path="/upenn_annotation/count",
            method="GET",
            user=admin,
            params={"datasetId": datasetId, "shape": "polygon"},
        )
        assertStatusOk(resp)
        assert resp.json["count"] == 2

    def testAnnotationCountInvalidDataset(self, admin, server):
        """Test count with invalid dataset ID returns error"""
        resp = server.request(
            path="/upenn_annotation/count",
            method="GET",
            user=admin,
            params={"datasetId": "012345678901234567890123"},
        )
        # Should return 400 or similar error
        assertStatus(resp, 400)


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestConnectionCount:
    def testConnectionCountEmpty(self, admin, server):
        """Test connection count returns 0 for empty dataset"""
        folder = utilities.createFolder(
            admin, "test_dataset", upenn_utilities.datasetMetadata
        )
        datasetId = str(folder["_id"])

        resp = server.request(
            path="/annotation_connection/count",
            method="GET",
            user=admin,
            params={"datasetId": datasetId},
        )
        assertStatusOk(resp)
        assert resp.json["count"] == 0

    def testConnectionCountMultiple(self, admin, server):
        """Test connection count returns correct number"""
        folder = utilities.createFolder(
            admin, "test_dataset", upenn_utilities.datasetMetadata
        )
        datasetId = str(folder["_id"])

        # Create annotations first
        parent = Annotation().create(
            upenn_utilities.getSampleAnnotation(folder["_id"])
        )
        child = Annotation().create(
            upenn_utilities.getSampleAnnotation(folder["_id"])
        )

        # Create 3 connections
        for _ in range(3):
            connection = upenn_utilities.getSampleConnection(
                parent["_id"], child["_id"], folder["_id"]
            )
            AnnotationConnection().create(connection)

        resp = server.request(
            path="/annotation_connection/count",
            method="GET",
            user=admin,
            params={"datasetId": datasetId},
        )
        assertStatusOk(resp)
        assert resp.json["count"] == 3

    def testConnectionCountInvalidDataset(self, admin, server):
        """Test connection count with invalid dataset ID returns error"""
        resp = server.request(
            path="/annotation_connection/count",
            method="GET",
            user=admin,
            params={"datasetId": "012345678901234567890123"},
        )
        assertStatus(resp, 400)


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestPropertyValuesCount:
    def testPropertyValuesCountEmpty(self, admin, server):
        """Test property values count returns 0 for empty dataset"""
        folder = utilities.createFolder(
            admin, "test_dataset", upenn_utilities.datasetMetadata
        )
        datasetId = str(folder["_id"])

        resp = server.request(
            path="/annotation_property_values/count",
            method="GET",
            user=admin,
            params={"datasetId": datasetId},
        )
        assertStatusOk(resp)
        assert resp.json["count"] == 0

    def testPropertyValuesCountMultiple(self, admin, server):
        """Test property values count returns correct number"""
        folder = utilities.createFolder(
            admin, "test_dataset", upenn_utilities.datasetMetadata
        )
        datasetId = str(folder["_id"])

        # Create annotations and add property values
        for i in range(4):
            annotation = Annotation().create(
                upenn_utilities.getSampleAnnotation(folder["_id"])
            )
            # Add property values for this annotation
            AnnotationPropertyValues().appendValues(
                {"testProperty": i * 10},
                annotation["_id"],
                folder["_id"],
            )

        resp = server.request(
            path="/annotation_property_values/count",
            method="GET",
            user=admin,
            params={"datasetId": datasetId},
        )
        assertStatusOk(resp)
        assert resp.json["count"] == 4

    def testPropertyValuesCountInvalidDataset(self, admin, server):
        """Test property values count with invalid dataset ID returns error"""
        resp = server.request(
            path="/annotation_property_values/count",
            method="GET",
            user=admin,
            params={"datasetId": "012345678901234567890123"},
        )
        assertStatus(resp, 400)


def getDefaultConfigMetadata():
    """Return default configuration metadata matching CollectionSchema
    requirements"""
    return {
        "subtype": "contrastConfiguration",
        "compatibility": {},
        "layers": [],
        "tools": [],
        "propertyIds": [],
        "snapshots": [],
        "scales": {},
    }


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestPropertyCount:
    def testPropertyCountEmpty(self, admin, server):
        """Test property count returns 0 for configuration with no
        properties"""
        folder = utilities.createFolder(
            admin, "test_dataset", upenn_utilities.datasetMetadata
        )

        # Create a configuration without properties
        metadata = getDefaultConfigMetadata()
        config = Collection().createCollection(
            "Test Config", admin, folder, metadata
        )

        resp = server.request(
            path="/annotation_property/count",
            method="GET",
            user=admin,
            params={"configurationId": str(config["_id"])},
        )
        assertStatusOk(resp)
        assert resp.json["count"] == 0

    def testPropertyCountWithProperties(self, admin, server):
        """Test property count returns correct number"""
        folder = utilities.createFolder(
            admin, "test_dataset", upenn_utilities.datasetMetadata
        )

        # Create a configuration with property IDs
        metadata = getDefaultConfigMetadata()
        metadata["propertyIds"] = ["prop1", "prop2", "prop3"]
        config = Collection().createCollection(
            "Test Config", admin, folder, metadata
        )

        resp = server.request(
            path="/annotation_property/count",
            method="GET",
            user=admin,
            params={"configurationId": str(config["_id"])},
        )
        assertStatusOk(resp)
        assert resp.json["count"] == 3

    def testPropertyCountInvalidConfig(self, admin, server):
        """Test property count with invalid configuration ID"""
        resp = server.request(
            path="/annotation_property/count",
            method="GET",
            user=admin,
            params={"configurationId": "012345678901234567890123"},
        )
        # Should return 400 (ValidationException from exc=True)
        assertStatus(resp, 400)


def postCounts(server, user, body):
    return server.request(
        path="/upenn_annotation/counts", method="POST", user=user,
        body=json.dumps(body), type="application/json",
    )


def addAnnotations(datasetId, shape, tags, n):
    for _ in range(n):
        annotation = upenn_utilities.getSampleAnnotation(datasetId)
        annotation["shape"] = shape
        annotation["tags"] = tags
        Annotation().create(annotation)


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestBatchAnnotationCounts:
    def testCountsPerDatasetWithFilters(self, admin, server):
        first = utilities.createFolder(
            admin, "first", upenn_utilities.datasetMetadata)
        second = utilities.createFolder(
            admin, "second", upenn_utilities.datasetMetadata)
        empty = utilities.createFolder(
            admin, "empty", upenn_utilities.datasetMetadata)
        addAnnotations(first["_id"], "point", ["spot"], 3)
        addAnnotations(first["_id"], "polygon", ["cell", "big"], 2)
        addAnnotations(second["_id"], "polygon", ["cell"], 4)
        ids = [str(second["_id"]), str(first["_id"]), str(empty["_id"])]

        resp = postCounts(server, admin, {"datasetIds": ids + ids[:1]})
        assertStatusOk(resp)
        # Request order, duplicates dropped, an empty dataset counts 0.
        assert resp.json["counts"] == [
            {"datasetId": ids[0], "count": 4},
            {"datasetId": ids[1], "count": 5},
            {"datasetId": ids[2], "count": 0},
        ]
        resp = postCounts(server, admin, {
            "datasetIds": ids, "shape": "polygon", "tags": ["cell", "big"],
        })
        assertStatusOk(resp)
        # Same filters as GET count: every tag must be present.
        assert [c["count"] for c in resp.json["counts"]] == [0, 2, 0]

    def testCountsMatchSingleDatasetCount(self, admin, server):
        folder = utilities.createFolder(
            admin, "ds", upenn_utilities.datasetMetadata)
        addAnnotations(folder["_id"], "polygon", ["a", "b"], 2)
        addAnnotations(folder["_id"], "polygon", ["a"], 3)
        for params in ({}, {"shape": "polygon"}, {"tags": ["a", "b"]}):
            single = server.request(
                path="/upenn_annotation/count", method="GET", user=admin,
                params={"datasetId": str(folder["_id"]),
                        **{k: json.dumps(v) if k == "tags" else v
                           for k, v in params.items()}},
            )
            batch = postCounts(server, admin, {
                "datasetIds": [str(folder["_id"])], **params,
            })
            assert batch.json["counts"][0]["count"] == single.json["count"]

    def testUnreadableDatasetsGetAnErrorEntry(self, admin, user, server):
        readable = utilities.createFolder(
            admin, "public", upenn_utilities.datasetMetadata)
        private = utilities.createPrivateFolder(
            admin, "private", upenn_utilities.datasetMetadata)
        addAnnotations(readable["_id"], "point", [], 2)
        addAnnotations(private["_id"], "point", [], 7)
        missing = "000000000000000000000000"
        resp = postCounts(server, user, {"datasetIds": [
            str(private["_id"]), str(readable["_id"]), missing, "typo",
            "y" * 64,
        ]})
        assertStatusOk(resp)
        assert resp.json["counts"] == [
            # Unreadable and nonexistent look the same.
            {"datasetId": str(private["_id"]),
             "error": "not found or not readable"},
            {"datasetId": str(readable["_id"]), "count": 2},
            {"datasetId": missing, "error": "not found or not readable"},
            # A mistyped id fails only its own entry, up to the length
            # cap (64 characters; longer is a 400).
            {"datasetId": "typo", "error": "not a valid id"},
            {"datasetId": "y" * 64, "error": "not a valid id"},
        ]
        # Anonymous callers see public datasets only.
        resp = postCounts(server, None, {"datasetIds": [
            str(readable["_id"]), str(private["_id"]),
        ]})
        assertStatusOk(resp)
        assert "count" in resp.json["counts"][0]
        assert "error" in resp.json["counts"][1]

    @pytest.mark.parametrize("body", [
        [],
        {},
        {"datasetIds": "abc"},
        {"datasetIds": [123]},
        {"datasetIds": [None]},
        # Long junk is refused, not echoed back as an error entry.
        {"datasetIds": ["x" * 65]},
        {"datasetIds": ["000000000000000000000000"] * 101},
        {"datasetIds": [], "shape": 3},
        {"datasetIds": [], "shape": "hexagon"},
        {"datasetIds": [], "shape": "x" * 10_000},
        {"datasetIds": [], "tags": "cell"},
        {"datasetIds": [], "tags": [1]},
        # Falsy non-lists must not read as "no filter".
        {"datasetIds": [], "tags": {}},
        {"datasetIds": [], "tags": ""},
        # Bounded on a public endpoint: how many tags, and how long.
        {"datasetIds": [], "tags": ["t"] * 101},
        {"datasetIds": [], "tags": ["x" * 1001]},
    ])
    def testMalformedBodiesAre400(self, admin, server, body):
        assertStatus(postCounts(server, admin, body), 400)

    @pytest.mark.parametrize("shape", [None, ""])
    def testEmptyShapeMeansNoFilter(self, admin, server, shape):
        # As in GET count, where an empty shape filters nothing.
        folder = utilities.createFolder(
            admin, "ds", upenn_utilities.datasetMetadata)
        addAnnotations(folder["_id"], "point", [], 2)
        addAnnotations(folder["_id"], "polygon", [], 1)
        resp = postCounts(server, admin, {
            "datasetIds": [str(folder["_id"])], "shape": shape,
        })
        assertStatusOk(resp)
        assert resp.json["counts"][0]["count"] == 3

import json
import pytest
import math

from pytest_girder.assertions import assertStatusOk

from upenncontrast_annotation.server.models.annotation import Annotation
from upenncontrast_annotation.server.models.connections import (
    AnnotationConnection,
)
from upenncontrast_annotation.server.models import connections
from upenncontrast_annotation.server.helpers.connections import (
    annotationToAnnotationDistance,
    isAPoint,
    isAPoly,
    simpleCentroid,
    pointToPointDistance,
)

from . import girder_utilities as utilities
from . import upenn_testing_utilities as upenn_utilities

from girder.exceptions import ValidationException
from girder.models.folder import Folder


def createTwoAnnotations(user):
    dataset = utilities.createFolder(
        user, "dataset", upenn_utilities.datasetMetadata
    )

    parentData = upenn_utilities.getSampleAnnotation(dataset["_id"])
    parent = Annotation().create(parentData)

    childData = upenn_utilities.getSampleAnnotation(dataset["_id"])
    child = Annotation().create(childData)
    return (parent, child, dataset)


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestConnection:
    def testAnnotationSchema(self):
        schema = connections.ConnectionSchema
        assert schema.connectionSchema is not None
        assert schema.tagsSchema is not None

    def testConnectionCreate(self, admin):
        (parent, child, dataset) = createTwoAnnotations(admin)

        connection = upenn_utilities.getSampleConnection(
            parent["_id"], child["_id"], dataset["_id"]
        )
        result = AnnotationConnection().create(connection)
        assert "_id" in result
        annotId = result["_id"]
        result = AnnotationConnection().load(annotId, user=admin)
        assert result is not None
        assert result["label"] == connection["label"]

    def testLoad(self, admin):
        with pytest.raises(Exception, match="Invalid ObjectId"):
            AnnotationConnection().load("nosuchid", user=admin)
        assert (
            AnnotationConnection().load("012345678901234567890123", user=admin)
            is None
        )

        (parent, child, dataset) = createTwoAnnotations(admin)
        connection = upenn_utilities.getSampleConnection(
            parent["_id"], child["_id"], dataset["_id"]
        )
        result = AnnotationConnection().create(connection)

        loaded = AnnotationConnection().load(result["_id"], user=admin)
        assert (
            loaded["_id"] == result["_id"]
            and loaded["label"] == connection["label"]
        )

    def testRemove(self, user, admin):
        (parent, child, dataset) = createTwoAnnotations(user)
        connectionData = upenn_utilities.getSampleConnection(
            parent["_id"], child["_id"], dataset["_id"]
        )
        connection = AnnotationConnection().create(connectionData)

        assert (
            AnnotationConnection().load(
                connection["_id"], force=True
            ) is not None
        )
        result = AnnotationConnection().remove(connection)
        assert result.deleted_count == 1
        assert (
            AnnotationConnection().load(connection["_id"], force=True) is None
        )

    def testOnAnnotationRemove(self, user, admin):
        (annotation1, annotation2, dataset) = createTwoAnnotations(admin)
        connection = upenn_utilities.getSampleConnection(
            annotation1["_id"], annotation2["_id"], dataset["_id"]
        )
        connectionInv = upenn_utilities.getSampleConnection(
            annotation2["_id"], annotation1["_id"], dataset["_id"]
        )

        result = AnnotationConnection().create(connection)
        resultInv = AnnotationConnection().create(connectionInv)

        # Create a few additional connections to test with the cursor
        AnnotationConnection().create(connection)
        AnnotationConnection().create(connection)
        AnnotationConnection().create(connectionInv)
        AnnotationConnection().create(connectionInv)

        loaded = AnnotationConnection().load(result["_id"], user=admin)
        loadedInv = AnnotationConnection().load(resultInv["_id"], user=admin)
        assert loaded is not None
        assert loadedInv is not None

        Annotation().remove(annotation1)
        loaded = AnnotationConnection().load(result["_id"], user=admin)
        loadedInv = AnnotationConnection().load(resultInv["_id"], user=admin)
        assert loaded is None
        assert loadedInv is None

        query = {
            "$or": [
                {"parentId": annotation1["_id"]},
                {"childId": annotation2["_id"]},
            ]
        }
        cursor = AnnotationConnection().find(query, limit=2)
        assert len(list(cursor)) == 0

    def testOnDatasetRemove(self, admin):
        (parent, child, dataset) = createTwoAnnotations(admin)
        connection = upenn_utilities.getSampleConnection(
            parent["_id"], child["_id"], dataset["_id"]
        )
        result = AnnotationConnection().create(connection)

        assert result is not None
        Folder().remove(dataset)
        test = Annotation().load(child["_id"], user=admin)
        assert test is None
        loaded = AnnotationConnection().load(connection["_id"], user=admin)
        assert loaded is None

    def testValidate(self, db, admin):
        # Test with missing child, missing parent, missing dataset
        (parent, child, dataset) = createTwoAnnotations(admin)
        connection = upenn_utilities.getSampleConnection(
            "012345678901234567890123", child["_id"], dataset["_id"]
        )
        with pytest.raises(
            ValidationException, match="A parent annotation does not exist"
        ):
            AnnotationConnection().validate(connection)

        connection = upenn_utilities.getSampleConnection(
            parent["_id"], "012345678901234567890123", dataset["_id"]
        )
        with pytest.raises(
            ValidationException, match="A child annotation does not exist"
        ):
            AnnotationConnection().validate(connection)

        connection = upenn_utilities.getSampleConnection(
            parent["_id"], child["_id"], "012345678901234567890123"
        )
        with pytest.raises(
            ValidationException, match="Connection dataset ID is invalid"
        ):
            AnnotationConnection().validate(connection)

        empty = {}
        with pytest.raises(ValidationException):
            AnnotationConnection().validate(empty)

        folder = utilities.createFolder(admin, "notADataset", {})
        connection = upenn_utilities.getSampleConnection(
            parent["_id"], child["_id"], folder["_id"]
        )
        with pytest.raises(
            ValidationException, match="Connection dataset ID is invalid"
        ):
            AnnotationConnection().validate(connection)


@pytest.mark.plugin("upenncontrast_annotation")
class TestConnectToNearest:
    pointAnnotationRef = {
        "_id": "0",
        "channel": 0,
        "coordinates": [{"x": 11, "y": 8, "z": 0}],
        "datasetId": "111",
        "location": {"Time": 0, "XY": 0, "Z": 0},
        "shape": "point",
        "tags": ["reference"],
    }
    pointAnnotations = [
        {
            "_id": "1",
            "channel": 0,
            "coordinates": [{"x": 6, "y": 7, "z": 0}],
            "datasetId": "111",
            "location": {"Time": 0, "XY": 0, "Z": 0},
            "shape": "point",
            "tags": ["other"],
        },
        {
            "_id": "2",
            "channel": 0,
            "coordinates": [{"x": 14, "y": 5, "z": 0}],
            "datasetId": "111",
            "location": {"Time": 0, "XY": 0, "Z": 0},
            "shape": "point",
            "tags": ["others"],
        },
    ]
    lineAnnotations = [
        {
            "_id": "3",
            "channel": 0,
            "coordinates": [
                {"x": 2, "y": 6, "z": 0},
                {"x": 6, "y": 11, "z": 0},
            ],
            "datasetId": "111",
            "location": {"Time": 0, "XY": 0, "Z": 0},
            "shape": "line",
            "tags": ["other"],
        },
        {
            "_id": "4",
            "channel": 0,
            "coordinates": [
                {"x": 20, "y": 2, "z": 0},
                {"x": 21, "y": 9, "z": 0},
            ],
            "datasetId": "111",
            "location": {"Time": 0, "XY": 0, "Z": 0},
            "shape": "line",
            "tags": ["others"],
        },
    ]
    blobAnnotations = [
        {
            "_id": "5",
            "channel": 0,
            "coordinates": [
                {"x": 7, "y": 3, "z": 0},
                {"x": 9, "y": 5, "z": 0},
                {"x": 11, "y": 3, "z": 0},
                {"x": 9, "y": 1, "z": 0},
            ],
            "datasetId": "111",
            "location": {"Time": 0, "XY": 0, "Z": 0},
            "shape": "polygon",
            "tags": ["other"],
        },
        {
            "_id": "6",
            "channel": 0,
            "coordinates": [
                {"x": 16, "y": 12, "z": 0},
                {"x": 18, "y": 14, "z": 0},
                {"x": 20, "y": 12, "z": 0},
                {"x": 18, "y": 10, "z": 0},
            ],
            "datasetId": "111",
            "location": {"Time": 0, "XY": 0, "Z": 0},
            "shape": "polygon",
            "tags": ["others"],
        },
    ]

    def testIsAPoint(self):
        assert isAPoint({"shape": "point"}) is True
        assert isAPoint({"shape": "line"}) is False
        assert isAPoint({"shape": "polygon"}) is False

    def testIsAPoly(self):
        assert isAPoly({"shape": "point"}) is False
        assert isAPoly({"shape": "line"}) is True
        assert isAPoly({"shape": "polygon"}) is True

    def testSimpleCentroid(self):
        triangleCoordinates = [
            {
                "x": 6,
                "y": 2,
                "z": 0,
            },
            {
                "x": 5,
                "y": -9,
                "z": 0,
            },
            {
                "x": 2,
                "y": -7,
                "z": 0,
            },
        ]
        centroid = simpleCentroid(triangleCoordinates)
        assert centroid["x"] == 4.333333333333333
        assert centroid["y"] == -4.666666666666667
        assert centroid["z"] == 0.0

        triangleCoordinates = [
            {
                "x": 6,
                "y": 2,
            },
            {
                "x": 5,
                "y": -9,
                "z": 0,
            },
            {
                "x": 2,
                "y": -7,
                "z": 0,
            },
        ]
        centroid = simpleCentroid(triangleCoordinates)
        assert centroid["x"] == 4.333333333333333
        assert centroid["y"] == -4.666666666666667
        assert "z" not in centroid

        triangleCoordinates = [
            {
                "x": 6,
                "y": 2,
                "z": 1,
            },
            {
                "x": 5,
                "y": -9,
                "z": 7,
            },
            {
                "x": 2,
                "y": -7,
                "z": 4,
            },
        ]
        centroid = simpleCentroid(triangleCoordinates)
        assert centroid["x"] == 4.333333333333333
        assert centroid["y"] == -4.666666666666667
        assert centroid["z"] == 4.0

    def testPointToPointDistance(self):
        coordPoint1 = {
            "x": 0,
            "y": 0,
            "z": 0,
        }
        coordPoint2 = {
            "x": 0,
            "y": 0,
            "z": 2,
        }
        assert pointToPointDistance(coordPoint1, coordPoint2) == 2

        coordPoint1 = {
            "x": 0,
            "y": 0,
        }
        coordPoint2 = {
            "x": 4,
            "y": 0,
            "z": 10,
        }
        assert pointToPointDistance(coordPoint1, coordPoint2) == 4

        coordPoint1 = {
            "x": 0,
            "y": 0,
            "z": 0,
        }
        coordPoint2 = {
            "x": 0,
            "y": 0,
            "z": 0,
        }
        assert pointToPointDistance(coordPoint1, coordPoint2) == 0

        coordPoint1 = {
            "x": 3,
            "y": 0,
            "z": 5,
        }
        coordPoint2 = {
            "x": 0,
            "y": -5,
        }
        assert (
            abs(pointToPointDistance(coordPoint1, coordPoint2) - math.sqrt(34))
            < 0.000000000000001
        )

        coordPoint1 = {
            "x": 1,
            "y": 4,
            "z": -6,
        }
        coordPoint2 = {
            "x": 2,
            "y": 10,
            "z": -10,
        }
        assert (
            abs(pointToPointDistance(coordPoint1, coordPoint2) - math.sqrt(53))
            < 0.000000000000001
        )

    def testAnnotationToAnnotationDistance(self):
        distance = annotationToAnnotationDistance(
            self.pointAnnotations[0], self.pointAnnotations[1]
        )
        assert distance == math.sqrt(68)
        distance = annotationToAnnotationDistance(
            self.pointAnnotations[0], self.lineAnnotations[0]
        )
        # Distance is computed to the centroid of the line, not endpoints
        assert distance == 2.5
        distance = annotationToAnnotationDistance(
            self.blobAnnotations[0], self.blobAnnotations[1]
        )
        assert distance == math.sqrt(162)

    def testGetClosestAnnotation(self, db):
        closest, _ = AnnotationConnection().getClosestAnnotation(
            self.pointAnnotationRef, self.pointAnnotations
        )
        assert closest == self.pointAnnotations[1]

        closest, _ = AnnotationConnection().getClosestAnnotation(
            self.pointAnnotationRef, self.lineAnnotations
        )
        assert closest == self.lineAnnotations[0]

        closest, _ = AnnotationConnection().getClosestAnnotation(
            self.pointAnnotationRef, self.blobAnnotations
        )
        assert closest == self.blobAnnotations[0]

        annotations = (
            self.pointAnnotations + self.lineAnnotations + self.blobAnnotations
        )
        annotations.append(self.pointAnnotationRef)
        closest, _ = AnnotationConnection().getClosestAnnotation(
            self.pointAnnotationRef, annotations
        )
        assert closest == self.pointAnnotations[1]

        (
            closestPoint,
            minDistanceToPoint,
        ) = AnnotationConnection().getClosestAnnotation(
            self.blobAnnotations[0], self.pointAnnotations
        )
        assert closestPoint == self.pointAnnotations[0]

        (
            closestLine,
            minDistanceToLine,
        ) = AnnotationConnection().getClosestAnnotation(
            self.blobAnnotations[0], self.lineAnnotations
        )
        assert closestLine == self.lineAnnotations[0]

        (
            closestBlob,
            minDistanceToBlob,
        ) = AnnotationConnection().getClosestAnnotation(
            self.blobAnnotations[0], self.blobAnnotations
        )
        assert closestBlob == self.blobAnnotations[1]

        closest, minDistance = AnnotationConnection().getClosestAnnotation(
            self.blobAnnotations[0], annotations
        )
        assert minDistance == min(
            minDistanceToPoint, minDistanceToLine, minDistanceToBlob
        )
        assert closest == closestPoint


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestConnectionEndpoints:
    """REST API endpoint tests for annotation connections."""

    def testCreateEndpoint(self, admin, server):
        """Test POST /annotation_connection creates a connection."""
        (parent, child, dataset) = createTwoAnnotations(admin)
        connection = upenn_utilities.getSampleConnection(
            str(parent["_id"]),
            str(child["_id"]),
            str(dataset["_id"]),
        )
        resp = server.request(
            path="/annotation_connection",
            method="POST",
            user=admin,
            body=json.dumps(connection),
            type="application/json",
        )
        assertStatusOk(resp)
        assert "_id" in resp.json
        assert resp.json["label"] == connection["label"]

    def testGetEndpoint(self, admin, server):
        """Test GET /annotation_connection/:id returns a connection."""
        (parent, child, dataset) = createTwoAnnotations(admin)
        connection = upenn_utilities.getSampleConnection(
            parent["_id"], child["_id"], dataset["_id"]
        )
        created = AnnotationConnection().create(connection)

        resp = server.request(
            path=f"/annotation_connection/{created['_id']}",
            method="GET",
            user=admin,
        )
        assertStatusOk(resp)
        assert resp.json["_id"] == str(created["_id"])
        assert resp.json["label"] == connection["label"]

    def testUpdateEndpoint(self, admin, server):
        """Test PUT /annotation_connection/:id updates a connection.

        Regression test for issue #1087: the update endpoint returned
        500 due to a parameter naming mismatch with @loadmodel.
        """
        (parent, child, dataset) = createTwoAnnotations(admin)
        connection = upenn_utilities.getSampleConnection(
            parent["_id"], child["_id"], dataset["_id"]
        )
        created = AnnotationConnection().create(connection)
        original_label = created["label"]

        updated_data = {
            "label": "Updated Label",
            "tags": ["updated"],
        }
        resp = server.request(
            path=f"/annotation_connection/{created['_id']}",
            method="PUT",
            user=admin,
            body=json.dumps(updated_data),
            type="application/json",
        )
        assertStatusOk(resp)

        # Verify the update was persisted
        loaded = AnnotationConnection().load(
            created["_id"], user=admin
        )
        assert loaded["label"] == "Updated Label"
        assert loaded["tags"] == ["updated"]
        assert loaded["label"] != original_label

    def testDeleteEndpoint(self, admin, server):
        """Test DELETE /annotation_connection/:id removes a connection."""
        (parent, child, dataset) = createTwoAnnotations(admin)
        connection = upenn_utilities.getSampleConnection(
            parent["_id"], child["_id"], dataset["_id"]
        )
        created = AnnotationConnection().create(connection)

        resp = server.request(
            path=f"/annotation_connection/{created['_id']}",
            method="DELETE",
            user=admin,
        )
        assertStatusOk(resp)

        loaded = AnnotationConnection().load(
            created["_id"], user=admin
        )
        assert loaded is None

    def testUpdateIgnoresUnknownFields(self, admin, server):
        """PUT /annotation_connection/:id drops unknown fields."""
        (parent, child, dataset) = createTwoAnnotations(admin)
        connection = upenn_utilities.getSampleConnection(
            parent["_id"], child["_id"], dataset["_id"]
        )
        created = AnnotationConnection().create(connection)

        updated_data = {
            "label": "Filtered Label",
            "tags": ["filtered"],
            "_malicious": "should be dropped",
            "accessLevel": 99,
            "unknownField": True,
        }
        resp = server.request(
            path=f"/annotation_connection/{created['_id']}",
            method="PUT",
            user=admin,
            body=json.dumps(updated_data),
            type="application/json",
        )
        assertStatusOk(resp)

        loaded = AnnotationConnection().load(
            created["_id"], user=admin
        )
        assert loaded["label"] == "Filtered Label"
        assert loaded["tags"] == ["filtered"]
        assert "_malicious" not in loaded
        assert "accessLevel" not in loaded
        assert "unknownField" not in loaded

    def testFindEndpoint(self, admin, server):
        """Test GET /annotation_connection returns connections."""
        (parent, child, dataset) = createTwoAnnotations(admin)
        for _ in range(3):
            connection = upenn_utilities.getSampleConnection(
                parent["_id"], child["_id"], dataset["_id"]
            )
            AnnotationConnection().create(connection)

        resp = server.request(
            path="/annotation_connection",
            method="GET",
            user=admin,
            params={"datasetId": str(dataset["_id"])},
        )
        assertStatusOk(resp)
        assert len(resp.json) == 3

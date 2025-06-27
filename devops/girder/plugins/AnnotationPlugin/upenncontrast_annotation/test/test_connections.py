import pytest
import math

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

from girder.constants import AccessType
from girder.exceptions import ValidationException
from girder.models.folder import Folder


def createTwoAnnotations(user):
    dataset = utilities.createFolder(
        user, "dataset", upenn_utilities.datasetMetadata
    )

    parentData = upenn_utilities.getSampleAnnotation(dataset["_id"])
    parent = Annotation().create(user, parentData)

    childData = upenn_utilities.getSampleAnnotation(dataset["_id"])
    child = Annotation().create(user, childData)
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
        result = AnnotationConnection().create(admin, connection)
        assert "_id" in result
        annotId = result["_id"]
        result = AnnotationConnection().load(annotId, user=admin)
        assert result is not None
        assert result["label"] == connection["label"]

    def testLoad(self, admin):
        with pytest.raises(Exception, match="Invalid ObjectId"):
            AnnotationConnection().load("nosuchid")
        assert (
            AnnotationConnection().load("012345678901234567890123", user=admin)
            is None
        )

        (parent, child, dataset) = createTwoAnnotations(admin)
        connection = upenn_utilities.getSampleConnection(
            parent["_id"], child["_id"], dataset["_id"]
        )
        result = AnnotationConnection().create(admin, connection)

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
        connection = AnnotationConnection().create(user, connectionData)

        assert (
            AnnotationConnection().load(
                connection["_id"], level=AccessType.READ, user=user
            )
            is not None
        )
        result = AnnotationConnection().remove(connection)
        assert result.deleted_count == 1
        assert (
            AnnotationConnection().load(
                connection["_id"], level=AccessType.READ, user=user
            )
            is None
        )

    def testOnAnnotationRemove(self, user, admin):
        (annotation1, annotation2, dataset) = createTwoAnnotations(admin)
        connection = upenn_utilities.getSampleConnection(
            annotation1["_id"], annotation2["_id"], dataset["_id"]
        )
        connectionInv = upenn_utilities.getSampleConnection(
            annotation2["_id"], annotation1["_id"], dataset["_id"]
        )

        result = AnnotationConnection().create(admin, connection)
        resultInv = AnnotationConnection().create(admin, connectionInv)

        # Create a few additional connections to test with the cursor
        AnnotationConnection().create(admin, connection)
        AnnotationConnection().create(admin, connection)
        AnnotationConnection().create(admin, connectionInv)
        AnnotationConnection().create(admin, connectionInv)

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
                {"parentId": str(annotation1["_id"])},
                {"childId": str(annotation2["_id"])},
            ]
        }
        cursor = AnnotationConnection().find(
            query, level=AccessType.READ, limit=2, user=admin
        )
        assert len(list(cursor)) == 0

    def testOnDatasetRemove(self, admin):
        (parent, child, dataset) = createTwoAnnotations(admin)
        connection = upenn_utilities.getSampleConnection(
            parent["_id"], child["_id"], dataset["_id"]
        )
        result = AnnotationConnection().create(admin, connection)

        assert result is not None
        Folder().remove(dataset)
        test = Annotation().load(
            child["_id"], level=AccessType.READ, user=admin
        )
        assert test is None
        loaded = AnnotationConnection().load(
            connection["_id"], level=AccessType.READ, user=admin
        )
        assert loaded is None

    def testValidate(self, db, admin):
        # Test with missing child, missing parent, missing dataset
        (parent, child, dataset) = createTwoAnnotations(admin)
        connection = upenn_utilities.getSampleConnection(
            "012345678901234567890123", child["_id"], dataset["_id"]
        )
        with pytest.raises(ValidationException, match="does not exist"):
            AnnotationConnection().validate(connection)

        connection = upenn_utilities.getSampleConnection(
            parent["_id"], "012345678901234567890123", dataset["_id"]
        )
        with pytest.raises(ValidationException, match="does not exist"):
            AnnotationConnection().validate(connection)

        connection = upenn_utilities.getSampleConnection(
            parent["_id"], child["_id"], "012345678901234567890123"
        )
        with pytest.raises(ValidationException, match="does not exist"):
            AnnotationConnection().validate(connection)

        empty = {}
        with pytest.raises(ValidationException):
            AnnotationConnection().validate(empty)

        folder = utilities.createFolder(admin, "notADataset", {})
        connection = upenn_utilities.getSampleConnection(
            parent["_id"], child["_id"], folder["_id"]
        )
        with pytest.raises(ValidationException, match="not a dataset"):
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
        assert distance == 4
        distance = annotationToAnnotationDistance(
            self.blobAnnotations[0], self.blobAnnotations[1]
        )
        assert distance == math.sqrt(162)

    def testGetClosestAnnotation(self):
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

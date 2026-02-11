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

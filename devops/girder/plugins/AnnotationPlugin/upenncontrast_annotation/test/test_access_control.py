"""
Security tests for access control on all plugin endpoints.

All tests create resources as admin in admin's Private folder,
then attempt unauthorized operations as user (who has no access).
"""
import json

import pytest
from bson.objectid import ObjectId

from pytest_girder.assertions import assertStatus, assertStatusOk

from girder.constants import AccessType
from girder.models.folder import Folder

from upenncontrast_annotation.server.models.annotation import Annotation
from upenncontrast_annotation.server.models.connections import (
    AnnotationConnection,
)
from upenncontrast_annotation.server.models.collection import Collection
from upenncontrast_annotation.server.models.propertyValues import (
    AnnotationPropertyValues,
)

from . import girder_utilities as utilities
from . import upenn_testing_utilities as upenn_utilities


def getDefaultConfigMetadata():
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
class TestAnnotationAccessControl:
    """Test that annotation endpoints enforce dataset access."""

    def testCreateAnnotationDeniedWithoutAccess(
        self, admin, user, server
    ):
        """User cannot create annotation in admin's private dataset."""
        folder = utilities.createPrivateFolder(
            admin, "private_ds", upenn_utilities.datasetMetadata
        )
        annotation = upenn_utilities.getSampleAnnotation(
            str(folder["_id"])
        )
        resp = server.request(
            path="/upenn_annotation",
            method="POST",
            user=user,
            body=json.dumps(annotation),
            type="application/json",
        )
        assertStatus(resp, 403)

    def testCreateMultipleAnnotationsDeniedWithoutAccess(
        self, admin, user, server
    ):
        """User cannot bulk-create annotations in admin's dataset."""
        folder = utilities.createPrivateFolder(
            admin, "private_ds", upenn_utilities.datasetMetadata
        )
        annotations = [
            upenn_utilities.getSampleAnnotation(str(folder["_id"]))
            for _ in range(3)
        ]
        resp = server.request(
            path="/upenn_annotation/multiple",
            method="POST",
            user=user,
            body=json.dumps(annotations),
            type="application/json",
        )
        assertStatus(resp, 403)

    def testDeleteMultipleAnnotationsDeniedWithoutAccess(
        self, admin, user, server
    ):
        """User cannot bulk-delete annotations in admin's dataset."""
        folder = utilities.createPrivateFolder(
            admin, "private_ds", upenn_utilities.datasetMetadata
        )
        ann = Annotation().create(
            upenn_utilities.getSampleAnnotation(folder["_id"])
        )
        resp = server.request(
            path="/upenn_annotation/multiple",
            method="DELETE",
            user=user,
            body=json.dumps([str(ann["_id"])]),
            type="application/json",
        )
        assertStatus(resp, 403)

    def testDeleteMultipleAnnotationsAllowedWithAccess(
        self, admin, server
    ):
        """Owner can bulk-delete their own annotations."""
        folder = utilities.createPrivateFolder(
            admin, "private_ds", upenn_utilities.datasetMetadata
        )
        ann = Annotation().create(
            upenn_utilities.getSampleAnnotation(folder["_id"])
        )
        resp = server.request(
            path="/upenn_annotation/multiple",
            method="DELETE",
            user=admin,
            body=json.dumps([str(ann["_id"])]),
            type="application/json",
        )
        assertStatusOk(resp)


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestConnectionAccessControl:
    """Test that connection endpoints enforce dataset access."""

    def testCreateConnectionDeniedWithoutAccess(
        self, admin, user, server
    ):
        """User cannot create connection in admin's private dataset."""
        folder = utilities.createPrivateFolder(
            admin, "private_ds", upenn_utilities.datasetMetadata
        )
        ann1 = Annotation().create(
            upenn_utilities.getSampleAnnotation(folder["_id"])
        )
        ann2 = Annotation().create(
            upenn_utilities.getSampleAnnotation(folder["_id"])
        )
        connection = upenn_utilities.getSampleConnection(
            str(ann1["_id"]), str(ann2["_id"]), str(folder["_id"])
        )
        resp = server.request(
            path="/annotation_connection",
            method="POST",
            user=user,
            body=json.dumps(connection),
            type="application/json",
        )
        assertStatus(resp, 403)

    def testCreateMultipleConnectionsDeniedWithoutAccess(
        self, admin, user, server
    ):
        """User cannot bulk-create connections in admin's dataset."""
        folder = utilities.createPrivateFolder(
            admin, "private_ds", upenn_utilities.datasetMetadata
        )
        ann1 = Annotation().create(
            upenn_utilities.getSampleAnnotation(folder["_id"])
        )
        ann2 = Annotation().create(
            upenn_utilities.getSampleAnnotation(folder["_id"])
        )
        connections = [
            upenn_utilities.getSampleConnection(
                str(ann1["_id"]), str(ann2["_id"]),
                str(folder["_id"])
            )
        ]
        resp = server.request(
            path="/annotation_connection/multiple",
            method="POST",
            user=user,
            body=json.dumps(connections),
            type="application/json",
        )
        assertStatus(resp, 403)

    def testDeleteMultipleConnectionsDeniedWithoutAccess(
        self, admin, user, server
    ):
        """User cannot bulk-delete connections in admin's dataset."""
        folder = utilities.createPrivateFolder(
            admin, "private_ds", upenn_utilities.datasetMetadata
        )
        ann1 = Annotation().create(
            upenn_utilities.getSampleAnnotation(folder["_id"])
        )
        ann2 = Annotation().create(
            upenn_utilities.getSampleAnnotation(folder["_id"])
        )
        conn = AnnotationConnection().create(
            upenn_utilities.getSampleConnection(
                ann1["_id"], ann2["_id"], folder["_id"]
            )
        )
        resp = server.request(
            path="/annotation_connection/multiple",
            method="DELETE",
            user=user,
            body=json.dumps([str(conn["_id"])]),
            type="application/json",
        )
        assertStatus(resp, 403)

    def testFindConnectionsRequiresDatasetId(self, admin, server):
        """Find connections without datasetId should be rejected."""
        resp = server.request(
            path="/annotation_connection",
            method="GET",
            user=admin,
        )
        assertStatus(resp, 400)


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestPropertyValuesAccessControl:
    """Test that property value endpoints enforce dataset access."""

    def testAddPropertyValueDeniedWithoutAccess(
        self, admin, user, server
    ):
        """User cannot add property values in admin's dataset."""
        folder = utilities.createPrivateFolder(
            admin, "private_ds", upenn_utilities.datasetMetadata
        )
        ann = Annotation().create(
            upenn_utilities.getSampleAnnotation(folder["_id"])
        )
        resp = server.request(
            path="/annotation_property_values",
            method="POST",
            user=user,
            body=json.dumps({"testProp": 42}),
            type="application/json",
            params={
                "annotationId": str(ann["_id"]),
                "datasetId": str(folder["_id"]),
            },
        )
        assertStatus(resp, 403)

    def testAddMultiplePropertyValuesDeniedWithoutAccess(
        self, admin, user, server
    ):
        """User cannot bulk-add property values in admin's dataset."""
        folder = utilities.createPrivateFolder(
            admin, "private_ds", upenn_utilities.datasetMetadata
        )
        ann = Annotation().create(
            upenn_utilities.getSampleAnnotation(folder["_id"])
        )
        entries = [{
            "annotationId": str(ann["_id"]),
            "datasetId": str(folder["_id"]),
            "values": {"testProp": 42},
        }]
        resp = server.request(
            path="/annotation_property_values/multiple",
            method="POST",
            user=user,
            body=json.dumps(entries),
            type="application/json",
        )
        assertStatus(resp, 403)

    def testDeletePropertyValuesDeniedWithoutAccess(
        self, admin, user, server
    ):
        """User cannot delete property values in admin's dataset."""
        folder = utilities.createPrivateFolder(
            admin, "private_ds", upenn_utilities.datasetMetadata
        )
        resp = server.request(
            path="/annotation_property_values",
            method="DELETE",
            user=user,
            params={
                "propertyId": str(ObjectId()),
                "datasetId": str(folder["_id"]),
            },
        )
        assertStatus(resp, 403)

    def testHistogramDeniedWithoutAccess(
        self, admin, user, server
    ):
        """User cannot get histogram for admin's private dataset."""
        folder = utilities.createPrivateFolder(
            admin, "private_ds", upenn_utilities.datasetMetadata
        )
        resp = server.request(
            path="/annotation_property_values/histogram",
            method="GET",
            user=user,
            params={
                "propertyPath": str(ObjectId()),
                "datasetId": str(folder["_id"]),
            },
        )
        assertStatus(resp, 403)


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestExportAccessControl:
    """Test that export respects configuration access."""

    def testExportJsonDeniedForInaccessibleConfig(
        self, admin, user, server
    ):
        """User with dataset READ cannot export using an
        inaccessible configuration."""
        # Create a public dataset (user can READ)
        folder = utilities.createFolder(
            admin, "public_ds", upenn_utilities.datasetMetadata
        )
        # Create a private configuration (user cannot READ)
        configMeta = getDefaultConfigMetadata()
        configMeta["propertyIds"] = ["prop1"]
        private_folder = utilities.createPrivateFolder(
            admin, "private_config_parent",
            upenn_utilities.datasetMetadata
        )
        config = Collection().createCollection(
            "PrivateConfig", admin, private_folder, configMeta
        )

        resp = server.request(
            path="/export/json",
            method="GET",
            user=user,
            params={
                "datasetId": str(folder["_id"]),
                "configurationId": str(config["_id"]),
            },
        )
        assertStatus(resp, 403)


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestHistoryAccessControl:
    """Test that history endpoints enforce dataset access."""

    def testHistoryFindDeniedWithoutAccess(
        self, admin, user, server
    ):
        """User cannot view history for admin's private dataset."""
        folder = utilities.createPrivateFolder(
            admin, "private_ds", upenn_utilities.datasetMetadata
        )
        resp = server.request(
            path="/history",
            method="GET",
            user=user,
            params={"datasetId": str(folder["_id"])},
        )
        assertStatus(resp, 403)

    def testHistoryUndoDeniedWithoutAccess(
        self, admin, user, server
    ):
        """User cannot undo in admin's private dataset."""
        folder = utilities.createPrivateFolder(
            admin, "private_ds", upenn_utilities.datasetMetadata
        )
        resp = server.request(
            path="/history/undo",
            method="PUT",
            user=user,
            params={"datasetId": str(folder["_id"])},
        )
        assertStatus(resp, 403)

    def testHistoryRedoDeniedWithoutAccess(
        self, admin, user, server
    ):
        """User cannot redo in admin's private dataset."""
        folder = utilities.createPrivateFolder(
            admin, "private_ds", upenn_utilities.datasetMetadata
        )
        resp = server.request(
            path="/history/redo",
            method="PUT",
            user=user,
            params={"datasetId": str(folder["_id"])},
        )
        assertStatus(resp, 403)


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestWorkerPreviewsAccessControl:
    """Test that worker preview write endpoints require admin."""

    def testUpdatePreviewDeniedForNonAdmin(self, user, server):
        """Non-admin user cannot update worker previews."""
        resp = server.request(
            path="/worker_preview",
            method="POST",
            user=user,
            body=json.dumps({"test": "data"}),
            type="application/json",
            params={"image": "test-image:latest"},
        )
        assertStatus(resp, 403)

    def testClearPreviewDeniedForNonAdmin(self, user, server):
        """Non-admin user cannot clear worker previews."""
        resp = server.request(
            path="/worker_preview",
            method="DELETE",
            user=user,
            params={"image": "test-image:latest"},
        )
        assertStatus(resp, 403)


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestUserAssetstoreAccessControl:
    """Test that assetstore listing requires admin."""

    def testListAssetstoresDeniedForNonAdmin(self, user, server):
        """Non-admin user cannot list assetstores."""
        resp = server.request(
            path="/user_assetstore",
            method="GET",
            user=user,
        )
        assertStatus(resp, 403)


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestInheritedAccessLoad:
    """Regression tests for the MRO that lets @loadmodel work on models
    using AccessControlMixin (Annotation, AnnotationConnection,
    AnnotationPropertyValues). These models inherit permissions from
    their parent dataset folder via resourceColl/resourceParent. If the
    MRO puts AccessControlledModel's load/hasAccess ahead of
    AccessControlMixin's, non-admin users always get 403 because those
    docs have no access/public fields of their own.
    """

    def testAnnotationLoadWithInheritedReadAccess(self, admin, user):
        folder = utilities.createPrivateFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        Folder().setUserAccess(folder, user, AccessType.READ, save=True)
        ann = Annotation().create(
            upenn_utilities.getSampleAnnotation(folder["_id"])
        )
        loaded = Annotation().load(
            ann["_id"], user=user, level=AccessType.READ, exc=True
        )
        assert loaded is not None
        assert loaded["_id"] == ann["_id"]

    def testConnectionLoadWithInheritedWriteAccess(self, admin, user):
        folder = utilities.createPrivateFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        Folder().setUserAccess(folder, user, AccessType.WRITE, save=True)
        ann1 = Annotation().create(
            upenn_utilities.getSampleAnnotation(folder["_id"])
        )
        ann2 = Annotation().create(
            upenn_utilities.getSampleAnnotation(folder["_id"])
        )
        conn = AnnotationConnection().create(
            upenn_utilities.getSampleConnection(
                ann1["_id"], ann2["_id"], folder["_id"]
            )
        )
        loaded = AnnotationConnection().load(
            conn["_id"], user=user, level=AccessType.WRITE, exc=True
        )
        assert loaded is not None
        assert loaded["_id"] == conn["_id"]

    def testPropertyValuesLoadWithInheritedReadAccess(self, admin, user):
        folder = utilities.createPrivateFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        Folder().setUserAccess(folder, user, AccessType.READ, save=True)
        ann = Annotation().create(
            upenn_utilities.getSampleAnnotation(folder["_id"])
        )
        values_doc = AnnotationPropertyValues().appendValues(
            {"testProp": 42},
            ann["_id"],
            folder["_id"],
        )
        loaded = AnnotationPropertyValues().load(
            values_doc["_id"], user=user, level=AccessType.READ, exc=True
        )
        assert loaded is not None
        assert loaded["_id"] == values_doc["_id"]

    def testAnnotationGetEndpointWithSharedAccess(
        self, admin, user, server
    ):
        """End-to-end: GET /upenn_annotation/{id} via @loadmodel for a
        non-admin user with inherited READ access."""
        folder = utilities.createPrivateFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        Folder().setUserAccess(folder, user, AccessType.READ, save=True)
        ann = Annotation().create(
            upenn_utilities.getSampleAnnotation(folder["_id"])
        )
        resp = server.request(
            path="/upenn_annotation/%s" % str(ann["_id"]),
            method="GET",
            user=user,
        )
        assertStatusOk(resp)
        assert resp.json["_id"] == str(ann["_id"])

    def testAnnotationGetEndpointDeniedWithoutAccess(
        self, admin, user, server
    ):
        """A user without access still gets 403 on the get endpoint."""
        folder = utilities.createPrivateFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        ann = Annotation().create(
            upenn_utilities.getSampleAnnotation(folder["_id"])
        )
        resp = server.request(
            path="/upenn_annotation/%s" % str(ann["_id"]),
            method="GET",
            user=user,
        )
        assertStatus(resp, 403)

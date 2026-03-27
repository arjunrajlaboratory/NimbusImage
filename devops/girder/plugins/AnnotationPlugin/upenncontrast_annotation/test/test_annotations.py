import json

import pytest

from pytest_girder.assertions import assertStatus, assertStatusOk

from upenncontrast_annotation.server.models.annotation import Annotation
from upenncontrast_annotation.server.models import annotation

from girder.models.folder import Folder

from girder.exceptions import ValidationException

from . import girder_utilities as utilities
from . import upenn_testing_utilities as upenn_utilities


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestAnnotation:
    def testAnnotationSchema(self):
        schema = annotation.AnnotationSchema
        assert schema.annotationSchema is not None
        assert schema.coordSchema is not None
        assert schema.coordsSchema is not None
        assert schema.tagsSchema is not None
        assert schema.locationSchema is not None
        assert schema.shapeSchema is not None

    def testAnnotationCreate(self, admin):
        folder = utilities.createFolder(
            admin, "sample", upenn_utilities.datasetMetadata
        )
        newAnnotation = upenn_utilities.getSampleAnnotation(folder["_id"])

        result = Annotation().create(newAnnotation)
        assert "_id" in result
        annotId = result["_id"]
        result = Annotation().load(annotId, user=admin)
        assert result is not None
        assert result["name"] == newAnnotation["name"]

    def testLoad(self, admin):
        with pytest.raises(Exception, match="Invalid ObjectId"):
            Annotation().load("nosuchid", user=admin)
        assert (
            Annotation().load("012345678901234567890123", user=admin) is None
        )

        folder = utilities.createFolder(
            admin, "sample", upenn_utilities.datasetMetadata
        )
        sample = upenn_utilities.getSampleAnnotation(folder["_id"])
        annotation = Annotation().create(sample)

        loaded = Annotation().load(annotation["_id"], user=admin)
        assert (
            loaded["_id"] == annotation["_id"]
            and loaded["name"] == sample["name"]
        )

    def testRemove(self, user):
        folder = utilities.createFolder(
            user, "sample", upenn_utilities.datasetMetadata
        )
        sample = upenn_utilities.getSampleAnnotation(folder["_id"])
        annotation = Annotation().create(sample)

        assert Annotation().load(annotation["_id"], force=True) is not None
        result = Annotation().remove(annotation)
        assert result.deleted_count == 1
        assert Annotation().load(annotation["_id"], force=True) is None

    def testOnDatasetRemove(self, user):
        folder = utilities.createFolder(
            user, "sample", upenn_utilities.datasetMetadata
        )
        sample = upenn_utilities.getSampleAnnotation(folder["_id"])
        annotation = Annotation().create(sample)

        Folder().remove(folder)
        result = Annotation().load(annotation["_id"], user=user)
        assert result is None

    def testValidate(self, admin):
        sample = upenn_utilities.getSampleAnnotation(
            "012345678901234567890123"
        )
        with pytest.raises(
            ValidationException, match="Annotation dataset ID is invalid"
        ):
            Annotation().validate(sample)
        empty = {}
        with pytest.raises(ValidationException):
            Annotation().validate(empty)

        folder = utilities.createFolder(admin, "sample2", {})
        sample = upenn_utilities.getSampleAnnotation(folder["_id"])
        with pytest.raises(
            ValidationException,
            match="Annotation dataset ID is invalid",
        ):
            Annotation().validate(sample)


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestUpdateMultiple:
    """Tests for PUT /upenn_annotation/multiple endpoint."""

    def _createAnnotation(self, folder, admin):
        sample = upenn_utilities.getSampleAnnotation(folder["_id"])
        return Annotation().create(sample)

    def testUpdateMultipleValid(self, admin, server):
        """Happy path: update annotations via the API."""
        folder = utilities.createFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        a1 = self._createAnnotation(folder, admin)
        a2 = self._createAnnotation(folder, admin)

        updates = [
            {
                "id": str(a1["_id"]),
                "datasetId": str(folder["_id"]),
                "tags": ["updated"],
            },
            {
                "id": str(a2["_id"]),
                "datasetId": str(folder["_id"]),
                "tags": ["updated2"],
            },
        ]
        resp = server.request(
            path="/upenn_annotation/multiple",
            method="PUT",
            user=admin,
            body=json.dumps(updates),
            type="application/json",
        )
        assertStatusOk(resp)

        loaded1 = Annotation().load(a1["_id"], user=admin)
        assert "updated" in loaded1["tags"]
        loaded2 = Annotation().load(a2["_id"], user=admin)
        assert "updated2" in loaded2["tags"]

    def testUpdateMultipleAcceptsUnderscoreId(self, admin, server):
        """_id field should be accepted as an alias for id."""
        folder = utilities.createFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        a1 = self._createAnnotation(folder, admin)

        updates = [
            {
                "_id": str(a1["_id"]),
                "datasetId": str(folder["_id"]),
                "tags": ["via_underscore"],
            },
        ]
        resp = server.request(
            path="/upenn_annotation/multiple",
            method="PUT",
            user=admin,
            body=json.dumps(updates),
            type="application/json",
        )
        assertStatusOk(resp)

        loaded = Annotation().load(a1["_id"], user=admin)
        assert "via_underscore" in loaded["tags"]

    def testUpdateMultipleEmptyList(self, admin, server):
        """Empty list should succeed with no changes."""
        resp = server.request(
            path="/upenn_annotation/multiple",
            method="PUT",
            user=admin,
            body=json.dumps([]),
            type="application/json",
        )
        assertStatusOk(resp)

    def testUpdateMultipleNotAList(self, admin, server):
        """Sending an object instead of an array should return 400."""
        resp = server.request(
            path="/upenn_annotation/multiple",
            method="PUT",
            user=admin,
            body=json.dumps({"id": "abc"}),
            type="application/json",
        )
        assertStatus(resp, 400)

    def testUpdateMultipleStringBody(self, admin, server):
        """Sending a bare string should return 400."""
        resp = server.request(
            path="/upenn_annotation/multiple",
            method="PUT",
            user=admin,
            body=json.dumps("not a list"),
            type="application/json",
        )
        assertStatus(resp, 400)

    def testUpdateMultipleNonDictEntry(self, admin, server):
        """Array containing a non-object entry should return 400."""
        resp = server.request(
            path="/upenn_annotation/multiple",
            method="PUT",
            user=admin,
            body=json.dumps(["not an object"]),
            type="application/json",
        )
        assertStatus(resp, 400)

    def testUpdateMultipleMissingId(self, admin, server):
        """Entry without id or _id should return 400."""
        resp = server.request(
            path="/upenn_annotation/multiple",
            method="PUT",
            user=admin,
            body=json.dumps([{"tags": ["oops"]}]),
            type="application/json",
        )
        assertStatus(resp, 400)

    def testUpdateMultipleInvalidId(self, admin, server):
        """Entry with a non-ObjectId string should return 400."""
        resp = server.request(
            path="/upenn_annotation/multiple",
            method="PUT",
            user=admin,
            body=json.dumps([{"id": "not-an-objectid"}]),
            type="application/json",
        )
        assertStatus(resp, 400)

    def testUpdateMultipleInvalidDatasetId(self, admin, server):
        """Invalid datasetId string should return 400."""
        folder = utilities.createFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        ann = self._createAnnotation(folder, admin)
        updates = [
            {
                "id": str(ann["_id"]),
                "datasetId": "not-a-valid-objectid",
            },
        ]
        resp = server.request(
            path="/upenn_annotation/multiple",
            method="PUT",
            user=admin,
            body=json.dumps(updates),
            type="application/json",
        )
        assertStatus(resp, 400)

    def testUpdateMultiplePartialWithoutDatasetId(
        self, admin, server
    ):
        """Partial update (no datasetId) should succeed."""
        folder = utilities.createFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        ann = self._createAnnotation(folder, admin)
        updates = [
            {
                "id": str(ann["_id"]),
                "tags": ["partial-update"],
            },
        ]
        resp = server.request(
            path="/upenn_annotation/multiple",
            method="PUT",
            user=admin,
            body=json.dumps(updates),
            type="application/json",
        )
        assertStatusOk(resp)

        loaded = Annotation().load(ann["_id"], user=admin)
        assert "partial-update" in loaded["tags"]

    def testUpdateMultipleMixedValidAndInvalidEntries(
        self, admin, server
    ):
        """If any entry is invalid, the whole request fails."""
        folder = utilities.createFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        ann = self._createAnnotation(folder, admin)
        updates = [
            {"id": str(ann["_id"]), "tags": ["ok"]},
            "not-a-dict",
        ]
        resp = server.request(
            path="/upenn_annotation/multiple",
            method="PUT",
            user=admin,
            body=json.dumps(updates),
            type="application/json",
        )
        assertStatus(resp, 400)

    def testUpdateMultipleRejectsMoveToDeniedDataset(
        self, admin, user, server
    ):
        """User cannot move annotations to a dataset they lack access to.

        Even if the user owns the source annotation, changing datasetId
        to point at another user's private dataset should be denied.
        """
        # User creates an annotation in their own dataset
        user_folder = utilities.createFolder(
            user, "user_ds", upenn_utilities.datasetMetadata
        )
        ann = self._createAnnotation(user_folder, user)

        # Admin creates a private dataset the user cannot access
        admin_folder = utilities.createPrivateFolder(
            admin, "admin_ds", upenn_utilities.datasetMetadata
        )

        # User tries to move their annotation into admin's dataset
        updates = [
            {
                "id": str(ann["_id"]),
                "datasetId": str(admin_folder["_id"]),
            },
        ]
        resp = server.request(
            path="/upenn_annotation/multiple",
            method="PUT",
            user=user,
            body=json.dumps(updates),
            type="application/json",
        )
        assertStatus(resp, 403)

    def testUpdateMultipleIgnoresUnknownFields(
        self, admin, server
    ):
        """Unknown fields in the update payload are silently dropped."""
        folder = utilities.createFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        ann = self._createAnnotation(folder, admin)
        updates = [
            {
                "id": str(ann["_id"]),
                "tags": ["field-test"],
                "_malicious": "should be dropped",
                "accessLevel": 99,
                "unknownField": True,
            },
        ]
        resp = server.request(
            path="/upenn_annotation/multiple",
            method="PUT",
            user=admin,
            body=json.dumps(updates),
            type="application/json",
        )
        assertStatusOk(resp)

        loaded = Annotation().load(ann["_id"], user=admin)
        assert "field-test" in loaded["tags"]
        assert "_malicious" not in loaded
        assert "accessLevel" not in loaded
        assert "unknownField" not in loaded

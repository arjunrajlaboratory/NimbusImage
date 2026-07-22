import json

import pytest

from pytest_girder.assertions import assertStatus, assertStatusOk

from upenncontrast_annotation.server.models.property import (
    AnnotationProperty,
)

from girder.constants import AccessType
from girder.models.folder import Folder

from . import girder_utilities as utilities
from . import upenn_testing_utilities as upenn_utilities


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestPropertyEndpoints:
    """REST API endpoint tests for annotation properties."""

    def _createProperty(self, admin):
        prop = {
            "name": "test-prop",
            "image": "test-image:latest",
            "shape": "point",
            "tags": {
                "tags": ["tag1"],
                "exclusive": False,
            },
            "workerInterface": {},
        }
        model = AnnotationProperty()
        model.setUserAccess(
            prop, user=admin,
            level=AccessType.ADMIN, save=False
        )
        return model.save(prop)

    def testUpdateIgnoresUnknownFields(self, admin, server):
        """PUT /annotation_property/:id drops unknown fields."""
        prop = self._createProperty(admin)
        update_body = {
            "name": "updated-prop",
            "_malicious": "should be dropped",
            "accessLevel": 99,
            "unknownField": True,
        }
        resp = server.request(
            path="/annotation_property/%s" % prop["_id"],
            method="PUT",
            user=admin,
            body=json.dumps(update_body),
            type="application/json",
        )
        assertStatusOk(resp)

        loaded = AnnotationProperty().load(
            prop["_id"], user=admin
        )
        assert loaded["name"] == "updated-prop"
        assert "_malicious" not in loaded
        assert "accessLevel" not in loaded
        assert "unknownField" not in loaded


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestPropertyComputeAccess:
    """Access-control tests for POST /annotation_property/:id/compute.

    Regression for issue #1241: the compute endpoint spawned a worker job
    against a caller-supplied datasetId without checking the caller had
    WRITE access to that dataset (unlike the annotation compute path, which
    is gated). A user with only READ on the dataset must be refused before a
    worker is ever scheduled.
    """

    def _createProperty(self, owner):
        prop = {
            "name": "compute-prop",
            "image": "test-image:latest",
            "shape": "point",
            "tags": {"tags": [], "exclusive": False},
            "workerInterface": {},
        }
        model = AnnotationProperty()
        model.setUserAccess(
            prop, user=owner, level=AccessType.ADMIN, save=False
        )
        return model.save(prop)

    def testReadOnlyDatasetAccessIsRefused(self, admin, user, server):
        """A user with only READ on the dataset gets 403 (never reaches the
        worker), because the dataset is loaded at WRITE first."""
        dataset = utilities.createFolder(
            admin, "compute-ds", upenn_utilities.datasetMetadata
        )
        # Share the dataset with `user` at READ only.
        Folder().setUserAccess(
            dataset, user=user, level=AccessType.READ, save=True
        )
        # `user` owns the property, so @loadmodel (READ on the property)
        # passes and the dataset WRITE check is what must reject the request.
        prop = self._createProperty(user)

        resp = server.request(
            path="/annotation_property/%s/compute" % prop["_id"],
            method="POST",
            user=user,
            params={"datasetId": str(dataset["_id"])},
            body=json.dumps({}),
            type="application/json",
        )
        assertStatus(resp, 403)

import json
from unittest import mock

import pytest

from pytest_girder.assertions import assertStatus, assertStatusOk

from upenncontrast_annotation.server.models.property import (
    AnnotationProperty,
)
from upenncontrast_annotation.server.api import property as propertyApi

from girder.constants import AccessType
from girder.models.folder import Folder

from . import girder_utilities as utilities


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

    def testComputeMultipleSubmitsAllPropertiesInOneRequest(
        self, admin, server
    ):
        dataset = utilities.createFolder(admin, "batch-compute-dataset", {})
        first = self._createProperty(admin)
        second = self._createProperty(admin)
        second["name"] = "test-prop-2"
        second = AnnotationProperty().save(second)
        requests = [
            {
                "id": str(prop["_id"]),
                "parameters": {"name": prop["name"], "scales": {}},
            }
            for prop in (first, second)
        ]

        with mock.patch.object(
            AnnotationProperty,
            "compute",
            side_effect=[[{"_id": "job-1"}], [{"_id": "job-2"}]],
        ) as compute:
            resp = server.request(
                path="/annotation_property/compute",
                method="POST",
                user=admin,
                body=json.dumps(
                    {
                        "datasetId": str(dataset["_id"]),
                        "properties": requests,
                    }
                ),
                type="application/json",
            )

        assertStatusOk(resp)
        assert resp.json == [
            {"propertyId": str(first["_id"]), "jobs": [{"_id": "job-1"}]},
            {
                "propertyId": str(second["_id"]),
                "jobs": [{"_id": "job-2"}],
            },
        ]
        assert compute.call_count == 2

    def testComputeMultipleRejectsInaccessibleProperty(
        self, admin, user, server
    ):
        dataset = utilities.createFolder(user, "batch-compute-private", {})
        inaccessible = self._createProperty(admin)
        resp = server.request(
            path="/annotation_property/compute",
            method="POST",
            user=user,
            body=json.dumps(
                {
                    "datasetId": str(dataset["_id"]),
                    "properties": [
                        {
                            "id": str(inaccessible["_id"]),
                            "parameters": {"name": inaccessible["name"]},
                        }
                    ],
                }
            ),
            type="application/json",
        )

        assertStatus(resp, 403)

    def testComputeMultipleEnforcesRequestLimit(
        self, admin, server, monkeypatch
    ):
        dataset = utilities.createFolder(admin, "batch-compute-limit", {})
        first = self._createProperty(admin)
        second = self._createProperty(admin)
        monkeypatch.setattr(propertyApi, "MAX_COMPUTE_PROPERTIES", 1)
        resp = server.request(
            path="/annotation_property/compute",
            method="POST",
            user=admin,
            body=json.dumps(
                {
                    "datasetId": str(dataset["_id"]),
                    "properties": [
                        {
                            "id": str(prop["_id"]),
                            "parameters": {"name": prop["name"]},
                        }
                        for prop in (first, second)
                    ],
                }
            ),
            type="application/json",
        )

        assertStatus(resp, 400)
        assert "maximum of 1" in resp.json["message"]

    def testComputeMultipleValidatesEveryPropertyBeforeSubmitting(
        self, admin, server
    ):
        dataset = utilities.createFolder(admin, "batch-compute-validation", {})
        valid = self._createProperty(admin)
        invalid = self._createProperty(admin)
        invalid.pop("image")
        invalid = AnnotationProperty().save(invalid)

        with mock.patch.object(AnnotationProperty, "compute") as compute:
            resp = server.request(
                path="/annotation_property/compute",
                method="POST",
                user=admin,
                body=json.dumps(
                    {
                        "datasetId": str(dataset["_id"]),
                        "properties": [
                            {
                                "id": str(prop["_id"]),
                                "parameters": {"name": prop["name"]},
                            }
                            for prop in (valid, invalid)
                        ],
                    }
                ),
                type="application/json",
            )

        assertStatus(resp, 400)
        assert "no image" in resp.json["message"]
        compute.assert_not_called()

    def testComputeRequiresDatasetWriteAccess(self, admin, user, server):
        dataset = utilities.createFolder(admin, "compute-read-only", {})
        Folder().setUserAccess(
            dataset, user=user, level=AccessType.READ, save=True
        )
        prop = self._createProperty(admin)
        AnnotationProperty().setUserAccess(
            prop, user=user, level=AccessType.READ, save=True
        )

        with mock.patch.object(AnnotationProperty, "compute") as compute:
            resp = server.request(
                path="/annotation_property/%s/compute" % prop["_id"],
                method="POST",
                user=user,
                params={"datasetId": str(dataset["_id"])},
                body=json.dumps({"name": prop["name"]}),
                type="application/json",
            )

        assertStatus(resp, 403)
        compute.assert_not_called()

import json
from unittest import mock

import pytest

from pytest_girder.assertions import assertStatus, assertStatusOk

from upenncontrast_annotation.server.models.property import (
    AnnotationProperty,
)
from upenncontrast_annotation.server.api import property as propertyApi
from upenncontrast_annotation.server.models.collection import Collection

from girder.constants import AccessType
from girder.models.folder import Folder
from girder_jobs.models.job import Job

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
        assert str(invalid["_id"]) in resp.json["message"]
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

    def _postComputeMultiple(
        self, server, user, datasetId, properties, **kwargs
    ):
        return server.request(
            path="/annotation_property/compute",
            method="POST",
            user=user,
            body=json.dumps(
                {
                    "datasetId": str(datasetId),
                    "properties": [
                        {
                            "id": str(prop["_id"]),
                            "parameters": {"name": prop["name"]},
                        }
                        for prop in properties
                    ],
                }
            ),
            type="application/json",
            **kwargs,
        )

    def testComputeMultipleRequiresDatasetWriteAccess(
        self, admin, user, server
    ):
        dataset = utilities.createFolder(admin, "batch-read-only", {})
        Folder().setUserAccess(
            dataset, user=user, level=AccessType.READ, save=True
        )
        prop = self._createProperty(admin)
        AnnotationProperty().setUserAccess(
            prop, user=user, level=AccessType.READ, save=True
        )

        with mock.patch.object(AnnotationProperty, "compute") as compute:
            resp = self._postComputeMultiple(
                server, user, dataset["_id"], [prop]
            )

        assertStatus(resp, 403)
        compute.assert_not_called()

    def testComputeMultipleRejectsDuplicatePropertyIds(self, admin, server):
        dataset = utilities.createFolder(admin, "batch-duplicates", {})
        prop = self._createProperty(admin)

        with mock.patch.object(AnnotationProperty, "compute") as compute:
            resp = self._postComputeMultiple(
                server, admin, dataset["_id"], [prop, prop]
            )

        assertStatus(resp, 400)
        assert "unique" in resp.json["message"]
        compute.assert_not_called()

    def testComputeMultipleReportsMissingPropertyAs404(self, admin, server):
        dataset = utilities.createFolder(admin, "batch-missing", {})
        prop = self._createProperty(admin)
        missing = {"_id": "0" * 24, "name": "deleted"}

        with mock.patch.object(AnnotationProperty, "compute") as compute:
            resp = self._postComputeMultiple(
                server, admin, dataset["_id"], [prop, missing]
            )

        assertStatus(resp, 404)
        assert "0" * 24 in resp.json["message"]
        compute.assert_not_called()

    def testComputeRequiresDatasetId(self, admin, server):
        prop = self._createProperty(admin)

        with mock.patch.object(AnnotationProperty, "compute") as compute:
            resp = server.request(
                path="/annotation_property/%s/compute" % prop["_id"],
                method="POST",
                user=admin,
                body=json.dumps({"name": prop["name"]}),
                type="application/json",
            )

        assertStatus(resp, 400)
        compute.assert_not_called()

    def testCollaboratorComputesPropertyReadableThroughConfiguration(
        self, admin, user, server
    ):
        """A property's own ACL only ever names its creator; a dataset
        collaborator reads it through the shared configuration, and may
        compute it on a dataset they can write."""
        dataset = utilities.createPrivateFolder(admin, "shared-ds", {})
        Folder().setUserAccess(
            dataset, user=user, level=AccessType.WRITE, save=True
        )
        prop = self._createProperty(admin)
        config = Collection().createCollection(
            "SharedConfig",
            admin,
            dataset,
            {
                "subtype": "contrastConfiguration",
                "compatibility": {},
                "layers": [],
                "tools": [],
                "propertyIds": [str(prop["_id"])],
                "snapshots": [],
                "scales": {},
            },
        )
        Collection().setUserAccess(
            config, user=user, level=AccessType.READ, save=True
        )
        assert not AnnotationProperty().hasAccess(
            prop, user=user, level=AccessType.READ
        )

        with mock.patch.object(
            AnnotationProperty, "compute", return_value=[{"_id": "job-1"}]
        ):
            batch = self._postComputeMultiple(
                server, user, dataset["_id"], [prop]
            )
            single = server.request(
                path="/annotation_property/%s/compute" % prop["_id"],
                method="POST",
                user=user,
                params={"datasetId": str(dataset["_id"])},
                body=json.dumps({"name": prop["name"]}),
                type="application/json",
            )

        assertStatusOk(batch)
        assert batch.json == [
            {"propertyId": str(prop["_id"]), "jobs": [{"_id": "job-1"}]}
        ]
        assertStatusOk(single)
        assert single.json == [{"_id": "job-1"}]

    def testComputeMultipleCancelsQueuedJobsWhenSchedulingFails(
        self, admin, server
    ):
        """A broker failure scheduling a later property cancels the jobs
        already queued for earlier ones, so the batch stays all-or-nothing
        and a retry does not run them twice."""
        dataset = utilities.createFolder(admin, "batch-broker-failure", {})
        first = self._createProperty(admin)
        second = self._createProperty(admin)
        queued = {"_id": "job-1"}

        with mock.patch.object(
            AnnotationProperty,
            "compute",
            side_effect=[(queued,), RuntimeError("broker unavailable")],
        ), mock.patch.object(Job, "cancelJob") as cancelJob:
            resp = self._postComputeMultiple(
                server, admin, dataset["_id"], [first, second],
                exception=True,
            )

        assertStatus(resp, 500)
        cancelJob.assert_called_once_with(queued)

    def testComputeMultipleRaisesOriginalErrorWhenCancelFails(
        self, admin, server
    ):
        """A failing cancel is logged, the remaining jobs are still
        canceled, and the scheduling error -- not the cancel error -- is
        what the caller gets."""
        dataset = utilities.createFolder(admin, "batch-cancel-failure", {})
        first, second, third = (
            self._createProperty(admin) for _ in range(3)
        )
        firstJob, secondJob = {"_id": "job-1"}, {"_id": "job-2"}

        with mock.patch.object(
            AnnotationProperty,
            "compute",
            side_effect=[
                (firstJob,),
                (secondJob,),
                RuntimeError("broker unavailable"),
            ],
        ), mock.patch.object(
            Job, "cancelJob", side_effect=[RuntimeError("cancel failed"), None]
        ) as cancelJob:
            resp = self._postComputeMultiple(
                server, admin, dataset["_id"], [first, second, third],
                exception=True,
            )

        assertStatus(resp, 500)
        assert "broker unavailable" in resp.json["message"]
        assert [c.args[0] for c in cancelJob.call_args_list] == [
            firstJob, secondJob
        ]

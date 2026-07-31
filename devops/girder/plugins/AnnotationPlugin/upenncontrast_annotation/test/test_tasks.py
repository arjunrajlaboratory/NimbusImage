import json
from unittest import mock

import pytest

from girder.constants import AccessType
from pytest_girder.assertions import assertStatus

from upenncontrast_annotation.server.helpers import tasks
from upenncontrast_annotation.server.models import workerInterfaces
from upenncontrast_annotation.server.models.property import (
    AnnotationProperty,
)

from . import girder_utilities as utilities

IMAGE = "properties/blob_metrics:latest"
DATASET_ID = "5f9a1b2c3d4e5f6a7b8c9d0e"


@pytest.fixture
def dockerRun():
    """Stub out the girder/celery side effects of runJobRequest."""
    with mock.patch.object(
        tasks, "docker_run"
    ) as dockerRunTask, mock.patch.object(
        tasks, "getCurrentToken", return_value={"_id": "token"}
    ), mock.patch.object(tasks, "Setting"), mock.patch.object(
        tasks, "getQueueForRequest", return_value="cpu"
    ):
        yield dockerRunTask


def jobKwargs(dockerRun):
    """The kwargs docker_run was asked to pass to the docker task."""
    return dockerRun.apply_async.call_args.kwargs["kwargs"]


def containerArg(dockerRun, flag):
    """The value following flag in the container's argument list."""
    args = jobKwargs(dockerRun)["container_args"]
    return args[args.index(flag) + 1]


def requestInterface():
    """Call the interface request without needing a database.

    `self` is None rather than a Mock on purpose: the method must not need
    model state to build its title, and a Mock would silently absorb any
    future `self.<anything>` access instead of failing the test.
    """
    return workerInterfaces.WorkerInterfaceModel.requestWorkerUpdate(
        None, IMAGE
    )


def test_interface_request_title_names_the_image(dockerRun):
    requestInterface()
    assert (
        jobKwargs(dockerRun)["girder_job_title"]
        == "Pulled worker interface for properties/blob_metrics:latest"
    )


def test_interface_container_name_is_not_unknown_none(dockerRun):
    requestInterface()
    name = jobKwargs(dockerRun)["name"]
    assert name.startswith("interface_")
    assert "unknown" not in name
    # datasetId is absent for interface requests, so it must not appear as
    # the literal "None" in the middle of the container name.
    assert "None" not in name


def test_interface_worker_parameters_are_unchanged(dockerRun):
    requestInterface()
    # The title lives in the job, not in the payload the worker parses.
    assert json.loads(containerArg(dockerRun, "--parameters")) == {
        "image": IMAGE
    }
    assert containerArg(dockerRun, "--request") == "interface"


def test_named_request_keeps_its_name_as_the_title(dockerRun):
    tasks.runJobRequest(
        IMAGE, DATASET_ID, {"name": "Cellpose Segmentation"}, "compute"
    )
    # The title keeps the spaces the container name has to drop.
    assert jobKwargs(dockerRun)["girder_job_title"] == "Cellpose Segmentation"
    assert jobKwargs(dockerRun)["name"].startswith(
        "CellposeSegmentation_{}_".format(DATASET_ID)
    )


@pytest.mark.parametrize("name", [None, "", "   ", 123, {"a": "b"}])
def test_unusable_name_falls_back_to_request_type(dockerRun, name):
    params = {} if name is None else {"name": name}
    tasks.runJobRequest(IMAGE, DATASET_ID, params, "compute")
    assert jobKwargs(dockerRun)["girder_job_title"] == "compute"
    assert jobKwargs(dockerRun)["name"].startswith(
        "compute_{}_".format(DATASET_ID)
    )


def test_name_of_only_invalid_characters_falls_back(dockerRun):
    # Sanitizing leaves nothing, so the container name would otherwise
    # start with the datasetId and lose all trace of the request type.
    tasks.runJobRequest(IMAGE, DATASET_ID, {"name": "??? ///"}, "preview")
    assert jobKwargs(dockerRun)["name"].startswith(
        "preview_{}_".format(DATASET_ID)
    )
    assert jobKwargs(dockerRun)["girder_job_title"] == "??? ///"


@pytest.mark.parametrize("name", ["_temp mask", "-draft", "..hidden"])
def test_container_name_starts_with_an_alphanumeric(dockerRun, name):
    # Docker requires [a-zA-Z0-9] as the first character of a container
    # name, and a leading "_", "-" or "." survives the character filter.
    tasks.runJobRequest(IMAGE, DATASET_ID, {"name": name}, "compute")
    assert jobKwargs(dockerRun)["name"][0].isalnum()
    # The title is untouched by the container's naming rules.
    assert jobKwargs(dockerRun)["girder_job_title"] == name


def test_leading_punctuation_only_name_falls_back(dockerRun):
    tasks.runJobRequest(IMAGE, DATASET_ID, {"name": "___"}, "compute")
    assert jobKwargs(dockerRun)["name"].startswith(
        "compute_{}_".format(DATASET_ID)
    )


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestWorkerRequestBodyValidation:
    """A non-object body must be a 400, not an uncaught 500.

    All three endpoints hand their request body straight to runJobRequest,
    which calls .get("name") on it — a JSON array would raise
    AttributeError deep in the helper.
    """

    NON_OBJECT_BODY = json.dumps(["not", "an", "object"])

    def assertBodyRejected(self, resp):
        """400 specifically because of the body's shape.

        Asserting the message matters here: these endpoints have other 400
        paths (a missing or unknown datasetId), so a bare status check can
        pass without the body ever being validated.
        """
        assertStatus(resp, 400)
        assert "must be a JSON object" in resp.json["message"]

    def _createProperty(self, admin):
        prop = {
            "name": "test-prop",
            "image": IMAGE,
            "shape": "point",
            "tags": {"tags": ["tag1"], "exclusive": False},
            "workerInterface": {},
        }
        model = AnnotationProperty()
        model.setUserAccess(
            prop, user=admin, level=AccessType.ADMIN, save=False
        )
        return model.save(prop)

    def testAnnotationComputeNonObjectBodyReturns400(self, admin, server):
        # A real dataset, so the request gets past the dataset lookup and
        # the body is what the endpoint rejects.
        dataset = utilities.createFolder(admin, "compute-body-dataset", {})
        resp = server.request(
            path="/upenn_annotation/compute",
            method="POST",
            user=admin,
            params={"datasetId": str(dataset["_id"])},
            body=self.NON_OBJECT_BODY,
            type="application/json",
        )
        self.assertBodyRejected(resp)

    def testPropertyComputeNonObjectBodyReturns400(self, admin, server):
        prop = self._createProperty(admin)
        resp = server.request(
            path="/annotation_property/%s/compute" % prop["_id"],
            method="POST",
            user=admin,
            params={"datasetId": DATASET_ID},
            body=self.NON_OBJECT_BODY,
            type="application/json",
        )
        self.assertBodyRejected(resp)

    def testWorkerPreviewNonObjectBodyReturns400(self, admin, server):
        dataset = utilities.createFolder(admin, "preview-body-dataset", {})
        resp = server.request(
            path="/worker_preview/request",
            method="POST",
            user=admin,
            params={"datasetId": str(dataset["_id"]), "image": IMAGE},
            body=self.NON_OBJECT_BODY,
            type="application/json",
        )
        self.assertBodyRejected(resp)

    def testWorkerPreviewUnknownDatasetReturns400(self, admin, server):
        # Was a RestException 500 raised from inside the model.
        resp = server.request(
            path="/worker_preview/request",
            method="POST",
            user=admin,
            params={"datasetId": DATASET_ID, "image": IMAGE},
            body=json.dumps({"name": "preview"}),
            type="application/json",
        )
        assertStatus(resp, 400)

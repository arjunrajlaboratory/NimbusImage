import json
from unittest import mock

import pytest

from upenncontrast_annotation.server.helpers import tasks
from upenncontrast_annotation.server.models import workerInterfaces

IMAGE = "properties/blob_metrics:latest"
DATASET_ID = "5f9a1b2c3d4e5f6a7b8c9d0e"


@pytest.fixture
def dockerRun():
    """Stub out the girder/celery side effects of runJobRequest."""
    with mock.patch.object(tasks, "docker_run") as docker, mock.patch.object(
        tasks, "getCurrentToken", return_value={"_id": "token"}
    ), mock.patch.object(tasks, "Setting"), mock.patch.object(
        tasks, "getQueueForRequest", return_value="cpu"
    ):
        yield docker


def jobKwargs(dockerRun):
    """The kwargs docker_run was asked to pass to the docker task."""
    return dockerRun.apply_async.call_args.kwargs["kwargs"]


def containerArg(dockerRun, flag):
    """The value following flag in the container's argument list."""
    args = jobKwargs(dockerRun)["container_args"]
    return args[args.index(flag) + 1]


def requestInterface():
    """Call the interface request without needing a database."""
    return workerInterfaces.WorkerInterfaceModel.requestWorkerUpdate(
        mock.Mock(), IMAGE
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

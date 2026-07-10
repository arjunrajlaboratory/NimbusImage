from unittest import mock

import pytest

from upenncontrast_annotation.server.helpers import workerQueues as wq

IMAGE = "a/b:latest"


@pytest.fixture(autouse=True)
def resetModuleState():
    wq._queueCache.clear()
    wq._dockerClient = None
    yield
    wq._queueCache.clear()
    wq._dockerClient = None


def clientWithLabels(labels):
    client = mock.Mock()
    client.images.get.return_value = mock.Mock(labels=labels)
    return client


def route(client):
    """Route IMAGE through getQueueForImage using client as docker client."""
    with mock.patch.object(wq, "_getDockerClient", return_value=client):
        return wq.getQueueForImage(IMAGE)


def test_gpu_label_routes_to_gpu_queue():
    assert route(clientWithLabels({"isGPUWorker": "true"})) == wq.GPU_QUEUE


def test_cpu_label_routes_to_cpu_queue():
    assert route(clientWithLabels({"isGPUWorker": "false"})) == wq.CPU_QUEUE


def test_label_parsing_is_case_insensitive():
    assert route(clientWithLabels({"isGPUWorker": "False"})) == wq.CPU_QUEUE
    wq._queueCache.clear()
    assert route(clientWithLabels({"isGPUWorker": "True"})) == wq.GPU_QUEUE


def test_missing_label_defaults_to_gpu_and_is_cached():
    client = clientWithLabels({})
    assert route(client) == wq.GPU_QUEUE
    assert route(client) == wq.GPU_QUEUE
    assert client.images.get.call_count == 1


@pytest.mark.parametrize("label", ["1", "yes"])
def test_gpu_label_variants_route_to_gpu_queue(label):
    assert route(clientWithLabels({"isGPUWorker": label})) == wq.GPU_QUEUE


@pytest.mark.parametrize("label", ["0", "no"])
def test_cpu_label_variants_route_to_cpu_queue(label):
    assert route(clientWithLabels({"isGPUWorker": label})) == wq.CPU_QUEUE


def test_garbage_label_defaults_to_gpu_and_is_cached():
    client = clientWithLabels({"isGPUWorker": "maybe"})
    assert route(client) == wq.GPU_QUEUE
    assert route(client) == wq.GPU_QUEUE
    assert client.images.get.call_count == 1


def test_docker_error_defaults_to_gpu_and_is_not_cached():
    client = mock.Mock()
    client.images.get.side_effect = RuntimeError("daemon unreachable")
    assert route(client) == wq.GPU_QUEUE
    assert IMAGE not in wq._queueCache


def test_queue_is_cached_per_image():
    client = clientWithLabels({"isGPUWorker": "false"})
    route(client)
    route(client)
    assert client.images.get.call_count == 1

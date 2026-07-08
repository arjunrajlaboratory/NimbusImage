from unittest import mock

import pytest

from upenncontrast_annotation.server.helpers import workerQueues


@pytest.fixture(autouse=True)
def resetModuleState():
    workerQueues._queueCache.clear()
    workerQueues._dockerClient = None
    yield
    workerQueues._queueCache.clear()
    workerQueues._dockerClient = None


def clientWithLabels(labels):
    client = mock.Mock()
    client.images.get.return_value = mock.Mock(labels=labels)
    return client


def test_gpu_label_routes_to_gpu_queue():
    with mock.patch.object(workerQueues, "_getDockerClient",
                           return_value=clientWithLabels({"isGPUWorker": "true"})):
        assert workerQueues.getQueueForImage("a/b:latest") == workerQueues.GPU_QUEUE


def test_cpu_label_routes_to_cpu_queue():
    with mock.patch.object(workerQueues, "_getDockerClient",
                           return_value=clientWithLabels({"isGPUWorker": "false"})):
        assert workerQueues.getQueueForImage("a/b:latest") == workerQueues.CPU_QUEUE


def test_label_parsing_is_case_insensitive():
    with mock.patch.object(workerQueues, "_getDockerClient",
                           return_value=clientWithLabels({"isGPUWorker": "False"})):
        assert workerQueues.getQueueForImage("a/b:latest") == workerQueues.CPU_QUEUE
    workerQueues._queueCache.clear()
    with mock.patch.object(workerQueues, "_getDockerClient",
                           return_value=clientWithLabels({"isGPUWorker": "True"})):
        assert workerQueues.getQueueForImage("a/b:latest") == workerQueues.GPU_QUEUE


def test_missing_label_defaults_to_gpu_and_is_cached():
    client = clientWithLabels({})
    with mock.patch.object(workerQueues, "_getDockerClient", return_value=client):
        assert workerQueues.getQueueForImage("a/b:latest") == workerQueues.GPU_QUEUE
        assert workerQueues.getQueueForImage("a/b:latest") == workerQueues.GPU_QUEUE
    assert client.images.get.call_count == 1


@pytest.mark.parametrize("label", ["1", "yes"])
def test_gpu_label_variants_route_to_gpu_queue(label):
    with mock.patch.object(workerQueues, "_getDockerClient",
                           return_value=clientWithLabels({"isGPUWorker": label})):
        assert workerQueues.getQueueForImage("a/b:latest") == workerQueues.GPU_QUEUE


@pytest.mark.parametrize("label", ["0", "no"])
def test_cpu_label_variants_route_to_cpu_queue(label):
    with mock.patch.object(workerQueues, "_getDockerClient",
                           return_value=clientWithLabels({"isGPUWorker": label})):
        assert workerQueues.getQueueForImage("a/b:latest") == workerQueues.CPU_QUEUE


def test_garbage_label_defaults_to_gpu_and_is_cached():
    client = clientWithLabels({"isGPUWorker": "maybe"})
    with mock.patch.object(workerQueues, "_getDockerClient", return_value=client):
        assert workerQueues.getQueueForImage("a/b:latest") == workerQueues.GPU_QUEUE
        assert workerQueues.getQueueForImage("a/b:latest") == workerQueues.GPU_QUEUE
    assert client.images.get.call_count == 1


def test_docker_error_defaults_to_gpu_and_is_not_cached():
    client = mock.Mock()
    client.images.get.side_effect = RuntimeError("daemon unreachable")
    with mock.patch.object(workerQueues, "_getDockerClient", return_value=client):
        assert workerQueues.getQueueForImage("a/b:latest") == workerQueues.GPU_QUEUE
    assert "a/b:latest" not in workerQueues._queueCache


def test_queue_is_cached_per_image():
    client = clientWithLabels({"isGPUWorker": "false"})
    with mock.patch.object(workerQueues, "_getDockerClient", return_value=client):
        workerQueues.getQueueForImage("a/b:latest")
        workerQueues.getQueueForImage("a/b:latest")
    assert client.images.get.call_count == 1

"""Route worker jobs to the "cpu" or "gpu" Celery queue.

A worker's class is declared by the `isGPUWorker` docker label baked into
its image; we read it from the docker daemon Girder already uses for tool
discovery. Interface requests are the exception: they always go to the
"cpu" queue regardless of the label (see getQueueForRequest).

Unlabeled or unreadable images fail safe to the GPU queue -- a gpu-queue
consumer is expected to be able to run any worker -- but we log it, because
a mislabeled CPU worker silently eating GPU capacity is exactly what this
split exists to stop.

In local dev the docker-compose worker consumes every queue
(celery, cpu, gpu), so routing is transparent and nothing can stall.
"""

import logging

import docker
import requests

logger = logging.getLogger(__name__)

GPU_QUEUE = "gpu"
CPU_QUEUE = "cpu"

_dockerClient = None
_queueCache = {}


def _getDockerClient():
    global _dockerClient
    if _dockerClient is None:
        # This lookup sits on Girder's interactive dispatch path (the
        # request thread). The docker SDK's default client timeout is ~60s;
        # a wedged daemon would stall every uncached dispatch behind that
        # instead of failing fast into the documented gpu fail-safe. Keep
        # this short.
        _dockerClient = docker.from_env(timeout=5)
    return _dockerClient


def getQueueForRequest(image, requestType):
    """Return the Celery queue name for a worker image + request type.

    Interface calls just emit the tool's parameter schema -- no GPU compute
    -- so they always go to the CPU box. Compute/preview route by worker
    type (the isGPUWorker label, see getQueueForImage).

    HARD DEPENDENCY: interface jobs run the actual worker container with
    `--request interface` under pull_image=False, so whatever consumes the
    "cpu" queue MUST have every worker image on disk -- otherwise GPU
    workers' interface calls land on a box that lacks the image and fail.
    """
    if requestType == "interface":
        return CPU_QUEUE
    return getQueueForImage(image)


def getQueueForImage(image):
    """Return the Celery queue name ("cpu" or "gpu") for a worker image.

    Only definitive label reads are cached (per image tag). Docker errors
    are not cached, so a transient daemon hiccup retries on the next
    dispatch (the possibly-broken client is dropped and rebuilt then), and
    the missing-label default is not cached either, so re-pulling the image
    with the label added takes effect without a Girder restart.
    """
    global _dockerClient
    if image in _queueCache:
        return _queueCache[image]

    try:
        labels = _getDockerClient().images.get(image).labels or {}
    # DockerException covers from_env failures, missing images and API
    # errors; docker-py's HTTP layer can also leak raw requests exceptions
    # (socket/timeout). Anything else is a bug and should propagate.
    except (docker.errors.DockerException,
            requests.exceptions.RequestException):
        _dockerClient = None
        logger.exception(
            "Could not read the isGPUWorker label for %s; "
            "routing to the %s queue", image, GPU_QUEUE)
        return GPU_QUEUE

    raw = str(labels.get("isGPUWorker", "")).strip().lower()
    if raw in ("true", "1", "yes"):
        queue = GPU_QUEUE
    elif raw in ("false", "0", "no"):
        queue = CPU_QUEUE
    else:
        # Warns on every dispatch by design: this is a misconfiguration
        # someone should fix, and not caching it lets a re-pulled, labeled
        # image take effect without a restart.
        logger.warning(
            "Image %s has no isGPUWorker label; defaulting to the %s queue. "
            "Add the label to the worker's Dockerfile so CPU work stops "
            "landing on the GPU fleet.", image, GPU_QUEUE)
        return GPU_QUEUE

    _queueCache[image] = queue
    return queue

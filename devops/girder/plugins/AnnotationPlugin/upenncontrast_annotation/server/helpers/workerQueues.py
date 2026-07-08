"""Route worker jobs to the "cpu" or "gpu" Celery queue.

Prod runs a split fleet (AWSDeploy doc/CPU_GPU_Queue_Split.md): GPU boxes
consume the "gpu" queue, an always-on CPU box consumes "cpu". A worker's
class is declared by the `isGPUWorker` docker label baked into every
ImageAnalysisProject worker image; we read it from the docker daemon Girder
already uses for tool discovery (DOCKER_HOST -> the GPU primary, which holds
every worker image).

Unlabeled or unreadable images fail safe to the GPU queue: the always-on GPU
primary can run any worker, so nothing breaks -- but we log it, because a
mislabeled CPU worker silently eating GPU capacity is exactly what this split
exists to stop.
"""

import logging

import docker

logger = logging.getLogger(__name__)

GPU_QUEUE = "gpu"
CPU_QUEUE = "cpu"

_dockerClient = None
_queueCache = {}


def _getDockerClient():
    global _dockerClient
    if _dockerClient is None:
        # This lookup sits on Girder's interactive dispatch path (request thread).
        # The docker SDK's default client timeout is ~60s; a wedged daemon would
        # stall every uncached dispatch behind that instead of failing fast into
        # the documented gpu fail-safe. Keep this short.
        _dockerClient = docker.from_env(timeout=5)
    return _dockerClient


def getQueueForImage(image):
    """Return the Celery queue name ("cpu" or "gpu") for a worker image.

    Label lookups are cached per image tag. A docker error is not cached, so
    a transient daemon hiccup retries on the next dispatch; the (possibly
    broken) client is dropped and rebuilt then.
    """
    global _dockerClient
    if image in _queueCache:
        return _queueCache[image]

    try:
        labels = _getDockerClient().images.get(image).labels or {}
    except Exception:
        _dockerClient = None
        logger.exception(
            "Could not read the isGPUWorker label for %s; routing to the %s queue",
            image, GPU_QUEUE)
        return GPU_QUEUE

    raw = str(labels.get("isGPUWorker", "")).strip().lower()
    if raw in ("true", "1", "yes"):
        queue = GPU_QUEUE
    elif raw in ("false", "0", "no"):
        queue = CPU_QUEUE
    else:
        queue = GPU_QUEUE
        logger.warning(
            "Image %s has no isGPUWorker label; defaulting to the %s queue. "
            "Add the label to the worker's Dockerfile so CPU work stops "
            "landing on the GPU fleet.", image, GPU_QUEUE)

    _queueCache[image] = queue
    return queue

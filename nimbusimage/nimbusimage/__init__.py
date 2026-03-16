"""NimbusImage Python API.

Usage:
    import nimbusimage as ni

    client = ni.connect(api_url, token=...)
    ds = client.dataset(dataset_id)
    img = ds.images.get(channel=0)
    anns = ds.annotations.list(shape='polygon')
"""

from nimbusimage.client import NimbusClient
from nimbusimage.collections import Collection
from nimbusimage.coordinates import attach_geometry_methods
from nimbusimage.dataset import Dataset
from nimbusimage.jobs import Job
from nimbusimage.filters import (
    filter_by_tags,
    filter_by_location,
    group_by_location,
)
from nimbusimage.models import (
    Annotation,
    Connection,
    FrameInfo,
    Location,
    PixelSize,
    Property,
)
from nimbusimage.worker import WorkerContext

# Attach geometry methods (polygon, point, get_mask, etc.) to Annotation
attach_geometry_methods()


def connect(
    api_url: str | None = None,
    token: str | None = None,
    username: str | None = None,
    password: str | None = None,
) -> NimbusClient:
    """Connect to a NimbusImage server.

    Args:
        api_url: Girder API URL. Or set NI_API_URL env var.
        token: Auth token. Or set NI_TOKEN env var.
        username: Username for interactive auth.
        password: Password for interactive auth.

    Returns:
        Authenticated NimbusClient.
    """
    return NimbusClient(
        api_url=api_url, token=token,
        username=username, password=password,
    )


def worker_context(
    dataset_id: str | None = None,
    api_url: str | None = None,
    token: str | None = None,
    params: dict | None = None,
) -> WorkerContext:
    """Create a worker context for Docker worker scripts.

    Args:
        dataset_id: The dataset folder ID.
        api_url: Girder API URL.
        token: Auth token.
        params: Worker parameters dict (from the job).

    Returns:
        WorkerContext with parsed parameters and dataset access.
    """
    return WorkerContext(
        dataset_id=dataset_id, api_url=api_url,
        token=token, params=params,
    )


__all__ = [
    # Connection
    "connect",
    "worker_context",
    # Classes
    "NimbusClient",
    "Collection",
    "Dataset",
    "Job",
    "WorkerContext",
    # Data models
    "Annotation",
    "Connection",
    "Property",
    "Location",
    "PixelSize",
    "FrameInfo",
    # Filters
    "filter_by_tags",
    "filter_by_location",
    "group_by_location",
]

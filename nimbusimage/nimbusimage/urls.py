"""URL generation for opening NimbusImage in the browser.

Generates frontend URLs for datasets, dataset views, configurations,
and projects. Can optionally open them in the default browser.
"""

from __future__ import annotations

import webbrowser
from typing import TYPE_CHECKING
from urllib.parse import urlencode

if TYPE_CHECKING:
    pass

DEFAULT_FRONTEND_URL = "http://localhost:5173"


def _build_url(
    base_url: str, path: str, query: dict | None = None
) -> str:
    """Build a full URL with hash routing."""
    url = f"{base_url.rstrip('/')}/#/{path.lstrip('/')}"
    if query:
        # Filter out None values
        filtered = {k: v for k, v in query.items() if v is not None}
        if filtered:
            url += "?" + urlencode(filtered)
    return url


def dataset_info_url(
    dataset_id: str,
    frontend_url: str = DEFAULT_FRONTEND_URL,
) -> str:
    """URL for the dataset info page."""
    return _build_url(frontend_url, f"dataset/{dataset_id}")


def dataset_view_url(
    view_id: str,
    frontend_url: str = DEFAULT_FRONTEND_URL,
    xy: int | None = None,
    z: int | None = None,
    time: int | None = None,
    layer: str | None = None,
    unroll_xy: bool | None = None,
    unroll_z: bool | None = None,
    unroll_t: bool | None = None,
) -> str:
    """URL for the dataset image viewer.

    Args:
        view_id: The dataset view ID (from dataset_view endpoint).
        frontend_url: Base URL of the NimbusImage frontend.
        xy: XY position to navigate to.
        z: Z-slice to navigate to.
        time: Time point to navigate to.
        layer: Layer mode ('single', 'multiple', 'unroll').
        unroll_xy: Unroll XY dimension.
        unroll_z: Unroll Z dimension.
        unroll_t: Unroll time dimension.
    """
    query = {
        "xy": xy,
        "z": z,
        "time": time,
        "layer": layer,
        "unrollXY": str(unroll_xy).lower() if unroll_xy is not None else None,
        "unrollZ": str(unroll_z).lower() if unroll_z is not None else None,
        "unrollT": str(unroll_t).lower() if unroll_t is not None else None,
    }
    return _build_url(frontend_url, f"datasetView/{view_id}/view", query)


def configuration_url(
    config_id: str,
    frontend_url: str = DEFAULT_FRONTEND_URL,
) -> str:
    """URL for the configuration info page."""
    return _build_url(frontend_url, f"configuration/{config_id}")


def project_url(
    project_id: str,
    frontend_url: str = DEFAULT_FRONTEND_URL,
) -> str:
    """URL for the project info page."""
    return _build_url(frontend_url, f"project/{project_id}")


def open_url(url: str) -> None:
    """Open a URL in the default browser."""
    webbrowser.open(url)

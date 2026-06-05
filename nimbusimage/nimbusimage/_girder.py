"""Internal wrapper around girder_client.GirderClient.

This module is an implementation detail. Users should never import from it.
All HTTP communication goes through this wrapper so that endpoint paths
and error handling are centralized.
"""

from __future__ import annotations

import os
from importlib.metadata import PackageNotFoundError, version

import girder_client
import requests

from nimbusimage.exceptions import WorkerRateLimitError

try:
    _VERSION = version("nimbusimage")
except PackageNotFoundError:  # running from a source tree without install
    _VERSION = "0+unknown"

# Distinctive User-Agent so the deployment can recognize traffic from the
# nimbusimage Python client (vs. the browser front-end, which sends a
# "Mozilla/*" agent). The HAProxy load balancer uses this to scope worker
# request rate limiting to programmatic API clients only.
USER_AGENT = f"nimbusimage-python/{_VERSION}"


def create_client(
    api_url: str | None = None,
    token: str | None = None,
    api_key: str | None = None,
    username: str | None = None,
    password: str | None = None,
) -> girder_client.GirderClient:
    """Create and authenticate a GirderClient.

    Connection modes (tried in order):
    1. Explicit token
    2. Explicit API key
    3. Username + password
    4. NI_API_KEY environment variable
    5. NI_TOKEN environment variable

    Args:
        api_url: Girder API URL (e.g., 'http://localhost:8080/api/v1').
        token: Pre-existing authentication token.
        api_key: Girder API key (persistent, doesn't expire).
        username: Username for interactive auth.
        password: Password for interactive auth.

    Returns:
        Authenticated GirderClient instance.

    Raises:
        ValueError: If no valid authentication method is provided.
    """
    if api_url is None:
        api_url = os.environ.get("NI_API_URL")
    if api_url is None:
        raise ValueError(
            "api_url must be provided or set NI_API_URL "
            "environment variable"
        )

    gc = girder_client.GirderClient(apiUrl=api_url)

    # Attach a persistent session that advertises the nimbusimage client
    # User-Agent on every request (including the API-key token exchange).
    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT
    gc._session = session

    if token is not None:
        gc.setToken(token)
    elif api_key is not None:
        gc.authenticate(apiKey=api_key)
    elif username is not None or password is not None:
        if username is None or password is None:
            raise ValueError(
                "Both username and password must be provided"
            )
        gc.authenticate(username=username, password=password)
    else:
        env_api_key = os.environ.get("NI_API_KEY")
        env_token = os.environ.get("NI_TOKEN")
        if env_api_key is not None:
            gc.authenticate(apiKey=env_api_key)
        elif env_token is not None:
            gc.setToken(env_token)
        else:
            raise ValueError(
                "Provide token=, api_key=, username=/password=, "
                "or set NI_API_KEY/NI_TOKEN environment variable"
            )

    return gc


def _parse_retry_after(response) -> int | None:
    """Extract the Retry-After header (seconds) from a response, if present."""
    if response is None:
        return None
    value = response.headers.get("Retry-After")
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def submit_worker_job(gc, path: str, body: dict):
    """POST a worker-compute request, translating rate-limit responses.

    Worker-compute endpoints are rate limited per user by the deployment
    (GPU workers take minutes to start). On HTTP 429 this raises
    :class:`~nimbusimage.exceptions.WorkerRateLimitError` carrying the
    server's ``Retry-After`` hint, instead of a generic ``HttpError``.

    Returns the job document (unwrapped from a single-element list if the
    backend returns one).
    """
    try:
        resp = gc.post(path, json=body)
    except girder_client.HttpError as exc:
        if exc.status == 429:
            raise WorkerRateLimitError(
                retry_after=_parse_retry_after(exc.response)
            ) from exc
        raise
    return resp[0] if isinstance(resp, (list, tuple)) else resp

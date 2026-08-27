"""Internal wrapper around girder_client.GirderClient.

This module is an implementation detail. Users should never import from it.
All HTTP communication goes through this wrapper so that endpoint paths
and error handling are centralized.
"""

from __future__ import annotations

import inspect
import os

import girder_client
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# NIM-006: transient 502/503/504 responses happen under normal load
# (backend saturation, proxy timeouts). Retry them with jittered
# exponential backoff so callers don't have to hand-roll retry loops.
#
# Only idempotent methods are retried (urllib3's default allowed set:
# GET/HEAD/PUT/DELETE/OPTIONS/TRACE). POST is deliberately excluded so a
# retried compute submission can't create duplicate jobs/annotations
# (NIM-007). raise_on_status=False lets girder_client raise its usual
# HttpError on the final response instead of a urllib3 RetryError.
_RETRY_TOTAL = 5
_RETRY_STATUS_FORCELIST = (502, 503, 504)
_RETRY_BACKOFF_FACTOR = 0.5
_RETRY_BACKOFF_JITTER = 0.5

# backoff_jitter was added in urllib3 2.0. Passing it on urllib3 1.26.x
# raises TypeError at construction, so gate it by feature detection rather
# than version parsing. Backoff still applies without jitter on older
# urllib3 — we just lose the thundering-herd spread.
_RETRY_SUPPORTS_JITTER = (
    "backoff_jitter" in inspect.signature(Retry.__init__).parameters
)


def _build_retry_session() -> requests.Session:
    """Build a requests.Session that retries transient 5xx with backoff."""
    retry_kwargs = dict(
        total=_RETRY_TOTAL,
        status_forcelist=_RETRY_STATUS_FORCELIST,
        backoff_factor=_RETRY_BACKOFF_FACTOR,
        respect_retry_after_header=True,
        raise_on_status=False,
    )
    if _RETRY_SUPPORTS_JITTER:
        retry_kwargs["backoff_jitter"] = _RETRY_BACKOFF_JITTER
    retry = Retry(**retry_kwargs)
    adapter = HTTPAdapter(max_retries=retry)
    session = requests.Session()
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    return session


def create_client(
    api_url: str | None = None,
    token: str | None = None,
    api_key: str | None = None,
    username: str | None = None,
    password: str | None = None,
    anonymous: bool = False,
) -> girder_client.GirderClient:
    """Create and authenticate a GirderClient.

    Connection modes (tried in order):
    1. Anonymous (no authentication; public resources only)
    2. Explicit token
    3. Explicit API key
    4. Username + password
    5. NI_API_KEY environment variable
    6. NI_TOKEN environment variable

    Args:
        api_url: Girder API URL (e.g., 'http://localhost:8080/api/v1').
        token: Pre-existing authentication token.
        api_key: Girder API key (persistent, doesn't expire).
        username: Username for interactive auth.
        password: Password for interactive auth.
        anonymous: Connect without credentials. Only public resources
            are accessible.

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
    # Route all requests (including authentication) through a session that
    # retries transient 5xx (NIM-006). girder_client uses gc._session for
    # every request when it is set.
    gc._session = _build_retry_session()

    if anonymous:
        if any(
            credential is not None
            for credential in (token, api_key, username, password)
        ):
            raise ValueError(
                "anonymous=True cannot be combined with credentials"
            )
    elif token is not None:
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

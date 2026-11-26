"""Internal wrapper around girder_client.GirderClient.

This module is an implementation detail. Users should never import from it.
All HTTP communication goes through this wrapper so that endpoint paths
and error handling are centralized.
"""

from __future__ import annotations

import enum
import inspect
import json
import math
import os
import sys
from importlib.metadata import PackageNotFoundError, version

import girder_client
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

try:
    import orjson
except ImportError:  # still works, at stdlib speed
    orjson = None

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


try:
    _VERSION = version("nimbusimage")
except PackageNotFoundError:  # running from a source tree without install
    _VERSION = "0+unknown"

# Identifies this client to the deployment. The production load balancer
# (AWSDeploy, doc/Worker_Rate_Limiting.md) rate-limits worker-compute
# submissions from this User-Agent only, so it must stay a
# "nimbusimage-python/" prefix. girder_client's default would otherwise be
# requests' generic "python-requests/<version>".
USER_AGENT = f"nimbusimage-python/{_VERSION}"


# JSON request bodies and responses go through orjson: ~10x faster to
# encode than requests' json= (stdlib json.dumps) and ~2.5x faster to parse
# than .json(), which also copies the whole body into a str first. The
# stdlib behavior is kept on purpose (the same policy as
# devops/girder/annotation_client/annotation_client/transport.py):
# - NaN/Infinity raise ValueError before sending, as allow_nan=False did;
#   orjson alone would silently write null.
# - numpy scalars and C-contiguous arrays are serialized
#   (OPT_SERIALIZE_NUMPY).
# - Dataclasses and datetimes pass through to stdlib, which rejects them as
#   before (a NaN inside a dataclass would otherwise slip out as null).
# - Whatever else orjson can't encode (non-str dict keys, ints past 64 bits,
#   float subclasses) or decode (NaN tokens, non-UTF-8 or truncated bodies)
#   falls back to the stdlib path, which accepts or raises as before. One
#   decode difference remains: integers past 64 bits parse as floats, but
#   Girder can't emit them (MongoDB stores at most 64-bit integers).
_NON_FINITE_MESSAGE = "Out of range float values are not JSON compliant"
_ORJSON_OPTIONS = (
    orjson.OPT_SERIALIZE_NUMPY
    | orjson.OPT_PASSTHROUGH_DATACLASS
    | orjson.OPT_PASSTHROUGH_DATETIME
) if orjson is not None else 0


def _contains_non_finite(value) -> bool:
    """Whether value holds a NaN or infinite float anywhere inside it.

    Walks dicts, lists, tuples and Enum values: everything orjson encodes
    that can hold a float, except dataclasses, which go to stdlib.
    """
    # numpy objects can only be present if numpy was imported already.
    np = sys.modules.get("numpy")
    stack = [value]
    while stack:
        item = stack.pop()
        if isinstance(item, float):
            if not math.isfinite(item):
                return True
        elif isinstance(item, dict):
            stack.extend(item.values())
        elif isinstance(item, (list, tuple)):
            stack.extend(item)
        elif isinstance(item, enum.Enum):
            # orjson encodes a plain Enum by its value, so check that.
            stack.append(item.value)
        elif np is not None and isinstance(item, (np.ndarray, np.floating)):
            if item.dtype.kind == "f" and not np.isfinite(item).all():
                return True
    return False


def dumps_json(value) -> bytes:
    """Encode value as a UTF-8 JSON request body, like requests' json=."""
    if orjson is not None:
        try:
            body = orjson.dumps(value, option=_ORJSON_OPTIONS)
        except orjson.JSONEncodeError:
            pass  # let stdlib accept it or raise its usual error
        else:
            # orjson writes NaN/Infinity as null. A body without any null
            # can't have had one, so only bodies with a null pay for the
            # walk (about 2x faster than stdlib encoding even then).
            if body.find(b"null") != -1 and _contains_non_finite(value):
                raise ValueError(_NON_FINITE_MESSAGE)
            return body
    return json.dumps(value, allow_nan=False).encode("utf-8")


def loads_json(response: requests.Response):
    """Parse a response body as JSON, like ``response.json()``."""
    if orjson is not None:
        try:
            return orjson.loads(response.content)
        except orjson.JSONDecodeError:
            pass  # let requests parse it or raise its usual error
    return response.json()


class FastJsonGirderClient(girder_client.GirderClient):
    """GirderClient whose JSON requests and responses go through orjson."""

    def sendRestRequest(self, method, path, parameters=None, data=None,
                        files=None, json=None, headers=None, jsonResp=True,
                        **kwargs):
        # requests ignores json= when data or files are given; so do we.
        if json is not None and not data and not files:
            data = dumps_json(json)
            json = None
            # A caller's own Content-Type wins, as it does in requests.
            headers = {"Content-Type": "application/json", **(headers or {})}
        response = super().sendRestRequest(
            method, path, parameters, data=data, files=files, json=json,
            headers=headers, jsonResp=False, **kwargs
        )
        return loads_json(response) if jsonResp else response


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
    session.headers["User-Agent"] = USER_AGENT
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
) -> FastJsonGirderClient:
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
        Authenticated FastJsonGirderClient instance.

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

    gc = FastJsonGirderClient(apiUrl=api_url)
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

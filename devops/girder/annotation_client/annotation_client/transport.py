"""
HTTP transport shared by every annotation_client helper class.

All requests from UPennContrastAnnotationClient, UPennContrastDataset and the
worker clients go through FastJsonGirderClient.sendRestRequest, so JSON
encoding, decoding and connection handling live in this one place instead of
being re-decided per endpoint.

- Responses are parsed with orjson straight from the response bytes. That is
  roughly 2.5x faster than requests' ``.json()`` (stdlib json), and it skips
  the full ``str`` copy of the body that ``.json()`` makes first.
- Request bodies are encoded with orjson, roughly 10x faster than requests'
  ``json=`` (stdlib ``json.dumps(allow_nan=False)``).
- Requests share one ``requests.Session``. GET/PUT/DELETE reuse pooled
  keep-alive connections and retry 502/503 with backoff. See
  buildRetrySession and FastJsonGirderClient for what stays as it was on
  module-level ``requests.*``: POSTs on fresh connections, no cookies.

Compatibility with the stdlib path is deliberate:

- NaN and Infinity still raise ``ValueError`` before anything is sent, as
  stdlib's ``allow_nan=False`` did. orjson alone would silently write null.
- numpy scalars and arrays are serialized (OPT_SERIALIZE_NUMPY). np.float64
  worked before because it subclasses float; np.float32, numpy ints and
  C-contiguous native-order ndarrays now work too, where stdlib raised
  TypeError. orjson also accepts plain Enums (encoded by value, which the
  NaN check covers) and UUIDs, which stdlib did not.
- Dataclasses and datetimes are passed through to the stdlib path, which
  rejects them as before (orjson would encode them, and a NaN inside a
  dataclass would slip out as null).
- Anything else orjson can't encode (non-str dict keys, ints past 64 bits,
  float subclasses, nesting deeper than 255) or decode (NaN tokens, non-UTF-8
  or truncated bodies) goes through the stdlib path, which accepts and
  rejects exactly what it did before.
- One decode difference remains: orjson reads integers outside the 64-bit
  range as floats rather than failing. Girder can't emit them, since MongoDB
  stores at most 64-bit integers.
- Without orjson installed everything still works, at stdlib speed.
"""

import enum
import http.cookiejar
import inspect
import json
import math
import sys

import girder_client
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

try:
    import orjson
except ImportError:
    orjson = None

# Only idempotent methods are retried (urllib3's default allowed set:
# GET/HEAD/PUT/DELETE/OPTIONS/TRACE), so a retried POST can't create
# duplicate annotations. raise_on_status=False lets girder_client raise its
# usual HttpError on the final response instead of a urllib3 RetryError.
# Like nimbusimage/_girder.py, except that 504 is not retried: the load
# balancer sends it after a request has run for its full 300 s server
# timeout, so a retry would rerun the same slow read or delete (up to six
# times) instead of failing as it did before.
RETRY_TOTAL = 5
RETRY_STATUS_FORCELIST = (502, 503)
RETRY_BACKOFF_FACTOR = 0.5
RETRY_BACKOFF_JITTER = 0.5
# urllib3's default retryable set; spelled out because urllib3 < 1.26 names
# the constant differently.
IDEMPOTENT_METHODS = frozenset(
    ["GET", "HEAD", "PUT", "DELETE", "OPTIONS", "TRACE"]
)

# backoff_jitter was added in urllib3 2.0; passing it to 1.26.x raises.
RETRY_SUPPORTS_JITTER = (
    "backoff_jitter" in inspect.signature(Retry.__init__).parameters
)

NON_FINITE_MESSAGE = "Out of range float values are not JSON compliant"

# requirements.txt and setup.py require orjson>=3.10: OPT_PASSTHROUGH_*
# needs 3.3 (read here, at import), and the numpy scalars the module
# docstring lists (np.bool_, np.float16) need 3.5.2 and 3.10.
ORJSON_OPTIONS = (
    orjson.OPT_SERIALIZE_NUMPY
    | orjson.OPT_PASSTHROUGH_DATACLASS
    | orjson.OPT_PASSTHROUGH_DATETIME
) if orjson is not None else 0


class _RejectAllCookies(http.cookiejar.DefaultCookiePolicy):
    def set_ok(self, cookie, request):
        return False


def buildRetrySession():
    """Build a pooled requests.Session that retries transient 5xx."""
    retryKwargs = dict(
        total=RETRY_TOTAL,
        status_forcelist=RETRY_STATUS_FORCELIST,
        backoff_factor=RETRY_BACKOFF_FACTOR,
        respect_retry_after_header=True,
        raise_on_status=False,
    )
    if RETRY_SUPPORTS_JITTER:
        retryKwargs["backoff_jitter"] = RETRY_BACKOFF_JITTER
    adapter = HTTPAdapter(max_retries=Retry(**retryKwargs))
    session = requests.Session()
    # Module-level requests.* kept no cookies, so the load balancer's sticky
    # SERVER cookie never pinned a worker to one Girder backend. Keep it so.
    session.cookies.set_policy(_RejectAllCookies())
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    return session


def containsNonFinite(value):
    """Whether value holds a NaN or infinite float anywhere inside it.

    Walks dicts, lists, tuples and Enum values (everything orjson encodes
    that can hold a float, dataclasses aside: those go to stdlib), and
    checks Python floats (np.float64 included), numpy floating scalars and
    float arrays.
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


def dumpsJson(value):
    """Encode value as a UTF-8 JSON request body.

    Accepts everything requests' ``json=`` accepted and raises ValueError
    on NaN/Infinity the same way. See the module docstring.
    """
    if orjson is not None:
        try:
            body = orjson.dumps(value, option=ORJSON_OPTIONS)
        except orjson.JSONEncodeError:
            pass  # let stdlib accept it or raise its usual error
        else:
            # orjson writes NaN/Infinity as null. A body without any null
            # can't have had one, so only bodies with a null pay for the
            # walk (still several times cheaper than stdlib encoding).
            if body.find(b"null") != -1 and containsNonFinite(value):
                raise ValueError(NON_FINITE_MESSAGE)
            return body
    return json.dumps(value, allow_nan=False).encode("utf-8")


def loadsJson(response):
    """Parse a requests response body as JSON, like ``response.json()``."""
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
        if (self._session is not None
                and method.upper() not in IDEMPOTENT_METHODS):
            # A pooled connection the server closes just as a request goes
            # out fails that request, and urllib3 won't retry a POST. Send
            # POST/PATCH on a fresh connection, as module-level requests.*
            # did; GET loops still reuse connections.
            self._session.close()
        # requests ignores json= when data or files are given; so do we.
        if json is not None and not data and not files:
            data = dumpsJson(json)
            json = None
            # A caller's own Content-Type wins, as it does in requests.
            headers = {"Content-Type": "application/json", **(headers or {})}
        response = super().sendRestRequest(
            method, path, parameters, data=data, files=files, json=json,
            headers=headers, jsonResp=False, **kwargs
        )
        return loadsJson(response) if jsonResp else response


def createGirderClient(apiUrl, token):
    """Build an authenticated FastJsonGirderClient with a retrying session.

    :param str apiUrl: The api URL to the girder server
    :param str token: The girder token for authentication
    """
    client = FastJsonGirderClient(apiUrl=apiUrl)
    # girder_client sends every request through _session when it is set.
    client._session = buildRetrySession()
    client.setToken(token)
    return client

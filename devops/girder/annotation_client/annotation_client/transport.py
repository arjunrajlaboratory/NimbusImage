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
- Requests share one pooled ``requests.Session`` (keep-alive), and idempotent
  requests retry transient 502/503/504 responses with backoff.

Compatibility with the stdlib path is deliberate:

- NaN and Infinity still raise ``ValueError`` before anything is sent, as
  stdlib's ``allow_nan=False`` did. orjson alone would silently write null.
- numpy scalars and arrays are serialized (OPT_SERIALIZE_NUMPY). np.float64
  worked before because it subclasses float; np.float32, numpy ints and
  ndarrays now work too, where stdlib raised TypeError.
- Anything orjson can't encode (non-str dict keys, ints past 64 bits, float
  subclasses, nesting deeper than 255) or decode (NaN tokens, non-UTF-8 or
  truncated bodies) goes through the stdlib path, which accepts and rejects
  exactly what it did before.
- Without orjson installed everything still works, at stdlib speed.
"""

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
# Mirrors nimbusimage/_girder.py.
RETRY_TOTAL = 5
RETRY_STATUS_FORCELIST = (502, 503, 504)
RETRY_BACKOFF_FACTOR = 0.5
RETRY_BACKOFF_JITTER = 0.5

# backoff_jitter was added in urllib3 2.0; passing it to 1.26.x raises.
RETRY_SUPPORTS_JITTER = (
    "backoff_jitter" in inspect.signature(Retry.__init__).parameters
)

NON_FINITE_MESSAGE = "Out of range float values are not JSON compliant"


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
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    return session


def containsNonFinite(value):
    """Whether value holds a NaN or infinite float anywhere inside it.

    Walks dicts, lists and tuples, and checks Python floats (np.float64
    included), numpy floating scalars and float arrays.
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
            body = orjson.dumps(value, option=orjson.OPT_SERIALIZE_NUMPY)
        except orjson.JSONEncodeError:
            pass  # let stdlib accept it or raise its usual error
        else:
            # orjson writes NaN/Infinity as null. A body without any null
            # can't have had one, which spares the walk on typical payloads.
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

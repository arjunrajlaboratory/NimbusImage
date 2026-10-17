"""Plumbing shared by every tool: the caller's client, error mapping,
compact results, and the call log."""

from __future__ import annotations

import contextlib
import functools
import inspect
import json
import logging
import math
import threading
import time

import girder_client
import requests
from urllib3.exceptions import ReadTimeoutError
from urllib3.util.retry import Retry
from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.mcpserver import Image
from mcp.server.mcpserver.exceptions import ToolError
from mcp_types import ToolAnnotations

import nimbusimage as ni

from nimbusimage_mcp import auth
from nimbusimage_mcp.config import Settings

log = logging.getLogger("nimbusimage_mcp.calls")

READ_ONLY = ToolAnnotations(readOnlyHint=True, openWorldHint=False)
# Writes server state but none of the user's data (e.g. registering a
# worker's parameter interface).
CACHE_FILL = ToolAnnotations(
    readOnlyHint=False, destructiveHint=False, idempotentHint=True,
    openWorldHint=False,
)
# Changes stored data; clients should ask the user first.
WRITES = ToolAnnotations(
    readOnlyHint=False, destructiveHint=True, idempotentHint=False,
    openWorldHint=False,
)

_settings: Settings | None = None


def configure(settings: Settings) -> None:
    global _settings
    _settings = settings


def settings() -> Settings:
    if _settings is None:
        raise RuntimeError("nimbusimage_mcp is not configured")
    return _settings


def client() -> ni.NimbusClient:
    """A nimbusimage client acting as the caller, from this request's
    verified token. There is no fallback credential."""
    access = get_access_token()
    if access is None or not (access.claims or {}).get("girder_token"):
        # Unreachable behind the auth middleware; a guard against ever
        # serving a request without a caller.
        raise ToolError("Not authenticated.")
    nc = ni.connect(settings().api_url, token=access.claims["girder_token"])
    _bound_requests(nc.girder._session)
    return nc


class _NoReadTimeoutRetry(Retry):
    """A Retry that gives up at once on a read timeout (and only then)."""

    def increment(self, method=None, url=None, response=None, error=None,
                  _pool=None, _stacktrace=None):
        if isinstance(error, ReadTimeoutError):
            raise error
        return super().increment(
            method, url, response, error, _pool, _stacktrace
        )


# (connect, read) seconds for every request a tool makes. girder_client
# sets none, so a hung Girder would hold a worker thread forever: a
# deadline-bounded wait (ni_job_wait) returns at its cap, but its
# abandoned thread would never end. The read timeout is above the
# server's own aggregation cap (AGGREGATION_MAX_TIME_MS, 300 s), so a
# legitimate slow request is never cut off first. Behind HAProxy
# (production reaches Girder through it) its own 300 s server timeout
# answers 504 first; see _bound_requests.
HTTP_TIMEOUT = (10, 330)


def _bound_requests(session) -> None:
    """Bound every request of a nimbusimage session.

    A default timeout (requests.Session has no setting for one;
    girder_client calls session.get/post/..., which call
    session.request). And no retry after a read timeout: nimbusimage's
    retry adapter retries GET/PUT/DELETE on read errors up to 5 times,
    which would turn one timeout into six requests (each re-running a
    slow server aggregation) and a stuck thread into half an hour.
    A 504 is the same event seen through a proxy (HAProxy answers 504
    only when its server timeout runs out, never on a failed connect),
    so it is not retried either. Every other retry stays: connect
    errors, 502/503, and a connection dropped before the response (a
    recycled keep-alive).
    """
    for adapter in session.adapters.values():
        retries = getattr(adapter, "max_retries", None)
        if isinstance(retries, Retry):
            # Same settings, two changed rules; new() keeps the class.
            adapter.max_retries = retries.new(status_forcelist=frozenset(
                retries.status_forcelist or ()) - {504})
            adapter.max_retries.__class__ = _NoReadTimeoutRetry
    request = session.request

    def request_with_timeout(method, url, **kwargs):
        kwargs.setdefault("timeout", HTTP_TIMEOUT)
        return request(method, url, **kwargs)

    session.request = request_with_timeout


def caller_id() -> str | None:
    access = get_access_token()
    return access.subject if access else None


def compact(result):
    """Tool results go out as compact JSON text. The SDK would indent dict
    results (about a third more bytes, measured in the spike). Content
    (text, an image, or a list of them) passes through."""
    if isinstance(result, (str, Image)) or (
        isinstance(result, list)
        and all(isinstance(item, (str, Image)) for item in result)
    ):
        return result
    return json.dumps(result, separators=(",", ":"), default=str)


def result_size(result) -> int:
    """Bytes on the wire: images travel base64-encoded, text as is."""
    if isinstance(result, list):
        return sum(result_size(item) for item in result)
    if isinstance(result, Image):
        return 4 * math.ceil(len(result.data or b"") / 3)
    return len(result.encode())


def girder_message(e: girder_client.HttpError) -> str:
    try:
        return json.loads(e.responseText).get("message", "")
    except (ValueError, AttributeError):
        return ""


def tool_error(e: girder_client.HttpError) -> ToolError:
    if e.status == 401:
        access = get_access_token()
        if access is not None and access.client_id != auth.CLIENT_ID:
            # An OAuth session is full-access, so no scope is missing: the
            # connection was ended (or its session expired) mid-call.
            return ToolError(
                "NimbusImage refused this call (HTTP 401): your sign-in has "
                "ended. Reconnect NimbusImage in your client and try again."
            )
        # The verifier checked this session at the start of the request,
        # so the likeliest cause is a scoped API key lacking the scope
        # this call needs (e.g. help topics and job status need
        # core.user_auth), not an expired session.
        return ToolError(
            "NimbusImage refused this call with your API key (HTTP 401). "
            "If the key was created with limited scopes, this call needs "
            "a scope it lacks; a full-access key works. Otherwise the key "
            "was just revoked."
        )
    if e.status == 403:
        return ToolError(
            "Access denied: you do not have permission for this. "
            f"{girder_message(e)}".strip()
        )
    if e.status == 400:
        # Girder answers 400, not 404, for an id that matches no folder.
        return ToolError(f"Invalid request: {girder_message(e)}")
    if e.status == 404:
        return ToolError(f"Not found. {girder_message(e)}".strip())
    if e.status == 504:
        # A proxy's timeout: the same advice as a read timeout.
        return ToolError(TOO_SLOW)
    return ToolError(f"NimbusImage server error ({e.status}).")


# Long list arguments (e.g. 10,000 annotation ids) are logged by size.
MAX_LOGGED_LIST = 20


def _loggable(kwargs: dict) -> dict:
    return {
        key: f"<{len(value)} items>"
        if isinstance(value, list) and len(value) > MAX_LOGGED_LIST
        else value
        for key, value in kwargs.items()
    }


class _Call:
    result = None


@contextlib.contextmanager
def _recorded(name: str, kwargs: dict):
    """Map Girder errors to tool errors and log the call: tool, caller,
    duration, wire size. Never logs credentials."""
    call = _Call()
    start = time.perf_counter()
    # kind: a fixed label, safe for the server log; error: the message,
    # which can quote the caller's input, so only the call log gets it.
    kind = error = None
    succeeded = False
    try:
        yield call
        succeeded = True
    except ToolError as e:
        kind, error = "tool error", str(e)
        raise
    except girder_client.HttpError as e:
        kind = error = f"HTTP {e.status}"
        raise tool_error(e) from None
    except requests.ConnectionError as e:
        # requests reports a read timeout while streaming a body as a
        # ConnectionError wrapping urllib3's ReadTimeoutError.
        if e.args and isinstance(e.args[0], ReadTimeoutError):
            kind = error = "timeout"
            raise ToolError(TOO_SLOW) from None
        # Includes ConnectTimeout (also a requests.Timeout).
        kind = error = "connection"
        raise ToolError("Could not reach the NimbusImage server.") from None
    except requests.Timeout:
        # A read timeout (HTTP_TIMEOUT). The exception text names the
        # internal Girder host, so it is not passed on.
        kind = error = "timeout"
        raise ToolError(TOO_SLOW) from None
    except requests.RequestException:
        # The rest: a truncated or undecodable answer and the like
        # (HttpError, also a RequestException, is handled above).
        kind = error = "bad response"
        raise ToolError(
            "NimbusImage sent an incomplete answer; try again."
        ) from None
    except (ValueError, PermissionError) as e:
        # nimbusimage reports bad input as ValueError ("No large image
        # found in dataset ...") and a key scope problem as
        # PermissionError; both messages are meant for the user.
        kind, error = "bad input", str(e)
        raise ToolError(str(e)) from None
    finally:
        record = {
            "ts": round(time.time(), 3),
            "tool": name,
            "user": caller_id(),
            "seconds": round(time.perf_counter() - start, 3),
            "bytes": result_size(call.result) if succeeded else None,
            # "unhandled": not one of the mapped errors; the SDK reports
            # it to the client.
            "error": None if succeeded else (kind or "unhandled"),
        }
        # The server log never carries arguments or error messages
        # (dataset ids, tags, parameters are the user's data); the opt-in
        # call log, kept for evals, does.
        log.info(json.dumps(record, default=str))
        call_log = _settings.call_log if _settings else None
        if call_log:
            line = json.dumps({
                **record, "args": _loggable(kwargs),
                "error": None if succeeded else (error or "unhandled"),
            }, default=str)
            # An optional sink: failing to write it must not turn a
            # finished call (perhaps one that changed data) into an error.
            try:
                with _log_lock, open(call_log, "a") as f:
                    f.write(line + "\n")
            except OSError as e:
                log.warning("Could not write the call log: %s", e)


_log_lock = threading.Lock()
TOO_SLOW = (
    "NimbusImage took too long to answer; narrow the request or try again."
)


def instrumented(fn):
    """Wrap a tool (sync or async): compact JSON result, mapped errors,
    one log record per call."""
    if inspect.iscoroutinefunction(fn):
        @functools.wraps(fn)
        async def async_wrapper(*args, **kwargs):
            with _recorded(fn.__name__, kwargs) as call:
                call.result = compact(await fn(*args, **kwargs))
            return call.result

        return async_wrapper

    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        with _recorded(fn.__name__, kwargs) as call:
            call.result = compact(fn(*args, **kwargs))
        return call.result

    return wrapper


def clamp(value: int, low: int, high: int) -> int:
    return max(low, min(value, high))


def round_sig(value, digits: int = 4):
    """Round a statistic for display; None and non-finite pass through."""
    if value is None or not isinstance(value, (int, float)) \
            or not math.isfinite(value) or value == 0:
        return value
    return round(value, digits - 1 - int(math.floor(math.log10(abs(value)))))

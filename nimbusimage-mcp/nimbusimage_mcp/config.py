"""Server settings, read once from the environment.

The server holds no NimbusImage credential of its own: every request
brings the caller's API key (see auth.py). That is why there is no
NI_API_KEY here, and why the server refuses to start with one set (the
nimbusimage package would otherwise fall back to it silently).
"""

from __future__ import annotations

import math
import os
import re
from dataclasses import dataclass, field
from urllib.parse import urlsplit

# Printable ASCII without spaces, 32 or more: safe as a header value.
SECRET_RE = re.compile(r"[!-~]{32,}")


def _http_url(name: str, value: str, bare_origin: bool = False) -> str:
    """The rules the Girder plugin applies to the same values
    (mcp_oauth.issuer and mcp_oauth.resources): an http(s) URL with a
    host and no fragment, and for the issuer no credentials, path or
    query. Stricter than the plugin in one way: no credentials in the
    public URL either. Parsed as given, as the plugin does, then returned
    without a trailing slash, as the plugin stores it."""
    try:
        parts = urlsplit(value)
        parts.port  # raises ValueError for a bad port
    except ValueError:
        parts = None
    if (parts is None or parts.scheme not in ("http", "https")
            or not parts.hostname or parts.fragment
            or parts.username or parts.password
            or (bare_origin and (parts.path.rstrip("/") or parts.query))):
        shape = "a bare origin (no path)" if bare_origin else "an http(s) URL"
        # The value is not echoed: it may hold credentials.
        raise ValueError(f"{name} must be {shape}.")
    return value.rstrip("/")


@dataclass(frozen=True)
class Settings:
    # Girder REST root the server calls, e.g. http://girder:8080/api/v1 in
    # compose. Not necessarily what clients can reach.
    api_url: str
    # This server's public MCP URL: the OAuth resource identifier and the
    # base of /.well-known/oauth-protected-resource.
    public_url: str
    # Advertised as the authorization server in the protected resource
    # metadata: the nimbus_mcp_oauth plugin's issuer (its mcp_oauth.issuer
    # setting), the site's bare origin.
    issuer_url: str
    host: str = "127.0.0.1"
    port: int = 8000
    # Optional JSON-lines call log (tool, user, seconds, bytes, error).
    call_log: str | None = None
    # ni_job_wait's longest wait. Must stay below every HTTP timeout
    # between the client and this server (client, HAProxy).
    max_job_wait: float = 240.0
    # Shared with the nimbus_mcp_oauth plugin (its
    # mcp_oauth.introspection_secret). Unset: OAuth tokens are refused and
    # only API keys work. Not a user credential; kept out of repr.
    introspection_secret: str | None = field(default=None, repr=False)

    @classmethod
    def from_env(cls, environ=os.environ) -> "Settings":
        if environ.get("NI_API_KEY") or environ.get("NI_TOKEN"):
            raise ValueError(
                "NI_API_KEY / NI_TOKEN must not be set for the MCP server: "
                "it acts only as each caller, with their own key."
            )
        port = int(environ.get("NI_MCP_PORT", "8000"))
        max_job_wait = float(environ.get("NI_MCP_MAX_JOB_WAIT", "240"))
        if not math.isfinite(max_job_wait) or max_job_wait < 1:
            raise ValueError("NI_MCP_MAX_JOB_WAIT must be at least 1 second.")
        host = environ.get("NI_MCP_HOST", "127.0.0.1")
        secret = environ.get("NI_MCP_INTROSPECTION_SECRET") or None
        # Sent as a header: printable ASCII, no spaces (the Girder plugin's
        # mcp_oauth.introspection_secret has the same rule).
        if secret is not None and not SECRET_RE.fullmatch(secret):
            raise ValueError(
                "NI_MCP_INTROSPECTION_SECRET must be at least 32 printable "
                "ASCII characters, without spaces."
            )
        return cls(
            api_url=environ.get(
                "NI_API_URL", "http://localhost:8080/api/v1"
            ),
            # No trailing slash: the protected-resource metadata path and
            # the proxy's exact-path rules follow this URL.
            public_url=_http_url("NI_MCP_PUBLIC_URL", environ.get(
                "NI_MCP_PUBLIC_URL", f"http://localhost:{port}/mcp"
            )),
            # Stripped as the Girder plugin strips mcp_oauth.issuer: clients
            # compare the two exactly, and the SDK keeps a trailing slash.
            issuer_url=_http_url("NI_MCP_ISSUER_URL", environ.get(
                "NI_MCP_ISSUER_URL", "http://localhost:8080"
            ), bare_origin=True),
            host=host,
            port=port,
            call_log=environ.get("NI_MCP_CALL_LOG") or None,
            max_job_wait=max_job_wait,
            introspection_secret=secret,
        )

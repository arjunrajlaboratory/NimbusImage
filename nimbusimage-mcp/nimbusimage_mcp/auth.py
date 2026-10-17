"""Bearer credential -> Girder session token, as an MCP TokenVerifier.

Plan: codebaseDocumentation/NIMBUSIMAGE_MCP_SERVER.md §6.1-6.3.

Two credentials are accepted (``NimbusVerifier`` picks by shape):

- A Girder API key (below), for Claude Code and Pro/Max header connectors.
- An OAuth access token (``nio_...``) issued by the Girder plugin
  ``nimbus_mcp_oauth`` (``GirderOAuthVerifier``), for connectors that sign
  users in, such as Team and Enterprise orgs.

A client sends ``Authorization: Bearer <Girder API key>``. The verifier
exchanges the key for a Girder session token (``POST api_key/token``)
and caches it by SHA-256 of the key, so a user mints one Girder token
per key rather than one per call (each exchange creates a token
document and counts toward the authenticated-users metric).

A cached token is still checked against Girder on every request
(``GET token/current``, one small read). That check is what makes a
deleted or deactivated API key stop working at once: Girder removes the
key's tokens, the check fails, the re-exchange is refused, and the
request gets 401.

Neither the key nor the session token is ever logged. The key itself is
not kept: the cache is keyed by its hash, and AccessToken.token holds
that hash.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import re
import time
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime

import httpx
from mcp.server.auth.provider import AccessToken

log = logging.getLogger(__name__)

# Re-exchange this long before the session token expires, so a token
# never lapses in the middle of a tool call. Keys with short token
# lifetimes use half their lifetime instead, so they still cache.
REFRESH_MARGIN_SECONDS = 3600
# Girder behind HAProxy answers these under normal load (NIM-006); the
# per-request session check retries them rather than failing the call.
TRANSIENT_STATUSES = (502, 503, 504)
CHECK_ATTEMPTS = 3
# Bounds memory if many distinct keys are seen; least recently used go.
MAX_CACHED_KEYS = 10_000
# Girder API keys are 40 alphanumeric characters; anything far outside
# that is not worth a round trip to Girder.
MAX_KEY_LENGTH = 256
CLIENT_ID = "girder-api-key"


@dataclass
class _Session:
    girder_token: str
    expires_at: float  # epoch seconds
    lifetime: float  # seconds, as issued
    user_id: str
    login: str

    def refresh_at(self) -> float:
        return self.expires_at - min(
            REFRESH_MARGIN_SECONDS, self.lifetime / 2
        )


async def _with_retries(send) -> httpx.Response:
    """Send a read-only request, retrying Girder's transient answers with
    backoff; no wait after the last attempt."""
    for attempt in range(CHECK_ATTEMPTS):
        response = await send()
        if response.status_code not in TRANSIENT_STATUSES or \
                attempt == CHECK_ATTEMPTS - 1:
            return response
        await asyncio.sleep(0.25 * 2 ** attempt)


def _key_hash(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


def _plausible_key(key: str) -> bool:
    return 0 < len(key) <= MAX_KEY_LENGTH and key.isascii() \
        and key.isalnum()


class GirderApiKeyVerifier:
    """Resolve a Girder API key to the caller's Girder session.

    ``verify_token`` returns None (the SDK answers 401) for a key Girder
    refuses. A Girder outage or 5xx raises instead, so it surfaces as a
    server error rather than as "your key is wrong".
    """

    def __init__(
        self,
        api_url: str,
        resource_url: str,
        http: httpx.AsyncClient | None = None,
    ):
        self._api_url = api_url.rstrip("/")
        self._resource_url = resource_url
        self._http = http or httpx.AsyncClient(timeout=30)
        self._cache: OrderedDict[str, _Session] = OrderedDict()
        # One exchange in flight per key: concurrent first uses of a key
        # share it, and different keys never wait on each other.
        self._inflight: dict[str, asyncio.Future] = {}

    async def verify_token(self, token: str) -> AccessToken | None:
        if not _plausible_key(token):
            return None
        key_hash = _key_hash(token)
        session = self._fresh(key_hash)
        if session is not None:
            if await self._still_valid(session):
                return self._access_token(key_hash, session)
            # Only if no other request replaced it during the check.
            if self._cache.get(key_hash) is session:
                del self._cache[key_hash]
        session = await self._exchange_once(key_hash, token)
        if session is None:
            return None
        return self._access_token(key_hash, session)

    async def _exchange_once(self, key_hash: str, key: str):
        pending = self._inflight.get(key_hash)
        if pending is not None:
            try:
                return await asyncio.shield(pending)
            except asyncio.CancelledError:
                if not pending.cancelled():
                    raise  # this request itself was cancelled
                # The request doing the exchange went away; do our own.
                return await self._exchange_once(key_hash, key)
        future = asyncio.get_running_loop().create_future()
        self._inflight[key_hash] = future
        try:
            session = await self._exchange(key)
            if session is not None:
                self._remember(key_hash, session)
            future.set_result(session)
            return session
        except asyncio.CancelledError:
            # This request went away (client disconnect); waiters retry.
            future.cancel()
            raise
        except BaseException as e:
            future.set_exception(e)
            future.exception()  # retrieved: no "never retrieved" warning
            raise
        finally:
            del self._inflight[key_hash]

    def _fresh(self, key_hash: str) -> _Session | None:
        session = self._cache.get(key_hash)
        if session is None:
            return None
        if session.refresh_at() <= time.time():
            self._cache.pop(key_hash, None)
            return None
        self._cache.move_to_end(key_hash)
        return session

    def _remember(self, key_hash: str, session: _Session) -> None:
        self._cache[key_hash] = session
        self._cache.move_to_end(key_hash)
        while len(self._cache) > MAX_CACHED_KEYS:
            self._cache.popitem(last=False)

    async def _exchange(self, key: str) -> _Session | None:
        response = await self._http.post(
            f"{self._api_url}/api_key/token", data={"key": key}
        )
        if response.status_code in (400, 401, 403):
            # Girder answers 400 "Invalid API key." for unknown, inactive,
            # and deleted keys alike.
            log.info("API key exchange refused (%d)", response.status_code)
            return None
        response.raise_for_status()
        body = response.json()
        auth = body["authToken"]
        user = body.get("user") or {}
        expires_at = datetime.fromisoformat(auth["expires"]).timestamp()
        return _Session(
            girder_token=auth["token"],
            expires_at=expires_at,
            lifetime=max(0.0, expires_at - time.time()),
            user_id=str(user.get("_id", "")),
            login=str(user.get("login", "")),
        )

    async def _still_valid(self, session: _Session) -> bool:
        response = await _with_retries(lambda: self._http.get(
            f"{self._api_url}/token/current",
            headers={"Girder-Token": session.girder_token},
        ))
        if response.status_code == 401:
            return False
        response.raise_for_status()
        # Girder answers 200 with null for a token it does not know.
        return response.json() is not None

    def _access_token(self, key_hash: str, session: _Session) -> AccessToken:
        return AccessToken(
            token=key_hash,
            client_id=CLIENT_ID,
            scopes=[],
            expires_at=int(session.expires_at),
            resource=self._resource_url,
            subject=session.user_id,
            claims={
                "girder_token": session.girder_token,
                "login": session.login,
            },
        )


# --- OAuth access tokens -------------------------------------------------

# nimbus_mcp_oauth's access tokens: "nio_" + 43 base64url characters. The
# underscore never occurs in a Girder key or token, so the shapes cannot
# collide.
OAUTH_PREFIX = "nio_"
OAUTH_TOKEN_RE = re.compile(r"nio_[A-Za-z0-9\-_]{43}")
INTROSPECTION_HEADER = "X-Mcp-Introspection-Secret"


class GirderOAuthVerifier:
    """Resolve an OAuth access token through the plugin's introspection
    endpoint, on every request: there is no cache, so a disconnected
    client, a disabled account or a revoked token fails on its next call.
    Each request costs one Girder call, as the API-key session check does.

    The plugin answers 404 when it is off or the shared secret is wrong;
    both refuse the token (401) and log a warning, since either is a
    deployment mistake rather than a bad token.
    """

    def __init__(
        self,
        api_url: str,
        secret: str,
        http: httpx.AsyncClient | None = None,
    ):
        self._url = f"{api_url.rstrip('/')}/mcp_oauth/introspect"
        self._secret = secret
        self._http = http or httpx.AsyncClient(timeout=30)

    async def verify_token(self, token: str) -> AccessToken | None:
        if not OAUTH_TOKEN_RE.fullmatch(token):
            return None
        response = await _with_retries(lambda: self._http.post(
            self._url, data={"token": token},
            headers={INTROSPECTION_HEADER: self._secret},
        ))
        if response.status_code == 404:
            log.warning(
                "OAuth introspection answered 404: the mcp_oauth plugin is "
                "off, or NI_MCP_INTROSPECTION_SECRET does not match its "
                "mcp_oauth.introspection_secret setting"
            )
            return None
        response.raise_for_status()
        info = response.json()
        if not info.get("active"):
            return None
        return AccessToken(
            token=_key_hash(token),
            client_id=str(info["client_id"]),
            scopes=str(info.get("scope", "")).split(),
            expires_at=int(info["exp"]),
            # The SDK compares this with the server's own URL (audience):
            # a token issued for another MCP server is refused.
            resource=info["resource"],
            subject=str(info["sub"]),
            claims={
                "girder_token": info["girder_token"],
                "login": str(info.get("username", "")),
            },
        )


class NimbusVerifier:
    """Route a bearer credential to the verifier for its kind."""

    def __init__(
        self,
        api_keys: GirderApiKeyVerifier,
        oauth: GirderOAuthVerifier | None = None,
    ):
        self._api_keys = api_keys
        self._oauth = oauth

    async def verify_token(self, token: str) -> AccessToken | None:
        if token.startswith(OAUTH_PREFIX):
            # Without a secret configured, OAuth is off here.
            if self._oauth is None:
                return None
            return await self._oauth.verify_token(token)
        return await self._api_keys.verify_token(token)

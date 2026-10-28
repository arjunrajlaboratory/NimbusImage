"""A stand-in for Girder's auth endpoints, as an httpx transport.

Mirrors what Girder 5 does (checked against the local stack): ``POST
api_key/token`` answers 400 "Invalid API key." for an unknown or deleted
key and ``{authToken: {token, expires, scope}, user}`` otherwise;
``GET token/current`` answers 200 null for a token it does not know.
Deleting a key deletes the tokens minted from it. ``POST
mcp_oauth/introspect`` mirrors the nimbus_mcp_oauth plugin: 404 without
the right secret header, ``{active: false}`` for an unknown token.
"""

from __future__ import annotations

import itertools
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs

import httpx

API = "http://girder.test/api/v1"


class FakeGirder:
    def __init__(self):
        self.keys: dict[str, dict] = {}  # key -> user
        self.tokens: dict[str, dict] = {}  # token -> {key, user}
        self.exchanges = 0
        self.checks = 0
        self.fail_with: int | None = None
        self.lifetime = timedelta(days=180)
        self._ids = itertools.count(1)
        self.introspection_secret = "i" * 40
        self.oauth: dict[str, dict] = {}  # access token -> introspection
        self.introspections = 0

    def add_key(self, key: str, login: str) -> dict:
        user = {"_id": f"user{next(self._ids):04d}", "login": login}
        self.keys[key] = user
        return user

    def delete_key(self, key: str) -> None:
        self.keys.pop(key, None)
        self.tokens = {
            t: v for t, v in self.tokens.items() if v["key"] != key
        }

    def add_oauth(self, token: str, login: str,
                  resource: str = "http://127.0.0.1:8000/mcp") -> dict:
        """An active OAuth access token backed by a Girder session."""
        user = {"_id": f"user{next(self._ids):04d}", "login": login}
        girder_token = f"tok{next(self._ids):06d}"
        self.tokens[girder_token] = {"key": token, "user": user}
        expires = datetime.now(timezone.utc) + timedelta(hours=8)
        self.oauth[token] = {
            "active": True, "sub": user["_id"], "username": login,
            "client_id": "nimbusimage-claude", "scope": "nimbusimage",
            "resource": resource, "exp": int(expires.timestamp()),
            "girder_token": girder_token,
        }
        return user

    def handler(self, request: httpx.Request) -> httpx.Response:
        if self.fail_with:
            return httpx.Response(self.fail_with, json={"message": "boom"})
        path = request.url.path.removeprefix("/api/v1/")
        if request.method == "POST" and path == "api_key/token":
            self.exchanges += 1
            key = parse_qs(request.content.decode()).get("key", [""])[0]
            user = self.keys.get(key)
            if user is None:
                return httpx.Response(
                    400, json={"message": "Invalid API key.",
                               "type": "validation"},
                )
            token = f"tok{next(self._ids):06d}"
            self.tokens[token] = {"key": key, "user": user}
            expires = datetime.now(timezone.utc) + self.lifetime
            return httpx.Response(200, json={
                "authToken": {
                    "token": token, "expires": expires.isoformat(),
                    "scope": ["core.user_auth"],
                },
                "user": user,
            })
        if request.method == "POST" and path == "mcp_oauth/introspect":
            self.introspections += 1
            if request.headers.get("X-Mcp-Introspection-Secret") != \
                    self.introspection_secret:
                return httpx.Response(404, json={"message": "Not found."})
            token = parse_qs(request.content.decode()).get("token", [""])[0]
            return httpx.Response(
                200, json=self.oauth.get(token, {"active": False}))
        if request.method == "GET" and path == "token/current":
            self.checks += 1
            entry = self.tokens.get(request.headers.get("Girder-Token"))
            if entry is None:
                return httpx.Response(200, content=b"null")
            return httpx.Response(200, json={
                "_id": "t", "userId": entry["user"]["_id"],
            })
        return httpx.Response(404, json={"message": "no route"})

    def http(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(self.handler))

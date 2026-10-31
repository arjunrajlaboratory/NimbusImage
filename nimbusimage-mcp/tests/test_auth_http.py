"""Auth over real HTTP: a uvicorn server, a real HTTP client.

The first group runs the server against a fake Girder (no network), so
the 401 paths are proven in CI. The integration group runs against the
local compose stack and proves what the fake only assumes: Girder's own
key semantics, per-user isolation, and that exchanges are cached (the
token collection does not grow per call).
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from unittest.mock import MagicMock

import pytest

import nimbusimage as ni

from nimbusimage_mcp import _common
from nimbusimage_mcp.auth import (
    GirderApiKeyVerifier, GirderOAuthVerifier, NimbusVerifier,
)
from nimbusimage_mcp.server import build_app

from conftest import make_settings, serve
from fake_girder import API, FakeGirder
from helpers import call_tool, rpc

KEY = "k" * 40


@pytest.fixture
def girder():
    fake = FakeGirder()
    fake.add_key(KEY, "alice")
    return fake


OAUTH = "nio_" + "B" * 43


@pytest.fixture
def server(girder):
    settings = make_settings()
    app = build_app(settings, NimbusVerifier(
        GirderApiKeyVerifier(API, settings.public_url, http=girder.http()),
        GirderOAuthVerifier(API, girder.introspection_secret,
                            http=girder.http()),
    ))
    with serve(app) as url:
        yield url


def test_rejects_bad_credentials(server, girder):
    tools_list = ("tools/list", {})
    # Missing, malformed (not a bearer key), invalid, and revoked.
    assert rpc(server, *tools_list).status_code == 401
    assert rpc(server, *tools_list,
               headers={"Authorization": "Basic Zm9vOmJhcg=="}
               ).status_code == 401
    assert rpc(server, *tools_list, key="not a key!").status_code == 401
    assert rpc(server, *tools_list, key="z" * 40).status_code == 401
    assert rpc(server, *tools_list, key=KEY).status_code == 200
    girder.delete_key(KEY)
    response = rpc(server, *tools_list, key=KEY)
    assert response.status_code == 401
    # The challenge points clients at the protected resource metadata.
    assert "resource_metadata=" in response.headers["www-authenticate"]


def test_oauth_tokens_act_as_their_user(server, girder, monkeypatch):
    girder.add_oauth(OAUTH, "carol")
    tokens = []

    def connect(api_url, token):
        tokens.append(token)
        fake = MagicMock()
        fake.list_datasets.return_value = []
        return fake

    monkeypatch.setattr(_common.ni, "connect", connect)
    call_tool(server, OAUTH, "ni_datasets_list", {})
    (token,) = tokens
    assert girder.tokens[token]["user"]["login"] == "carol"


def test_oauth_rejections_are_401(server, girder):
    tools_list = ("tools/list", {})
    # Unknown, then revoked.
    assert rpc(server, *tools_list, key=OAUTH).status_code == 401
    girder.add_oauth(OAUTH, "carol")
    assert rpc(server, *tools_list, key=OAUTH).status_code == 200
    girder.oauth[OAUTH] = {"active": False}
    assert rpc(server, *tools_list, key=OAUTH).status_code == 401


def test_token_for_another_mcp_server_is_refused(server, girder):
    # Audience: the plugin issued it for a different resource.
    girder.add_oauth(OAUTH, "carol", resource="https://other.example/mcp")
    assert rpc(server, "tools/list", {}, key=OAUTH).status_code == 401


@pytest.mark.parametrize("public_url", [
    "http://127.0.0.1:8000/mcp/", "HTTP://127.0.0.1:8000/mcp",
])
def test_equivalent_public_url_spellings_accept_the_token(
        girder, public_url):
    # The plugin stores the canonical resource (no trailing slash, lower
    # case); NI_MCP_PUBLIC_URL may be spelled otherwise, as the README
    # allows. The SDK compares as URLs, a trailing slash aside.
    girder.add_oauth(OAUTH, "carol", resource="http://127.0.0.1:8000/mcp")
    app = build_app(make_settings(public_url=public_url), NimbusVerifier(
        GirderApiKeyVerifier(API, public_url, http=girder.http()),
        GirderOAuthVerifier(API, girder.introspection_secret,
                            http=girder.http()),
    ))
    with serve(app) as url:
        assert rpc(url, "tools/list", {}, key=OAUTH).status_code == 200


def test_metadata_names_the_issuer_without_a_trailing_slash(girder):
    # What clients compare with the plugin's AS metadata (which strips the
    # slash from mcp_oauth.issuer).
    import httpx
    from nimbusimage_mcp.config import Settings
    settings = Settings.from_env({"NI_MCP_ISSUER_URL": "https://h/",
                                  "NI_API_URL": API})
    with serve(build_app(settings, NimbusVerifier(
            GirderApiKeyVerifier(API, settings.public_url,
                                 http=girder.http()), None))) as url:
        base = url.rsplit("/mcp", 1)[0]
        meta = httpx.get(
            base + "/.well-known/oauth-protected-resource/mcp").json()
    assert meta["authorization_servers"] == ["https://h"]


@pytest.mark.parametrize("public_url", [
    "https://h.example:443/mcp", "HTTPS://H.example/mcp",
])
def test_default_port_and_host_case_accept_the_canonical_token(
        girder, public_url):
    # The plugin stores https://h.example/mcp (no default port, lower-case
    # host); the SDK compares as URLs, so these spellings still match.
    girder.add_oauth(OAUTH, "carol", resource="https://h.example/mcp")
    app = build_app(make_settings(public_url=public_url), NimbusVerifier(
        GirderApiKeyVerifier(API, public_url, http=girder.http()),
        GirderOAuthVerifier(API, girder.introspection_secret,
                            http=girder.http()),
    ))
    with serve(app) as url:
        assert rpc(url, "tools/list", {}, key=OAUTH).status_code == 200


def test_expired_oauth_token_is_refused(server, girder):
    girder.add_oauth(OAUTH, "carol")
    girder.oauth[OAUTH]["exp"] = 1
    assert rpc(server, "tools/list", {}, key=OAUTH).status_code == 401


def test_protected_resource_metadata_is_public(server):
    import httpx
    response = httpx.get(
        f"{server}/.well-known/oauth-protected-resource/mcp"
    )
    assert response.status_code == 200
    assert response.json()["resource"] == make_settings().public_url


def test_tools_run_as_the_callers_session(server, girder, monkeypatch):
    calls = []
    fake = MagicMock()
    fake.list_datasets.return_value = [{"_id": "d1", "name": "Mine"}]

    def connect(api_url, token):
        calls.append((api_url, token))
        return fake

    monkeypatch.setattr(_common.ni, "connect", connect)
    result = call_tool(server, KEY, "ni_datasets_list", {})
    assert result["datasets"] == [{"id": "d1", "name": "Mine"}]
    (api_url, token), = calls
    assert api_url == make_settings().api_url
    # The client carries the caller's Girder session, nothing else.
    assert girder.tokens[token]["key"] == KEY


def test_concurrent_callers_each_get_their_own_session(
        server, girder, monkeypatch):
    """Sync tools run in worker threads; under concurrency each must
    still see its own caller's token."""
    other = "o" * 40
    girder.add_key(other, "bob")
    seen = []

    def connect(api_url, token):
        fake = MagicMock()
        fake.list_datasets.return_value = [{"_id": token, "name": "x"}]
        seen.append(token)
        return fake

    monkeypatch.setattr(_common.ni, "connect", connect)
    keys = [KEY, other] * 10
    with ThreadPoolExecutor(max_workers=10) as pool:
        results = list(pool.map(
            lambda key: call_tool(server, key, "ni_datasets_list", {}),
            keys,
        ))
    for key, result in zip(keys, results):
        token = result["datasets"][0]["id"]
        assert girder.tokens[token]["key"] == key
    assert len(set(seen)) == 2


# --- Integration: the local compose stack -------------------------------


@pytest.mark.integration
def test_two_users_see_only_own_datasets(live):
    """Each user sees exactly what Girder lets that user read; the
    server adds nothing of its own."""
    def via_mcp(key):
        return {d["id"] for d in call_tool(
            live.url, key, "ni_datasets_list", {"limit": 100}
        )["datasets"]}

    def via_girder(key):
        return {d["_id"] for d in
                ni.connect(live.api_url, api_key=key).list_datasets()}

    admin, stranger = via_mcp(live.admin_key), via_mcp(live.user_key)
    assert admin == via_girder(live.admin_key)
    assert stranger == via_girder(live.user_key)
    private = admin - stranger
    assert private, "the admin should have datasets the new user cannot see"
    # Nor can the new user open one by id.
    response = rpc(live.url, "tools/call", {
        "name": "ni_dataset_info",
        "arguments": {"dataset_id": sorted(private)[0]},
    }, key=live.user_key)
    result = response.json()["result"]
    assert result["isError"]
    assert "denied" in result["content"][0]["text"].lower()


@pytest.mark.integration
def test_key_exchange_cached(live):
    before = live.token_count(live.user_id)
    for _ in range(5):
        call_tool(live.url, live.user_key, "ni_datasets_list", {})
    # Five calls, at most one exchange (none if the key was used before).
    assert live.token_count(live.user_id) - before <= 1
    for _ in range(5):
        call_tool(live.url, live.user_key, "ni_datasets_list", {})
    assert live.token_count(live.user_id) - before <= 1


@pytest.mark.integration
def test_revoked_key_rejected_live(live):
    """Deleting a key in Girder must end access even though the server
    holds a cached session for it."""
    key, key_id = live.new_api_key()
    assert rpc(live.url, "tools/list", {}, key=key).status_code == 200
    live.delete_api_key(key_id)
    assert rpc(live.url, "tools/list", {}, key=key).status_code == 401


@pytest.mark.integration
def test_deactivated_key_rejected_live(live):
    key, key_id = live.new_api_key()
    assert rpc(live.url, "tools/list", {}, key=key).status_code == 200
    live.user_gc.put(f"api_key/{key_id}", parameters={"active": "false"})
    assert rpc(live.url, "tools/list", {}, key=key).status_code == 401

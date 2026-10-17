"""The API-key verifier against a fake Girder (no network)."""

from __future__ import annotations

import asyncio
import time
from datetime import timedelta

import httpx
import pytest

from nimbusimage_mcp import auth
from nimbusimage_mcp.auth import GirderApiKeyVerifier

from fake_girder import API, FakeGirder

KEY = "a" * 40
RESOURCE = "http://127.0.0.1:8000/mcp"


@pytest.fixture
def girder():
    fake = FakeGirder()
    fake.add_key(KEY, "alice")
    return fake


def verifier(girder: FakeGirder) -> GirderApiKeyVerifier:
    return GirderApiKeyVerifier(API, RESOURCE, http=girder.http())


def run(coro):
    return asyncio.run(coro)


def test_valid_key_resolves_to_the_users_session(girder):
    access = run(verifier(girder).verify_token(KEY))
    assert access.subject == "user0001"
    assert access.claims["login"] == "alice"
    assert access.claims["girder_token"] in girder.tokens
    assert access.resource == RESOURCE
    # The raw key is not kept anywhere on the token.
    assert KEY not in access.model_dump_json()


def test_exchange_is_cached_and_rechecked(girder):
    v = verifier(girder)

    async def three_calls():
        return [await v.verify_token(KEY) for _ in range(3)]

    first, second, third = run(three_calls())
    assert girder.exchanges == 1
    # Every cached use is checked against Girder (revocation).
    assert girder.checks == 2
    assert first.claims["girder_token"] == third.claims["girder_token"]


def test_concurrent_first_use_exchanges_once(girder):
    v = verifier(girder)

    async def burst():
        return await asyncio.gather(*(v.verify_token(KEY) for _ in range(8)))

    results = run(burst())
    assert all(r is not None for r in results)
    assert girder.exchanges == 1


def test_unknown_key_is_refused_and_not_cached(girder):
    v = verifier(girder)

    async def twice():
        return [await v.verify_token("b" * 40) for _ in range(2)]

    assert run(twice()) == [None, None]
    assert girder.exchanges == 2


def test_deleted_key_stops_working_at_once(girder):
    v = verifier(girder)

    async def scenario():
        assert await v.verify_token(KEY) is not None
        girder.delete_key(KEY)
        return await v.verify_token(KEY)

    assert run(scenario()) is None


def test_implausible_tokens_never_reach_girder(girder):
    v = verifier(girder)
    for token in ("", "x" * 300, "has space", "ünïcode", "a.b.c"):
        assert run(v.verify_token(token)) is None
    assert girder.exchanges == 0


def test_token_near_expiry_is_exchanged_again(girder, monkeypatch):
    girder.lifetime = timedelta(seconds=auth.REFRESH_MARGIN_SECONDS + 60)
    v = verifier(girder)

    async def twice():
        first = await v.verify_token(KEY)
        # Jump to a minute before expiry: inside any refresh margin.
        now = time.time() + auth.REFRESH_MARGIN_SECONDS
        monkeypatch.setattr(auth.time, "time", lambda: now)
        return first, await v.verify_token(KEY)

    first, second = run(twice())
    assert girder.exchanges == 2
    assert first.claims["girder_token"] != second.claims["girder_token"]


def test_short_lived_tokens_are_still_cached(girder):
    # A key whose tokens live under an hour would otherwise be inside
    # the refresh margin from the start and mint a token per request.
    girder.lifetime = timedelta(minutes=20)
    v = verifier(girder)

    async def twice():
        return [await v.verify_token(KEY) for _ in range(2)]

    run(twice())
    assert girder.exchanges == 1


def test_transient_check_failures_are_retried(girder, monkeypatch):
    monkeypatch.setattr(auth.asyncio, "sleep", _no_sleep)
    v = verifier(girder)
    run(v.verify_token(KEY))
    original = girder.handler
    failures = iter([503, 502])

    def flaky(request):
        status = next(failures, None)
        if status and request.url.path.endswith("token/current"):
            return httpx.Response(status)
        return original(request)

    v._http = httpx.AsyncClient(transport=httpx.MockTransport(flaky))
    assert run(v.verify_token(KEY)) is not None
    assert girder.exchanges == 1


async def _no_sleep(_seconds):
    return None


def test_concurrent_different_keys_do_not_wait_on_each_other(girder):
    other = "o" * 40
    girder.add_key(other, "bob")
    v = verifier(girder)

    async def both():
        return await asyncio.gather(v.verify_token(KEY),
                                    v.verify_token(other))

    alice, bob = run(both())
    assert alice.subject != bob.subject
    assert girder.exchanges == 2 and not v._inflight


def test_waiters_survive_a_cancelled_exchange(girder):
    """The request doing a key's exchange can be cancelled (client
    disconnect); requests waiting on that exchange must not fail."""
    v = verifier(girder)
    gate = asyncio.Event()
    original = v._exchange

    async def slow_exchange(key):
        await gate.wait()
        return await original(key)

    v._exchange = slow_exchange

    async def scenario():
        first = asyncio.create_task(v.verify_token(KEY))
        await asyncio.sleep(0)
        second = asyncio.create_task(v.verify_token(KEY))
        await asyncio.sleep(0)
        first.cancel()
        await asyncio.sleep(0)
        gate.set()
        return await second

    assert run(scenario()).subject == "user0001"


def test_girder_outage_is_an_error_not_a_bad_key(girder):
    girder.fail_with = 502
    with pytest.raises(httpx.HTTPStatusError):
        run(verifier(girder).verify_token(KEY))


def test_cache_is_bounded(girder, monkeypatch):
    monkeypatch.setattr(auth, "MAX_CACHED_KEYS", 3)
    keys = [chr(ord("c") + i) * 40 for i in range(5)]
    for key in keys:
        girder.add_key(key, key[0])
    v = verifier(girder)

    async def all_keys():
        for key in keys:
            await v.verify_token(key)

    run(all_keys())
    assert len(v._cache) == 3


# --- OAuth access tokens --------------------------------------------------

OAUTH = "nio_" + "A" * 43


def oauth_verifier(girder: FakeGirder, secret=None) -> auth.NimbusVerifier:
    oauth = auth.GirderOAuthVerifier(
        API, secret or girder.introspection_secret, http=girder.http())
    return auth.NimbusVerifier(verifier(girder), oauth)


def test_oauth_token_resolves_through_introspection(girder):
    user = girder.add_oauth(OAUTH, "carol")
    access = run(oauth_verifier(girder).verify_token(OAUTH))
    assert access.subject == user["_id"]
    assert access.claims["login"] == "carol"
    assert girder.tokens[access.claims["girder_token"]]["user"] == user
    assert access.client_id == "nimbusimage-claude"
    assert access.scopes == ["nimbusimage"]
    assert access.resource == RESOURCE
    assert OAUTH not in access.model_dump_json()


def test_oauth_is_checked_on_every_request(girder):
    girder.add_oauth(OAUTH, "carol")
    v = oauth_verifier(girder)

    async def calls():
        first = await v.verify_token(OAUTH)
        girder.oauth[OAUTH] = {"active": False}  # disconnected
        return first, await v.verify_token(OAUTH)

    first, second = run(calls())
    assert first is not None and second is None
    assert girder.introspections == 2
    # Neither path touched the API-key endpoints.
    assert girder.exchanges == 0 and girder.checks == 0


def test_oauth_refused_without_secret_or_with_a_wrong_one(girder, caplog):
    girder.add_oauth(OAUTH, "carol")
    no_oauth = auth.NimbusVerifier(verifier(girder))
    assert run(no_oauth.verify_token(OAUTH)) is None
    assert girder.introspections == 0
    with caplog.at_level("WARNING"):
        assert run(oauth_verifier(girder, secret="w" * 40)
                   .verify_token(OAUTH)) is None
    assert "answered 404" in caplog.text
    assert "w" * 40 not in caplog.text


def test_malformed_oauth_tokens_never_reach_girder(girder):
    v = oauth_verifier(girder)
    for token in ("nio_short", "nio_" + "A" * 44, "nio_" + "!" * 43):
        assert run(v.verify_token(token)) is None
    assert girder.introspections == 0


def test_api_keys_still_work_alongside_oauth(girder):
    access = run(oauth_verifier(girder).verify_token(KEY))
    assert access.claims["login"] == "alice"
    assert girder.introspections == 0


def test_transient_introspection_failures_are_retried(girder, monkeypatch):
    girder.add_oauth(OAUTH, "carol")
    monkeypatch.setattr(auth.asyncio, "sleep", _no_sleep)
    real = girder.handler
    answers = iter([503, 502])

    def flaky(request):
        status = next(answers, None)
        if status:
            girder.introspections += 1
            return httpx.Response(status)
        return real(request)

    girder.handler = flaky
    assert run(oauth_verifier(girder).verify_token(OAUTH)) is not None
    assert girder.introspections == 3


def test_introspection_outage_is_an_error_not_a_bad_token(girder):
    girder.add_oauth(OAUTH, "carol")
    girder.fail_with = 500
    with pytest.raises(httpx.HTTPStatusError):
        run(oauth_verifier(girder).verify_token(OAUTH))

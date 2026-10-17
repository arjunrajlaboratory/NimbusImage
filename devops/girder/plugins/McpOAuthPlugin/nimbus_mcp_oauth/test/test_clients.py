"""Client ID Metadata Documents: which URLs are fetched, and how."""
import json

import pytest
import requests

from nimbus_mcp_oauth import clients
from nimbus_mcp_oauth.errors import OAuthError

from .conftest import pkcePair, startFlow

pytestmark = pytest.mark.plugin('nimbus_mcp_oauth')

CLIENT_URL = 'https://claude.ai/oauth/claude-code-client-metadata'
DOCUMENT = {
    'client_id': CLIENT_URL,
    'client_name': 'Claude Code',
    'redirect_uris': ['http://localhost/callback',
                      'http://127.0.0.1/callback'],
    'token_endpoint_auth_method': 'none',
}


class FakeResponse:
    def __init__(self, status=200, body=None, chunks=None):
        self.status_code = status
        self._chunks = chunks if chunks is not None else [
            json.dumps(body if body is not None else DOCUMENT).encode()]

    def iter_content(self, size):
        return iter(self._chunks)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@pytest.fixture
def fetches(monkeypatch):
    calls = []
    responses = []

    def fakeGet(url, **kwargs):
        calls.append((url, kwargs))
        if responses:
            result = responses.pop(0)
            if isinstance(result, Exception):
                raise result
            return result
        return FakeResponse()

    monkeypatch.setattr(clients.requests, 'get', fakeGet)
    return calls, responses


def testDocumentClientCanSignIn(enabled, fetches):
    calls, _ = fetches
    startFlow(enabled, client_id=CLIENT_URL,
              redirect_uri='http://localhost:4321/callback')
    url, kwargs = calls[0]
    assert url == CLIENT_URL
    assert kwargs['allow_redirects'] is False
    assert kwargs['timeout'] <= 5
    # Cached: a second sign-in does not fetch again.
    startFlow(enabled, client_id=CLIENT_URL,
              redirect_uri='http://127.0.0.1:4321/callback')
    assert len(calls) == 1


@pytest.mark.parametrize('clientId', [
    'https://evil.example/client',          # host not allowed
    'http://claude.ai/oauth/client',        # not https
    'https://claude.ai:8443/oauth/client',  # odd port
    'https://claude.ai/',                   # no path
    'https://user@claude.ai/oauth/client',  # credentials
    'https://claude.ai.evil.example/x',     # look-alike host
])
def testDisallowedDocumentUrlsAreNeverFetched(enabled, fetches, clientId):
    calls, _ = fetches
    with pytest.raises(OAuthError) as err:
        clients.resolve(clientId)
    assert err.value.error == 'invalid_client'
    assert calls == []


@pytest.mark.parametrize('response', [
    FakeResponse(status=302),
    FakeResponse(status=404),
    FakeResponse(chunks=[b'x' * (clients.CIMD_MAX_BYTES + 1)]),
    FakeResponse(chunks=[b'not json']),
    FakeResponse(body=dict(DOCUMENT, client_id='https://claude.ai/other')),
    FakeResponse(body=dict(DOCUMENT, redirect_uris=[])),
    FakeResponse(body=dict(DOCUMENT, redirect_uris=['javascript:x'])),
    # A document may only send codes to Claude's callbacks or loopback.
    FakeResponse(body=dict(DOCUMENT, redirect_uris=[
        'https://attacker.example/cb'])),
    FakeResponse(body=dict(DOCUMENT, redirect_uris=[
        'http://localhost/callback', 'https://claude.ai.evil.example/cb'])),
    FakeResponse(body=dict(DOCUMENT, redirect_uris=[
        'https://localhost/callback'])),
    FakeResponse(body=dict(DOCUMENT,
                           token_endpoint_auth_method='client_secret_post')),
    requests.ConnectionError('down'),
])
def testBadDocumentsAreRefused(enabled, fetches, response):
    _, responses = fetches
    responses.append(response)
    with pytest.raises(OAuthError) as err:
        clients.resolve(CLIENT_URL)
    assert err.value.error == 'invalid_client'


def testRedirectMustBeInTheDocument(enabled, fetches):
    _, challenge = pkcePair()
    from .conftest import authorizeParams
    resp = enabled.request('/mcp_oauth/authorize', params=authorizeParams(
        challenge, client_id=CLIENT_URL,
        redirect_uri='https://claude.ai/api/mcp/auth_callback'))
    assert resp.output_status.startswith(b'400')


def testBuiltinClientNeedsNoFetch(enabled, fetches):
    calls, _ = fetches
    startFlow(enabled)
    assert calls == []


def testDocumentMayNameClaudeCallbacks(enabled, fetches):
    _, responses = fetches
    responses.append(FakeResponse(body=dict(DOCUMENT, redirect_uris=[
        'https://claude.ai/api/mcp/auth_callback'])))
    client = clients.resolve(CLIENT_URL)
    assert clients.redirectAllowed(
        client, 'https://claude.ai/api/mcp/auth_callback')


@pytest.mark.parametrize('envValue', ['claude.ai', '"claude.ai"', '42'])
def testEnvironmentCimdHostsNeverMatchASubstring(server, monkeypatch,
                                                 envValue):
    # An environment override skips the validator, and a bare string would
    # make "e.ai" or "ai" match by substring; it trusts no host instead.
    from girder.models.setting import Setting
    from nimbus_mcp_oauth import settings
    monkeypatch.setenv('GIRDER_SETTING_MCP_OAUTH_CIMD_HOSTS', envValue)
    Setting()._get.invalidate(Setting(), settings.CIMD_HOSTS)
    try:
        assert not clients._isAllowedDocumentUrl('https://e.ai/client.json')
        assert not clients._isAllowedDocumentUrl('https://ai/client.json')
    finally:
        monkeypatch.undo()
        Setting()._get.invalidate(Setting(), settings.CIMD_HOSTS)
    assert clients._isAllowedDocumentUrl(
        'https://claude.ai/oauth/mcp-oauth-client-metadata')

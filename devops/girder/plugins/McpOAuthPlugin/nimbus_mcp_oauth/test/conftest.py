import base64
import hashlib
import secrets
from urllib.parse import parse_qs, urlsplit

import pytest
# tox installs the annotation plugin editable (-e ../AnnotationPlugin), so its
# test helpers are importable here.
from upenncontrast_annotation.test.model_state import dropStaleModelState

from girder.models.setting import Setting

from nimbus_mcp_oauth import rest, settings

ISSUER = 'https://nimbus.example'
RESOURCE = 'https://nimbus.example/mcp'
SECRET = 's' * 40
CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback'


@pytest.fixture(autouse=True)
def _resetStaleModelState():
    # See codebaseDocumentation/BACKEND_CI_PERFORMANCE.md.
    dropStaleModelState()
    yield


@pytest.fixture(autouse=True)
def _freshRateLimits(monkeypatch):
    # The limiters are module-level; give every test its own.
    for name in ('_authorizeLimit', '_tokenLimit', '_consentLimit'):
        limiter = getattr(rest, name)
        monkeypatch.setattr(rest, name, type(limiter)(
            limiter.max_requests, limiter.window_seconds))


@pytest.fixture
def enabled(server):
    Setting().set(settings.ISSUER, ISSUER)
    Setting().set(settings.API_URL, ISSUER + '/girder/api/v1')
    Setting().set(settings.FRONTEND_URL, ISSUER)
    Setting().set(settings.RESOURCES, [RESOURCE])
    Setting().set(settings.INTROSPECTION_SECRET, SECRET)
    # Last: enabling requires the issuer, resources and secret
    Setting().set(settings.ENABLED, True)
    return server


def pkcePair():
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
    return verifier, challenge


def authorizeParams(challenge, **overrides):
    params = {
        'client_id': 'nimbusimage-claude',
        'redirect_uri': CLAUDE_CALLBACK,
        'response_type': 'code',
        'code_challenge': challenge,
        'code_challenge_method': 'S256',
        'resource': RESOURCE,
        'state': 'xyz',
        'scope': 'nimbusimage offline_access',
    }
    params.update(overrides)
    return {k: v for k, v in params.items() if v is not None}


def location(resp):
    return dict(resp.headers)['Location']


def query(url):
    return {k: v[0] for k, v in parse_qs(urlsplit(url).query).items()}


def startFlow(server, **overrides):
    """authorize -> request id; returns (verifier, requestId, params)."""
    verifier, challenge = pkcePair()
    params = authorizeParams(challenge, **overrides)
    resp = server.request('/mcp_oauth/authorize', params=params,
                          isJson=False)
    assert resp.output_status.startswith(b'302'), resp.output_status
    consent = location(resp)
    assert consent.startswith(ISSUER + '/#/oauth/consent?request=')
    return verifier, consent.split('request=')[1], params


def approveFlow(server, user, **overrides):
    """authorize + approve; returns (verifier, code, params)."""
    verifier, requestId, params = startFlow(server, **overrides)
    resp = server.request(f'/mcp_oauth/request/{requestId}/approve',
                          method='POST', user=user)
    assert resp.output_status.startswith(b'200'), resp.json
    return verifier, query(resp.json['redirect'])['code'], params


def exchange(server, code, verifier, params, **overrides):
    form = {
        'grant_type': 'authorization_code',
        'code': code,
        'code_verifier': verifier,
        'client_id': params['client_id'],
        'redirect_uri': params['redirect_uri'],
        'resource': params['resource'],
    }
    form.update(overrides)
    form = {k: v for k, v in form.items() if v is not None}
    return server.request('/mcp_oauth/token', method='POST', params=form)


def connect(server, user, **overrides):
    """A full sign-in; returns the token response."""
    verifier, code, params = approveFlow(server, user, **overrides)
    resp = exchange(server, code, verifier, params)
    assert resp.output_status.startswith(b'200'), resp.json
    return resp.json


def introspect(server, token, secret=SECRET):
    headers = [('X-Mcp-Introspection-Secret', secret)] if secret else []
    return server.request('/mcp_oauth/introspect', method='POST',
                          params={'token': token},
                          additionalHeaders=headers)


def refresh(server, refreshToken, clientId='nimbusimage-claude'):
    return server.request('/mcp_oauth/token', method='POST', params={
        'grant_type': 'refresh_token', 'refresh_token': refreshToken,
        'client_id': clientId})

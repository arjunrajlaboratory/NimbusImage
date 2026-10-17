import datetime

import pytest
from girder.models.setting import Setting
from girder.models.token import Token
from girder.models.user import User

from nimbus_mcp_oauth import oauth, settings
from nimbus_mcp_oauth.models import AuthorizationCode, AuthorizationRequest

from .conftest import (
    CLAUDE_CALLBACK, ISSUER, RESOURCE, approveFlow, authorizeParams,
    connect, exchange, introspect, location, pkcePair, query, refresh,
    startFlow)

pytestmark = pytest.mark.plugin('nimbus_mcp_oauth')


def _status(resp):
    return int(resp.output_status.split()[0])


# --- off by default --------------------------------------------------------

def testEverythingIs404WhileDisabled(server, user):
    assert Setting().get(settings.ENABLED) is False
    _, challenge = pkcePair()
    calls = [
        ('GET', '/mcp_oauth/authorize', authorizeParams(challenge), None),
        ('GET', '/mcp_oauth/request/abc', None, user),
        ('POST', '/mcp_oauth/request/abc/approve', None, user),
        ('POST', '/mcp_oauth/request/abc/deny', None, user),
        ('DELETE', '/mcp_oauth/grant/abc', None, user),
        ('POST', '/mcp_oauth/token', {'grant_type': 'refresh_token'}, None),
        ('POST', '/mcp_oauth/revoke', {'token': 'x'}, None),
        ('POST', '/mcp_oauth/introspect', {'token': 'x'}, None),
        ('GET', '/mcp_oauth/grant', None, user),
    ]
    for method, path, params, who in calls:
        resp = server.request(path, method=method, params=params, user=who)
        assert _status(resp) == 404, path
    resp = server.request('/oauth-authorization-server', prefix='/.well-known',
                          appPrefix='/.well-known', isJson=False)
    assert _status(resp) == 404


def testMetadataAtServerRoot(enabled):
    resp = enabled.request(
        '/oauth-authorization-server', prefix='/.well-known',
        appPrefix='/.well-known')
    assert _status(resp) == 200
    meta = resp.json
    assert meta['issuer'] == ISSUER
    assert meta['authorization_endpoint'] == \
        ISSUER + '/girder/api/v1/mcp_oauth/authorize'
    assert meta['token_endpoint'] == ISSUER + '/girder/api/v1/mcp_oauth/token'
    assert meta['code_challenge_methods_supported'] == ['S256']
    assert meta['token_endpoint_auth_methods_supported'] == ['none']
    assert meta['client_id_metadata_document_supported'] is True
    assert meta['authorization_response_iss_parameter_supported'] is True
    assert 'registration_endpoint' not in meta  # no dynamic registration


# --- authorize -------------------------------------------------------------

def testUnknownClientOrRedirectIsNeverRedirected(enabled):
    _, challenge = pkcePair()
    for overrides in (
            {'client_id': 'someone-else'},
            {'client_id': 'https://evil.example/client'},
            {'redirect_uri': 'https://evil.example/cb'},
            {'redirect_uri': CLAUDE_CALLBACK + '/extra'},
            {'redirect_uri': None}):
        resp = enabled.request('/mcp_oauth/authorize',
                               params=authorizeParams(challenge, **overrides))
        assert _status(resp) == 400, overrides
        assert 'Location' not in dict(resp.headers)


@pytest.mark.parametrize('overrides,error', [
    ({'code_challenge_method': 'plain'}, 'invalid_request'),
    ({'code_challenge_method': None}, 'invalid_request'),
    ({'code_challenge': None}, 'invalid_request'),
    ({'code_challenge': 'short'}, 'invalid_request'),
    ({'response_type': 'token'}, 'unsupported_response_type'),
    ({'resource': None}, 'invalid_target'),
    ({'resource': 'https://other.example/mcp'}, 'invalid_target'),
    ({'scope': 'nimbusimage admin'}, 'invalid_scope'),
])
def testBadRequestsRedirectBackWithError(enabled, overrides, error):
    _, challenge = pkcePair()
    resp = enabled.request(
        '/mcp_oauth/authorize', params=authorizeParams(challenge, **overrides),
        isJson=False)
    assert _status(resp) == 302
    target = location(resp)
    assert target.startswith(CLAUDE_CALLBACK + '?')
    params = query(target)
    assert params['error'] == error
    assert params['state'] == 'xyz'
    assert params['iss'] == ISSUER


def testResourceIsComparedInCanonicalForm(enabled):
    startFlow(enabled, resource='HTTPS://Nimbus.Example:443/mcp/')


def testLoopbackPortWildcardIsTheOnlyLeeway(enabled):
    _, challenge = pkcePair()
    for uri in ('http://user@localhost:3118/callback',
                'http://localhost:3118/callback?x=1',
                'http://localhost:3118/callback#frag',
                'http://localhost.:3118/callback',
                'http://LOCALHOST:3118/Callback'):
        resp = enabled.request('/mcp_oauth/authorize',
                               params=authorizeParams(challenge,
                                                      redirect_uri=uri))
        assert _status(resp) == 400, uri


def testLoopbackRedirectMatchesAnyPort(enabled):
    for uri in ('http://localhost:3118/callback',
                'http://127.0.0.1:50000/callback'):
        startFlow(enabled, redirect_uri=uri)
    _, challenge = pkcePair()
    for uri in ('http://localhost:3118/other',
                'https://localhost:3118/callback',
                'http://evil.example:3118/callback'):
        resp = enabled.request('/mcp_oauth/authorize',
                               params=authorizeParams(challenge,
                                                      redirect_uri=uri))
        assert _status(resp) == 400, uri


# --- consent ---------------------------------------------------------------

def testConsentNeedsLoginAndShowsClient(enabled, user):
    _, requestId, _ = startFlow(enabled)
    resp = enabled.request(f'/mcp_oauth/request/{requestId}')
    assert _status(resp) == 401
    resp = enabled.request(f'/mcp_oauth/request/{requestId}', user=user)
    assert resp.json['clientName'] == 'Claude'
    assert resp.json['redirectHost'] == 'claude.ai'
    assert resp.json['localRedirect'] is False
    resp = enabled.request(f'/mcp_oauth/request/{requestId}/approve',
                           method='POST')
    assert _status(resp) == 401


def testApproveReturnsCodeStateAndIss(enabled, user):
    _, requestId, _ = startFlow(enabled)
    resp = enabled.request(f'/mcp_oauth/request/{requestId}/approve',
                           method='POST', user=user)
    target = resp.json['redirect']
    assert target.startswith(CLAUDE_CALLBACK + '?')
    params = query(target)
    assert params['state'] == 'xyz' and params['iss'] == ISSUER
    assert len(params['code']) >= 40
    # Stored hashed only
    assert AuthorizationCode().findOne({'_id': params['code']}) is None


def testRequestCanBeApprovedOnlyOnce(enabled, user):
    _, requestId, _ = startFlow(enabled)
    path = f'/mcp_oauth/request/{requestId}/approve'
    assert _status(enabled.request(path, method='POST', user=user)) == 200
    assert _status(enabled.request(path, method='POST', user=user)) == 404
    deny = f'/mcp_oauth/request/{requestId}/deny'
    assert _status(enabled.request(deny, method='POST', user=user)) == 404


def testExpiredRequestIsRefused(enabled, user):
    _, requestId, _ = startFlow(enabled)
    AuthorizationRequest().update({'_id': requestId}, {'$set': {
        'expiresAt': oauth.now() - datetime.timedelta(seconds=1)}})
    resp = enabled.request(f'/mcp_oauth/request/{requestId}/approve',
                           method='POST', user=user)
    assert _status(resp) == 404


def testRequestExpiringDuringApprovalIssuesNoCode(
        enabled, user, monkeypatch):
    # The read said live; by the claim it had expired. The claim itself
    # must refuse it.
    _, requestId, _ = startFlow(enabled)
    AuthorizationRequest().update({'_id': requestId}, {'$set': {
        'expiresAt': oauth.now() - datetime.timedelta(seconds=1)}})
    monkeypatch.setattr(oauth, 'expired', lambda doc: False)
    resp = enabled.request(f'/mcp_oauth/request/{requestId}/approve',
                           method='POST', user=user)
    assert _status(resp) == 404
    assert AuthorizationCode().find({}).count() == 0


def testDenyRedirectsWithAccessDenied(enabled, user):
    _, requestId, _ = startFlow(enabled)
    resp = enabled.request(f'/mcp_oauth/request/{requestId}/deny',
                           method='POST', user=user)
    params = query(resp.json['redirect'])
    assert params['error'] == 'access_denied' and params['state'] == 'xyz'


# --- token: authorization code --------------------------------------------

def testCodeExchangeIssuesTokens(enabled, user):
    tokens = connect(enabled, user)
    assert tokens['token_type'] == 'Bearer'
    assert tokens['access_token'].startswith('nio_')
    assert tokens['refresh_token'].startswith('nir_')
    assert tokens['expires_in'] == 8 * 3600
    assert tokens['scope'] == 'nimbusimage'


def testTokenResponsesAreNotCached(enabled, user):
    verifier, code, params = approveFlow(enabled, user)
    resp = exchange(enabled, code, verifier, params)
    assert dict(resp.headers)['Cache-Control'] == 'no-store'


@pytest.mark.parametrize('overrides', [
    {'code_verifier': 'x' * 50},
    {'code_verifier': None},
    {'redirect_uri': 'http://localhost:9999/callback'},
    {'client_id': 'https://claude.ai/other'},
    {'code': 'not-a-code'},
])
def testCodeExchangeChecks(enabled, user, overrides):
    verifier, code, params = approveFlow(enabled, user)
    code = overrides.pop('code', code)
    resp = exchange(enabled, code, verifier, params, **overrides)
    assert _status(resp) == 400
    assert resp.json['error'] == 'invalid_grant'


def testResourceMismatchAtTokenIsInvalidTarget(enabled, user):
    verifier, code, params = approveFlow(enabled, user)
    resp = exchange(enabled, code, verifier, params,
                    resource='https://other.example/mcp')
    assert resp.json['error'] == 'invalid_target'


def testCodeWithWrongResourceIsNotSpent(enabled, user):
    verifier, code, params = approveFlow(enabled, user)
    resp = exchange(enabled, code, verifier, params,
                    resource='https://other.example/mcp')
    assert resp.json['error'] == 'invalid_target'
    # A corrected retry still works.
    resp = exchange(enabled, code, verifier, params)
    assert resp.json['access_token'].startswith('nio_')


def testCodeWithoutClientIdIsNotSpent(enabled, user):
    verifier, code, params = approveFlow(enabled, user)
    resp = exchange(enabled, code, verifier, params, client_id=None)
    assert resp.json['error'] == 'invalid_request'
    resp = exchange(enabled, code, verifier, params)
    assert resp.json['access_token'].startswith('nio_')


@pytest.mark.parametrize('redirect', [None, 'http://localhost:9/callback'])
def testCodeWithWrongRedirectIsNotSpent(enabled, user, redirect):
    verifier, code, params = approveFlow(enabled, user)
    resp = exchange(enabled, code, verifier, params, redirect_uri=redirect)
    assert resp.json['error'] == 'invalid_grant'
    # A corrected retry still works.
    resp = exchange(enabled, code, verifier, params)
    assert resp.json['access_token'].startswith('nio_')


def testWrongVerifierStillSpendsTheCode(enabled, user):
    # PKCE is the proof of possession, so a failure is not a typo to
    # forgive: the code is gone.
    verifier, code, params = approveFlow(enabled, user)
    assert exchange(enabled, code, verifier, params,
                    code_verifier='x' * 50).json['error'] == 'invalid_grant'
    assert exchange(enabled, code, verifier, params).json[
        'error'] == 'invalid_grant'


def testWrongClientWithWrongResourceStillSpendsTheCode(enabled, user):
    # The peek is only for the right client; anyone else is a bad grant.
    verifier, code, params = approveFlow(enabled, user)
    resp = exchange(enabled, code, verifier, params,
                    client_id='https://claude.ai/other',
                    resource='https://other.example/mcp')
    assert resp.json['error'] == 'invalid_grant'
    assert exchange(enabled, code, verifier, params).json[
        'error'] == 'invalid_grant'


def testCodeRemovedAfterTheClaimIsInvalidGrant(enabled, user, monkeypatch):
    # The TTL monitor can delete an expired code between the claim and the
    # read that follows it.
    from nimbus_mcp_oauth.models import AuthorizationCode
    verifier, code, params = approveFlow(enabled, user)
    update = AuthorizationCode.update

    def updateThenDelete(self, query, *args, **kwargs):
        result = update(self, query, *args, **kwargs)
        AuthorizationCode().removeWithQuery({'_id': query['_id']})
        return result

    monkeypatch.setattr(AuthorizationCode, 'update', updateThenDelete)
    resp = exchange(enabled, code, verifier, params, resource=None)
    assert _status(resp) == 400
    assert resp.json['error'] == 'invalid_grant'


def testCodeWorksOnceAndReplayRevokesItsTokens(enabled, user):
    verifier, code, params = approveFlow(enabled, user)
    first = exchange(enabled, code, verifier, params).json
    assert introspect(enabled, first['access_token']).json['active']
    replay = exchange(enabled, code, verifier, params)
    assert replay.json['error'] == 'invalid_grant'
    assert introspect(enabled, first['access_token']).json == {
        'active': False}
    assert refresh(enabled, first['refresh_token']).json['error'] == \
        'invalid_grant'


def testExpiredCodeIsRefused(enabled, user):
    verifier, code, params = approveFlow(enabled, user)
    AuthorizationCode().update({}, {'$set': {
        'expiresAt': oauth.now() - datetime.timedelta(seconds=1)}})
    assert exchange(enabled, code, verifier, params).json['error'] == \
        'invalid_grant'


def testUnsupportedGrantType(enabled):
    resp = enabled.request('/mcp_oauth/token', method='POST',
                           params={'grant_type': 'client_credentials'})
    assert resp.json['error'] == 'unsupported_grant_type'


# --- token: refresh --------------------------------------------------------

def testRefreshRotates(enabled, user):
    first = connect(enabled, user)
    second = refresh(enabled, first['refresh_token']).json
    assert second['refresh_token'] != first['refresh_token']
    assert second['access_token'] != first['access_token']
    assert introspect(enabled, second['access_token']).json['active']
    third = refresh(enabled, second['refresh_token']).json
    assert third['access_token'].startswith('nio_')


def testRefreshReuseRevokesTheConnection(enabled, user):
    first = connect(enabled, user)
    second = refresh(enabled, first['refresh_token']).json
    reuse = refresh(enabled, first['refresh_token'])
    assert reuse.json['error'] == 'invalid_grant'
    # Everything issued on that connection is dead, including the newest.
    assert introspect(enabled, second['access_token']).json == {
        'active': False}
    assert refresh(enabled, second['refresh_token']).json['error'] == \
        'invalid_grant'


def testRefreshFromAnotherClientRevokes(enabled, user):
    first = connect(enabled, user)
    resp = refresh(enabled, first['refresh_token'],
                   clientId='https://claude.ai/other')
    assert resp.json['error'] == 'invalid_grant'
    assert introspect(enabled, first['access_token']).json == {
        'active': False}


def testAnotherClientCannotProbeWithAWrongResource(enabled, user):
    # A wrong resource must not let another client test a refresh token
    # without tripping the revocation.
    first = connect(enabled, user)
    resp = enabled.request('/mcp_oauth/token', method='POST', params={
        'grant_type': 'refresh_token', 'refresh_token': first['refresh_token'],
        'client_id': 'https://claude.ai/other',
        'resource': 'https://other.example/mcp'})
    assert resp.json['error'] == 'invalid_grant'
    assert introspect(enabled, first['access_token']).json == {
        'active': False}


def testRefreshWithoutClientIdKeepsTheConnection(enabled, user):
    first = connect(enabled, user)
    resp = enabled.request('/mcp_oauth/token', method='POST', params={
        'grant_type': 'refresh_token',
        'refresh_token': first['refresh_token']})
    assert resp.json['error'] == 'invalid_request'
    assert introspect(enabled, first['access_token']).json['active']
    # The refresh token was not spent: a corrected retry works.
    retry = refresh(enabled, first['refresh_token'])
    assert retry.json['access_token'].startswith('nio_')


def testRefreshWithWrongResourceKeepsTheToken(enabled, user):
    first = connect(enabled, user)
    resp = enabled.request('/mcp_oauth/token', method='POST', params={
        'grant_type': 'refresh_token', 'client_id': 'nimbusimage-claude',
        'refresh_token': first['refresh_token'],
        'resource': 'https://other.example/mcp'})
    assert resp.json['error'] == 'invalid_target'
    # Canonical form matches, and the token was not spent.
    resp = enabled.request('/mcp_oauth/token', method='POST', params={
        'grant_type': 'refresh_token', 'client_id': 'nimbusimage-claude',
        'refresh_token': first['refresh_token'],
        'resource': 'HTTPS://Nimbus.Example/mcp/'})
    assert resp.json['access_token'].startswith('nio_')


def testUnverifiedEmailCannotUseTokens(enabled, user):
    first = connect(enabled, user)
    Setting().set('core.email_verification', 'required')
    user['emailVerified'] = False
    User().save(user)
    assert introspect(enabled, first['access_token']).json == {
        'active': False}


@pytest.mark.parametrize('block', ['disabled', 'unverified', 'unapproved'])
def testAccountBlockedAfterApprovalCannotExchange(enabled, user, block):
    # Between consent and the token exchange: no grant, no tokens.
    from nimbus_mcp_oauth.models import Grant
    verifier, code, params = approveFlow(enabled, user)
    if block == 'disabled':
        user['status'] = 'disabled'
    elif block == 'unverified':
        Setting().set('core.email_verification', 'required')
        user['emailVerified'] = False
    else:
        Setting().set('core.registration_policy', 'approve')
        user['status'] = 'pending'
    User().save(user)
    resp = exchange(enabled, code, verifier, params)
    assert resp.json['error'] == 'invalid_grant'
    assert Grant().find({'userId': user['_id']}).count() == 0


def testExpiredGrantsAreNotListed(enabled, user):
    from nimbus_mcp_oauth.models import Grant
    connect(enabled, user)
    assert len(enabled.request('/mcp_oauth/grant', user=user).json) == 1
    Grant().update({'userId': user['_id']}, {'$set': {
        'expiresAt': oauth.now() - datetime.timedelta(seconds=1)}})
    assert enabled.request('/mcp_oauth/grant', user=user).json == []


def testOverlongStateIsNotEchoed(enabled):
    _, challenge = pkcePair()
    params = authorizeParams(challenge, state='s' * (oauth.MAX_STATE + 1))
    resp = enabled.request('/mcp_oauth/authorize', params=params,
                           isJson=False)
    back = query(location(resp))
    assert back['error'] == 'invalid_request' and 'state' not in back


def testDisabledUserCannotRefresh(enabled, user):
    first = connect(enabled, user)
    user['status'] = 'disabled'
    User().save(user)
    assert refresh(enabled, first['refresh_token']).json['error'] == \
        'invalid_grant'
    assert introspect(enabled, first['access_token']).json == {
        'active': False}


# --- introspection ---------------------------------------------------------

def testIntrospectionNeedsTheSecret(enabled, user):
    tokens = connect(enabled, user)
    assert _status(introspect(enabled, tokens['access_token'],
                              secret=None)) == 404
    assert _status(introspect(enabled, tokens['access_token'],
                              secret='w' * 40)) == 404


def testIntrospectionReturnsAWorkingGirderSession(enabled, user):
    tokens = connect(enabled, user)
    info = introspect(enabled, tokens['access_token']).json
    assert info['active'] is True
    assert info['sub'] == str(user['_id'])
    assert info['username'] == user['login']
    assert info['resource'] == RESOURCE
    assert info['client_id'] == 'nimbusimage-claude'
    me = enabled.request('/user/me', token=info['girder_token'])
    assert me.json['_id'] == str(user['_id'])
    session = Token().load(info['girder_token'], force=True, objectId=False)
    lifetime = session['expires'] - session['created']
    assert lifetime == datetime.timedelta(hours=8)


def testRefreshTokensAndJunkAreNotIntrospectable(enabled, user):
    tokens = connect(enabled, user)
    for value in (tokens['refresh_token'], 'nio_' + 'a' * 43, 'garbage', ''):
        assert introspect(enabled, value).json == {'active': False}


def testSecretsAreStoredHashed(enabled, user):
    tokens = connect(enabled, user)
    from nimbus_mcp_oauth.models import AccessToken, RefreshToken
    assert AccessToken().findOne({'_id': tokens['access_token']}) is None
    assert RefreshToken().findOne({'_id': tokens['refresh_token']}) is None


# --- revocation and connections ---------------------------------------------

def testRevokeEndsTheConnectionAndItsGirderSessions(enabled, user):
    tokens = connect(enabled, user)
    girderToken = introspect(enabled, tokens['access_token']).json[
        'girder_token']
    resp = enabled.request('/mcp_oauth/revoke', method='POST',
                           params={'token': tokens['refresh_token']})
    assert _status(resp) == 200
    assert introspect(enabled, tokens['access_token']).json == {
        'active': False}
    assert Token().load(girderToken, force=True, objectId=False) is None
    # Unknown tokens are not an error (RFC 7009)
    resp = enabled.request('/mcp_oauth/revoke', method='POST',
                           params={'token': 'nir_' + 'b' * 43})
    assert _status(resp) == 200


def testUsersSeeAndRevokeOnlyTheirOwnConnections(enabled, user, admin):
    mine = connect(enabled, user)
    theirs = connect(enabled, admin)
    listed = enabled.request('/mcp_oauth/grant', user=user).json
    assert [g['clientName'] for g in listed] == ['Claude']
    adminGrant = enabled.request('/mcp_oauth/grant', user=admin).json[0]
    resp = enabled.request(f"/mcp_oauth/grant/{adminGrant['id']}",
                           method='DELETE', user=user)
    assert _status(resp) == 404
    assert introspect(enabled, theirs['access_token']).json['active']
    resp = enabled.request(f"/mcp_oauth/grant/{listed[0]['id']}",
                           method='DELETE', user=user)
    assert _status(resp) == 200
    assert introspect(enabled, mine['access_token']).json == {
        'active': False}
    resp = enabled.request('/mcp_oauth/grant/not-an-id', method='DELETE',
                           user=user)
    assert _status(resp) == 404


def testTokenRateLimitAnswersInOAuthShape(enabled, monkeypatch):
    from nimbus_mcp_oauth import rest
    monkeypatch.setattr(rest, '_tokenLimit',
                        rest.SlidingWindowRateLimiter(1, 60))
    params = {'grant_type': 'refresh_token', 'refresh_token': 'x',
              'client_id': 'nimbusimage-claude'}
    enabled.request('/mcp_oauth/token', method='POST', params=params)
    resp = enabled.request('/mcp_oauth/token', method='POST', params=params)
    assert _status(resp) == 429
    assert resp.json['error'] == 'temporarily_unavailable'
    assert dict(resp.headers)['Retry-After'] == '60'


def testSecretsStayOutOfTheAuditLog(enabled, user, caplog):
    verifier, code, params = approveFlow(enabled, user)
    caplog.clear()
    with caplog.at_level('INFO', logger='girder_audit'):
        tokens = exchange(enabled, code, verifier, params).json
        refresh(enabled, tokens['refresh_token'])
        introspect(enabled, tokens['access_token'])
        enabled.request('/mcp_oauth/revoke', method='POST',
                        params={'token': tokens['refresh_token']})
    logged = repr([(r.getMessage(), getattr(r, 'details', None))
                   for r in caplog.records])
    for secret in (code, verifier, tokens['refresh_token'],
                   tokens['access_token']):
        assert secret not in logged


def testCollectionsExpireOnTheirOwn(enabled):
    from nimbus_mcp_oauth import models
    for model in (models.AuthorizationRequest, models.AuthorizationCode,
                  models.Grant, models.AccessToken, models.RefreshToken,
                  models.ClientDocument):
        indexes = model().collection.index_information()
        assert any(spec['key'] == [('expiresAt', 1)]
                   and spec.get('expireAfterSeconds') == 0
                   for spec in indexes.values()), model.__name__


def testAuthorizeIsRateLimited(enabled, monkeypatch):
    from nimbus_mcp_oauth import rest
    monkeypatch.setattr(rest, '_authorizeLimit',
                        rest.SlidingWindowRateLimiter(2, 60))
    _, challenge = pkcePair()
    statuses = [
        _status(enabled.request('/mcp_oauth/authorize',
                                params=authorizeParams(challenge),
                                isJson=False))
        for _ in range(3)]
    assert statuses == [302, 302, 429]


# --- review round: query credentials, reconnects, settings -----------------

def _postWithQuery(server, path, query, headers=()):
    # pytest-girder puts params in the query string only when a body is
    # also sent.
    return server.request(path, method='POST', params=query, body='x=1',
                          type='application/x-www-form-urlencoded',
                          additionalHeaders=list(headers))


def testCredentialsInTheQueryStringAreRefused(enabled, user):
    tokens = connect(enabled, user)
    resp = _postWithQuery(enabled, '/mcp_oauth/token', {
        'grant_type': 'refresh_token', 'client_id': 'nimbusimage-claude',
        'refresh_token': tokens['refresh_token']})
    assert _status(resp) == 400
    assert resp.json['error'] == 'invalid_request'
    # Not spent: the same token still works from the body.
    assert refresh(enabled, tokens['refresh_token']).json[
        'access_token'].startswith('nio_')
    for path in ('/mcp_oauth/revoke', '/mcp_oauth/introspect'):
        resp = _postWithQuery(
            enabled, path, {'token': tokens['access_token']},
            [('X-Mcp-Introspection-Secret', 's' * 40)])
        assert resp.json['error'] == 'invalid_request', path


def testSecondDeviceDoesNotEndTheFirst(enabled, user):
    # Claude Code on two machines shares one client id; so do claude.ai
    # orgs. A new sign-in must not cut off the other.
    first = connect(enabled, user)
    second = connect(enabled, user)
    assert introspect(enabled, first['access_token']).json['active']
    assert introspect(enabled, second['access_token']).json['active']
    assert refresh(enabled, first['refresh_token']).json[
        'access_token'].startswith('nio_')
    assert len(enabled.request('/mcp_oauth/grant', user=user).json) == 2


def testAnotherClientKeepsItsOwnConnection(enabled, user, monkeypatch):
    from nimbus_mcp_oauth import clients
    other = {'client_id': 'other-test-client', 'client_name': 'Other',
             'redirect_uris': ['https://claude.ai/api/mcp/auth_callback']}
    monkeypatch.setitem(clients.BUILTIN_CLIENTS, 'other-test-client', other)
    builtin = connect(enabled, user)
    connect(enabled, user, client_id='other-test-client')
    assert introspect(enabled, builtin['access_token']).json['active']
    assert len(enabled.request('/mcp_oauth/grant', user=user).json) == 2


def testCannotEnableHalfConfigured(server):
    from girder.exceptions import ValidationException
    with pytest.raises(ValidationException, match='mcp_oauth.issuer'):
        Setting().set(settings.ENABLED, True)
    Setting().set(settings.ISSUER, ISSUER)
    with pytest.raises(ValidationException, match='mcp_oauth.resources'):
        Setting().set(settings.ENABLED, True)
    Setting().set(settings.RESOURCES, [RESOURCE])
    # Without the secret every sign-in would succeed and every MCP call fail
    with pytest.raises(ValidationException,
                       match='mcp_oauth.introspection_secret'):
        Setting().set(settings.ENABLED, True)
    Setting().set(settings.INTROSPECTION_SECRET, 'k' * 40)
    Setting().set(settings.ENABLED, True)
    # Its twin: not cleared while on.
    for key, empty in ((settings.ISSUER, ''), (settings.RESOURCES, []),
                       (settings.INTROSPECTION_SECRET, '')):
        with pytest.raises(ValidationException, match='Disable MCP OAuth'):
            Setting().set(key, empty)
    Setting().set(settings.ENABLED, False)
    Setting().set(settings.RESOURCES, [])


@pytest.mark.parametrize('key,value', [
    (settings.ISSUER, 'https://'),
    (settings.ISSUER, 'https://nimbus.example#frag'),
    (settings.ISSUER, 'https://nimbus.example?x=1'),
    (settings.API_URL, 'https://nimbus.example:notaport/girder/api/v1'),
    (settings.FRONTEND_URL, 'https://user:pw@nimbus.example'),
    (settings.FRONTEND_URL, 'ftp://nimbus.example'),
    (settings.RESOURCES, ['https://']),
    (settings.RESOURCES, ['https://nimbus.example/mcp#frag']),
    (settings.RESOURCES, [RESOURCE, 'nimbus.example/mcp']),
])
def testMalformedUrlSettingsAreRefused(server, key, value):
    # Accepting these would let the plugin be enabled and then refuse
    # every sign-in (invalid_target) or serve unusable metadata.
    from girder.exceptions import ValidationException
    with pytest.raises(ValidationException, match='http'):
        Setting().set(key, value)


@pytest.mark.parametrize('issuer', [
    'https://nimbus.example/oauth', 'https://nimbus.example/girder/'])
def testIssuerMustBeABareOrigin(server, issuer):
    # The metadata is served only at the root's /.well-known path.
    from girder.exceptions import ValidationException
    with pytest.raises(ValidationException, match='bare origin'):
        Setting().set(settings.ISSUER, issuer)
    Setting().set(settings.ISSUER, 'https://nimbus.example/')
    assert Setting().get(settings.ISSUER) == 'https://nimbus.example'


# Unusable values in effect (skipping the validators), at least one per
# setting; testEveryEffectiveSettingIsChecked keeps the table complete when
# a setting is added.
UNVALIDATED_BAD = [
    (settings.ISSUER, 'https://nimbus.example/oauth'),
    (settings.ISSUER, 'https://nimbus.example/'),
    (settings.ISSUER, 'https://'),
    (settings.ISSUER, 42),
    (settings.ISSUER, ''),
    (settings.RESOURCES, ['https://']),
    (settings.RESOURCES, 'https://nimbus.example/mcp'),
    (settings.RESOURCES, [42]),
    (settings.RESOURCES, []),
    (settings.API_URL, 42),
    (settings.API_URL, 'https://nimbus.example/girder/api/v1/'),
    (settings.API_URL, 'nimbus.example/api/v1'),
    (settings.FRONTEND_URL, ['https://nimbus.example']),
    (settings.FRONTEND_URL, 'https://nimbus.example/#/'),
    (settings.INTROSPECTION_SECRET, 12345678901234567890123456789012345),
    (settings.INTROSPECTION_SECRET, 'short'),
    (settings.INTROSPECTION_SECRET, ''),
    (settings.INTROSPECTION_SECRET, '\u00e9' * 40),
    (settings.CIMD_HOSTS, 'claude.ai'),
    (settings.CIMD_HOSTS, ['Claude.ai']),
]


@pytest.mark.parametrize('secret', [
    'short', '\u00e9' * 40, 'a' * 31 + ' ' + 'a', 'a' * 40 + '\n'])
def testSecretMustBeHeaderSafe(server, secret):
    # The MCP service sends it as a header; NI_MCP_INTROSPECTION_SECRET has
    # the same rule (test_settings_introspection_secret).
    from girder.exceptions import ValidationException
    with pytest.raises(ValidationException, match='printable ASCII'):
        Setting().set(settings.INTROSPECTION_SECRET, secret)
    Setting().set(settings.INTROSPECTION_SECRET, '!~' * 16)


def testEveryEffectiveSettingIsChecked():
    assert {key for key, _ in UNVALIDATED_BAD} == set(settings.NORMALIZE)


@pytest.mark.parametrize('key,value', UNVALIDATED_BAD)
def testUnvalidatedBadSettingsActDisabled(
        enabled, key, value, monkeypatch):
    # GIRDER_SETTING_* environment overrides skip the validators, so the
    # values in effect are checked again, and a bad one turns the plugin
    # off instead of serving broken metadata or failing every sign-in.
    import json
    envKey = 'GIRDER_SETTING_' + key.replace('.', '_').upper()
    monkeypatch.setenv(envKey, json.dumps(value))
    Setting()._get.invalidate(Setting(), key)
    try:
        assert settings.get(key) == value
        assert settings.enabled() is False
        resp = enabled.request(
            '/oauth-authorization-server', prefix='/.well-known',
            appPrefix='/.well-known', isJson=False)
        assert _status(resp) == 404
    finally:
        monkeypatch.undo()
        Setting()._get.invalidate(Setting(), key)


def testEquivalentResourceSpellingsAreAccepted(server):
    Setting().set(settings.RESOURCES, ['https://NIMBUS.example:443/mcp/'])
    from nimbus_mcp_oauth import oauth
    assert oauth.allowedResources() == {RESOURCE}


def testHalfConfiguredActsDisabled(enabled):
    # A null PUT (unset) skips the validators; the plugin must not serve
    # broken metadata then.
    Setting().unset(settings.ISSUER)
    resp = enabled.request('/oauth-authorization-server',
                           prefix='/.well-known', appPrefix='/.well-known',
                           isJson=False)
    assert _status(resp) == 404
    _, challenge = pkcePair()
    resp = enabled.request('/mcp_oauth/authorize',
                           params=authorizeParams(challenge))
    assert _status(resp) == 404


def _repeated(params, key):
    """The query string or form body a client sends with key twice."""
    from urllib.parse import urlencode
    pairs = [(k, v) for k, v in params.items()] + [(key, params[key])]
    return urlencode(pairs)


def _refusedAsRepeated(resp):
    # Girder's own _preventRepeatedParams answers before the endpoint runs:
    # a 400, never the endpoint seeing a list (which would be a 500).
    return _status(resp) == 400 and 'multiple times' in resp.json['message']


def testRepeatedTokenFieldsAreRefusedWithoutSpendingTheCode(enabled, user):
    verifier, code, params = approveFlow(enabled, user)
    form = {'grant_type': 'authorization_code', 'code': code,
            'code_verifier': verifier, 'client_id': params['client_id'],
            'redirect_uri': params['redirect_uri'],
            'resource': params['resource']}
    for key in ('code', 'grant_type'):
        assert _refusedAsRepeated(enabled.request(
            '/mcp_oauth/token', method='POST', body=_repeated(form, key),
            type='application/x-www-form-urlencoded'))
    assert exchange(enabled, code, verifier, params).json[
        'access_token'].startswith('nio_')


def testRepeatedRevokeAndIntrospectFieldsAreRefused(enabled, user):
    from .conftest import SECRET
    token = connect(enabled, user)['access_token']
    body = _repeated({'token': token}, 'token')
    assert _refusedAsRepeated(enabled.request(
        '/mcp_oauth/revoke', method='POST', body=body,
        type='application/x-www-form-urlencoded'))
    assert _refusedAsRepeated(enabled.request(
        '/mcp_oauth/introspect', method='POST', body=body,
        type='application/x-www-form-urlencoded',
        additionalHeaders=[('X-Mcp-Introspection-Secret', SECRET)]))
    assert introspect(enabled, token).json['active']


def testRepeatedAuthorizeFieldsNeverRedirect(enabled):
    _, challenge = pkcePair()
    resp = enabled.request(
        '/mcp_oauth/authorize?' + _repeated(authorizeParams(challenge),
                                            'redirect_uri'),
        isJson=False)
    assert _status(resp) == 400


def testRateLimitKeyIsTheAddressTheProxyGives(enabled, monkeypatch):
    # Through the real request stack: Girder's proxy tool makes the FIRST
    # X-Forwarded-For entry the client (HAProxy owns the header: it
    # overwrites it), and without the header the socket peer counts.
    from nimbus_mcp_oauth import rest
    keys = []

    class Recorder:
        def check(self, key):
            keys.append(key)
            return True

    monkeypatch.setattr(rest, '_authorizeLimit', Recorder())
    _, challenge = pkcePair()
    params = authorizeParams(challenge)
    enabled.request('/mcp_oauth/authorize', params=params, isJson=False,
                    additionalHeaders=[('X-Forwarded-For',
                                        '203.0.113.7, 198.51.100.9')])
    enabled.request('/mcp_oauth/authorize', params=params, isJson=False)
    assert keys == ['203.0.113.7', '127.0.0.1']

"""The authorization server's logic, free of HTTP concerns.

Raises ``OAuthError`` (or ``RedirectableError`` from authorize once the
client and redirect URI are trusted); ``rest.py`` turns those into
responses.

Flow: authorize stores a pending request and sends the browser to the
consent page; approve turns it into a one-time code (60 s); the token
endpoint swaps code + PKCE verifier for an access token (8 h) and a refresh
token (30 days idle, rotated on every use). An access token stands for a
Girder session token minted for the user, which the MCP service gets from
introspection and uses for its REST calls.
"""
import base64
import datetime
import hashlib
import re
import secrets
from urllib.parse import urlencode, urlsplit, urlunsplit

from bson import ObjectId

from girder.constants import TokenScope
from girder.models.token import Token
from girder.models.user import User

from . import clients, settings
from .errors import OAuthError, RedirectableError
from .models import (
    AccessToken, AuthorizationCode, AuthorizationRequest, Grant,
    RefreshToken, expired, now)
from .urls import canonicalResource

SCOPE = 'nimbusimage'
# Accepted in a request and ignored: Claude adds offline_access when the
# server metadata lists it, and refresh tokens are always issued.
IGNORED_SCOPES = {'offline_access'}
ACCESS_LIFETIME = datetime.timedelta(hours=8)
REFRESH_IDLE_LIFETIME = datetime.timedelta(days=30)
CODE_LIFETIME = datetime.timedelta(seconds=60)
REQUEST_LIFETIME = datetime.timedelta(minutes=10)
ACCESS_PREFIX = 'nio_'
REFRESH_PREFIX = 'nir_'
MAX_STATE = 2048
# RFC 7636: verifier 43-128 unreserved characters; an S256 challenge is the
# 43-character base64url SHA-256 digest.
VERIFIER_RE = re.compile(r'[A-Za-z0-9\-._~]{43,128}')
CHALLENGE_RE = re.compile(r'[A-Za-z0-9\-_]{43}')
TOKEN_RE = re.compile(r'(nio|nir)_[A-Za-z0-9\-_]{43}')


def _hash(secret):
    return hashlib.sha256(secret.encode()).hexdigest()


def _newSecret(prefix):
    return prefix + secrets.token_urlsafe(32)


def allowedResources():
    return {canonicalResource(r) for r in settings.get(settings.RESOURCES)}


def _withParams(uri, params):
    parts = urlsplit(uri)
    query = parts.query + ('&' if parts.query else '') + urlencode(params)
    return urlunsplit(parts._replace(query=query))


def errorRedirect(redirectUri, error, description, state):
    params = {'error': error, 'error_description': description,
              'iss': settings.get(settings.ISSUER)}
    if state is not None:
        params['state'] = state
    return _withParams(redirectUri, params)


# --- authorize ------------------------------------------------------------

def startAuthorization(params):
    """Validate an authorize request and store it for consent.

    Returns ``(client, redirectUri, requestId)``. Errors before the client
    and redirect URI are trusted are plain ``OAuthError``s (shown to the
    user, never redirected); later ones are ``RedirectableError``s.
    """
    client = clients.resolve(params.get('client_id'))
    redirectUri = params.get('redirect_uri')
    if not clients.redirectAllowed(client, redirectUri):
        raise OAuthError(
            'invalid_request',
            'redirect_uri is not registered for this client.')
    state = params.get('state')
    if state is not None and len(state) > MAX_STATE:
        raise RedirectableError('invalid_request', 'state is too long.',
                                echoState=False)
    if params.get('response_type') != 'code':
        raise RedirectableError(
            'unsupported_response_type', 'Only response_type=code.')
    if params.get('code_challenge_method') != 'S256' or not \
            CHALLENGE_RE.fullmatch(params.get('code_challenge') or ''):
        raise RedirectableError(
            'invalid_request', 'PKCE with code_challenge_method=S256 is '
            'required.')
    resource = canonicalResource(params.get('resource') or '')
    if resource is None or resource not in allowedResources():
        raise RedirectableError(
            'invalid_target', 'resource must name this MCP server.')
    requested = set((params.get('scope') or '').split()) - IGNORED_SCOPES
    if requested - {SCOPE}:
        raise RedirectableError('invalid_scope', f'Only scope {SCOPE}.')
    requestId = secrets.token_urlsafe(24)
    AuthorizationRequest().save({
        '_id': requestId,
        'clientId': client['client_id'],
        'clientName': client['client_name'],
        'redirectUri': redirectUri,
        'codeChallenge': params['code_challenge'],
        'state': state,
        'resource': resource,
        'scope': SCOPE,
        'consumed': False,
        'expiresAt': now() + REQUEST_LIFETIME,
    })
    return client, redirectUri, requestId


def _requestGone():
    return OAuthError(
        'invalid_request',
        'This sign-in request has expired or was already used. Start '
        'again from Claude.', status=404)


def pendingRequest(requestId):
    request = AuthorizationRequest().findOne({'_id': requestId})
    if request is None or request['consumed'] or expired(request):
        raise _requestGone()
    return request


def describeRequest(requestId):
    """What the consent page shows."""
    request = pendingRequest(requestId)
    return {
        'clientName': request['clientName'],
        'clientId': request['clientId'],
        'redirectHost': urlsplit(request['redirectUri']).netloc,
        'localRedirect': clients.isLoopback(request['redirectUri']),
        'resource': request['resource'],
        'scope': request['scope'],
    }


def _consume(requestId):
    request = pendingRequest(requestId)
    # Atomic: of two concurrent approvals only one flips consumed, and only
    # while the request is still live (it may expire after the read above).
    result = AuthorizationRequest().update(
        {'_id': requestId, 'consumed': False, 'expiresAt': {'$gt': now()}},
        {'$set': {'consumed': True}}, multi=False)
    if result.modified_count != 1:
        raise _requestGone()
    return request


def approve(requestId, user):
    """Issue a one-time code; returns the URL to send the browser to."""
    request = _consume(requestId)
    code = secrets.token_urlsafe(32)
    AuthorizationCode().save({
        '_id': _hash(code),
        'userId': user['_id'],
        'clientId': request['clientId'],
        'clientName': request['clientName'],
        'redirectUri': request['redirectUri'],
        'codeChallenge': request['codeChallenge'],
        'resource': request['resource'],
        'scope': request['scope'],
        'used': False,
        'grantId': None,
        'expiresAt': now() + CODE_LIFETIME,
    })
    params = {'code': code, 'iss': settings.get(settings.ISSUER)}
    if request['state'] is not None:
        params['state'] = request['state']
    return _withParams(request['redirectUri'], params)


def deny(requestId):
    request = _consume(requestId)
    return errorRedirect(
        request['redirectUri'], 'access_denied',
        'The user declined the request.', request['state'])


# --- token endpoint -------------------------------------------------------

def token(params):
    grantType = params.get('grant_type')
    if grantType == 'authorization_code':
        return _exchangeCode(params)
    if grantType == 'refresh_token':
        return _refresh(params)
    raise OAuthError('unsupported_grant_type',
                     'grant_type must be authorization_code or '
                     'refresh_token.')


def _pkceMatches(verifier, challenge):
    if not VERIFIER_RE.fullmatch(verifier or ''):
        return False
    digest = hashlib.sha256(verifier.encode()).digest()
    computed = base64.urlsafe_b64encode(digest).rstrip(b'=').decode()
    return secrets.compare_digest(computed, challenge)


def _checkResource(params, expected):
    if params.get('resource') is not None and \
            canonicalResource(params['resource']) != expected:
        raise OAuthError(
            'invalid_target', 'resource does not match the grant.')


def _exchangeCode(params):
    # Before claiming the code: a malformed request must not spend it.
    if not params.get('client_id'):
        raise OAuthError('invalid_request', 'client_id is required.')
    code = params.get('code') or ''
    codeId = _hash(code)
    grantId = ObjectId()
    # Mistakes a well-behaved client can make (a redirect_uri or resource
    # that does not match the authorization) are request errors, so (as for
    # refresh) they are checked on a peek before the code is spent, and only
    # for the right client: a wrong client falls through to the claim. PKCE
    # stays after the claim: a wrong verifier is a caller who cannot prove
    # it started this sign-in, not a typo.
    peek = AuthorizationCode().findOne({'_id': codeId, 'used': False})
    if peek and peek['clientId'] == params.get('client_id'):
        if params.get('redirect_uri') != peek['redirectUri']:
            raise OAuthError('invalid_grant', 'redirect_uri does not match.')
        _checkResource(params, peek['resource'])
    # Atomic single use: only one exchange flips used, and it records the
    # grant it will create, so a replay can always find what to revoke.
    result = AuthorizationCode().update(
        {'_id': codeId, 'used': False},
        {'$set': {'used': True, 'grantId': grantId}}, multi=False)
    doc = AuthorizationCode().findOne({'_id': codeId})
    if result.modified_count != 1:
        if doc is not None and doc.get('grantId'):
            # A replayed code: revoke what it issued (RFC 6749 4.1.2). The
            # flag also reaches an exchange still creating that grant.
            AuthorizationCode().update(
                {'_id': codeId}, {'$set': {'replayed': True}}, multi=False)
            revokeGrant(doc['grantId'])
        raise OAuthError('invalid_grant', 'Invalid authorization code.')
    # Gone between the claim and the read: the TTL monitor removed it.
    if doc is None or expired(doc):
        raise OAuthError('invalid_grant', 'The authorization code expired.')
    if params.get('client_id') != doc['clientId']:
        raise OAuthError('invalid_grant', 'Code was issued to another client.')
    if params.get('redirect_uri') != doc['redirectUri']:
        raise OAuthError('invalid_grant', 'redirect_uri does not match.')
    if not _pkceMatches(params.get('code_verifier'), doc['codeChallenge']):
        raise OAuthError('invalid_grant', 'PKCE verification failed.')
    _checkResource(params, doc['resource'])
    user = _activeUser(doc['userId'])
    if user is None:
        raise OAuthError('invalid_grant', 'The account is not active.')
    grant = Grant().save({
        '_id': grantId,
        'userId': user['_id'],
        'clientId': doc['clientId'],
        'clientName': doc['clientName'],
        'redirectHost': urlsplit(doc['redirectUri']).netloc,
        'resource': doc['resource'],
        'scope': doc['scope'],
        'created': now(),
        'lastUsed': now(),
        'expiresAt': now() + REFRESH_IDLE_LIFETIME,
    })
    # Earlier connections of this user and client are left alone: the
    # client id is shared by every device (Claude Code on two machines) and
    # every claude.ai org, so it cannot tell a reconnect from a second
    # device. An abandoned connection's Girder sessions expire with its
    # last access token (8 h); its unheld refresh token after 30 idle days.
    return _issueIfStillGranted(grant, user, codeId=codeId)


def _refresh(params):
    # Before claiming the token: a malformed request must not spend it.
    if not params.get('client_id'):
        raise OAuthError('invalid_request', 'client_id is required.')
    refresh = params.get('refresh_token') or ''
    refreshId = _hash(refresh)
    # A resource that does not match the connection is a request error, so
    # it is checked (on a peek) before the token is spent too.
    if params.get('resource') is not None:
        peek = RefreshToken().findOne({'_id': refreshId, 'used': False})
        peekGrant = peek and Grant().findOne({'_id': peek['grantId']})
        # Only for the right client: a wrong client falls through to the
        # claim, which revokes the connection.
        if peekGrant and peekGrant['clientId'] == params['client_id']:
            _checkResource(params, peekGrant['resource'])
    result = RefreshToken().update(
        {'_id': refreshId, 'used': False}, {'$set': {'used': True}},
        multi=False)
    doc = RefreshToken().findOne({'_id': refreshId})
    if doc is None:
        raise OAuthError('invalid_grant', 'Invalid refresh token.')
    if result.modified_count != 1:
        # Reuse of a rotated refresh token: someone else may hold it, so
        # end the whole connection.
        revokeGrant(doc['grantId'])
        raise OAuthError('invalid_grant', 'Refresh token was already used.')
    grant = Grant().findOne({'_id': doc['grantId']})
    if grant is None or expired(doc) or expired(grant):
        raise OAuthError('invalid_grant', 'The connection has ended.')
    if params.get('client_id') != grant['clientId']:
        revokeGrant(grant['_id'])
        raise OAuthError('invalid_grant', 'Token was issued to another '
                         'client.')
    user = _activeUser(grant['userId'])
    if user is None:
        revokeGrant(grant['_id'])
        raise OAuthError('invalid_grant', 'The account is not active.')
    Grant().update({'_id': grant['_id']}, {'$set': {
        'lastUsed': now(), 'expiresAt': now() + REFRESH_IDLE_LIFETIME}},
        multi=False)
    return _issueIfStillGranted(grant, user)


def _issueIfStillGranted(grant, user, codeId=None):
    """Issue tokens, then make sure the connection was not ended while
    they were being created (a concurrent replay or reuse revoking it);
    if it was, take the new tokens back too."""
    tokens = _issue(grant, user)
    replayed = codeId is not None and AuthorizationCode().findOne(
        {'_id': codeId, 'replayed': True}) is not None
    if replayed or Grant().findOne({'_id': grant['_id']}) is None:
        revokeGrant(grant['_id'])
        raise OAuthError('invalid_grant', 'The connection was ended.')
    return tokens


def _issue(grant, user):
    girderToken = Token().createToken(
        user=user, days=ACCESS_LIFETIME.total_seconds() / 86400,
        scope=TokenScope.USER_AUTH)
    access = _newSecret(ACCESS_PREFIX)
    refresh = _newSecret(REFRESH_PREFIX)
    expiresAt = now() + ACCESS_LIFETIME
    AccessToken().save({
        '_id': _hash(access), 'grantId': grant['_id'],
        'userId': user['_id'], 'girderTokenId': girderToken['_id'],
        'expiresAt': expiresAt,
    })
    RefreshToken().save({
        '_id': _hash(refresh), 'grantId': grant['_id'], 'used': False,
        'expiresAt': now() + REFRESH_IDLE_LIFETIME,
    })
    return {
        'access_token': access,
        'token_type': 'Bearer',
        'expires_in': int(ACCESS_LIFETIME.total_seconds()),
        'refresh_token': refresh,
        'scope': grant['scope'],
    }


def _activeUser(userId):
    """The user, if they could log in right now (not disabled, approved,
    email verified as required)."""
    user = User().load(userId, force=True)
    if user is None or not User().canLogin(user):
        return None
    return user


# --- introspection and revocation ----------------------------------------

INACTIVE = {'active': False}


def introspect(tokenValue):
    """For the MCP service only. An active access token's user, grant and
    the Girder session token to act with."""
    if not isinstance(tokenValue, str) or \
            not tokenValue.startswith(ACCESS_PREFIX) or \
            not TOKEN_RE.fullmatch(tokenValue):
        return INACTIVE
    access = AccessToken().findOne({'_id': _hash(tokenValue)})
    if access is None or expired(access):
        return INACTIVE
    grant = Grant().findOne({'_id': access['grantId']})
    girderToken = Token().load(
        access['girderTokenId'], force=True, objectId=False)
    if grant is None or expired(grant) or girderToken is None or \
            _aware(girderToken['expires']) <= now():
        return INACTIVE
    user = _activeUser(access['userId'])
    if user is None:
        return INACTIVE
    return {
        'active': True,
        'sub': str(user['_id']),
        'username': user['login'],
        'client_id': grant['clientId'],
        'scope': grant['scope'],
        'resource': grant['resource'],
        'exp': int(_aware(access['expiresAt']).timestamp()),
        'girder_token': girderToken['_id'],
    }


def _aware(moment):
    if moment.tzinfo is None:
        return moment.replace(tzinfo=datetime.timezone.utc)
    return moment


def revokeGrants(grantIds):
    """End connections: their refresh tokens, access tokens and the
    Girder sessions behind them, in one query per collection."""
    if not grantIds:
        return
    byGrant = {'grantId': {'$in': list(grantIds)}}
    tokenIds = [a['girderTokenId'] for a in AccessToken().find(
        byGrant, fields=['girderTokenId'])]
    if tokenIds:
        Token().removeWithQuery({'_id': {'$in': tokenIds}})
    AccessToken().removeWithQuery(byGrant)
    RefreshToken().removeWithQuery(byGrant)
    Grant().removeWithQuery({'_id': {'$in': list(grantIds)}})


def revokeGrant(grantId):
    revokeGrants([grantId])


def revokeToken(tokenValue):
    """RFC 7009: revoking either token ends the connection. Unknown tokens
    are not an error."""
    if not isinstance(tokenValue, str) or not TOKEN_RE.fullmatch(tokenValue):
        return
    model = AccessToken if tokenValue.startswith(ACCESS_PREFIX) \
        else RefreshToken
    doc = model().findOne({'_id': _hash(tokenValue)})
    if doc is not None:
        revokeGrant(doc['grantId'])


def listGrants(user):
    # Not yet reaped by the TTL monitor is not the same as still connected.
    live = Grant().find({'userId': user['_id'], 'expiresAt': {'$gt': now()}},
                        sort=[('created', 1)])
    return [{
        'id': str(g['_id']),
        'clientName': g['clientName'],
        'clientId': g['clientId'],
        'redirectHost': g['redirectHost'],
        'created': g['created'],
        'lastUsed': g['lastUsed'],
    } for g in live]


def revokeUserGrant(user, grantId):
    grant = Grant().findOne({'_id': grantId, 'userId': user['_id']})
    if grant is None:
        raise OAuthError('invalid_request', 'No such connection.', status=404)
    revokeGrant(grant['_id'])


# --- metadata -------------------------------------------------------------

def metadata():
    """RFC 8414 authorization server metadata."""
    issuer = settings.get(settings.ISSUER)
    api = settings.get(settings.API_URL) or f'{issuer}/api/v1'
    return {
        'issuer': issuer,
        'authorization_endpoint': f'{api}/mcp_oauth/authorize',
        'token_endpoint': f'{api}/mcp_oauth/token',
        'revocation_endpoint': f'{api}/mcp_oauth/revoke',
        'response_types_supported': ['code'],
        'grant_types_supported': ['authorization_code', 'refresh_token'],
        'code_challenge_methods_supported': ['S256'],
        'token_endpoint_auth_methods_supported': ['none'],
        'revocation_endpoint_auth_methods_supported': ['none'],
        'scopes_supported': [SCOPE, 'offline_access'],
        'client_id_metadata_document_supported': True,
        'authorization_response_iss_parameter_supported': True,
    }

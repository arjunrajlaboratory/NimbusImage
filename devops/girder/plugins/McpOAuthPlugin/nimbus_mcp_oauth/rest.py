"""HTTP layer of the MCP OAuth server, at ``/api/v1/mcp_oauth`` plus the
metadata document at the server root (``/.well-known/...``).

Everything answers 404 while the ``mcp_oauth.enabled`` setting is false.
"""
import secrets

import cherrypy
from bson import ObjectId
from bson.errors import InvalidId
from girder.api import access
from girder.api.describe import Description, describeRoute
from girder.api.rest import (
    Resource, RestException, disableAuditLog, setResponseHeader)

from . import oauth, settings
from .errors import OAuthError, RedirectableError
from .rate_limit import SlidingWindowRateLimiter

INTROSPECTION_HEADER = 'X-Mcp-Introspection-Secret'

# authorize comes from users' browsers, so per address is per user. The
# token endpoint is called by connector backends: claude.ai's comes from a
# few shared Anthropic addresses on behalf of every user, so its cap is a
# backstop against floods, not a per-user limit (tokens are 256-bit, so
# guessing is not the threat). Consent is per user.
_authorizeLimit = SlidingWindowRateLimiter(30, 60)
_tokenLimit = SlidingWindowRateLimiter(1200, 60)
_consentLimit = SlidingWindowRateLimiter(30, 60)


def _requireEnabled():
    if not settings.enabled():
        raise RestException('Not found.', code=404)


def _clientAddress():
    """The address to rate-limit. Girder turns on CherryPy's proxy tool,
    which has already replaced remote.ip with the first X-Forwarded-For
    entry; HAProxy sets that header to the client's real address,
    replacing anything the client sent, so this is the client."""
    return cherrypy.request.remote.ip


def _limit(limiter, key):
    if not limiter.check(key):
        raise RestException('Too many requests; try again shortly.',
                            code=429)


def _oauthErrorBody(err):
    cherrypy.response.status = err.status
    return {'error': err.error, 'error_description': err.description}


def _refuseQueryCredentials():
    """Codes, verifiers and tokens belong in the POST body: a query string
    is written to the access log, which @disableAuditLog does not cover."""
    if cherrypy.request.query_string:
        raise OAuthError(
            'invalid_request', 'Send the parameters in the request body.')


def _noStore():
    setResponseHeader('Cache-Control', 'no-store')
    setResponseHeader('Pragma', 'no-cache')


class McpOAuthResource(Resource):
    def __init__(self):
        super().__init__()
        self.resourceName = 'mcp_oauth'
        self.route('GET', ('authorize',), self.authorize)
        self.route('GET', ('request', ':id'), self.getRequest)
        self.route('POST', ('request', ':id', 'approve'), self.approve)
        self.route('POST', ('request', ':id', 'deny'), self.deny)
        self.route('POST', ('token',), self.token)
        self.route('POST', ('revoke',), self.revoke)
        self.route('POST', ('introspect',), self.introspect)
        self.route('GET', ('grant',), self.listGrants)
        self.route('DELETE', ('grant', ':id'), self.deleteGrant)

    @access.public
    @describeRoute(
        Description('OAuth authorization endpoint (browser redirect).')
        .notes('Redirects to the consent page, or back to the client '
               'with an error.')
        .param('client_id', 'Client id or metadata document URL.')
        .param('redirect_uri', 'Registered redirect URI.')
        .param('response_type', 'Must be "code".')
        .param('code_challenge', 'PKCE S256 challenge.')
        .param('code_challenge_method', 'Must be "S256".')
        .param('resource', 'The MCP server URL (RFC 8707).')
        .param('state', 'Opaque client state.', required=False)
        .param('scope', 'Requested scope.', required=False)
    )
    def authorize(self, params):
        _requireEnabled()
        _limit(_authorizeLimit, _clientAddress())
        try:
            _, _, requestId = oauth.startAuthorization(params)
        except RedirectableError as err:
            raise cherrypy.HTTPRedirect(oauth.errorRedirect(
                params['redirect_uri'], err.error, err.description,
                params.get('state') if err.echoState else None), 302)
        except OAuthError as err:
            # The client or redirect URI is not trusted: never redirect.
            raise RestException(err.description, code=400)
        frontend = settings.get(settings.FRONTEND_URL) or \
            settings.get(settings.ISSUER)
        raise cherrypy.HTTPRedirect(
            f'{frontend}/#/oauth/consent?request={requestId}', 302)

    @access.user
    @describeRoute(
        Description('What a pending sign-in request asks for (consent '
                    'page).')
        .param('id', 'The request id.', paramType='path')
    )
    def getRequest(self, id, params):
        _requireEnabled()
        try:
            return oauth.describeRequest(id)
        except OAuthError as err:
            raise RestException(err.description, code=err.status)

    @access.user
    @describeRoute(
        Description('Approve a pending sign-in request as the current user.')
        .notes('Returns the URL to send the browser to.')
        .param('id', 'The request id.', paramType='path')
    )
    def approve(self, id, params):
        _requireEnabled()
        user = self.getCurrentUser()
        _limit(_consentLimit, str(user['_id']))
        try:
            return {'redirect': oauth.approve(id, user)}
        except OAuthError as err:
            raise RestException(err.description, code=err.status)

    @access.user
    @describeRoute(
        Description('Decline a pending sign-in request.')
        .param('id', 'The request id.', paramType='path')
    )
    def deny(self, id, params):
        _requireEnabled()
        _limit(_consentLimit, str(self.getCurrentUser()['_id']))
        try:
            return {'redirect': oauth.deny(id)}
        except OAuthError as err:
            raise RestException(err.description, code=err.status)

    # Secrets travel in these parameters, so they stay out of the audit log.
    @disableAuditLog
    @access.public
    @describeRoute(
        Description('OAuth token endpoint (form-encoded).')
        .param('grant_type', 'authorization_code or refresh_token.',
               paramType='formData')
    )
    def token(self, params):
        _requireEnabled()
        _noStore()
        if not _tokenLimit.check(_clientAddress()):
            setResponseHeader('Retry-After', '60')
            return _oauthErrorBody(OAuthError(
                'temporarily_unavailable', 'Too many requests; retry '
                'shortly.', status=429))
        try:
            _refuseQueryCredentials()
            return oauth.token(params)
        except OAuthError as err:
            return _oauthErrorBody(err)

    @disableAuditLog
    @access.public
    @describeRoute(
        Description('OAuth token revocation (RFC 7009).')
        .param('token', 'Access or refresh token.', paramType='formData')
    )
    def revoke(self, params):
        _requireEnabled()
        _limit(_tokenLimit, _clientAddress())
        try:
            _refuseQueryCredentials()
        except OAuthError as err:
            return _oauthErrorBody(err)
        oauth.revokeToken(params.get('token'))
        return {}

    # Token introspection for the MCP service only: needs the shared secret
    # header, and is left out of the API docs.
    @disableAuditLog
    @access.public
    @describeRoute(None)
    def introspect(self, params):
        _requireEnabled()
        expected = settings.get(settings.INTROSPECTION_SECRET)
        given = cherrypy.request.headers.get(INTROSPECTION_HEADER, '')
        if not expected or not secrets.compare_digest(
                given.encode(), expected.encode()):
            raise RestException('Not found.', code=404)
        _noStore()
        try:
            _refuseQueryCredentials()
        except OAuthError as err:
            return _oauthErrorBody(err)
        return oauth.introspect(params.get('token'))

    @access.user
    @describeRoute(Description('Your connected MCP clients.'))
    def listGrants(self, params):
        _requireEnabled()
        return oauth.listGrants(self.getCurrentUser())

    @access.user
    @describeRoute(
        Description('Disconnect one of your MCP clients.')
        .param('id', 'The connection id.', paramType='path')
    )
    def deleteGrant(self, id, params):
        _requireEnabled()
        try:
            oauth.revokeUserGrant(self.getCurrentUser(), _objectId(id))
        except OAuthError as err:
            raise RestException(err.description, code=err.status)
        return {}


def _objectId(value):
    try:
        return ObjectId(value)
    except (InvalidId, TypeError):
        raise RestException('No such connection.', code=404)


class WellKnown:
    """Mounted at the server root's ``/.well-known``: the RFC 8414
    metadata document, where clients look for it (not under /api/v1)."""

    @cherrypy.expose
    @cherrypy.tools.json_out()
    def oauth_authorization_server(self, *args, **kwargs):
        if args or not settings.enabled():
            raise cherrypy.NotFound()
        cherrypy.response.headers['Access-Control-Allow-Origin'] = '*'
        cherrypy.response.headers['Cache-Control'] = 'public, max-age=300'
        return oauth.metadata()

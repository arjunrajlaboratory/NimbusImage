"""Which OAuth clients may sign users in, and where they may redirect.

Two kinds, both public clients (PKCE, no secret):

- One built-in client, for "Use your own OAuth client" in Claude's
  connector dialog and ``claude mcp add --client-id``.
- Client ID Metadata Documents: the client_id is an https URL on an allowed
  host (claude.ai, claude.com by default) serving the client's name and
  redirect URIs. This is "Use Claude's published identity" and Claude
  Code's default. Fetching a URL the client chose is a server-side request,
  so only allowed hosts are fetched, over https, without redirects, with a
  short timeout and a size cap. A document may only list Claude's
  callbacks or loopback redirects.
"""
import datetime
import json
from urllib.parse import urlsplit

import requests

from . import settings
from .errors import OAuthError
from .models import ClientDocument, expired, now

CLAUDE_CALLBACKS = [
    'https://claude.ai/api/mcp/auth_callback',
    'https://claude.com/api/mcp/auth_callback',
]
LOOPBACK_CALLBACKS = [
    'http://localhost/callback',
    'http://127.0.0.1/callback',
]
BUILTIN_CLIENT_ID = 'nimbusimage-claude'
BUILTIN_CLIENTS = {
    BUILTIN_CLIENT_ID: {
        'client_id': BUILTIN_CLIENT_ID,
        'client_name': 'Claude',
        'redirect_uris': CLAUDE_CALLBACKS + LOOPBACK_CALLBACKS,
    },
}

CIMD_TIMEOUT_SECONDS = 5
CIMD_MAX_BYTES = 64 * 1024
CIMD_CACHE = datetime.timedelta(hours=1)
MAX_REDIRECT_URIS = 20
MAX_CLIENT_NAME = 100
LOOPBACK_HOSTS = {'localhost', '127.0.0.1', '::1'}


def resolve(clientId):
    """The client's ``{client_id, client_name, redirect_uris}``, or an
    ``invalid_client`` error."""
    if not isinstance(clientId, str) or not clientId:
        raise OAuthError('invalid_client', 'client_id is required.')
    if clientId in BUILTIN_CLIENTS:
        return BUILTIN_CLIENTS[clientId]
    if not _isAllowedDocumentUrl(clientId):
        raise OAuthError('invalid_client', 'Unknown client.')
    cached = ClientDocument().findOne({'_id': clientId})
    if cached and not expired(cached):
        return cached['client']
    client = _fetchDocument(clientId)
    ClientDocument().save({
        '_id': clientId, 'client': client, 'expiresAt': now() + CIMD_CACHE})
    return client


def _isAllowedDocumentUrl(url):
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        return False
    return (
        parts.scheme == 'https'
        and parts.hostname in settings.cimdHosts()
        and port in (None, 443)
        and parts.username is None and parts.password is None
        and parts.path not in ('', '/')
        and not parts.fragment
    )


def _fetchDocument(url):
    try:
        with requests.get(
                url, timeout=CIMD_TIMEOUT_SECONDS, allow_redirects=False,
                stream=True, headers={'Accept': 'application/json'}) as resp:
            if resp.status_code != 200:
                raise OAuthError(
                    'invalid_client',
                    f'Client metadata document answered {resp.status_code}.')
            body = b''
            for chunk in resp.iter_content(8192):
                body += chunk
                if len(body) > CIMD_MAX_BYTES:
                    raise OAuthError(
                        'invalid_client', 'Client metadata is too large.')
        doc = json.loads(body)
    except requests.RequestException:
        raise OAuthError(
            'invalid_client', 'Could not fetch the client metadata.')
    except ValueError:  # includes JSON and Unicode decoding errors
        raise OAuthError('invalid_client', 'Client metadata is not JSON.')
    return _validateDocument(url, doc)


def _validateDocument(url, doc):
    if not isinstance(doc, dict) or doc.get('client_id') != url:
        raise OAuthError(
            'invalid_client', 'Client metadata does not name this client.')
    redirects = doc.get('redirect_uris')
    if (not isinstance(redirects, list) or not redirects
            or len(redirects) > MAX_REDIRECT_URIS
            or not all(_documentRedirectAllowed(r) for r in redirects)):
        raise OAuthError(
            'invalid_client', 'Client metadata has no valid redirect_uris.')
    if doc.get('token_endpoint_auth_method', 'none') != 'none':
        raise OAuthError(
            'invalid_client', 'Only public clients (no secret) are supported.')
    name = doc.get('client_name')
    if not isinstance(name, str) or not name.strip():
        name = urlsplit(url).hostname
    return {
        'client_id': url,
        'client_name': name.strip()[:MAX_CLIENT_NAME],
        'redirect_uris': redirects,
    }


def _documentRedirectAllowed(uri):
    """A metadata document may only send codes to Claude's callbacks or to
    the user's own machine: a JSON file served from an allowed host must
    not be able to redirect codes anywhere else."""
    if not isinstance(uri, str):
        return False
    if uri in CLAUDE_CALLBACKS:
        return True
    try:
        parts = urlsplit(uri)
        parts.port
    except ValueError:
        return False
    return (parts.scheme == 'http' and parts.hostname in LOOPBACK_HOSTS
            and not parts.username and not parts.password
            and not parts.fragment)


def redirectAllowed(client, redirectUri):
    """Exact match against the client's redirect URIs, except that a
    loopback redirect registered without a port matches any port
    (RFC 8252 section 7.3), as native clients pick an ephemeral one."""
    if not isinstance(redirectUri, str):
        return False
    registered = client['redirect_uris']
    if redirectUri in registered:
        return True
    try:
        asked = urlsplit(redirectUri)
        askedPort = asked.port
    except ValueError:
        return False
    if (asked.scheme != 'http' or asked.hostname not in LOOPBACK_HOSTS
            or askedPort is None or asked.username or asked.password
            or asked.fragment):
        return False
    for uri in registered:
        try:
            reg = urlsplit(uri)
            regPort = reg.port
        except ValueError:
            continue
        if (reg.scheme == 'http' and regPort is None
                and reg.hostname == asked.hostname
                and reg.path == asked.path and reg.query == asked.query):
            return True
    return False


def isLoopback(redirectUri):
    return urlsplit(redirectUri).hostname in LOOPBACK_HOSTS

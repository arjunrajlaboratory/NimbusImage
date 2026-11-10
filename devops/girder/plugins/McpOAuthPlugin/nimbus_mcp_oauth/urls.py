"""URL checks shared by the settings validators and the OAuth flow."""
from urllib.parse import urlsplit, urlunsplit


def _parse(url):
    """The parts of an http(s) URL with a host, or None."""
    try:
        parts = urlsplit(url)
        parts.port  # raises ValueError for a bad port
    except (ValueError, AttributeError):
        return None
    if parts.scheme.lower() not in ('http', 'https') or not parts.hostname:
        return None
    return parts


def isPlainHttpUrl(url):
    """An http(s) URL with a host and no credentials, query or fragment:
    an issuer, a REST root or the frontend's address."""
    parts = _parse(url)
    return parts is not None and not (
        parts.username or parts.password or parts.query or parts.fragment)


def canonicalResource(url):
    """RFC 8707 resource in canonical form: lower-case scheme and host, no
    default port, no trailing slash, no fragment."""
    parts = _parse(url)
    if parts is None or parts.fragment:
        return None
    scheme = parts.scheme.lower()
    host = parts.hostname
    if ':' in host:
        host = f'[{host}]'
    if parts.port and parts.port != {'http': 80, 'https': 443}[scheme]:
        host = f'{host}:{parts.port}'
    return urlunsplit(
        (scheme, host, parts.path.rstrip('/'), parts.query, ''))

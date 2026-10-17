"""Settings for the MCP OAuth server, all under ``mcp_oauth.``.

Set them as a site admin with ``PUT /system/setting``. While ``enabled`` is
false every endpoint of this plugin answers 404.
"""
import re
from urllib.parse import urlsplit

from girder.exceptions import ValidationException
from girder.models.setting import Setting
from girder.utility import setting_utilities

from .urls import canonicalResource, isPlainHttpUrl

ENABLED = 'mcp_oauth.enabled'
# The public origin that issues tokens, e.g. https://app.nimbusimage.com.
# Must equal the MCP server's NI_MCP_ISSUER_URL exactly: clients compare it
# with the protected-resource metadata's authorization_servers entry.
ISSUER = 'mcp_oauth.issuer'
# Public URL of Girder's REST root as browsers and clients reach it, e.g.
# https://app.nimbusimage.com/girder/api/v1 (HAProxy adds /girder).
API_URL = 'mcp_oauth.api_url'
# Where the consent page lives, e.g. https://app.nimbusimage.com
FRONTEND_URL = 'mcp_oauth.frontend_url'
# The MCP server URLs a token may be issued for (RFC 8707 resource).
RESOURCES = 'mcp_oauth.resources'
# Shared secret the MCP service sends to the introspection endpoint.
# Required to enable the plugin (without it every MCP call would fail).
INTROSPECTION_SECRET = 'mcp_oauth.introspection_secret'
# Hosts whose Client ID Metadata Documents are fetched.
CIMD_HOSTS = 'mcp_oauth.cimd_hosts'

DEFAULT_CIMD_HOSTS = ['claude.ai', 'claude.com']


@setting_utilities.default(ENABLED)
def _defaultEnabled():
    return False


@setting_utilities.default({ISSUER, API_URL, FRONTEND_URL,
                            INTROSPECTION_SECRET})
def _defaultEmpty():
    return ''


@setting_utilities.default(RESOURCES)
def _defaultResources():
    return []


@setting_utilities.default(CIMD_HOSTS)
def _defaultCimdHosts():
    return list(DEFAULT_CIMD_HOSTS)


# One normalizer per setting: the value as it should be stored, or a
# ValidationException. The validators store what it returns, and
# enabled() runs it again on the values in effect, which may have skipped
# the validators (an unset, or a GIRDER_SETTING_* environment override).
# A value is usable when normalizing leaves it unchanged.

def _url(value):
    if not isinstance(value, str) or (value and not isPlainHttpUrl(value)):
        raise ValidationException(
            'Must be an http(s) URL with a host and no query or fragment.',
            'value')
    return value.rstrip('/')


def _issuer(value):
    value = _url(value)
    # A bare origin: the metadata is served (and proxied) only at
    # /.well-known/oauth-authorization-server, where a client looks for an
    # issuer with no path (RFC 8414 section 3).
    if urlsplit(value).path:
        raise ValidationException(
            'Must be a bare origin, with no path.', 'value')
    return value


def _resources(value):
    if not isinstance(value, list) or not all(
            isinstance(v, str) and canonicalResource(v) for v in value):
        raise ValidationException(
            'Must be a list of http(s) URLs with a host and no fragment.',
            'value')
    return value


# Printable ASCII without spaces: the MCP service sends it as a header
# (NI_MCP_INTROSPECTION_SECRET has the same rule).
SECRET_RE = re.compile(r'[!-~]{32,}')


def _secret(value):
    if not isinstance(value, str) or (
            value and not SECRET_RE.fullmatch(value)):
        raise ValidationException(
            'Must be empty or at least 32 printable ASCII characters, '
            'without spaces.', 'value')
    return value


def _cimdHosts(value):
    if not isinstance(value, list) or not all(
            isinstance(v, str) and v and '/' not in v for v in value):
        raise ValidationException('Must be a list of host names.', 'value')
    return [v.lower() for v in value]


NORMALIZE = {
    ISSUER: _issuer,
    API_URL: _url,
    FRONTEND_URL: _url,
    RESOURCES: _resources,
    INTROSPECTION_SECRET: _secret,
    CIMD_HOSTS: _cimdHosts,
}
# Without these the plugin would serve broken metadata and refuse every
# sign-in, or (no introspection secret) complete every sign-in and then have
# the MCP service refuse every call.
REQUIRED = (ISSUER, RESOURCES, INTROSPECTION_SECRET)


@setting_utilities.validator(set(NORMALIZE))
def _validate(doc):
    doc['value'] = NORMALIZE[doc['key']](doc['value'])
    if doc['key'] in REQUIRED and not doc['value'] and enabled():
        raise ValidationException(
            'Disable MCP OAuth (mcp_oauth.enabled) before clearing this.',
            'value')


@setting_utilities.validator(ENABLED)
def _validateEnabled(doc):
    if not isinstance(doc['value'], bool):
        raise ValidationException('Must be true or false.', 'value')
    # Say so now rather than act disabled later. Set them first.
    problems = _problems()
    if doc['value'] and problems:
        raise ValidationException(
            'Set a valid %s before enabling MCP OAuth (a GIRDER_SETTING_* '
            'environment override takes precedence).'
            % ' and '.join(problems), 'value')


def get(key):
    return Setting().get(key)


def _problems():
    """The settings whose values in effect are unusable or missing."""
    problems = []
    for key, normalize in NORMALIZE.items():
        value = get(key)
        try:
            usable = normalize(value) == value
        except ValidationException:
            usable = False
        if not usable or (key in REQUIRED and not value):
            problems.append(key)
    return problems


def enabled():
    return get(ENABLED) is True and not _problems()


def cimdHosts():
    # A set, whatever the setting holds: a bare string from an environment
    # override would turn the host check into a substring test.
    value = get(CIMD_HOSTS)
    if not isinstance(value, list):
        return set()
    return {v for v in value if isinstance(v, str)}

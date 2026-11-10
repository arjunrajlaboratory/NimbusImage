import logging

from girder import auditLogger, plugin

from . import settings  # noqa: F401  (registers the setting validators)
from .rest import McpOAuthResource, WellKnown


# Routes whose parameters carry codes, verifiers and tokens.
SECRET_ROUTES = {'token', 'revoke', 'introspect'}


class _DropSecretRoutes(logging.Filter):
    """Keeps these routes out of Girder's audit log on every path.
    @disableAuditLog only takes effect once the handler runs; Girder logs a
    request it refuses before then (a repeated parameter) with all of its
    parameters."""

    def filter(self, record):
        details = getattr(record, 'details', None)
        route = details.get('route') if isinstance(details, dict) else None
        return not (route and len(route) > 1 and route[0] == 'mcp_oauth'
                    and route[1] in SECRET_ROUTES)


_auditFilter = _DropSecretRoutes()


class McpOAuthPlugin(plugin.GirderPlugin):
    DISPLAY_NAME = 'MCP OAuth'

    def load(self, info):
        info['apiRoot'].mcp_oauth = McpOAuthResource()
        if _auditFilter not in auditLogger.filters:
            auditLogger.addFilter(_auditFilter)
        # Clients fetch the metadata at the origin's root; CherryPy maps the
        # hyphenated path segment to the underscored method name.
        info['serverRoot'].mount(WellKnown(), '/.well-known', {'/': {}})

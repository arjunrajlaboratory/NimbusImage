from girder import plugin

from . import settings  # noqa: F401  (registers the setting validators)
from .rest import McpOAuthResource, WellKnown


class McpOAuthPlugin(plugin.GirderPlugin):
    DISPLAY_NAME = 'MCP OAuth'

    def load(self, info):
        info['apiRoot'].mcp_oauth = McpOAuthResource()
        # Clients fetch the metadata at the origin's root; CherryPy maps the
        # hyphenated path segment to the underscored method name.
        info['serverRoot'].mount(WellKnown(), '/.well-known', {'/': {}})

nimbus_mcp_oauth
================

The OAuth 2.1 authorization server for the NimbusImage MCP server
(``nimbusimage-mcp/``). Claude connectors (claude.ai, Claude Desktop, Claude
Code) sign a user in here, and the MCP server then acts as that user.

Off by default: until the ``mcp_oauth.enabled`` setting is true, every
endpoint answers 404. Design, decisions and security requirements:
``codebaseDocumentation/NIMBUSIMAGE_MCP_SERVER.md`` (sections 4.4, 6 and
Phase 3).

Tests (need MongoDB on localhost:27017)::

    cd devops/girder/plugins/McpOAuthPlugin
    tox

"""The NimbusImage MCP server: stateless streamable HTTP at /mcp.

Every request must carry ``Authorization: Bearer <credential>``, a Girder
API key or an OAuth access token from the nimbus_mcp_oauth plugin; tools
then run as that user (see auth.py). The SDK answers requests
without a valid key with 401 and serves the protected resource metadata
at /.well-known/oauth-protected-resource/mcp.

Run:
    NI_API_URL=http://localhost:8080/api/v1 python -m nimbusimage_mcp
"""

from __future__ import annotations

import logging
import sys

import uvicorn
from mcp.server import MCPServer
from mcp.server.auth.provider import TokenVerifier
from mcp.server.auth.settings import AuthSettings
from starlette.applications import Starlette

from nimbusimage_mcp import _common
from nimbusimage_mcp.auth import (
    GirderApiKeyVerifier, GirderOAuthVerifier, NimbusVerifier,
)
from nimbusimage_mcp.config import Settings
from nimbusimage_mcp.tools import TOOLS

INSTRUCTIONS = (
    "Tools for NimbusImage, a microscopy image viewer and annotation "
    "platform, acting as the signed-in user. Datasets are multidimensional "
    "images (channels, z-slices, time points, XY positions) with "
    "annotations (points for spots, polygons for cells/nuclei, lines, "
    "rectangles) and measurements (properties) computed on them. Dataset "
    "tools take a dataset_id (ni_annotations_count takes a list); use "
    "ni_datasets_list to find it. Prefer "
    "counts and summaries over listing rows. Tools marked destructive "
    "change the user's data: confirm with the user first."
)


def build_verifier(settings: Settings) -> NimbusVerifier:
    oauth = None
    if settings.introspection_secret:
        oauth = GirderOAuthVerifier(
            settings.api_url, settings.introspection_secret
        )
    return NimbusVerifier(
        GirderApiKeyVerifier(settings.api_url, settings.public_url), oauth
    )


def build_server(
    settings: Settings, verifier: TokenVerifier | None = None
) -> MCPServer:
    _common.configure(settings)
    # The SDK logs each failed tool call's message at INFO ("Tool X
    # failed: ..."); messages can quote the caller's data, and the call
    # record already counts the failure.
    logging.getLogger("mcp.server.mcpserver.server").setLevel(
        logging.WARNING
    )
    mcp = MCPServer(
        name="nimbusimage",
        instructions=INSTRUCTIONS,
        token_verifier=verifier or build_verifier(settings),
        auth=AuthSettings(
            issuer_url=settings.issuer_url,
            resource_server_url=settings.public_url,
            validate_token_resource=True,
        ),
    )
    for fn, hints in TOOLS:
        # structured_output=False: tools return compact JSON text (or an
        # image); a structured copy would double every response.
        mcp.tool(annotations=hints, structured_output=False)(fn)
    return mcp


def build_app(
    settings: Settings, verifier: TokenVerifier | None = None
) -> Starlette:
    return build_server(settings, verifier).streamable_http_app(
        stateless_http=True, json_response=True, host=settings.host
    )


def main() -> None:
    logging.basicConfig(
        stream=sys.stderr, level=logging.INFO,
        format="%(asctime)s %(name)s %(message)s",
    )
    try:
        settings = Settings.from_env()
    except ValueError as e:
        sys.exit(str(e))
    uvicorn.run(
        build_app(settings), host=settings.host, port=settings.port,
        log_level="info",
    )


if __name__ == "__main__":
    main()

"""The ni_* tools, grouped by what they touch. Each module lists its
tools with their MCP annotations in TOOLS."""

from nimbusimage_mcp.tools import (
    annotations,
    datasets,
    help,
    images,
    properties,
    workers,
)

TOOLS = [
    *datasets.TOOLS,
    *annotations.TOOLS,
    *images.TOOLS,
    *properties.TOOLS,
    *workers.TOOLS,
    *help.TOOLS,
]

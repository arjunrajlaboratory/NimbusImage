"""The ni_* tools, grouped by what they touch. Each module lists its
tools with their MCP annotations in TOOLS."""

from nimbusimage_mcp.tools import (
    analysis,
    annotations,
    datasets,
    help,
    history,
    images,
    links,
    properties,
    regions,
    workers,
)

TOOLS = [
    *datasets.TOOLS,
    *links.TOOLS,
    *annotations.TOOLS,
    *regions.TOOLS,
    *history.TOOLS,
    *images.TOOLS,
    *properties.TOOLS,
    *analysis.TOOLS,
    *workers.TOOLS,
    *help.TOOLS,
]

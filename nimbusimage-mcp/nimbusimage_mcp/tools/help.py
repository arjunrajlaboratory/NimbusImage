"""NimbusImage documentation, served by the server's help endpoint.

The articles are the ones the in-app AI panel reads (``GET
claude_agent/help``, in the girder-claude-chat plugin). Reading them over
REST, rather than copying ~100 KB of markdown into this package, keeps
one copy of the user documentation; the endpoint is a public contract
this server only reads.
"""

from __future__ import annotations

import girder_client
from mcp.server.mcpserver.exceptions import ToolError

from nimbusimage_mcp._common import READ_ONLY, client, girder_message, \
    instrumented

# The endpoint has no index route; an unknown slug gets a 400 whose
# message lists the real ones, which this tool passes on. So a topic
# missing here is still reachable, and a removed one corrects itself.
TOPICS = [
    "advanced-features", "analysis-and-measurement", "analysis-panel-gating",
    "annotation-tools", "connections", "file-formats-and-upload",
    "image-processing", "import-export", "interacting-with-objects",
    "interface-navigation", "managing-files", "sharing-projects-zenodo",
    "spatial-transcriptomics", "troubleshooting", "visualization",
    "workflows",
]


@instrumented
def ni_help_topic(topic: str | None = None) -> dict:
    """Read NimbusImage's user documentation on a topic: how a feature
    works, or how the user can do something themselves in the app (e.g.
    "workflows" for cell segmentation and measurement recipes,
    "annotation-tools", "image-processing", "connections",
    "troubleshooting"). Call without a topic to list the topics. Articles
    run 3-11 KB, so read one only when you need it.
    """
    if not topic:
        return {"topics": TOPICS}
    try:
        response = client().girder.get(
            "claude_agent/help", parameters={"topic": topic}
        )
    except girder_client.HttpError as e:
        if e.status == 400:
            raise ToolError(girder_message(e) or f"Unknown topic {topic!r}.")\
                from None
        if e.status == 404:
            raise ToolError(
                "This NimbusImage server does not serve help topics."
            ) from None
        raise
    return {"topic": topic, "markdown": response["markdown"]}


TOOLS = [(ni_help_topic, READ_ONLY)]

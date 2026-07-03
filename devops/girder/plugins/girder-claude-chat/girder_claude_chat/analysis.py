import json
import logging
import os

import anthropic
from anthropic import Anthropic
from bson import ObjectId

from girder.api import access
from girder.api.describe import Description, autoDescribeRoute
from girder.api.rest import Resource
from girder.constants import AccessType
from girder.models.folder import Folder

from .analysis_tools import AnalysisToolkit

logger = logging.getLogger(__name__)

MODEL = "claude-sonnet-5"
MAX_TOKENS = 8000
MAX_ITERATIONS = 20

SYSTEM_PROMPT = """You are a data-analysis agent embedded in NimbusImage's \
AI analysis panel, analyzing computed annotation property values for a \
microscopy image dataset.

Use the provided tools to inspect the data before drawing conclusions: \
get statistics, histograms, samples, and tag/shape breakdowns as needed. \
Then use the plot-creation tools to build the charts most relevant to the \
user's request (typically 1-4 plots). Plots you create render as \
interactive Plotly charts in the UI, so favor creating a plot over \
describing one in prose.

When you reference a plot in your summary, refer to it by its title so \
the user can find it. Finish with a concise markdown summary of your \
quantitative findings, referencing the plots you created.

If data for a requested property is missing, entirely non-numeric, or \
otherwise unsuitable for the request, say so explicitly rather than \
fabricating results."""


def _buildContextMessage(
    instructions, properties, propertyPaths, annotationCount
):
    lines = [
        instructions,
        "",
        "Dataset context:",
        "- Total annotations: %d" % annotationCount,
        "- Properties:",
    ]
    for prop in properties:
        lines.append("  - id=%s name=%s" % (
            prop.get("id"), prop.get("name")
        ))
    lines.append("- Plottable property paths (dotted path -> full name):")
    for propertyPath in propertyPaths:
        dottedPath = ".".join(propertyPath.get("path", []))
        lines.append("  - %s -> %s" % (
            dottedPath, propertyPath.get("fullName")
        ))
    return "\n".join(lines)


class ClaudeAnalysisResource(Resource):
    def __init__(self):
        super().__init__()
        self.resourceName = "claude_analysis"
        self.route("POST", (), self.analyze)

        apiKey = os.environ.get("ANTHROPIC_API_KEY")
        if apiKey:
            self.client = Anthropic(api_key=apiKey)
        else:
            self.client = None
            logger.error(
                "Can't create an Anthropic client without an API key, "
                "the claude_analysis endpoint will not work"
            )

    @access.user
    @autoDescribeRoute(
        Description(
            "Run an agentic analysis over computed annotation property "
            "values for a dataset and return a text summary plus "
            "interactive Plotly chart specs."
        )
        .jsonParam("data", "Analysis request", paramType="body", required=True)
    )
    def analyze(self, data):
        return self._analyzeImpl(data)

    def _analyzeImpl(self, data):
        emptyResponse = {
            "summary": "",
            "plots": [],
            "toolLog": [],
            "error": None,
        }

        if self.client is None:
            emptyResponse["error"] = (
                "Claude analysis is not configured: missing API key."
            )
            return emptyResponse

        datasetIdString = data.get("datasetId")
        instructions = data.get("instructions")
        if not datasetIdString or not instructions:
            emptyResponse["error"] = (
                "Both datasetId and instructions are required."
            )
            return emptyResponse

        properties = data.get("properties", [])
        propertyPaths = data.get("propertyPaths", [])

        # Convert/validate inputs once at the API boundary.
        datasetId = ObjectId(datasetIdString)
        Folder().load(
            datasetId,
            user=self.getCurrentUser(),
            level=AccessType.READ,
            exc=True,
        )
        toolkit = AnalysisToolkit(datasetId)

        annotationCount = toolkit.annotation_count()
        contextMessage = _buildContextMessage(
            instructions, properties, propertyPaths, annotationCount
        )

        messages = [
            {"role": "user", "content": contextMessage},
        ]
        toolLog = []

        try:
            response = self.client.messages.create(
                model=MODEL,
                max_tokens=MAX_TOKENS,
                system=SYSTEM_PROMPT,
                tools=toolkit.tool_definitions(),
                messages=messages,
            )

            iterations = 0
            truncated = False
            while response.stop_reason == "tool_use":
                iterations += 1
                if iterations > MAX_ITERATIONS:
                    truncated = True
                    break

                messages.append(
                    {"role": "assistant", "content": response.content}
                )

                toolResults = []
                for block in response.content:
                    if block.type != "tool_use":
                        continue
                    toolResults.append(
                        self._runToolBlock(toolkit, block, toolLog)
                    )

                messages.append({"role": "user", "content": toolResults})

                response = self.client.messages.create(
                    model=MODEL,
                    max_tokens=MAX_TOKENS,
                    system=SYSTEM_PROMPT,
                    tools=toolkit.tool_definitions(),
                    messages=messages,
                )

            summary = "".join(
                block.text for block in response.content
                if block.type == "text"
            )
            if truncated:
                summary += (
                    "\n\n_Note: analysis stopped early after reaching the "
                    "maximum number of tool-use iterations._"
                )

            return {
                "summary": summary,
                "plots": toolkit.plots,
                "toolLog": toolLog,
                "error": None,
            }
        except (anthropic.APIStatusError, anthropic.APIConnectionError) as e:
            logger.error(
                "Error in claude_analysis endpoint: %s", str(e),
                exc_info=True,
            )
            return {
                "summary": "",
                "plots": toolkit.plots,
                "toolLog": toolLog,
                "error": str(e),
            }

    def _runToolBlock(self, toolkit, block, toolLog):
        try:
            result, oneLineSummary = toolkit.run_tool(
                block.name, block.input
            )
            toolLog.append({
                "tool": block.name,
                "input": block.input,
                "summary": oneLineSummary,
            })
            return {
                "type": "tool_result",
                "tool_use_id": block.id,
                "content": json.dumps(result),
            }
        except ValueError as e:
            errorMessage = str(e)
            toolLog.append({
                "tool": block.name,
                "input": block.input,
                "summary": "error: %s" % errorMessage,
            })
            return {
                "type": "tool_result",
                "tool_use_id": block.id,
                "content": errorMessage,
                "is_error": True,
            }

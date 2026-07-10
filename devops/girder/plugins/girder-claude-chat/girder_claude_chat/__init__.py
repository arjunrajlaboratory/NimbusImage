import json
import os
import logging

from anthropic import Anthropic, APIError

from girder import plugin
from girder.api import access
from girder.api.describe import Description, autoDescribeRoute
from girder.api.rest import Resource, RestException

from .rate_limit import SlidingWindowRateLimiter

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Claude model used for all chat completions. Centralized here so that
# additional call sites in this plugin share a single source of truth.
CLAUDE_MODEL = 'claude-sonnet-5'
MAX_TOOL_SUGGESTION_IMAGES = 2
MAX_TOOL_SUGGESTION_IMAGE_DATA_CHARS = 12 * 1024 * 1024

PACKAGE_DIR = os.path.dirname(__file__)

# The system prompt ships as package data alongside this module. Resolving
# it relative to __file__ works for every install layout -- the Docker image
# (editable install), a non-editable/packaged install (the plugin's own
# tox/pytest suite), and a local non-Docker Girder.
SYSTEM_PROMPT_PATH = os.path.join(
    PACKAGE_DIR, 'system_prompt_2.txt'
)

# The AI-panel agent's system prompt and tool schema ship as package data too
# (same reasoning as SYSTEM_PROMPT_PATH). They must live inside the package,
# not at the plugin root: a non-editable install (tox sdist, PyPI) does not
# ship root-level files, which would leave the toolset empty and 503 the
# claude_agent endpoint.
AGENT_PROMPT_PATH = os.path.join(PACKAGE_DIR, 'agent_system_prompt.txt')
AGENT_TOOLS_PATH = os.path.join(PACKAGE_DIR, 'agent_tools.json')

# System prompt for the tool-suggestion endpoint. It is deliberately terse:
# the real work is describing the image (which the vision model does well) and
# mapping what it sees to the catalog of tools the frontend passes in.
SUGGEST_TOOLS_SYSTEM_PROMPT = (
    'You are an assistant embedded in NimbusImage, a scientific image '
    'annotation platform. You are shown screenshot(s) of a freshly opened '
    'microscopy dataset, usually the rendered image viewport. You are also '
    'given the list of annotation tools that are available to set up for '
    'this dataset (the "catalog"), the names of the image channels, and '
    'the displayed layer metadata. Layer metadata includes each layer color '
    'and visibility; use it to map colored signal in the rendered image back '
    'to the correct channelName.\n\n'
    'Your job is to look at the image and suggest which tools to set up '
    'so the user can get started quickly. Guidance:\n'
    '- If you see nuclei, suggest a Cellpose-SAM tool on the nuclear '
    'channel.\n'
    '- If you see roughly circular blobs / cells, suggest a blob '
    '(polygon) annotation tool.\n'
    '- If you see punctate spots (e.g. single-molecule FISH), suggest a '
    'Piscis spot-detection tool on the spot channel.\n'
    'Only suggest tools that exist in the catalog, referenced by their '
    'exact toolId. When a tool should run on a particular channel, set '
    'channelName to one of the provided channel names. Prefer a small, '
    'high-signal set of suggestions (usually 1-3) over an exhaustive '
    'list. If the image is empty or you are unsure, return an empty list.'
)

# Forced tool schema: makes Claude return a structured, validated list of
# suggestions instead of free-form prose we would have to parse.
SUGGEST_TOOLS_TOOL = {
    'name': 'suggest_tools',
    'description': (
        'Report the annotation tools to suggest for this dataset.'
    ),
    'input_schema': {
        'type': 'object',
        'properties': {
            'suggestions': {
                'type': 'array',
                'items': {
                    'type': 'object',
                    'properties': {
                        'toolId': {
                            'type': 'string',
                            'description': (
                                'The exact id of a tool from the catalog.'
                            ),
                        },
                        'channelName': {
                            'type': 'string',
                            'description': (
                                'The channel this tool should run on, '
                                'matching one of the provided channel '
                                'names. Omit if not channel-specific.'
                            ),
                        },
                        'reason': {
                            'type': 'string',
                            'description': (
                                'One short sentence on what was seen in the '
                                'image that justifies this suggestion.'
                            ),
                        },
                        'confidence': {
                            'type': 'string',
                            'enum': ['low', 'medium', 'high'],
                        },
                    },
                    'required': ['toolId', 'reason'],
                },
            },
        },
        'required': ['suggestions'],
    },
}


def _make_anthropic_client(endpoint_name):
    api_key = os.environ.get('ANTHROPIC_API_KEY')
    if api_key:
        return Anthropic(api_key=api_key)
    logger.error(
        "Can't create an Anthropic client without an API key, "
        'the %s endpoint will not work',
        endpoint_name
    )
    return None


def _list_param(data, name):
    value = data.get(name, [])
    if not isinstance(value, list):
        raise RestException(f'{name} must be a list', code=400)
    return value


class ClaudeChatResource(Resource):
    def __init__(self):
        super().__init__()
        self.resourceName = 'claude_chat'
        self.route('POST', (), self.query_claude)

        # Load system prompt
        try:
            with open(SYSTEM_PROMPT_PATH, 'r') as f:
                self.system_prompt = f.read().strip()
            logger.info('Successfully loaded system prompt')
        except IOError:
            logger.error(
                'Failed to load system prompt from %s', SYSTEM_PROMPT_PATH
            )
            self.system_prompt = ''

        self.client = _make_anthropic_client('claude_chat')

    @access.user
    @autoDescribeRoute(
        Description('Send a full chat structure to Claude and get a response')
        .jsonParam('data', 'Chat structure', paramType='body', required=True)
    )
    def query_claude(self, data):
        return self.query_claude_imp(data)

    def query_claude_imp(self, data):
        if self.client is None:
            raise RestException(
                'Claude chat is not configured (no ANTHROPIC_API_KEY)',
                code=503
            )
        messages = data.get('messages', [])
        logger.debug(f'Processing {len(messages)} messages')
        try:
            response = self.client.messages.create(
                model=CLAUDE_MODEL,
                max_tokens=8192,
                system=[
                    {
                        'type': 'text',
                        'text': self.system_prompt,
                        'cache_control': {'type': 'ephemeral'}
                    }
                ],
                messages=messages
            )
            # Sonnet 5 may include non-text content blocks before the answer.
            text = ''.join(
                block.text
                for block in response.content
                if block.type == 'text'
            )
            return {'response': text}
        except APIError as e:
            logger.error(
                f'Anthropic API error: {str(e)}', exc_info=True
            )
            return {'error': str(e)}


class ClaudeAgentResource(Resource):
    """One round trip of the AI-panel agent loop.

    The browser owns the loop (see codebaseDocumentation/AI_PANEL_SPEC.md,
    Option A): it sends the full conversation in Anthropic wire format,
    this endpoint attaches the API key, the system prompt and the
    server-held tool definitions, and returns the raw content blocks. Tool
    calls are executed by the frontend against the user's own session.
    """

    # Output-token cap per round trip. Sized so the model can finish a
    # normal answer without truncation (stop_reason 'max_tokens'); the
    # frontend surfaces a "response was cut short" notice when it is hit.
    AGENT_MAX_TOKENS = 32000
    # Backstop against runaway conversations; the frontend caps the loop
    # much earlier.
    AGENT_MAX_MESSAGES = 400

    # Abuse/cost protection (see AI_PANEL_SPEC.md §6.1 and
    # API_RATE_LIMITING_AUDIT.md); limiter semantics and the
    # single-process caveat are documented in rate_limit.py.
    RATE_LIMIT_WINDOW_SECONDS = 60
    RATE_LIMIT_MAX_REQUESTS = 30
    # Reject conversations whose JSON-serialized messages exceed this size
    # (base64 screenshots dominate; the frontend prunes old ones).
    MAX_BODY_BYTES = 25 * 1024 * 1024

    def __init__(self):
        super().__init__()
        self.resourceName = 'claude_agent'
        self.route('POST', (), self.agent_message)

        self._rate_limiter = SlidingWindowRateLimiter(
            self.RATE_LIMIT_MAX_REQUESTS, self.RATE_LIMIT_WINDOW_SECONDS
        )

        try:
            with open(AGENT_PROMPT_PATH, 'r') as f:
                self.system_prompt = f.read().strip()
            logger.info('Successfully loaded agent system prompt')
        except IOError:
            logger.error('Failed to load agent system prompt')
            self.system_prompt = ''

        try:
            with open(AGENT_TOOLS_PATH, 'r') as f:
                self.tools = json.load(f)
            logger.info('Loaded %d agent tool definitions', len(self.tools))
        except (IOError, ValueError):
            logger.error('Failed to load agent tool definitions')
            self.tools = []
        if self.tools:
            # Tools and system prompt are stable across requests; caching
            # the prefix makes each loop iteration cheap.
            self.tools[-1]['cache_control'] = {'type': 'ephemeral'}

        self.client = _make_anthropic_client('claude_agent')

    def _check_rate_limit(self, user_id):
        """Raise RestException(429) when the user exceeds the rate limit."""
        if not self._rate_limiter.check(user_id):
            raise RestException(
                'Rate limit exceeded: too many AI-panel requests. '
                'Please wait a moment and try again.',
                code=429,
            )

    @staticmethod
    def _add_message_cache_breakpoint(messages):
        """Mark the end of the conversation as a prompt-cache breakpoint.

        System prompt and tools carry the first two breakpoints; without a
        third one on the messages, every loop iteration would reprocess
        the whole conversation (including in-turn screenshots) uncached.
        Marking the last content block lets each iteration read the prefix
        written by the previous one. Mutates this request's parsed body
        only — the client's own copy of the conversation is never touched.
        (Caveat: a single turn adding more than ~20 content blocks falls
        outside the cache lookback window; rare with this tool surface.)
        """
        content = messages[-1].get('content')
        if (
            isinstance(content, list)
            and content
            and isinstance(content[-1], dict)
        ):
            content[-1]['cache_control'] = {'type': 'ephemeral'}

    @access.user
    @autoDescribeRoute(
        Description(
            'Run one round trip of the AI-panel agent loop: send the '
            'conversation in Anthropic wire format and get the raw '
            'response content blocks.'
        )
        .jsonParam(
            'data',
            'Object with a "messages" list in Anthropic wire format',
            paramType='body',
            required=True,
        )
    )
    def agent_message(self, data):
        if self.client is None or not self.tools:
            raise RestException(
                'The claude_agent endpoint is not configured', code=503
            )
        self._check_rate_limit(self.getCurrentUser()['_id'])
        messages = data.get('messages')
        if not isinstance(messages, list) or not messages:
            raise RestException('messages must be a non-empty list')
        if len(messages) > self.AGENT_MAX_MESSAGES:
            raise RestException('Conversation too long')
        body_size = len(json.dumps(messages).encode('utf-8'))
        if body_size > self.MAX_BODY_BYTES:
            raise RestException(
                'Conversation payload too large; clear the conversation '
                'and start a new one.',
                code=413,
            )
        self._add_message_cache_breakpoint(messages)
        try:
            return self._stream_agent_response(messages)
        except APIError as e:
            logger.error(f'Error in agent endpoint: {str(e)}', exc_info=True)
            return {'error': str(e)}

    def _stream_agent_response(self, messages):
        """Call the model and shape the response for the frontend.

        Uses the streaming API because AGENT_MAX_TOKENS exceeds the SDK's
        non-streaming ceiling (~21k tokens, above which client.messages.create
        raises "Streaming is required for operations that may take longer than
        10 minutes"). We still aggregate the whole message server-side and
        return it in one response, so the wire contract is unchanged: the
        browser owns the tool loop and never sees a token stream.
        """
        with self.client.messages.stream(
            model=CLAUDE_MODEL,
            max_tokens=self.AGENT_MAX_TOKENS,
            system=[
                {
                    'type': 'text',
                    'text': self.system_prompt,
                    'cache_control': {'type': 'ephemeral'},
                }
            ],
            tools=self.tools,
            messages=messages,
        ) as stream:
            response = stream.get_final_message()
        return {
            'content': [block.model_dump() for block in response.content],
            'stop_reason': response.stop_reason,
            'usage': {
                'input_tokens': response.usage.input_tokens,
                'output_tokens': response.usage.output_tokens,
            },
        }


class ClaudeSuggestToolsResource(Resource):
    """Suggest annotation tools for a freshly opened dataset.

    The frontend captures a rendered viewport screenshot, builds a catalog of
    the tools it knows how to set up, and posts display-layer context here. We
    ask Claude to look at the image and pick which tools to suggest, returning
    a structured list via a forced tool call.
    """

    def __init__(self):
        super().__init__()
        self.resourceName = 'claude_suggest_tools'
        self.route('POST', (), self.suggest_tools)

        self.client = _make_anthropic_client('claude_suggest_tools')

    @access.user
    @autoDescribeRoute(
        Description(
            'Suggest annotation tools for a dataset based on screenshots'
        )
        .jsonParam('data', 'Suggestion request', paramType='body',
                   required=True)
    )
    def suggest_tools(self, data):
        return self.suggest_tools_imp(data)

    def _build_user_content(self, data):
        if not isinstance(data, dict):
            raise RestException(
                'Request body must be a JSON object', code=400
            )
        # images: [{media_type, data}] base64 (no data-url prefix)
        # catalog: [{id, name, kind, description, defaultShape}]
        # channels: [str]
        # layers: [{id, name, channel, channelName, color, visible}]
        images = _list_param(data, 'images')
        catalog = _list_param(data, 'catalog')
        channels = _list_param(data, 'channels')
        layers = _list_param(data, 'layers')

        if len(images) > MAX_TOOL_SUGGESTION_IMAGES:
            raise RestException(
                'images contains too many screenshots', code=400
            )

        content = []
        for image in images:
            if not isinstance(image, dict):
                raise RestException('images entries must be objects', code=400)
            media_type = image.get('media_type', 'image/png')
            image_data = image.get('data')
            if not isinstance(media_type, str):
                raise RestException(
                    'image media_type must be a string', code=400
                )
            if image_data is not None and not isinstance(image_data, str):
                raise RestException('image data must be a string', code=400)
            if (
                image_data
                and len(image_data) > MAX_TOOL_SUGGESTION_IMAGE_DATA_CHARS
            ):
                raise RestException('image data is too large', code=400)
            if not image_data:
                continue
            content.append({
                'type': 'image',
                'source': {
                    'type': 'base64',
                    'media_type': media_type,
                    'data': image_data,
                },
            })

        content.append({
            'type': 'text',
            'text': (
                'Here is the catalog of tools available to set up '
                '(JSON):\n'
                f'{json.dumps(catalog)}'
                '\n\nThe image channels are (JSON):\n'
                f'{json.dumps(channels)}'
                '\n\nThe displayed layers are (JSON):\n'
                f'{json.dumps(layers)}'
                '\n\nUse the displayed layer colors and visibility to map '
                'colored objects in the screenshot(s) to channelName. Then '
                'call suggest_tools with your suggestions.'
            ),
        })
        return content

    def suggest_tools_imp(self, data):
        content = self._build_user_content(data)
        if self.client is None:
            raise RestException(
                'Claude tool suggestions are not configured '
                '(no ANTHROPIC_API_KEY)',
                code=503
            )
        try:
            response = self.client.messages.create(
                model=CLAUDE_MODEL,
                max_tokens=2048,
                # Structured extraction, not reasoning — disable thinking
                # so we can force the tool call (forced tool_choice is
                # incompatible with extended thinking).
                thinking={'type': 'disabled'},
                system=SUGGEST_TOOLS_SYSTEM_PROMPT,
                tools=[SUGGEST_TOOLS_TOOL],
                tool_choice={'type': 'tool', 'name': 'suggest_tools'},
                messages=[
                    {
                        'role': 'user',
                        'content': content,
                    }
                ],
            )
            for block in response.content:
                if block.type == 'tool_use' and block.name == 'suggest_tools':
                    return {'suggestions': block.input.get('suggestions', [])}
            return {'suggestions': []}
        except APIError as e:
            logger.error(
                f'Error in suggest_tools endpoint: {str(e)}', exc_info=True
            )
            return {'error': str(e)}


class GirderClaudeChatPlugin(plugin.GirderPlugin):
    DISPLAY_NAME = 'Claude Chat'

    def load(self, info):
        info['apiRoot'].claude_chat = ClaudeChatResource()
        info['apiRoot'].claude_agent = ClaudeAgentResource()
        info['apiRoot'].claude_suggest_tools = ClaudeSuggestToolsResource()

import json
import os
import logging
from anthropic import Anthropic, AnthropicError

from girder import plugin
from girder.api import access
from girder.api.describe import Description, autoDescribeRoute
from girder.api.rest import Resource
from girder.exceptions import RestException

from .rate_limit import SlidingWindowRateLimiter

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Single point of model configuration for the whole plugin
CLAUDE_MODEL = 'claude-sonnet-5'

# The plugin sources are copied here in the Girder image (see
# devops/girder/Dockerfile); prompt and tool definition files live next to
# the package so they can be edited without touching code.
PLUGIN_DIR = '/src/girder-claude-chat'


class ClaudeChatResource(Resource):
    def __init__(self):
        super().__init__()
        self.resourceName = 'claude_chat'
        self.route('POST', (), self.query_claude)

        # Load system prompt
        try:
            with open('/src/girder-claude-chat/system_prompt_2.txt', 'r') as f:
                self.system_prompt = f.read().strip()
            logger.info('Successfully loaded system prompt')
        except IOError:
            logger.error('Failed to load system prompt')
            self.system_prompt = ''

        # Create client
        api_key = os.environ.get('ANTHROPIC_API_KEY')
        if api_key:
            self.client = Anthropic(api_key=api_key)
        else:
            logger.error(
                "Can't create an Anthropic client without an API key,"
                'the claude_chat endpoint will not work'
            )

    @access.user
    @autoDescribeRoute(
        Description('Send a full chat structure to Claude and get a response')
        .jsonParam('data', 'Chat structure', paramType='body', required=True)
    )
    def query_claude(self, data):
        return self.query_claude_imp(data)

    def query_claude_imp(self, data):
        messages = data.get('messages', [])
        logger.debug(f'Processing {len(messages)} messages')
        try:
            response = self.client.messages.create(
                model='claude-sonnet-4-6',
                max_tokens=4096,
                system=[
                    {
                        'type': 'text',
                        'text': self.system_prompt,
                        'cache_control': {'type': 'ephemeral'}
                    }
                ],
                messages=messages
            )
            return {'response': response.content[0].text}
        except Exception as e:
            logger.error(
                f'Error in full chat endpoint: {str(e)}', exc_info=True
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

    AGENT_MAX_TOKENS = 8192
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

        prompt_path = os.path.join(PLUGIN_DIR, 'agent_system_prompt.txt')
        try:
            with open(prompt_path, 'r') as f:
                self.system_prompt = f.read().strip()
            logger.info('Successfully loaded agent system prompt')
        except IOError:
            logger.error('Failed to load agent system prompt')
            self.system_prompt = ''

        tools_path = os.path.join(PLUGIN_DIR, 'agent_tools.json')
        try:
            with open(tools_path, 'r') as f:
                self.tools = json.load(f)
            logger.info('Loaded %d agent tool definitions', len(self.tools))
        except (IOError, ValueError):
            logger.error('Failed to load agent tool definitions')
            self.tools = []
        if self.tools:
            # Tools and system prompt are stable across requests; caching
            # the prefix makes each loop iteration cheap.
            self.tools[-1]['cache_control'] = {'type': 'ephemeral'}

        api_key = os.environ.get('ANTHROPIC_API_KEY')
        if api_key:
            self.client = Anthropic(api_key=api_key)
        else:
            self.client = None
            logger.error(
                "Can't create an Anthropic client without an API key,"
                'the claude_agent endpoint will not work'
            )

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
            response = self.client.messages.create(
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
            )
        except AnthropicError as e:
            logger.error(f'Error in agent endpoint: {str(e)}', exc_info=True)
            return {'error': str(e)}
        return {
            'content': [block.model_dump() for block in response.content],
            'stop_reason': response.stop_reason,
            'usage': {
                'input_tokens': response.usage.input_tokens,
                'output_tokens': response.usage.output_tokens,
            },
        }


class GirderClaudeChatPlugin(plugin.GirderPlugin):
    DISPLAY_NAME = 'Claude Chat'

    def load(self, info):
        info['apiRoot'].claude_chat = ClaudeChatResource()
        info['apiRoot'].claude_agent = ClaudeAgentResource()

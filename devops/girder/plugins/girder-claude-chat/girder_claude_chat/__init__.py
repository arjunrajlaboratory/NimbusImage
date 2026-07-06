import os
import logging

from anthropic import Anthropic, APIError

from girder import plugin
from girder.api import access
from girder.api.describe import Description, autoDescribeRoute
from girder.api.rest import Resource, RestException

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Claude model used for all chat completions. Centralized here so that
# additional call sites in this plugin share a single source of truth.
CLAUDE_MODEL = 'claude-sonnet-4-6'

# The system prompt lives at the plugin root, one level above this package.
# Resolve it relative to this module so it also works outside the Docker
# image (local Girder, the plugin's own tox/pytest suite, etc.).
SYSTEM_PROMPT_PATH = os.path.abspath(
    os.path.join(os.path.dirname(__file__), '..', 'system_prompt_2.txt')
)


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

        # Create client
        api_key = os.environ.get('ANTHROPIC_API_KEY')
        if api_key:
            self.client = Anthropic(api_key=api_key)
        else:
            self.client = None
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
        except APIError as e:
            logger.error(
                f'Anthropic API error: {str(e)}', exc_info=True
            )
            return {'error': str(e)}


class GirderClaudeChatPlugin(plugin.GirderPlugin):
    DISPLAY_NAME = 'Claude Chat'

    def load(self, info):
        info['apiRoot'].claude_chat = ClaudeChatResource()

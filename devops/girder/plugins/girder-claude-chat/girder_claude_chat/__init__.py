import os
import json
import logging
from anthropic import Anthropic

from girder import plugin
from girder.api import access
from girder.api.describe import Description, autoDescribeRoute
from girder.api.rest import Resource

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# The model used for every Claude call in this plugin. Kept in one place so
# there is a single spot to bump when migrating to a newer Claude model.
CLAUDE_MODEL = 'claude-sonnet-5'

# System prompt for the tool-suggestion endpoint. It is deliberately terse:
# the real work is describing the image (which the vision model does well) and
# mapping what it sees to the catalog of tools the frontend passes in.
SUGGEST_TOOLS_SYSTEM_PROMPT = (
    'You are an assistant embedded in NimbusImage, a scientific image '
    'annotation platform. You are shown two screenshots of a freshly '
    'opened microscopy dataset: one of the whole application interface '
    'and one of the image itself in the viewport. You are also given the '
    'list of annotation tools that are available to set up for this '
    'dataset (the "catalog") and the names of the image channels.\n\n'
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
            # Sonnet 5 runs adaptive thinking by default, so the content
            # array may start with a thinking block — collect text blocks
            # instead of assuming content[0] is text.
            text = ''.join(
                block.text
                for block in response.content
                if block.type == 'text'
            )
            return {'response': text}
        except Exception as e:
            logger.error(
                f'Error in full chat endpoint: {str(e)}', exc_info=True
            )
            return {'error': str(e)}


class ClaudeSuggestToolsResource(Resource):
    """Suggest annotation tools for a freshly opened dataset.

    The frontend captures two screenshots (interface + viewport), builds a
    catalog of the tools it knows how to set up, and posts them here. We ask
    Claude to look at the image and pick which tools to suggest, returning a
    structured list via a forced tool call.
    """

    def __init__(self):
        super().__init__()
        self.resourceName = 'claude_suggest_tools'
        self.route('POST', (), self.suggest_tools)

        api_key = os.environ.get('ANTHROPIC_API_KEY')
        if api_key:
            self.client = Anthropic(api_key=api_key)
        else:
            self.client = None
            logger.error(
                "Can't create an Anthropic client without an API key, "
                'the claude_suggest_tools endpoint will not work'
            )

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
        # images: [{media_type, data}] base64 (no data-url prefix)
        # catalog: [{id, name, kind, description, defaultShape}]
        # channels: [str]
        images = data.get('images', [])
        catalog = data.get('catalog', [])
        channels = data.get('channels', [])

        content = []
        for image in images:
            media_type = image.get('media_type', 'image/png')
            image_data = image.get('data')
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
                '(JSON):\n' + json.dumps(catalog) +
                '\n\nThe image channels are (JSON):\n' +
                json.dumps(channels) +
                '\n\nLook at the screenshots and call suggest_tools with your '
                'suggestions.'
            ),
        })
        return content

    def suggest_tools_imp(self, data):
        if self.client is None:
            return {'error': 'Anthropic client is not configured'}
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
                        'content': self._build_user_content(data),
                    }
                ],
            )
            for block in response.content:
                if block.type == 'tool_use' and block.name == 'suggest_tools':
                    return {'suggestions': block.input.get('suggestions', [])}
            return {'suggestions': []}
        except Exception as e:
            logger.error(
                f'Error in suggest_tools endpoint: {str(e)}', exc_info=True
            )
            return {'error': str(e)}


class GirderClaudeChatPlugin(plugin.GirderPlugin):
    DISPLAY_NAME = 'Claude Chat'

    def load(self, info):
        info['apiRoot'].claude_chat = ClaudeChatResource()
        info['apiRoot'].claude_suggest_tools = ClaudeSuggestToolsResource()

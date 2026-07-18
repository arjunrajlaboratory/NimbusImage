import logging
import os

from anthropic import Anthropic

from girder.api.rest import RestException

logger = logging.getLogger(__name__)

# Claude model used for all chat completions. Centralized here so that
# every call site in this plugin shares a single source of truth.
CLAUDE_MODEL = 'claude-sonnet-5'


def make_anthropic_client(endpoint_name):
    api_key = os.environ.get('ANTHROPIC_API_KEY')
    if api_key:
        return Anthropic(api_key=api_key)
    logger.error(
        "Can't create an Anthropic client without an API key, "
        'the %s endpoint will not work',
        endpoint_name
    )
    return None


def list_param(data, name):
    value = data.get(name, [])
    if not isinstance(value, list):
        raise RestException(f'{name} must be a list', code=400)
    return value

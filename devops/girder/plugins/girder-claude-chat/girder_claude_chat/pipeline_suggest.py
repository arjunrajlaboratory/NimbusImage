import os
import json
import logging

import anthropic
from anthropic import Anthropic

from girder.api import access
from girder.api.describe import Description, autoDescribeRoute
from girder.api.rest import Resource
from girder.exceptions import RestException

logger = logging.getLogger(__name__)

CLAUDE_MODEL = 'claude-sonnet-4-6'

PIPELINE_SYSTEM_PROMPT = (
    'You suggest NimbusImage analysis pipelines: ordered sequences of '
    'Docker worker steps that run on a scientific image dataset.\n'
    'Rules:\n'
    '- Use ONLY images present in the provided annotationWorkers and '
    'propertyWorkers lists. Never invent an image.\n'
    '- Annotation-producing steps must come before the property steps '
    'that depend on their output.\n'
    '- Reuse an annotation step\'s outputTags as the inputTags of '
    'downstream property steps that operate on those annotations.\n'
    '- Prefer parameter values within each interface element\'s '
    'declared min/max; otherwise omit the parameter and let the '
    'worker default apply.\n'
    '- Return between 1 and maxSuggestions pipelines, most useful '
    'first, each with a one-line rationale.'
)

SUGGEST_PIPELINES_TOOL = {
    'name': 'suggest_pipelines',
    'description': (
        'Return suggested analysis pipelines built ONLY from the '
        'provided worker images.'
    ),
    'input_schema': {
        'type': 'object',
        'required': ['pipelines'],
        'properties': {
            'pipelines': {
                'type': 'array',
                'items': {
                    'type': 'object',
                    'required': ['name', 'rationale', 'steps'],
                    'properties': {
                        'name': {'type': 'string'},
                        'rationale': {'type': 'string'},
                        'steps': {
                            'type': 'array',
                            'items': {
                                'type': 'object',
                                'required': ['kind', 'image', 'name'],
                                'properties': {
                                    'kind': {
                                        'enum': [
                                            'annotation', 'property'
                                        ]
                                    },
                                    'image': {'type': 'string'},
                                    'name': {'type': 'string'},
                                    'outputTags': {
                                        'type': 'array',
                                        'items': {'type': 'string'}
                                    },
                                    'inputTags': {
                                        'type': 'array',
                                        'items': {'type': 'string'}
                                    },
                                    'shape': {
                                        'enum': [
                                            'point',
                                            'line',
                                            'polygon',
                                            'rectangle',
                                            'circle',
                                            'ellipse',
                                            'any'
                                        ]
                                    },
                                    'workerInterfaceValues': {
                                        'type': 'object'
                                    },
                                    'reason': {'type': 'string'}
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}


class PipelineSuggestResource(Resource):
    def __init__(self):
        super().__init__()
        self.resourceName = 'claude_pipeline'
        self.route('POST', ('suggest',), self.suggest_pipelines)

        api_key = os.environ.get('ANTHROPIC_API_KEY')
        if api_key:
            self.client = Anthropic(api_key=api_key)
        else:
            logger.error(
                "Can't create an Anthropic client without an API key, "
                'the claude_pipeline endpoint will not work'
            )
            self.client = None

    # TODO(rate-limit): this endpoint calls the paid Anthropic API on behalf
    # of any logged-in user with no per-user throttle. There is currently no
    # established rate-limiting pattern anywhere in this codebase to reuse
    # (confirmed against codebaseDocumentation/API_RATE_LIMITING_AUDIT.md,
    # which audits the whole stack and finds "no rate limiting configured
    # anywhere" - no nginx layer, no Girder plugin, no per-user throttle
    # helper) and Girder's `girder.api.access` module has no built-in
    # decorator for it either. Adding one here would mean inventing a
    # bespoke, likely fragile mechanism (e.g. an in-process counter that
    # doesn't work across multiple Girder worker processes) for this single
    # endpoint. Once a real rate-limiting layer exists (see the audit doc's
    # recommendations), apply it here first since this is the only
    # endpoint that spends real money per call.
    @access.user
    @autoDescribeRoute(
        Description(
            'Ask Claude to suggest analysis pipelines built from the '
            'available worker catalog'
        )
        .jsonParam(
            'data', 'Pipeline suggestion request', paramType='body',
            required=True
        )
    )
    def suggest_pipelines(self, data):
        return self.suggest_pipelines_imp(data)

    def suggest_pipelines_imp(self, data):
        if self.client is None:
            raise RestException(
                'The claude_pipeline endpoint is not configured with an '
                'Anthropic API key.',
                code=503
            )

        try:
            response = self.client.messages.create(
                model=CLAUDE_MODEL,
                max_tokens=4096,
                system=[
                    {
                        'type': 'text',
                        'text': PIPELINE_SYSTEM_PROMPT,
                        'cache_control': {'type': 'ephemeral'}
                    }
                ],
                tools=[SUGGEST_PIPELINES_TOOL],
                tool_choice={'type': 'tool', 'name': 'suggest_pipelines'},
                messages=[
                    {'role': 'user', 'content': json.dumps(data)}
                ]
            )
        except anthropic.APIError as e:
            logger.error(
                f'Error calling Claude for pipeline suggestions: {e}',
                exc_info=True
            )
            raise RestException(
                'Failed to get pipeline suggestions from Claude.',
                code=502
            )

        try:
            block = next(
                b for b in response.content if b.type == 'tool_use'
            )
            pipelines = block.input['pipelines']
        except (KeyError, StopIteration, json.JSONDecodeError) as e:
            logger.error(
                f'Malformed pipeline suggestion response: {e}',
                exc_info=True
            )
            raise RestException(
                'Claude returned a malformed pipeline suggestion '
                'response.',
                code=502
            )

        return {'suggestions': pipelines}

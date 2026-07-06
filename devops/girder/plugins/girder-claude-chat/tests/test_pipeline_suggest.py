import os
from unittest import mock

import pytest

from girder.exceptions import RestException
from girder_claude_chat.pipeline_suggest import PipelineSuggestResource


def _makeResource():
    os.environ['ANTHROPIC_API_KEY'] = 'FAKE_API_KEY'
    return PipelineSuggestResource()


def _makeToolUseResponse(pipelines):
    block = mock.Mock()
    block.type = 'tool_use'
    block.input = {'pipelines': pipelines}
    response = mock.Mock()
    response.content = [block]
    return response


@pytest.mark.plugin('girder_claude_chat')
def testSuggestPipelinesReturnsToolInput():
    resource = _makeResource()
    pipelines = [
        {
            'name': 'Nuclei + metrics',
            'rationale': 'Segment nuclei then measure them',
            'steps': [
                {
                    'kind': 'annotation',
                    'image': 'cellpose-sam:latest',
                    'name': 'Cellpose SAM',
                    'outputTags': ['nuclei']
                },
                {
                    'kind': 'property',
                    'image': 'blob-metrics:latest',
                    'name': 'Blob metrics',
                    'inputTags': ['nuclei'],
                    'shape': 'polygon'
                }
            ]
        }
    ]
    resource.client = mock.Mock()
    resource.client.messages.create.return_value = _makeToolUseResponse(
        pipelines
    )

    data = {
        'goal': 'count nuclei and measure their intensity',
        'context': {
            'channels': ['DAPI', 'GFP'],
            'existingTags': ['nuclei'],
            'existingShapes': ['polygon']
        },
        'annotationWorkers': [
            {
                'image': 'cellpose-sam:latest',
                'name': 'Cellpose SAM',
                'description': 'Segments nuclei',
                'annotationShape': 'polygon',
                'interface': {}
            }
        ],
        'propertyWorkers': [
            {
                'image': 'blob-metrics:latest',
                'name': 'Blob metrics',
                'description': 'Computes blob metrics',
                'interface': {}
            }
        ],
        'maxSuggestions': 3
    }

    result = resource.suggest_pipelines_imp(data)

    assert result == {'suggestions': pipelines}

    resource.client.messages.create.assert_called_once()
    _, kwargs = resource.client.messages.create.call_args
    assert kwargs['tool_choice'] == {
        'type': 'tool', 'name': 'suggest_pipelines'
    }
    assert kwargs['tools'][0]['name'] == 'suggest_pipelines'


@pytest.mark.plugin('girder_claude_chat')
def testSuggestPipelinesHandlesMalformedResponse():
    resource = _makeResource()

    block = mock.Mock()
    block.type = 'text'
    response = mock.Mock()
    response.content = [block]

    resource.client = mock.Mock()
    resource.client.messages.create.return_value = response

    with pytest.raises(RestException):
        resource.suggest_pipelines_imp({'maxSuggestions': 1})


@pytest.mark.plugin('girder_claude_chat')
def testSuggestPipelinesWithoutApiKeyRaises():
    os.environ.pop('ANTHROPIC_API_KEY', None)
    resource = PipelineSuggestResource()

    assert resource.client is None
    with pytest.raises(RestException):
        resource.suggest_pipelines_imp({'maxSuggestions': 1})

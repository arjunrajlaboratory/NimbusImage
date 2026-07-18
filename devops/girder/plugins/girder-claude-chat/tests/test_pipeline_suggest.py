from unittest import mock

import pytest

from anthropic import APIError

from girder.exceptions import RestException
from girder_claude_chat.pipeline_suggest import (
    MAX_PIPELINE_REQUEST_CHARS,
    PipelineSuggestResource,
)


def _makeResource(monkeypatch):
    monkeypatch.setenv('ANTHROPIC_API_KEY', 'FAKE_API_KEY')
    return PipelineSuggestResource()


def _makeToolUseResponse(pipelines):
    block = mock.Mock()
    block.type = 'tool_use'
    block.input = {'pipelines': pipelines}
    response = mock.Mock()
    response.content = [block]
    return response


@pytest.mark.plugin('girder_claude_chat')
def testSuggestPipelinesReturnsToolInput(monkeypatch):
    resource = _makeResource(monkeypatch)
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
def testSuggestPipelinesHandlesMalformedResponse(monkeypatch):
    resource = _makeResource(monkeypatch)

    block = mock.Mock()
    block.type = 'text'
    response = mock.Mock()
    response.content = [block]

    resource.client = mock.Mock()
    resource.client.messages.create.return_value = response

    with pytest.raises(RestException) as exc:
        resource.suggest_pipelines_imp({'maxSuggestions': 1})
    assert exc.value.code == 502


@pytest.mark.plugin('girder_claude_chat')
def testSuggestPipelinesHandlesMissingPipelinesKey(monkeypatch):
    resource = _makeResource(monkeypatch)

    block = mock.Mock()
    block.type = 'tool_use'
    block.input = {}
    response = mock.Mock()
    response.content = [block]

    resource.client = mock.Mock()
    resource.client.messages.create.return_value = response

    with pytest.raises(RestException) as exc:
        resource.suggest_pipelines_imp({'maxSuggestions': 1})
    assert exc.value.code == 502


@pytest.mark.plugin('girder_claude_chat')
def testSuggestPipelinesHandlesApiError(monkeypatch):
    resource = _makeResource(monkeypatch)

    resource.client = mock.Mock()
    resource.client.messages.create.side_effect = APIError(
        message='boom',
        request=mock.Mock(),
        body=None,
    )

    with pytest.raises(RestException) as exc:
        resource.suggest_pipelines_imp({'maxSuggestions': 1})
    assert exc.value.code == 502


@pytest.mark.plugin('girder_claude_chat')
def testSuggestPipelinesRejectsOversizedRequest(monkeypatch):
    resource = _makeResource(monkeypatch)
    resource.client = mock.Mock()

    data = {'goal': 'x' * (MAX_PIPELINE_REQUEST_CHARS + 1)}
    with pytest.raises(RestException) as exc:
        resource.suggest_pipelines_imp(data)
    assert exc.value.code == 400
    resource.client.messages.create.assert_not_called()


@pytest.mark.plugin('girder_claude_chat')
def testSuggestPipelinesWithoutApiKeyRaises(monkeypatch):
    monkeypatch.delenv('ANTHROPIC_API_KEY', raising=False)
    resource = PipelineSuggestResource()

    assert resource.client is None
    with pytest.raises(RestException) as exc:
        resource.suggest_pipelines_imp({'maxSuggestions': 1})
    assert exc.value.code == 503

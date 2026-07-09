import pytest
import os
from types import SimpleNamespace

from girder.api.rest import RestException

from girder_claude_chat import (
    ClaudeChatResource, ClaudeSuggestToolsResource, CLAUDE_MODEL
)


@pytest.mark.plugin('girder_claude_chat')
def testClaudeChatImplementation():
    os.environ['ANTHROPIC_API_KEY'] = 'FAKE_API_KEY'
    resource = ClaudeChatResource()
    # Of course the API errors, we have a fake API key
    assert 'error' in resource.query_claude_imp({'messages': ['Hi Claude !']})


@pytest.mark.plugin('girder_claude_chat')
def testClaudeChatMissingApiKey(monkeypatch):
    monkeypatch.delenv('ANTHROPIC_API_KEY', raising=False)
    resource = ClaudeChatResource()
    # Without an API key the client is never created, so the endpoint
    # should raise a clear 503 rather than an AttributeError.
    with pytest.raises(RestException) as excinfo:
        resource.query_claude_imp({'messages': ['Hi Claude !']})
    assert excinfo.value.code == 503


@pytest.mark.plugin('girder_claude_chat')
def testClaudeChatUsesSonnet5AndCollectsTextBlocks(monkeypatch):
    monkeypatch.setenv('ANTHROPIC_API_KEY', 'FAKE_API_KEY')
    resource = ClaudeChatResource()

    class FakeMessages:
        create_kwargs = None

        def create(self, **kwargs):
            self.create_kwargs = kwargs
            return SimpleNamespace(content=[
                SimpleNamespace(type='thinking'),
                SimpleNamespace(type='text', text='Hello'),
                SimpleNamespace(type='text', text=' world'),
            ])

    fake_messages = FakeMessages()
    resource.client = SimpleNamespace(messages=fake_messages)

    result = resource.query_claude_imp({'messages': ['Hi Claude !']})

    assert result == {'response': 'Hello world'}
    assert fake_messages.create_kwargs['model'] == CLAUDE_MODEL
    assert fake_messages.create_kwargs['model'] == 'claude-sonnet-5'
    assert fake_messages.create_kwargs['max_tokens'] == 8192


@pytest.mark.plugin('girder_claude_chat')
def testSuggestToolsIncludesLayerContext(monkeypatch):
    monkeypatch.setenv('ANTHROPIC_API_KEY', 'FAKE_API_KEY')
    resource = ClaudeSuggestToolsResource()

    content = resource._build_user_content({
        'images': [],
        'catalog': [{'id': 'manual:blob', 'name': 'Blob'}],
        'channels': ['DAPI', 'TRITC'],
        'layers': [
            {
                'id': 'layer-0',
                'name': 'TRITC',
                'channel': 1,
                'channelName': 'TRITC',
                'color': '#FFFF00',
                'visible': True,
            },
        ],
    })

    text = content[-1]['text']
    assert 'The displayed layers are (JSON)' in text
    assert '"channelName": "TRITC"' in text
    assert '"color": "#FFFF00"' in text
    assert 'map colored objects' in text


@pytest.mark.plugin('girder_claude_chat')
@pytest.mark.parametrize(
    ('payload', 'message'),
    [
        (None, 'Request body must be a JSON object'),
        ({'images': 'not-a-list'}, 'images must be a list'),
        ({'images': ['not-an-object']}, 'images entries must be objects'),
        (
            {'images': [{'data': 'AAAA'}, {'data': 'BBBB'}, {'data': 'CCCC'}]},
            'images contains too many screenshots',
        ),
        ({'catalog': {}}, 'catalog must be a list'),
        ({'channels': {}}, 'channels must be a list'),
        ({'layers': {}}, 'layers must be a list'),
    ],
)
def testSuggestToolsRejectsMalformedRequests(monkeypatch, payload, message):
    monkeypatch.setenv('ANTHROPIC_API_KEY', 'FAKE_API_KEY')
    resource = ClaudeSuggestToolsResource()

    with pytest.raises(RestException) as excinfo:
        resource.suggest_tools_imp(payload)

    assert excinfo.value.code == 400
    assert message in str(excinfo.value)

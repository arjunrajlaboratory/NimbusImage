import pytest
import os
from types import SimpleNamespace

from girder.api.rest import RestException

from girder_claude_chat import (
    ClaudeAgentResource, ClaudeChatResource, ClaudeSuggestToolsResource,
    CLAUDE_MODEL
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
def testAgentEndpointLoadsPackagedAssets(monkeypatch):
    # The agent system prompt and tool schema must ship INSIDE the installed
    # package (loaded from PACKAGE_DIR), not the plugin source root. A
    # non-editable install (like this tox distribution) otherwise gets an
    # empty toolset and the endpoint 503s. Regression guard: this runs against
    # the installed distribution, so it fails if the assets are not packaged.
    monkeypatch.setenv('ANTHROPIC_API_KEY', 'FAKE_API_KEY')
    resource = ClaudeAgentResource()
    assert resource.system_prompt, 'agent system prompt not packaged'
    assert len(resource.tools) > 0, 'agent tool definitions not packaged'


@pytest.mark.plugin('girder_claude_chat')
def testAgentEndpointStreamsAndShapesResponse(monkeypatch):
    # AGENT_MAX_TOKENS is above the SDK's non-streaming ceiling (~21k), so the
    # agent endpoint must use the streaming API (client.messages.stream) or the
    # SDK raises "Streaming is required...". It still aggregates server-side and
    # returns one JSON response with the same shape as before.
    monkeypatch.setenv('ANTHROPIC_API_KEY', 'FAKE_API_KEY')
    resource = ClaudeAgentResource()

    final_message = SimpleNamespace(
        content=[
            SimpleNamespace(
                model_dump=lambda exclude=None: {'type': 'text', 'text': 'ok'},
            ),
        ],
        stop_reason='end_turn',
        usage=SimpleNamespace(input_tokens=11, output_tokens=7),
    )

    class FakeStream:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def get_final_message(self):
            return final_message

    class FakeMessages:
        stream_kwargs = None

        def stream(self, **kwargs):
            self.stream_kwargs = kwargs
            return FakeStream()

        def create(self, **kwargs):
            raise AssertionError(
                'agent endpoint must stream, not call create (max_tokens '
                'exceeds the non-streaming ceiling)'
            )

    fake_messages = FakeMessages()
    resource.client = SimpleNamespace(messages=fake_messages)

    result = resource._stream_agent_response(
        [{'role': 'user', 'content': 'hi'}]
    )

    assert result == {
        'content': [{'type': 'text', 'text': 'ok'}],
        'stop_reason': 'end_turn',
        'usage': {'input_tokens': 11, 'output_tokens': 7},
    }
    assert fake_messages.stream_kwargs['model'] == CLAUDE_MODEL
    assert fake_messages.stream_kwargs['max_tokens'] == resource.AGENT_MAX_TOKENS
    # The bump the whole change is about; also keeps us above the non-streaming
    # ceiling so streaming stays mandatory.
    assert resource.AGENT_MAX_TOKENS > 21333


@pytest.mark.plugin('girder_claude_chat')
def testAgentEndpointStripsApiExcludedBlockFields(monkeypatch):
    # The streaming API returns ParsedTextBlocks carrying an output-only
    # `parsed_output` field (marked __api_exclude__). Those content blocks are
    # echoed straight back as the assistant turn on the next request, so they
    # must be serialized without parsed_output or the API rejects the request
    # with "Extra inputs are not permitted".
    monkeypatch.setenv('ANTHROPIC_API_KEY', 'FAKE_API_KEY')
    resource = ClaudeAgentResource()

    class FakeParsedTextBlock:
        __api_exclude__ = {'parsed_output'}

        def model_dump(self, exclude=None):
            data = {
                'type': 'text',
                'text': 'ok',
                'parsed_output': {'anything': 1},
            }
            for key in exclude or set():
                data.pop(key, None)
            return data

    final_message = SimpleNamespace(
        content=[FakeParsedTextBlock()],
        stop_reason='end_turn',
        usage=SimpleNamespace(input_tokens=1, output_tokens=1),
    )

    class FakeStream:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def get_final_message(self):
            return final_message

    class FakeMessages:
        def stream(self, **kwargs):
            return FakeStream()

    resource.client = SimpleNamespace(messages=FakeMessages())

    result = resource._stream_agent_response([{'role': 'user', 'content': 'x'}])
    assert result['content'] == [{'type': 'text', 'text': 'ok'}]
    assert 'parsed_output' not in result['content'][0]


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

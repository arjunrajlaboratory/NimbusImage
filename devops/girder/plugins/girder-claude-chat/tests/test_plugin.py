import pytest
import os
from types import SimpleNamespace

from girder.api.rest import RestException

from girder_claude_chat import ClaudeChatResource, CLAUDE_MODEL


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

import pytest
import os

from girder.api.rest import RestException

from girder_claude_chat import ClaudeChatResource


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

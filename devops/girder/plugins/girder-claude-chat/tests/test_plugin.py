import pytest
import os

from girder_claude_chat import ClaudeChatResource


@pytest.mark.plugin('girder_claude_chat')
def testClaudeChatImplementation():
    os.environ['ANTHROPIC_API_KEY'] = 'FAKE_API_KEY'
    resource = ClaudeChatResource()
    # Of course the API errors, we have a fake API key
    assert 'error' in resource.query_claude_imp({'messages': ['Hi Claude !']})

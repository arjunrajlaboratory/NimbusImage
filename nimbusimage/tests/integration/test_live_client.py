"""Integration tests for NimbusClient."""

import pytest

pytestmark = pytest.mark.integration


class TestLiveClient:
    def test_connect_and_get_user(self, client):
        assert client.user_id is not None
        assert len(client.user_id) > 0

    def test_list_projects(self, client):
        projects = client.list_projects()
        assert isinstance(projects, list)

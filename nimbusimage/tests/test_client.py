"""Tests for NimbusClient."""

import os
from unittest.mock import MagicMock, patch

import pytest

from nimbusimage.client import NimbusClient


class TestNimbusClientInit:
    def test_connect_with_token(self):
        with patch("nimbusimage._girder.girder_client.GirderClient") as MockGC:
            mock_gc = MagicMock()
            MockGC.return_value = mock_gc
            mock_gc.get.return_value = {"_id": "user123", "login": "admin"}

            client = NimbusClient(
                api_url="http://localhost:8080/api/v1", token="tok123"
            )
            assert client.api_url == "http://localhost:8080/api/v1"
            mock_gc.setToken.assert_called_with("tok123")

    def test_connect_with_username_password(self):
        with patch("nimbusimage._girder.girder_client.GirderClient") as MockGC:
            mock_gc = MagicMock()
            MockGC.return_value = mock_gc
            mock_gc.get.return_value = {"_id": "user123", "login": "admin"}

            client = NimbusClient(
                api_url="http://localhost:8080/api/v1",
                username="admin",
                password="password",
            )
            mock_gc.authenticate.assert_called_with(
                username="admin", password="password"
            )

    def test_connect_with_env_vars(self):
        with patch("nimbusimage._girder.girder_client.GirderClient") as MockGC:
            mock_gc = MagicMock()
            MockGC.return_value = mock_gc
            mock_gc.get.return_value = {"_id": "user123", "login": "admin"}

            with patch.dict(os.environ, {
                "NI_API_URL": "http://env:8080/api/v1",
                "NI_TOKEN": "envtoken",
            }):
                client = NimbusClient()
                assert client.api_url == "http://env:8080/api/v1"
                mock_gc.setToken.assert_called_with("envtoken")

    def test_connect_no_credentials_raises(self):
        with patch.dict(os.environ, {}, clear=True):
            with pytest.raises(ValueError, match="api_url must be provided"):
                NimbusClient()


class TestNimbusClientProperties:
    def test_girder_escape_hatch(self, mock_gc):
        client = NimbusClient.__new__(NimbusClient)
        client._gc = mock_gc
        client._api_url = "http://localhost:8080/api/v1"
        client._frontend_url = "http://localhost:5173"
        assert client.girder is mock_gc

    def test_token_property(self, mock_gc):
        client = NimbusClient.__new__(NimbusClient)
        client._gc = mock_gc
        client._api_url = "http://localhost:8080/api/v1"
        client._frontend_url = "http://localhost:5173"
        assert client.token == "test-token-abc123"


class TestNimbusClientDataset:
    def test_dataset_by_id(self, mock_gc):
        client = NimbusClient.__new__(NimbusClient)
        client._gc = mock_gc
        client._api_url = "http://localhost:8080/api/v1"
        client._frontend_url = "http://localhost:5173"

        ds = client.dataset("folder_123")
        assert ds.id == "folder_123"

    def test_dataset_by_name(self, mock_gc):
        mock_gc.get.return_value = [
            {"_id": "folder_123", "name": "My Dataset", "meta": {}},
        ]
        client = NimbusClient.__new__(NimbusClient)
        client._gc = mock_gc
        client._api_url = "http://localhost:8080/api/v1"
        client._frontend_url = "http://localhost:5173"

        ds = client.dataset(name="My Dataset")
        assert ds.id == "folder_123"

    def test_dataset_by_name_not_found(self, mock_gc):
        mock_gc.get.return_value = []
        client = NimbusClient.__new__(NimbusClient)
        client._gc = mock_gc
        client._api_url = "http://localhost:8080/api/v1"
        client._frontend_url = "http://localhost:5173"

        with pytest.raises(ValueError, match="not found"):
            client.dataset(name="Nonexistent")


class TestNimbusClientListDatasets:
    def test_list_datasets(self, mock_gc):
        # list_datasets now uses dataset_view to discover datasets
        mock_gc.get.side_effect = [
            # GET /dataset_view
            [
                {"_id": "v1", "datasetId": "f1", "configurationId": "c1"},
                {"_id": "v2", "datasetId": "f2", "configurationId": "c2"},
            ],
            # GET folder/f1
            {"_id": "f1", "name": "Dataset A", "meta": {"subtype": "contrastDataset"}},
            # GET folder/f2
            {"_id": "f2", "name": "Dataset B", "meta": {"subtype": "contrastDataset"}},
        ]
        client = NimbusClient.__new__(NimbusClient)
        client._gc = mock_gc
        client._api_url = "http://localhost:8080/api/v1"
        client._frontend_url = "http://localhost:5173"

        datasets = client.list_datasets()
        assert len(datasets) == 2
        assert datasets[0]["name"] == "Dataset A"

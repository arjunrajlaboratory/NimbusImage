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

            NimbusClient(
                api_url="http://localhost:8080/api/v1",
                token="tok123",
            )
            mock_gc.setToken.assert_called_with("tok123")

    def test_connect_with_username_password(self):
        with patch("nimbusimage._girder.girder_client.GirderClient") as MockGC:
            mock_gc = MagicMock()
            MockGC.return_value = mock_gc
            mock_gc.get.return_value = {"_id": "user123", "login": "admin"}

            NimbusClient(
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

    def test_connect_anonymous(self):
        with patch("nimbusimage._girder.girder_client.GirderClient") as MockGC:
            mock_gc = MagicMock()
            MockGC.return_value = mock_gc

            NimbusClient(
                api_url="http://localhost:8080/api/v1",
                anonymous=True,
            )
            mock_gc.authenticate.assert_not_called()
            mock_gc.setToken.assert_not_called()

    def test_connect_anonymous_ignores_env_credentials(self):
        """anonymous=True must not silently authenticate from env vars."""
        with patch("nimbusimage._girder.girder_client.GirderClient") as MockGC:
            mock_gc = MagicMock()
            MockGC.return_value = mock_gc

            with patch.dict(os.environ, {
                "NI_API_URL": "http://env:8080/api/v1",
                "NI_API_KEY": "envkey",
            }):
                NimbusClient(anonymous=True)
            mock_gc.authenticate.assert_not_called()
            mock_gc.setToken.assert_not_called()

    def test_connect_anonymous_with_credentials_raises(self):
        with patch("nimbusimage._girder.girder_client.GirderClient"):
            with pytest.raises(ValueError, match="anonymous"):
                NimbusClient(
                    api_url="http://localhost:8080/api/v1",
                    anonymous=True,
                    token="tok123",
                )


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


class TestNimbusClientCreateDataset:
    def _client(self, mock_gc):
        client = NimbusClient.__new__(NimbusClient)
        client._gc = mock_gc
        client._api_url = "http://localhost:8080/api/v1"
        client._frontend_url = "http://localhost:5173"
        return client

    def test_create_dataset_uses_createFolder(self, mock_gc):
        """girder_client's createFolder (which JSON-encodes metadata itself)
        is used rather than a hand-rolled POST."""
        mock_gc.createFolder.return_value = {"_id": "newfolder"}
        client = self._client(mock_gc)

        ds = client.create_dataset(
            "My Experiment", description="desc", parent_folder_id="parent1"
        )
        assert ds.id == "newfolder"
        mock_gc.createFolder.assert_called_once_with(
            "parent1",
            "My Experiment",
            description="desc",
            metadata={
                "subtype": "contrastDataset",
                "selectedLargeImageId": None,
            },
        )

    def test_create_dataset_defaults_to_private_folder(self, mock_gc):
        """The Private folder is found with listFolder(name=...), not by
        fetching every top-level folder and scanning client-side."""
        mock_gc.get.return_value = {"_id": "user123", "login": "admin"}
        mock_gc.listFolder.return_value = iter(
            [{"_id": "privfolder", "name": "Private"}]
        )
        mock_gc.createFolder.return_value = {"_id": "newfolder"}
        client = self._client(mock_gc)

        client.create_dataset("My Experiment")
        mock_gc.listFolder.assert_called_once_with(
            "user123", parentFolderType="user", name="Private"
        )
        assert mock_gc.createFolder.call_args[0][0] == "privfolder"

    def test_create_dataset_no_private_folder_raises(self, mock_gc):
        mock_gc.get.return_value = {"_id": "user123", "login": "admin"}
        mock_gc.listFolder.return_value = iter([])
        client = self._client(mock_gc)

        with pytest.raises(ValueError, match="No Private folder"):
            client.create_dataset("My Experiment")


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
            {
                "_id": "f1", "name": "Dataset A",
                "meta": {"subtype": "contrastDataset"},
            },
            # GET folder/f2
            {
                "_id": "f2", "name": "Dataset B",
                "meta": {"subtype": "contrastDataset"},
            },
        ]
        client = NimbusClient.__new__(NimbusClient)
        client._gc = mock_gc
        client._api_url = "http://localhost:8080/api/v1"
        client._frontend_url = "http://localhost:5173"

        datasets = client.list_datasets()
        assert len(datasets) == 2
        assert datasets[0]["name"] == "Dataset A"

    def test_list_datasets_skips_only_http_errors(self, mock_gc):
        """A view whose folder 403s (shared view, private folder) is skipped;
        anything else must propagate, not be silently swallowed."""
        import girder_client

        mock_gc.get.side_effect = [
            [
                {"_id": "v1", "datasetId": "f1"},
                {"_id": "v2", "datasetId": "f2"},
            ],
            girder_client.HttpError(403, "denied", "url", "GET"),
            {"_id": "f2", "name": "Dataset B", "meta": {}},
        ]
        client = NimbusClient.__new__(NimbusClient)
        client._gc = mock_gc
        client._api_url = "http://localhost:8080/api/v1"
        client._frontend_url = "http://localhost:5173"

        datasets = client.list_datasets()
        assert [d["name"] for d in datasets] == ["Dataset B"]

    def test_list_datasets_propagates_unexpected_errors(self, mock_gc):
        mock_gc.get.side_effect = [
            [{"_id": "v1", "datasetId": "f1"}],
            RuntimeError("boom"),
        ]
        client = NimbusClient.__new__(NimbusClient)
        client._gc = mock_gc
        client._api_url = "http://localhost:8080/api/v1"
        client._frontend_url = "http://localhost:5173"

        with pytest.raises(RuntimeError, match="boom"):
            client.list_datasets()

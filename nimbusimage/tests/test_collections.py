"""Tests for Collection class and collection-related methods."""

from unittest.mock import MagicMock, patch

import pytest

from nimbusimage.collections import Collection
from nimbusimage.config import ConfigAccessor


@pytest.fixture
def sample_collection_data():
    return {
        "_id": "coll_001",
        "name": "My Dataset collection",
        "folderId": "folder_001",
        "meta": {
            "layers": [
                {"channel": 0, "color": "#FF0000", "visible": True,
                 "contrast": {"blackPoint": 0, "whitePoint": 100, "mode": "percentile"}},
                {"channel": 1, "color": "#00FF00", "visible": False,
                 "contrast": {"blackPoint": 5, "whitePoint": 95, "mode": "percentile"}},
            ],
            "tools": [
                {"name": "Spot tool", "type": "annotation"},
            ],
            "propertyIds": ["prop_001", "prop_002"],
            "snapshots": [{"name": "snapshot1"}],
            "scales": {"pixelSize": {"unit": "mm", "value": 0.000219}},
            "subtype": "contrastConfiguration",
        },
    }


class TestCollectionProperties:
    def test_id(self, mock_gc, sample_collection_data):
        coll = Collection(mock_gc, sample_collection_data)
        assert coll.id == "coll_001"

    def test_name(self, mock_gc, sample_collection_data):
        coll = Collection(mock_gc, sample_collection_data)
        assert coll.name == "My Dataset collection"

    def test_folder_id(self, mock_gc, sample_collection_data):
        coll = Collection(mock_gc, sample_collection_data)
        assert coll.folder_id == "folder_001"

    def test_layers(self, mock_gc, sample_collection_data):
        coll = Collection(mock_gc, sample_collection_data)
        layers = coll.layers
        assert len(layers) == 2
        assert layers[0]["color"] == "#FF0000"
        assert layers[1]["visible"] is False

    def test_tools(self, mock_gc, sample_collection_data):
        coll = Collection(mock_gc, sample_collection_data)
        assert len(coll.tools) == 1
        assert coll.tools[0]["name"] == "Spot tool"

    def test_property_ids(self, mock_gc, sample_collection_data):
        coll = Collection(mock_gc, sample_collection_data)
        assert coll.property_ids == ["prop_001", "prop_002"]

    def test_snapshots(self, mock_gc, sample_collection_data):
        coll = Collection(mock_gc, sample_collection_data)
        assert len(coll.snapshots) == 1

    def test_scales(self, mock_gc, sample_collection_data):
        coll = Collection(mock_gc, sample_collection_data)
        assert coll.scales["pixelSize"]["value"] == 0.000219

    def test_url(self, mock_gc, sample_collection_data):
        coll = Collection(mock_gc, sample_collection_data,
                          frontend_url="http://localhost:5173")
        assert coll.url() == "http://localhost:5173/#/configuration/coll_001"

    def test_open(self, mock_gc, sample_collection_data):
        coll = Collection(mock_gc, sample_collection_data,
                          frontend_url="http://localhost:5173")
        with patch("nimbusimage.urls.webbrowser.open") as mock_open:
            url = coll.open()
            mock_open.assert_called_once_with(url)


class TestClientCollections:
    def test_list_collections(self, mock_gc, sample_collection_data):
        # Mock user/me and folder lookup
        mock_gc.get.side_effect = [
            {"_id": "user_001"},  # user/me
            [{"_id": "private_folder"}],  # folder listing
            [sample_collection_data],  # upenn_collection listing
        ]

        from nimbusimage.client import NimbusClient
        client = NimbusClient.__new__(NimbusClient)
        client._gc = mock_gc
        client._api_url = "http://localhost:8080/api/v1"
        client._frontend_url = "http://localhost:5173"

        colls = client.list_collections()
        assert len(colls) == 1
        assert isinstance(colls[0], Collection)
        assert colls[0].name == "My Dataset collection"

    def test_list_collections_with_folder_id(self, mock_gc, sample_collection_data):
        mock_gc.get.return_value = [sample_collection_data]

        from nimbusimage.client import NimbusClient
        client = NimbusClient.__new__(NimbusClient)
        client._gc = mock_gc
        client._api_url = "http://localhost:8080/api/v1"
        client._frontend_url = "http://localhost:5173"

        colls = client.list_collections(folder_id="explicit_folder")
        assert len(colls) == 1
        call_url = mock_gc.get.call_args[0][0]
        assert "folderId=explicit_folder" in call_url

    def test_collection_by_id(self, mock_gc, sample_collection_data):
        mock_gc.get.return_value = sample_collection_data

        from nimbusimage.client import NimbusClient
        client = NimbusClient.__new__(NimbusClient)
        client._gc = mock_gc
        client._api_url = "http://localhost:8080/api/v1"
        client._frontend_url = "http://localhost:5173"

        coll = client.collection("coll_001")
        assert coll.id == "coll_001"
        mock_gc.get.assert_called_with("/upenn_collection/coll_001")


class TestConfigAccessorCollections:
    def test_get_collection(self, mock_gc, sample_collection_data):
        mock_gc.get.side_effect = [
            [{"_id": "view_001", "configurationId": "coll_001"}],
            sample_collection_data,
        ]
        accessor = ConfigAccessor(mock_gc, "ds_001")

        coll = accessor.get_collection()
        assert isinstance(coll, Collection)
        assert coll.id == "coll_001"
        assert len(coll.layers) == 2

    def test_get_collection_none_when_no_views(self, mock_gc):
        mock_gc.get.return_value = []
        accessor = ConfigAccessor(mock_gc, "ds_001")

        assert accessor.get_collection() is None

    def test_list_collections(self, mock_gc, sample_collection_data):
        mock_gc.get.side_effect = [
            [
                {"_id": "v1", "configurationId": "coll_001"},
                {"_id": "v2", "configurationId": "coll_002"},
            ],
            sample_collection_data,
            {**sample_collection_data, "_id": "coll_002", "name": "Second"},
        ]
        accessor = ConfigAccessor(mock_gc, "ds_001")

        colls = accessor.list_collections()
        assert len(colls) == 2
        assert colls[0].id == "coll_001"
        assert colls[1].id == "coll_002"

    def test_list_collections_deduplicates(self, mock_gc, sample_collection_data):
        """Two views pointing to the same collection should not duplicate."""
        mock_gc.get.side_effect = [
            [
                {"_id": "v1", "configurationId": "coll_001"},
                {"_id": "v2", "configurationId": "coll_001"},  # same
            ],
            sample_collection_data,
        ]
        accessor = ConfigAccessor(mock_gc, "ds_001")

        colls = accessor.list_collections()
        assert len(colls) == 1

    def test_layers_still_works_for_composite(self, mock_gc, sample_collection_data):
        """Verify ds.config.layers still returns layer dicts (used by get_composite)."""
        mock_gc.get.side_effect = [
            [{"_id": "v1", "configurationId": "coll_001"}],
            sample_collection_data,
        ]
        accessor = ConfigAccessor(mock_gc, "ds_001")

        layers = accessor.layers
        assert len(layers) == 2
        assert layers[0]["channel"] == 0
        assert layers[0]["color"] == "#FF0000"
        assert layers[0]["contrast"]["mode"] == "percentile"

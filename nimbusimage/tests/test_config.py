"""Tests for ConfigAccessor."""

import pytest
from nimbusimage.config import ConfigAccessor


class TestConfigAccessor:
    def test_list_views(self, mock_gc):
        mock_gc.get.return_value = [{"_id": "v1", "configurationId": "c1"}]
        accessor = ConfigAccessor(mock_gc, "ds_001")
        result = accessor.list_views()
        assert len(result) == 1

    def test_get_configuration(self, mock_gc):
        mock_gc.get.side_effect = [
            [{"_id": "v1", "configurationId": "c1"}],  # views
            {"_id": "c1", "meta": {"layers": [{"channel": 0}]}},  # collection
        ]
        accessor = ConfigAccessor(mock_gc, "ds_001")
        result = accessor.get_configuration()
        assert result["_id"] == "c1"
        # Verify it uses /upenn_collection, not /item
        calls = [str(c) for c in mock_gc.get.call_args_list]
        assert any("/upenn_collection/c1" in c for c in calls)
        assert not any("/item/c1" in c for c in calls)

    def test_layers_property(self, mock_gc):
        mock_gc.get.side_effect = [
            [{"_id": "v1", "configurationId": "c1"}],
            {"_id": "c1", "meta": {
                "layers": [{"channel": 0, "visible": True}]
            }},
        ]
        accessor = ConfigAccessor(mock_gc, "ds_001")
        layers = accessor.layers
        assert len(layers) == 1
        assert layers[0]["channel"] == 0

    def test_property_ids(self, mock_gc):
        mock_gc.get.side_effect = [
            [{"_id": "v1", "configurationId": "c1"}],
            {"_id": "c1", "meta": {"propertyIds": ["p1", "p2"]}},
        ]
        accessor = ConfigAccessor(mock_gc, "ds_001")
        assert accessor.property_ids == ["p1", "p2"]

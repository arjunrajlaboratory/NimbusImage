"""Tests for PropertyAccessor."""

import pytest

from nimbusimage.properties import PropertyAccessor
from nimbusimage.models import Property


def route_gets(mock_gc, routes):
    """Configure mock_gc.get to answer by URL prefix.

    Properties are only visible through the configurations that
    reference them, so create() must hit dataset_view and
    upenn_collection in addition to annotation_property.
    """
    def get(url, *args, **kwargs):
        for prefix, value in routes.items():
            if url.startswith(prefix):
                return value
        raise AssertionError(f"unexpected GET {url}")
    mock_gc.get.side_effect = get


class TestPropertyDefinitions:
    def test_list(self, mock_gc, sample_property_dict):
        mock_gc.get.return_value = [sample_property_dict]
        accessor = PropertyAccessor(mock_gc, "ds_001")

        result = accessor.list()
        assert len(result) == 1
        assert isinstance(result[0], Property)
        assert result[0].name == "Blob Intensity"

    def test_get(self, mock_gc, sample_property_dict):
        mock_gc.get.return_value = sample_property_dict
        accessor = PropertyAccessor(mock_gc, "ds_001")

        result = accessor.get("prop_001")
        assert result.id == "prop_001"

    def test_create(self, mock_gc, sample_property_dict):
        mock_gc.post.return_value = sample_property_dict
        route_gets(mock_gc, {
            "dataset_view": [{"configurationId": "cfg_1"}],
            "upenn_collection/cfg_1": {"meta": {"propertyIds": []}},
        })
        accessor = PropertyAccessor(mock_gc, "ds_001")

        result = accessor.create(
            name="Blob Intensity", shape="polygon",
        )
        assert isinstance(result, Property)

    def test_create_registers_in_dataset_collections(
        self, mock_gc, sample_property_dict
    ):
        # An unregistered property is invisible to every user (the
        # backend gates list/get on configuration membership), so
        # create() must register the new property into the dataset's
        # collections.
        mock_gc.post.return_value = sample_property_dict
        route_gets(mock_gc, {
            "dataset_view": [{"configurationId": "cfg_1"}],
            "upenn_collection/cfg_1": {"meta": {"propertyIds": []}},
        })
        accessor = PropertyAccessor(mock_gc, "ds_001")

        accessor.create(name="Blob Intensity", shape="polygon")
        mock_gc.put.assert_called_once_with(
            "upenn_collection/cfg_1/metadata",
            json={"propertyIds": ["prop_001"]},
        )

    def test_create_warns_when_dataset_has_no_collections(
        self, mock_gc, sample_property_dict
    ):
        mock_gc.post.return_value = sample_property_dict
        route_gets(mock_gc, {"dataset_view": []})
        accessor = PropertyAccessor(mock_gc, "ds_001")

        with pytest.warns(UserWarning, match="not .* visible"):
            result = accessor.create(name="Blob Intensity")
        assert isinstance(result, Property)
        mock_gc.put.assert_not_called()

    def test_register_returns_collection_count(self, mock_gc):
        route_gets(mock_gc, {
            "dataset_view": [
                {"configurationId": "cfg_1"},
                {"configurationId": "cfg_2"},
                {"configurationId": "cfg_1"},  # duplicate view
            ],
            "upenn_collection/cfg_1": {"meta": {"propertyIds": []}},
            "upenn_collection/cfg_2": {
                "meta": {"propertyIds": ["prop_001"]}
            },
        })
        accessor = PropertyAccessor(mock_gc, "ds_001")

        assert accessor.register("prop_001") == 2
        # cfg_2 already has the property; only cfg_1 is updated
        mock_gc.put.assert_called_once_with(
            "upenn_collection/cfg_1/metadata",
            json={"propertyIds": ["prop_001"]},
        )

    def test_get_or_create_existing(self, mock_gc, sample_property_dict):
        mock_gc.get.return_value = [sample_property_dict]
        accessor = PropertyAccessor(mock_gc, "ds_001")

        result = accessor.get_or_create(
            name="Blob Intensity", shape="polygon"
        )
        assert result.id == "prop_001"
        mock_gc.post.assert_not_called()

    def test_get_or_create_new(self, mock_gc, sample_property_dict):
        mock_gc.post.return_value = sample_property_dict
        route_gets(mock_gc, {
            "annotation_property": [],  # no existing
            "dataset_view": [{"configurationId": "cfg_1"}],
            "upenn_collection/cfg_1": {"meta": {"propertyIds": []}},
        })
        accessor = PropertyAccessor(mock_gc, "ds_001")

        result = accessor.get_or_create(
            name="Blob Intensity", shape="polygon"
        )
        assert result.id == "prop_001"
        mock_gc.post.assert_called_once()
        # the created property must be registered so the next
        # get_or_create can find it
        mock_gc.put.assert_called_once()

    def test_delete(self, mock_gc):
        accessor = PropertyAccessor(mock_gc, "ds_001")
        accessor.delete("prop_001")
        mock_gc.delete.assert_called_with("annotation_property/prop_001")


class TestPropertyValues:
    def test_get_values_for_dataset(self, mock_gc):
        mock_gc.get.return_value = [{"annotationId": "a1", "values": {}}]
        accessor = PropertyAccessor(mock_gc, "ds_001")

        result = accessor.get_values()
        assert len(result) == 1
        call_url = mock_gc.get.call_args[0][0]
        assert "datasetId=ds_001" in call_url

    def test_get_values_for_annotation(self, mock_gc):
        mock_gc.get.return_value = [{"annotationId": "a1", "values": {}}]
        accessor = PropertyAccessor(mock_gc, "ds_001")

        accessor.get_values(annotation_id="a1")
        call_url = mock_gc.get.call_args[0][0]
        assert "annotationId=a1" in call_url

    def test_submit_values_transforms_format(self, mock_gc):
        accessor = PropertyAccessor(mock_gc, "ds_001")

        accessor.submit_values("prop_001", {
            "ann_a": {"Area": 100, "Perimeter": 50},
            "ann_b": {"Area": 200, "Perimeter": 75},
        })

        call_args = mock_gc.post.call_args
        payload = call_args[1]["json"]
        assert len(payload) == 2
        assert payload[0]["datasetId"] == "ds_001"
        assert payload[0]["annotationId"] == "ann_a"
        assert payload[0]["values"]["prop_001"]["Area"] == 100

    def test_submit_values_batches_at_10k(self, mock_gc):
        accessor = PropertyAccessor(mock_gc, "ds_001")

        # Create 15000 entries
        values = {f"ann_{i}": {"v": i} for i in range(15000)}
        accessor.submit_values("prop_001", values)

        # Should have been called twice (10K + 5K)
        assert mock_gc.post.call_count == 2

    def test_delete_values(self, mock_gc):
        accessor = PropertyAccessor(mock_gc, "ds_001")
        accessor.delete_values("prop_001")
        call_url = mock_gc.delete.call_args[0][0]
        assert "propertyId=prop_001" in call_url
        assert "datasetId=ds_001" in call_url

    def test_histogram(self, mock_gc):
        mock_gc.get.return_value = [{"min": 0, "max": 100, "count": 50}]
        accessor = PropertyAccessor(mock_gc, "ds_001")

        accessor.histogram("prop_001.Area", buckets=128)
        call_url = mock_gc.get.call_args[0][0]
        assert "propertyPath=prop_001.Area" in call_url
        assert "buckets=128" in call_url

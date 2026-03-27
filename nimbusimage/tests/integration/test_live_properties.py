"""Integration tests for property definitions and values."""

import pytest

import nimbusimage as ni

pytestmark = pytest.mark.integration


class TestLiveProperties:
    def test_create_property_and_submit_values(self, test_dataset):
        ds = test_dataset

        # Create a property
        prop = ds.properties.create(
            name="test_property", shape="point",
        )
        assert prop.id is not None

        # Create an annotation
        ann = ds.annotations.create(ni.Annotation(
            id=None, shape="point", tags=["prop_test"],
            channel=0, location=ni.Location(),
            coordinates=[{"x": 10.0, "y": 10.0}],
            dataset_id=ds.id,
        ))

        # Submit values
        ds.properties.submit_values(prop.id, {
            ann.id: {"score": 0.95},
        })

        # Retrieve values
        values = ds.properties.get_values(annotation_id=ann.id)
        assert len(values) >= 1

        # Cleanup
        ds.properties.delete_values(prop.id)
        ds.annotations.delete(ann.id)
        ds.properties.delete(prop.id)

    def test_get_or_create(self, test_dataset):
        ds = test_dataset

        prop1 = ds.properties.get_or_create(
            name="unique_test_prop", shape="polygon"
        )
        prop2 = ds.properties.get_or_create(
            name="unique_test_prop", shape="polygon"
        )
        assert prop1.id == prop2.id

        # Cleanup
        ds.properties.delete(prop1.id)

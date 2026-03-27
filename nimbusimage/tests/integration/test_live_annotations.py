"""Integration tests for annotation CRUD."""

import pytest

import nimbusimage as ni

pytestmark = pytest.mark.integration


class TestLiveAnnotations:
    def test_create_and_list(self, test_dataset):
        ds = test_dataset

        ann = ni.Annotation(
            id=None, shape="point", tags=["test"],
            channel=0, location=ni.Location(),
            coordinates=[{"x": 50.5, "y": 60.5}],
            dataset_id=ds.id,
        )

        created = ds.annotations.create(ann)
        assert created.id is not None

        listed = ds.annotations.list(shape="point", tags=["test"])
        assert len(listed) >= 1
        assert any(a.id == created.id for a in listed)

        # Cleanup
        ds.annotations.delete(created.id)

    def test_create_many_and_delete_many(self, test_dataset):
        ds = test_dataset

        anns = [
            ni.Annotation(
                id=None, shape="point", tags=["batch"],
                channel=0, location=ni.Location(),
                coordinates=[{"x": float(i), "y": float(i)}],
                dataset_id=ds.id,
            )
            for i in range(5)
        ]

        created = ds.annotations.create_many(anns)
        assert len(created) == 5

        count = ds.annotations.count(tags=["batch"])
        assert count >= 5

        ids = [a.id for a in created]
        ds.annotations.delete_many(ids)

    def test_update(self, test_dataset):
        ds = test_dataset

        ann = ni.Annotation(
            id=None, shape="point", tags=["update_test"],
            channel=0, location=ni.Location(),
            coordinates=[{"x": 1.0, "y": 2.0}],
            dataset_id=ds.id,
        )
        created = ds.annotations.create(ann)

        updated = ds.annotations.update(
            created.id, {"tags": ["updated"]}
        )
        assert "updated" in updated.tags

        ds.annotations.delete(created.id)

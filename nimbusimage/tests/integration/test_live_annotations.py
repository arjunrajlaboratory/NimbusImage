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

    def test_iter_all_walks_after_id_cursor(self, test_dataset):
        """NIM-002: iter_all() pages the real afterId cursor and returns
        every record exactly once, in ascending _id order."""
        ds = test_dataset

        anns = [
            ni.Annotation(
                id=None, shape="point", tags=["iterall"],
                channel=0, location=ni.Location(),
                coordinates=[{"x": float(i), "y": float(i)}],
                dataset_id=ds.id,
            )
            for i in range(7)
        ]
        created = ds.annotations.create_many(anns)
        created_ids = sorted(a.id for a in created)

        try:
            seen = [
                a.id
                for a in ds.annotations.iter_all(tags=["iterall"], page_size=2)
            ]
            assert sorted(seen) == created_ids
            assert len(seen) == len(set(seen))  # no duplicates
            assert seen == sorted(seen)  # ascending _id order
        finally:
            ds.annotations.delete_many([a.id for a in created])

    def test_iter_all_safe_during_deletion(self, test_dataset):
        """NIM-002: deleting each record as it is yielded must not skip
        any (the offset-pagination bug the cursor fixes)."""
        ds = test_dataset

        anns = [
            ni.Annotation(
                id=None, shape="point", tags=["iterdel"],
                channel=0, location=ni.Location(),
                coordinates=[{"x": float(i), "y": float(i)}],
                dataset_id=ds.id,
            )
            for i in range(7)
        ]
        created = ds.annotations.create_many(anns)
        expected = sorted(a.id for a in created)

        seen = []
        for a in ds.annotations.iter_all(tags=["iterdel"], page_size=2):
            seen.append(a.id)
            ds.annotations.delete(a.id)

        assert sorted(seen) == expected
        assert ds.annotations.count(tags=["iterdel"]) == 0

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

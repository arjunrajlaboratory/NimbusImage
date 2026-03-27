"""Integration tests for connection CRUD."""

import pytest

import nimbusimage as ni

pytestmark = pytest.mark.integration


class TestLiveConnections:
    def test_create_and_list(self, test_dataset):
        ds = test_dataset

        # Create two annotations to connect
        a1 = ds.annotations.create(ni.Annotation(
            id=None, shape="point", tags=["conn_test"],
            channel=0, location=ni.Location(),
            coordinates=[{"x": 10.0, "y": 10.0}],
            dataset_id=ds.id,
        ))
        a2 = ds.annotations.create(ni.Annotation(
            id=None, shape="point", tags=["conn_test"],
            channel=0, location=ni.Location(),
            coordinates=[{"x": 20.0, "y": 20.0}],
            dataset_id=ds.id,
        ))

        conn = ds.connections.create(a1.id, a2.id, tags=["test_link"])
        assert conn.id is not None

        listed = ds.connections.list()
        assert any(c.id == conn.id for c in listed)

        # Cleanup
        ds.connections.delete(conn.id)
        ds.annotations.delete_many([a1.id, a2.id])

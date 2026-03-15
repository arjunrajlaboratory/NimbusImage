"""Tests for ConnectionAccessor."""

import pytest

from nimbusimage.connections import ConnectionAccessor
from nimbusimage.models import Connection


class TestConnectionList:
    def test_list_all(self, mock_gc, sample_connection_dict):
        mock_gc.get.return_value = [sample_connection_dict]
        accessor = ConnectionAccessor(mock_gc, "ds_001")

        result = accessor.list()
        assert len(result) == 1
        assert isinstance(result[0], Connection)

    def test_list_with_filters(self, mock_gc):
        mock_gc.get.return_value = []
        accessor = ConnectionAccessor(mock_gc, "ds_001")

        accessor.list(parent_id="p1", child_id="c1", limit=50)
        call_url = mock_gc.get.call_args[0][0]
        assert "parentId=p1" in call_url
        assert "childId=c1" in call_url
        assert "limit=50" in call_url


class TestConnectionGet:
    def test_get_by_id(self, mock_gc, sample_connection_dict):
        mock_gc.get.return_value = sample_connection_dict
        accessor = ConnectionAccessor(mock_gc, "ds_001")

        conn = accessor.get("conn_001")
        assert conn.parent_id == "ann_001"


class TestConnectionCount:
    def test_count(self, mock_gc):
        mock_gc.get.return_value = {"count": 10}
        accessor = ConnectionAccessor(mock_gc, "ds_001")
        assert accessor.count() == 10


class TestConnectionCreate:
    def test_create_single(self, mock_gc, sample_connection_dict):
        mock_gc.post.return_value = sample_connection_dict
        accessor = ConnectionAccessor(mock_gc, "ds_001")

        result = accessor.create("ann_001", "ann_002", tags=["link"])
        assert isinstance(result, Connection)

    def test_create_many(self, mock_gc, sample_connection_dict):
        mock_gc.post.return_value = [sample_connection_dict]
        accessor = ConnectionAccessor(mock_gc, "ds_001")

        conn = Connection(
            id=None, parent_id="p1", child_id="c1",
            dataset_id="ds_001", tags=[],
        )
        result = accessor.create_many([conn])
        assert len(result) == 1

    def test_connect_to_nearest(self, mock_gc):
        mock_gc.post.return_value = None
        accessor = ConnectionAccessor(mock_gc, "ds_001")

        accessor.connect_to_nearest(
            ["ann_001", "ann_002"], tags=["nucleus"], channel=0
        )
        call_args = mock_gc.post.call_args
        body = call_args[1]["json"]
        assert body["annotationsIds"] == ["ann_001", "ann_002"]
        assert body["tags"] == ["nucleus"]
        assert body["channelId"] == 0


class TestConnectionUpdate:
    def test_update(self, mock_gc, sample_connection_dict):
        mock_gc.put.return_value = sample_connection_dict
        accessor = ConnectionAccessor(mock_gc, "ds_001")

        result = accessor.update("conn_001", {"tags": ["new"]})
        assert isinstance(result, Connection)


class TestConnectionDelete:
    def test_delete_single(self, mock_gc):
        accessor = ConnectionAccessor(mock_gc, "ds_001")
        accessor.delete("conn_001")
        mock_gc.delete.assert_called_with("/annotation_connection/conn_001")

    def test_delete_many(self, mock_gc):
        accessor = ConnectionAccessor(mock_gc, "ds_001")
        accessor.delete_many(["c1", "c2"])
        mock_gc.sendRestRequest.assert_called_once()

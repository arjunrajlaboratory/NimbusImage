"""Tests for HistoryAccessor."""

import pytest
from nimbusimage.history import HistoryAccessor


class TestHistoryAccessor:
    def test_list(self, mock_gc):
        mock_gc.get.return_value = [
            {"action": "create", "timestamp": "2026-01-01"}
        ]
        accessor = HistoryAccessor(mock_gc, "ds_001")
        result = accessor.list()
        assert len(result) == 1

    def test_undo(self, mock_gc):
        accessor = HistoryAccessor(mock_gc, "ds_001")
        accessor.undo()
        mock_gc.put.assert_called_once()
        call_url = mock_gc.put.call_args[0][0]
        assert "history/undo" in call_url

    def test_redo(self, mock_gc):
        accessor = HistoryAccessor(mock_gc, "ds_001")
        accessor.redo()
        call_url = mock_gc.put.call_args[0][0]
        assert "history/redo" in call_url

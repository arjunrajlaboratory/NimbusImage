"""Tests for ExportAccessor."""

from unittest.mock import MagicMock

import pytest
from nimbusimage.export import ExportAccessor


class TestExportAccessor:
    def test_to_json(self, mock_gc):
        mock_gc.get.return_value = {"annotations": [], "connections": []}
        accessor = ExportAccessor(mock_gc, "ds_001")
        result = accessor.to_json()
        assert "annotations" in result
        call_url = mock_gc.get.call_args[0][0]
        assert "datasetId=ds_001" in call_url

    def test_to_csv(self, mock_gc):
        mock_response = MagicMock()
        mock_response.content = b"Id,Channel\nann1,0"
        mock_gc.sendRestRequest.return_value = mock_response
        accessor = ExportAccessor(mock_gc, "ds_001")
        result = accessor.to_csv(property_paths=[["prop1", "Area"]])
        assert isinstance(result, bytes)
        assert b"Id,Channel" in result

    def test_to_csv_with_path(self, mock_gc, tmp_path):
        mock_response = MagicMock()
        mock_response.content = b"Id,Channel\nann1,0"
        mock_gc.sendRestRequest.return_value = mock_response
        accessor = ExportAccessor(mock_gc, "ds_001")
        out_file = tmp_path / "export.csv"
        accessor.to_csv(
            property_paths=[["prop1"]], path=str(out_file)
        )
        assert out_file.read_bytes() == b"Id,Channel\nann1,0"

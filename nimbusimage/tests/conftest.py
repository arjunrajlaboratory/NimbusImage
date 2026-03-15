"""Shared test fixtures for nimbusimage unit tests."""

from unittest.mock import MagicMock

import pytest


@pytest.fixture
def mock_gc():
    """A mock girder_client.GirderClient instance.

    All HTTP methods (get, post, put, delete, sendRestRequest)
    are MagicMock objects that can be configured per-test.
    """
    gc = MagicMock()
    gc.getServerApiUrl.return_value = "http://localhost:8080/api/v1"
    gc.token = "test-token-abc123"
    return gc


@pytest.fixture
def sample_annotation_dict():
    """A sample annotation dict as returned by the server."""
    return {
        "_id": "ann_001",
        "shape": "polygon",
        "tags": ["nucleus"],
        "channel": 0,
        "location": {"Time": 0, "XY": 0, "Z": 0},
        "coordinates": [
            {"x": 100.5, "y": 200.5},
            {"x": 150.5, "y": 200.5},
            {"x": 150.5, "y": 250.5},
            {"x": 100.5, "y": 250.5},
        ],
        "datasetId": "dataset_001",
        "color": None,
    }


@pytest.fixture
def sample_connection_dict():
    """A sample connection dict as returned by the server."""
    return {
        "_id": "conn_001",
        "parentId": "ann_001",
        "childId": "ann_002",
        "datasetId": "dataset_001",
        "tags": ["parent-child"],
    }


@pytest.fixture
def sample_property_dict():
    """A sample property definition dict as returned by the server."""
    return {
        "_id": "prop_001",
        "name": "Blob Intensity",
        "image": "properties/blob_intensity:latest",
        "shape": "polygon",
        "tags": {"exclusive": False, "tags": ["nucleus"]},
        "workerInterface": {"Channel": 1},
    }


@pytest.fixture
def sample_tiles_metadata():
    """Sample tiles metadata as returned by large_image /tiles endpoint."""
    return {
        "sizeX": 1024,
        "sizeY": 768,
        "levels": 1,
        "magnification": 20.0,
        "mm_x": 0.000219,
        "mm_y": 0.000219,
        "dtype": "uint16",
        "bandCount": 1,
        "frames": [
            {"Frame": 0, "IndexC": 0, "IndexT": 0, "IndexZ": 0, "IndexXY": 0, "Channel": "DAPI"},
            {"Frame": 1, "IndexC": 1, "IndexT": 0, "IndexZ": 0, "IndexXY": 0, "Channel": "GFP"},
            {"Frame": 2, "IndexC": 0, "IndexT": 0, "IndexZ": 1, "IndexXY": 0, "Channel": "DAPI"},
            {"Frame": 3, "IndexC": 1, "IndexT": 0, "IndexZ": 1, "IndexXY": 0, "Channel": "GFP"},
        ],
        "IndexRange": {"IndexC": 2, "IndexT": 1, "IndexZ": 2, "IndexXY": 1},
        "IndexStride": {"IndexC": 1, "IndexT": 4, "IndexZ": 2, "IndexXY": 1},
        "channels": ["DAPI", "GFP"],
    }

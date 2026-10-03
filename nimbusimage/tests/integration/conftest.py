"""Fixtures for integration tests against a live Girder backend."""

import json
import os

import pytest

import nimbusimage as ni


@pytest.fixture(scope="session")
def api_url():
    return os.environ.get("NI_API_URL", "http://localhost:8080/api/v1")


@pytest.fixture(scope="session")
def client(api_url):
    """Authenticated client for integration tests."""
    username = os.environ.get("NI_TEST_USER", "admin")
    password = os.environ.get("NI_TEST_PASS", "password")
    return ni.connect(api_url, username=username, password=password)


@pytest.fixture
def test_dataset(client):
    """Create a temporary test dataset folder and clean up after.

    The dataset gets a collection (configuration) and a dataset_view
    linking them, like every real dataset has. Properties are only
    visible through the collections that reference them, so a dataset
    without a collection can't hold visible properties at all.

    Note: This creates a folder with dataset metadata but no actual
    image data. Tests that need images should upload a test image.
    """
    gc = client.girder
    # Create a folder in the admin's public folder
    user = gc.get("user/me")
    public_folder = gc.get(
        "folder",
        parameters={
            "parentType": "user",
            "parentId": user["_id"],
            "name": "Public",
        },
    )[0]

    folder = gc.post(
        "folder",
        parameters={
            "parentType": "folder",
            "parentId": public_folder["_id"],
            "name": "nimbusimage_test_dataset",
            "metadata": json.dumps({"subtype": "contrastDataset"}),
        },
    )

    # If collection/view setup fails, delete the folder before
    # re-raising: a stranded folder makes every later run fail with
    # "A folder with that name already exists here."
    try:
        collection = gc.post(
            "upenn_collection",
            parameters={
                "folderId": folder["_id"],
                "name": "nimbusimage_test_config",
            },
            data={
                "metadata": json.dumps({
                    "subtype": "contrastConfiguration",
                    "compatibility": {},
                    "layers": [],
                    "tools": [],
                    "propertyIds": [],
                    "snapshots": [],
                    "scales": {},
                })
            },
        )
        view = gc.post(
            "dataset_view",
            json={
                "datasetId": folder["_id"],
                "configurationId": collection["_id"],
                "layerContrasts": {},
                "lastLocation": {"xy": 0, "z": 0, "time": 0},
            },
        )
    except Exception:
        gc.delete(f"folder/{folder['_id']}")
        raise

    yield client.dataset(folder["_id"])

    # Cleanup
    gc.delete(f"dataset_view/{view['_id']}")
    gc.delete(f"upenn_collection/{collection['_id']}")
    gc.delete(f"folder/{folder['_id']}")

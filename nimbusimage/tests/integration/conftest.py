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

    yield client.dataset(folder["_id"])

    # Cleanup
    gc.delete(f"folder/{folder['_id']}")

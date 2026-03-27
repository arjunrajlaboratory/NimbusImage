"""Integration tests for collection accessor and image compositing.

These tests verify that:
1. CollectionAccessor fetches collections via /upenn_collection
2. Layer settings have the expected structure (hex colors, percentile contrast)
3. get_composite works end-to-end with real layer settings
"""

import numpy as np
import pytest

import nimbusimage as ni

pytestmark = pytest.mark.integration


@pytest.fixture(scope="module")
def client():
    """Authenticated client."""
    import os
    api_url = os.environ.get("NI_API_URL", "http://localhost:8080/api/v1")
    username = os.environ.get("NI_TEST_USER", "admin")
    password = os.environ.get("NI_TEST_PASS", "password")
    return ni.connect(api_url, username=username, password=password)


@pytest.fixture(scope="module")
def dataset_with_collection(client):
    """Find a dataset that has a collection with layers.

    Searches user's folders for a dataset with at least one
    collection that has layer settings.
    """
    gc = client.girder
    me = gc.get("user/me")

    # List all folders recursively looking for datasets
    for parent_type, parent_name in [("Private", None), ("Public", None)]:
        top_folders = gc.get("folder", parameters={
            "parentType": "user", "parentId": me["_id"], "limit": 10,
        })
        for top in top_folders:
            subfolders = gc.get("folder", parameters={
                "parentType": "folder", "parentId": top["_id"], "limit": 20,
            })
            for f in subfolders:
                if f.get("meta", {}).get("subtype") == "contrastDataset":
                    ds = client.dataset(f["_id"])
                    try:
                        views = ds.collections.list_views()
                        if views and views[0].get("configurationId"):
                            raw = ds.collections.get_raw()
                            layers = raw.get("meta", {}).get("layers", [])
                            if layers:
                                return ds
                    except Exception:
                        continue

    pytest.skip("No dataset with collection found")


class TestLiveCollections:
    def test_collection_layers_structure(self, dataset_with_collection):
        """Verify layers have the expected real-world structure."""
        ds = dataset_with_collection
        layers = ds.collections.layers

        assert len(layers) > 0
        for layer in layers:
            assert "channel" in layer
            assert "color" in layer
            assert "visible" in layer
            # Color should be a hex string
            assert layer["color"].startswith("#")
            # Contrast should have blackPoint/whitePoint
            contrast = layer.get("contrast", {})
            assert "blackPoint" in contrast
            assert "whitePoint" in contrast

    def test_collection_property_ids(self, dataset_with_collection):
        """Verify property_ids is a list."""
        ds = dataset_with_collection
        prop_ids = ds.collections.property_ids
        assert isinstance(prop_ids, list)

    def test_get_raw_uses_collection_endpoint(self, dataset_with_collection):
        """Verify collection is fetched (no HTTP 400 error)."""
        ds = dataset_with_collection
        raw = ds.collections.get_raw()
        assert "_id" in raw
        assert "meta" in raw
        assert "layers" in raw["meta"]


class TestLiveComposite:
    def test_get_composite_uint8(self, dataset_with_collection):
        """Verify get_composite produces a valid RGB image."""
        ds = dataset_with_collection
        rgb = ds.images.get_composite(xy=0, z=0, time=0, dtype="uint8")

        assert rgb.ndim == 3
        assert rgb.shape[2] == 3
        assert rgb.dtype == np.uint8
        assert rgb.max() > 0  # not all black

    def test_get_composite_float64(self, dataset_with_collection):
        """Verify float64 composite is in [0, 1] range."""
        ds = dataset_with_collection
        rgb = ds.images.get_composite(xy=0, z=0, time=0, dtype="float64")

        assert rgb.dtype == np.float64
        assert rgb.min() >= 0.0
        assert rgb.max() <= 1.0

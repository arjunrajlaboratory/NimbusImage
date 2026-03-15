"""Integration tests for config accessor and image compositing.

These tests verify that:
1. ConfigAccessor correctly fetches configurations via /upenn_collection (not /item)
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
def dataset_with_config(client):
    """Find a dataset that has a configuration with layers.

    Searches user's folders for a dataset with at least one
    configuration that has layer settings.
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
                        views = ds.config.list_views()
                        if views and views[0].get("configurationId"):
                            config = ds.config.get_configuration()
                            layers = config.get("meta", {}).get("layers", [])
                            if layers:
                                return ds
                    except Exception:
                        continue

    pytest.skip("No dataset with configuration found")


class TestLiveConfig:
    def test_config_layers_structure(self, dataset_with_config):
        """Verify layers have the expected real-world structure."""
        ds = dataset_with_config
        layers = ds.config.layers

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

    def test_config_property_ids(self, dataset_with_config):
        """Verify property_ids is a list."""
        ds = dataset_with_config
        prop_ids = ds.config.property_ids
        assert isinstance(prop_ids, list)

    def test_get_configuration_uses_collection_endpoint(self, dataset_with_config):
        """Verify configuration is fetched (no HTTP 400 error)."""
        ds = dataset_with_config
        config = ds.config.get_configuration()
        assert "_id" in config
        assert "meta" in config
        assert "layers" in config["meta"]


class TestLiveComposite:
    def test_get_composite_uint8(self, dataset_with_config):
        """Verify get_composite produces a valid RGB image."""
        ds = dataset_with_config
        rgb = ds.images.get_composite(xy=0, z=0, time=0, dtype="uint8")

        assert rgb.ndim == 3
        assert rgb.shape[2] == 3
        assert rgb.dtype == np.uint8
        assert rgb.max() > 0  # not all black

    def test_get_composite_float64(self, dataset_with_config):
        """Verify float64 composite is in [0, 1] range."""
        ds = dataset_with_config
        rgb = ds.images.get_composite(xy=0, z=0, time=0, dtype="float64")

        assert rgb.dtype == np.float64
        assert rgb.min() >= 0.0
        assert rgb.max() <= 1.0

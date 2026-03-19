"""Tests for URL generation."""

from unittest.mock import patch

import pytest

from nimbusimage.urls import (
    dataset_info_url,
    dataset_view_url,
    configuration_url,
    project_url,
)


class TestDatasetInfoUrl:
    def test_basic(self):
        url = dataset_info_url("ds_001")
        assert url == "http://localhost:5173/#/dataset/ds_001"

    def test_custom_base(self):
        url = dataset_info_url(
            "ds_001", frontend_url="https://nimbus.example.com",
        )
        assert url == "https://nimbus.example.com/#/dataset/ds_001"

    def test_trailing_slash_stripped(self):
        url = dataset_info_url("ds_001", frontend_url="http://localhost:5173/")
        assert url == "http://localhost:5173/#/dataset/ds_001"


class TestDatasetViewUrl:
    def test_basic(self):
        url = dataset_view_url("view_001")
        assert url == "http://localhost:5173/#/datasetView/view_001/view"

    def test_with_z(self):
        url = dataset_view_url("view_001", z=5)
        assert url == "http://localhost:5173/#/datasetView/view_001/view?z=5"

    def test_with_all_params(self):
        url = dataset_view_url(
            "view_001", xy=0, z=3, time=2,
            layer="multiple", unroll_z=True,
        )
        assert "xy=0" in url
        assert "z=3" in url
        assert "time=2" in url
        assert "layer=multiple" in url
        assert "unrollZ=true" in url

    def test_none_params_excluded(self):
        url = dataset_view_url("view_001", z=5, time=None)
        assert "z=5" in url
        assert "time" not in url

    def test_custom_base(self):
        url = dataset_view_url("v1", frontend_url="https://app.nimbus.io")
        assert url.startswith("https://app.nimbus.io/#/")


class TestConfigurationUrl:
    def test_basic(self):
        url = configuration_url("cfg_001")
        assert url == "http://localhost:5173/#/configuration/cfg_001"


class TestProjectUrl:
    def test_basic(self):
        url = project_url("proj_001")
        assert url == "http://localhost:5173/#/project/proj_001"


class TestDatasetUrlMethods:
    """Test URL methods on Dataset objects."""

    def test_info_url(self, mock_gc):
        from nimbusimage.dataset import Dataset
        ds = Dataset(mock_gc, "ds_001", frontend_url="http://localhost:5173")
        assert ds.info_url() == "http://localhost:5173/#/dataset/ds_001"

    def test_view_url(self, mock_gc):
        from nimbusimage.dataset import Dataset
        ds = Dataset(mock_gc, "ds_001", frontend_url="http://localhost:5173")
        mock_gc.get.return_value = [
            {"_id": "view_001", "configurationId": "cfg_001"}
        ]
        url = ds.view_url(z=5)
        assert "datasetView/view_001/view" in url
        assert "z=5" in url

    def test_view_url_no_view_raises(self, mock_gc):
        from nimbusimage.dataset import Dataset
        ds = Dataset(mock_gc, "ds_001")
        mock_gc.get.return_value = []  # no views
        with pytest.raises(ValueError, match="No dataset view"):
            ds.view_url()

    def test_configuration_url(self, mock_gc):
        from nimbusimage.dataset import Dataset
        ds = Dataset(mock_gc, "ds_001", frontend_url="http://localhost:5173")
        mock_gc.get.return_value = [
            {"_id": "view_001", "configurationId": "cfg_001"}
        ]
        url = ds.configuration_url()
        assert url == "http://localhost:5173/#/configuration/cfg_001"

    def test_open_calls_webbrowser(self, mock_gc):
        from nimbusimage.dataset import Dataset
        ds = Dataset(mock_gc, "ds_001", frontend_url="http://localhost:5173")
        mock_gc.get.return_value = [
            {"_id": "view_001", "configurationId": "cfg_001"}
        ]
        with patch("nimbusimage.urls.webbrowser.open") as mock_open:
            url = ds.open(z=3)
            mock_open.assert_called_once_with(url)
            assert "z=3" in url


class TestProjectUrlMethods:
    def test_url(self, mock_gc):
        from nimbusimage.projects import Project
        proj = Project(
            mock_gc, {"_id": "proj_001", "name": "Test", "meta": {}},
            frontend_url="http://localhost:5173",
        )
        assert proj.url() == "http://localhost:5173/#/project/proj_001"

    def test_open_calls_webbrowser(self, mock_gc):
        from nimbusimage.projects import Project
        proj = Project(
            mock_gc, {"_id": "proj_001", "name": "Test", "meta": {}},
            frontend_url="http://localhost:5173",
        )
        with patch("nimbusimage.urls.webbrowser.open") as mock_open:
            url = proj.open()
            mock_open.assert_called_once_with(url)


class TestClientFrontendUrl:
    def test_default_frontend_url(self):
        from unittest.mock import MagicMock
        with patch("nimbusimage._girder.girder_client.GirderClient") as MockGC:
            mock_gc = MagicMock()
            MockGC.return_value = mock_gc
            from nimbusimage.client import NimbusClient
            client = NimbusClient(
                api_url="http://localhost:8080/api/v1", token="tok"
            )
            assert client.frontend_url == "http://localhost:5173"

    def test_custom_frontend_url(self):
        from unittest.mock import MagicMock
        with patch("nimbusimage._girder.girder_client.GirderClient") as MockGC:
            mock_gc = MagicMock()
            MockGC.return_value = mock_gc
            from nimbusimage.client import NimbusClient
            client = NimbusClient(
                api_url="http://localhost:8080/api/v1", token="tok",
                frontend_url="https://nimbus.example.com",
            )
            assert client.frontend_url == "https://nimbus.example.com"

    def test_env_var_overrides(self):
        import os
        from unittest.mock import MagicMock
        with patch("nimbusimage._girder.girder_client.GirderClient") as MockGC:
            mock_gc = MagicMock()
            MockGC.return_value = mock_gc
            with patch.dict(
                os.environ, {"NI_FRONTEND_URL": "https://env.nimbus.io"},
            ):
                from nimbusimage.client import NimbusClient
                client = NimbusClient(
                    api_url="http://localhost:8080/api/v1", token="tok"
                )
                assert client.frontend_url == "https://env.nimbus.io"

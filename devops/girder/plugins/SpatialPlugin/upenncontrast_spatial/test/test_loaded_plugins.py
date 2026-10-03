"""
The client hides every spatial feature unless GET /system/loaded_plugins
names this plugin, so the name it reports is a contract with the frontend
(SPATIAL_PLUGIN_NAME in src/store/SpatialAPI.ts).
"""
import pytest
from pytest_girder.assertions import assertStatusOk


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_spatial")
class TestLoadedPlugins:
    def testSpatialPluginIsListed(self, server):
        resp = server.request(path="/system/loaded_plugins", method="GET")
        assertStatusOk(resp)
        assert "upenncontrast_spatial" in resp.json
        assert "upenncontrast_annotation" in resp.json

"""
Tests for the public loaded-plugins list (GET /api/v1/system/loaded_plugins),
which the client uses to leave out the UI of an optional plugin
(upenncontrast_spatial) that a deployment does not install.
"""
import pytest
from pytest_girder.assertions import assertStatusOk


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestLoadedPlugins:
    def testAnonymousGetsSortedNames(self, server):
        resp = server.request(path="/system/loaded_plugins", method="GET")
        assertStatusOk(resp)
        assert "upenncontrast_annotation" in resp.json
        assert resp.json == sorted(resp.json)
        # This plugin's test environment never installs the spatial plugin,
        # which is exactly the deployment the client must detect.
        assert "upenncontrast_spatial" not in resp.json

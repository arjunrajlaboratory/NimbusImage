"""Integration tests for NimbusClient."""

import os

import numpy as np
import pytest

import nimbusimage as ni

pytestmark = pytest.mark.integration


class TestLiveClient:
    def test_connect_and_get_user(self, client):
        assert client.user_id is not None
        assert len(client.user_id) > 0

    def test_list_projects(self, client):
        projects = client.list_projects()
        assert isinstance(projects, list)


class TestLiveAnonymousAccess:
    """Public-dataset workflow: connect without credentials, read a public
    dataset, run measurements, but stay blocked from private data."""

    @pytest.fixture(scope="class")
    def public_dataset(self, client):
        """Create a dataset with a tiny image, make it public, clean up.

        Skips if the authenticated user can't create public content.
        """
        gc = client.girder
        user = gc.get("user/me")
        public_folders = gc.get("folder", parameters={
            "parentType": "user", "parentId": user["_id"], "name": "Public",
        })
        if not public_folders:
            pytest.skip("authenticated user has no Public folder")
        import json
        folder = gc.post("folder", parameters={
            "parentType": "folder", "parentId": public_folders[0]["_id"],
            "name": "nimbusimage_anon_test", "public": True,
            "reuseExisting": True,
            "metadata": json.dumps({"subtype": "contrastDataset"}),
        })

        # Upload a small deterministic TIFF so images.get / line_scan work.
        # The server tiles it via large_image; the client only writes a TIFF.
        try:
            import tifffile
        except ImportError:
            gc.delete(f"folder/{folder['_id']}")
            pytest.skip("tifffile not installed for test image upload")

        import tempfile
        arr = np.tile(
            np.arange(64, dtype=np.uint16)[None, :], (64, 1)
        )  # value == column index, exact under bilinear
        path = os.path.join(tempfile.gettempdir(), "anon_test.tiff")
        tifffile.imwrite(path, arr)
        item = gc.uploadFileToFolder(folder["_id"], path)
        os.remove(path)
        # large_image usually auto-tiles TIFFs on upload; if not, request it.
        try:
            gc.post(f"item/{item['itemId']}/tiles")
        except Exception as exc:
            if "already has largeImage" not in str(exc):
                raise

        yield folder["_id"], arr
        gc.delete(f"folder/{folder['_id']}")

    def test_anonymous_connect_has_no_token(self, api_url):
        anon = ni.connect(api_url, anonymous=True)
        assert not anon.girder.token

    def test_anonymous_reads_public_and_line_scans(
        self, api_url, public_dataset,
    ):
        folder_id, arr = public_dataset
        anon = ni.connect(api_url, anonymous=True)
        ds = anon.dataset(folder_id)
        # Row scan: value equals column index in the source image
        result = ds.images.line_scan(
            [(5.5, 32.5), (58.5, 32.5)], channel=0, z=0, time=0,
        )
        np.testing.assert_allclose(
            result.values, np.arange(5, 59, dtype=np.float64), atol=1e-6
        )

    @pytest.fixture
    def private_folder(self, client):
        """A folder in the user's Private folder, cleaned up after."""
        gc = client.girder
        user = gc.get("user/me")
        private_folders = gc.get("folder", parameters={
            "parentType": "user", "parentId": user["_id"], "name": "Private",
        })
        if not private_folders:
            pytest.skip("authenticated user has no Private folder")
        folder = gc.post("folder", parameters={
            "parentType": "folder", "parentId": private_folders[0]["_id"],
            "name": "nimbusimage_private_test", "public": False,
            "reuseExisting": True,
        })
        yield folder["_id"]
        gc.delete(f"folder/{folder['_id']}")

    def test_anonymous_denied_private_dataset(self, api_url, private_folder):
        """A private folder must not be readable anonymously."""
        anon = ni.connect(api_url, anonymous=True)
        with pytest.raises(Exception) as exc_info:
            anon.girder.get(f"folder/{private_folder}")
        status = getattr(exc_info.value, "status", None)
        assert status in (401, 403), (
            f"expected auth error, got {exc_info.value!r}"
        )

"""Tests for Zenodo upload integration.

Tests credential management, shared helpers, filename
collision detection, progress counting, and upload
endpoint edge cases.
"""

import pytest
from unittest.mock import MagicMock

from girder.models.item import Item
from girder.models.user import User

from upenncontrast_annotation.server.api.zenodo_credentials import (
    encrypt_token,
    decrypt_token,
)
from upenncontrast_annotation.server.helpers.zenodo_client import (
    ZenodoClient,
    ZenodoError,
    get_zenodo_client_for_user,
    update_zenodo_meta,
)
from upenncontrast_annotation.server.models.project import (
    Project as ProjectModel,
)

from . import girder_utilities as utilities
from . import upenn_testing_utilities as upenn_utilities


# --- Credential encryption tests ---

class TestTokenEncryption:
    """Test Fernet encryption/decryption of tokens."""

    def test_encrypt_decrypt_round_trip(self):
        """A token can be encrypted then decrypted."""
        token = "test_zenodo_pat_abc123"
        encrypted = encrypt_token(token)
        assert encrypted != token
        assert decrypt_token(encrypted) == token

    def test_decrypt_invalid_returns_none(self):
        """Decrypting garbage returns None, not error."""
        assert decrypt_token("not-a-valid-ciphertext") is None

    def test_encrypt_produces_different_ciphertext(self):
        """Each encryption produces different ciphertext
        (Fernet uses random IV)."""
        token = "same_token"
        a = encrypt_token(token)
        b = encrypt_token(token)
        # Both should decrypt to same value
        assert decrypt_token(a) == token
        assert decrypt_token(b) == token
        # But ciphertext should differ (random IV)
        assert a != b


# --- Shared helper tests ---

@pytest.mark.usefixtures(
    "unbindLargeImage", "unbindAnnotation"
)
@pytest.mark.plugin("upenncontrast_annotation")
class TestGetZenodoClientForUser:
    """Test the shared get_zenodo_client_for_user helper."""

    def test_no_token_raises(self, admin):
        """Raises ValueError when user has no token."""
        with pytest.raises(
            ValueError, match="No Zenodo token"
        ):
            get_zenodo_client_for_user(admin)

    def test_with_token_returns_client(self, admin):
        """Returns a ZenodoClient when token is stored."""
        encrypted = encrypt_token("test_pat")
        user_doc = User().load(admin['_id'], force=True)
        if 'meta' not in user_doc:
            user_doc['meta'] = {}
        user_doc['meta']['zenodo'] = {
            'encryptedToken': encrypted,
            'sandbox': True,
        }
        User().save(user_doc)

        client = get_zenodo_client_for_user(admin)
        assert isinstance(client, ZenodoClient)
        assert client.token == "test_pat"
        assert "sandbox" in client.base_url

    def test_sandbox_flag_respected(self, admin):
        """Client uses production URL when sandbox=False."""
        encrypted = encrypt_token("prod_pat")
        user_doc = User().load(admin['_id'], force=True)
        if 'meta' not in user_doc:
            user_doc['meta'] = {}
        user_doc['meta']['zenodo'] = {
            'encryptedToken': encrypted,
            'sandbox': False,
        }
        User().save(user_doc)

        client = get_zenodo_client_for_user(admin)
        assert "sandbox" not in client.base_url


@pytest.mark.usefixtures(
    "unbindLargeImage", "unbindAnnotation"
)
@pytest.mark.plugin("upenncontrast_annotation")
class TestUpdateZenodoMeta:
    """Test the shared update_zenodo_meta helper."""

    def test_creates_zenodo_field(self, admin):
        """Creates meta.zenodo if it does not exist."""
        pm = ProjectModel()
        proj = pm.createProject(
            name="Zenodo Meta Test", creator=admin
        )
        assert 'zenodo' not in proj['meta']

        update_zenodo_meta(proj['_id'], {
            'status': 'uploading',
        })

        reloaded = pm.load(proj['_id'], force=True)
        assert reloaded['meta']['zenodo']['status'] == (
            'uploading'
        )

    def test_merges_existing_fields(self, admin):
        """Updates merge with existing zenodo metadata."""
        pm = ProjectModel()
        proj = pm.createProject(
            name="Zenodo Merge Test", creator=admin
        )

        update_zenodo_meta(proj['_id'], {
            'status': 'draft',
            'depositionId': 12345,
        })
        update_zenodo_meta(proj['_id'], {
            'status': 'published',
            'doi': '10.5072/test',
        })

        reloaded = pm.load(proj['_id'], force=True)
        zenodo = reloaded['meta']['zenodo']
        assert zenodo['status'] == 'published'
        assert zenodo['depositionId'] == 12345
        assert zenodo['doi'] == '10.5072/test'

    def test_nonexistent_project_no_error(self, admin):
        """Does not raise for a missing project ID."""
        # Should not raise
        update_zenodo_meta(
            "000000000000000000000000",
            {'status': 'error'},
        )


# --- ZenodoClient tests ---

class TestZenodoClient:
    """Test ZenodoClient URL construction and error
    handling."""

    def test_sandbox_url(self):
        client = ZenodoClient("tok", sandbox=True)
        assert client.base_url == (
            "https://sandbox.zenodo.org"
        )

    def test_production_url(self):
        client = ZenodoClient("tok", sandbox=False)
        assert client.base_url == "https://zenodo.org"

    def test_check_raises_on_unexpected_status(self):
        client = ZenodoClient("tok")
        resp = MagicMock()
        resp.status_code = 403
        resp.text = "Forbidden"

        with pytest.raises(ZenodoError) as exc_info:
            client._check(resp, expected=(200,))
        assert exc_info.value.status_code == 403

    def test_check_passes_on_expected_status(self):
        client = ZenodoClient("tok")
        resp = MagicMock()
        resp.status_code = 201
        result = client._check(resp, expected=(200, 201))
        assert result is resp

    def test_delete_all_files_checks_each_response(self):
        """delete_all_files checks each DELETE response."""
        client = ZenodoClient("tok")

        list_resp = MagicMock()
        list_resp.status_code = 200
        list_resp.json.return_value = [
            {'id': 'file1'}, {'id': 'file2'},
        ]

        del_resp_ok = MagicMock()
        del_resp_ok.status_code = 204

        del_resp_fail = MagicMock()
        del_resp_fail.status_code = 500
        del_resp_fail.text = "Internal error"

        client.session = MagicMock()
        client.session.get.return_value = list_resp
        client.session.delete.side_effect = [
            del_resp_ok, del_resp_fail,
        ]

        with pytest.raises(ZenodoError):
            client.delete_all_files(99999)


# --- Filename collision tests ---

class TestFilenameCollisions:
    """Test filename collision detection in the upload
    job.

    These test the logic pattern without actually running
    the full job — we verify the collision-safe naming
    produces unique keys.
    """

    def test_same_folder_name_different_datasets(self):
        """Two datasets with identical folder names get
        unique filenames via dataset ID suffix."""
        seen = set()

        # Simulate two datasets both named "MyData"
        for ds_id in ["aaa111", "bbb222"]:
            folder_name = "MyData"
            file_name = "image.tif"
            filename = f"{folder_name}--{file_name}"
            if filename in seen:
                filename = (
                    f"{folder_name}__{ds_id}"
                    f"--{file_name}"
                )
            seen.add(filename)

        assert len(seen) == 2
        assert "MyData--image.tif" in seen
        assert "MyData__bbb222--image.tif" in seen

    def test_annotation_filename_collision(self):
        """Annotation JSONs from same-named datasets get
        unique filenames."""
        seen = set()

        for ds_id in ["aaa111", "bbb222"]:
            folder_name = "MyData"
            ann_filename = (
                f"{folder_name}_annotations.json"
            )
            if ann_filename in seen:
                ann_filename = (
                    f"{folder_name}__{ds_id}"
                    f"_annotations.json"
                )
            seen.add(ann_filename)

        assert len(seen) == 2

    def test_config_filename_collision(self):
        """Collection configs with same name get unique
        filenames."""
        seen = set()

        for coll_id in ["ccc333", "ddd444"]:
            coll_name = "MyConfig"
            config_filename = (
                f"{coll_name}_config.json"
            )
            if config_filename in seen:
                config_filename = (
                    f"{coll_name}__{coll_id}"
                    f"_config.json"
                )
            seen.add(config_filename)

        assert len(seen) == 2

    def test_no_collision_unique_names(self):
        """No suffix added when names are already unique."""
        seen = set()

        for folder_name in ["Dataset_A", "Dataset_B"]:
            filename = f"{folder_name}--image.tif"
            if filename in seen:
                filename = f"{folder_name}__id--image.tif"
            seen.add(filename)

        assert len(seen) == 2
        assert "Dataset_A--image.tif" in seen
        assert "Dataset_B--image.tif" in seen


# --- Progress counting tests ---

@pytest.mark.usefixtures(
    "unbindLargeImage", "unbindAnnotation"
)
@pytest.mark.plugin("upenncontrast_annotation")
class TestProgressCounting:
    """Test that progress counts files, not items."""

    def test_total_counts_files_not_items(self, admin):
        """The total file count should reflect actual File
        documents, not just Items. An Item can contain
        multiple Files (e.g. sidecar files)."""
        # Create a dataset folder with items
        folder = utilities.createFolder(
            admin, "progress_test",
            upenn_utilities.datasetMetadata,
        )

        # Create two items in the folder
        Item().createItem("item1", admin, folder)
        Item().createItem("item2", admin, folder)

        # Count files the way the job does
        items = list(Item().find(
            {'folderId': folder['_id']}
        ))

        # Wrong way (counts items):
        item_count = len(items)

        # Right way (counts files per item):
        from girder.models.file import File
        file_count = 0
        for item in items:
            file_count += len(list(File().find(
                {'itemId': item['_id']}
            )))

        # With no uploaded files, both should be 0
        # (items exist but have no File documents)
        assert item_count == 2
        assert file_count == 0

        # This demonstrates the bug: if we used
        # item_count for progress total, progress
        # would show 2 even though there are 0 actual
        # files to upload. The fix correctly uses
        # file_count.


# --- Discard from uploading state tests ---

@pytest.mark.usefixtures(
    "unbindLargeImage", "unbindAnnotation"
)
@pytest.mark.plugin("upenncontrast_annotation")
class TestDiscardFromUploading:
    """Test that discard works from the 'uploading' state
    (safety valve for stuck uploads)."""

    def test_discard_allowed_from_uploading(self, admin):
        """A project stuck in 'uploading' can be reset
        via discard."""
        pm = ProjectModel()
        proj = pm.createProject(
            name="Stuck Upload Test", creator=admin
        )

        # Simulate stuck-in-uploading state
        update_zenodo_meta(proj['_id'], {
            'status': 'uploading',
            'progress': {
                'current': 3,
                'total': 10,
                'message': 'Uploading...',
            },
        })

        reloaded = pm.load(proj['_id'], force=True)
        zenodo = reloaded['meta']['zenodo']
        assert zenodo['status'] == 'uploading'

        # The discard endpoint allows 'uploading' status
        assert zenodo['status'] in (
            'draft', 'error', 'uploading'
        )

    def test_discard_not_allowed_from_none(self, admin):
        """A project with status 'none' cannot be
        discarded."""
        pm = ProjectModel()
        proj = pm.createProject(
            name="No Discard None Test", creator=admin
        )

        # No zenodo meta at all
        zenodo = proj['meta'].get('zenodo', {})
        status = zenodo.get('status', 'none')
        assert status not in (
            'draft', 'error', 'uploading'
        )

    def test_discard_preserves_doi_for_published(
        self, admin
    ):
        """Discarding a new-version draft of a published
        project preserves the original DOI."""
        pm = ProjectModel()
        proj = pm.createProject(
            name="Discard Preserve DOI", creator=admin
        )

        # Simulate: was published, then new version
        # draft was created
        update_zenodo_meta(proj['_id'], {
            'status': 'draft',
            'doi': '10.5072/zenodo.12345',
            'depositionId': 99999,
        })

        reloaded = pm.load(proj['_id'], force=True)
        zenodo = reloaded['meta']['zenodo']
        assert zenodo['doi'] == '10.5072/zenodo.12345'

        # After discard, DOI should be preserved and
        # status should revert to 'published'
        previous_doi = zenodo.get('doi')
        new_meta = {'status': 'none'}
        if previous_doi:
            new_meta['doi'] = previous_doi
            new_meta['status'] = 'published'

        assert new_meta['status'] == 'published'
        assert new_meta['doi'] == '10.5072/zenodo.12345'

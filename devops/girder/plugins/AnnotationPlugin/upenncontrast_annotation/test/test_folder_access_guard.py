"""Tests for the folder-access guard.

The guard (see `server/helpers/folder_access_guard.py`) prevents
non-admin folder owners from removing themselves from the access list
of a `contrastDataset` folder. Site admins can override (recovery
path); non-contrastDataset folders are unaffected.
"""
import json

import pytest

from pytest_girder.assertions import assertStatus, assertStatusOk

from girder.constants import AccessType
from girder.exceptions import ValidationException
from girder.models.folder import Folder

from . import girder_utilities as utilities
from . import upenn_testing_utilities as upenn_utilities


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestFolderAccessGuard:
    def testOwnerCannotEmptyAccessViaRestEndpoint(self, user, server):
        """PUT /folder/{id}/access with empty users list is rejected."""
        dataset = utilities.createFolder(
            user, "guarded-empty", upenn_utilities.datasetMetadata
        )

        resp = server.request(
            path=f"/folder/{dataset['_id']}/access",
            method="PUT",
            user=user,
            params={"access": json.dumps({"users": [], "groups": []})},
        )
        assertStatus(resp, 400)
        assert "creator" in resp.json["message"].lower()

        # And the folder retains the creator's ADMIN access.
        reloaded = Folder().load(dataset["_id"], force=True)
        admin_entries = [
            u for u in reloaded["access"]["users"]
            if u["id"] == user["_id"]
            and u["level"] == AccessType.ADMIN
        ]
        assert len(admin_entries) == 1

    def testOwnerCannotDemoteSelfBelowAdmin(self, user, server):
        """Owner can't downgrade their own access to READ either."""
        dataset = utilities.createFolder(
            user, "guarded-demote", upenn_utilities.datasetMetadata
        )

        bad_acl = {
            "users": [{"id": str(user["_id"]), "level": AccessType.READ}],
            "groups": [],
        }
        resp = server.request(
            path=f"/folder/{dataset['_id']}/access",
            method="PUT",
            user=user,
            params={"access": json.dumps(bad_acl)},
        )
        assertStatus(resp, 400)

    def testOwnerCanShareWithOthers(self, user, admin, server):
        """Adding a second user while keeping owner-as-ADMIN succeeds."""
        dataset = utilities.createFolder(
            user, "guarded-share-ok", upenn_utilities.datasetMetadata
        )

        good_acl = {
            "users": [
                {"id": str(user["_id"]), "level": AccessType.ADMIN},
                {"id": str(admin["_id"]), "level": AccessType.READ},
            ],
            "groups": [],
        }
        resp = server.request(
            path=f"/folder/{dataset['_id']}/access",
            method="PUT",
            user=user,
            params={"access": json.dumps(good_acl)},
        )
        assertStatusOk(resp)

    def testSiteAdminCanOverride(self, user, admin, server):
        """Site admin can save a folder without the creator (recovery)."""
        dataset = utilities.createFolder(
            user, "guarded-admin-override",
            upenn_utilities.datasetMetadata,
        )

        # Admin sets ACL with only themselves — bypasses the guard.
        admin_only = {
            "users": [{"id": str(admin["_id"]), "level": AccessType.ADMIN}],
            "groups": [],
        }
        resp = server.request(
            path=f"/folder/{dataset['_id']}/access",
            method="PUT",
            user=admin,
            params={"access": json.dumps(admin_only)},
        )
        assertStatusOk(resp)

    def testNonContrastFolderUnaffected(self, user, server):
        """Plain Girder folders (no contrastDataset subtype) are not
        guarded — the upstream Girder behavior is preserved."""
        from girder.models.folder import Folder
        # Create a folder WITHOUT contrastDataset metadata.
        public = utilities.namedFolder(user)
        plain = Folder().createFolder(
            name="plain-folder", creator=user, parent=public
        )

        resp = server.request(
            path=f"/folder/{plain['_id']}/access",
            method="PUT",
            user=user,
            params={"access": json.dumps({"users": [], "groups": []})},
        )
        # Upstream Girder accepts this. The guard must not intercept
        # non-contrastDataset folders.
        assertStatusOk(resp)

    def testModelLayerAlsoGuarded(self, user, admin):
        """Direct setAccessList on a contrastDataset folder is also
        rejected — the guard catches non-REST code paths too."""
        from girder.api import rest
        dataset = utilities.createFolder(
            user, "guarded-model-layer",
            upenn_utilities.datasetMetadata,
        )

        # Simulate a non-admin user attempting a setAccessList that
        # excludes themselves. We have to set up a fake current user
        # because the guard checks `rest.getCurrentUser()`.
        original_get = rest.getCurrentUser
        rest.getCurrentUser = lambda *a, **kw: user
        try:
            with pytest.raises(ValidationException):
                Folder().setAccessList(
                    dataset,
                    {"users": [], "groups": []},
                    save=True,
                    user=user,
                )
        finally:
            rest.getCurrentUser = original_get

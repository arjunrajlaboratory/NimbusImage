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


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestCreatorGuardOnSharePaths:
    """The plugin's share paths check the creator guard before writing
    anything: dataset_view/share writes views and configurations before the
    folder, and project propagation uses bulk updates that fire no folder
    save event, so the save listener alone would either leave a partial
    write or never run."""

    @staticmethod
    def levels(user, dataset, config, view):
        from upenncontrast_annotation.server.models.collection import (
            Collection,
        )
        from upenncontrast_annotation.server.models.datasetView import (
            DatasetView,
        )
        out = []
        for model, doc in ((Folder(), dataset), (Collection(), config),
                           (DatasetView(), view)):
            stored = model.load(doc["_id"], force=True)
            out.append(next((u["level"] for u in stored["access"]["users"]
                             if u["id"] == user["_id"]), None))
        return tuple(out)

    def testCreatorCannotRemoveThemselvesViaDatasetShare(self, user, server):
        from .test_sharing import createDatasetWithView, shareDatasetView
        dataset, config, view = createDatasetWithView(user)

        resp = shareDatasetView(server, user, view, user, -1)

        assertStatus(resp, 400)
        assert "creator" in resp.json["message"].lower()
        # Nothing was written: the views and configuration keep the
        # creator too, not just the folder.
        assert self.levels(user, dataset, config, view) == (
            AccessType.ADMIN, AccessType.ADMIN, AccessType.ADMIN)

    def testCoOwnerCannotDemoteTheCreatorViaDatasetShare(
            self, user, server):
        from girder.models.user import User
        from .test_sharing import createDatasetWithView, shareDatasetView
        coOwner = User().createUser(
            "coowner", "password", "Co", "Owner", "coowner@example.com")
        dataset, config, view = createDatasetWithView(user)
        assertStatusOk(shareDatasetView(
            server, user, view, coOwner, AccessType.ADMIN))

        resp = shareDatasetView(server, coOwner, view, user, AccessType.READ)

        assertStatus(resp, 400)
        assert self.levels(user, dataset, config, view) == (
            AccessType.ADMIN, AccessType.ADMIN, AccessType.ADMIN)

    def testCreatorCannotRemoveThemselvesViaProjectShare(self, user, server):
        from upenncontrast_annotation.server.models.project import Project
        from .test_sharing import createDatasetWithView
        dataset, config, view = createDatasetWithView(user)
        resp = server.request(path="/project", method="POST", user=user,
                              params={"name": "guarded project"})
        assertStatusOk(resp)
        project = resp.json
        assertStatusOk(server.request(
            path=f"/project/{project['_id']}/dataset", method="POST",
            user=user, params={"datasetId": str(dataset["_id"])}))

        resp = server.request(
            path=f"/project/{project['_id']}/share", method="POST",
            user=user, params={"userMailOrUsername": user["login"],
                               "accessType": -1})

        assertStatus(resp, 400)
        assert self.levels(user, dataset, config, view) == (
            AccessType.ADMIN, AccessType.ADMIN, AccessType.ADMIN)
        stored = Project().load(project["_id"], force=True)
        assert any(u["id"] == user["_id"] and u["level"] == AccessType.ADMIN
                   for u in stored["access"]["users"])

    def testOwnerCanStillShareAndRemoveOthers(self, user, server):
        from girder.models.user import User
        from .test_sharing import createDatasetWithView, shareDatasetView
        other = User().createUser(
            "guardother", "password", "G", "Other", "guardother@example.com")
        dataset, config, view = createDatasetWithView(user)

        assertStatusOk(shareDatasetView(
            server, user, view, other, AccessType.WRITE))
        assertStatusOk(shareDatasetView(server, user, view, other, -1))
        assert self.levels(other, dataset, config, view) == (None, None, None)

    def testDamagedDatasetStaysShareable(self, user, server):
        """A dataset whose creator already lost ADMIN (before the guard
        existed, or via a site admin) is not frozen: its other owners can
        still share and rename it. Only taking ADMIN away is refused."""
        from girder.models.user import User
        from .test_sharing import createDatasetWithView, shareDatasetView
        coOwner = User().createUser(
            "dmgowner", "password", "D", "Owner", "dmgowner@example.com")
        third = User().createUser(
            "dmgthird", "password", "D", "Third", "dmgthird@example.com")
        dataset, config, view = createDatasetWithView(user)
        assertStatusOk(shareDatasetView(
            server, user, view, coOwner, AccessType.ADMIN))
        # Damage the folder without a save event, as old data looks.
        stored = Folder().load(dataset["_id"], force=True)
        Folder().update({"_id": dataset["_id"]}, {"$set": {
            "access.users": [
                dict(entry, level=AccessType.READ)
                if entry["id"] == user["_id"] else entry
                for entry in stored["access"]["users"]]}})

        assertStatusOk(shareDatasetView(
            server, coOwner, view, third, AccessType.READ))
        assert self.levels(third, dataset, config, view) == (
            AccessType.READ, AccessType.READ, AccessType.READ)
        assertStatusOk(server.request(
            path=f"/folder/{dataset['_id']}", method="PUT", user=coOwner,
            params={"name": "renamed damaged dataset"}))

    def testFolderCannotBecomeADatasetWithoutCreatorAdmin(
            self, user, server):
        """The damaged-dataset exception covers folders that were already
        datasets. Otherwise clearing the subtype, demoting the creator and
        re-importing the folder would get around the guard."""
        from girder.models.user import User
        coOwner = User().createUser(
            "reimport", "password", "R", "Owner", "reimport@example.com")
        plain = Folder().createFolder(
            name="reimported", creator=user,
            parent=utilities.namedFolder(user))
        Folder().update({"_id": plain["_id"]}, {"$set": {"access.users": [
            {"id": user["_id"], "level": AccessType.WRITE, "flags": []},
            {"id": coOwner["_id"], "level": AccessType.ADMIN, "flags": []},
        ]}})

        resp = server.request(
            path=f"/folder/{plain['_id']}/metadata", method="PUT",
            user=coOwner, body=json.dumps({"subtype": "contrastDataset"}),
            type="application/json")

        assertStatus(resp, 400)
        stored = Folder().load(plain["_id"], force=True)
        assert "subtype" not in (stored.get("meta") or {})

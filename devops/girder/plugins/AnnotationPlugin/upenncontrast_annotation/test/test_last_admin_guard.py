"""Tests for the last-ADMIN guard.

The guard (see `server/helpers/last_admin_guard.py`) refuses any change
that would leave a `contrastDataset` folder or a project with no user at
ADMIN. Who holds ADMIN doesn't matter: the creator can hand a dataset over
and step down. Site admins can override (recovery path); plain Girder
folders are unaffected.
"""
import json

import pytest

from pytest_girder.assertions import assertStatus, assertStatusOk

from girder.constants import AccessType
from girder.exceptions import ValidationException
from girder.models.folder import Folder
from girder.models.group import Group

from upenncontrast_annotation.server.models.collection import Collection
from upenncontrast_annotation.server.models.datasetView import DatasetView
from upenncontrast_annotation.server.models.project import Project

from . import girder_utilities as utilities
from . import upenn_testing_utilities as upenn_utilities
from .test_sharing import createDatasetWithView, createUser, shareDatasetView


def userLevel(model, doc, user):
    stored = model.load(doc["_id"], force=True)
    return next((entry["level"] for entry in stored["access"]["users"]
                 if entry["id"] == user["_id"]), None)


def datasetLevels(user, dataset, config, view):
    """The user's level on the folder, configuration and view."""
    return tuple(userLevel(model, doc, user) for model, doc in (
        (Folder(), dataset), (Collection(), config), (DatasetView(), view)))


def putFolderAccess(server, user, folder, users, groups=()):
    return server.request(
        path=f"/folder/{folder['_id']}/access", method="PUT", user=user,
        params={"access": json.dumps({
            "users": [{"id": str(u["_id"]), "level": level}
                      for u, level in users],
            "groups": [{"id": str(g["_id"]), "level": level}
                       for g, level in groups],
        })})


def createProject(server, user, name="guarded project"):
    resp = server.request(path="/project", method="POST", user=user,
                          params={"name": name})
    assertStatusOk(resp)
    return resp.json


def shareProject(server, sharer, project, target, accessType):
    return server.request(
        path=f"/project/{project['_id']}/share", method="POST", user=sharer,
        params={"userMailOrUsername": target["login"],
                "accessType": accessType})


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestRawFolderAccess:
    """Girder's own PUT folder/{id}/access, guarded by the save listener."""

    def testSoleAdminCannotEmptyAccessViaRestEndpoint(self, user, server):
        dataset = utilities.createFolder(
            user, "guarded-empty", upenn_utilities.datasetMetadata)

        resp = putFolderAccess(server, user, dataset, [])

        assertStatus(resp, 400)
        assert resp.json["message"].startswith('Dataset "guarded-empty" must')
        assert userLevel(Folder(), dataset, user) == AccessType.ADMIN

    def testSoleAdminCannotDemoteSelfViaRestEndpoint(self, user, server):
        dataset = utilities.createFolder(
            user, "guarded-demote", upenn_utilities.datasetMetadata)

        resp = putFolderAccess(
            server, user, dataset, [(user, AccessType.WRITE)])

        assertStatus(resp, 400)
        assert userLevel(Folder(), dataset, user) == AccessType.ADMIN

    def testOwnerCanShareWithOthers(self, user, server):
        other = createUser("rawother")
        dataset = utilities.createFolder(
            user, "guarded-share-ok", upenn_utilities.datasetMetadata)

        assertStatusOk(putFolderAccess(server, user, dataset, [
            (user, AccessType.ADMIN), (other, AccessType.READ)]))

    def testCreatorCanHandOverViaRestEndpoint(self, user, server):
        """Who holds ADMIN doesn't matter: the creator can leave it to
        someone else in the same request."""
        heir = createUser("rawheir")
        dataset = utilities.createFolder(
            user, "guarded-handover", upenn_utilities.datasetMetadata)

        assertStatusOk(putFolderAccess(
            server, user, dataset, [(heir, AccessType.ADMIN)]))

        assert userLevel(Folder(), dataset, user) is None
        assert userLevel(Folder(), dataset, heir) == AccessType.ADMIN

    def testGroupAdminDoesNotCountAsAnAdmin(self, user, server):
        """Group membership is managed elsewhere and a group can be
        emptied, so only a user entry keeps a dataset administrable."""
        group = Group().createGroup("guard-group", user)
        dataset = utilities.createFolder(
            user, "guarded-group", upenn_utilities.datasetMetadata)

        resp = putFolderAccess(
            server, user, dataset, [], groups=[(group, AccessType.ADMIN)])

        assertStatus(resp, 400)
        assert userLevel(Folder(), dataset, user) == AccessType.ADMIN

    def testSiteAdminCanOverride(self, user, admin, server):
        """Site admins can leave a dataset with no ADMIN (recovery)."""
        dataset = utilities.createFolder(
            user, "guarded-admin-override", upenn_utilities.datasetMetadata)

        assertStatusOk(putFolderAccess(server, admin, dataset, []))

    def testNonContrastFolderUnaffected(self, user, server):
        """Plain Girder folders keep upstream behavior."""
        plain = Folder().createFolder(
            name="plain-folder", creator=user,
            parent=utilities.namedFolder(user))

        assertStatusOk(putFolderAccess(server, user, plain, []))

    def testModelLayerAlsoGuarded(self, user):
        """Direct setAccessList on a dataset folder is guarded too, since
        the listener catches every save."""
        from girder.api import rest
        dataset = utilities.createFolder(
            user, "guarded-model-layer", upenn_utilities.datasetMetadata)

        # The guard asks rest.getCurrentUser() who is calling.
        original_get = rest.getCurrentUser
        rest.getCurrentUser = lambda *a, **kw: user
        try:
            with pytest.raises(ValidationException):
                Folder().setAccessList(
                    dataset, {"users": [], "groups": []}, save=True,
                    user=user)
        finally:
            rest.getCurrentUser = original_get

    def testFolderCannotBecomeADatasetWithoutAnAdmin(self, user, server):
        """The damaged-dataset exception covers folders that were already
        datasets. Otherwise clearing the subtype, removing the last ADMIN
        and re-importing the folder would get around the guard."""
        plain = Folder().createFolder(
            name="reimported", creator=user,
            parent=utilities.namedFolder(user))
        Folder().update({"_id": plain["_id"]}, {"$set": {"access.users": [
            {"id": user["_id"], "level": AccessType.WRITE, "flags": []},
        ]}})

        resp = server.request(
            path=f"/folder/{plain['_id']}/metadata", method="PUT",
            user=user, body=json.dumps({"subtype": "contrastDataset"}),
            type="application/json")

        assertStatus(resp, 400)
        stored = Folder().load(plain["_id"], force=True)
        assert "subtype" not in (stored.get("meta") or {})


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestDatasetShare:
    """dataset_view/share checks the rule before writing anything: it
    writes views and configurations before the folder, so the save
    listener alone would leave a partial write."""

    def testLastAdminCannotRemoveThemselvesViaDatasetShare(
            self, user, server):
        dataset, config, view = createDatasetWithView(user)

        resp = shareDatasetView(server, user, view, user, -1)

        assertStatus(resp, 400)
        assert "must keep at least one user with ADMIN" in (
            resp.json["message"])
        assert datasetLevels(user, dataset, config, view) == (
            AccessType.ADMIN, AccessType.ADMIN, AccessType.ADMIN)

    def testLastAdminCannotDemoteThemselvesViaDatasetShare(
            self, user, server):
        dataset, config, view = createDatasetWithView(user)

        resp = shareDatasetView(server, user, view, user, AccessType.WRITE)

        assertStatus(resp, 400)
        assert datasetLevels(user, dataset, config, view) == (
            AccessType.ADMIN, AccessType.ADMIN, AccessType.ADMIN)

    def testCreatorCanTransferOwnershipThenStepDown(self, user, server):
        heir = createUser("dsheir")
        third = createUser("dsthird")
        dataset, config, view = createDatasetWithView(user)
        assertStatusOk(shareDatasetView(
            server, user, view, heir, AccessType.ADMIN))

        assertStatusOk(shareDatasetView(server, user, view, user, -1))

        assert datasetLevels(user, dataset, config, view) == (
            None, None, None)
        # The new owner can administer it: share it on.
        assertStatusOk(shareDatasetView(
            server, heir, view, third, AccessType.ADMIN))

    def testCoOwnerCanRemoveTheCreator(self, user, server):
        coOwner = createUser("dscoowner")
        dataset, config, view = createDatasetWithView(user)
        assertStatusOk(shareDatasetView(
            server, user, view, coOwner, AccessType.ADMIN))

        assertStatusOk(shareDatasetView(server, coOwner, view, user, -1))

        assert datasetLevels(user, dataset, config, view) == (
            None, None, None)
        assert datasetLevels(coOwner, dataset, config, view) == (
            AccessType.ADMIN, AccessType.ADMIN, AccessType.ADMIN)

    def testNewSoleAdminCannotRemoveThemselves(self, user, server):
        heir = createUser("dssole")
        dataset, config, view = createDatasetWithView(user)
        assertStatusOk(shareDatasetView(
            server, user, view, heir, AccessType.ADMIN))
        assertStatusOk(shareDatasetView(server, user, view, user, -1))

        resp = shareDatasetView(server, heir, view, heir, -1)

        assertStatus(resp, 400)
        assert datasetLevels(heir, dataset, config, view) == (
            AccessType.ADMIN, AccessType.ADMIN, AccessType.ADMIN)

    def testSiteAdminCanRemoveTheLastAdminViaDatasetShare(
            self, user, admin, server):
        dataset, config, view = createDatasetWithView(user)

        assertStatusOk(shareDatasetView(server, admin, view, user, -1))

        assert userLevel(Folder(), dataset, user) is None

    def testDamagedDatasetStaysShareable(self, user, server):
        """A dataset that already has no user at ADMIN (damaged before the
        guard existed, or by a site admin) is not frozen: whoever can share
        it still can, and it can still be renamed."""
        editor = createUser("dmgeditor")
        third = createUser("dmgthird")
        dataset, config, view = createDatasetWithView(user)
        assertStatusOk(shareDatasetView(
            server, user, view, editor, AccessType.WRITE))
        # Damage the folder without a save event, as old data looks.
        stored = Folder().load(dataset["_id"], force=True)
        Folder().update({"_id": dataset["_id"]}, {"$set": {
            "access.users": [
                dict(entry, level=AccessType.WRITE)
                if entry["id"] == user["_id"] else entry
                for entry in stored["access"]["users"]]}})

        assertStatusOk(shareDatasetView(
            server, editor, view, third, AccessType.READ))
        assert datasetLevels(third, dataset, config, view) == (
            AccessType.READ, AccessType.READ, AccessType.READ)
        assertStatusOk(server.request(
            path=f"/folder/{dataset['_id']}", method="PUT", user=editor,
            params={"name": "renamed damaged dataset"}))

    def testOwnerCanStillShareAndRemoveOthers(self, user, server):
        other = createUser("guardother")
        dataset, config, view = createDatasetWithView(user)

        assertStatusOk(shareDatasetView(
            server, user, view, other, AccessType.WRITE))
        assertStatusOk(shareDatasetView(server, user, view, other, -1))
        assert datasetLevels(other, dataset, config, view) == (
            None, None, None)


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestProjectShare:
    """project/:id/share checks the project's own ACL and every dataset it
    reaches before writing anything (propagation uses bulk updates that
    fire no save event)."""

    def testLastAdminCannotLeaveAnEmptyProject(self, user, server):
        project = createProject(server, user)

        resp = shareProject(server, user, project, user, -1)

        assertStatus(resp, 400)
        assert resp.json["message"].startswith(
            'Project "guarded project" must keep')
        assert userLevel(Project(), project, user) == AccessType.ADMIN

    def testLastAdminCannotDemoteThemselvesOnAProject(self, user, server):
        project = createProject(server, user)

        resp = shareProject(server, user, project, user, AccessType.READ)

        assertStatus(resp, 400)
        assert userLevel(Project(), project, user) == AccessType.ADMIN

    def testProjectOwnerCanHandOverThenLeave(self, user, server):
        heir = createUser("projheir")
        project = createProject(server, user)
        assertStatusOk(shareProject(
            server, user, project, heir, AccessType.ADMIN))

        assertStatusOk(shareProject(server, user, project, user, -1))

        assert userLevel(Project(), project, user) is None
        assert userLevel(Project(), project, heir) == AccessType.ADMIN

    def testSiteAdminCanRemoveTheLastProjectAdmin(self, user, admin, server):
        project = createProject(server, user)

        assertStatusOk(shareProject(server, admin, project, user, -1))

        assert userLevel(Project(), project, user) is None

    def testLastDatasetAdminCannotLeaveViaProjectShare(self, user, server):
        dataset, config, view = createDatasetWithView(user)
        project = createProject(server, user)
        assertStatusOk(server.request(
            path=f"/project/{project['_id']}/dataset", method="POST",
            user=user, params={"datasetId": str(dataset["_id"])}))

        resp = shareProject(server, user, project, user, -1)

        assertStatus(resp, 400)
        assert datasetLevels(user, dataset, config, view) == (
            AccessType.ADMIN, AccessType.ADMIN, AccessType.ADMIN)
        assert userLevel(Project(), project, user) == AccessType.ADMIN

    def testRefusedProjectShareLeavesTheProjectUnchanged(self, user, server):
        """With a co-owner on the project but none on a dataset it holds,
        leaving is refused on the dataset and nothing is written, the
        project's own ACL included."""
        coOwner = createUser("projcoowner")
        dataset, config, view = createDatasetWithView(user)
        project = createProject(server, user)
        assertStatusOk(shareProject(
            server, user, project, coOwner, AccessType.ADMIN))
        assertStatusOk(server.request(
            path=f"/project/{project['_id']}/dataset", method="POST",
            user=user, params={"datasetId": str(dataset["_id"])}))
        # Adding copied the co-owner's ADMIN onto the dataset; leave them
        # only WRITE there, so the creator is the dataset's last ADMIN.
        assertStatusOk(shareDatasetView(
            server, user, view, coOwner, AccessType.WRITE))

        resp = shareProject(server, user, project, user, -1)

        assertStatus(resp, 400)
        # The dataset that blocked the share is named.
        assert resp.json["message"].startswith(
            'Dataset "%s" must keep' % dataset["name"])
        assert userLevel(Project(), project, user) == AccessType.ADMIN
        assert datasetLevels(user, dataset, config, view) == (
            AccessType.ADMIN, AccessType.ADMIN, AccessType.ADMIN)

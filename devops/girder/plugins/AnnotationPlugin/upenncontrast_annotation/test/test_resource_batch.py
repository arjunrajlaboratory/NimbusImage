"""
Tests for POST /resource/batch: documents must be filtered to the fields the
caller's access level exposes, exactly as GET <kind>/{id} returns them.
"""
import json

import pytest

from pytest_girder.assertions import assertStatus, assertStatusOk

from girder.constants import AccessType
from girder.models.folder import Folder
from girder.models.item import Item

from upenncontrast_annotation.server.helpers import validation
from upenncontrast_annotation.server.models.collection import Collection

from . import girder_utilities as utilities
from . import upenn_testing_utilities as upenn_utilities


USER_PRIVATE_FIELDS = (
    "salt", "email", "otp", "groups", "groupInvites", "emailVerified",
    "status", "access",
)


def getDefaultConfigMetadata():
    return {
        "subtype": "contrastConfiguration",
        "compatibility": {},
        "layers": [],
        "tools": [],
        "propertyIds": [],
        "snapshots": [],
        "scales": {},
    }


def postBatch(server, user, body):
    return server.request(
        path="/resource/batch",
        method="POST",
        user=user,
        body=json.dumps(body),
        type="application/json",
    )


def batch(server, user, body):
    resp = postBatch(server, user, body)
    assertStatusOk(resp)
    return resp.json


def createSharedResources(admin, user):
    """A folder, item and configuration owned by admin, READ-shared."""
    folder = utilities.createPrivateFolder(
        admin, "shared_ds", upenn_utilities.datasetMetadata
    )
    folder = Folder().setUserAccess(
        folder, user, AccessType.READ, save=True
    )
    item = Item().createItem("image.tif", admin, folder)
    config = Collection().createCollection(
        "SharedConfig", admin, folder, getDefaultConfigMetadata()
    )
    config = Collection().setUserAccess(
        config, user, AccessType.READ, save=True
    )
    return folder, item, config


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestResourceBatch:

    def testReadOnlyUserDoesNotReceiveAcl(self, admin, user, server):
        folder, item, config = createSharedResources(admin, user)
        # The raw documents carry an ACL naming both users.
        assert "access" in Folder().load(folder["_id"], force=True)
        assert "access" in Collection().load(config["_id"], force=True)

        result = batch(server, user, {
            "folder": [str(folder["_id"])],
            "item": [str(item["_id"])],
            "upenn_collection": [str(config["_id"])],
        })

        batchFolder = result["folder"][str(folder["_id"])]
        batchConfig = result["upenn_collection"][str(config["_id"])]
        assert "access" not in batchFolder
        assert "access" not in batchConfig
        # Fields the app reads are still present.
        assert batchFolder["name"] == "shared_ds"
        assert batchFolder["meta"] == upenn_utilities.datasetMetadata
        assert batchFolder["creatorId"] == str(admin["_id"])
        assert batchFolder["_accessLevel"] == AccessType.READ
        assert batchConfig["name"] == "SharedConfig"
        assert batchConfig["_accessLevel"] == AccessType.READ
        # Items have no ACL of their own, but the raw document still holds
        # fields Item.filter drops, such as lowerName.
        assert "lowerName" in Item().load(item["_id"], force=True)
        batchItem = result["item"][str(item["_id"])]
        assert "lowerName" not in batchItem
        assert batchItem["name"] == "image.tif"

    def testUserDocumentsOmitPrivateFields(self, admin, user, server):
        # The raw document holds the password hash and email.
        assert "salt" in admin and "email" in admin

        result = batch(server, user, {"user": [str(admin["_id"])]})

        batchAdmin = result["user"][str(admin["_id"])]
        for field in USER_PRIVATE_FIELDS:
            assert field not in batchAdmin, field
        assert batchAdmin["login"] == admin["login"]
        assert batchAdmin["firstName"] == admin["firstName"]

    def testUserSeesOwnEmailButNotSalt(self, user, server):
        result = batch(server, user, {"user": [str(user["_id"])]})

        selfDoc = result["user"][str(user["_id"])]
        assert selfDoc["email"] == user["email"]
        assert "salt" not in selfDoc
        assert "access" not in selfDoc

    def testSiteAdminSeesEmailButNotSalt(self, admin, user, server):
        result = batch(server, admin, {"user": [str(user["_id"])]})

        userDoc = result["user"][str(user["_id"])]
        assert userDoc["email"] == user["email"]
        assert "salt" not in userDoc
        assert "access" not in userDoc

    def testMatchesSingleResourceEndpoints(self, admin, user, server):
        """Each batch document equals what GET <kind>/{id} returns."""
        folder, item, config = createSharedResources(admin, user)
        ids = {
            "folder": str(folder["_id"]),
            "item": str(item["_id"]),
            "upenn_collection": str(config["_id"]),
            "user": str(admin["_id"]),
        }

        result = batch(server, user, {k: [v] for k, v in ids.items()})

        for kind, resourceId in ids.items():
            resp = server.request(
                path="/%s/%s" % (kind, resourceId), method="GET", user=user
            )
            assertStatusOk(resp)
            assert result[kind][resourceId] == resp.json, kind

    def testUnreadableResourcesAreOmitted(self, admin, user, server):
        folder = utilities.createPrivateFolder(
            admin, "private_ds", upenn_utilities.datasetMetadata
        )

        result = batch(server, user, {"folder": [str(folder["_id"])]})

        assert result["folder"] == {}

    @pytest.mark.parametrize("badValue", ["abc", 0, "", {}, False])
    def testNonListIdsAreRejected(self, user, server, badValue):
        resp = postBatch(server, user, {"folder": badValue})

        assertStatus(resp, 400)
        assert "folder must be a list" in resp.json["message"]

    def testMissingNullAndEmptyKindsAreSkipped(self, user, server):
        result = batch(server, user, {"folder": None, "item": []})

        assert result == {}

    @pytest.mark.parametrize("badId", ["notanobjectid", 123])
    def testMalformedIdsAreRejected(self, user, server, badId):
        resp = postBatch(server, user, {"user": [badId]})

        assertStatus(resp, 400)
        assert "user is not a valid id" in resp.json["message"]

    def testTooManyIdsAreRejected(self, admin, user, server, monkeypatch):
        monkeypatch.setattr(validation, "MAX_BATCH_RESOURCE_IDS", 2)

        # The cap counts ids across every kind in the request.
        resp = postBatch(server, user, {
            "folder": [str(admin["_id"])] * 2,
            "user": [str(user["_id"])],
        })

        assertStatus(resp, 400)
        assert "Resource ids exceeds the maximum of 2" in resp.json["message"]

        assertStatusOk(postBatch(server, user, {
            "folder": [str(admin["_id"])], "user": [str(user["_id"])],
        }))

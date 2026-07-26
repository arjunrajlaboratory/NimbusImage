"""
Tests for POST /resource/batch, the bulk id-to-document resolver, and in
particular its optional field projection.
"""
import json

import pytest

from girder.constants import AccessType
from girder.models.folder import Folder
from girder.models.user import User

from pytest_girder.assertions import assertStatus, assertStatusOk

from . import girder_utilities as utilities
from . import upenn_testing_utilities as upenn_utilities


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestResourceBatch:
    def _batch(self, server, user, body):
        return server.request(
            path="/resource/batch",
            method="POST",
            user=user,
            body=json.dumps(body),
            type="application/json",
        )

    def testBatchReturnsWholeDocumentsByDefault(self, admin, server):
        """Omitting `fields` must not change what existing callers receive."""
        folder = utilities.createPrivateFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        resp = self._batch(
            server, admin, {"folder": [str(folder["_id"])]})
        assertStatusOk(resp)
        doc = resp.json["folder"][str(folder["_id"])]
        assert doc["name"] == "ds"
        # A full folder document carries far more than the identifying fields.
        assert "meta" in doc
        assert "parentId" in doc

    def testBatchProjectsOnlyRequestedFields(self, admin, server):
        """`fields` trims the response to the named keys plus _id.

        Resolving thousands of folder NAMES should not ship thousands of whole
        folder documents (each with meta, timestamps, sizes, access), which is
        what forced the client to chunk its requests.
        """
        folder = utilities.createPrivateFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        resp = self._batch(
            server,
            admin,
            {"folder": [str(folder["_id"])], "fields": ["name"]},
        )
        assertStatusOk(resp)
        doc = resp.json["folder"][str(folder["_id"])]
        assert set(doc.keys()) == {"_id", "name"}
        assert doc["name"] == "ds"

    def testBatchProjectionStillEnforcesAccess(self, admin, user, server):
        """A projection must not become a way around the access filter.

        Permission filtering happens inside the Mongo query, so excluding the
        access fields from the projection is safe -- but assert it, because a
        projection that accidentally moved filtering into Python would leak.
        """
        adminFolder = utilities.createPrivateFolder(
            admin, "admin_ds", upenn_utilities.datasetMetadata
        )
        resp = self._batch(
            server,
            user,
            {"folder": [str(adminFolder["_id"])], "fields": ["name"]},
        )
        assertStatusOk(resp)
        assert resp.json.get("folder", {}) == {}

    @pytest.mark.parametrize("fields", [
        "name",                 # not a list
        [123],                  # not strings
        [""],                   # empty key
        ["meta.subtype"],       # dotted path
        ["$where"],             # operator-looking key
    ])
    def testBatchRejectsMalformedFields(self, admin, server, fields):
        """`fields` is caller input on a shape the projection is built from."""
        folder = utilities.createPrivateFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        resp = self._batch(
            server,
            admin,
            {"folder": [str(folder["_id"])], "fields": fields},
        )
        assertStatus(resp, 400)

    def testBatchRejectsMalformedIds(self, admin, server):
        """A bad id is a clean 400, not an uncaught InvalidId 500."""
        resp = self._batch(server, admin, {"folder": ["not-an-object-id"]})
        assertStatus(resp, 400)

    def testBatchNeverReturnsUnexposedFolderFields(self, admin, user, server):
        """The response must not carry fields filtermodel would strip.

        This endpoint hand-builds its response instead of using @filtermodel,
        so nothing strips non-exposed keys. Folder exposes 'public' at READ but
        NOT 'access' -- the document listing which users and groups hold which
        permission levels.
        """
        folder = utilities.createPrivateFolder(
            admin, "shared_ds", upenn_utilities.datasetMetadata
        )
        Folder().setUserAccess(folder, user, AccessType.READ, save=True)

        resp = self._batch(server, user, {"folder": [str(folder["_id"])]})
        assertStatusOk(resp)
        doc = resp.json["folder"][str(folder["_id"])]
        assert doc["name"] == "shared_ds"
        assert "access" not in doc

    def testBatchNeverReturnsUnexposedUserFields(self, admin, user, server):
        """A batch user lookup must not leak credentials or contact details.

        A raw user document holds 'salt' (the bcrypt password hash), 'email',
        'groups' and 'access'; User exposes only _id/admin/created/firstName/
        lastName/login/public at READ. Returning documents unfiltered hands
        any authenticated caller another account's password hash.
        """
        User().update({'_id': admin['_id']}, {'$set': {'public': True}})

        resp = self._batch(server, user, {"user": [str(admin["_id"])]})
        assertStatusOk(resp)
        doc = resp.json.get("user", {}).get(str(admin["_id"]))
        if doc is None:
            pytest.skip("admin user is not readable by this user")
        for secret in ("salt", "email", "access", "groupInvites", "status"):
            assert secret not in doc, (
                "%s must not be returned by resource/batch" % secret
            )

"""
Tests for POST /resource/batch, the bulk id-to-document resolver, and in
particular its optional field projection.
"""
import json

import pytest

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

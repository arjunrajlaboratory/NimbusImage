"""
Tests for GET /upenn_collection/list, the lightweight cross-folder listing
endpoint, and for the folderId requirement on GET /upenn_collection.
"""
import datetime
import json

import pytest

from pytest_girder.assertions import assertStatus, assertStatusOk

from upenncontrast_annotation.server.api import collection as collectionApi
from upenncontrast_annotation.server.models.collection import Collection

from . import girder_utilities as utilities
from . import upenn_testing_utilities as upenn_utilities


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


def createCollection(user, folder, name):
    return Collection().createCollection(
        name=name,
        creator=user,
        folder=folder,
        metadata=getDefaultConfigMetadata(),
        description="%s description" % name,
    )


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestCollectionList:
    def testListRequiresNoFolderAndSpansFolders(self, admin, server):
        """Omitting folderId lists collections from every folder."""
        folderA = utilities.createPrivateFolder(
            admin, "ds_a", upenn_utilities.datasetMetadata
        )
        folderB = utilities.createPrivateFolder(
            admin, "ds_b", upenn_utilities.datasetMetadata
        )
        createCollection(admin, folderA, "collection_a")
        createCollection(admin, folderB, "collection_b")

        resp = server.request(
            path="/upenn_collection/list", method="GET", user=admin
        )
        assertStatusOk(resp)
        names = {c["name"] for c in resp.json["collections"]}
        assert names == {"collection_a", "collection_b"}
        assert resp.json["hasMore"] is False

    def testListFiltersByFolder(self, admin, server):
        """Passing folderId narrows the listing to that folder."""
        folderA = utilities.createPrivateFolder(
            admin, "ds_a", upenn_utilities.datasetMetadata
        )
        folderB = utilities.createPrivateFolder(
            admin, "ds_b", upenn_utilities.datasetMetadata
        )
        createCollection(admin, folderA, "collection_a")
        createCollection(admin, folderB, "collection_b")

        resp = server.request(
            path="/upenn_collection/list",
            method="GET",
            user=admin,
            params={"folderId": str(folderA["_id"])},
        )
        assertStatusOk(resp)
        assert [c["name"] for c in resp.json["collections"]] == [
            "collection_a"
        ]

    def testListOmitsMetadata(self, admin, server):
        """Entries carry identifying fields only, never the meta document."""
        folder = utilities.createPrivateFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        createCollection(admin, folder, "collection_a")

        resp = server.request(
            path="/upenn_collection/list", method="GET", user=admin
        )
        assertStatusOk(resp)
        entry = resp.json["collections"][0]
        assert set(entry.keys()) == {
            "_id",
            "name",
            "description",
            "folderId",
            "creatorId",
            "created",
            "updated",
        }

    def testListPagesWithHasMore(self, admin, server):
        """hasMore reports whether paging further would return anything."""
        folder = utilities.createPrivateFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        for index in range(3):
            createCollection(admin, folder, "collection_%d" % index)

        resp = server.request(
            path="/upenn_collection/list",
            method="GET",
            user=admin,
            params={"limit": 2},
        )
        assertStatusOk(resp)
        assert len(resp.json["collections"]) == 2
        assert resp.json["hasMore"] is True

        resp = server.request(
            path="/upenn_collection/list",
            method="GET",
            user=admin,
            params={"limit": 2, "offset": 2},
        )
        assertStatusOk(resp)
        assert len(resp.json["collections"]) == 1
        assert resp.json["hasMore"] is False

    def testListClampsLimitToMaximum(self, admin, server):
        """A limit above the cap, or the unlimited 0, is clamped."""
        folder = utilities.createPrivateFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        createCollection(admin, folder, "collection_a")

        for limit in (0, collectionApi.MAX_COLLECTION_LIST_LIMIT + 5000):
            resp = server.request(
                path="/upenn_collection/list",
                method="GET",
                user=admin,
                params={"limit": limit},
            )
            assertStatusOk(resp)
            assert len(resp.json["collections"]) == 1
            assert resp.json["hasMore"] is False

    def testListSortsByUpdatedDescendingByDefault(self, admin, server):
        """The default ordering is most recently modified first.

        Do NOT lean on wall-clock ordering here. MongoDB stores datetimes at
        millisecond resolution, so creating one collection and touching another
        can easily land both in the same millisecond -- the sort then has a tie
        and returns an arbitrary order. That made this test pass alone and fail
        whenever a preceding test file shifted the timing. Write the two
        timestamps explicitly so the expected order is unambiguous, and scope
        the request to this folder so collections from elsewhere cannot perturb
        it.
        """
        folder = utilities.createPrivateFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        older = createCollection(admin, folder, "collection_older")
        newer = createCollection(admin, folder, "collection_newer")

        base = datetime.datetime(2026, 1, 1, 12, 0, 0)
        older['updated'] = base
        newer['updated'] = base + datetime.timedelta(hours=1)
        Collection().save(older)
        Collection().save(newer)

        resp = server.request(
            path="/upenn_collection/list",
            method="GET",
            user=admin,
            params={"folderId": str(folder["_id"])},
        )
        assertStatusOk(resp)
        assert [c["name"] for c in resp.json["collections"]] == [
            "collection_newer",
            "collection_older",
        ]

    def testListExcludesCollectionsTheUserCannotRead(
        self, admin, user, server
    ):
        """A user only sees collections they have access to."""
        adminFolder = utilities.createPrivateFolder(
            admin, "admin_ds", upenn_utilities.datasetMetadata
        )
        userFolder = utilities.createPrivateFolder(
            user, "user_ds", upenn_utilities.datasetMetadata
        )
        createCollection(admin, adminFolder, "admin_collection")
        createCollection(user, userFolder, "user_collection")

        resp = server.request(
            path="/upenn_collection/list", method="GET", user=user
        )
        assertStatusOk(resp)
        assert [c["name"] for c in resp.json["collections"]] == [
            "user_collection"
        ]

    def testFindStillRequiresFolderId(self, admin, server):
        """GET /upenn_collection rejects a missing folderId outright."""
        resp = server.request(
            path="/upenn_collection", method="GET", user=admin
        )
        assertStatus(resp, 400)

    @pytest.mark.parametrize("path", ["/upenn_collection/list",
                                      "/upenn_collection"])
    def testMalformedFolderIdIsA400(self, admin, server, path):
        """A bad folderId is a clean 400, never an uncaught InvalidId 500."""
        resp = server.request(
            path=path,
            method="GET",
            user=admin,
            params={"folderId": "not-an-object-id"},
        )
        assertStatus(resp, 400)

    def testNegativeOneLimitCannotBypassTheCap(self, admin, server):
        """limit=-1 must not reach Mongo as the unlimited sentinel.

        The endpoint reads limit+1 rows to compute hasMore, so an unclamped
        limit=-1 becomes limit+1 == 0 -- which Girder treats as "no limit".
        That would materialize every accessible collection and return all but
        the last, bypassing MAX_COLLECTION_LIST_LIMIT entirely.
        """
        folder = utilities.createPrivateFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        for index in range(3):
            createCollection(admin, folder, "collection_%d" % index)

        resp = server.request(
            path="/upenn_collection/list",
            method="GET",
            user=admin,
            params={"limit": -1},
        )
        assertStatusOk(resp)
        # Clamped to a page of 1, not "everything but the last row".
        assert len(resp.json["collections"]) == 1
        assert resp.json["hasMore"] is True

    @pytest.mark.parametrize("params", [
        {"limit": -5},
        {"offset": -5},
        {"limit": "abc"},
        {"offset": "abc"},
    ])
    def testDegeneratePagingParamsNeverReachMongo(
        self, admin, server, params
    ):
        """Negative paging is clamped; non-numeric paging is a 400."""
        folder = utilities.createPrivateFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        createCollection(admin, folder, "collection_a")

        resp = server.request(
            path="/upenn_collection/list",
            method="GET",
            user=admin,
            params=params,
        )
        if isinstance(params.get("limit"), str) or isinstance(
            params.get("offset"), str
        ):
            assertStatus(resp, 400)
        else:
            assertStatusOk(resp)
            assert len(resp.json["collections"]) == 1

    def testSortIsRestrictedToReturnedFields(self, admin, server):
        """A sort key outside the returned fields is rejected."""
        resp = server.request(
            path="/upenn_collection/list",
            method="GET",
            user=admin,
            params={"sort": "meta"},
        )
        assertStatus(resp, 400)

        resp = server.request(
            path="/upenn_collection/list",
            method="GET",
            user=admin,
            params={"sort": "name"},
        )
        assertStatusOk(resp)

    def testFindByFoldersRejectsMalformedBodies(self, admin, server):
        """findByFolders answers 400, not 500, on a degenerate payload."""
        for body in [{}, {"folderIds": "abc"}, {"folderIds": ["nope"]}]:
            resp = server.request(
                path="/upenn_collection/by_folders",
                method="POST",
                user=admin,
                body=json.dumps(body),
                type="application/json",
            )
            assertStatus(resp, 400)

    def _byFolders(self, server, admin, folder, params=None):
        return server.request(
            path="/upenn_collection/by_folders",
            method="POST",
            user=admin,
            params=params or {},
            body=json.dumps({"folderIds": [str(folder["_id"])]}),
            type="application/json",
        )

    def testFindByFoldersClampsLimit(self, admin, server, monkeypatch):
        """by_folders is public and returns WHOLE documents, meta included, so
        an unclamped limit lets one request materialize everything the caller
        can read. limit=0 is Girder's "unlimited" sentinel and must be capped
        exactly as /list caps it.

        The real ceiling is 10,000, which no test fixture can exceed, so shrink
        the constant instead: with a cap of 2 and 3 collections present, an
        unclamped limit=0 returns 3 and a clamped one returns 2. Without this
        the assertion is vacuous and passes with or without the clamp.
        """
        monkeypatch.setattr(
            collectionApi, "MAX_COLLECTION_LIST_LIMIT", 2)
        folder = utilities.createPrivateFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        for index in range(3):
            createCollection(admin, folder, "collection_%d" % index)

        # limit=0 means "as many as the cap allows", not "unlimited".
        resp = self._byFolders(server, admin, folder, {"limit": 0})
        assertStatusOk(resp)
        assert len(resp.json) == 2

        # Above the cap clamps down to it.
        resp = self._byFolders(server, admin, folder, {"limit": 99})
        assertStatusOk(resp)
        assert len(resp.json) == 2

        # Negative limits clamp to a single-row page, never to the sentinel.
        for limit in (-1, -5):
            resp = self._byFolders(server, admin, folder, {"limit": limit})
            assertStatusOk(resp)
            assert len(resp.json) == 1

        # A negative offset must not reach PyMongo, which raises on it.
        resp = self._byFolders(server, admin, folder, {"offset": -5})
        assertStatusOk(resp)

    def testFindByFoldersRestrictsSortToReturnedFields(self, admin, server):
        """A free-form sort key lets a public caller force a blocking sort over
        every accessible document, including on the large 'meta' subdocument.
        The index added for /list covers only its own default sort."""
        folder = utilities.createPrivateFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        createCollection(admin, folder, "collection_a")

        assertStatus(
            self._byFolders(server, admin, folder, {"sort": "meta"}), 400)
        assertStatus(
            self._byFolders(server, admin, folder, {"sort": "access"}), 400)
        assertStatusOk(
            self._byFolders(server, admin, folder, {"sort": "name"}))
        # The endpoint's own default sort must stay acceptable.
        assertStatusOk(
            self._byFolders(server, admin, folder, {"sort": "lowerName"}))

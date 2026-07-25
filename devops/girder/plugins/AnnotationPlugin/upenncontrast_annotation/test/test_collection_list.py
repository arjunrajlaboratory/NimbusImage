"""
Tests for GET /upenn_collection/list, the lightweight cross-folder listing
endpoint, and for the folderId requirement on GET /upenn_collection.
"""
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
        """The default ordering is most recently modified first."""
        folder = utilities.createPrivateFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        first = createCollection(admin, folder, "collection_first")
        createCollection(admin, folder, "collection_second")
        # Touch the older collection so it becomes the most recent.
        Collection().updateFields(first, description="touched")

        resp = server.request(
            path="/upenn_collection/list", method="GET", user=admin
        )
        assertStatusOk(resp)
        assert [c["name"] for c in resp.json["collections"]] == [
            "collection_first",
            "collection_second",
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

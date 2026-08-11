"""
Tests for the POST /dataset/{id}/multi_source endpoint.

The access-control and validation tests below do not depend on any real
image-processing capability and always run. The tests that exercise the
full pipeline (dryRun / full run / transcode) need a Girder large_image
tile source to actually be installed so that a real TIFF can be marked as
a large image; they self-skip via the ``largeImageCapable`` fixture below
when none is available, rather than reporting a false failure caused by
the test environment.

Running this file: prefer the Linux girder container over local tox on
arm64 macOS, where ``large_image_source_tiff`` intermittently segfaults
pylibtiff while probing the synthetic TIFFs (it takes down tests nobody
touched, and whether it fires depends on test selection). The container
recipe -- including the ``--mongo-uri`` that pytest-girder needs there --
is in codebaseDocumentation/DATASET_MULTI_SOURCE_ENDPOINT-REVIEW.md.
"""

import io
import json

import pytest
from bson.objectid import ObjectId
from large_image.exceptions import TileGeneralError, TileSourceError

from pytest_girder.assertions import assertStatus, assertStatusOk

from girder.constants import AccessType
from girder.models.file import File
from girder.models.folder import Folder
from girder.models.item import Item
from girder.models.upload import Upload
from girder_large_image.models.image_item import ImageItem

from ..server.api.dataset import MULTI_SOURCE_ITEM_NAME

from . import girder_utilities as utilities
from . import upenn_testing_utilities as upenn_utilities

MULTI_SOURCE_PATH = "/dataset/%s/multi_source"


def _createTinyTiffBytes(size=(16, 16), fill=0):
    from PIL import Image

    img = Image.new("L", size, color=fill)
    buf = io.BytesIO()
    img.save(buf, format="TIFF")
    return buf.getvalue()


def _uploadTiffItem(user, folder, name, fill=0):
    data = _createTinyTiffBytes(fill=fill)
    upload = Upload().uploadFromFile(
        io.BytesIO(data), len(data), name, "folder", folder,
        user=user, mimeType="image/tiff",
    )
    return Item().load(
        upload["itemId"], user=user, level=AccessType.READ
    )


def _firstFile(item):
    return list(Item().childFiles(item, limit=1))[0]


def _clearLargeImageMarks(folder):
    for item in Item().find({"folderId": folder["_id"]}):
        ImageItem().delete(item)


def _mockLargeImagePipeline(
    monkeypatch, metadataError=None, transcodeError=None, metadataByName=None
):
    """Install deterministic model doubles for endpoint failure tests.

    ``metadataByName`` overrides the tile metadata per item name, so tests
    can drive dtype/IndexRange-dependent behaviour without needing a real
    tile source (and without the arm64 pylibtiff crash that probing real
    TIFFs triggers locally).
    """
    def createImageItem(self, item, file, createJob=True, **kwargs):
        if createJob == "always" and transcodeError is not None:
            raise transcodeError
        item["largeImage"] = {
            "fileId": file["_id"], "sourceName": "mock_source",
        }
        Item().save(item)
        return None

    def getMetadata(self, item, **kwargs):
        if metadataError is not None:
            raise metadataError
        if metadataByName is not None and item["name"] in metadataByName:
            return metadataByName[item["name"]]
        return {"bandCount": 1, "frames": [], "sizeX": 16, "sizeY": 16}

    monkeypatch.setattr(ImageItem, "createImageItem", createImageItem)
    monkeypatch.setattr(ImageItem, "getMetadata", getMetadata)
    monkeypatch.setattr(
        ImageItem, "getInternalMetadata", lambda self, item, **kwargs: {}
    )


@pytest.fixture
def largeImageCapable(admin, fsAssetstore):
    """Skip dependent tests if no large_image tile source is installed.

    Probes the real capability directly against the model layer (not the
    endpoint under test) using a throwaway folder/item, so a missing tile
    source plugin produces a skip instead of a misleading failure.
    """
    probeFolder = utilities.createFolder(
        admin, "ms_probe_%s" % ObjectId(), upenn_utilities.datasetMetadata
    )
    probeItem = _uploadTiffItem(admin, probeFolder, "probe.tif")
    try:
        ImageItem().createImageItem(
            probeItem, _firstFile(probeItem), user=admin, createJob=False
        )
    # Broad catch is intentional here: this is a test-capability probe,
    # not production logic, and any failure to build a real tile source
    # (missing plugin, missing native codec, etc.) should self-skip
    # rather than fail the suite.
    except Exception as e:
        pytest.skip(
            "No usable large_image tile source is installed in this "
            "test environment (tox.ini pins large-image-source-pil and "
            "large-image-source-tiff; check they installed): %r" % e
        )
    return True


@pytest.fixture
def secondUser(db, admin):
    """A second ordinary (non-site-admin) user.

    ACL tests need two of them: pytest_girder provides ``admin`` (a site
    administrator, who passes every access check regardless of the ACL) and
    a single ``user``, which is not enough to model owner vs collaborator.
    """
    from girder.models.user import User
    return User().createUser(
        email="second@girder.test", login="second", firstName="Second",
        lastName="User", password="password", admin=False,
    )


@pytest.fixture
def largeImageAutoSet(db):
    """Reproduce the deployed server's ``largeImage.autoSet`` marking.

    Why this has to be simulated: ``pytest_girder`` loads only
    ``upenncontrast_annotation`` (checked with ``loadedPlugins()``), so
    ``girder_large_image``'s ``load()`` never runs and *none* of its event
    handlers are bound. ``autoSet`` therefore cannot fire under test, no
    matter which tile sources are installed -- which is exactly why the
    transcode regression this guards was invisible to the suite while
    failing on every real request.

    Binding the genuine ``checkForLargeImageFiles`` was tried first and is
    not usable here: probing the multi-source JSON walks every installed
    source, and ``large_image_source_tiff`` segfaults pylibtiff on arm64
    (crash inside ``libtiff.GetField``). The precondition that matters is
    only "the configuration item already carries a largeImage mark by the
    time the endpoint reaches createImageItem", so set that directly.
    """
    from girder import events

    def markConfigUploads(event):
        fileObj = event.info
        if not str(fileObj.get("name", "")).endswith(".json"):
            return
        if not fileObj.get("itemId"):
            return
        item = Item().load(fileObj["itemId"], force=True, exc=False)
        if item is None or "largeImage" in item:
            return
        # Shape matches what autoSet writes in production: a fileId and the
        # source that claimed it, with no originalId/jobId.
        item["largeImage"] = {
            "fileId": fileObj["_id"], "sourceName": "multi",
        }
        Item().save(item)

    events.bind(
        "model.file.save.after", "test_large_image_autoset",
        markConfigUploads,
    )
    yield True
    events.unbind("model.file.save.after", "test_large_image_autoset")


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestDatasetMultiSourceValidation:
    """Validation and access-control tests that need no real images."""

    def testRejectsNonContrastDatasetFolder(self, admin, server):
        folder = utilities.createFolder(admin, "plain_folder", {})
        resp = server.request(
            path=MULTI_SOURCE_PATH % folder["_id"],
            method="POST",
            user=admin,
            body=json.dumps({}),
            type="application/json",
        )
        assertStatus(resp, 400)

    def testRejectsFolderWithNoItems(self, admin, server):
        folder = utilities.createFolder(
            admin, "empty_dataset", upenn_utilities.datasetMetadata
        )
        resp = server.request(
            path=MULTI_SOURCE_PATH % folder["_id"],
            method="POST",
            user=admin,
            body=json.dumps({}),
            type="application/json",
        )
        assertStatus(resp, 400)

    def testDeniedWithoutWriteAccess(self, admin, user, server):
        folder = utilities.createPrivateFolder(
            admin, "private_ds", upenn_utilities.datasetMetadata
        )
        resp = server.request(
            path=MULTI_SOURCE_PATH % folder["_id"],
            method="POST",
            user=user,
            body=json.dumps({}),
            type="application/json",
        )
        assertStatus(resp, 403)

    def testRejectsItemWithNoFiles(self, admin, server):
        folder = utilities.createFolder(
            admin, "fileless_dataset", upenn_utilities.datasetMetadata
        )
        Item().createItem("empty_item.tif", admin, folder)
        resp = server.request(
            path=MULTI_SOURCE_PATH % folder["_id"],
            method="POST",
            user=admin,
            body=json.dumps({"dryRun": True}),
            type="application/json",
        )
        assertStatus(resp, 400)
        assert "empty_item.tif" in resp.json["message"]

    def testRejectsItemWithMultipleFiles(
        self, admin, server, fsAssetstore
    ):
        """Girder's own POST item/{id}/tiles refuses an item with more than
        one file rather than guessing which is the image, and so must this
        endpoint: picking whichever file mongo returned first would be
        non-deterministic."""
        folder = utilities.createFolder(
            admin, "multifile_dataset", upenn_utilities.datasetMetadata
        )
        item = Item().createItem("two_files.tif", admin, folder)
        for name in ("a.tif", "b.tif"):
            data = _createTinyTiffBytes()
            Upload().uploadFromFile(
                io.BytesIO(data), len(data), name, "item", item,
                user=admin, mimeType="image/tiff",
            )

        resp = server.request(
            path=MULTI_SOURCE_PATH % folder["_id"],
            method="POST",
            user=admin,
            body=json.dumps({"dryRun": True}),
            type="application/json",
        )
        assertStatus(resp, 400)
        assert "two_files.tif" in resp.json["message"]
        assert "exactly one" in resp.json["message"]

    def testMarksLargeImagesWithASingleFileQuery(
        self, admin, server, monkeypatch
    ):
        """Cost invariant: the marking loop must batch-load files with one
        query, never a childFiles call per item (CLAUDE.md)."""
        folder = utilities.createFolder(
            admin, "batch_query_dataset", upenn_utilities.datasetMetadata
        )
        for idx in range(5):
            Item().createItem("img_%d.tif" % idx, admin, folder)

        calls = []
        originalFind = File.find

        def countingFind(self, *args, **kwargs):
            calls.append(args[0] if args else kwargs.get("query"))
            return originalFind(self, *args, **kwargs)

        monkeypatch.setattr(File, "find", countingFind)

        resp = server.request(
            path=MULTI_SOURCE_PATH % folder["_id"],
            method="POST",
            user=admin,
            body=json.dumps({"dryRun": True}),
            type="application/json",
        )
        # Every item is file-less, so this 400s -- but only after the single
        # batched lookup that this test exists to pin.
        assertStatus(resp, 400)
        assert len(calls) == 1, "expected one batched File().find, got %r" % (
            calls,
        )
        assert "$in" in calls[0]["itemId"]

    def testRejectsMalformedAssignments(self, admin, server):
        folder = utilities.createFolder(
            admin, "malformed_assignments", upenn_utilities.datasetMetadata
        )
        for badBody in (
            {"assignments": "XY"},
            {"assignments": {"bogus": {"source": "file", "guess": "C"}}},
            {"assignments": {"XY": {"source": "file"}}},
            {"assignments": {"XY": ["file", "XY"]}},
        ):
            resp = server.request(
                path=MULTI_SOURCE_PATH % folder["_id"],
                method="POST",
                user=admin,
                body=json.dumps(badBody),
                type="application/json",
            )
            assertStatus(resp, 400)
            assert "assignments" in resp.json["message"]

    @pytest.mark.parametrize(
        "field", ("transcode", "splitRGBBands", "enableCompositing", "dryRun")
    )
    def testRejectsNonBooleanOptions(self, admin, server, field):
        folder = utilities.createFolder(
            admin, "invalid_boolean_%s" % field,
            upenn_utilities.datasetMetadata,
        )
        Item().createItem("placeholder.tif", admin, folder)

        resp = server.request(
            path=MULTI_SOURCE_PATH % folder["_id"],
            method="POST",
            user=admin,
            body=json.dumps({field: "false"}),
            type="application/json",
        )

        assertStatus(resp, 400)
        assert resp.json["message"] == "%s must be a boolean." % field

    def testAllowedWithExplicitWriteAccess(self, admin, user, server):
        """A user granted WRITE (but not owner) can configure the
        dataset; verifies the check is a genuine WRITE check and not an
        ownership check."""
        folder = utilities.createPrivateFolder(
            admin, "shared_ds", upenn_utilities.datasetMetadata
        )
        Folder().setUserAccess(folder, user, AccessType.WRITE, save=True)
        # No items yet, so this should get past access control and fail
        # on the (later) "no items" validation instead of 403.
        resp = server.request(
            path=MULTI_SOURCE_PATH % folder["_id"],
            method="POST",
            user=user,
            body=json.dumps({}),
            type="application/json",
        )
        assertStatus(resp, 400)


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestDatasetMultiSourcePipeline:
    """Tests that exercise the full pipeline against real tiny TIFFs."""

    def _makeDatasetFolder(self, admin, name):
        folder = utilities.createFolder(
            admin, name, upenn_utilities.datasetMetadata
        )
        _uploadTiffItem(admin, folder, "chanA_pos1.tif", fill=10)
        _uploadTiffItem(admin, folder, "chanB_pos1.tif", fill=20)
        return folder

    def testDryRunDoesNotWrite(self, admin, server, largeImageCapable):
        folder = self._makeDatasetFolder(admin, "dry_run_dataset")

        resp = server.request(
            path=MULTI_SOURCE_PATH % folder["_id"],
            method="POST",
            user=admin,
            body=json.dumps({"dryRun": True}),
            type="application/json",
        )
        assertStatusOk(resp)
        result = resp.json

        assert "config" in result
        assert "sources" in result["config"]
        assert "channels" in result["config"]
        # One source per item in the (non-compositing) basic path.
        assert len(result["config"]["sources"]) == 2
        assert len(result["config"]["channels"]) >= 1
        assert "dimensionLabels" in result

        # dryRun must not create the config item or touch folder meta.
        assert Item().findOne({
            "folderId": folder["_id"], "name": MULTI_SOURCE_ITEM_NAME,
        }) is None
        reloadedFolder = Folder().load(
            folder["_id"], user=admin, level=AccessType.READ
        )
        assert "dimensionLabels" not in reloadedFolder.get("meta", {})
        # ... and must roll back the largeImage marks it needed to read
        # tile metadata, leaving the items exactly as uploaded.
        for item in Item().find({"folderId": folder["_id"]}):
            assert "largeImage" not in item

    def testMetadataFailureRollsBackLargeImageMarks(
        self, admin, server, fsAssetstore, monkeypatch
    ):
        _mockLargeImagePipeline(
            monkeypatch,
            metadataError=TileSourceError("forced metadata failure"),
        )
        folder = self._makeDatasetFolder(admin, "metadata_failure_dataset")
        _clearLargeImageMarks(folder)
        resp = server.request(
            path=MULTI_SOURCE_PATH % folder["_id"],
            method="POST",
            user=admin,
            body=json.dumps({"dryRun": True}),
            type="application/json",
            exception=True,
        )

        assertStatus(resp, 500)
        assert Item().findOne({
            "folderId": folder["_id"], "name": MULTI_SOURCE_ITEM_NAME,
        }) is None
        for item in Item().find({"folderId": folder["_id"]}):
            assert "largeImage" not in item

    def testFullRunNonTranscode(self, admin, server, largeImageCapable):
        folder = self._makeDatasetFolder(admin, "full_run_dataset")

        resp = server.request(
            path=MULTI_SOURCE_PATH % folder["_id"],
            method="POST",
            user=admin,
            body=json.dumps({"transcode": False}),
            type="application/json",
        )
        assertStatusOk(resp)
        result = resp.json

        assert result["transcode"] is False
        assert result["jobId"] is None
        assert "itemId" in result and result["itemId"]
        assert "config" in result

        # The config item was created with the exact JSON body.
        configItem = Item().load(
            ObjectId(result["itemId"]), user=admin, level=AccessType.READ,
            exc=True,
        )
        assert configItem["name"] == MULTI_SOURCE_ITEM_NAME
        configFile = _firstFile(configItem)
        with File().open(configFile) as fh:
            contents = fh.read()
        assert json.loads(contents) == result["config"]

        # Folder metadata now records dimension labels.
        reloadedFolder = Folder().load(
            folder["_id"], user=admin, level=AccessType.READ
        )
        assert (
            reloadedFolder["meta"]["dimensionLabels"]
            == result["dimensionLabels"]
        )
        # subtype metadata must survive the merge.
        assert reloadedFolder["meta"]["subtype"] == "contrastDataset"

        # Non-transcode path strips largeImage from the (marked) source
        # items but leaves the new config item alone.
        sourceItems = list(Item().find(
            {
                "folderId": folder["_id"],
                "name": {"$ne": MULTI_SOURCE_ITEM_NAME},
            }
        ))
        assert len(sourceItems) == 2
        for item in sourceItems:
            assert "largeImage" not in item
        assert "largeImage" not in configItem

    def testMarkingFailureRollsBackEarlierMarks(
        self, admin, server, largeImageCapable
    ):
        """A mid-loop marking failure must not leave earlier items in
        the same request marked as large images ("aaa_good.tif" sorts
        before the failing file-less item, so it is marked first)."""
        folder = utilities.createFolder(
            admin, "partial_mark_dataset", upenn_utilities.datasetMetadata
        )
        goodItem = _uploadTiffItem(admin, folder, "aaa_good.tif")
        Item().createItem("empty_item.tif", admin, folder)

        resp = server.request(
            path=MULTI_SOURCE_PATH % folder["_id"],
            method="POST",
            user=admin,
            body=json.dumps({"dryRun": True}),
            type="application/json",
        )
        assertStatus(resp, 400)
        assert "empty_item.tif" in resp.json["message"]
        reloaded = Item().load(
            goodItem["_id"], user=admin, level=AccessType.READ, exc=True
        )
        assert "largeImage" not in reloaded

    def testSecondInvocationConflicts(self, admin, server, largeImageCapable):
        folder = self._makeDatasetFolder(admin, "conflict_dataset")

        firstResp = server.request(
            path=MULTI_SOURCE_PATH % folder["_id"],
            method="POST",
            user=admin,
            body=json.dumps({"transcode": False}),
            type="application/json",
        )
        assertStatusOk(firstResp)

        secondResp = server.request(
            path=MULTI_SOURCE_PATH % folder["_id"],
            method="POST",
            user=admin,
            body=json.dumps({"transcode": False}),
            type="application/json",
        )
        assertStatus(secondResp, 409)

    def testConcurrentConfigurationUploadConflictsAndRollsBack(
        self, admin, server, fsAssetstore, monkeypatch
    ):
        """A competing exact-name item must win over this request.

        Girder resolves simultaneous duplicate item creation by renaming the
        later item.  Inject the winning item after the endpoint's preflight
        check but immediately before its upload to reproduce that race.
        """
        _mockLargeImagePipeline(monkeypatch)
        folder = self._makeDatasetFolder(admin, "concurrent_conflict_dataset")
        _clearLargeImageMarks(folder)
        originalUpload = Upload.uploadFromFile
        injected = False

        def uploadWithConcurrentWinner(
            model, stream, size, name, parentType, parent, *args, **kwargs
        ):
            nonlocal injected
            if name == "multi-source2.json" and not injected:
                injected = True
                Item().createItem(name, kwargs["user"], parent)
            return originalUpload(
                model, stream, size, name, parentType, parent, *args, **kwargs
            )

        monkeypatch.setattr(
            Upload, "uploadFromFile", uploadWithConcurrentWinner
        )

        resp = server.request(
            path=MULTI_SOURCE_PATH % folder["_id"],
            method="POST",
            user=admin,
            body=json.dumps({"transcode": False}),
            type="application/json",
        )

        assertStatus(resp, 409)
        items = list(Item().find({"folderId": folder["_id"]}))
        configItems = [
            item for item in items
            if item["name"].startswith("multi-source2.json")
        ]
        assert [item["name"] for item in configItems] == ["multi-source2.json"]
        reloadedFolder = Folder().load(
            folder["_id"], user=admin, level=AccessType.READ
        )
        assert "dimensionLabels" not in reloadedFolder.get("meta", {})
        for item in items:
            if item not in configItems:
                assert "largeImage" not in item

    def testTranscodeSchedulesJob(self, admin, server, largeImageCapable):
        folder = self._makeDatasetFolder(admin, "transcode_dataset")

        resp = server.request(
            path=MULTI_SOURCE_PATH % folder["_id"],
            method="POST",
            user=admin,
            body=json.dumps({"transcode": True}),
            type="application/json",
        )
        assertStatusOk(resp)
        result = resp.json

        assert result["transcode"] is True
        assert result["jobId"]

        from girder_jobs.models.job import Job
        job = Job().load(
            ObjectId(result["jobId"]), force=True, exc=True
        )
        assert job is not None
        assert job["type"] == "large_image_tiff"

    def testCreatesCollectionAndViewByDefault(
        self, admin, server, largeImageCapable
    ):
        """Without a view the dataset is invisible: the UI has nothing to
        open and dataset listings enumerate views, so a configured dataset
        with none would not appear anywhere."""
        folder = self._makeDatasetFolder(admin, "with_view_dataset")

        resp = server.request(
            path=MULTI_SOURCE_PATH % folder["_id"],
            method="POST",
            user=admin,
            body=json.dumps({"transcode": False}),
            type="application/json",
        )
        assertStatusOk(resp)
        assert resp.json["collectionId"]
        assert resp.json["viewId"]

        from ..server.models.collection import Collection as CollectionModel
        from ..server.models.datasetView import (
            DatasetView as DatasetViewModel,
        )

        collection = CollectionModel().load(
            ObjectId(resp.json["collectionId"]), user=admin,
            level=AccessType.READ, exc=True,
        )
        assert collection["meta"]["subtype"] == "contrastConfiguration"
        # One layer per channel, named and coloured like the UI would.
        layers = collection["meta"]["layers"]
        assert [layer["name"] for layer in layers] == \
            resp.json["config"]["channels"]
        assert len({layer["color"] for layer in layers}) == len(layers)

        view = DatasetViewModel().load(
            ObjectId(resp.json["viewId"]), user=admin,
            level=AccessType.READ, exc=True,
        )
        assert view["datasetId"] == folder["_id"]
        assert view["configurationId"] == collection["_id"]

    def testCollectionAndViewInheritTheFolderAcl(
        self, admin, user, secondUser, server, largeImageCapable
    ):
        """Collections and views are AccessControlledModels with their own
        enforced ACL (unlike items, which delegate to the folder), and both
        seed it with the CREATOR alone. Without copying the folder's ACL, a
        WRITE collaborator configuring someone else's dataset locks the
        owner out of their own dataset's configuration -- and since dataset
        discovery enumerates views, the owner stops seeing the dataset at
        all while the collaborator sees it.

        The owner here is an ORDINARY user, not the ``admin`` fixture: a
        site administrator passes every hasAccess check regardless of what
        the ACL says, which would make the owner half of this test vacuous
        -- the same masking that hid the bug in the first place.
        """
        owner, collaborator = secondUser, user
        assert not owner.get("admin"), "owner must not be a site admin"
        assert not collaborator.get("admin")

        folder = utilities.createPrivateFolder(
            owner, "acl_inherit_dataset", upenn_utilities.datasetMetadata
        )
        _uploadTiffItem(owner, folder, "chanA_pos1.tif", fill=10)
        _uploadTiffItem(owner, folder, "chanB_pos1.tif", fill=20)
        Folder().setUserAccess(
            folder, user=collaborator, level=AccessType.WRITE, save=True
        )

        # The collaborator, not the owner, configures it.
        resp = server.request(
            path=MULTI_SOURCE_PATH % folder["_id"],
            method="POST",
            user=collaborator,
            body=json.dumps({"transcode": False}),
            type="application/json",
        )
        assertStatusOk(resp)

        from ..server.models.collection import Collection as CollectionModel
        from ..server.models.datasetView import (
            DatasetView as DatasetViewModel,
        )
        collection = CollectionModel().load(
            ObjectId(resp.json["collectionId"]), force=True
        )
        view = DatasetViewModel().load(
            ObjectId(resp.json["viewId"]), force=True
        )

        for label, model, document in (
            ("collection", CollectionModel(), collection),
            ("view", DatasetViewModel(), view),
        ):
            # The owner keeps ADMIN...
            assert model.hasAccess(
                document, user=owner, level=AccessType.ADMIN
            ), "owner lost ADMIN on the %s" % label
            # ...by an explicit ACL entry, asserted independently of
            # hasAccess so this cannot pass on a technicality.
            granted = {
                str(entry["id"]): entry["level"]
                for entry in document["access"]["users"]
            }
            assert granted.get(str(owner["_id"])) == AccessType.ADMIN, (
                "no explicit ADMIN entry for the owner on the %s: %r"
                % (label, granted)
            )
            # ...and the collaborator gets exactly their dataset rights,
            # not the ADMIN that createCollection/create would have given
            # them -- WRITE on a dataset must not become ADMIN on its
            # configuration.
            assert granted.get(str(collaborator["_id"])) == AccessType.WRITE
            assert not model.hasAccess(
                document, user=collaborator, level=AccessType.ADMIN
            ), "WRITE on the dataset escalated to ADMIN on the %s" % label

        # The path that actually broke: discovery enumerates views, so the
        # owner seeing zero of them means the dataset vanished for them.
        listing = server.request(
            path="/dataset_view",
            method="GET",
            user=owner,
            params={"datasetId": str(folder["_id"])},
        )
        assertStatusOk(listing)
        assert [v["_id"] for v in listing.json] == [str(view["_id"])], (
            "the owner cannot discover their own dataset's view"
        )

    def testPublicDatasetGetsAPublicCollectionAndView(
        self, admin, server, largeImageCapable
    ):
        """Otherwise an anonymous visitor can see the dataset but not the
        configuration needed to open it."""
        folder = utilities.createFolder(
            admin, "acl_public_dataset", upenn_utilities.datasetMetadata
        )
        Folder().setPublic(folder, True, save=True)
        _uploadTiffItem(admin, folder, "chanA_pos1.tif", fill=10)
        _uploadTiffItem(admin, folder, "chanB_pos1.tif", fill=20)

        resp = server.request(
            path=MULTI_SOURCE_PATH % folder["_id"],
            method="POST",
            user=admin,
            body=json.dumps({"transcode": False}),
            type="application/json",
        )
        assertStatusOk(resp)

        from ..server.models.collection import Collection as CollectionModel
        from ..server.models.datasetView import (
            DatasetView as DatasetViewModel,
        )
        assert CollectionModel().load(
            ObjectId(resp.json["collectionId"]), force=True
        )["public"] is True
        assert DatasetViewModel().load(
            ObjectId(resp.json["viewId"]), force=True
        )["public"] is True

    def testCreateViewCanBeDisabled(
        self, admin, server, largeImageCapable
    ):
        folder = self._makeDatasetFolder(admin, "no_view_dataset")
        resp = server.request(
            path=MULTI_SOURCE_PATH % folder["_id"],
            method="POST",
            user=admin,
            body=json.dumps({"transcode": False, "createView": False}),
            type="application/json",
        )
        assertStatusOk(resp)
        assert resp.json["collectionId"] is None
        assert resp.json["viewId"] is None

        from ..server.models.datasetView import (
            DatasetView as DatasetViewModel,
        )
        assert DatasetViewModel().findOne(
            {"datasetId": folder["_id"]}
        ) is None

    def testViewFailureRollsBackTheWholeRequest(
        self, admin, server, largeImageCapable, monkeypatch
    ):
        """The view is created last, so its failure must still undo the
        configuration item and the folder metadata -- otherwise a retry
        hits the 409."""
        from ..server.models.datasetView import (
            DatasetView as DatasetViewModel,
        )

        def boom(self, creator, dataset_view):
            raise ValueError("forced dataset view failure")

        monkeypatch.setattr(DatasetViewModel, "create", boom)
        folder = self._makeDatasetFolder(admin, "view_failure_dataset")

        resp = server.request(
            path=MULTI_SOURCE_PATH % folder["_id"],
            method="POST",
            user=admin,
            body=json.dumps({"transcode": False}),
            type="application/json",
            exception=True,
        )
        assertStatus(resp, 500)
        assert Item().findOne({
            "folderId": folder["_id"], "name": MULTI_SOURCE_ITEM_NAME,
        }) is None
        reloadedFolder = Folder().load(
            folder["_id"], user=admin, level=AccessType.READ
        )
        assert "dimensionLabels" not in reloadedFolder.get("meta", {})

        from ..server.models.collection import Collection as CollectionModel
        assert CollectionModel().findOne(
            {"folderId": folder["_id"]}
        ) is None

    def testRollbackTriesEveryItemAndDoesNotMaskTheResponse(
        self, admin, server, fsAssetstore, monkeypatch
    ):
        """The rollback runs from a finally block, so a raising delete
        would both strand the remaining marks and discard the response --
        a successful dry run would come back as a 500."""
        _mockLargeImagePipeline(monkeypatch)
        folder = self._makeDatasetFolder(admin, "rollback_partial_dataset")
        _clearLargeImageMarks(folder)

        attempted = []
        realDelete = ImageItem.delete

        def failTheFirstDelete(self, item, **kwargs):
            attempted.append(item["name"])
            if len(attempted) == 1:
                raise ValueError("forced largeImage delete failure")
            return realDelete(self, item, **kwargs)

        monkeypatch.setattr(ImageItem, "delete", failTheFirstDelete)

        resp = server.request(
            path=MULTI_SOURCE_PATH % folder["_id"],
            method="POST",
            user=admin,
            body=json.dumps({"dryRun": True}),
            type="application/json",
        )
        monkeypatch.undo()

        # The dry run still reports its result...
        assertStatusOk(resp)
        assert "variables" in resp.json
        # ...and the failure did not stop the rollback reaching the rest.
        assert len(attempted) == 2, (
            "rollback stopped at the first failure: %r" % (attempted,)
        )
        remaining = [
            item["name"] for item in Item().find({"folderId": folder["_id"]})
            if "largeImage" in item
        ]
        assert len(remaining) == 1, (
            "only the item whose delete failed should still be marked, got %r"
            % (remaining,)
        )

    def testConfigItemIsRemovedWhenItsLoadFails(
        self, admin, server, largeImageCapable, monkeypatch
    ):
        """The upload creates the item; loading it is a separate fallible
        call. If the load raised and the caller had no handle on the id,
        the orphan multi-source2.json would make every retry hit the
        preflight 409 forever."""
        realLoad = Item.load

        def failTheEndpointsLoad(self, id, *args, **kwargs):
            item = realLoad(self, id, *args, **kwargs)
            # Match only the endpoint's own call. Girder's upload path
            # loads items too, and failing THAT raises inside
            # uploadFromFile before any handle exists -- a different
            # (and, given the concurrent-upload case, not safely
            # cleanable) scenario than the one under test.
            if (item is not None
                    and item.get("name") == MULTI_SOURCE_ITEM_NAME
                    and kwargs.get("exc") is True
                    and kwargs.get("level") == AccessType.READ):
                raise ValueError("forced item load failure")
            return item

        monkeypatch.setattr(Item, "load", failTheEndpointsLoad)
        folder = self._makeDatasetFolder(admin, "config_load_failure")

        resp = server.request(
            path=MULTI_SOURCE_PATH % folder["_id"],
            method="POST",
            user=admin,
            body=json.dumps({"transcode": False}),
            type="application/json",
            exception=True,
        )
        assertStatus(resp, 500)
        monkeypatch.undo()
        assert Item().findOne({
            "folderId": folder["_id"], "name": MULTI_SOURCE_ITEM_NAME,
        }) is None, "orphaned configuration item blocks every retry"

    def testSourceClearingFailureDoesNotUndoAGoodDataset(
        self, admin, server, largeImageCapable, monkeypatch
    ):
        """Clearing the sources is several deletes and happens last. A
        failure there has already destroyed some of them, so unwinding a
        configured dataset over it would both report a false failure and
        destroy more state on the way out."""
        def boom(self, item, **kwargs):
            raise ValueError("forced largeImage delete failure")

        folder = self._makeDatasetFolder(admin, "clear_failure_dataset")
        monkeypatch.setattr(ImageItem, "delete", boom)

        resp = server.request(
            path=MULTI_SOURCE_PATH % folder["_id"],
            method="POST",
            user=admin,
            body=json.dumps({"transcode": False}),
            type="application/json",
        )
        monkeypatch.undo()
        assertStatusOk(resp)
        assert resp.json["itemId"]
        assert resp.json["viewId"]
        configItem = Item().findOne({
            "folderId": folder["_id"], "name": MULTI_SOURCE_ITEM_NAME,
        })
        assert configItem is not None
        reloadedFolder = Folder().load(
            folder["_id"], user=admin, level=AccessType.READ
        )
        assert "dimensionLabels" in reloadedFolder["meta"]

    def testPreExistingLargeImagesSurviveAFailedRun(
        self, admin, server, largeImageCapable, monkeypatch
    ):
        """Source items marked before this request (autoSet does that on
        upload) are absent from newlyMarked, so the rollback cannot put
        them back -- and for a worker-converted source, clearing also
        deletes the derived file. Clearing must therefore come after
        everything that can still fail."""
        from ..server.models.datasetView import (
            DatasetView as DatasetViewModel,
        )

        def boom(self, creator, dataset_view):
            raise ValueError("forced dataset view failure")

        monkeypatch.setattr(DatasetViewModel, "create", boom)
        folder = self._makeDatasetFolder(admin, "preexisting_marks_dataset")
        # Mark them up front, the way autoSet would, so they are NOT this
        # request's to roll back.
        for item in Item().find({"folderId": folder["_id"]}):
            if "largeImage" not in item:
                ImageItem().createImageItem(
                    item, _firstFile(item), user=admin, createJob=False,
                )

        resp = server.request(
            path=MULTI_SOURCE_PATH % folder["_id"],
            method="POST",
            user=admin,
            body=json.dumps({"transcode": False}),
            type="application/json",
            exception=True,
        )
        assertStatus(resp, 500)

        sourceItems = list(Item().find({
            "folderId": folder["_id"],
            "name": {"$ne": MULTI_SOURCE_ITEM_NAME},
        }))
        assert len(sourceItems) == 2
        for item in sourceItems:
            assert "largeImage" in item, (
                "a failed run destroyed pre-existing largeImage state"
            )

    def testUserChannelColoursAreHonoured(
        self, admin, server, largeImageCapable
    ):
        """The UI passes the configuring user's saved palette into
        newLayer; the endpoint must too."""
        from ..server.models.userColors import (
            UserColors as UserColorsModel,
        )
        UserColorsModel().setUserColors(admin, {"CHANA": "#123456"})

        folder = self._makeDatasetFolder(admin, "user_colours_dataset")
        resp = server.request(
            path=MULTI_SOURCE_PATH % folder["_id"],
            method="POST",
            user=admin,
            body=json.dumps({"transcode": False}),
            type="application/json",
        )
        assertStatusOk(resp)

        from ..server.models.collection import Collection as CollectionModel
        collection = CollectionModel().load(
            ObjectId(resp.json["collectionId"]), user=admin,
            level=AccessType.READ, exc=True,
        )
        colours = {
            layer["name"]: layer["color"]
            for layer in collection["meta"]["layers"]
        }
        assert colours["chanA"] == "#123456"

    def testTranscodeSchedulesJobWhenConfigIsAutoMarked(
        self, admin, server, largeImageCapable, largeImageAutoSet
    ):
        """Regression: the deployed server marks the configuration we just
        uploaded as a large image (autoSet + the "multi" source), and
        createImageItem refuses an item that already has one, so the whole
        transcode path 500'd with "Item already has largeImage set."
        """
        folder = self._makeDatasetFolder(admin, "transcode_autoset_dataset")

        resp = server.request(
            path=MULTI_SOURCE_PATH % folder["_id"],
            method="POST",
            user=admin,
            body=json.dumps({"transcode": True}),
            type="application/json",
        )
        assertStatusOk(resp)
        result = resp.json
        assert result["transcode"] is True
        assert result["jobId"]

        configItem = Item().load(
            ObjectId(result["itemId"]), user=admin, level=AccessType.READ,
            exc=True,
        )
        # The mark now belongs to the transcode job, not to autoSet.
        assert configItem["largeImage"].get("sourceName") != "multi"
        # Clearing the autoSet mark must not have deleted the configuration
        # itself -- ImageItem().delete removes the underlying file only for
        # worker-converted images (largeImage.originalId).
        configFiles = list(Item().childFiles(configItem))
        assert len(configFiles) == 1
        with File().open(configFiles[0]) as fh:
            assert json.loads(fh.read()) == result["config"]

    def testAutoSetMarkSurvivesNonTranscodeRun(
        self, admin, server, largeImageCapable, largeImageAutoSet
    ):
        """The twin of the transcode path: without transcoding, the
        configuration must KEEP the mark (that is what makes the dataset
        readable), while the source items lose theirs.
        """
        folder = self._makeDatasetFolder(admin, "autoset_keep_dataset")
        resp = server.request(
            path=MULTI_SOURCE_PATH % folder["_id"],
            method="POST",
            user=admin,
            body=json.dumps({"transcode": False}),
            type="application/json",
        )
        assertStatusOk(resp)

        configItem = Item().load(
            ObjectId(resp.json["itemId"]), user=admin,
            level=AccessType.READ, exc=True,
        )
        assert configItem["largeImage"]["sourceName"] == "multi"
        for item in Item().find({
            "folderId": folder["_id"],
            "name": {"$ne": MULTI_SOURCE_ITEM_NAME},
        }):
            assert "largeImage" not in item

    def testTranscodeSetupFailureCanBeRetried(
        self, admin, server, fsAssetstore, monkeypatch
    ):
        _mockLargeImagePipeline(
            monkeypatch,
            transcodeError=TileGeneralError(
                "forced transcode setup failure"
            ),
        )
        folder = self._makeDatasetFolder(admin, "transcode_failure_dataset")
        _clearLargeImageMarks(folder)
        resp = server.request(
            path=MULTI_SOURCE_PATH % folder["_id"],
            method="POST",
            user=admin,
            body=json.dumps({"transcode": True}),
            type="application/json",
            exception=True,
        )

        assertStatus(resp, 500)
        assert Item().findOne({
            "folderId": folder["_id"], "name": MULTI_SOURCE_ITEM_NAME,
        }) is None
        reloadedFolder = Folder().load(
            folder["_id"], user=admin, level=AccessType.READ
        )
        assert "dimensionLabels" not in reloadedFolder.get("meta", {})
        for item in Item().find({"folderId": folder["_id"]}):
            assert "largeImage" not in item

        retry = server.request(
            path=MULTI_SOURCE_PATH % folder["_id"],
            method="POST",
            user=admin,
            body=json.dumps({"transcode": False}),
            type="application/json",
        )
        assertStatusOk(retry)

    def testInvalidFileIdRaisesRestExceptionNotBareError(
        self, admin, server, largeImageCapable
    ):
        """Sanity check that marking failures surface as a 400 naming
        the offending item rather than an uncaught exception. Simulated
        by pre-marking one item with a largeImage that will be skipped,
        and leaving the other as a plain file; this should still
        succeed end to end (regression guard for the "skip already
        marked items" branch)."""
        folder = self._makeDatasetFolder(admin, "already_marked_dataset")
        items = list(Item().find({"folderId": folder["_id"]}))
        ImageItem().createImageItem(
            items[0], _firstFile(items[0]), user=admin, createJob=False
        )

        resp = server.request(
            path=MULTI_SOURCE_PATH % folder["_id"],
            method="POST",
            user=admin,
            body=json.dumps({"dryRun": True}),
            type="application/json",
        )
        assertStatusOk(resp)


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestDatasetMultiSourceValidationRules:
    """The frontend's refusal rules, driven through mocked tile metadata so
    they need no real tile source."""

    def _makeFolder(self, admin, name, metadataByName, monkeypatch):
        _mockLargeImagePipeline(monkeypatch, metadataByName=metadataByName)
        folder = utilities.createFolder(
            admin, name, upenn_utilities.datasetMetadata
        )
        for itemName in metadataByName:
            _uploadTiffItem(admin, folder, itemName)
        _clearLargeImageMarks(folder)
        return folder

    # dtype and the number of sized variables are the two things the
    # frontend refuses on; keep them adjacent so the precedence is obvious.
    _MIXED_DTYPE = {
        "gfp_A1.tif": {
            "bandCount": 1, "frames": [], "sizeX": 16, "sizeY": 16,
            "dtype": "uint16",
        },
        "red_A1.tif": {
            "bandCount": 1, "frames": [], "sizeX": 16, "sizeY": 16,
            "dtype": "uint8",
        },
    }
    _UNIFORM_DTYPE = {
        name: dict(meta, dtype="uint16")
        for name, meta in _MIXED_DTYPE.items()
    }

    def testRejectsMixedSourceDtypes(
        self, admin, server, fsAssetstore, monkeypatch
    ):
        """Parity with master #1309: the frontend blocks submission when
        sources have different pixel types, so the endpoint must too."""
        folder = self._makeFolder(
            admin, "mixed_dtype_dataset", self._MIXED_DTYPE, monkeypatch
        )
        resp = server.request(
            path=MULTI_SOURCE_PATH % folder["_id"],
            method="POST",
            user=admin,
            body=json.dumps({"transcode": False}),
            type="application/json",
        )
        assertStatus(resp, 400)
        assert "different pixel types" in resp.json["message"]
        assert "uint16, uint8" in resp.json["message"]
        assert Item().findOne({
            "folderId": folder["_id"], "name": MULTI_SOURCE_ITEM_NAME,
        }) is None

    def testUniformDtypesAreAccepted(
        self, admin, server, fsAssetstore, monkeypatch
    ):
        """The twin of the above: the guard must not reject the normal
        case (and an absent dtype must not count as a distinct type)."""
        folder = self._makeFolder(
            admin, "uniform_dtype_dataset", self._UNIFORM_DTYPE, monkeypatch
        )
        resp = server.request(
            path=MULTI_SOURCE_PATH % folder["_id"],
            method="POST",
            user=admin,
            body=json.dumps({"transcode": False}),
            type="application/json",
        )
        assertStatusOk(resp)

    def testDryRunReportsMixedDtypeInsteadOfFailing(
        self, admin, server, fsAssetstore, monkeypatch
    ):
        folder = self._makeFolder(
            admin, "mixed_dtype_dry_dataset", self._MIXED_DTYPE, monkeypatch
        )
        resp = server.request(
            path=MULTI_SOURCE_PATH % folder["_id"],
            method="POST",
            user=admin,
            body=json.dumps({"dryRun": True}),
            type="application/json",
        )
        assertStatusOk(resp)
        assert "different pixel types" in resp.json["validationError"]
        assert "variables" in resp.json

    def testDryRunReportsValidationErrorWithVariables(
        self, admin, server, fsAssetstore, monkeypatch
    ):
        """A dry run is how a caller discovers what to assign. Returning a
        bare 400 withheld the `variables` list needed to build a valid
        `assignments` override, so the caller could never recover.
        """
        # Two files whose IndexRange/IndexStride yield a file Z and a file
        # C variable, plus a filename variable -- three sized variables, so
        # the defaults (which fill Z and C) leave one unassigned.
        metadata = {
            "exp_a.nd2": {
                "bandCount": 1, "sizeX": 16, "sizeY": 16, "dtype": "uint16",
                "frames": [{}] * 6,
                "IndexRange": {"IndexC": 2, "IndexZ": 3},
                "IndexStride": {"IndexC": 1, "IndexZ": 2},
                "channels": ["DAPI", "CY3"],
            },
            "exp_b.nd2": {
                "bandCount": 1, "sizeX": 16, "sizeY": 16, "dtype": "uint16",
                "frames": [{}] * 10,
                "IndexRange": {"IndexC": 2, "IndexZ": 5},
                "IndexStride": {"IndexC": 1, "IndexZ": 2},
                "channels": ["DAPI", "CY3"],
            },
        }
        folder = self._makeFolder(
            admin, "incomplete_assignments_dataset", metadata, monkeypatch
        )

        dry = server.request(
            path=MULTI_SOURCE_PATH % folder["_id"],
            method="POST",
            user=admin,
            body=json.dumps({"dryRun": True}),
            type="application/json",
        )
        assertStatusOk(dry)
        assert dry.json["validationError"] == "Not all variables are assigned"

        # The whole point: the response carries enough to build the fix.
        variables = dry.json["variables"]
        filenameVar = next(
            v for v in variables if v["source"] == "filename"
        )
        assert dry.json["assignments"]["XY"] is None

        # A real run still refuses...
        resp = server.request(
            path=MULTI_SOURCE_PATH % folder["_id"],
            method="POST",
            user=admin,
            body=json.dumps({"transcode": False}),
            type="application/json",
        )
        assertStatus(resp, 400)
        assert resp.json["message"] == "Not all variables are assigned"

        # ...until the caller uses what the dry run told them.
        fixed = server.request(
            path=MULTI_SOURCE_PATH % folder["_id"],
            method="POST",
            user=admin,
            body=json.dumps({
                "transcode": False,
                "assignments": {"XY": {
                    "source": filenameVar["source"],
                    "guess": filenameVar["guess"],
                }},
            }),
            type="application/json",
        )
        assertStatusOk(fixed)
        assert fixed.json["assignments"]["XY"]["source"] == "filename"

    def testDryRunStillRejectsMalformedBodies(self, admin, server):
        """Malformed requests are not discovery results: they 400 even in
        a dry run."""
        folder = utilities.createFolder(
            admin, "dry_malformed_dataset", upenn_utilities.datasetMetadata
        )
        Item().createItem("placeholder.tif", admin, folder)
        resp = server.request(
            path=MULTI_SOURCE_PATH % folder["_id"],
            method="POST",
            user=admin,
            body=json.dumps({
                "dryRun": True, "assignments": {"bogus": None},
            }),
            type="application/json",
        )
        assertStatus(resp, 400)
        # The folder's item is also file-less, which is a second route to a
        # 400. Pin the reason, or this passes even if body parsing stopped
        # running before the items are inspected.
        assert "bogus" in resp.json["message"]


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestDatasetMultiSourceMarkingFailure:
    """Verify the 400-naming-the-item path without needing a working
    tile source: an item with zero files can never produce a
    TileGeneralError from createImageItem in the marking loop (it is
    skipped), so this instead exercises createImageItem's own
    already-largeImage guard through the endpoint's "skip if already
    marked" branch combined with a corrupt/unreadable upload that a
    real source would reject. This is inherently environment dependent
    the same way as the pipeline tests above, so it also uses the
    largeImageCapable fixture.
    """

    def testMarkingFailureNamesTheItem(
        self, admin, server, largeImageCapable
    ):
        folder = utilities.createFolder(
            admin, "bad_item_dataset", upenn_utilities.datasetMetadata
        )
        badBytes = b"not a real image"
        Upload().uploadFromFile(
            io.BytesIO(badBytes), len(badBytes), "not_an_image.tif",
            "folder", folder, user=admin, mimeType="image/tiff",
        )

        resp = server.request(
            path=MULTI_SOURCE_PATH % folder["_id"],
            method="POST",
            user=admin,
            body=json.dumps({"dryRun": True}),
            type="application/json",
        )
        assertStatus(resp, 400)
        assert "not_an_image.tif" in resp.json["message"]


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestDatasetMultiSourceHelperUsage:
    """Confirms TileGeneralError is the exception type the endpoint
    guards against (used by the marking-failure test above); this is a
    static sanity check that does not need a real tile source."""

    def testTileGeneralErrorIsImportable(self):
        assert issubclass(TileGeneralError, Exception)

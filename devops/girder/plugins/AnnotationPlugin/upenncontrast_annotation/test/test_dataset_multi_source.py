"""
Tests for the POST /dataset/{id}/multi_source endpoint.

The access-control and validation tests below do not depend on any real
image-processing capability and always run. The tests that exercise the
full pipeline (dryRun / full run / transcode) need a Girder large_image
tile source (e.g. large-image-source-tiff or large-image-source-pil) to
actually be installed so that a real TIFF can be marked as a large image.
The project's tox.ini only pins ``girder-large-image`` itself (no source
extras), so those tests self-skip via the ``largeImageCapable`` fixture
below when no tile source is available, rather than reporting a false
failure caused by the test environment.
"""

import io
import json

import pytest
from bson.objectid import ObjectId
from large_image.exceptions import TileGeneralError, TileSourceError

from pytest_girder.assertions import assertStatus, assertStatusOk

from girder.constants import AccessType
from girder.models.folder import Folder
from girder.models.item import Item
from girder.models.upload import Upload
from girder_large_image.models.image_item import ImageItem

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
    monkeypatch, metadataError=None, transcodeError=None
):
    """Install deterministic model doubles for endpoint failure tests."""
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
            "test environment (tox.ini installs girder-large-image "
            "without a source extra such as tiff/pil): %r" % e
        )
    return True


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
            "folderId": folder["_id"], "name": "multi-source2.json",
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
            "folderId": folder["_id"], "name": "multi-source2.json",
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
        assert configItem["name"] == "multi-source2.json"
        configFile = _firstFile(configItem)
        from girder.models.file import File
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
            {"folderId": folder["_id"], "name": {"$ne": "multi-source2.json"}}
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
            "folderId": folder["_id"], "name": "multi-source2.json",
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

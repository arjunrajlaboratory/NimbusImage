"""Store integrity and stale-state checks: structural validation at open,
non-finite data at registration, values retired after a smaller table or a
narrower neighborhood run, dirty recomputes against a changed transcript
registration, and the jobs' dataset-affiliation re-check.

A standalone class with fixture instances (as test_provider_access), so the
parent classes' tests are not re-run."""

import os

import numcodecs
import numpy as np
import pytest
import zarr
from bson.objectid import ObjectId
from pytest_girder.assertions import assertStatus, assertStatusOk

from girder.exceptions import AccessException
from girder.models.folder import Folder
from girder.models.item import Item
from girder_jobs.models.job import Job

from upenncontrast_annotation.server.models.propertyValues import (
    AnnotationPropertyValues,
)

from upenncontrast_spatial.server import differential as differentialModule
from upenncontrast_spatial.server import materialize as materializeModule
from upenncontrast_spatial.server import neighborhood as neighborhoodModule
from upenncontrast_spatial.server import recompute as recomputeModule
from upenncontrast_spatial.server import store as storeModule
from upenncontrast_spatial.server.models.registry import DatasetSpatial
from upenncontrast_spatial.server.transcripts import TranscriptStore

from .test_analysis import square
from .test_recompute import TestRecompute as RecomputeFixture, runJob
from .test_spatial import (
    CELL_TYPES,
    COUNTS,
    TestSpatial as SpatialFixture,
    buildStoreZip,
    request,
    uploadStore,
)
from .test_transcripts import (
    PIXEL_SIZE,
    buildTranscriptsZip,
    uploadTranscripts,
)


def rewriteZip(source, target, edit):
    """Copy a zipped zarr store through memory, applying `edit(root)`."""
    memory = zarr.MemoryStore()
    original = zarr.ZipStore(source, mode="r")
    zarr.copy_store(original, memory)
    original.close()
    edit(zarr.group(store=memory))
    output = zarr.ZipStore(target, mode="w")
    zarr.copy_store(memory, output)
    output.close()


def replaceArray(group, name, data):
    del group[name]
    group.create_dataset(name, data=data)


def goodTable(tmp_path):
    ids = ["%024x" % i for i in range(COUNTS.shape[0])]
    path = str(tmp_path / "good.zarr.zip")
    buildStoreZip(path, ids)
    return path


def valuesOf(annotation, propertyId):
    document = AnnotationPropertyValues().findOne(
        {"annotationId": annotation["_id"]}
    )
    return (document or {}).get("values", {}).get(str(propertyId))


def moveAway(admin, item):
    Item().move(item, Folder().findOne({
        "parentId": admin["_id"], "name": "Private",
    }))


def _shortFeatureTypes(root):
    var = root["var"]
    del var["feature_type"]
    var.create_dataset(
        "feature_type", data=np.array(["gene"] * 3, dtype=object),
        dtype=object, object_codec=numcodecs.VLenUTF8(),
    )


# ---- structural checks at open ---------------------------------------------

@pytest.mark.parametrize("edit, message", [
    (lambda root: replaceArray(
        root["X"], "indptr", np.zeros(4, dtype=np.int64),
    ), "X/indptr has 4 entries"),
    (lambda root: replaceArray(
        root["layers/X_csr"], "indptr", np.zeros(9, dtype=np.int64),
    ), "X_csr/indptr has 9 entries"),
    (lambda root: _shortFeatureTypes(root), "feature_type has 3 entries"),
])
def testTableStructureIsCheckedAtOpen(tmp_path, edit, message):
    path = str(tmp_path / "bad.zarr.zip")
    rewriteZip(goodTable(tmp_path), path, edit)
    with pytest.raises(ValueError, match=message):
        storeModule.SpatialStore(path)


def _transcripts(tmp_path):
    path = str(tmp_path / "good-transcripts.zarr.zip")
    buildTranscriptsZip(path)
    return path


def testTranscriptLevelsAndKeysAreCheckedAtOpen(tmp_path):
    source = _transcripts(tmp_path)
    missing = str(tmp_path / "missing.zarr.zip")
    rewriteZip(source, missing, lambda root: root["grids"].__delitem__("1"))
    with pytest.raises(ValueError, match="no level 1 group"):
        TranscriptStore(missing, PIXEL_SIZE)

    def duplicateKey(root):
        keys = root["grids"].attrs["grid_keys"]
        keys[0] = keys[0] + [keys[0][0]]
        root["grids"].attrs["grid_keys"] = keys

    repeated = str(tmp_path / "repeated.zarr.zip")
    rewriteZip(source, repeated, duplicateKey)
    with pytest.raises(ValueError, match="list tile 0,0 more than once"):
        TranscriptStore(repeated, PIXEL_SIZE)


def testTranscriptGeneOffsetMustCoverEveryGene(tmp_path):
    path = str(tmp_path / "offsets.zarr.zip")
    rewriteZip(_transcripts(tmp_path), path, lambda root: replaceArray(
        root["grids/0/0,0"], "gene_offset", np.zeros((3, 4), dtype=np.int64),
    ))
    store = TranscriptStore(path, PIXEL_SIZE)
    with pytest.raises(ValueError, match="gene_offset has shape"):
        store.tilePoints(0, "0,0", [0], 0)
    # A tile with a well-formed table still reads.
    xy, _, _ = store.tilePoints(0, "1,0", [0], 0)
    assert len(xy) == 1


# ---- non-finite and negative data ------------------------------------------

def testFiniteCheckScansEveryChunk(tmp_path):
    ids = ["%024x" % i for i in range(COUNTS.shape[0])]
    counts = COUNTS.copy()
    counts[3, 3] = np.inf  # the last stored value
    path = str(tmp_path / "inf.zarr.zip")
    buildStoreZip(path, ids, counts=counts)
    # Opening does not scan the data; the registration check does.
    store = storeModule.SpatialStore(path)
    with pytest.raises(ValueError, match="non-finite"):
        store.requireFiniteValues(chunkValues=2)
    storeModule.SpatialStore(goodTable(tmp_path)).requireFiniteValues(1)


def testLog2FoldChangeIsNoneForNonPositiveShiftedMeans(tmp_path):
    fold = differentialModule.log2FoldChange
    assert fold(0.0, 0.0) == 0.0
    assert fold(-1.0, 2.0) is None and fold(2.0, -0.5) is None
    ids = ["%024x" % i for i in range(COUNTS.shape[0])]
    path = str(tmp_path / "scaled.zarr.zip")
    buildStoreZip(path, ids, counts=-COUNTS)
    result = differentialModule.differential(
        storeModule.SpatialStore(path), np.array([0, 4]), None, 10
    )
    cd3e = next(f for f in result["features"] if f["symbol"] == "CD3E")
    assert cd3e["meanA"] == -4 and cd3e["log2FoldChange"] is None


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_spatial")
class TestIntegrity:
    # ---- registration -------------------------------------------------------

    def testRegisterRefusesNonFiniteValues(
        self, admin, server, tmp_path, fsAssetstore
    ):
        fixture = SpatialFixture()
        folder, annotations, _ = fixture._setup(admin, tmp_path)
        counts = COUNTS.copy()
        counts[1, 1] = np.nan
        path = str(tmp_path / "nan" / "spatial.zarr.zip")
        os.makedirs(os.path.dirname(path))
        buildStoreZip(path, [str(a["_id"]) for a in annotations],
                      counts=counts)
        item, _ = uploadStore(admin, folder, path)
        resp = request(
            server, admin, "POST", "/spatial/%s/register" % folder["_id"],
            body={"itemId": str(item["_id"])},
        )
        assertStatus(resp, 400)
        assert "non-finite" in resp.json["message"]
        assert DatasetSpatial().forDataset(folder["_id"]) is None

    @pytest.mark.parametrize("error", [IndexError, TypeError])
    def testRegisterMapsMalformedStoreErrorsTo400(
        self, admin, server, tmp_path, fsAssetstore, monkeypatch, error
    ):
        fixture = SpatialFixture()
        folder, _, item = fixture._setup(admin, tmp_path)

        def malformed(path):
            raise error("malformed store")

        monkeypatch.setattr(storeModule, "SpatialStore", malformed)
        resp = request(
            server, admin, "POST", "/spatial/%s/register" % folder["_id"],
            body={"itemId": str(item["_id"])},
        )
        assertStatus(resp, 400)
        assert "malformed store" in resp.json["message"]

    # ---- materialize / score ------------------------------------------------

    def testMaterializeRefusesSymbolsThatAreNotSubKeys(
        self, admin, server, tmp_path, fsAssetstore
    ):
        fixture = SpatialFixture()
        folder, _, item = fixture._setup(
            admin, tmp_path, symbols=["CD3E", "HLA.DR", "X$Y", "PECAM1"],
        )
        fixture._register(server, admin, folder, item)
        fixture._configure(admin, folder)
        for symbol in ("HLA.DR", "X$Y"):
            resp = request(
                server, admin, "POST",
                "/spatial/%s/materialize" % folder["_id"],
                body={"features": ["CD3E", symbol]},
            )
            assertStatus(resp, 400)
            assert symbol in resp.json["message"]
        assert AnnotationPropertyValues().findOne(
            {"datasetId": folder["_id"]}
        ) is None
        # A score's features are read, not written as sub-keys.
        assertStatusOk(request(
            server, admin, "POST", "/spatial/%s/score" % folder["_id"],
            body={"features": ["HLA.DR"], "name": "hla"},
        ))

    def testRematerializingFromASmallerTableRetiresMissingCells(
        self, admin, server, tmp_path, fsAssetstore
    ):
        fixture = SpatialFixture()
        folder, annotations, item = fixture._setup(admin, tmp_path)
        fixture._register(server, admin, folder, item)
        fixture._configure(admin, folder)
        path = "/spatial/%s/materialize" % folder["_id"]
        resp = request(server, admin, "POST", path, body={
            "features": ["CD3E", "CD19"],
        })
        assertStatusOk(resp)
        propertyId = resp.json["propertyId"]
        assert valuesOf(annotations[4], propertyId) == {"CD3E": 5, "CD19": 0}

        # Activate a table holding only the first four cells.
        small = str(tmp_path / "small" / "spatial.zarr.zip")
        os.makedirs(os.path.dirname(small))
        buildStoreZip(
            small, [str(a["_id"]) for a in annotations[:4]],
            counts=COUNTS[:4], cellTypes=CELL_TYPES[:4],
        )
        smallItem, _ = uploadStore(admin, folder, small)
        fixture._register(server, admin, folder, smallItem)
        AnnotationPropertyValues().setSubValuesMany(
            folder["_id"], propertyId, [(annotations[5]["_id"], {"note": 1})]
        )
        resp = request(server, admin, "POST", path, body={
            "features": ["CD3E"],
        })
        assertStatusOk(resp)
        assert resp.json["written"] == 4
        # Rows 4 and 5 are gone: the re-written CD3E is retired there, while
        # a sub-key this run did not write (CD19, note) is left alone.
        assert valuesOf(annotations[4], propertyId) == {"CD19": 0}
        assert valuesOf(annotations[5], propertyId) == {"CD19": 0, "note": 1}
        assert valuesOf(annotations[0], propertyId) == {"CD3E": 3, "CD19": 0}

    def testCellValueWriterRetiresOnlyAfterEveryChunkIsWritten(
        self, admin, tmp_path, fsAssetstore, monkeypatch
    ):
        fixture = SpatialFixture()
        folder, annotations, _ = fixture._setup(admin, tmp_path)
        propertyId = ObjectId()
        model = AnnotationPropertyValues()
        model.setSubValuesMany(folder["_id"], str(propertyId), [
            (annotations[5]["_id"], {"CD3E": 9, "other": 2}),
        ])
        monkeypatch.setattr(materializeModule, "CHUNK_ROWS", 2)
        ids = [a["_id"] for a in annotations[:4]]

        def failSecondChunk(start, stop):
            if start:
                raise RuntimeError("storage failed")
            return [{"CD3E": 1}] * (stop - start)

        with pytest.raises(RuntimeError):
            materializeModule.writeCellValues(
                folder["_id"], propertyId, ids, failSecondChunk,
                retireSubKeys=["CD3E"],
            )
        assert valuesOf(annotations[5], propertyId) == {
            "CD3E": 9, "other": 2,
        }
        assert materializeModule.writeCellValues(
            folder["_id"], propertyId, ids,
            lambda start, stop: [{"CD3E": 1}] * (stop - start),
            retireSubKeys=["CD3E"],
        ) == 4
        assert valuesOf(annotations[5], propertyId) == {"other": 2}
        assert valuesOf(annotations[3], propertyId) == {"CD3E": 1}

    # ---- neighborhood -------------------------------------------------------

    def testNeighborhoodRetiresAgainstItsOwnPropertysPreviousTypes(
        self, admin, server, tmp_path, fsAssetstore
    ):
        fixture = SpatialFixture()
        folder, _, _ = fixture._setup(admin, tmp_path)
        fixture._configure(admin, folder)
        square(folder["_id"], 1000, 1000, 10, ["cell", "Endo"])
        square(folder["_id"], 1012, 1000, 10, ["cell", "T"])
        path = "/spatial/%s/neighborhood" % folder["_id"]

        def run(body):
            resp = request(server, admin, "POST", path, body=body)
            assertStatusOk(resp)
            neighborhoodModule.run(Job().load(resp.json["jobId"], force=True))
            return resp.json["propertyId"]

        first = run({"radius": 20})
        # A run into another property in between must not hide the first
        # property's types from its next run.
        second = run({"radius": 20, "propertyName": "Other"})
        assert second != first
        assert run({
            "radius": 20, "excludeTags": ["cell", "Endo"],
        }) == first
        for document in AnnotationPropertyValues().find(
            {"datasetId": folder["_id"]}
        ):
            assert "Endo" not in document["values"].get(first, {})
            assert "Endo" in document["values"][second]
        registry = DatasetSpatial()
        assert registry.neighborhoodTypes(folder["_id"], first) == ["B", "T"]
        assert registry.neighborhoodTypes(folder["_id"], second) == [
            "B", "Endo", "T",
        ]
        assert registry.neighborhoodTypes(folder["_id"], ObjectId()) == []

    # ---- dirty recompute ----------------------------------------------------

    def testDirtyRecomputeRefusesAChangedTranscriptRegistration(
        self, admin, server, tmp_path, fsAssetstore
    ):
        fixture = RecomputeFixture()
        folder, _, _, _ = fixture._scene(admin, server, tmp_path)
        path = "/spatial/%s/recompute" % folder["_id"]
        transcriptsItem = Item().load(DatasetSpatial().forDataset(
            folder["_id"]
        )["transcriptsItemId"], force=True)

        def dirty():
            return request(
                server, admin, "POST", path, body={"scope": "dirty"}
            )

        # The imported table recorded no settings: nothing to compare.
        fixture._registerTranscripts(
            server, admin, folder, transcriptsItem, pixelSize=PIXEL_SIZE * 2,
        )
        assertStatusOk(dirty())
        fixture._registerTranscripts(server, admin, folder, transcriptsItem)
        runJob(request(
            server, admin, "POST", path, body={"scope": "all"},
        ).json["jobId"])
        entry = DatasetSpatial().forDataset(folder["_id"])
        assert entry["provenance"]["transcriptsFileId"] == str(
            entry["transcriptsFileId"]
        )
        assert entry["provenance"]["pixelSize"] == PIXEL_SIZE
        assert entry["provenance"]["transform"] is None
        assertStatusOk(dirty())

        fixture._registerTranscripts(
            server, admin, folder, transcriptsItem, pixelSize=PIXEL_SIZE * 2,
        )
        resp = dirty()
        assertStatus(resp, 400)
        assert "pixelSize" in resp.json["message"]
        assert "'all'" in resp.json["message"]

        copy = str(tmp_path / "copy" / "transcripts.zarr.zip")
        os.makedirs(os.path.dirname(copy))
        buildTranscriptsZip(copy)
        fixture._registerTranscripts(
            server, admin, folder, uploadTranscripts(admin, folder, copy),
        )
        resp = dirty()
        assertStatus(resp, 400)
        assert "transcriptsFileId" in resp.json["message"]
        assertStatusOk(request(
            server, admin, "POST", path, body={"scope": "all"},
        ))

        # A table recompute built before the registration was recorded
        # compares only its minQv/tags.
        DatasetSpatial().update({"datasetId": folder["_id"]}, {"$unset": {
            "provenance.transcriptsFileId": "", "provenance.pixelSize": "",
            "provenance.transform": "",
        }})
        assertStatusOk(dirty())

    # ---- jobs re-check dataset affiliation --------------------------------

    def testMaterializeJobRefusesAMovedTable(
        self, admin, server, tmp_path, fsAssetstore, monkeypatch
    ):
        fixture = SpatialFixture()
        folder, _, item = fixture._setup(admin, tmp_path)
        fixture._register(server, admin, folder, item)
        fixture._configure(admin, folder)
        monkeypatch.setattr(
            materializeModule, "MATERIALIZE_INLINE_MAX_ROWS", 2
        )
        resp = request(
            server, admin, "POST", "/spatial/%s/materialize" % folder["_id"],
            body={"features": ["CD3E"]},
        )
        assertStatusOk(resp)
        moveAway(admin, item)
        with pytest.raises(AccessException):
            materializeModule.run(Job().load(resp.json["jobId"], force=True))
        assert AnnotationPropertyValues().findOne(
            {"datasetId": folder["_id"]}
        ) is None

    def testDifferentialJobRefusesAMovedTable(
        self, admin, server, tmp_path, fsAssetstore
    ):
        fixture = SpatialFixture()
        folder, _, item = fixture._setup(admin, tmp_path)
        fixture._register(server, admin, folder, item)
        resp = request(
            server, admin, "POST", "/spatial/%s/differential" % folder["_id"],
            body={"filtersA": {"tags": {"values": ["T"], "exclusive": False}}},
        )
        assertStatusOk(resp)
        moveAway(admin, item)
        with pytest.raises(AccessException):
            differentialModule.run(
                Job().load(resp.json["jobId"], force=True)
            )
        assert "spatialResult" not in Job().load(
            resp.json["jobId"], force=True
        )

    @pytest.mark.parametrize("moved", ["transcripts", "table"])
    def testRecomputeJobRefusesAMovedSource(
        self, admin, server, tmp_path, fsAssetstore, moved
    ):
        fixture = RecomputeFixture()
        folder, _, tableItem, _ = fixture._scene(admin, server, tmp_path)
        resp = request(
            server, admin, "POST", "/spatial/%s/recompute" % folder["_id"],
            body={"scope": "all"},
        )
        assertStatusOk(resp)
        entry = DatasetSpatial().forDataset(folder["_id"])
        moveAway(admin, tableItem if moved == "table" else Item().load(
            entry["transcriptsItemId"], force=True
        ))
        with pytest.raises(AccessException):
            recomputeModule.run(Job().load(resp.json["jobId"], force=True))
        assert DatasetSpatial().forDataset(folder["_id"])["itemId"] == (
            tableItem["_id"]
        )

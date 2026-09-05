"""Endpoint tests against a synthetic 6-cell x 4-gene store built the way
anndata writes one (zarr v2: csc_matrix / csr_matrix groups, string-array
and categorical obs columns) so the reader is exercised on the real
encodings without an anndata dependency in the test environment."""

import json
import math
import os

import numpy as np
import numcodecs
import pytest
import zarr
from bson.objectid import ObjectId
from pytest_girder.assertions import assertStatus, assertStatusOk

from girder.models.folder import Folder
from girder.models.item import Item
from girder.models.upload import Upload

from upenncontrast_annotation.server.models.annotation import Annotation
from upenncontrast_annotation.server.models.collection import Collection
from upenncontrast_annotation.server.models.datasetView import DatasetView
from upenncontrast_annotation.server.models.property import (
    AnnotationProperty,
)
from upenncontrast_annotation.server.models.propertyValues import (
    AnnotationPropertyValues,
)

from upenncontrast_spatial.server import store as storeModule

DATASET_METADATA = {"subtype": "contrastDataset"}
SYMBOLS = ["CD3E", "MS4A1", "CD19", "PECAM1"]
CELL_TYPES = ["T", "B", "B", "Endo", "T", "B"]
# rows = cells, columns = SYMBOLS
COUNTS = np.array([
    [3, 0, 0, 0],
    [0, 4, 2, 0],
    [0, 1, 0, 0],
    [0, 0, 0, 7],
    [5, 0, 0, 0],
    [0, 0, 0, 0],
], dtype=np.float32)


def _sparseGroup(root, path, dense, encoding, majorAxis):
    """Write `dense` as anndata does: data/indices/indptr with shape attrs."""
    matrix = dense if majorAxis == "row" else dense.T
    data, indices, indptr = [], [], [0]
    for line in matrix:
        nonzero = np.nonzero(line)[0]
        indices.extend(int(i) for i in nonzero)
        data.extend(float(line[i]) for i in nonzero)
        indptr.append(len(indices))
    group = root.create_group(path)
    group.attrs.update({
        "encoding-type": encoding, "encoding-version": "0.1.0",
        "shape": [int(dense.shape[0]), int(dense.shape[1])],
    })
    group.create_dataset("data", data=np.array(data, dtype=np.float32))
    group.create_dataset("indices", data=np.array(indices, dtype=np.int32))
    group.create_dataset("indptr", data=np.array(indptr, dtype=np.int64))


def _stringArray(group, name, values):
    group.create_dataset(
        name, data=np.array(values, dtype=object), dtype=object,
        object_codec=numcodecs.VLenUTF8(),
    )
    group[name].attrs.update({
        "encoding-type": "string-array", "encoding-version": "0.2.0",
    })


def buildStoreZip(path, annotationIds, counts=COUNTS, symbols=SYMBOLS,
                  cellTypes=CELL_TYPES, withCsr=True):
    zipStore = zarr.ZipStore(path, mode="w")
    root = zarr.group(store=zipStore)
    root.attrs.update({
        "encoding-type": "anndata", "encoding-version": "0.1.0",
    })
    _sparseGroup(root, "X", counts, "csc_matrix", "column")
    if withCsr:
        root.create_group("layers")
        _sparseGroup(root, "layers/X_csr", counts, "csr_matrix", "row")
    obs = root.create_group("obs")
    obs.attrs.update({"_index": "_index", "column-order": [
        "annotation_id", "cell_type",
    ]})
    _stringArray(obs, "_index", [str(i) for i in range(len(annotationIds))])
    _stringArray(obs, "annotation_id", annotationIds)
    categories = sorted(set(cellTypes))
    cellType = obs.create_group("cell_type")
    cellType.attrs.update({
        "encoding-type": "categorical", "encoding-version": "0.2.0",
        "ordered": False,
    })
    cellType.create_dataset("codes", data=np.array(
        [categories.index(value) for value in cellTypes], dtype=np.int8
    ))
    _stringArray(cellType, "categories", categories)
    var = root.create_group("var")
    var.attrs.update({"_index": "_index", "column-order": ["feature_type"]})
    _stringArray(var, "_index", symbols)
    _stringArray(var, "feature_type", ["gene"] * len(symbols))
    zipStore.close()


def makeAnnotation(datasetId, tags):
    return Annotation().create({
        "tags": tags, "shape": "polygon", "channel": 0,
        "location": {"XY": 0, "Z": 0, "Time": 0},
        "coordinates": [
            {"x": 0, "y": 0}, {"x": 10, "y": 0}, {"x": 10, "y": 10},
        ],
        "datasetId": datasetId,
    })


def uploadStore(admin, folder, path):
    with open(path, "rb") as fh:
        fileDoc = Upload().uploadFromFile(
            fh, os.path.getsize(path), "spatial.zarr.zip",
            parentType="folder", parent=folder, user=admin,
            mimeType="application/zip",
        )
    return Item().load(fileDoc["itemId"], force=True), fileDoc


def request(server, user, method, path, body=None, params=None):
    kwargs = {"path": path, "method": method, "user": user}
    if body is not None:
        kwargs.update(body=json.dumps(body), type="application/json")
    if params is not None:
        kwargs["params"] = params
    return server.request(**kwargs)


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_spatial")
class TestSpatial:
    def _setup(self, admin, tmp_path, private=False, withCsr=True):
        """A dataset with six tagged cell annotations and a matching store
        uploaded (not yet registered) into its folder."""
        parent = Folder().find({
            "parentId": admin["_id"],
            "name": "Private" if private else "Public",
        })[0]
        folder = Folder().createFolder(
            name="ds", creator=admin, parent=parent
        )
        Folder().setMetadata(folder, DATASET_METADATA)
        annotations = [
            makeAnnotation(folder["_id"], ["cell", cellType])
            for cellType in CELL_TYPES
        ]
        ids = [str(annotation["_id"]) for annotation in annotations]
        path = str(tmp_path / "spatial.zarr.zip")
        buildStoreZip(path, ids, withCsr=withCsr)
        item, fileDoc = uploadStore(admin, folder, path)
        return folder, annotations, item

    def _register(self, server, admin, folder, item):
        resp = request(
            server, admin, "POST", "/spatial/%s/register" % folder["_id"],
            body={"itemId": str(item["_id"])},
        )
        assertStatusOk(resp)
        return resp.json

    def _configure(self, admin, folder):
        """A configuration + dataset view, which is what materialize
        registers the property into."""
        config = Collection().createCollection(
            name="cfg", creator=admin, folder=folder,
            metadata={
                "subtype": "contrastDataset", "compatibility": {},
                "layers": [], "tools": [], "propertyIds": [],
                "snapshots": [], "scales": {},
            },
        )
        DatasetView().create(admin, {
            "datasetId": folder["_id"], "configurationId": config["_id"],
            "layerContrasts": {},
            "lastLocation": {"xy": 0, "z": 0, "time": 0},
        })
        return config

    # ---- registry -------------------------------------------------------

    def testUnregisteredIs404(self, admin, server, tmp_path, fsAssetstore):
        folder, _, _ = self._setup(admin, tmp_path)
        assertStatus(
            request(server, admin, "GET", "/spatial/%s" % folder["_id"]), 404
        )

    def testRegisterAndSchema(self, admin, server, tmp_path, fsAssetstore):
        folder, annotations, item = self._setup(admin, tmp_path)
        entry = self._register(server, admin, folder, item)
        assert entry["nObs"] == 6 and entry["nVar"] == 4
        assert entry["itemId"] == str(item["_id"])
        resp = request(server, admin, "GET", "/spatial/%s" % folder["_id"])
        assertStatusOk(resp)
        # The live-row count is opt-in (it scans the dataset's ids).
        assert "liveAnnotations" not in resp.json
        assert set(resp.json["obsColumns"]) == {"annotation_id", "cell_type"}
        verify = {"verify": "true"}
        resp = request(
            server, admin, "GET", "/spatial/%s" % folder["_id"], params=verify
        )
        assert resp.json["liveAnnotations"] == 6
        # Deleting a cell shows up as a row that no longer joins.
        Annotation().remove(annotations[0])
        resp = request(
            server, admin, "GET", "/spatial/%s" % folder["_id"], params=verify
        )
        assert resp.json["liveAnnotations"] == 5

    def testRegisterRejectsForeignItemAndBadStore(
        self, admin, server, tmp_path, fsAssetstore
    ):
        folder, _, item = self._setup(admin, tmp_path)
        other = Folder().createFolder(
            name="other", creator=admin,
            parent=Folder().load(folder["parentId"], force=True),
        )
        assertStatus(request(
            server, admin, "POST", "/spatial/%s/register" % other["_id"],
            body={"itemId": str(item["_id"])},
        ), 400)
        garbage = tmp_path / "garbage.zip"
        garbage.write_bytes(b"not a zip")
        badItem, _ = uploadStore(admin, folder, str(garbage))
        assertStatus(request(
            server, admin, "POST", "/spatial/%s/register" % folder["_id"],
            body={"itemId": str(badItem["_id"])},
        ), 400)

    def testRegisterRequiresWrite(
        self, admin, user, server, tmp_path, fsAssetstore
    ):
        folder, _, item = self._setup(admin, tmp_path)
        assertStatus(request(
            server, user, "POST", "/spatial/%s/register" % folder["_id"],
            body={"itemId": str(item["_id"])},
        ), 403)

    def testReadRequiresAccess(
        self, admin, user, server, tmp_path, fsAssetstore
    ):
        folder, _, item = self._setup(admin, tmp_path, private=True)
        self._register(server, admin, folder, item)
        assertStatus(
            request(server, user, "GET", "/spatial/%s" % folder["_id"]), 403
        )

    def testUnregisterForgetsButKeepsItem(
        self, admin, server, tmp_path, fsAssetstore
    ):
        folder, _, item = self._setup(admin, tmp_path)
        self._register(server, admin, folder, item)
        assertStatusOk(
            request(server, admin, "DELETE", "/spatial/%s" % folder["_id"])
        )
        assertStatus(
            request(server, admin, "GET", "/spatial/%s" % folder["_id"]), 404
        )
        assert Item().load(item["_id"], force=True) is not None

    # ---- reads ----------------------------------------------------------

    def testFeatureSearch(self, admin, server, tmp_path, fsAssetstore):
        folder, _, item = self._setup(admin, tmp_path)
        self._register(server, admin, folder, item)
        resp = request(
            server, admin, "GET", "/spatial/%s/features" % folder["_id"],
            params={"search": "cd"},
        )
        assertStatusOk(resp)
        # Prefix matches first (alphabetical), then inner matches.
        assert [f["symbol"] for f in resp.json] == ["CD19", "CD3E"]
        resp = request(
            server, admin, "GET", "/spatial/%s/features" % folder["_id"],
            params={"search": "a", "limit": 1},
        )
        assert [f["symbol"] for f in resp.json] == ["MS4A1"]
        assert resp.json[0]["featureType"] == "gene"

    def testColumnAndRow(self, admin, server, tmp_path, fsAssetstore):
        folder, annotations, item = self._setup(admin, tmp_path)
        self._register(server, admin, folder, item)
        resp = request(
            server, admin, "GET", "/spatial/%s/column" % folder["_id"],
            params={"feature": "MS4A1"},
        )
        assertStatusOk(resp)
        assert resp.json["annotationIds"] == [
            str(annotations[1]["_id"]), str(annotations[2]["_id"]),
        ]
        assert resp.json["values"] == [4, 1]
        resp = request(
            server, admin, "GET", "/spatial/%s/row" % folder["_id"],
            params={"annotationId": str(annotations[1]["_id"])},
        )
        assertStatusOk(resp)
        assert resp.json["values"] == {"MS4A1": 4, "CD19": 2}
        # An annotation of the dataset that has no row.
        stray = makeAnnotation(folder["_id"], ["cell"])
        assertStatus(request(
            server, admin, "GET", "/spatial/%s/row" % folder["_id"],
            params={"annotationId": str(stray["_id"])},
        ), 404)
        assertStatus(request(
            server, admin, "GET", "/spatial/%s/column" % folder["_id"],
            params={"feature": "NOPE"},
        ), 400)

    def testRowNeedsCsrLayer(self, admin, server, tmp_path, fsAssetstore):
        folder, annotations, item = self._setup(
            admin, tmp_path, withCsr=False
        )
        self._register(server, admin, folder, item)
        assertStatus(request(
            server, admin, "GET", "/spatial/%s/row" % folder["_id"],
            params={"annotationId": str(annotations[1]["_id"])},
        ), 400)

    def testAggregate(self, admin, server, tmp_path, fsAssetstore):
        folder, annotations, item = self._setup(admin, tmp_path)
        self._register(server, admin, folder, item)
        path = "/spatial/%s/aggregate" % folder["_id"]
        resp = request(server, admin, "POST", path, body={
            "filters": {}, "features": ["CD3E", "MS4A1"],
        })
        assertStatusOk(resp)
        assert resp.json["total"] == 6 and resp.json["unmatched"] == 0
        cd3e, ms4a1 = resp.json["features"]
        assert math.isclose(cd3e["mean"], 8 / 6)
        assert math.isclose(cd3e["fractionExpressing"], 2 / 6)
        assert math.isclose(ms4a1["mean"], 5 / 6) and ms4a1["expressing"] == 2

        # Same filter object the list endpoints take: B cells only.
        resp = request(server, admin, "POST", path, body={
            "filters": {"tags": {"values": ["B"], "exclusive": False}},
            "features": ["MS4A1", "CD3E"],
        })
        assertStatusOk(resp)
        assert resp.json["total"] == 3
        assert math.isclose(resp.json["features"][0]["mean"], 5 / 3)
        assert resp.json["features"][1]["mean"] == 0

        # A matching annotation without a row is counted as unmatched.
        makeAnnotation(folder["_id"], ["B"])
        resp = request(server, admin, "POST", path, body={
            "filters": {"tags": {"values": ["B"], "exclusive": False}},
            "features": ["MS4A1"],
        })
        assert resp.json["total"] == 3 and resp.json["unmatched"] == 1

        # Empty match is zeros, not an error.
        resp = request(server, admin, "POST", path, body={
            "filters": {"tags": {"values": ["nope"], "exclusive": False}},
            "features": ["MS4A1"],
        })
        assertStatusOk(resp)
        assert resp.json["total"] == 0
        assert resp.json["features"][0]["mean"] is None

    def testAggregateRejectsBadInput(
        self, admin, server, tmp_path, fsAssetstore
    ):
        folder, _, item = self._setup(admin, tmp_path)
        self._register(server, admin, folder, item)
        path = "/spatial/%s/aggregate" % folder["_id"]
        for body in (
            {"features": []},
            {"features": ["NOPE"]},
            {"features": "CD3E"},
            {"features": ["CD3E"], "filters": "tags"},
            {"features": ["CD3E"] * 65},
        ):
            assertStatus(request(server, admin, "POST", path, body=body), 400)

    # ---- materialize ----------------------------------------------------

    def testMaterializeRegistersConfigurationsWithoutReplacement(
        self, admin, server, tmp_path, fsAssetstore, monkeypatch,
    ):
        folder, _, item = self._setup(admin, tmp_path)
        self._register(server, admin, folder, item)
        configs = [self._configure(admin, folder) for _ in range(2)]
        model = Collection()

        def noReplacement(*args, **kwargs):
            pytest.fail('registration must not replace config snapshots')

        monkeypatch.setattr(model, 'setMetadata', noReplacement)
        response = request(server, admin, 'POST',
                           '/spatial/%s/materialize' % folder['_id'], body={
                               'features': ['CD3E'], 'propertyName': 'Batch',
                           })
        assertStatusOk(response)
        for config in configs:
            saved = model.load(config['_id'], force=True)
            assert response.json['propertyId'] in saved['meta']['propertyIds']

    def testMaterializeWritesRegistersAndMerges(
        self, admin, server, tmp_path, fsAssetstore
    ):
        folder, annotations, item = self._setup(admin, tmp_path)
        self._register(server, admin, folder, item)
        config = self._configure(admin, folder)
        path = "/spatial/%s/materialize" % folder["_id"]

        resp = request(server, admin, "POST", path, body={
            "features": ["CD3E", "MS4A1"],
        })
        assertStatusOk(resp)
        propertyId = resp.json["propertyId"]
        assert resp.json["written"] == 6 and resp.json["jobId"] is None
        prop = AnnotationProperty().load(propertyId, force=True)
        assert prop["name"] == "Gene Expression" and prop["shape"] == "polygon"
        config = Collection().load(config["_id"], force=True)
        assert propertyId in config["meta"]["propertyIds"]

        def valuesFor(index):
            doc = AnnotationPropertyValues().findOne({
                "annotationId": annotations[index]["_id"],
            })
            return doc["values"][propertyId]

        # Dense: zeros are written, and counts come back as ints.
        assert valuesFor(0) == {"CD3E": 3, "MS4A1": 0}
        assert valuesFor(5) == {"CD3E": 0, "MS4A1": 0}

        # Re-materializing more genes MERGES into the same property (the
        # plain value submission would have been a silent no-op).
        resp = request(server, admin, "POST", path, body={
            "features": ["CD19"],
        })
        assertStatusOk(resp)
        assert resp.json["propertyId"] == propertyId
        assert valuesFor(1) == {"CD3E": 0, "MS4A1": 4, "CD19": 2}
        assert len(list(Collection().load(
            config["_id"], force=True
        )["meta"]["propertyIds"])) == 1

    def testCellValueWriterSkipsMovedAndDeletedAnnotations(
        self, admin, tmp_path, fsAssetstore, monkeypatch,
    ):
        from upenncontrast_spatial.server import materialize

        folder, annotations, _ = self._setup(admin, tmp_path)
        other = Folder().createFolder(
            name='destination', creator=admin, parent=folder)
        Folder().setMetadata(other, DATASET_METADATA)
        Annotation().updateMultiple({
            annotations[1]['_id']: {'datasetId': other['_id']},
        }, admin)
        Annotation().delete(annotations[2])
        model = AnnotationPropertyValues()
        original = model.appendValues(
            {'private': 1}, annotations[1]['_id'], other['_id'])
        monkeypatch.setattr(materialize, 'CHUNK_ROWS', 2)
        progress = []
        propertyId = ObjectId()
        written = materialize.writeCellValues(
            folder['_id'], propertyId,
            [annotation['_id'] for annotation in annotations[:3]],
            lambda start, stop: [{'CD3E': 7}] * (stop - start),
            lambda current, total: progress.append((current, total)),
        )
        assert written == 1
        assert progress[-1] == (3, 3)
        assert model.findOne({'_id': original['_id']}) == original
        assert model.findOne({'annotationId': annotations[2]['_id']}) is None
        assert model.findOne({'annotationId': annotations[0]['_id']})[
            'values'][str(propertyId)] == {'CD3E': 7}

    def testCellValueWriterUsesAtomicNestedUpdates(
        self, admin, tmp_path, fsAssetstore, monkeypatch
    ):
        from upenncontrast_spatial.server import materialize

        folder, annotations, _ = self._setup(admin, tmp_path)
        propertyId = ObjectId()
        model = AnnotationPropertyValues()
        model.save({
            "annotationId": annotations[0]["_id"],
            "datasetId": folder["_id"],
            "values": {"existing": {"area": 12}},
        })

        def unsafeRead(*args, **kwargs):
            raise AssertionError("writer must not read a replaceable snapshot")

        monkeypatch.setattr(model, "find", unsafeRead)
        assert materialize.writeCellValues(
            folder["_id"], propertyId, [annotations[0]["_id"]],
            lambda start, stop: [{"CD3E": 7}],
        ) == 1
        document = model.findOne({"annotationId": annotations[0]["_id"]})
        assert document["values"] == {
            "existing": {"area": 12}, str(propertyId): {"CD3E": 7},
        }

    def testMaterializeNeedsConfigurationAndWrite(
        self, admin, user, server, tmp_path, fsAssetstore
    ):
        folder, _, item = self._setup(admin, tmp_path)
        self._register(server, admin, folder, item)
        path = "/spatial/%s/materialize" % folder["_id"]
        assertStatus(request(server, admin, "POST", path, body={
            "features": ["CD3E"],
        }), 400)
        self._configure(admin, folder)
        assertStatus(request(server, user, "POST", path, body={
            "features": ["CD3E"],
        }), 403)

    def testMaterializeSchedulesJobAboveInlineLimit(
        self, admin, server, tmp_path, fsAssetstore, monkeypatch
    ):
        from upenncontrast_spatial.server import materialize as module
        folder, _, item = self._setup(admin, tmp_path)
        self._register(server, admin, folder, item)
        self._configure(admin, folder)
        monkeypatch.setattr(module, "MATERIALIZE_INLINE_MAX_ROWS", 2)
        resp = request(
            server, admin, "POST", "/spatial/%s/materialize" % folder["_id"],
            body={"features": ["CD3E"]},
        )
        assertStatusOk(resp)
        assert resp.json["jobId"] is not None and resp.json["written"] == 0

    def testMaterializeJobPublishesItsFinalResult(self, monkeypatch):
        from upenncontrast_spatial.server import materialize as module

        updates = []

        class FakeJobModel:
            def updateJob(self, job, **fields):
                updates.append(fields)

        class FakeFileModel:
            def load(self, fileId, force=False):
                return {"_id": fileId}

        monkeypatch.setattr(module, "Job", FakeJobModel)
        monkeypatch.setattr(module, "File", FakeFileModel)
        monkeypatch.setattr(module, "openStore", lambda fileDoc: object())
        monkeypatch.setattr(
            module, "columnsFor", lambda store, kwargs: {"CD3E": object()}
        )
        monkeypatch.setattr(module, "writeValues", lambda *args: 6)
        jobId = ObjectId()
        propertyId = ObjectId()
        module.run({
            "_id": jobId,
            "kwargs": {
                "datasetId": str(ObjectId()),
                "fileId": str(ObjectId()),
                "propertyId": str(propertyId),
                "symbols": ["CD3E"],
            },
        })
        assert updates[-1]["otherFields"]["spatialResult"] == {
            "propertyId": str(propertyId),
            "written": 6,
            "jobId": str(jobId),
        }

    # ---- store unit checks ---------------------------------------------

    def testRowsForAnnotationIdsHandlesMissingAndEmpty(self, tmp_path):
        ids = [str(ObjectId()) for _ in range(6)]
        path = str(tmp_path / "s.zarr.zip")
        buildStoreZip(path, ids)
        spatialStore = storeModule.SpatialStore(path)
        rows = spatialStore.rowsForAnnotationIds([ids[3], str(ObjectId())])
        assert rows.tolist() == [3, -1]
        assert spatialStore.rowsForAnnotationIds([]).tolist() == []
        # An empty store answers "no row" for everything instead of indexing
        # into an empty array.
        empty = str(tmp_path / "empty.zarr.zip")
        buildStoreZip(empty, [], counts=np.zeros((0, 4), dtype=np.float32),
                      cellTypes=[])
        emptyStore = storeModule.SpatialStore(empty)
        assert emptyStore.rowsForAnnotationIds([ids[0]]).tolist() == [-1]
        assert spatialStore.featureSymbols == SYMBOLS

"""Phase 4: rebuilding the expression table from cell polygons + transcripts,
table versions and staleness."""

import numpy as np
import pytest
import zarr
from pytest_girder.assertions import assertStatus, assertStatusOk

from girder_jobs.constants import JobStatus
from girder_jobs.models.job import Job

from girder.models.file import File

from upenncontrast_annotation.server.models.annotation import Annotation

from upenncontrast_spatial.server import recompute as recomputeModule
from upenncontrast_spatial.server.store import SpatialStore

from .test_spatial import request
from .test_transcripts import PIXEL_SIZE, TestTranscripts


def um(value):
    return value / PIXEL_SIZE


def cellPolygon(datasetId, x0, y0, x1, y1, tags):
    """A rectangular cell polygon given in microns (stored in pixels)."""
    return Annotation().create({
        "tags": tags, "shape": "polygon", "channel": 0,
        "location": {"XY": 0, "Z": 0, "Time": 0},
        "coordinates": [
            {"x": um(x0), "y": um(y0)}, {"x": um(x1), "y": um(y0)},
            {"x": um(x1), "y": um(y1)}, {"x": um(x0), "y": um(y1)},
        ],
        "datasetId": datasetId,
    })


def runJob(jobId):
    job = Job().load(jobId, force=True)
    recomputeModule.run(job)
    job = Job().load(jobId, force=True)
    assert job["status"] == JobStatus.SUCCESS, job.get("log")
    return job["spatialResult"]


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_spatial")
class TestRecompute(TestTranscripts):
    def testBackfillDoesNotOverwriteConcurrentEdit(
        self, admin, server, tmp_path, fsAssetstore, monkeypatch,
    ):
        folder, _, _, cells = self._scene(admin, server, tmp_path)
        model = Annotation()
        target = cells['C']
        model.update({'_id': target['_id']}, {'$unset': {'geometryHash': ''}})
        originalBackfill = model.setGeometryHashes
        expected = {}

        def editBeforeBackfill(hashes):
            target['coordinates'][0]['x'] += 1
            expected['hash'] = model.save(target)['geometryHash']
            return originalBackfill(hashes)

        monkeypatch.setattr(model, 'setGeometryHashes', editBeforeBackfill)
        result = recomputeModule.polygonFingerprints(folder['_id'])
        assert result[str(target['_id'])] == expected['hash']
        assert model.load(target['_id'], force=True)['geometryHash'] == (
            expected['hash']
        )

    def _scene(self, admin, server, tmp_path):
        """The transcript fixture (POINTS in test_transcripts) plus cells:
        A over (0-60, 0-40) um holding CD3E qv30, CD3E qv15 and a control
        codeword; C, a small cell inside A around (10, 20) um that wins that
        molecule; B over (90-110, 90-110) um holding MS4A1 qv25; E in tile
        1,0 around (300, 10) um holding CD3E qv22. The six fixture cells of
        the table (10 x 10 px triangles at the origin, tagged "cell" too)
        hold nothing."""
        folder, annotations, tableItem, item = self._setupTranscripts(
            admin, tmp_path
        )
        self._register(server, admin, folder, tableItem)
        self._registerTranscripts(server, admin, folder, item)
        cells = {
            "A": cellPolygon(folder["_id"], 0, 0, 60, 40, ["cell", "T"]),
            "C": cellPolygon(folder["_id"], 5, 15, 15, 25, ["cell", "T"]),
            "B": cellPolygon(folder["_id"], 90, 90, 110, 110, ["cell", "B"]),
            "E": cellPolygon(folder["_id"], 295, 5, 305, 15, ["cell"]),
            # F straddles the 0,0 / 1,0 tile boundary (250 um); it holds no
            # molecule, but its footprint pulls tile 1,0 into a dirty run.
            "F": cellPolygon(folder["_id"], 240, 100, 260, 110, ["cell"]),
        }
        return folder, annotations, tableItem, cells

    def _row(self, server, admin, folder, annotationId):
        resp = request(
            server, admin, "GET", "/spatial/%s/row" % folder["_id"],
            params={"annotationId": str(annotationId)},
        )
        assertStatusOk(resp)
        return resp.json["values"]

    def testRecomputeAllAssignsAndVersions(
        self, admin, server, tmp_path, fsAssetstore
    ):
        folder, annotations, tableItem, cells = self._scene(
            admin, server, tmp_path
        )
        resp = request(
            server, admin, "POST", "/spatial/%s/recompute" % folder["_id"],
            body={"label": "v2", "scope": "all", "tags": ["cell"]},
        )
        assertStatusOk(resp)
        result = runJob(resp.json["jobId"])
        assert result["nObs"] == 11 and result["nVar"] == 3
        # qv >= 20 genes: CD3E(10,20), MS4A1, CCL19, CD3E(300,10) considered;
        # CCL19 lies in no cell.
        assert result["considered"] == 4
        assert result["assigned"] == 3 and result["unassigned"] == 1
        assert result["tilesProcessed"] == 2

        info = request(server, admin, "GET", "/spatial/%s" % folder["_id"])
        assertStatusOk(info)
        assert info.json["nObs"] == 11
        assert info.json["itemId"] == result["itemId"]
        assert "geometry_hash" in info.json["obsColumns"]
        assert "cell_type" in info.json["obsColumns"]
        # Smallest polygon wins: C has the CD3E molecule, A has none.
        assert self._row(server, admin, folder, cells["C"]["_id"]) == {
            "CD3E": 1.0
        }
        assert self._row(server, admin, folder, cells["A"]["_id"]) == {}
        assert self._row(server, admin, folder, cells["B"]["_id"]) == {
            "MS4A1": 1.0
        }
        assert self._row(server, admin, folder, cells["E"]["_id"]) == {
            "CD3E": 1.0
        }
        # Cell types came from the tags, using the previous table's
        # categories (T, B, Endo); E has none.
        store = SpatialStore(File().getLocalFilePath(
            File().load(info.json["fileId"], force=True)
        ))
        types = dict(zip(
            store.annotationIds.tolist(),
            recomputeModule.readStringColumn(store.root["obs"], "cell_type"),
        ))
        assert types[str(cells["A"]["_id"])] == "T"
        assert types[str(cells["B"]["_id"])] == "B"
        assert types[str(cells["E"]["_id"])] is None

        versions = request(
            server, admin, "GET", "/spatial/%s/versions" % folder["_id"]
        )
        assertStatusOk(versions)
        assert versions.json["active"]["label"] == "v2"
        assert versions.json["active"]["nObs"] == 11
        assert [v["itemId"] for v in versions.json["versions"]] == [
            str(tableItem["_id"])
        ]
        assert versions.json["versions"][0]["nObs"] == 6

    def testStalenessAndDirtyScope(
        self, admin, server, tmp_path, fsAssetstore
    ):
        folder, annotations, tableItem, cells = self._scene(
            admin, server, tmp_path
        )
        # The imported table has no hashes: only added/removed are known.
        stale = request(
            server, admin, "GET", "/spatial/%s/staleness" % folder["_id"]
        )
        assertStatusOk(stale)
        assert stale.json["hasGeometryHashes"] is False
        assert stale.json["added"] == 5 and stale.json["removed"] == 0
        assert stale.json["upToDate"] is False

        resp = request(
            server, admin, "POST", "/spatial/%s/recompute" % folder["_id"],
            body={"label": "v2", "scope": "all", "tags": ["cell"]},
        )
        runJob(resp.json["jobId"])
        # A second full run: a third version for the ordering check below.
        resp = request(
            server, admin, "POST", "/spatial/%s/recompute" % folder["_id"],
            body={"label": "v3", "scope": "all"},
        )
        runJob(resp.json["jobId"])
        stale = request(
            server, admin, "GET", "/spatial/%s/staleness" % folder["_id"]
        ).json
        assert stale["upToDate"] is True and stale["hasGeometryHashes"]
        # Mongo's fingerprints equal the ones the job wrote from Python.
        prints = recomputeModule.polygonFingerprints(folder["_id"])
        assert prints[str(cells["B"]["_id"])] == recomputeModule.geometryHash(
            Annotation().load(cells["B"]["_id"], force=True)["coordinates"]
        )

        # Edit B (shrink it away from its molecule), add D over the CCL19
        # molecule, delete A.
        b = Annotation().load(cells["B"]["_id"], force=True)
        b["coordinates"] = [
            {"x": um(90), "y": um(90)}, {"x": um(95), "y": um(90)},
            {"x": um(95), "y": um(95)}, {"x": um(90), "y": um(95)},
        ]
        Annotation().save(b)
        d = cellPolygon(folder["_id"], 195, 45, 205, 55, ["cell", "T"])
        Annotation().delete(cells["A"])
        stale = request(
            server, admin, "GET", "/spatial/%s/staleness" % folder["_id"]
        ).json
        assert stale["added"] == 1 and stale["addedIds"] == [str(d["_id"])]
        assert stale["changed"] == 1 and stale["changedIds"] == [
            str(cells["B"]["_id"])
        ]
        assert stale["removed"] == 1 and stale["removedIds"] == [
            str(cells["A"]["_id"])
        ]

        resp = request(
            server, admin, "POST", "/spatial/%s/recompute" % folder["_id"],
            body={"label": "v4", "scope": "dirty"},
        )
        assertStatusOk(resp)
        result = runJob(resp.json["jobId"])
        # Tile 0,0 held the edits; F straddles into 1,0, so once F is
        # re-assigned its far tile is processed too (closure), while E's row
        # is still carried over untouched.
        assert result["tilesProcessed"] == 2
        assert result["nObs"] == 11  # triangles + B, C, E, F, D; A is gone
        assert self._row(server, admin, folder, cells["B"]["_id"]) == {}
        assert self._row(server, admin, folder, d["_id"]) == {"CCL19": 1.0}
        assert self._row(server, admin, folder, cells["C"]["_id"]) == {
            "CD3E": 1.0
        }
        assert self._row(server, admin, folder, cells["E"]["_id"]) == {
            "CD3E": 1.0
        }
        assert request(
            server, admin, "GET", "/spatial/%s/staleness" % folder["_id"]
        ).json["upToDate"] is True
        labels = [
            v["label"] for v in request(
                server, admin, "GET", "/spatial/%s/versions" % folder["_id"]
            ).json["versions"]
        ]
        assert labels == ["Imported table", "v2", "v3"]

    def testActivateAndForgetVersions(
        self, admin, user, server, tmp_path, fsAssetstore
    ):
        folder, annotations, tableItem, cells = self._scene(
            admin, server, tmp_path
        )
        resp = request(
            server, admin, "POST", "/spatial/%s/recompute" % folder["_id"],
            body={"scope": "all"},
        )
        newItemId = runJob(resp.json["jobId"])["itemId"]
        base = "/spatial/%s/versions" % folder["_id"]
        assertStatus(request(
            server, user, "POST", "%s/%s/activate" % (base, tableItem["_id"])
        ), 403)
        resp = request(
            server, admin, "POST", "%s/%s/activate" % (base, tableItem["_id"])
        )
        assertStatusOk(resp)
        assert resp.json["active"]["itemId"] == str(tableItem["_id"])
        assert [v["itemId"] for v in resp.json["versions"]] == [newItemId]
        info = request(server, admin, "GET", "/spatial/%s" % folder["_id"])
        assert info.json["nObs"] == 6
        # The active table cannot be forgotten; a version can, once.
        assertStatus(request(
            server, admin, "DELETE", "%s/%s" % (base, tableItem["_id"])
        ), 404)
        assertStatusOk(request(
            server, admin, "DELETE", "%s/%s" % (base, newItemId)
        ))
        assertStatus(request(
            server, admin, "DELETE", "%s/%s" % (base, newItemId)
        ), 404)
        assertStatus(request(
            server, admin, "POST", "%s/%s/activate" % (base, newItemId)
        ), 404)
        assert request(server, admin, "GET", base).json["versions"] == []

    def testRecomputeValidation(
        self, admin, server, tmp_path, fsAssetstore
    ):
        folder, _, tableItem, item = self._setupTranscripts(admin, tmp_path)
        path = "/spatial/%s/recompute" % folder["_id"]
        # No transcript store yet.
        assertStatus(
            request(server, admin, "POST", path, body={"scope": "all"}), 404
        )
        self._registerTranscripts(server, admin, folder, item)
        # dirty needs an active table.
        assertStatus(
            request(server, admin, "POST", path, body={"scope": "dirty"}), 400
        )
        for body in (
            {"scope": "some"},
            {"scope": "all", "label": ""},
            {"scope": "all", "label": "x" * 81},
            {"scope": "all", "minQv": -1},
            {"scope": "all", "minQv": "high"},
            {"scope": "all", "tags": "cell"},
            {"scope": "all", "tags": [1]},
            {"scope": "all", "tags": []},
            {"scope": "all", "tags": [""]},
            {"scope": "all", "recomputeEmbeddings": "false"},
        ):
            assertStatus(request(server, admin, "POST", path, body=body), 400)
        self._registerTranscripts(
            server, admin, folder, item,
            transform=[[1, 0, 0], [0, 1, 0], [0, 0, 1]],
        )
        assertStatus(
            request(server, admin, "POST", path, body={"scope": "all"}), 400
        )

    def testUnits(self, tmp_path):
        coordinates = [{"x": 1, "y": 2}, {"x": 3, "y": 4}, {"x": 5, "y": 0}]
        assert recomputeModule.geometryHash(coordinates) == (
            recomputeModule.geometryHash(
                [{"x": 1.0, "y": 2.0}, {"x": 3, "y": 4}, {"x": 5, "y": 0}]
            )
        )
        assert recomputeModule.geometryHash(coordinates) != (
            recomputeModule.geometryHash(coordinates[:2] + [{"x": 6, "y": 0}])
        )
        # Equal low-order moments do not make two polygons equal.  The old
        # count/sum fingerprint collided for this pair despite their different
        # outlines (and areas: 2.5 vs 3.0).
        collisionA = [
            {"x": 0, "y": 0}, {"x": 3, "y": 2},
            {"x": 1, "y": 2}, {"x": 0, "y": 1},
        ]
        collisionB = [
            {"x": 0, "y": 0}, {"x": 2, "y": 1},
            {"x": 2, "y": 3}, {"x": 0, "y": 1},
        ]
        assert recomputeModule.geometryHash(collisionA) != (
            recomputeModule.geometryHash(collisionB)
        )
        assert recomputeModule.isFingerprint(
            recomputeModule.geometryHash(coordinates)
        )
        assert not recomputeModule.isFingerprint("3:9.00:6.00:14.00:55.00")
        assert not recomputeModule.isFingerprint("0123456789abcdef")
        assert not recomputeModule.isFingerprint("3:9.00:6.00:14.00")
        # A rectangle widened symmetrically keeps count, sum x, sum y and
        # sum xy; the second moment tells it apart.
        rect = lambda x0, y0, x1, y1: [  # noqa: E731
            {"x": x0, "y": y0}, {"x": x1, "y": y0},
            {"x": x1, "y": y1}, {"x": x0, "y": y1},
        ]
        assert recomputeModule.geometryHash(rect(10, 10, 30, 20)) != (
            recomputeModule.geometryHash(rect(5, 10, 35, 20))
        )
        big = recomputeModule.Cell(
            "a", np.array([[0, 0], [10, 0], [10, 10], [0, 10]], float),
            [], (0, 0, 10, 10), 100.0, "h",
        )
        small = recomputeModule.Cell(
            "b", np.array([[2, 2], [5, 2], [5, 5], [2, 5]], float),
            [], (2, 2, 5, 5), 9.0, "h",
        )
        labels = recomputeModule.labelImage(
            [big, small], [0, 1], (0, 0, 12, 12)
        )
        assert labels[3, 3] == 2 and labels[8, 8] == 1 and labels[11, 11] == 0
        matrix = recomputeModule.buildMatrix(
            [np.array([0, 5, 5]), np.array([5])], [np.array([1, 2, 1]),
                                                   np.array([3])], 2, 3,
        )
        assert matrix.toarray().tolist() == [[1, 0, 0], [0, 0, 6]]

        path = str(tmp_path / "written.zarr.zip")
        recomputeModule.writeStore(
            path, matrix, [big, small], ["G1", "G2", "G3"], ["T", None],
            {"source": "test"},
            projection=np.zeros((2, 2), np.float32),
            clusters=np.array([0, 1], np.int32),
        )
        # Not annotation ids, so the reader refuses; check the layout raw.
        root = zarr.open_group(zarr.ZipStore(path, mode="r"), mode="r")
        assert root["X"].attrs["encoding-type"] == "csc_matrix"
        assert root["X"].attrs["shape"] == [2, 3]
        assert root["layers/X_csr/data"][:].tolist() == [1.0, 6.0]
        assert list(recomputeModule.readStringColumn(
            root["obs"], "cell_type"
        )) == ["T", None]
        assert root["obs/transcript_count"][:].tolist() == [1, 6]
        assert root["obsm/X_umap"].shape == (2, 2)
        assert root["uns"].attrs["nimbus"]["source"] == "test"

    def testEmbeddingsShapes(self):
        rng = np.random.default_rng(0)
        counts = recomputeModule.sp.csr_matrix(
            rng.poisson(2.0, size=(40, 6)).astype(np.float32)
        )
        projection, clusters = recomputeModule.embeddings(counts)
        assert projection.shape == (40, 2) and clusters.shape == (40,)
        assert projection.dtype == np.float32

"""Phase 3: the per-molecule transcript store — registration, gene search,
point extraction across the pyramid and density tiles."""

import io
import json
import os

import numpy as np
import pytest
import zarr
from PIL import Image
from pytest_girder.assertions import assertStatus, assertStatusOk

from girder.models.item import Item
from girder.models.upload import Upload

from upenncontrast_spatial.server import transcripts as transcriptsModule
from upenncontrast_spatial.server.transcripts import (
    TranscriptStore,
    encodePoints,
    parseTransform,
)

from .test_spatial import TestSpatial, request

# Three genes and one control codeword; molecules over two 250 um tiles.
GENE_NAMES = ["CD3E", "MS4A1", "CCL19", "NegControlProbe_00001"]
# (gene, x um, y um, qv); tile 0,0 and tile 1,0.
POINTS = [
    ("CD3E", 10.0, 20.0, 30.0),
    ("CD3E", 40.0, 20.0, 15.0),        # low quality
    ("MS4A1", 100.0, 100.0, 25.0),
    ("CCL19", 200.0, 50.0, 40.0),
    ("NegControlProbe_00001", 30.0, 30.0, 40.0),
    ("CD3E", 300.0, 10.0, 22.0),       # tile 1,0
    ("MS4A1", 400.0, 200.0, 12.5),     # tile 1,0, low quality
]
PIXEL_SIZE = 0.2125


def _writeTile(grid, key, rows, level):
    """Rows of (gene index, x, y, qv) sorted into the two per-gene runs
    Xenium writes: high quality first, low quality second."""
    high = sorted(
        [r for r in rows if r[3] >= 20], key=lambda r: r[0]
    )
    low = sorted([r for r in rows if r[3] < 20], key=lambda r: r[0])
    ordered = high + low
    offsets = np.zeros((len(GENE_NAMES), 4), dtype=np.int64)
    for gene in range(len(GENE_NAMES)):
        highIdx = [
            i for i, r in enumerate(ordered) if r[0] == gene and r[3] >= 20
        ]
        lowIdx = [
            i for i, r in enumerate(ordered) if r[0] == gene and r[3] < 20
        ]
        if highIdx:
            offsets[gene, 2:] = [highIdx[0], highIdx[-1] + 1]
        else:
            offsets[gene, 2:] = [len(high), len(high)]
        if lowIdx:
            offsets[gene, :2] = [lowIdx[0], lowIdx[-1] + 1]
        else:
            offsets[gene, :2] = [len(ordered), len(ordered)]
    tile = grid.create_group(key)
    tile.create_dataset("gene_offset", data=offsets)
    tile.create_dataset("location", data=np.array(
        [[r[1], r[2], 0.0] for r in ordered], dtype=np.float32
    ).reshape(-1, 3))
    tile.create_dataset("gene_identity", data=np.array(
        [r[0] for r in ordered], dtype=np.int32
    ).reshape(-1, 1))
    if level == 0:
        tile.create_dataset("quality_score", data=np.array(
            [r[3] for r in ordered], dtype=np.float32
        ).reshape(-1, 1))
        # The transcript's own id, as in the real file: no cell reference.
        tile.create_dataset("id", data=np.array(
            [[i, 103] for i in range(len(ordered))], dtype=np.uint32
        ).reshape(-1, 2))
    return len(ordered)


def buildTranscriptsZip(path, points=POINTS, geneNames=GENE_NAMES):
    zipStore = zarr.ZipStore(path, mode="w")
    root = zarr.group(store=zipStore)
    root.attrs.update({
        "gene_names": geneNames, "number_rnas": len(points),
        "spatial_units": "micron",
    })
    rows = [(geneNames.index(g), x, y, qv) for g, x, y, qv in points]
    grids = root.create_group("grids")
    keys, counts = [], []
    for level in (0, 1):
        size = 250.0 * 2 ** level
        grid = grids.create_group(str(level))
        byTile = {}
        for row in rows:
            byTile.setdefault(
                "%d,%d" % (int(row[1] // size), int(row[2] // size)), []
            ).append(row)
        keys.append(sorted(byTile))
        counts.append([
            _writeTile(grid, key, byTile[key], level) for key in sorted(byTile)
        ])
    grids.attrs.update({
        "grid_size": [250.0], "number_levels": 2,
        "grid_keys": keys, "grid_number_objects": counts,
    })
    # density: 10 um bins over a 500 x 300 um section (30 rows x 50 cols)
    rowsN, colsN = 30, 50
    dense = np.zeros((len(geneNames), rowsN, colsN), dtype=np.int32)
    for gene, x, y, qv in rows:
        if qv >= 20:
            dense[gene, int(y // 10), int(x // 10)] += 1
    indptr, indices, data = [0], [], []
    for gene in range(len(geneNames)):
        for r in range(rowsN):
            cols = np.nonzero(dense[gene, r])[0]
            indices.extend(cols.tolist())
            data.extend(dense[gene, r, cols].tolist())
            indptr.append(len(indices))
    density = root.create_group("density").create_group("gene")
    density.create_dataset("indptr", data=np.array(indptr, dtype=np.int64))
    density.create_dataset(
        "indices", data=np.array(indices or [0], dtype=np.int32)[:len(indices)]
    )
    density.create_dataset(
        "data", data=np.array(data or [0], dtype=np.int32)[:len(data)]
    )
    density.attrs.update({
        "rows": rowsN, "cols": colsN, "grid_size": [10, 10], "origin": [0, 0],
    })
    zipStore.close()


def uploadTranscripts(admin, folder, path):
    with open(path, "rb") as fh:
        fileDoc = Upload().uploadFromFile(
            fh, os.path.getsize(path), "transcripts.zarr.zip",
            parentType="folder", parent=folder, user=admin,
            mimeType="application/zip",
        )
    return Item().load(fileDoc["itemId"], force=True)


def decodePoints(body):
    n = int(np.frombuffer(body[:4], dtype="<u4")[0])
    hasLevel0 = body[4] == 1
    offset = 5
    xy = np.frombuffer(body[offset:offset + 8 * n], dtype="<f4").reshape(n, 2)
    offset += 8 * n
    slots = np.frombuffer(body[offset:offset + n], dtype=np.uint8)
    offset += n
    quality = None
    if hasLevel0:
        quality = np.frombuffer(body[offset:offset + 4 * n], dtype="<f4")
        offset += 4 * n
    assert offset == len(body)
    return xy, slots, quality


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_spatial")
class TestTranscripts(TestSpatial):
    def _setupTranscripts(self, admin, tmp_path, private=False):
        folder, annotations, item = self._setup(
            admin, tmp_path, private=private
        )
        path = str(tmp_path / "transcripts.zarr.zip")
        buildTranscriptsZip(path)
        transcriptsItem = uploadTranscripts(admin, folder, path)
        return folder, annotations, item, transcriptsItem

    def _registerTranscripts(self, server, admin, folder, item, **extra):
        body = {"itemId": str(item["_id"]), "pixelSize": PIXEL_SIZE}
        body.update(extra)
        resp = request(
            server, admin, "POST",
            "/spatial/%s/transcripts/register" % folder["_id"], body=body,
        )
        assertStatusOk(resp)
        return resp.json

    def _points(self, server, admin, folder, body):
        return server.request(
            path="/spatial/%s/transcripts/points" % folder["_id"],
            method="POST", user=admin, body=json.dumps(body),
            type="application/json", isJson=False,
        )

    # ---- registration -----------------------------------------------------

    def testRegisterDescribesPyramid(
        self, admin, server, tmp_path, fsAssetstore
    ):
        folder, _, _, item = self._setupTranscripts(admin, tmp_path)
        assertStatus(request(
            server, admin, "GET", "/spatial/%s/transcripts" % folder["_id"]
        ), 404)
        schema = self._registerTranscripts(server, admin, folder, item)
        assert schema["levels"] == 2
        assert schema["genes"] == 3          # the control codeword is not one
        assert schema["totalPoints"] == len(POINTS)
        assert schema["pixelSize"] == PIXEL_SIZE
        assert schema["tiles"][0]["keys"] == ["0,0", "1,0"]
        assert schema["tiles"][1]["keys"] == ["0,0"]
        assert schema["tiles"][0]["tilePixels"] == pytest.approx(
            250 / PIXEL_SIZE
        )
        described = request(
            server, admin, "GET", "/spatial/%s/transcripts" % folder["_id"]
        )
        assertStatusOk(described)
        assert described.json["itemId"] == str(item["_id"])
        # The expression-table routes still report no table.
        assertStatus(
            request(server, admin, "GET", "/spatial/%s" % folder["_id"]), 404
        )

    def testRegisterValidatesInput(
        self, admin, server, tmp_path, fsAssetstore
    ):
        folder, _, tableItem, item = self._setupTranscripts(admin, tmp_path)
        path = "/spatial/%s/transcripts/register" % folder["_id"]
        for body in (
            {"itemId": str(item["_id"])},
            {"itemId": str(item["_id"]), "pixelSize": 0},
            {"itemId": str(item["_id"]), "pixelSize": "big"},
            {"itemId": str(item["_id"]), "pixelSize": 1, "transform": [1, 2]},
            {"itemId": str(tableItem["_id"]), "pixelSize": 1},
        ):
            assertStatus(request(server, admin, "POST", path, body=body), 400)

    def testRegisterRequiresWriteAndKeepsTable(
        self, admin, user, server, tmp_path, fsAssetstore
    ):
        folder, _, tableItem, item = self._setupTranscripts(admin, tmp_path)
        self._register(server, admin, folder, tableItem)
        assertStatus(request(
            server, user, "POST",
            "/spatial/%s/transcripts/register" % folder["_id"],
            body={"itemId": str(item["_id"]), "pixelSize": 1},
        ), 403)
        self._registerTranscripts(server, admin, folder, item)
        # Both halves coexist and are forgotten independently.
        assertStatusOk(request(
            server, admin, "DELETE", "/spatial/%s" % folder["_id"]
        ))
        assertStatusOk(request(
            server, admin, "GET", "/spatial/%s/transcripts" % folder["_id"]
        ))
        assertStatus(request(
            server, admin, "GET", "/spatial/%s" % folder["_id"]
        ), 404)
        assertStatus(request(
            server, user, "DELETE", "/spatial/%s/transcripts" % folder["_id"]
        ), 403)
        assertStatusOk(request(
            server, admin, "DELETE", "/spatial/%s/transcripts" % folder["_id"]
        ))
        assertStatus(request(
            server, admin, "GET", "/spatial/%s/transcripts" % folder["_id"]
        ), 404)
        assert Item().load(item["_id"], force=True) is not None

    # ---- genes ------------------------------------------------------------

    def testGeneSearchSkipsControls(
        self, admin, server, tmp_path, fsAssetstore
    ):
        folder, _, _, item = self._setupTranscripts(admin, tmp_path)
        self._registerTranscripts(server, admin, folder, item)
        path = "/spatial/%s/transcripts/genes" % folder["_id"]
        resp = request(server, admin, "GET", path)
        assertStatusOk(resp)
        assert resp.json == ["CD3E", "MS4A1", "CCL19"]
        resp = request(server, admin, "GET", path, params={"search": "c"})
        # Shortest prefix match first.
        assert resp.json == ["CD3E", "CCL19"]
        resp = request(server, admin, "GET", path, params={"search": "4a"})
        assert resp.json == ["MS4A1"]
        assertStatus(
            request(server, admin, "GET", path, params={"limit": 0}), 400
        )

    # ---- points -----------------------------------------------------------

    def testPointsAtLevelZeroCarryQuality(
        self, admin, server, tmp_path, fsAssetstore
    ):
        folder, annotations, tableItem, item = self._setupTranscripts(
            admin, tmp_path
        )
        self._register(server, admin, folder, tableItem)
        self._registerTranscripts(server, admin, folder, item)
        resp = self._points(server, admin, folder, {
            "genes": ["CD3E", "MS4A1"], "level": 0, "tiles": ["0,0", "1,0"],
        })
        assertStatusOk(resp)
        xy, slots, quality = decodePoints(b"".join(resp.body))
        assert len(xy) == 5
        # Microns became image pixels.
        expected = sorted(
            (x / PIXEL_SIZE, y / PIXEL_SIZE)
            for g, x, y, _ in POINTS if g in ("CD3E", "MS4A1")
        )
        np.testing.assert_allclose(
            sorted(map(tuple, xy.tolist())), expected, rtol=1e-5
        )
        assert sorted(slots.tolist()) == [0, 0, 0, 1, 1]
        assert sorted(quality.tolist()) == [12.5, 15.0, 22.0, 25.0, 30.0]

    def testPointsHonorQualityAndUnknownTiles(
        self, admin, server, tmp_path, fsAssetstore
    ):
        folder, _, _, item = self._setupTranscripts(admin, tmp_path)
        self._registerTranscripts(server, admin, folder, item)
        resp = self._points(server, admin, folder, {
            "genes": ["CD3E"], "level": 0, "tiles": ["0,0", "1,0", "7,7"],
            "minQv": 20,
        })
        assertStatusOk(resp)
        xy, slots, quality = decodePoints(b"".join(resp.body))
        assert sorted(quality.tolist()) == [22.0, 30.0]
        # A stricter threshold within the high-quality run.
        resp = self._points(server, admin, folder, {
            "genes": ["CD3E"], "level": 0, "tiles": ["0,0", "1,0"],
            "minQv": 25,
        })
        _, _, quality = decodePoints(b"".join(resp.body))
        assert quality.tolist() == [30.0]

    def testPointsAtCoarserLevelsHaveNoQuality(
        self, admin, server, tmp_path, fsAssetstore
    ):
        folder, _, _, item = self._setupTranscripts(admin, tmp_path)
        self._registerTranscripts(server, admin, folder, item)
        resp = self._points(server, admin, folder, {
            "genes": ["CCL19", "CD3E"], "level": 1, "tiles": ["0,0"],
            "minQv": 20,
        })
        assertStatusOk(resp)
        xy, slots, quality = decodePoints(b"".join(resp.body))
        assert quality is None
        assert sorted(slots.tolist()) == [0, 1, 1]

    def testPointsRejectBadInputAndTooMany(
        self, admin, server, tmp_path, fsAssetstore, monkeypatch
    ):
        folder, _, _, item = self._setupTranscripts(admin, tmp_path)
        self._registerTranscripts(server, admin, folder, item)
        for body in (
            {"genes": [], "level": 0, "tiles": ["0,0"]},
            {"genes": ["NOPE"], "level": 0, "tiles": ["0,0"]},
            {"genes": ["NegControlProbe_00001"] * 9, "tiles": ["0,0"]},
            {"genes": ["CD3E"], "level": 2, "tiles": ["0,0"]},
            {"genes": ["CD3E"], "level": 0, "tiles": ["a,b"]},
            {"genes": ["CD3E"], "level": 0, "tiles": "0,0"},
            {"genes": ["CD3E"], "level": 0, "tiles": []},
            {"genes": ["CD3E"], "level": 0, "tiles": ["0,0"], "minQv": -1},
        ):
            assertStatus(self._points(server, admin, folder, body), 400)
        monkeypatch.setattr(
            transcriptsModule, "MAX_POINTS_PER_RESPONSE", 2
        )
        monkeypatch.setattr(
            "upenncontrast_spatial.server.api.transcripts."
            "MAX_POINTS_PER_RESPONSE", 2,
        )
        assertStatus(self._points(server, admin, folder, {
            "genes": ["CD3E", "MS4A1"], "level": 0, "tiles": ["0,0", "1,0"],
        }), 413)

    def testPointsRequireReadAccess(
        self, admin, user, server, tmp_path, fsAssetstore
    ):
        folder, _, _, item = self._setupTranscripts(admin, tmp_path)
        self._registerTranscripts(server, admin, folder, item)
        for path in ("transcripts", "transcripts/genes"):
            assertStatusOk(request(
                server, user, "GET", "/spatial/%s/%s" % (folder["_id"], path)
            ))
        private, _, _, privateItem = self._setupTranscripts(
            admin, tmp_path, private=True
        )
        self._registerTranscripts(server, admin, private, privateItem)
        assertStatus(request(
            server, user, "GET", "/spatial/%s/transcripts" % private["_id"]
        ), 403)
        assertStatus(request(
            server, None, "GET",
            "/spatial/%s/transcripts/density/0/0/0" % private["_id"],
            params={"genes": "CD3E", "sizeX": 10, "sizeY": 10,
                    "maxLevel": 0},
        ), 401)

    # ---- density ------------------------------------------------------------

    def testDensityTileMatchesBins(
        self, admin, server, tmp_path, fsAssetstore
    ):
        folder, _, _, item = self._setupTranscripts(admin, tmp_path)
        self._registerTranscripts(server, admin, folder, item)
        # Image of 500 x 300 um at 0.2125 um/px, rendered so that one tile
        # of 256 px at maxLevel 0 covers the whole image at 2**-maxLevel.
        sizeX, sizeY = int(500 / PIXEL_SIZE), int(300 / PIXEL_SIZE)
        maxLevel = 4
        resp = server.request(
            path="/spatial/%s/transcripts/density/0/0/0" % folder["_id"],
            method="GET", user=admin, isJson=False,
            params={"genes": "CD3E", "sizeX": sizeX, "sizeY": sizeY,
                    "tileSize": 256, "maxLevel": maxLevel,
                    "color": "#ff0000"},
        )
        assertStatusOk(resp)
        assert resp.headers["Content-Type"] == "image/png"
        image = np.asarray(Image.open(io.BytesIO(b"".join(resp.body))))
        assert image.shape == (256, 256, 4)
        # Level 0 of a 4-level pyramid: 1 tile px = 16 image px = 3.4 um.
        # CD3E high-quality molecules sit in bins (row 2, col 1) and
        # (row 1, col 30); each bin is 10 um = ~2.9 tile px wide.
        alpha = image[..., 3]
        lit = np.argwhere(alpha > 0)
        assert len(lit) > 0
        rows, cols = lit[:, 0], lit[:, 1]
        scale = 16 * PIXEL_SIZE  # um per tile pixel
        # Each output pixel samples the bin under its center.
        binsHit = set(zip(((rows + 0.5) * scale // 10).astype(int),
                          ((cols + 0.5) * scale // 10).astype(int)))
        assert binsHit == {(2, 1), (1, 30)}
        # Both bins hold one molecule: alpha is full where lit.
        assert set(alpha[alpha > 0].tolist()) == {255}
        assert set(image[..., 0][alpha > 0].tolist()) == {255}
        assert not image[..., 1][alpha > 0].any()
        # Outside the section (below 300 um) nothing is drawn.
        assert not alpha[int(300 / scale) + 1:].any()

    def testDensityTileValidatesParams(
        self, admin, server, tmp_path, fsAssetstore
    ):
        folder, _, _, item = self._setupTranscripts(admin, tmp_path)
        self._registerTranscripts(server, admin, folder, item)
        base = "/spatial/%s/transcripts/density" % folder["_id"]
        good = {"genes": "CD3E", "sizeX": 100, "sizeY": 100, "maxLevel": 2}
        for path, params in (
            ("/0/0/0", {**good, "tileSize": 100}),
            ("/3/0/0", good),
            ("/0/0/0", {**good, "genes": "NOPE"}),
            ("/0/0/0", {**good, "color": "red"}),
            ("/0/0/0", {**good, "sizeX": 0}),
            ("/0/0/0", {k: v for k, v in good.items() if k != "maxLevel"}),
            # 100 px at maxLevel 2 is one 256 px tile at every level.
            ("/2/1/0", good),
            ("/0/0/1", good),
        ):
            assertStatus(server.request(
                path=base + path, method="GET", user=admin, isJson=False,
                params=params,
            ), 400)

    def testDensityRefusesTransformedRegistrations(
        self, admin, server, tmp_path, fsAssetstore
    ):
        folder, _, _, item = self._setupTranscripts(admin, tmp_path)
        self._registerTranscripts(
            server, admin, folder, item,
            transform=[[2, 0, 5], [0, 2, 7], [0, 0, 1]],
        )
        resp = self._points(server, admin, folder, {
            "genes": ["CCL19"], "level": 0, "tiles": ["0,0"],
        })
        xy, _, _ = decodePoints(b"".join(resp.body))
        np.testing.assert_allclose(
            xy, [[200 / PIXEL_SIZE * 2 + 5, 50 / PIXEL_SIZE * 2 + 7]],
            rtol=1e-5,
        )
        assertStatus(server.request(
            path="/spatial/%s/transcripts/density/0/0/0" % folder["_id"],
            method="GET", user=admin, isJson=False,
            params={"genes": "CD3E", "sizeX": 10, "sizeY": 10, "maxLevel": 0},
        ), 400)

    # ---- unit --------------------------------------------------------------

    def testStoreUnits(self, tmp_path):
        path = str(tmp_path / "t.zarr.zip")
        buildTranscriptsZip(path)
        store = TranscriptStore(path, 1.0)
        assert store.tileMicrons(1) == 500.0
        assert store.tile(0, "9,9") is None
        with pytest.raises(ValueError):
            store.tile(5, "0,0")
        with pytest.raises(ValueError):
            store.tile(0, "bad")
        with pytest.raises(ValueError):
            store.geneIndices(["CD3E", "NOPE"])
        grid, binMicrons, reference = store.densityGrid(
            store.geneIndices(["MS4A1"])
        )
        assert binMicrons == 10.0 and grid.shape == (30, 50)
        assert grid.sum() == 1  # only the high-quality MS4A1 molecule
        assert reference == 1.0
        assert parseTransform(None) is None
        assert parseTransform([1, 0, 0, 0, 1, 0, 0, 0, 1]).shape == (3, 3)
        for bad in ([1, 2], [[1, 2, 3]], [[1, 2, "x"]] * 3, "matrix"):
            with pytest.raises(ValueError):
                parseTransform(bad)
        with pytest.raises(ValueError):
            TranscriptStore(path, 0)
        body = encodePoints(
            np.zeros((0, 2), np.float32), np.zeros(0, np.uint8), None
        )
        assert decodePoints(body)[0].shape == (0, 2)

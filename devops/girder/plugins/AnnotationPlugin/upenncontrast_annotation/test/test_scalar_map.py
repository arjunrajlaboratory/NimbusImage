import contextlib
import io
import json
import math
import threading
import zipfile

import numpy as np
import pytest
from PIL import Image

from pytest_girder.assertions import assertStatus, assertStatusOk

from girder.constants import AccessType
from girder.models.file import File
from girder.models.folder import Folder
from girder.models.item import Item
from girder.models.upload import Upload

from ..server.helpers import scalarMap
from ..server.helpers.scalarMap import (
    MAX_SCALAR_MAP_CACHE_BYTES,
    THRESHOLD_DIM_ALPHA,
    ScalarMapStorageError,
    colorizeScalarValues,
    colormapLut,
    defaultDisplayRange,
    renderScalarMapTile,
    scalarMapRevision,
    readScalarMapArray,
    sampleScalarMap,
    tilePixelCenters,
    validateScalarMapMeta,
)

from . import girder_utilities as utilities
from . import upenn_testing_utilities as upenn_utilities

LOCATION = "xy0_z0_t0"
# Image 64 x 48 px; map cells of 8 px from the origin: 6 rows x 8 cols.
SIZE_X, SIZE_Y = 64, 48
ROWS, COLS = 6, 8


def _meta(**overrides):
    meta = {
        "version": 1,
        "toolId": "tool1",
        "name": "Area mean",
        "gridSpacingPx": 8,
        "originPx": [0, 0],
        "shape": [ROWS, COLS],
        "locations": [{"XY": 0, "Z": 0, "Time": 0, "key": LOCATION}],
        "valueRange": [0.0, 1.0],
        "percentiles": [float(i) / 100 for i in range(101)],
    }
    meta.update(overrides)
    return meta


def _npz(**arrays):
    buffer = io.BytesIO()
    np.savez_compressed(buffer, **arrays)
    return buffer.getvalue()


def _uploadMap(user, folder, arrays, meta, name="hotspot_map_tool1.npz"):
    data = _npz(**arrays)
    upload = Upload().uploadFromFile(
        io.BytesIO(data), len(data), name, "folder", folder, user=user,
        mimeType="application/octet-stream",
    )
    item = Item().load(upload["itemId"], force=True)
    if meta is not None:
        item = Item().setMetadata(item, {"nimbusScalarMap": meta})
    return item


def _privateDataset(user, name="maps"):
    return utilities.createPrivateFolder(
        user, name, upenn_utilities.datasetMetadata
    )


def _tile(server, item, user, z=0, x=0, y=0, **params):
    query = {
        "location": LOCATION, "sizeX": SIZE_X, "sizeY": SIZE_Y,
        "maxLevel": 0,
    }
    query.update(params)
    return server.request(
        "/scalar_map/%s/tiles/%s/%s/%s" % (item["_id"], z, x, y),
        user=user, params=query, isJson=False,
    )


def _rgba(resp):
    assertStatusOk(resp)
    assert resp.headers["Content-Type"] == "image/png"
    image = Image.open(io.BytesIO(b"".join(resp.body)))
    assert image.mode == "RGBA"
    return np.asarray(image)


def _message(resp):
    return json.loads(b"".join(resp.body))["message"]


def _unsupportedCompression():
    """An .npz whose member claims compression method 99, which zipfile
    does not implement (NotImplementedError on open)."""
    data = bytearray(_npz(**{
        LOCATION: np.zeros((ROWS, COLS), dtype=np.float32)
    }))
    central = data.index(b"PK\x01\x02")
    data[central + 10:central + 12] = (99).to_bytes(2, "little")
    return bytes(data)


def _replaceContentsInPlace(fileDoc, user, data):
    """Girder's in-place content replacement (PUT file/{id}/contents)."""
    upload = Upload().createUploadToFile(fileDoc, user, len(data))
    Upload().handleChunk(upload, io.BytesIO(data))
    return File().load(fileDoc["_id"], force=True)


def _bruteForceSample(array, origin, spacing, px, py):
    """Independent per-point reference of the documented semantics."""
    rows, cols = array.shape
    u = (px - origin[0]) / spacing
    v = (py - origin[1]) / spacing
    if not (0 <= u < cols and 0 <= v < rows):
        return math.nan
    if math.isnan(array[int(v), int(u)]):
        return math.nan
    cu = min(max(u - 0.5, 0), cols - 1)
    cv = min(max(v - 0.5, 0), rows - 1)
    c0, r0 = int(math.floor(cu)), int(math.floor(cv))
    c1, r1 = min(c0 + 1, cols - 1), min(r0 + 1, rows - 1)
    fx, fy = cu - c0, cv - r0
    total = weight = 0.0
    for r, c, w in (
        (r0, c0, (1 - fy) * (1 - fx)), (r0, c1, (1 - fy) * fx),
        (r1, c0, fy * (1 - fx)), (r1, c1, fy * fx),
    ):
        value = array[r, c]
        if not math.isnan(value):
            total += value * w
            weight += w
    return total / weight if weight > 0 else math.nan


class TestScalarMapHelpers:
    def testMetaValidation(self):
        validateScalarMapMeta(_meta())
        bad = [
            _meta(version=2), _meta(version=True), _meta(gridSpacingPx=0),
            _meta(gridSpacingPx=float("nan")), _meta(originPx=[0]),
            _meta(shape=[0, 3]), _meta(shape=[2.5, 3]),
            _meta(shape=[100000, 100000]), _meta(locations=[]),
            _meta(locations=[{"XY": 0, "Z": 0, "Time": 0, "key": "x"}]),
            _meta(locations=[{"key": LOCATION}]),
            _meta(locations=[
                {"XY": 0, "Z": 0, "Time": 0, "key": LOCATION},
                {"XY": 0, "Z": 0, "Time": 0, "key": LOCATION},
            ]),
            _meta(valueRange=[1, 0]), _meta(valueRange=[0, None]),
            _meta(percentiles=[1] + [0] * 100),
            _meta(percentiles=[0] * 100),
            _meta(percentiles=[0] * 102),
            _meta(percentiles=[0] * 100 + [float("nan")]),
            _meta(percentiles=[0] * 100 + [float("inf")]),
            _meta(originPx=[0, float("inf")]),
            "not a dict",
        ]
        for meta in bad:
            with pytest.raises(ValueError):
                validateScalarMapMeta(meta)
        noPercentiles = _meta()
        del noPercentiles["percentiles"]
        with pytest.raises(ValueError, match="percentiles"):
            validateScalarMapMeta(noPercentiles)

    @pytest.mark.parametrize("level", [0, 1, 2])
    def testSamplingMatchesBruteForce(self, level):
        rng = np.random.default_rng(level)
        array = rng.uniform(0, 10, (7, 9)).astype(np.float32)
        array[2, 3] = np.nan
        array[5, 0:2] = np.nan
        origin, spacing = (5.5, -3.0), 6.25
        maxLevel, tileSize = 2, 256
        xs, ys = tilePixelCenters(tileSize, maxLevel, level, 0, 0)
        # Keep the brute force cheap: every 3rd row/column of the tile.
        xs, ys = xs[::3], ys[::3]
        result = sampleScalarMap(array, origin, spacing, xs, ys)
        expected = np.array([
            [_bruteForceSample(array, origin, spacing, px, py) for px in xs]
            for py in ys
        ])
        np.testing.assert_allclose(result, expected, rtol=1e-6,
                                   equal_nan=True)
        assert np.isnan(result).any() and (~np.isnan(result)).any()

    def testTilePixelCentersFollowThePyramid(self):
        xs, ys = tilePixelCenters(256, 3, 1, 2, 1)
        # Level 1 of 3: one output pixel spans 4 image pixels.
        assert xs[0] == 2 * 256 * 4 + 2
        assert ys[0] == 256 * 4 + 2
        assert xs[1] - xs[0] == 4

    def testNanNeighborDoesNotPoisonValidPixel(self):
        array = np.array([[1.0, np.nan]], dtype=np.float32)
        # x = 7.5 is in cell 0 near its right edge: bilinear would mix in
        # the NaN cell; it must stay 1.0. x = 8.5 is in the NaN cell.
        result = sampleScalarMap(array, (0, 0), 8, [7.5, 8.5], [4])
        assert result[0, 0] == pytest.approx(1.0)
        assert np.isnan(result[0, 1])

    def testOutsideArrayIsNan(self):
        array = np.ones((2, 2), dtype=np.float32)
        result = sampleScalarMap(array, (10, 10), 5, [9.9, 10, 19.9, 20],
                                 [12])
        assert np.isnan(result[0, 0]) and np.isnan(result[0, 3])
        assert result[0, 1] == 1 and result[0, 2] == 1

    def testColormapEndpointsMatchAnchors(self):
        for name, first, last in (
            ("viridis", (0x44, 0x01, 0x54), (0xfd, 0xe7, 0x25)),
            ("magma", (0, 0, 4), (0xfc, 0xfd, 0xbf)),
            ("inferno", (0, 0, 4), (0xfc, 0xff, 0xa4)),
            ("gray", (0, 0, 0), (255, 255, 255)),
        ):
            lut = colormapLut(name)
            assert lut.shape == (256, 3)
            assert tuple(lut[0]) == first and tuple(lut[-1]) == last
        with pytest.raises(ValueError):
            colormapLut("plasma")

    def testThresholdDimsTheOtherSide(self):
        values = np.array([[0.2, 0.8, np.nan]])
        above = colorizeScalarValues(values, "viridis", 0, 1, 0.5, "above")
        assert list(above[0, :, 3]) == [THRESHOLD_DIM_ALPHA, 255, 0]
        below = colorizeScalarValues(values, "viridis", 0, 1, 0.5, "below")
        assert list(below[0, :, 3]) == [255, THRESHOLD_DIM_ALPHA, 0]
        plain = colorizeScalarValues(values, "viridis", 0, 1)
        assert list(plain[0, :, 3]) == [255, 255, 0]
        with pytest.raises(ValueError):
            colorizeScalarValues(values, "viridis", 1, 1)

    def testThresholdIsInclusive(self):
        # A value exactly at the cutoff is selected on both sides: the
        # worker's `Value at least` / `Value at most` are inclusive, and the
        # panel's "% selected" counts ties with the selected side.
        values = np.array([[0.5]])
        for side in ("above", "below"):
            rgba = colorizeScalarValues(values, "viridis", 0, 1, 0.5, side)
            assert rgba[0, 0, 3] == 255, side

    def testReadRejectsBadArrays(self, monkeypatch):
        good = np.zeros((ROWS, COLS), dtype=np.float64)
        array = readScalarMapArray(_npz(**{LOCATION: good}), LOCATION,
                                   [ROWS, COLS])
        assert array.dtype == np.float32
        cases = [
            (_npz(**{LOCATION: good}), "xy1_z0_t0", "no array"),
            (_npz(**{LOCATION: good.astype(np.int32)}), LOCATION, "float"),
            (_npz(**{LOCATION: np.zeros(4)}), LOCATION, "2-D"),
            (_npz(**{LOCATION: good}), LOCATION, "shape"),
            (b"not a zip", LOCATION, "readable"),
        ]
        for data, key, message in cases:
            shape = [ROWS + 1, COLS] if message == "shape" else [ROWS, COLS]
            with pytest.raises(ValueError, match=message):
                readScalarMapArray(data, key, shape)
        monkeypatch.setattr(scalarMap, "MAX_SCALAR_MAP_CELLS", 10)
        with pytest.raises(ValueError, match="larger than"):
            readScalarMapArray(_npz(**{LOCATION: good}), LOCATION,
                               [ROWS, COLS])

    def testBareNpyIsRefusedWithoutDecoding(self, monkeypatch):
        buffer = io.BytesIO()
        np.save(buffer, np.zeros((ROWS, COLS), dtype=np.float32))

        def refuse(*args, **kwargs):
            raise AssertionError("a bare .npy must not be decoded")

        monkeypatch.setattr(np, "load", refuse)
        monkeypatch.setattr(np.lib.format, "read_array", refuse)
        with pytest.raises(ValueError, match="not a readable .npz"):
            readScalarMapArray(buffer.getvalue(), LOCATION, [ROWS, COLS])

    def testChecksAndDecodesTheSameExplicitMember(self):
        good = np.arange(ROWS * COLS, dtype=np.float32).reshape(ROWS, COLS)
        decoy = io.BytesIO()
        np.save(decoy, np.zeros((ROWS + 1, COLS), dtype=np.int64))
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr(LOCATION, decoy.getvalue())
            with archive.open(LOCATION + ".npy", "w") as member:
                np.lib.format.write_array(member, good)
        # numpy's NpzFile would resolve the suffixless member for this key.
        array = readScalarMapArray(buffer.getvalue(), LOCATION, [ROWS, COLS])
        np.testing.assert_array_equal(array, good)

        # A member whose data is shorter than its header says is refused.
        whole = io.BytesIO()
        np.lib.format.write_array(whole, good)
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr(LOCATION + ".npy", whole.getvalue()[:-8])
        with pytest.raises(ValueError, match="truncated"):
            readScalarMapArray(buffer.getvalue(), LOCATION, [ROWS, COLS])

    def testEncryptedMemberIsRefused(self):
        whole = io.BytesIO()
        np.lib.format.write_array(whole, np.zeros((ROWS, COLS), np.float32))
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr(LOCATION + ".npy", whole.getvalue())
        # zipfile can't write encrypted members; set the "encrypted" flag in
        # the central directory, which is what zipfile checks on open.
        data = bytearray(buffer.getvalue())
        central = data.index(b"PK\x01\x02")
        data[central + 8] |= 0x1
        with pytest.raises(RuntimeError):
            zipfile.ZipFile(io.BytesIO(bytes(data))).open(LOCATION + ".npy")
        with pytest.raises(ValueError, match="not a readable .npz"):
            readScalarMapArray(bytes(data), LOCATION, [ROWS, COLS])

    def testUnsupportedCompressionIsRefused(self):
        with pytest.raises(ValueError, match="unsupported compression"):
            readScalarMapArray(_unsupportedCompression(), LOCATION,
                               [ROWS, COLS])

    @pytest.mark.parametrize("method", [
        zipfile.ZIP_BZIP2, zipfile.ZIP_LZMA,
    ])
    def testOnlyNumpysCompressionMethodsAreRead(self, method):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", compression=method) as archive:
            with archive.open(LOCATION + ".npy", "w") as member:
                np.lib.format.write_array(
                    member, np.zeros((ROWS, COLS), np.float32)
                )
        with pytest.raises(ValueError, match="unsupported compression"):
            readScalarMapArray(buffer.getvalue(), LOCATION, [ROWS, COLS])

    def testStorageFailureIsNotABadFile(self):
        data = _npz(**{LOCATION: np.zeros((ROWS, COLS), np.float32)})

        class FlakyHandle(io.BytesIO):
            reads = 0

            def read(self, size=-1):
                FlakyHandle.reads += 1
                if FlakyHandle.reads > 1:
                    raise OSError("connection reset by peer")
                return super().read(size)

        source = scalarMap._BoundedReads(FlakyHandle(data), 1024)
        with pytest.raises(ScalarMapStorageError):
            readScalarMapArray(source, LOCATION, [ROWS, COLS])
        assert not issubclass(ScalarMapStorageError, (ValueError, OSError))

    def testFlatRegionAtTheThresholdIsSelectedOnBothSides(self):
        # A constant float32 map at a spacing that is not a power of two:
        # bilinear weights used to land 121 of 2,500 pixels a hair below
        # 100 and 145 a hair above.
        array = np.full((4, 4), 100, dtype=np.float32)
        meta = _meta(gridSpacingPx=12.5, shape=[4, 4])
        xs, ys = tilePixelCenters(256, 0, 0, 0, 0)
        values = sampleScalarMap(array, (0, 0), 12.5, xs[:50], ys[:50])
        assert (values == 100).all()
        for side in ("above", "below"):
            png = renderScalarMapTile(
                array, meta, 50, 50, 256, 0, 0, 0, 0, "viridis", 0, 200,
                100.0, side,
            )
            rgba = np.asarray(Image.open(io.BytesIO(png)))
            assert (rgba[:50, :50, 3] == 255).all(), side

    def testInterpolationStaysWithinItsSamples(self):
        rng = np.random.default_rng(3)
        array = rng.uniform(-5, 5, (6, 7)).astype(np.float32)
        array[2, 2] = np.nan
        xs = np.linspace(0, 7 * 9.7, 301)
        ys = np.linspace(0, 6 * 9.7, 257)
        values = sampleScalarMap(array, (0, 0), 9.7, xs, ys)
        valid = ~np.isnan(values)
        assert values[valid].min() >= np.nanmin(array)
        assert values[valid].max() <= np.nanmax(array)

    def testRevisionCoversTheWholeMetadata(self):
        fileDoc = {"_id": "a" * 24, "size": 10}
        base = scalarMapRevision(fileDoc, _meta())
        assert scalarMapRevision(fileDoc, _meta()) == base
        for change in (
            {"locations": [
                {"XY": 0, "Z": 0, "Time": 0, "key": LOCATION},
                {"XY": 1, "Z": 0, "Time": 0, "key": "xy1_z0_t0"},
            ]},
            {"valueRange": [0.0, 2.0]},
            {"percentiles": [float(i) / 50 for i in range(101)]},
            {"originPx": [4, 0]},
            {"gridSpacingPx": 4},
            {"name": "renamed"},
        ):
            assert scalarMapRevision(fileDoc, _meta(**change)) != base, change
        # Key order does not matter (canonical JSON).
        reordered = dict(reversed(list(_meta().items())))
        assert scalarMapRevision(fileDoc, reordered) == base

    @pytest.mark.parametrize("value,expected", [
        (3.0, (2.5, 3.5)),
        (0.0, (-0.5, 0.5)),
        (1e17, (1e17 - 1e11, 1e17 + 1e11)),
    ])
    def testConstantMapDefaultRange(self, value, expected):
        low, high = defaultDisplayRange(
            _meta(valueRange=[value, value], percentiles=[value] * 101)
        )
        assert (low, high) == pytest.approx(expected)
        assert low < value < high

    def testFortranOrderMember(self):
        good = np.asfortranarray(
            np.arange(ROWS * COLS, dtype=np.float64).reshape(ROWS, COLS)
        )
        array = readScalarMapArray(_npz(**{LOCATION: good}), LOCATION,
                                   [ROWS, COLS])
        np.testing.assert_array_equal(array, good)
        assert array.flags["C_CONTIGUOUS"]


class TestScalarMapCache:
    """Single-flight cold loads and invalidation, with a counting reader in
    place of Girder's file read."""

    FILE = {"_id": "f" * 24, "size": 10}

    @pytest.fixture(autouse=True)
    def _emptyCache(self):
        scalarMap.clearScalarMapCache()
        yield
        scalarMap.clearScalarMapCache()

    def _countingReader(self, monkeypatch, gate=None, arrays=None,
                        stats=None):
        """Replace the file open with one that counts opens and the most
        archive reads in flight at once."""
        calls = []
        data = _npz(**(arrays or {
            LOCATION: np.ones((ROWS, COLS), dtype=np.float32)
        }))
        lock = threading.Lock()
        stats = stats if stats is not None else {}
        stats.update(active=0, peak=0)

        @contextlib.contextmanager
        def openFile(fileDoc):
            calls.append(fileDoc["_id"])
            with lock:
                stats["active"] += 1
                stats["peak"] = max(stats["peak"], stats["active"])
            try:
                if gate is not None:
                    gate.wait(5)
                else:
                    threading.Event().wait(0.05)
                yield io.BytesIO(data)
            finally:
                with lock:
                    stats["active"] -= 1

        monkeypatch.setattr(scalarMap, "_openMapFile", openFile)
        return calls

    def testConcurrentColdLoadsShareOneRead(self, monkeypatch):
        gate = threading.Event()
        calls = self._countingReader(monkeypatch, gate)
        barrier = threading.Barrier(8)
        results = []

        def load():
            barrier.wait()
            results.append(
                scalarMap.loadScalarMapArray(self.FILE, _meta(), LOCATION)
            )

        threads = [threading.Thread(target=load) for _ in range(8)]
        for thread in threads:
            thread.start()
        # Let every thread reach the per-key lock before the read finishes.
        threading.Timer(0.2, gate.set).start()
        for thread in threads:
            thread.join(10)
        assert len(calls) == 1
        assert len(results) == 8
        assert all(result is results[0] for result in results)

    def testLoadInFlightDuringInvalidateIsNotCached(self, monkeypatch):
        gate = threading.Event()
        calls = self._countingReader(monkeypatch, gate)
        thread = threading.Thread(
            target=scalarMap.loadScalarMapArray,
            args=(self.FILE, _meta(), LOCATION),
        )
        thread.start()
        while not calls:
            threading.Event().wait(0.01)
        scalarMap.invalidateScalarMapFiles([self.FILE["_id"]])
        gate.set()
        thread.join(10)
        assert scalarMap.scalarMapCacheBytes() == 0
        scalarMap.loadScalarMapArray(self.FILE, _meta(), LOCATION)
        assert len(calls) == 2
        assert scalarMap.scalarMapCacheBytes() > 0

    def testDifferentLocationsOfOneFileLoadOneAtATime(self, monkeypatch):
        keys = ["xy0_z%d_t0" % z for z in range(6)]
        arrays = {
            key: np.full((ROWS, COLS), index, dtype=np.float32)
            for index, key in enumerate(keys)
        }
        stats = {}
        calls = self._countingReader(
            monkeypatch, arrays=arrays, stats=stats
        )
        meta = _meta(locations=[
            {"XY": 0, "Z": z, "Time": 0, "key": key}
            for z, key in enumerate(keys)
        ])
        barrier = threading.Barrier(len(keys) * 2)
        results = {}

        def load(key):
            barrier.wait()
            results.setdefault(key, []).append(
                scalarMap.loadScalarMapArray(self.FILE, meta, key)
            )

        threads = [
            threading.Thread(target=load, args=(key,))
            for key in keys * 2
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(10)
        # One archive open per location, never two at once for the file.
        assert stats["peak"] == 1
        assert len(calls) == len(keys)
        for index, key in enumerate(keys):
            assert len(results[key]) == 2
            for array in results[key]:
                assert (array == index).all()

    def testCacheStaysWithinBudget(self, monkeypatch):
        self._countingReader(monkeypatch)
        arrayBytes = ROWS * COLS * 4
        monkeypatch.setattr(
            scalarMap, "MAX_SCALAR_MAP_CACHE_BYTES", arrayBytes * 2
        )
        for index in range(4):
            scalarMap.loadScalarMapArray(
                {"_id": "%024x" % index, "size": 10}, _meta(), LOCATION
            )
        assert scalarMap.scalarMapCacheBytes() == arrayBytes * 2
        assert MAX_SCALAR_MAP_CACHE_BYTES > arrayBytes * 2


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestScalarMapEndpoints:
    @pytest.fixture(autouse=True)
    def _emptyCache(self):
        scalarMap.clearScalarMapCache()
        yield
        scalarMap.clearScalarMapCache()

    def testListReturnsOnlyValidMapsAndEnforcesRead(
        self, server, admin, user, fsAssetstore
    ):
        folder = _privateDataset(admin)
        array = np.zeros((ROWS, COLS), dtype=np.float32)
        good = _uploadMap(admin, folder, {LOCATION: array}, _meta())
        _uploadMap(admin, folder, {LOCATION: array}, None, name="plain.npz")
        _uploadMap(admin, folder, {LOCATION: array}, _meta(version=2),
                   name="future.npz")
        # A map in a child folder is not directly in the dataset.
        child = Folder().createFolder(folder, "child", creator=admin)
        _uploadMap(admin, child, {LOCATION: array}, _meta())
        # Map metadata on an item with no file, and on one with two files,
        # cannot render: skipped.
        empty = Item().createItem("empty", admin, folder)
        Item().setMetadata(empty, {"nimbusScalarMap": _meta()})
        twoFiles = _uploadMap(admin, folder, {LOCATION: array}, _meta(),
                              name="two.npz")
        data = _npz(**{LOCATION: array})
        Upload().uploadFromFile(
            io.BytesIO(data), len(data), "extra.npz", "item", twoFiles,
            user=admin,
        )

        resp = server.request("/scalar_map", user=admin,
                              params={"datasetId": str(folder["_id"])})
        assertStatusOk(resp)
        assert [entry["itemId"] for entry in resp.json] == [
            str(good["_id"])
        ]
        assert resp.json[0]["meta"] == _meta()
        assert isinstance(resp.json[0]["updated"], str)
        goodFile = list(Item().childFiles(good))[0]
        assert resp.json[0]["revision"] == scalarMap.scalarMapRevision(
            goodFile, _meta()
        )
        assert set(resp.json[0]) == {"itemId", "updated", "revision", "meta"}

        resp = server.request("/scalar_map", user=user,
                              params={"datasetId": str(folder["_id"])})
        assertStatus(resp, 403)
        resp = server.request("/scalar_map",
                              params={"datasetId": str(folder["_id"])})
        assertStatus(resp, 401)
        resp = server.request("/scalar_map", user=admin)
        assertStatus(resp, 400)

        Folder().setUserAccess(folder, user, AccessType.READ, save=True)
        resp = server.request("/scalar_map", user=user,
                              params={"datasetId": str(folder["_id"])})
        assertStatusOk(resp)
        assert len(resp.json) == 1

    def testTileColorsNanAndOutside(self, server, admin, fsAssetstore):
        folder = _privateDataset(admin)
        array = np.zeros((ROWS, COLS), dtype=np.float32)
        array[:, 4:] = 1.0
        array[0, 0] = np.nan
        # Map covers only x < 56: the last 8 image columns are off-map.
        item = _uploadMap(
            admin, folder, {LOCATION: array[:, :7]},
            _meta(shape=[ROWS, 7]),
        )
        rgba = _rgba(_tile(server, item, admin))
        assert rgba.shape == (256, 256, 4)
        viridis = colormapLut("viridis")
        # Deep in a 0 cell and a 1 cell (away from bilinear blending).
        assert tuple(rgba[20, 12]) == tuple(viridis[0]) + (255,)
        assert tuple(rgba[20, 44]) == tuple(viridis[255]) + (255,)
        # NaN cell, off-map columns, and outside the image: transparent.
        assert rgba[3, 3, 3] == 0
        assert (rgba[:SIZE_Y, 56:SIZE_X, 3] == 0).all()
        assert (rgba[SIZE_Y:, :, 3] == 0).all()
        assert (rgba[:, SIZE_X:, 3] == 0).all()

        # Explicit range and another colormap.
        rgba = _rgba(_tile(server, item, admin, colormap="gray",
                           min=-1, max=1))
        gray = colormapLut("gray")
        assert tuple(rgba[20, 12, :3]) == tuple(gray[128])
        assert tuple(rgba[20, 44, :3]) == tuple(gray[255])

    def testTileThresholdBothSides(self, server, admin, fsAssetstore):
        folder = _privateDataset(admin)
        array = np.zeros((ROWS, COLS), dtype=np.float32)
        array[:, 4:] = 1.0
        item = _uploadMap(admin, folder, {LOCATION: array}, _meta())
        above = _rgba(_tile(server, item, admin, threshold=0.5))
        assert above[20, 12, 3] == THRESHOLD_DIM_ALPHA
        assert above[20, 44, 3] == 255
        below = _rgba(_tile(server, item, admin, threshold=0.5,
                            thresholdSide="below"))
        assert below[20, 12, 3] == 255
        assert below[20, 44, 3] == THRESHOLD_DIM_ALPHA

    def testTileAtLowerLevel(self, server, admin, fsAssetstore):
        folder = _privateDataset(admin)
        array = np.zeros((ROWS, COLS), dtype=np.float32)
        array[:, 4:] = 1.0
        item = _uploadMap(admin, folder, {LOCATION: array}, _meta())
        # maxLevel 1, level 0: one output pixel = 2 image pixels.
        rgba = _rgba(_tile(server, item, admin, maxLevel=1))
        viridis = colormapLut("viridis")
        assert tuple(rgba[10, 6, :3]) == tuple(viridis[0])
        assert tuple(rgba[10, 22, :3]) == tuple(viridis[255])
        assert (rgba[:, SIZE_X // 2:, 3] == 0).all()

    def testTileBadRequests(self, server, admin, fsAssetstore):
        folder = _privateDataset(admin)
        array = np.zeros((ROWS, COLS), dtype=np.float32)
        item = _uploadMap(admin, folder, {LOCATION: array}, _meta())
        plain = _uploadMap(admin, folder, {LOCATION: array}, None,
                           name="plain.npz")
        missing = _uploadMap(
            admin, folder, {LOCATION: array},
            _meta(locations=[{"XY": 1, "Z": 0, "Time": 0,
                              "key": "xy1_z0_t0"}]),
            name="missing.npz",
        )
        cases = [
            (item, {"x": 1}, "outside the tile pyramid"),
            (item, {"y": 1}, "outside the tile pyramid"),
            (item, {"z": 1}, "z must be between"),
            (item, {"location": "xy9_z0_t0"}, "location"),
            (item, {"colormap": "jet"}, "colormap"),
            (item, {"min": 1, "max": 1}, "min must be less than max"),
            (item, {"min": 2}, "min must be less than max"),
            (item, {"min": "nan"}, "finite"),
            (item, {"max": "inf"}, "finite"),
            (item, {"threshold": "inf"}, "finite"),
            (item, {"thresholdSide": "left"}, "thresholdSide"),
            (item, {"tileSize": 100}, "tileSize"),
            (item, {"sizeX": "abc"}, "sizeX"),
            (item, {"maxLevel": 99}, "maxLevel"),
            (plain, {}, "not a scalar map"),
            (missing, {"location": "xy1_z0_t0"}, "no array"),
        ]
        for target, overrides, message in cases:
            resp = _tile(server, target, admin, **overrides)
            assertStatus(resp, 400)
            assert message in _message(resp), (overrides, _message(resp))

    def testTileEnforcesRead(self, server, admin, user, fsAssetstore):
        folder = _privateDataset(admin)
        array = np.zeros((ROWS, COLS), dtype=np.float32)
        item = _uploadMap(admin, folder, {LOCATION: array}, _meta())
        assertStatus(_tile(server, item, user), 403)
        assertStatus(_tile(server, item, None), 401)

    def testCacheNotStaleAfterFileReplaced(
        self, server, admin, fsAssetstore
    ):
        folder = _privateDataset(admin)
        zeros = np.zeros((ROWS, COLS), dtype=np.float32)
        item = _uploadMap(admin, folder, {LOCATION: zeros}, _meta())
        viridis = colormapLut("viridis")
        assert tuple(_rgba(_tile(server, item, admin))[20, 12, :3]) == \
            tuple(viridis[0])
        assert scalarMap.scalarMapCacheBytes() == zeros.nbytes

        before = server.request("/scalar_map", user=admin, params={
            "datasetId": str(folder["_id"])}).json[0]["revision"]
        etagBefore = _tile(server, item, admin).headers["ETag"]

        for fileDoc in list(Item().childFiles(item)):
            File().remove(fileDoc)
        data = _npz(**{LOCATION: np.ones((ROWS, COLS), dtype=np.float32)})
        Upload().uploadFromFile(
            io.BytesIO(data), len(data), "hotspot_map_tool1.npz", "item",
            item, user=admin,
        )
        after = server.request("/scalar_map", user=admin, params={
            "datasetId": str(folder["_id"])}).json[0]["revision"]
        assert after != before
        resp = _tile(server, item, admin)
        assert resp.headers["ETag"] != etagBefore
        assert tuple(_rgba(resp)[20, 12, :3]) == tuple(viridis[255])

    def testMetadataOnlyEditChangesRevisionAndEtag(
        self, server, admin, fsAssetstore
    ):
        folder = _privateDataset(admin)
        array = np.zeros((ROWS, COLS), dtype=np.float32)
        item = _uploadMap(admin, folder, {LOCATION: array}, _meta())
        listParams = {"datasetId": str(folder["_id"])}
        before = server.request("/scalar_map", user=admin,
                                params=listParams).json[0]["revision"]
        etagBefore = _tile(server, item, admin).headers["ETag"]
        for change in (
            {"originPx": [4, 0]}, {"gridSpacingPx": 4},
            {"locations": [
                {"XY": 0, "Z": 0, "Time": 0, "key": LOCATION},
                {"XY": 1, "Z": 0, "Time": 0, "key": "xy1_z0_t0"},
            ]},
            {"valueRange": [0.0, 2.0]},
            {"percentiles": [float(i) / 50 for i in range(101)]},
        ):
            item = Item().setMetadata(
                item, {"nimbusScalarMap": _meta(**change)}
            )
            after = server.request("/scalar_map", user=admin,
                                   params=listParams).json[0]["revision"]
            assert after != before
            resp = _tile(server, item, admin)
            _rgba(resp)
            assert resp.headers["ETag"] != etagBefore
            before, etagBefore = after, resp.headers["ETag"]

    def testSameSizeReplacementWithoutChecksumIsNotStale(
        self, server, admin, fsAssetstore
    ):
        folder = _privateDataset(admin)

        # Uncompressed .npz files of one shape have identical sizes.
        def storedNpz(value):
            buffer = io.BytesIO()
            np.savez(buffer, **{
                LOCATION: np.full((ROWS, COLS), value, dtype=np.float32)
            })
            return buffer.getvalue()

        item = _uploadMap(admin, folder, {LOCATION: np.zeros(
            (ROWS, COLS), dtype=np.float32)}, _meta())
        fileDoc = list(Item().childFiles(item))[0]
        fileDoc = _replaceContentsInPlace(fileDoc, admin, storedNpz(0.0))

        # Simulate an assetstore that computes no checksum while tiles are
        # served. The filesystem assetstore needs the checksum back to
        # delete the old contents when they are replaced.
        def withoutChecksum(request):
            checksum = File().load(fileDoc["_id"], force=True)["sha512"]
            File().update({"_id": fileDoc["_id"]},
                          {"$unset": {"sha512": ""}})
            assert "sha512" not in File().load(fileDoc["_id"], force=True)
            try:
                return request()
            finally:
                File().update({"_id": fileDoc["_id"]},
                              {"$set": {"sha512": checksum}})

        viridis = colormapLut("viridis")
        first = withoutChecksum(lambda: _tile(server, item, admin))
        assert tuple(_rgba(first)[20, 12, :3]) == tuple(viridis[0])

        sizeBefore = File().load(fileDoc["_id"], force=True)["size"]
        _replaceContentsInPlace(
            File().load(fileDoc["_id"], force=True), admin, storedNpz(1.0)
        )
        assert File().load(fileDoc["_id"], force=True)["size"] == sizeBefore

        second = withoutChecksum(lambda: _tile(server, item, admin))
        assert second.headers["ETag"] != first.headers["ETag"]
        assert tuple(_rgba(second)[20, 12, :3]) == tuple(viridis[255])

    def testStorageFailureIsAServerError(
        self, server, admin, fsAssetstore, monkeypatch
    ):
        folder = _privateDataset(admin)
        item = _uploadMap(admin, folder, {
            LOCATION: np.zeros((ROWS, COLS), dtype=np.float32)
        }, _meta())

        class FlakyHandle:
            def __init__(self, handle):
                self._handle, self._reads = handle, 0

            def read(self, size=-1):
                self._reads += 1
                if self._reads > 1:
                    raise OSError("connection reset by peer")
                return self._handle.read(size)

            def seek(self, *args):
                return self._handle.seek(*args)

            def tell(self):
                return self._handle.tell()

            def __enter__(self):
                return self

            def __exit__(self, *args):
                self._handle.close()

        realFile = File()

        class FlakyFile:
            def open(self, fileDoc):
                return FlakyHandle(realFile.open(fileDoc))

        monkeypatch.setattr(scalarMap, "File", FlakyFile)
        resp = server.request(
            "/scalar_map/%s/tiles/0/0/0" % item["_id"], user=admin,
            params={"location": LOCATION, "sizeX": SIZE_X,
                    "sizeY": SIZE_Y, "maxLevel": 0},
            isJson=False, exception=True,
        )
        assertStatus(resp, 500)
        assert "not a readable .npz" not in _message(resp)

    def testCraftedArchiveIs400(self, server, admin, fsAssetstore):
        folder = _privateDataset(admin)
        data = _unsupportedCompression()
        upload = Upload().uploadFromFile(
            io.BytesIO(data), len(data), "crafted.npz", "folder", folder,
            user=admin,
        )
        item = Item().setMetadata(
            Item().load(upload["itemId"], force=True),
            {"nimbusScalarMap": _meta()},
        )
        resp = _tile(server, item, admin)
        assertStatus(resp, 400)
        assert "unsupported compression" in _message(resp)

    def testFileOverGirderSingleReadLimit(self, server, admin, fsAssetstore):
        # Girder's FileHandle refuses one read above 16 MiB by default;
        # random float32 doesn't compress, so the .npz is ~19 MB.
        shape = (2200, 2200)
        array = np.random.default_rng(0).uniform(
            0, 1, shape).astype(np.float32)
        folder = _privateDataset(admin)
        item = _uploadMap(admin, folder, {LOCATION: array},
                          _meta(shape=list(shape)))
        assert list(Item().childFiles(item))[0]["size"] > 16 * 1024 * 1024
        rgba = _rgba(_tile(server, item, admin, sizeX=2200, sizeY=2200,
                           maxLevel=4))
        assert (rgba[..., 3] == 255).any()

    def testTilesRevalidateWithEtag(self, server, admin, user, fsAssetstore):
        folder = _privateDataset(admin)
        array = np.zeros((ROWS, COLS), dtype=np.float32)
        item = _uploadMap(admin, folder, {LOCATION: array}, _meta())
        resp = _tile(server, item, admin)
        _rgba(resp)
        assert resp.headers["Cache-Control"] == \
            "private, max-age=0, must-revalidate"
        etag = resp.headers["ETag"]
        query = {"location": LOCATION, "sizeX": SIZE_X, "sizeY": SIZE_Y,
                 "maxLevel": 0}
        cached = server.request(
            "/scalar_map/%s/tiles/0/0/0" % item["_id"], user=admin,
            params=query, additionalHeaders=[("If-None-Match", etag)],
            isJson=False,
        )
        assertStatus(cached, 304)
        assert b"".join(cached.body) == b""
        # A different display parameter is a different tile.
        assert _tile(server, item, admin, colormap="gray").headers[
            "ETag"] != etag
        # Revalidation still checks READ: no 304 for someone without it.
        denied = server.request(
            "/scalar_map/%s/tiles/0/0/0" % item["_id"], user=user,
            params=query, additionalHeaders=[("If-None-Match", etag)],
            isJson=False,
        )
        assertStatus(denied, 403)

    @pytest.mark.parametrize("name", [
        "location", "sizeX", "sizeY", "maxLevel", "tileSize", "colormap",
        "min", "max", "threshold", "thresholdSide",
    ])
    def testRepeatedParamIs400(self, server, admin, fsAssetstore, name):
        folder = _privateDataset(admin)
        array = np.zeros((ROWS, COLS), dtype=np.float32)
        item = _uploadMap(admin, folder, {LOCATION: array}, _meta())
        values = {
            "location": LOCATION, "sizeX": SIZE_X, "sizeY": SIZE_Y,
            "maxLevel": 0, "tileSize": 256, "colormap": "viridis",
            "min": 0, "max": 1, "threshold": 0.5, "thresholdSide": "above",
        }
        # A list of pairs is the only way pytest-girder sends a repeated
        # query parameter.
        query = list(values.items()) + [(name, values[name])]
        resp = server.request(
            "/scalar_map/%s/tiles/0/0/0" % item["_id"], user=admin,
            params=query, isJson=False,
        )
        assertStatus(resp, 400)
        assert "must not be specified multiple times" in _message(resp)

    def testDeleteNeedsWriteAndRefusesNonMaps(
        self, server, admin, user, fsAssetstore
    ):
        folder = _privateDataset(admin)
        array = np.zeros((ROWS, COLS), dtype=np.float32)
        item = _uploadMap(admin, folder, {LOCATION: array}, _meta())
        plain = _uploadMap(admin, folder, {LOCATION: array}, None,
                           name="plain.npz")
        _rgba(_tile(server, item, admin))
        assert scalarMap.scalarMapCacheBytes() > 0

        Folder().setUserAccess(folder, user, AccessType.READ, save=True)
        resp = server.request("/scalar_map/%s" % item["_id"],
                              method="DELETE", user=user)
        assertStatus(resp, 403)
        resp = server.request("/scalar_map/%s" % plain["_id"],
                              method="DELETE", user=admin)
        assertStatus(resp, 400)
        assert Item().load(plain["_id"], force=True) is not None

        resp = server.request("/scalar_map/%s" % item["_id"],
                              method="DELETE", user=admin)
        assertStatusOk(resp)
        assert Item().load(item["_id"], force=True) is None
        assert scalarMap.scalarMapCacheBytes() == 0

    def testDefaultRangeOfConstantMap(self, server, admin, fsAssetstore):
        folder = _privateDataset(admin)
        array = np.full((ROWS, COLS), 3.0, dtype=np.float32)
        item = _uploadMap(admin, folder, {LOCATION: array},
                          _meta(valueRange=[3.0, 3.0],
                                percentiles=[3.0] * 101))
        rgba = _rgba(_tile(server, item, admin))
        assert tuple(rgba[20, 12, :3]) == tuple(colormapLut("viridis")[128])
        assert rgba[20, 12, 3] == 255

import io
import json
import math

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
    THRESHOLD_DIM_ALPHA,
    colorizeScalarValues,
    colormapLut,
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
            _meta(percentiles=[2, 1]), "not a dict",
        ]
        for meta in bad:
            with pytest.raises(ValueError):
                validateScalarMapMeta(meta)
        noPercentiles = _meta()
        del noPercentiles["percentiles"]
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

        resp = server.request("/scalar_map", user=admin,
                              params={"datasetId": str(folder["_id"])})
        assertStatusOk(resp)
        assert [entry["itemId"] for entry in resp.json] == [
            str(good["_id"])
        ]
        assert resp.json[0]["meta"] == _meta()
        assert isinstance(resp.json[0]["updated"], str)

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

        for fileDoc in list(Item().childFiles(item)):
            File().remove(fileDoc)
        data = _npz(**{LOCATION: np.ones((ROWS, COLS), dtype=np.float32)})
        Upload().uploadFromFile(
            io.BytesIO(data), len(data), "hotspot_map_tool1.npz", "item",
            item, user=admin,
        )
        assert tuple(_rgba(_tile(server, item, admin))[20, 12, :3]) == \
            tuple(viridis[255])

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

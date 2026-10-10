import io

import numpy as np
import pytest
import tifffile

from pytest_girder.assertions import assertStatus, assertStatusOk

from girder.constants import AccessType
from girder.exceptions import RestException
from girder.models.item import Item
from girder.models.upload import Upload
from girder_large_image.models.image_item import ImageItem

from ..server.api import rawRegion
from ..server.api.rawRegion import encodeRawTiff

from . import girder_utilities as utilities
from . import upenn_testing_utilities as upenn_utilities

WIDTH, HEIGHT = 64, 48


def _sixteenBitPlane():
    # Values above 255 that differ by less than 256 between neighbours: an
    # 8-bit conversion (floor-divide by 256) would collapse them
    return (
        np.arange(WIDTH * HEIGHT, dtype=np.uint16).reshape(HEIGHT, WIDTH)
        + 300
    )


def _sixteenBitRgb():
    plane = _sixteenBitPlane()
    return np.stack([plane, plane + 5000, plane + 10000], axis=-1)


def _createImageItem(admin, name, image, photometric):
    folder = utilities.createPrivateFolder(
        admin, name, upenn_utilities.datasetMetadata
    )
    buffer = io.BytesIO()
    tifffile.imwrite(
        buffer, image, photometric=photometric, tile=(16, 16),
    )
    data = buffer.getvalue()
    upload = Upload().uploadFromFile(
        io.BytesIO(data), len(data), "%s.tif" % name, "folder", folder,
        user=admin, mimeType="image/tiff",
    )
    item = Item().load(upload["itemId"], user=admin, level=AccessType.READ)
    # large_image's autoSet may already have marked the upload
    if "largeImage" not in item:
        file = list(Item().childFiles(item, limit=1))[0]
        ImageItem().createImageItem(item, file, user=admin, createJob=False)
    return Item().load(item["_id"], force=True)


@pytest.fixture
def sixteenBitItem(admin, fsAssetstore):
    return _createImageItem(
        admin, "plane", _sixteenBitPlane(), "minisblack"
    )


@pytest.fixture
def sixteenBitRgbItem(admin, fsAssetstore):
    return _createImageItem(admin, "rgb", _sixteenBitRgb(), "rgb")


def _getRegion(server, item, user, **params):
    return server.request(
        "/item/%s/raw_region" % item["_id"], user=user, params=params,
        isJson=False,
    )


def _bodyBytes(resp):
    return b"".join(resp.body)


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestRawRegion:
    def testReturnsSixteenBitSamplesUnscaled(
        self, server, admin, sixteenBitItem
    ):
        resp = _getRegion(
            server, sixteenBitItem, admin,
            left=10, top=5, right=42, bottom=37,
        )
        assertStatusOk(resp)
        assert resp.headers["Content-Type"] == "image/tiff"
        with tifffile.TiffFile(io.BytesIO(_bodyBytes(resp))) as tiff:
            assert len(tiff.pages) == 1
            page = tiff.pages[0]
            assert page.compression == 1
            assert not page.is_tiled
            image = page.asarray()
        assert image.dtype == np.uint16
        np.testing.assert_array_equal(
            image, _sixteenBitPlane()[5:37, 10:42]
        )

    def testDownsamplesToMaximumSize(self, server, admin, sixteenBitItem):
        resp = _getRegion(
            server, sixteenBitItem, admin,
            left=0, top=0, right=WIDTH, bottom=HEIGHT, width=16, height=16,
        )
        assertStatusOk(resp)
        image = tifffile.imread(io.BytesIO(_bodyBytes(resp)))
        assert image.dtype == np.uint16
        assert image.shape == (12, 16)
        # Nearest-neighbour sampling keeps source values, not averages
        assert np.isin(image, _sixteenBitPlane()).all()

    def testDownsampledMultibandKeepsSourceSamples(
        self, server, admin, sixteenBitRgbItem
    ):
        # large_image's default resampling sends multiband uint16 through
        # 8-bit PIL and multiplies back by 257
        resp = _getRegion(
            server, sixteenBitRgbItem, admin,
            left=0, top=0, right=WIDTH, bottom=HEIGHT, width=16, height=16,
        )
        assertStatusOk(resp)
        image = tifffile.imread(io.BytesIO(_bodyBytes(resp)))
        assert image.dtype == np.uint16
        assert image.shape == (12, 16, 3)
        sourcePixels = {tuple(p) for p in _sixteenBitRgb().reshape(-1, 3)}
        assert all(tuple(p) in sourcePixels for p in image.reshape(-1, 3))

    def testHugeOutputSizesMeanNoDownsampling(
        self, server, admin, sixteenBitItem
    ):
        # Larger than a float: must not overflow into a 500
        resp = _getRegion(
            server, sixteenBitItem, admin, left=0, top=0, right=8, bottom=8,
            width=10 ** 400, height=10 ** 400,
        )
        assertStatusOk(resp)
        np.testing.assert_array_equal(
            tifffile.imread(io.BytesIO(_bodyBytes(resp))),
            _sixteenBitPlane()[0:8, 0:8],
        )

    def testCoordinatesAreClampedToTheImage(
        self, server, admin, sixteenBitItem
    ):
        resp = _getRegion(
            server, sixteenBitItem, admin,
            left=-10, top=-3, right=8, bottom=WIDTH + 100,
        )
        assertStatusOk(resp)
        image = tifffile.imread(io.BytesIO(_bodyBytes(resp)))
        np.testing.assert_array_equal(image, _sixteenBitPlane()[:, 0:8])

    def testOutputOverTheByteLimitIsRejected(
        self, server, admin, sixteenBitItem, sixteenBitRgbItem, monkeypatch
    ):
        monkeypatch.setattr(rawRegion, "MAX_RAW_REGION_BYTES", 300)
        full = {"left": 0, "top": 0, "right": WIDTH, "bottom": HEIGHT}
        assertStatus(_getRegion(server, sixteenBitItem, admin, **full), 400)
        # Downsampled to 10x8 single-band uint16: 160 bytes, allowed
        resp = _getRegion(
            server, sixteenBitItem, admin, width=10, height=10, **full
        )
        assertStatusOk(resp)
        assert tifffile.imread(io.BytesIO(_bodyBytes(resp))).nbytes <= 300
        # The same pixels with three uint16 bands are 480 bytes: refused
        assertStatus(
            _getRegion(
                server, sixteenBitRgbItem, admin, width=10, height=10, **full
            ),
            400,
        )

    def testEmptyRegionIsRejected(self, server, admin, sixteenBitItem):
        resp = _getRegion(
            server, sixteenBitItem, admin,
            left=WIDTH + 10, top=0, right=WIDTH + 20, bottom=10,
        )
        assertStatus(resp, 400)

    @pytest.mark.parametrize("params", [
        {"right": "inf"},
        {"right": "nan"},
        {"width": 0},
        {"height": 0},
        {"width": 0, "height": 10 ** 400},
    ])
    def testMalformedRegionIsRejected(
        self, server, admin, sixteenBitItem, params
    ):
        resp = _getRegion(
            server, sixteenBitItem, admin,
            **{"left": 0, "top": 0, "right": 8, "bottom": 8, **params},
        )
        assertStatus(resp, 400)

    def testRequiresReadAccess(self, server, user, sixteenBitItem):
        resp = _getRegion(
            server, sixteenBitItem, user, left=0, top=0, right=8, bottom=8,
        )
        assertStatus(resp, 403)


@pytest.mark.parametrize("metadata, expected", [
    ({"dtype": "uint16", "bandCount": 1}, 2),
    ({"dtype": "uint8", "bandCount": 3}, 3),
    ({"dtype": "None", "bandCount": None}, 32),
    ({"dtype": None, "bandCount": 1}, 8),
])
def testByteLimitCountsDtypeAndBands(monkeypatch, metadata, expected):
    monkeypatch.setattr(rawRegion, "MAX_RAW_REGION_BYTES", expected)
    region = {"left": 0, "top": 0, "right": 1, "bottom": 1}
    rawRegion._requireOutputWithinLimit(metadata, region, {})
    monkeypatch.setattr(rawRegion, "MAX_RAW_REGION_BYTES", expected - 1)
    with pytest.raises(RestException):
        rawRegion._requireOutputWithinLimit(metadata, region, {})


def testByteLimitIgnoresFloatDriftAtTheRequestedSize():
    # 1588 x 1760 RGB float64 fits 64 MiB, but 2217 * (1760 / 2217) rounds
    # up to 1761 rows without clamping
    rawRegion._requireOutputWithinLimit(
        {"dtype": "float64", "bandCount": 3},
        {"left": 0, "top": 0, "right": 2000, "bottom": 2217},
        {"maxWidth": 1588, "maxHeight": 1760},
    )


def testEncodeRawTiffWritesOnePageForEveryBandCount():
    rgb = np.arange(4 * 3 * 3, dtype=np.uint16).reshape(4, 3, 3) * 1000
    with tifffile.TiffFile(io.BytesIO(encodeRawTiff(rgb))) as tiff:
        page = tiff.pages[0]
        assert page.photometric == tifffile.PHOTOMETRIC.RGB
        np.testing.assert_array_equal(page.asarray(), rgb)

    for bands in (2, 5):
        multiband = np.arange(4 * 3 * bands, dtype=np.uint16).reshape(
            4, 3, bands
        )
        with tifffile.TiffFile(io.BytesIO(encodeRawTiff(multiband))) as tiff:
            assert len(tiff.pages) == 1
            assert tiff.pages[0].samplesperpixel == bands
            np.testing.assert_array_equal(tiff.pages[0].asarray(), multiband)

    singleBand = np.full((4, 3, 1), 4095, dtype=np.uint16)
    decoded = tifffile.imread(io.BytesIO(encodeRawTiff(singleBand)))
    assert decoded.shape == (4, 3)
    assert (decoded == 4095).all()

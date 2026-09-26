import io
import json
import threading
import time

import bson
from bson.objectid import ObjectId
import numpy as np
import pytest
from PIL import Image

from girder.exceptions import ValidationException
from girder.models.folder import Folder
from girder.models.token import Token
from pytest_girder.assertions import assertStatus, assertStatusOk

from upenncontrast_annotation.server.api import annotation as annotationApi
from upenncontrast_annotation.server.helpers import annotationRaster
from upenncontrast_annotation.server.helpers.annotationRaster import (
    FilterMaskCache,
    FrameGeometryCache,
    RasterBuildBusy,
    RasterBuildRateLimited,
    RasterGeometryKey,
    RasterLayerSelector,
    _geometryFromDocuments,
    _geometryFromRawBatches,
    _geometryMatch,
    _geometryPipeline,
    _buildFrameGeometry,
    filterMaskCache,
    frameGeometryCache,
)
from upenncontrast_annotation.server.helpers.colormaps import (
    categoricalColor,
)
from upenncontrast_annotation.server.models import rasterFilter
from upenncontrast_annotation.server.models.annotation import Annotation
from upenncontrast_annotation.server.models.propertyValues import (
    AnnotationPropertyValues,
)

from . import girder_utilities as utilities
from . import upenn_testing_utilities as upenn_utilities


def createAnnotation(datasetId, coordinates, shape="polygon", **overrides):
    annotation = upenn_utilities.getSampleAnnotation(datasetId)
    annotation.update({
        "coordinates": coordinates,
        "shape": shape,
        "location": {"XY": 0, "Z": 0, "Time": 0},
        "tags": ["included"],
        "color": None,
    })
    annotation.update(overrides)
    return Annotation().create(annotation)


def rasterKey(datasetId="dataset", z=0, mode="shapes"):
    return RasterGeometryKey(
        datasetId=datasetId,
        selectors=(RasterLayerSelector(0, 0, z, 0),),
        mode=mode,
    )


GEOMETRY_FIELDS = (
    "vertices",
    "offsets",
    "bboxes",
    "centroids",
    "radii",
    "colors",
    "validColors",
    "shapes",
)


def assertSameGeometry(actual, expected):
    for field in GEOMETRY_FIELDS:
        actualValue = getattr(actual, field)
        expectedValue = getattr(expected, field)
        assert actualValue.dtype == expectedValue.dtype, field
        assert np.array_equal(
            actualValue,
            expectedValue,
            equal_nan=actualValue.dtype.kind == "f",
        ), field
    assert len(actual.grid) == len(expected.grid)
    for actualCell, expectedCell in zip(actual.grid, expected.grid):
        assert np.array_equal(actualCell, expectedCell)
    # The NaN document makes the union NaN, as it does on the decoded path.
    assert np.array_equal(
        actual.unionBounds, expected.unionBounds, equal_nan=True
    )
    assert actual.nbytes == expected.nbytes


def rawGeometryDocuments():
    """Documents covering the raw shapes path and each decoded fallback."""
    def floatPoints(count, offset=0.0):
        return [
            {"x": offset + index * 1.25, "y": offset - index * 0.5}
            for index in range(count)
        ]

    return [
        # Conforming: the layout the app writes, one- and two-digit keys.
        {"shape": "polygon", "coordinates": floatPoints(4, 10.5),
         "color": "#112233"},
        {"shape": "polygon", "coordinates": floatPoints(12, 3.1),
         "color": "#112233"},
        {"shape": "polygon", "coordinates": floatPoints(4, 99.9),
         "color": "#445566"},
        # Cancellation that numpy's pairwise sum resolves differently from
        # sum()'s left-to-right order: the centroid must follow sum().
        {"shape": "polygon",
         "coordinates": [
             {"x": value, "y": float(index)}
             for index, value in enumerate(
                 [1e17] + [1.0] * 7 + [-1e17] + [1.0] * 8
             )
         ],
         "color": "#445566"},
        # Integer coordinates and a z value decode through pymongo.
        {"shape": "polygon",
         "coordinates": [{"x": 0, "y": 0}, {"x": 10, "y": 0},
                         {"x": 10, "y": 10}],
         "color": "#112233"},
        {"shape": "point", "coordinates": [{"x": 5.5, "y": 6.5, "z": 1.0}],
         "color": "#112233"},
        # Other key order, and a NaN, have the conforming length.
        {"shape": "line",
         "coordinates": [{"y": 1.5, "x": 2.5}, {"y": 3.5, "x": 4.5}],
         "color": "#112233"},
        # NaN second: Python's min() keeps 2.0 where numpy's would be NaN.
        {"shape": "polygon",
         "coordinates": [{"x": 2.0, "y": 3.0},
                         {"x": float("nan"), "y": 1.0}],
         "color": "#112233"},
        # Skipped: empty, missing and null coordinates.
        {"shape": "polygon", "coordinates": [], "color": "#112233"},
        {"shape": "polygon", "color": "#112233"},
        {"shape": "polygon", "coordinates": None, "color": "#112233"},
        # Invalid, null and absent colors; unknown and null shapes; the
        # fields in another order.
        {"shape": "polygon", "coordinates": floatPoints(3), "color": "red"},
        {"shape": "polygon", "coordinates": floatPoints(3), "color": None},
        {"shape": "rectangle", "coordinates": floatPoints(4)},
        {"shape": "blob", "coordinates": floatPoints(3), "color": "#abcdef"},
        {"shape": None, "coordinates": floatPoints(3), "color": "#abcdef"},
        {"color": "#abcdef", "coordinates": floatPoints(5, -7.25),
         "shape": "polygon"},
    ]


def pointGeometry(count):
    """A frame geometry of ``count`` points, and its annotation id strings."""
    ids = [ObjectId() for _ in range(count)]
    geometry = _geometryFromDocuments(
        [
            {
                "_id": annotationId,
                "shape": "point",
                "coordinates": [{"x": index, "y": index}],
                "color": None,
            }
            for index, annotationId in enumerate(ids)
        ],
        rasterKey(),
    )
    return geometry, [str(annotationId) for annotationId in ids]


def responseBytes(response):
    if isinstance(response.body, list):
        return b"".join(response.body)
    return response.body


def responseImage(response):
    return Image.open(io.BytesIO(responseBytes(response))).convert("RGBA")


def requestTile(server, dataset, user=None, **overrides):
    params = {
        "datasetId": str(dataset["_id"]),
        "selectors": json.dumps([
            {"channel": 0, "XY": 0, "Z": 0, "Time": 0}
        ]),
        "sizeX": 1024,
        "sizeY": 1024,
        "tileSize": 512,
        "maxLevel": 1,
        "mode": "shapes",
    }
    params.update(overrides.pop("params", {}))
    return server.request(
        path="/upenn_annotation/raster/{}/{}/{}".format(
            overrides.pop("level", 1),
            overrides.pop("x", 0),
            overrides.pop("y", 0),
        ),
        method="GET",
        user=user,
        params=params,
        isJson=False,
        **overrides
    )


@pytest.fixture(autouse=True)
def clearRasterCache():
    frameGeometryCache.clear()
    filterMaskCache.clear()
    yield
    frameGeometryCache.clear()
    filterMaskCache.clear()


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestAnnotationRaster:
    def testGeometryPipelineUsesCanonicalLayerSelectors(self):
        key = RasterGeometryKey(
            datasetId="dataset",
            selectors=(
                RasterLayerSelector(channel=0, xy=2, z=3, time=4),
                RasterLayerSelector(channel=2, xy=2, z=None, time=None),
            ),
            mode="shapes",
        )

        assert _geometryPipeline(key)[0] == {
            "$match": {
                "datasetId": "dataset",
                "$or": [
                    {
                        "channel": 0,
                        "location.XY": 2,
                        "location.Z": 3,
                        "location.Time": 4,
                    },
                    {"channel": 2, "location.XY": 2},
                ],
            }
        }

    def testDistinctColdBuildsRespectGlobalConcurrencyLimit(
        self, monkeypatch
    ):
        buildStarted = threading.Event()
        finishBuild = threading.Event()
        builtKeys = []

        def build(_annotationModel, key):
            builtKeys.append(key)
            buildStarted.set()
            finishBuild.wait(timeout=2)
            return object()

        monkeypatch.setattr(annotationRaster, "_buildFrameGeometry", build)
        cache = FrameGeometryCache(maxConcurrentBuilds=1)
        firstKey = rasterKey(z=0)
        secondKey = rasterKey(z=1)
        firstResult = []
        worker = threading.Thread(
            target=lambda: firstResult.append(
                cache.get(object(), firstKey, ("v", 0, 0, 0))
            )
        )
        worker.start()
        assert buildStarted.wait(timeout=1)

        with pytest.raises(RasterBuildBusy):
            cache.get(object(), secondKey, ("v", 0, 0, 0))

        finishBuild.set()
        worker.join(timeout=2)
        assert not worker.is_alive()
        assert len(firstResult) == 1
        assert builtKeys == [firstKey]

    def testConcurrentRequestsForSameKeyBuildOnce(self, monkeypatch):
        buildStarted = threading.Event()
        finishBuild = threading.Event()
        builtKeys = []

        def build(_annotationModel, key):
            builtKeys.append(key)
            buildStarted.set()
            finishBuild.wait(timeout=2)
            return object()

        monkeypatch.setattr(annotationRaster, "_buildFrameGeometry", build)
        cache = FrameGeometryCache(maxConcurrentBuilds=1)
        key = rasterKey()
        version = ("v", 0, 0, 0)
        results = []
        first = threading.Thread(
            target=lambda: results.append(cache.get(object(), key, version))
        )
        second = threading.Thread(
            target=lambda: results.append(cache.get(object(), key, version))
        )

        first.start()
        assert buildStarted.wait(timeout=1)
        second.start()
        finishBuild.set()
        first.join(timeout=2)
        second.join(timeout=2)

        assert not first.is_alive()
        assert not second.is_alive()
        assert builtKeys == [key]
        assert len(results) == 2
        assert results[0] is results[1]

    def testNewerCachedVersionSatisfiesStaleRequest(self, monkeypatch):
        builtGeometries = []

        def build(_annotationModel, _key):
            geometry = object()
            builtGeometries.append(geometry)
            return geometry

        monkeypatch.setattr(annotationRaster, "_buildFrameGeometry", build)
        cache = FrameGeometryCache()
        key = rasterKey()
        oldVersion = ("process", 0, 0, 0)
        newVersion = ("process", 0, 1, 0)

        cache.get(object(), key, oldVersion)
        newest = cache.get(object(), key, newVersion)
        staleResult = cache.get(object(), key, oldVersion)

        assert len(builtGeometries) == 2
        assert staleResult is newest

    def testAnonymousColdBuildsAreRateLimitedButCacheHitsAreNot(
        self, monkeypatch
    ):
        builtKeys = []
        monkeypatch.setattr(
            annotationRaster,
            "_buildFrameGeometry",
            lambda _annotationModel, key: builtKeys.append(key) or object(),
        )
        cache = FrameGeometryCache(
            anonymousBuildLimit=2,
            anonymousBuildWindowSeconds=60,
        )
        version = ("v", 0, 0, 0)
        keys = [
            rasterKey(z=z)
            for z in range(3)
        ]
        identity = ("127.0.0.1", "dataset")

        first = cache.get(
            object(), keys[0], version, anonymousIdentity=identity
        )
        cache.get(object(), keys[1], version, anonymousIdentity=identity)
        assert (
            cache.get(
                object(), keys[0], version, anonymousIdentity=identity
            )
            is first
        )
        with pytest.raises(RasterBuildRateLimited):
            cache.get(
                object(), keys[2], version, anonymousIdentity=identity
            )

        assert builtKeys == keys[:2]

    @pytest.mark.parametrize(
        "error,status",
        [
            (RasterBuildBusy(), 503),
            (RasterBuildRateLimited(), 429),
        ],
    )
    def testColdBuildCapacityErrorsReturnRetryableResponses(
        self, admin, server, monkeypatch, error, status
    ):
        folder = utilities.createFolder(
            admin,
            "raster_capacity_{}".format(status),
            upenn_utilities.datasetMetadata,
        )
        Folder().setPublic(folder, True, save=True)
        anonymousIdentities = []

        def rejectBuild(
            _annotationModel,
            _tileParams,
            _version,
            anonymousIdentity=None,
        ):
            anonymousIdentities.append(anonymousIdentity)
            raise error

        monkeypatch.setattr(annotationApi, "getFrameGeometry", rejectBuild)
        response = requestTile(server, folder)

        assertStatus(response, status)
        assert response.headers["Retry-After"] == "1"
        assert anonymousIdentities[0][1] == str(folder["_id"])

    def testFilterMasksLiveOnTheGeometryAndAreCapped(self):
        """Masks are stored on the geometry (dropped with it when the
        geometry cache evicts it), a few per geometry, oldest first; the
        passing set is computed once per key."""
        cache = FilterMaskCache()
        geometry, ids = pointGeometry(3)
        calls = []

        def compute(passing):
            def run():
                calls.append(passing)
                return passing
            return run

        mask = cache.mask(geometry, "a", compute(ids[:2]))
        assert mask.tolist() == [True, True, False]
        assert cache.mask(geometry, "a", compute(ids)) is mask
        assert geometry.filterMasks == {"a": mask}
        assert not hasattr(cache, "_masks")

        other, _ = pointGeometry(2)
        # Same passing key on another geometry: the passing set is reused.
        assert cache.mask(other, "a", compute([])).tolist() == [
            False, False,
        ]
        assert len(calls) == 1

        limit = annotationRaster.RASTER_FILTER_MASKS_PER_GEOMETRY
        for index in range(limit):
            cache.mask(geometry, "k%d" % index, compute(ids[:1]))
        assert list(geometry.filterMasks) == [
            "k%d" % index for index in range(limit)
        ]

    def testAnonymousFilterBuildsAreRateLimitedButCacheHitsAreNot(self):
        cache = FilterMaskCache(anonymousBuildLimit=1)
        geometry, ids = pointGeometry(2)
        identity = ("127.0.0.1", "dataset")
        builds = []

        def compute():
            builds.append(1)
            return ids[:1]

        first = cache.mask(
            geometry, "a", compute, anonymousIdentity=identity
        )
        # A mask hit and a passing-set hit (a new geometry) are not builds.
        assert cache.mask(
            geometry, "a", compute, anonymousIdentity=identity
        ) is first
        cache.mask(
            pointGeometry(1)[0], "a", compute, anonymousIdentity=identity
        )
        with pytest.raises(RasterBuildRateLimited):
            cache.mask(geometry, "b", compute, anonymousIdentity=identity)
        # A signed-in caller is not limited.
        cache.mask(geometry, "b", compute)
        assert len(builds) == 2

    def testConcurrentFilterRequestsForSameKeyBuildOnce(self):
        cache = FilterMaskCache()
        geometry, ids = pointGeometry(2)
        started = threading.Event()
        finish = threading.Event()
        builds = []

        def compute():
            builds.append(1)
            started.set()
            finish.wait(timeout=2)
            return ids[:1]

        results = []
        first = threading.Thread(
            target=lambda: results.append(cache.mask(geometry, "a", compute))
        )
        second = threading.Thread(
            target=lambda: results.append(
                cache.mask(pointGeometry(2)[0], "a", compute)
            )
        )
        first.start()
        assert started.wait(timeout=1)
        second.start()
        finish.set()
        first.join(timeout=2)
        second.join(timeout=2)
        assert not first.is_alive() and not second.is_alive()
        assert len(results) == 2
        assert len(builds) == 1
        # The build's key lock is gone once the set is stored.
        assert cache._locks == {}

    def testFilterWaitOnSameKeyBuildIsBounded(self, monkeypatch):
        monkeypatch.setattr(
            annotationRaster, "RASTER_FILTER_BUILD_WAIT_SECONDS", 0.05
        )
        cache = FilterMaskCache()
        geometry, ids = pointGeometry(2)
        started = threading.Event()
        finish = threading.Event()

        def compute():
            started.set()
            finish.wait(timeout=2)
            return ids

        worker = threading.Thread(
            target=lambda: cache.mask(geometry, "a", compute)
        )
        worker.start()
        assert started.wait(timeout=1)
        with pytest.raises(RasterBuildBusy):
            cache.mask(pointGeometry(1)[0], "a", compute)
        finish.set()
        worker.join(timeout=2)
        assert not worker.is_alive()

    def testFailedFilterBuildIsNotCachedAndReleasesItsLock(self):
        cache = FilterMaskCache()
        geometry, ids = pointGeometry(2)

        def fail():
            raise ValueError("bad gate")

        with pytest.raises(ValueError):
            cache.mask(geometry, "a", fail)
        assert cache._locks == {}
        assert cache.mask(geometry, "a", lambda: ids).tolist() == [
            True, True,
        ]

    def testRasterFilterRegistrationsAreCappedPerUser(
        self, admin, user, monkeypatch
    ):
        monkeypatch.setattr(rasterFilter, "MAX_RASTER_FILTERS_PER_USER", 3)
        model = rasterFilter.RasterFilter()
        datasetId = ObjectId()
        keys = []
        for index in range(5):
            keys.append(model.register(
                datasetId, {"tags": {"values": [str(index)]}}, admin
            ))
            # Mongo stores milliseconds: keep "oldest" unambiguous.
            time.sleep(0.005)
        otherKey = model.register(datasetId, {"tags": {"values": ["x"]}},
                                  user)
        remaining = {
            document["_id"]: document["userId"]
            for document in model.find({"_id": {"$in": keys + [otherKey]}})
        }
        # The admin's two oldest are gone; the other user's is untouched.
        assert set(remaining) == set(keys[2:]) | {otherKey}
        assert remaining[otherKey] == user["_id"]
        assert model.filtersFor(keys[0], datasetId) is None
        assert model.filtersFor(keys[4], datasetId) == {
            "tags": {"values": ["4"]}
        }
        # The upserted document goes through validate().

        def reject(document):
            raise ValidationException("rejected")

        monkeypatch.setattr(model, "validate", reject)
        with pytest.raises(ValidationException):
            model.register(datasetId, {"tags": {"values": ["y"]}}, admin)

    @pytest.mark.parametrize(
        "error,status",
        [
            (RasterBuildBusy(), 503),
            (RasterBuildRateLimited(), 429),
        ],
    )
    def testFilterBuildCapacityErrorsReturnRetryableResponses(
        self, admin, server, monkeypatch, error, status
    ):
        folder = utilities.createFolder(
            admin,
            "raster_filter_capacity_{}".format(status),
            upenn_utilities.datasetMetadata,
        )
        Folder().setPublic(folder, True, save=True)
        identities = []

        def rejectMask(_geometry, _key, _compute, anonymousIdentity=None):
            identities.append(anonymousIdentity)
            raise error

        monkeypatch.setattr(annotationApi.filterMaskCache, "mask", rejectMask)
        response = requestTile(server, folder, params={"filter": "0" * 64})

        assertStatus(response, status)
        assert response.headers["Retry-After"] == "1"
        assert identities[0][1] == str(folder["_id"])

    def testGeometryCacheEvictsByRetainedBytes(self, monkeypatch):
        class SizedGeometry:
            def __init__(self, nbytes):
                self.nbytes = nbytes

        builtKeys = []
        monkeypatch.setattr(
            annotationRaster,
            "_buildFrameGeometry",
            lambda _annotationModel, key: (
                builtKeys.append(key) or SizedGeometry(6)
            ),
        )
        cache = FrameGeometryCache(maxBytes=10, maxEntries=10)
        version = ("v", 0, 0, 0)
        firstKey = rasterKey(z=0)
        secondKey = rasterKey(z=1)

        cache.get(object(), firstKey, version)
        second = cache.get(object(), secondKey, version)
        assert cache.get(object(), secondKey, version) is second
        cache.get(object(), firstKey, version)

        assert builtKeys == [firstKey, secondKey, firstKey]

    def testGeometryConstructionTraversesCoordinatesOnce(self):
        class CountingCoordinates(list):
            def __init__(self, values):
                super().__init__(values)
                self.iterations = 0

            def __iter__(self):
                self.iterations += 1
                return super().__iter__()

        polygon = CountingCoordinates([
            {"x": 0, "y": 0},
            {"x": 10, "y": 0},
            {"x": 10, "y": 10},
            {"x": 0, "y": 10},
        ])
        point = CountingCoordinates([{"x": 100, "y": 100}])

        geometry = _geometryFromDocuments(
            [
                {
                    "color": "#112233",
                    "coordinates": polygon,
                    "shape": "polygon",
                },
                {
                    "color": None,
                    "coordinates": point,
                    "shape": "point",
                },
            ],
            rasterKey(),
        )

        assert polygon.iterations == 1
        assert point.iterations == 1
        assert geometry.offsets.tolist() == [0, 4, 5]
        assert geometry.coordinates(0).tolist() == [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
        ]
        assert geometry.bboxes.tolist() == [
            [0, 0, 10, 10],
            [100, 100, 100, 100],
        ]
        assert geometry.centroids.tolist() == [[5, 5], [100, 100]]
        assert geometry.radii.tolist() == [5, 0]
        # 320 bytes of geometry + two 12-byte annotation ids (used to mask
        # the frame to the viewer's filters).
        assert geometry.nbytes == 344
        assert geometry.candidates((-1, -1, 11, 11)).tolist() == [0]
        assert geometry.candidates((99, 99, 101, 101)).tolist() == [1]

    def testRawBatchGeometryMatchesDecodedGeometry(self):
        encoded = [
            bson.encode({"_id": bson.ObjectId(), **document})
            for document in rawGeometryDocuments()
        ]
        # Documents split across batches, as a cursor returns them.
        geometry = _geometryFromRawBatches(
            [b"".join(encoded[:5]), b"".join(encoded[5:])]
        )

        assertSameGeometry(
            geometry,
            _geometryFromDocuments(
                [bson.decode(document) for document in encoded],
                rasterKey(),
            ),
        )
        # Every document with coordinates, the integer and z ones included.
        assert geometry.count == 14
        assert geometry.coordinates(4).tolist() == [
            [0, 0], [10, 0], [10, 10],
        ]
        assert geometry.validColors.tolist().count(False) == 3

    def testShapesBuildReadsFrameFromMongo(self, db):
        datasetId = bson.ObjectId()
        documents = [
            {
                "datasetId": datasetId,
                "channel": 0,
                "location": {"XY": 0, "Z": 0, "Time": 0},
                **document,
            }
            for document in rawGeometryDocuments()
        ]
        # Another channel and another dataset stay out of the frame.
        documents.append({**documents[0], "channel": 1})
        documents.append({**documents[0], "datasetId": bson.ObjectId()})
        Annotation().collection.insert_many(documents)
        key = rasterKey(datasetId)

        geometry = _buildFrameGeometry(Annotation(), key)

        assertSameGeometry(
            geometry,
            _geometryFromDocuments(
                Annotation().find(_geometryMatch(key), sort=[("_id", 1)]),
                key,
            ),
        )
        assert geometry.count == 14

    def testPolygonAndSubpixelRendering(self, admin, server):
        folder = utilities.createFolder(
            admin, "raster_polygon", upenn_utilities.datasetMetadata
        )
        createAnnotation(folder["_id"], [
            {"x": 10, "y": 10},
            {"x": 30, "y": 10},
            {"x": 30, "y": 30},
            {"x": 10, "y": 30},
        ])
        createAnnotation(folder["_id"], [
            {"x": 100, "y": 100},
            {"x": 101, "y": 100},
            {"x": 101, "y": 101},
            {"x": 100, "y": 101},
        ])

        full = requestTile(server, folder, admin)
        assertStatusOk(full)
        assert full.headers["Content-Type"].startswith("image/png")
        assert responseImage(full).getpixel((20, 20))[3] == 255

        low = requestTile(server, folder, admin, level=0)
        assertStatusOk(low)
        assert responseImage(low).getpixel((50, 50))[3] == 255

    def testTileBoundaryAndTransparentPadding(self, admin, server):
        folder = utilities.createFolder(
            admin, "raster_boundary", upenn_utilities.datasetMetadata
        )
        createAnnotation(folder["_id"], [
            {"x": 510, "y": 20},
            {"x": 514, "y": 20},
            {"x": 514, "y": 30},
            {"x": 510, "y": 30},
        ])

        left = responseImage(requestTile(server, folder, admin))
        right = responseImage(requestTile(server, folder, admin, x=1))
        assert left.getpixel((511, 25))[3] == 255
        assert right.getpixel((0, 25))[3] == 255

        padded = responseImage(requestTile(
            server,
            folder,
            admin,
            x=1,
            y=1,
            params={"sizeX": 600, "sizeY": 600},
        ))
        assert padded.getpixel((400, 400)) == (0, 0, 0, 0)

        createAnnotation(
            folder["_id"],
            [{"x": 700, "y": 100}],
            shape="point",
        )
        clipped = responseImage(requestTile(
            server,
            folder,
            admin,
            x=1,
            params={"sizeX": 600, "sizeY": 600},
        ))
        assert clipped.getpixel((188, 100)) == (0, 0, 0, 0)

    def testLayerSelectorsFilterFrameChannelAndColors(self, admin, server):
        folder = utilities.createFolder(
            admin, "raster_filters", upenn_utilities.datasetMetadata
        )
        createAnnotation(
            folder["_id"],
            [{"x": 20, "y": 20}],
            shape="point",
            color="#112233",
        )
        createAnnotation(
            folder["_id"],
            [{"x": 60, "y": 60}],
            shape="point",
            channel=1,
        )
        createAnnotation(
            folder["_id"],
            [{"x": 90, "y": 90}],
            shape="point",
            location={"XY": 0, "Z": 1, "Time": 0},
        )

        response = requestTile(
            server,
            folder,
            admin,
            params={
                "selectors": json.dumps([
                    {"channel": 0, "XY": 0, "Z": 0, "Time": 0}
                ]),
                "color": "#AABBCC",
            },
        )
        assertStatusOk(response)
        image = responseImage(response)
        assert image.getpixel((20, 20)) == (17, 34, 51, 255)
        assert image.getpixel((60, 60)) == (0, 0, 0, 0)
        assert image.getpixel((90, 90)) == (0, 0, 0, 0)

    def testRegisteredFilterDrawsOnlyPassingObjects(
        self, admin, user, server
    ):
        """The overview follows the viewer's filters: a registered filter
        (tags here; gates and id lists travel the same way) leaves the
        objects failing it out of the tile."""
        folder = utilities.createFolder(
            admin, "raster_viewer_filters", upenn_utilities.datasetMetadata
        )
        # Private, so the non-owner `user` fixture has no access.
        Folder().setPublic(folder, False, save=True)
        kept = createAnnotation(
            folder["_id"], [{"x": 20, "y": 20}], shape="point",
            color="#112233", tags=["B"],
        )
        createAnnotation(
            folder["_id"], [{"x": 60, "y": 60}], shape="point",
            color="#445566", tags=["T"],
        )

        def register(filters, who=admin):
            return server.request(
                path="/upenn_annotation/raster/filter", method="POST",
                user=who, type="application/json",
                body=json.dumps({
                    "datasetId": str(folder["_id"]), "filters": filters,
                }),
            )

        resp = register({"tags": {"values": ["B"], "exclusive": False}})
        assertStatusOk(resp)
        key = resp.json["key"]
        # Content-addressed: the same spec is the same key.
        assert register(
            {"tags": {"values": ["B"], "exclusive": False}}
        ).json["key"] == key

        unfiltered = responseImage(requestTile(server, folder, admin))
        assert unfiltered.getpixel((60, 60)) == (68, 85, 102, 255)
        response = requestTile(
            server, folder, admin, params={"filter": key}
        )
        assertStatusOk(response)
        image = responseImage(response)
        assert image.getpixel((20, 20)) == (17, 34, 51, 255)
        assert image.getpixel((60, 60)) == (0, 0, 0, 0)
        # The filter is part of the tile identity.
        assert response.headers["ETag"] != requestTile(
            server, folder, admin
        ).headers["ETag"]

        # An id-list filter (the selection) works the same way.
        resp = register({"idConstraints": [[str(kept["_id"])]]})
        image = responseImage(requestTile(
            server, folder, admin, params={"filter": resp.json["key"]}
        ))
        assert image.getpixel((20, 20)) == (17, 34, 51, 255)
        assert image.getpixel((60, 60)) == (0, 0, 0, 0)

        # Validation and access: bad filters 400, no access 403, anonymous
        # 401, a malformed key 400, an unknown key 404, and a key from
        # another dataset does not apply here.
        assertStatus(register({"tags": "B"}), 400)
        assertStatus(register({}, who=user), 403)
        assertStatus(register({}, who=None), 401)
        assertStatus(requestTile(
            server, folder, admin, params={"filter": "nope"}
        ), 400)
        assertStatus(requestTile(
            server, folder, admin, params={"filter": "0" * 64}
        ), 404)
        other = utilities.createFolder(
            admin, "raster_other", upenn_utilities.datasetMetadata
        )
        assertStatus(requestTile(
            server, other, admin, params={"filter": key}
        ), 404)

    def testPointRadiusIsConstantAcrossLevels(self, admin, server):
        folder = utilities.createFolder(
            admin, "raster_points", upenn_utilities.datasetMetadata
        )
        createAnnotation(
            folder["_id"], [{"x": 100, "y": 100}], shape="point"
        )

        full = responseImage(requestTile(
            server,
            folder,
            admin,
            params={"pointRadius": 4},
        ))
        low = responseImage(requestTile(
            server,
            folder,
            admin,
            level=0,
            params={"pointRadius": 4},
        ))
        assert full.getpixel((104, 100))[3] == 255
        assert low.getpixel((54, 50))[3] == 255

    def testImagePyramidLevelControlsCoordinateScale(self, admin, server):
        folder = utilities.createFolder(
            admin, "raster_coordinate_scale", upenn_utilities.datasetMetadata
        )
        createAnnotation(
            folder["_id"], [{"x": 100, "y": 100}], shape="point"
        )

        image = responseImage(requestTile(
            server,
            folder,
            admin,
            level=1,
            params={"maxLevel": 2},
        ))

        assert image.getpixel((50, 50))[3] == 255
        assert image.getpixel((100, 100))[3] == 0

    def testDiscsMode(self, admin, server):
        folder = utilities.createFolder(
            admin, "raster_discs", upenn_utilities.datasetMetadata
        )
        createAnnotation(folder["_id"], [
            {"x": 90, "y": 90},
            {"x": 110, "y": 90},
            {"x": 110, "y": 110},
            {"x": 90, "y": 110},
        ])
        response = requestTile(
            server, folder, admin, params={"mode": "discs"}
        )
        assertStatusOk(response)
        image = responseImage(response)
        assert image.getpixel((100, 100))[3] == 255
        assert image.getpixel((110, 100))[3] == 255
        assert image.getpixel((111, 100))[3] == 0

    @pytest.mark.parametrize(
        "path,params",
        [
            ((2, 0, 0), {}),
            ((1, 2, 0), {}),
            ((1, 0, 0), {"tileSize": 300}),
            ((1, 0, 0), {"sizeX": 200000}),
            ((1, 0, 0), {"maxLevel": -1}),
            ((1, 0, 0), {"selectors": "not-json"}),
            ((1, 0, 0), {"color": "yellow"}),
        ],
    )
    def testInvalidInputsReturn400(self, admin, server, path, params):
        folder = utilities.createFolder(
            admin, "raster_invalid_{}".format(path),
            upenn_utilities.datasetMetadata,
        )
        response = requestTile(
            server,
            folder,
            admin,
            level=path[0],
            x=path[1],
            y=path[2],
            params=params,
        )
        assertStatus(response, 400)

    @pytest.mark.parametrize(
        "selectors,message",
        [
            ([], "selectors must contain at least one layer"),
            ({"channel": 0}, "selectors must be a list"),
            ([1], "selectors[0] must be a JSON object"),
            ([{"channel": -1}], "selectors[0].channel must be non-negative"),
            (
                [{"channel": 0, "XY": -1}],
                "selectors[0].XY must be non-negative",
            ),
            (
                [{"channel": 0, "extra": 1}],
                "selectors[0] contains unsupported fields",
            ),
            (
                [{"channel": index} for index in range(65)],
                "selectors exceeds the maximum of 64",
            ),
        ],
    )
    def testSelectorValidationReturnsSpecific400(
        self, admin, server, selectors, message
    ):
        folder = utilities.createFolder(
            admin,
            "raster_selector_validation",
            upenn_utilities.datasetMetadata,
        )
        response = requestTile(
            server,
            folder,
            admin,
            params={"selectors": json.dumps(selectors)},
        )

        assertStatus(response, 400)
        assert message in json.loads(responseBytes(response))["message"]

    def testAccessAndEtagInvalidation(self, admin, server):
        folder = utilities.createFolder(
            admin, "raster_access", upenn_utilities.datasetMetadata
        )
        Folder().setPublic(folder, False, save=True)
        private = requestTile(server, folder)
        assertStatus(private, 401)

        token = Token().createToken(admin)
        cookieAuthenticated = requestTile(
            server,
            folder,
            cookie="girderToken={}".format(token["_id"]),
        )
        assertStatusOk(cookieAuthenticated)

        Folder().setPublic(folder, True, save=True)
        first = requestTile(server, folder)
        assertStatusOk(first)
        etag = first.headers["ETag"]
        cached = requestTile(
            server, folder, additionalHeaders=[("If-None-Match", etag)]
        )
        assertStatus(cached, 304)

        createAnnotation(
            folder["_id"], [{"x": 30, "y": 30}], shape="point"
        )
        changed = requestTile(server, folder)
        assertStatusOk(changed)
        assert changed.headers["ETag"] != etag
        assert responseImage(changed).getpixel((30, 30))[3] == 255

    def testEveryModelMutationPathInvalidatesEtag(self, admin, server):
        folder = utilities.createFolder(
            admin, "raster_mutations", upenn_utilities.datasetMetadata
        )
        Folder().setPublic(folder, True, save=True)
        annotationModel = Annotation()
        annotation = createAnnotation(
            folder["_id"], [{"x": 40, "y": 40}], shape="point"
        )

        etag = requestTile(server, folder).headers["ETag"]
        annotation["color"] = "#123456"
        annotationModel.save(annotation)
        savedEtag = requestTile(server, folder).headers["ETag"]
        assert savedEtag != etag

        annotation["color"] = "#654321"
        annotationModel.saveMany([annotation])
        saveManyEtag = requestTile(server, folder).headers["ETag"]
        assert saveManyEtag != savedEtag

        annotationModel.remove(annotation)
        removedEtag = requestTile(server, folder).headers["ETag"]
        assert removedEtag != saveManyEtag

        batch = [createAnnotation(
            folder["_id"], [{"x": 50, "y": 50}], shape="point"
        )]
        batchEtag = requestTile(server, folder).headers["ETag"]
        annotationModel.deleteMultiple([
            str(document["_id"]) for document in batch
        ])
        assert requestTile(server, folder).headers["ETag"] != batchEtag

    def testColorByPropertyInvalidatesEtagAndRepaints(self, admin, server):
        # The color-by-property paths write colors with bulk_write/update
        # instead of save()/saveMany(), so they get no raster-version bump for
        # free — without an explicit one this tile keeps 304-ing the
        # pre-recolor image (and its cached geometry keeps the old colors)
        # until the 120s TTL rotation.
        folder = utilities.createFolder(
            admin, "raster_color_by_property", upenn_utilities.datasetMetadata
        )
        Folder().setPublic(folder, True, save=True)
        annotation = createAnnotation(
            folder["_id"], [{"x": 30, "y": 30}], shape="point"
        )
        AnnotationPropertyValues().appendValues(
            {"propA": "cluster"}, annotation["_id"], folder["_id"]
        )

        etag = requestTile(server, folder).headers["ETag"]
        Annotation().colorByProperty(
            folder["_id"], ["propA"], mode="categorical"
        )
        colored = requestTile(server, folder)
        coloredEtag = colored.headers["ETag"]
        assert coloredEtag != etag
        # The one category takes the leading palette color, and the raster must
        # be drawing that color rather than a cached pre-recolor tile.
        expected = categoricalColor(0)
        assert responseImage(colored).getpixel((30, 30)) == (
            int(expected[1:3], 16),
            int(expected[3:5], 16),
            int(expected[5:7], 16),
            255,
        )

        # Clearing is the symmetric path (the "Remove coloring" flow) and it
        # skips _writeColors entirely.
        Annotation().clearColors(folder["_id"])
        cleared = requestTile(server, folder)
        assert cleared.headers["ETag"] != coloredEtag
        # A null color falls back to the request's fallback fill, so the
        # property color is really gone rather than merely re-fetched.
        assert responseImage(cleared).getpixel((30, 30)) == (
            0xFF, 0xD7, 0x00, 255
        )

    def testFailedColorWritesStillInvalidateRaster(
        self, admin, server, monkeypatch
    ):
        # Unordered bulk writes can raise after applying only some
        # operations, and a clear's update_many can fail partway too. The
        # frontend already treats a non-400 failure as "colors may have
        # changed" and refetches; the server cache must reach the same
        # conclusion, or it keeps serving the pre-failure image (geometry
        # cache + 304s) until the 120s TTL rotation.
        folder = utilities.createFolder(
            admin, "raster_color_failure", upenn_utilities.datasetMetadata
        )
        Folder().setPublic(folder, True, save=True)
        annotation = createAnnotation(
            folder["_id"], [{"x": 30, "y": 30}], shape="point"
        )
        AnnotationPropertyValues().appendValues(
            {"propA": 1}, annotation["_id"], folder["_id"]
        )
        model = Annotation()

        def explode(*args, **kwargs):
            raise RuntimeError("simulated mid-write failure")

        etag = requestTile(server, folder).headers["ETag"]
        monkeypatch.setattr(model, "_applyColorOperations", explode)
        with pytest.raises(RuntimeError):
            model.colorByProperty(folder["_id"], ["propA"])
        monkeypatch.undo()
        failedAssignEtag = requestTile(server, folder).headers["ETag"]
        assert failedAssignEtag != etag

        monkeypatch.setattr(model, "update", explode)
        with pytest.raises(RuntimeError):
            model.clearColors(folder["_id"])
        monkeypatch.undo()
        assert (
            requestTile(server, folder).headers["ETag"] != failedAssignEtag
        )

    def testBulkMoveInvalidatesSourceAndDestinationRasters(
        self, admin, server
    ):
        source = utilities.createFolder(
            admin, "raster_move_source", upenn_utilities.datasetMetadata
        )
        destination = utilities.createFolder(
            admin, "raster_move_destination", upenn_utilities.datasetMetadata
        )
        Folder().setPublic(source, True, save=True)
        Folder().setPublic(destination, True, save=True)
        annotation = createAnnotation(
            source["_id"], [{"x": 30, "y": 30}], shape="point"
        )

        sourceEtag = requestTile(server, source).headers["ETag"]
        destinationEtag = requestTile(server, destination).headers["ETag"]

        Annotation().updateMultiple(
            {annotation["_id"]: {"datasetId": destination["_id"]}}, admin
        )

        movedSource = requestTile(server, source)
        movedDestination = requestTile(server, destination)
        assert movedSource.headers["ETag"] != sourceEtag
        assert movedDestination.headers["ETag"] != destinationEtag
        assert responseImage(movedSource).getpixel((30, 30))[3] == 0
        assert responseImage(movedDestination).getpixel((30, 30))[3] == 255

import io
import json
import threading

import pytest
from PIL import Image

from girder.models.folder import Folder
from girder.models.token import Token
from pytest_girder.assertions import assertStatus, assertStatusOk

from upenncontrast_annotation.server.api import annotation as annotationApi
from upenncontrast_annotation.server.helpers import annotationRaster
from upenncontrast_annotation.server.helpers.annotationRaster import (
    FrameGeometryCache,
    RasterBuildBusy,
    RasterBuildRateLimited,
    RasterGeometryKey,
    RasterLayerSelector,
    _geometryPipeline,
    _buildFrameGeometry,
    frameGeometryCache,
)
from upenncontrast_annotation.server.models.annotation import Annotation

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
    yield
    frameGeometryCache.clear()


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

        class AnnotationModel:
            collection = object()

            def _aggregate(self, collection, pipeline):
                assert collection is self.collection
                assert pipeline[-1]["$project"]["coordinates"] == 1
                return iter([
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
                ])

        geometry = _buildFrameGeometry(
            AnnotationModel(),
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
        assert geometry.nbytes == 320
        assert geometry.candidates((-1, -1, 11, 11)).tolist() == [0]
        assert geometry.candidates((99, 99, 101, 101)).tolist() == [1]

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

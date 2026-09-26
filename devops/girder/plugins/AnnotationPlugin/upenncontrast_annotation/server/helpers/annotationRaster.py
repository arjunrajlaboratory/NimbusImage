"""Cached server-side raster rendering for annotation overview tiles."""

from array import array
from collections import deque, OrderedDict
from dataclasses import dataclass, field
from functools import lru_cache
import hashlib
import io
import json
import math
import re
import struct
import threading
import time
import uuid

import bson
import numpy as np
from PIL import Image, ImageDraw

from .aggregation import AGGREGATION_MAX_TIME_MS


RASTER_TILE_SIZE = 512
RASTER_CACHE_ENTRIES = 3
RASTER_CACHE_MAX_BYTES = 300 * 1024 * 1024
RASTER_CACHE_TTL_SECONDS = 120
RASTER_GRID_SIZE = 64
RASTER_MAX_CONCURRENT_BUILDS = 1
RASTER_ANONYMOUS_BUILD_LIMIT = 6
RASTER_ANONYMOUS_BUILD_WINDOW_SECONDS = 60

COLOR_PATTERN = re.compile(r"^#[0-9a-fA-F]{6}$")
SHAPE_CODES = {
    "point": 0,
    "line": 1,
    "polygon": 2,
    "rectangle": 3,
}


class RasterBuildBusy(Exception):
    """Raised when another geometry key is already building."""


class RasterBuildRateLimited(Exception):
    """Raised when an anonymous caller exceeds the cold-build budget."""


@dataclass(frozen=True)
class RasterLayerSelector:
    channel: int
    xy: int | None
    z: int | None
    time: int | None

    def canonicalQuery(self):
        query = {"channel": self.channel}
        if self.xy is not None:
            query["XY"] = self.xy
        if self.z is not None:
            query["Z"] = self.z
        if self.time is not None:
            query["Time"] = self.time
        return query


@dataclass(frozen=True)
class RasterGeometryKey:
    datasetId: object
    selectors: tuple[RasterLayerSelector, ...]
    mode: str


@dataclass(frozen=True)
class RasterTileParams:
    geometryKey: RasterGeometryKey
    sizeX: int
    sizeY: int
    tileSize: int
    maxLevel: int
    level: int
    x: int
    y: int
    fallbackColor: tuple[int, int, int, int]
    pointRadius: float
    lineWidth: int
    clientVersion: str
    # A registered filter (models/rasterFilter.py): only the objects passing
    # it are drawn. None draws every object of the frame.
    filterKey: str | None = None

    @property
    def scale(self):
        return 2 ** (self.level - self.maxLevel)

    def canonicalQuery(self):
        key = self.geometryKey
        return {
            "color": "#%02X%02X%02X" % self.fallbackColor[:3],
            "datasetId": str(key.datasetId),
            "lineWidth": self.lineWidth,
            "mode": key.mode,
            "pointRadius": self.pointRadius,
            "selectors": [
                selector.canonicalQuery() for selector in key.selectors
            ],
            "sizeX": self.sizeX,
            "sizeY": self.sizeY,
            "tileSize": self.tileSize,
            "maxLevel": self.maxLevel,
            "filter": self.filterKey,
            "v": self.clientVersion,
            "x": self.x,
            "y": self.y,
            "z": self.level,
        }


@dataclass
class FrameGeometry:
    vertices: np.ndarray
    offsets: np.ndarray
    bboxes: np.ndarray
    centroids: np.ndarray
    radii: np.ndarray
    colors: np.ndarray
    validColors: np.ndarray
    shapes: np.ndarray
    grid: tuple[np.ndarray, ...]
    unionBounds: tuple[float, float, float, float] | None
    # Annotation ids (12-byte ObjectId binaries, "S12") in geometry order,
    # for masking a frame to the objects passing the viewer's filters.
    ids: np.ndarray = field(
        default_factory=lambda: np.empty(0, dtype="S12")
    )
    # Filter masks over this geometry, keyed by passing key and kept here
    # (not in FilterMaskCache) so they die with the geometry when
    # FrameGeometryCache evicts it. Guarded by FilterMaskCache's lock.
    filterMasks: dict = field(
        default_factory=dict, compare=False, repr=False
    )

    @property
    def count(self):
        return len(self.shapes)

    @property
    def nbytes(self):
        arrays = (
            self.vertices,
            self.offsets,
            self.bboxes,
            self.centroids,
            self.radii,
            self.colors,
            self.validColors,
            self.shapes,
            self.ids,
            *self.grid,
        )
        allocationBytes = 0
        allocations = set()
        for data in arrays:
            if data.nbytes == 0:
                continue
            allocation = data
            while isinstance(allocation.base, np.ndarray):
                allocation = allocation.base
            allocationId = id(allocation)
            if allocationId not in allocations:
                allocations.add(allocationId)
                allocationBytes += allocation.nbytes
        return allocationBytes

    def coordinates(self, index):
        start = int(self.offsets[index]) * 2
        stop = int(self.offsets[index + 1]) * 2
        return self.vertices[start:stop].reshape((-1, 2))

    def candidates(self, bounds):
        if self.count == 0 or self.unionBounds is None:
            return np.empty(0, dtype=np.int64)

        left, top, right, bottom = bounds
        unionLeft, unionTop, unionRight, unionBottom = self.unionBounds
        if (
            right < unionLeft
            or bottom < unionTop
            or left > unionRight
            or top > unionBottom
        ):
            return np.empty(0, dtype=np.int64)
        if (
            left <= unionLeft
            and top <= unionTop
            and right >= unionRight
            and bottom >= unionBottom
        ):
            return np.arange(self.count, dtype=np.int64)

        width = max(unionRight - unionLeft, 1.0)
        height = max(unionBottom - unionTop, 1.0)

        def cell(value, origin, extent):
            return max(
                0,
                min(
                    RASTER_GRID_SIZE - 1,
                    int((value - origin) / extent * RASTER_GRID_SIZE),
                ),
            )

        minX = cell(left, unionLeft, width)
        maxX = cell(right, unionLeft, width)
        minY = cell(top, unionTop, height)
        maxY = cell(bottom, unionTop, height)
        cells = [
            self.grid[y * RASTER_GRID_SIZE + x]
            for y in range(minY, maxY + 1)
            for x in range(minX, maxX + 1)
            if self.grid[y * RASTER_GRID_SIZE + x].size
        ]
        if not cells:
            return np.empty(0, dtype=np.int64)
        indices = np.unique(np.concatenate(cells))
        boxes = self.bboxes[indices]
        intersects = (
            (boxes[:, 2] >= left)
            & (boxes[:, 0] <= right)
            & (boxes[:, 3] >= top)
            & (boxes[:, 1] <= bottom)
        )
        return indices[intersects]


@dataclass
class _CacheEntry:
    geometry: FrameGeometry
    version: tuple[str, int, int, int]
    created: float
    sizeBytes: int


class _AnonymousBuildRateLimiter:
    def __init__(self, limit, windowSeconds, timeFn):
        self._limit = limit
        self._windowSeconds = windowSeconds
        self._timeFn = timeFn
        self._attempts = {}

    def check(self, identity):
        if self._limit <= 0:
            raise RasterBuildRateLimited()
        now = self._timeFn()
        attempts = self._attempts.setdefault(identity, deque())
        cutoff = now - self._windowSeconds
        while attempts and attempts[0] <= cutoff:
            attempts.popleft()
        if len(attempts) >= self._limit:
            raise RasterBuildRateLimited()
        attempts.append(now)

    def clear(self):
        self._attempts.clear()


_PROCESS_UUID = str(uuid.uuid4())
_VERSION_LOCK = threading.RLock()
_DATASET_COUNTERS = {}
_GLOBAL_EPOCH = 0


def getRasterVersion(datasetId):
    with _VERSION_LOCK:
        return (
            _PROCESS_UUID,
            _GLOBAL_EPOCH,
            _DATASET_COUNTERS.get(str(datasetId), 0),
            # A request handled by another Girder process cannot observe this
            # process's mutation counters. Rotate both ETags and geometry
            # versions on the cache TTL boundary so that case is still bounded
            # to the documented 120-second staleness window.
            int(time.time() // RASTER_CACHE_TTL_SECONDS),
        )


def bumpDatasetRasterVersion(datasetId):
    if datasetId is None:
        return
    key = str(datasetId)
    with _VERSION_LOCK:
        _DATASET_COUNTERS[key] = _DATASET_COUNTERS.get(key, 0) + 1


def bumpGlobalRasterVersion():
    global _GLOBAL_EPOCH
    with _VERSION_LOCK:
        _GLOBAL_EPOCH += 1


def buildRasterEtag(version, params):
    query = json.dumps(
        params.canonicalQuery(), sort_keys=True, separators=(",", ":")
    ).encode()
    digest = hashlib.sha1(query).hexdigest()
    return 'W/"%s:%s"' % (":".join(str(value) for value in version), digest)


def parseHexColor(value):
    if not isinstance(value, str) or not COLOR_PATTERN.fullmatch(value):
        return None
    return (
        int(value[1:3], 16),
        int(value[3:5], 16),
        int(value[5:7], 16),
        255,
    )


def _geometryMatch(key):
    selectors = []
    for selector in key.selectors:
        selectorMatch = {"channel": selector.channel}
        if selector.xy is not None:
            selectorMatch["location.XY"] = selector.xy
        if selector.z is not None:
            selectorMatch["location.Z"] = selector.z
        if selector.time is not None:
            selectorMatch["location.Time"] = selector.time
        selectors.append(selectorMatch)
    return {"datasetId": key.datasetId, "$or": selectors}


def _geometryPipeline(key):
    pipeline = [{"$match": _geometryMatch(key)}, {"$sort": {"_id": 1}}]
    if key.mode == "discs":
        # Compute the same centroid and half-max-bbox radius as /stubs while
        # dropping coordinates before Mongo sends the result to the process.
        pipeline.extend([
            {"$addFields": {
                "centroid": {
                    "x": {"$avg": "$coordinates.x"},
                    "y": {"$avg": "$coordinates.y"},
                },
                "estimatedRadius": {
                    "$divide": [
                        {"$max": [
                            {"$subtract": [
                                {"$max": "$coordinates.x"},
                                {"$min": "$coordinates.x"},
                            ]},
                            {"$subtract": [
                                {"$max": "$coordinates.y"},
                                {"$min": "$coordinates.y"},
                            ]},
                        ]},
                        2,
                    ]
                },
            }},
            {"$project": {
                "centroid": 1,
                "color": 1,
                "estimatedRadius": 1,
            }},
        ])
    else:
        pipeline.append({"$project": {
            "color": 1,
            "coordinates": 1,
            "shape": 1,
        }})
    return pipeline


def _buildGrid(bboxes):
    count = len(bboxes)
    if count == 0:
        return (
            tuple(
                np.empty(0, dtype=np.uint32)
                for _ in range(RASTER_GRID_SIZE ** 2)
            ),
            None,
        )
    union = (
        float(np.min(bboxes[:, 0])),
        float(np.min(bboxes[:, 1])),
        float(np.max(bboxes[:, 2])),
        float(np.max(bboxes[:, 3])),
    )
    width = max(union[2] - union[0], 1.0)
    height = max(union[3] - union[1], 1.0)
    minXs = np.clip(
        ((bboxes[:, 0] - union[0]) / width * RASTER_GRID_SIZE).astype(
            np.int64
        ),
        0,
        RASTER_GRID_SIZE - 1,
    )
    maxXs = np.clip(
        ((bboxes[:, 2] - union[0]) / width * RASTER_GRID_SIZE).astype(
            np.int64
        ),
        0,
        RASTER_GRID_SIZE - 1,
    )
    minYs = np.clip(
        ((bboxes[:, 1] - union[1]) / height * RASTER_GRID_SIZE).astype(
            np.int64
        ),
        0,
        RASTER_GRID_SIZE - 1,
    )
    maxYs = np.clip(
        ((bboxes[:, 3] - union[1]) / height * RASTER_GRID_SIZE).astype(
            np.int64
        ),
        0,
        RASTER_GRID_SIZE - 1,
    )

    # Most annotations fit in one grid cell. Group those indices with a
    # vectorized stable sort, then retain the small Python loop only for
    # annotations that cross a cell boundary.
    singleCell = (minXs == maxXs) & (minYs == maxYs)
    singleIndices = np.flatnonzero(singleCell).astype(np.uint32)
    singleCellIds = (
        minYs[singleCell] * RASTER_GRID_SIZE + minXs[singleCell]
    )
    order = np.argsort(singleCellIds, kind="stable")
    orderedCellIds = singleCellIds[order]
    orderedIndices = singleIndices[order]
    boundaries = np.searchsorted(
        orderedCellIds,
        np.arange(RASTER_GRID_SIZE ** 2 + 1),
    )
    cells = [
        orderedIndices[boundaries[cellId]:boundaries[cellId + 1]]
        for cellId in range(RASTER_GRID_SIZE ** 2)
    ]

    crossingCells = [array("I") for _ in range(RASTER_GRID_SIZE ** 2)]
    for index in np.flatnonzero(~singleCell):
        for y in range(minYs[index], maxYs[index] + 1):
            for x in range(minXs[index], maxXs[index] + 1):
                crossingCells[y * RASTER_GRID_SIZE + x].append(index)
    for cellId, crossing in enumerate(crossingCells):
        if crossing:
            cells[cellId] = np.concatenate((
                cells[cellId],
                np.frombuffer(crossing, dtype=np.uint32),
            ))
    return tuple(cells), union


def _geometryFromDocuments(documents, key):
    """Build geometry from decoded documents: the discs path, and the
    reference the raw shapes path must reproduce exactly."""
    vertices = array("f")
    offsets = array("I", [0])
    bboxes = array("f")
    centroids = array("f")
    radii = array("f")
    colors = array("B")
    validColors = array("B")
    shapes = array("B")

    ids = bytearray()
    for document in documents:
        parsedColor = parseHexColor(document.get("color"))
        colors.extend(parsedColor or (0, 0, 0, 255))
        validColors.append(parsedColor is not None)

        if key.mode == "discs":
            centroid = document.get("centroid") or {"x": 0, "y": 0}
            centerX = float(centroid.get("x") or 0)
            centerY = float(centroid.get("y") or 0)
            radius = float(document.get("estimatedRadius") or 0)
            offsets.append(offsets[-1])
            bboxes.extend((
                centerX - radius,
                centerY - radius,
                centerX + radius,
                centerY + radius,
            ))
            centroids.extend((centerX, centerY))
            radii.append(radius)
            shapes.append(SHAPE_CODES["point"])
            ids += _idBinary(document.get("_id"))
            continue

        coordinates = document.get("coordinates") or []
        if not coordinates:
            colors[-4:] = array("B")
            validColors.pop()
            continue
        flatCoordinates, bbox, centroid, radius = _decodedShape(coordinates)
        vertices.fromlist(flatCoordinates)
        offsets.append(offsets[-1] + len(flatCoordinates) // 2)
        bboxes.extend(bbox)
        centroids.extend(centroid)
        radii.append(radius)
        shapes.append(SHAPE_CODES.get(document.get("shape"), 2))
        ids += _idBinary(document.get("_id"))

    shapeArray = np.frombuffer(shapes, dtype=np.uint8)
    bboxArray = np.frombuffer(bboxes, dtype=np.float32).reshape((-1, 4))
    grid, union = _buildGrid(bboxArray)
    return FrameGeometry(
        vertices=np.frombuffer(vertices, dtype=np.float32),
        offsets=np.frombuffer(offsets, dtype=np.uint32),
        bboxes=bboxArray,
        centroids=np.frombuffer(centroids, dtype=np.float32).reshape((-1, 2)),
        radii=np.frombuffer(radii, dtype=np.float32),
        colors=np.frombuffer(colors, dtype=np.uint8).reshape((-1, 4)),
        validColors=np.frombuffer(validColors, dtype=np.uint8).astype(bool),
        shapes=shapeArray,
        grid=grid,
        unionBounds=union,
        ids=np.frombuffer(bytes(ids), dtype="S12"),
    )


def _idBinary(annotationId):
    """The 12 bytes of an ObjectId (zeros for a document without one, as
    test fixtures may be)."""
    binary = getattr(annotationId, "binary", None)
    return binary if binary is not None else bytes(12)


# The shapes build reads every vertex of every annotation in the frame, and
# for a 700K-cell dataset pymongo turning 18M points into dicts dominated it.
# Conforming coordinates -- an array of {x: double, y: double} documents, which
# is what the app writes -- have a byte layout fixed by their point count, so
# they are read straight out of the raw BSON with numpy. Anything else (int or
# NaN coordinates, a z value, another key order) is decoded by pymongo and goes
# through _decodedShape, the same arithmetic _geometryFromDocuments uses.
RAW_POINT_CHUNK_ROWS = 4096
_INT32 = struct.Struct("<i")


@lru_cache(maxsize=65536)
def _pointArrayCount(length):
    """Point count whose conforming array is ``length`` bytes, else None.

    Element ``i`` is 29 bytes plus the digits of ``i``; the array adds five.
    """
    remaining = length - 5
    count = 0
    digits = 1
    keys = 10
    while remaining > 0:
        elements = min(remaining // (29 + digits), keys)
        count += elements
        remaining -= elements * (29 + digits)
        if elements < keys:
            break
        digits += 1
        keys = 9 * 10 ** (digits - 1)
    return count if remaining == 0 else None


@lru_cache(maxsize=1024)
def _pointArrayLayout(count):
    """Byte offsets of the structure and of the x and y values in a
    conforming ``count``-point array, and the structure bytes expected."""
    template = bytearray()
    xStarts = []
    yStarts = []
    for index in range(count):
        template += b"\x03" + str(index).encode() + b"\x00"
        template += b"\x1b\x00\x00\x00\x01x\x00"
        xStarts.append(4 + len(template))
        template += bytes(8) + b"\x01y\x00"
        yStarts.append(4 + len(template))
        template += bytes(8) + b"\x00"
    template = (
        (len(template) + 5).to_bytes(4, "little") + template + b"\x00"
    )
    valueBytes = np.arange(8)
    xIndex = np.array(xStarts, dtype=np.intp)[:, None] + valueBytes
    yIndex = np.array(yStarts, dtype=np.intp)[:, None] + valueBytes
    structure = np.ones(len(template), dtype=bool)
    structure[xIndex.ravel()] = False
    structure[yIndex.ravel()] = False
    structureIndex = np.flatnonzero(structure)
    templateBytes = np.frombuffer(bytes(template), dtype=np.uint8)
    return (
        structureIndex,
        templateBytes[structureIndex],
        xIndex.ravel(),
        yIndex.ravel(),
    )


def _rawGeometryFields(buffer, start, end):
    """``(shape, color, coordinates)`` of the raw document at
    ``buffer[start:end]``, the coordinates as the array's ``(start, end)``.
    None when a field is not a plain string, null or array, so the caller
    decodes the document instead."""
    # Fast path: _id, shape, coordinates, color in the order the app stores
    # them. startswith at an offset compares without slicing.
    position = start + 21
    if (
        buffer.startswith(b"\x07_id\x00", start + 4)
        and buffer.startswith(b"\x02shape\x00", position)
    ):
        size = _INT32.unpack_from(buffer, position + 7)[0]
        shape = buffer[position + 11:position + 10 + size].decode()
        position += 11 + size
        if buffer.startswith(b"\x04coordinates\x00", position):
            coordinatesStart = position + 13
            position = coordinatesStart + _INT32.unpack_from(
                buffer, coordinatesStart
            )[0]
            if buffer.startswith(b"\x02color\x00", position):
                size = _INT32.unpack_from(buffer, position + 7)[0]
                if position + 12 + size == end:
                    color = buffer[position + 11:position + 10 + size]
                    return (
                        shape,
                        color.decode(),
                        (coordinatesStart, position),
                    )
    return _walkRawGeometryFields(buffer, start, end)


def _walkRawGeometryFields(buffer, start, end):
    shape = color = coordinates = None
    position = start + 4
    end -= 1
    while position < end:
        elementType = buffer[position]
        keyEnd = buffer.index(0, position + 1)
        key = buffer[position + 1:keyEnd]
        position = keyEnd + 1
        if elementType == 0x07 and key == b"_id":
            position += 12
        elif elementType == 0x02 and (key == b"shape" or key == b"color"):
            size = _INT32.unpack_from(buffer, position)[0]
            value = buffer[position + 4:position + 3 + size].decode()
            if key == b"shape":
                shape = value
            else:
                color = value
            position += 4 + size
        elif elementType == 0x04 and key == b"coordinates":
            size = _INT32.unpack_from(buffer, position)[0]
            coordinates = (position, position + size)
            position += size
        elif elementType == 0x0A and key in (
            b"shape", b"color", b"coordinates"
        ):
            if key == b"coordinates":
                coordinates = None
            elif key == b"shape":
                shape = None
            else:
                color = None
        else:
            return None
    return shape, color, coordinates


def _decodedShape(coordinates):
    """Flat vertices, bbox, centroid and radius of decoded coordinates."""
    flatCoordinates = [
        value
        for point in coordinates
        for value in (point["x"], point["y"])
    ]
    xs = flatCoordinates[::2]
    ys = flatCoordinates[1::2]
    minX, maxX = min(xs), max(xs)
    minY, maxY = min(ys), max(ys)
    return (
        flatCoordinates,
        (minX, minY, maxX, maxY),
        (sum(xs) / len(xs), sum(ys) / len(ys)),
        max(maxX - minX, maxY - minY) / 2,
    )


class _RawShapeAccumulator:
    """Collects shapes in cursor order: conforming point arrays batched per
    point count and parsed with numpy, the rest through _decodedShape."""

    def __init__(self):
        self.count = 0
        self.ids = bytearray()
        self.shapes = array("B")
        # Colors repeat (one per cell type), so parse each value once.
        self.colorIndices = array("I")
        self.colorValues = {}
        # Per point count: pending shape indices and their array bytes.
        self._pendingIndices = {}
        self._pendingArrays = {}
        # (shape indices, xs, ys, bboxes, centroids, radii) per chunk.
        self._chunks = []
        # (shape index, flat vertices, bbox, centroid, radius).
        self._decoded = []

    def add(self, shape, color, coordinates, annotationId):
        """Add a shape whose coordinates are array bytes or decoded;
        ``annotationId`` is the ObjectId's 12 bytes."""
        self.ids += annotationId
        self.shapes.append(SHAPE_CODES.get(shape, 2))
        if not isinstance(color, str):
            color = None
        colorIndex = self.colorValues.get(color)
        if colorIndex is None:
            colorIndex = self.colorValues[color] = len(self.colorValues)
        self.colorIndices.append(colorIndex)
        index = self.count
        self.count += 1
        if isinstance(coordinates, bytes):
            count = _pointArrayCount(len(coordinates))
            if count is not None:
                indices = self._pendingIndices.get(count)
                if indices is None:
                    indices = self._pendingIndices[count] = array("I")
                    self._pendingArrays[count] = []
                indices.append(index)
                arrays = self._pendingArrays[count]
                arrays.append(coordinates)
                if len(arrays) >= RAW_POINT_CHUNK_ROWS:
                    self._flush(count)
                return
            coordinates = list(bson.decode(coordinates).values())
        self._decoded.append((index, *_decodedShape(coordinates)))

    def _flush(self, count):
        indices = np.frombuffer(
            self._pendingIndices.pop(count), dtype=np.uint32
        )
        arrays = self._pendingArrays.pop(count)
        data = np.frombuffer(b"".join(arrays), dtype=np.uint8).reshape(
            (len(arrays), -1)
        )
        structureIndex, structureBytes, xIndex, yIndex = (
            _pointArrayLayout(count)
        )
        xs = np.ascontiguousarray(data[:, xIndex]).view("<f8")
        ys = np.ascontiguousarray(data[:, yIndex]).view("<f8")
        conforming = (
            (data[:, structureIndex] == structureBytes).all(axis=1)
            & ~np.isnan(xs).any(axis=1)
            & ~np.isnan(ys).any(axis=1)
        )
        if not conforming.all():
            for row in np.flatnonzero(~conforming):
                coordinates = list(bson.decode(arrays[row]).values())
                self._decoded.append(
                    (int(indices[row]), *_decodedShape(coordinates))
                )
            indices = indices[conforming]
            xs = xs[conforming]
            ys = ys[conforming]
            if not len(indices):
                return
        minX, maxX = xs.min(axis=1), xs.max(axis=1)
        minY, maxY = ys.min(axis=1), ys.max(axis=1)
        # Summed left to right like the decoded path's sum(), so centroids
        # match it to the bit rather than to numpy's pairwise summation.
        sumX = xs[:, 0].copy()
        sumY = ys[:, 0].copy()
        for column in range(1, count):
            sumX += xs[:, column]
            sumY += ys[:, column]
        self._chunks.append((
            indices,
            xs.astype(np.float32),
            ys.astype(np.float32),
            np.stack((minX, minY, maxX, maxY), axis=1),
            np.stack((sumX / count, sumY / count), axis=1),
            np.maximum(maxX - minX, maxY - minY) / 2,
        ))

    def geometry(self):
        for count in list(self._pendingArrays):
            self._flush(count)
        pointCounts = np.zeros(self.count, dtype=np.uint32)
        bboxes = np.empty((self.count, 4), dtype=np.float32)
        centroids = np.empty((self.count, 2), dtype=np.float32)
        radii = np.empty(self.count, dtype=np.float32)
        for indices, xs, _, chunkBboxes, chunkCentroids, chunkRadii in (
            self._chunks
        ):
            pointCounts[indices] = xs.shape[1]
            bboxes[indices] = chunkBboxes
            centroids[indices] = chunkCentroids
            radii[indices] = chunkRadii
        for index, flatCoordinates, bbox, centroid, radius in self._decoded:
            pointCounts[index] = len(flatCoordinates) // 2
            bboxes[index] = bbox
            centroids[index] = centroid
            radii[index] = radius
        offsets = np.zeros(self.count + 1, dtype=np.uint32)
        np.cumsum(pointCounts, out=offsets[1:])
        vertices = np.empty(int(offsets[-1]) * 2, dtype=np.float32)
        for indices, xs, ys, *_ in self._chunks:
            starts = (
                offsets[indices].astype(np.intp)[:, None]
                + np.arange(xs.shape[1])
            ) * 2
            vertices[starts] = xs
            vertices[starts + 1] = ys
        for index, flatCoordinates, *_ in self._decoded:
            start = int(offsets[index]) * 2
            vertices[start:start + len(flatCoordinates)] = flatCoordinates
        palette = np.zeros((max(len(self.colorValues), 1), 4), np.uint8)
        validPalette = np.zeros(len(palette), dtype=bool)
        for value, colorIndex in self.colorValues.items():
            parsedColor = parseHexColor(value)
            palette[colorIndex] = parsedColor or (0, 0, 0, 255)
            validPalette[colorIndex] = parsedColor is not None
        colorIndices = np.frombuffer(self.colorIndices, dtype=np.uint32)
        grid, union = _buildGrid(bboxes)
        return FrameGeometry(
            vertices=vertices,
            offsets=offsets,
            bboxes=bboxes,
            centroids=centroids,
            radii=radii,
            colors=palette[colorIndices],
            validColors=validPalette[colorIndices],
            shapes=np.frombuffer(self.shapes, dtype=np.uint8),
            grid=grid,
            unionBounds=union,
            ids=np.frombuffer(bytes(self.ids), dtype="S12"),
        )


def _rawId(buffer, start, end):
    """The ObjectId bytes of the raw document at ``buffer[start:end]``:
    straight from the bytes when ``_id`` comes first (always, for documents
    Mongo stores), otherwise by decoding it."""
    if buffer.startswith(b"\x07_id\x00", start + 4):
        return bytes(buffer[start + 9:start + 21])
    return _idBinary(bson.decode(buffer[start:end]).get("_id"))


def _geometryFromRawBatches(batches):
    """Shapes-mode geometry from raw BSON batches (concatenated documents,
    as ``find_raw_batches`` yields them); identical to
    ``_geometryFromDocuments`` on the same documents decoded."""
    accumulator = _RawShapeAccumulator()
    add = accumulator.add
    for batch in batches:
        position = 0
        batchEnd = len(batch)
        while position < batchEnd:
            documentEnd = position + _INT32.unpack_from(batch, position)[0]
            fields = _rawGeometryFields(batch, position, documentEnd)
            if fields is None:
                document = bson.decode(batch[position:documentEnd])
                coordinates = document.get("coordinates") or []
                if coordinates:
                    add(
                        document.get("shape"),
                        document.get("color"),
                        coordinates,
                        _idBinary(document.get("_id")),
                    )
            else:
                shape, color, coordinates = fields
                # Five bytes is the empty array, which the decoded path
                # skips like a missing one.
                if coordinates is not None and (
                    coordinates[1] - coordinates[0] > 5
                ):
                    add(
                        shape, color, batch[coordinates[0]:coordinates[1]],
                        _rawId(batch, position, documentEnd),
                    )
            position = documentEnd
    return accumulator.geometry()


def _buildFrameGeometry(annotationModel, key):
    if key.mode == "discs":
        return _geometryFromDocuments(
            annotationModel._aggregate(
                annotationModel.collection, _geometryPipeline(key)
            ),
            key,
        )
    # A plain find, not the aggregate: $project costs Mongo more than it
    # saves. Raw batches skip pymongo's decoding, which Girder's Model.find
    # cannot, so this reads the collection directly, bounded like _aggregate.
    batches = annotationModel.collection.find_raw_batches(
        _geometryMatch(key),
        {"color": 1, "coordinates": 1, "shape": 1},
        sort=[("_id", 1)],
        hint=[("datasetId", 1), ("_id", 1)],
        max_time_ms=AGGREGATION_MAX_TIME_MS,
    )
    return _geometryFromRawBatches(batches)


class FrameGeometryCache:
    def __init__(
        self,
        maxBytes=RASTER_CACHE_MAX_BYTES,
        maxEntries=RASTER_CACHE_ENTRIES,
        maxConcurrentBuilds=RASTER_MAX_CONCURRENT_BUILDS,
        anonymousBuildLimit=RASTER_ANONYMOUS_BUILD_LIMIT,
        anonymousBuildWindowSeconds=(
            RASTER_ANONYMOUS_BUILD_WINDOW_SECONDS
        ),
        timeFn=time.monotonic,
    ):
        self._entries = OrderedDict()
        self._maxBytes = maxBytes
        self._maxEntries = maxEntries
        self._retainedBytes = 0
        self._locks = {}
        self._lock = threading.RLock()
        self._buildSlots = threading.BoundedSemaphore(maxConcurrentBuilds)
        self._anonymousBuildLimiter = _AnonymousBuildRateLimiter(
            anonymousBuildLimit,
            anonymousBuildWindowSeconds,
            timeFn,
        )
        self._timeFn = timeFn

    def _getFreshGeometryLocked(self, key, version, now):
        """Return a compatible cached geometry while ``self._lock`` is held."""
        entry = self._entries.get(key)
        if (
            entry is not None
            and entry.version[0] == version[0]
            and entry.version[1:] >= version[1:]
            and now - entry.created < RASTER_CACHE_TTL_SECONDS
        ):
            # Versions are monotonic within one process. A newer entry is safe
            # for an older queued request and must not be replaced by it.
            self._entries.move_to_end(key)
            return entry.geometry
        return None

    def get(
        self,
        annotationModel,
        key,
        version,
        anonymousIdentity=None,
    ):
        now = self._timeFn()
        with self._lock:
            geometry = self._getFreshGeometryLocked(key, version, now)
            if geometry is not None:
                return geometry
            keyLock = self._locks.setdefault(key, threading.Lock())

        with keyLock:
            now = self._timeFn()
            with self._lock:
                geometry = self._getFreshGeometryLocked(key, version, now)
                if geometry is not None:
                    return geometry
            buildSlotAcquired = self._buildSlots.acquire(blocking=False)
            if not buildSlotAcquired:
                with self._lock:
                    self._locks.pop(key, None)
                raise RasterBuildBusy()
            try:
                if anonymousIdentity is not None:
                    with self._lock:
                        self._anonymousBuildLimiter.check(
                            anonymousIdentity
                        )
                geometry = _buildFrameGeometry(annotationModel, key)
                with self._lock:
                    previous = self._entries.pop(key, None)
                    if previous is not None:
                        self._retainedBytes -= previous.sizeBytes
                    sizeBytes = int(getattr(geometry, "nbytes", 0))
                    if sizeBytes <= self._maxBytes:
                        self._entries[key] = _CacheEntry(
                            geometry,
                            version,
                            now,
                            sizeBytes,
                        )
                        self._retainedBytes += sizeBytes
                        while (
                            len(self._entries) > self._maxEntries
                            or self._retainedBytes > self._maxBytes
                        ):
                            _, removed = self._entries.popitem(last=False)
                            self._retainedBytes -= removed.sizeBytes
            finally:
                self._buildSlots.release()
                with self._lock:
                    self._locks.pop(key, None)
            return geometry

    def clear(self):
        with self._lock:
            self._entries.clear()
            self._retainedBytes = 0
            self._locks.clear()
            self._anonymousBuildLimiter.clear()


frameGeometryCache = FrameGeometryCache()


def getFrameGeometry(
    annotationModel,
    params,
    version,
    anonymousIdentity=None,
):
    return frameGeometryCache.get(
        annotationModel,
        params.geometryKey,
        version,
        anonymousIdentity=anonymousIdentity,
    )


# ---- filtered overview: which objects of a frame pass the viewer's filters

RASTER_FILTER_CACHE_ENTRIES = 8
# Masks kept per frame geometry (FrameGeometry.filterMasks); the oldest is
# dropped past this.
RASTER_FILTER_MASKS_PER_GEOMETRY = 4
RASTER_MAX_CONCURRENT_FILTER_BUILDS = 1
# A filter build is seconds of whole-dataset work, and a filter change
# arrives as two registrations in quick succession (a new gate is first
# unresolved, then resolved): tiles of the second wait this long for the
# first build rather than failing at once and exhausting the client's
# retries. Past it, 503 with Retry-After as for geometry builds. The same
# bound applies to waiting on another request building the same key.
RASTER_FILTER_BUILD_WAIT_SECONDS = 30


class FilterMaskCache:
    """Per-process cache of the objects passing a registered filter.

    Resolving a filter is a whole-dataset query (seconds at 700K objects),
    and a view asks for a dozen tiles at once: the passing ids are computed
    once per (dataset, raster version, filter, client version) under a
    per-key lock, and turned into a boolean mask per frame geometry (stored
    on the geometry, so an evicted geometry is not pinned here). The raster
    version's time bucket bounds how stale a passing set can be when another
    process wrote; the client version carries the client's property-value
    revision, which is what moves when a recomputed property changes a
    gate's membership (the raster version only moves on annotation writes).
    Anonymous request rates are limited at the proxy, which sees the client
    address (Girder behind HAProxy sees only the proxy's): CytoPixel/
    AWSDeploy#120.
    """

    def __init__(
        self,
        maxEntries=RASTER_FILTER_CACHE_ENTRIES,
        maxConcurrentBuilds=RASTER_MAX_CONCURRENT_FILTER_BUILDS,
    ):
        self._passing = OrderedDict()
        self._maxEntries = maxEntries
        self._locks = {}
        self._lock = threading.RLock()
        self._buildSlots = threading.BoundedSemaphore(maxConcurrentBuilds)

    def mask(self, geometry, passingKey, computePassingIds):
        """Boolean mask over ``geometry`` of the objects passing; builds the
        passing set with ``computePassingIds()`` (-> id strings) on a miss.
        Raises RasterBuildBusy when another filter build is running (or the
        same key's build outlasts the wait)."""
        with self._lock:
            masks = geometry.filterMasks
            mask = masks.pop(passingKey, None)
            if mask is not None:
                masks[passingKey] = mask
                return mask
        passing = self._passingIds(passingKey, computePassingIds)
        mask = np.isin(geometry.ids, passing)
        with self._lock:
            masks = geometry.filterMasks
            masks.pop(passingKey, None)
            masks[passingKey] = mask
            while len(masks) > RASTER_FILTER_MASKS_PER_GEOMETRY:
                del masks[next(iter(masks))]
        return mask

    def _passingIds(self, passingKey, computePassingIds):
        with self._lock:
            passing = self._passing.get(passingKey)
            if passing is not None:
                self._passing.move_to_end(passingKey)
                return passing
            keyLock = self._locks.setdefault(passingKey, threading.Lock())
        if not keyLock.acquire(timeout=RASTER_FILTER_BUILD_WAIT_SECONDS):
            raise RasterBuildBusy()
        # Settled once the key's lock needs no removal: the set was already
        # cached (its builder removed the lock) or was stored with the lock
        # removed in the same critical section, so no request can slip in
        # between and rebuild it.
        settled = False
        try:
            with self._lock:
                passing = self._passing.get(passingKey)
                if passing is not None:
                    settled = True
                    return passing
            if not self._buildSlots.acquire(
                timeout=RASTER_FILTER_BUILD_WAIT_SECONDS
            ):
                raise RasterBuildBusy()
            try:
                passing = np.array(
                    [bytes.fromhex(value) for value in computePassingIds()],
                    dtype="S12",
                )
            finally:
                self._buildSlots.release()
            with self._lock:
                self._passing[passingKey] = passing
                while len(self._passing) > self._maxEntries:
                    self._passing.popitem(last=False)
                self._dropKeyLockLocked(passingKey, keyLock)
                settled = True
            return passing
        finally:
            if not settled:
                with self._lock:
                    self._dropKeyLockLocked(passingKey, keyLock)
            keyLock.release()

    def _dropKeyLockLocked(self, passingKey, keyLock):
        """Forget ``keyLock`` (while ``self._lock`` is held) unless a newer
        request already replaced it."""
        if self._locks.get(passingKey) is keyLock:
            del self._locks[passingKey]

    def clear(self):
        with self._lock:
            self._passing.clear()
            self._locks.clear()


filterMaskCache = FilterMaskCache()


def _annotationColors(geometry, indices, fallback):
    result = geometry.colors[indices].copy()
    result[~geometry.validColors[indices]] = fallback
    return result


def _splat(arr, centroids, colors, params):
    x = np.floor(
        centroids[:, 0] * params.scale - params.x * params.tileSize
    ).astype(np.int64)
    y = np.floor(
        centroids[:, 1] * params.scale - params.y * params.tileSize
    ).astype(np.int64)
    inside = (
        (x >= 0)
        & (x < params.tileSize)
        & (y >= 0)
        & (y < params.tileSize)
    )
    arr[y[inside], x[inside]] = colors[inside]


def renderRasterTile(geometry, params, mask=None):
    """PNG bytes of one tile. With ``mask`` (a boolean per geometry object,
    FilterMaskCache.mask) only the objects passing the filter are drawn."""
    arr = np.zeros((params.tileSize, params.tileSize, 4), dtype=np.uint8)
    scale = params.scale
    tileLeft = params.x * params.tileSize / scale
    tileTop = params.y * params.tileSize / scale
    tileRight = (params.x + 1) * params.tileSize / scale
    tileBottom = (params.y + 1) * params.tileSize / scale
    # Points and lines have tile-pixel widths, so their geometry bbox alone is
    # insufficient at seams. Pad the lookup in image pixels before culling.
    padding = max(params.pointRadius, params.lineWidth) / scale
    indices = geometry.candidates((
        tileLeft - padding,
        tileTop - padding,
        tileRight + padding,
        tileBottom + padding,
    ))
    if mask is not None and indices.size:
        indices = indices[mask[indices]]
    if indices.size == 0:
        image = Image.fromarray(arr, "RGBA")
    else:
        colors = _annotationColors(
            geometry, indices, params.fallbackColor
        )
        if params.geometryKey.mode == "discs":
            scaledRadii = geometry.radii[indices] * scale
            subpixel = scaledRadii * 2 < 1.5
            _splat(
                arr,
                geometry.centroids[indices[subpixel]],
                colors[subpixel],
                params,
            )
        else:
            widths = geometry.bboxes[indices, 2] - geometry.bboxes[indices, 0]
            heights = geometry.bboxes[indices, 3] - geometry.bboxes[indices, 1]
            # Point markers have a configured constant tile-pixel radius, so
            # they must not be swallowed by the bbox-based sub-pixel path.
            subpixel = (
                (np.maximum(widths, heights) * scale < 1.5)
                & (geometry.shapes[indices] != SHAPE_CODES["point"])
            )
            _splat(
                arr,
                geometry.centroids[indices[subpixel]],
                colors[subpixel],
                params,
            )

        image = Image.fromarray(arr, "RGBA")
        draw = ImageDraw.Draw(image)
        visibleIndices = indices[~subpixel]
        visibleColors = colors[~subpixel]
        for offset, index in enumerate(visibleIndices):
            color = tuple(int(value) for value in visibleColors[offset])
            center = geometry.centroids[index]
            centerX = center[0] * scale - params.x * params.tileSize
            centerY = center[1] * scale - params.y * params.tileSize
            if params.geometryKey.mode == "discs":
                radius = max(0.5, geometry.radii[index] * scale)
                draw.ellipse(
                    (centerX - radius, centerY - radius,
                     centerX + radius, centerY + radius),
                    fill=color,
                )
                continue

            shape = int(geometry.shapes[index])
            if shape == SHAPE_CODES["point"]:
                radius = params.pointRadius
                draw.ellipse(
                    (centerX - radius, centerY - radius,
                     centerX + radius, centerY + radius),
                    fill=color,
                )
                continue

            coordinates = geometry.coordinates(index)
            points = [
                (
                    point[0] * scale - params.x * params.tileSize,
                    point[1] * scale - params.y * params.tileSize,
                )
                for point in coordinates
            ]
            if shape == SHAPE_CODES["line"]:
                draw.line(points, fill=color, width=params.lineWidth)
            elif shape == SHAPE_CODES["rectangle"]:
                bbox = geometry.bboxes[index]
                draw.rectangle(
                    (
                        bbox[0] * scale - params.x * params.tileSize,
                        bbox[1] * scale - params.y * params.tileSize,
                        bbox[2] * scale - params.x * params.tileSize,
                        bbox[3] * scale - params.y * params.tileSize,
                    ),
                    fill=color,
                )
            else:
                draw.polygon(points, fill=color)

    validWidth = max(
        0,
        min(
            params.tileSize,
            math.ceil(params.sizeX * scale) - params.x * params.tileSize,
        ),
    )
    validHeight = max(
        0,
        min(
            params.tileSize,
            math.ceil(params.sizeY * scale) - params.y * params.tileSize,
        ),
    )
    if validWidth < params.tileSize:
        image.paste(
            (0, 0, 0, 0),
            (validWidth, 0, params.tileSize, params.tileSize),
        )
    if validHeight < params.tileSize:
        image.paste(
            (0, 0, 0, 0),
            (0, validHeight, params.tileSize, params.tileSize),
        )

    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()

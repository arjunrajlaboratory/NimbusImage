"""Cached server-side raster rendering for annotation overview tiles."""

from array import array
from collections import deque, OrderedDict
from dataclasses import dataclass
import hashlib
import io
import json
import math
import re
import threading
import time
import uuid

import numpy as np
from PIL import Image, ImageDraw


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


def _geometryPipeline(key):
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
    match = {"datasetId": key.datasetId, "$or": selectors}

    pipeline = [{"$match": match}, {"$sort": {"_id": 1}}]
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


def _buildFrameGeometry(annotationModel, key):
    vertices = array("f")
    offsets = array("I", [0])
    bboxes = array("f")
    centroids = array("f")
    radii = array("f")
    colors = array("B")
    validColors = array("B")
    shapes = array("B")

    cursor = annotationModel._aggregate(
        annotationModel.collection, _geometryPipeline(key)
    )
    for document in cursor:
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
            continue

        coordinates = document.get("coordinates") or []
        if not coordinates:
            colors[-4:] = array("B")
            validColors.pop()
            continue
        flatCoordinates = [
            value
            for point in coordinates
            for value in (point["x"], point["y"])
        ]
        vertices.fromlist(flatCoordinates)
        offsets.append(offsets[-1] + len(coordinates))
        xs = flatCoordinates[::2]
        ys = flatCoordinates[1::2]
        minX, maxX = min(xs), max(xs)
        minY, maxY = min(ys), max(ys)
        bboxes.extend((minX, minY, maxX, maxY))
        centroids.extend((sum(xs) / len(xs), sum(ys) / len(ys)))
        radii.append(max(maxX - minX, maxY - minY) / 2)
        shapes.append(SHAPE_CODES.get(document.get("shape"), 2))

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
    )


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

    def get(
        self,
        annotationModel,
        key,
        version,
        anonymousIdentity=None,
    ):
        now = self._timeFn()
        with self._lock:
            entry = self._entries.get(key)
            if (
                entry is not None
                and entry.version == version
                and now - entry.created < RASTER_CACHE_TTL_SECONDS
            ):
                self._entries.move_to_end(key)
                return entry.geometry
            keyLock = self._locks.setdefault(key, threading.Lock())

        with keyLock:
            now = self._timeFn()
            with self._lock:
                entry = self._entries.get(key)
                if (
                    entry is not None
                    and entry.version == version
                    and now - entry.created < RASTER_CACHE_TTL_SECONDS
                ):
                    self._entries.move_to_end(key)
                    return entry.geometry
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


def renderRasterTile(geometry, params):
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

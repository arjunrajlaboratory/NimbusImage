"""Saved scalar maps: validation, loading and tile rendering
(codebaseDocumentation/HOTSPOT_REGIONS_WORKER.md §5.8 and §8.2).

A scalar map is an item in a dataset folder whose metadata key
`nimbusScalarMap` describes it and whose single file is an `.npz`
(`numpy.savez_compressed`) holding one 2-D float array per location key
(`xy{XY}_z{Z}_t{Time}`). Geometry: `array[row, col]` covers image pixels
`x in [originPx[0] + col * gridSpacingPx, originPx[0] + (col + 1) *
gridSpacingPx)` and the same in y with `row` and `originPx[1]`. NaN marks
cells outside the map's support.

Everything here is pure numpy and raises ValueError; the API layer
(`server/api/scalarMap.py`) maps that to HTTP errors.
"""

import functools
import io
import math
import threading
import zipfile
import zlib
from collections import OrderedDict

import fastjsonschema
import numpy as np
from girder.models.file import File
from girder.models.setting import Setting
from girder.settings import SettingKey
from PIL import Image

from .colormaps import CONTINUOUS_COLORMAPS

SCALAR_MAP_META_KEY = "nimbusScalarMap"
SCALAR_MAP_VERSION = 1
SCALAR_MAP_COLORMAPS = ("viridis", "magma", "inferno", "gray")
PERCENTILE_COUNT = 101
# Cells (rows * cols) per location array. The worker writes at most ~4096^2;
# 32M cells (8192 x 4096) is 128 MiB as float32 and leaves headroom without
# letting one map item pin the cache.
MAX_SCALAR_MAP_CELLS = 32 * 1024 * 1024
# The compressed .npz is read whole into memory before the requested array is
# decompressed, so its size is bounded too.
MAX_SCALAR_MAP_FILE_BYTES = 512 * 1024 * 1024
# Girder's FileHandle refuses a single read above core.filehandle_max_size
# (16 MiB by default), so the file is read in chunks no larger than this
# and no larger than that setting.
FILE_READ_CHUNK_BYTES = 8 * 1024 * 1024
# Process-wide budget for decoded arrays across every map and location.
MAX_SCALAR_MAP_CACHE_BYTES = 512 * 1024 * 1024
# Alpha of pixels on the unselected side of a threshold: visible enough to
# keep context, faint enough that would-be regions stand out.
THRESHOLD_DIM_ALPHA = 64
COLORMAP_LUT_SIZE = 256

_NUMBER_PAIR = {
    "type": "array", "items": {"type": "number"},
    "minItems": 2, "maxItems": 2,
}
# Structure only. What a schema cannot say (finite numbers, ordering, the
# cell cap, unique location keys) is checked in validateScalarMapMeta.
# Descriptive fields (name, property, statistic, ...) are not constrained.
SCALAR_MAP_META_SCHEMA = {
    "$schema": "http://json-schema.org/draft-04/schema#",
    "type": "object",
    "properties": {
        "version": {"type": "integer", "enum": [SCALAR_MAP_VERSION]},
        "gridSpacingPx": {
            "type": "number", "minimum": 0, "exclusiveMinimum": True,
        },
        "originPx": _NUMBER_PAIR,
        "shape": {
            "type": "array", "items": {"type": "integer", "minimum": 1},
            "minItems": 2, "maxItems": 2,
        },
        "locations": {
            "type": "array",
            "minItems": 1,
            "items": {
                "type": "object",
                "properties": {
                    "XY": {"type": "integer", "minimum": 0},
                    "Z": {"type": "integer", "minimum": 0},
                    "Time": {"type": "integer", "minimum": 0},
                    "key": {
                        "type": "string", "pattern": r"^xy\d+_z\d+_t\d+$",
                    },
                },
                "required": ["XY", "Z", "Time", "key"],
            },
        },
        "valueRange": _NUMBER_PAIR,
        "percentiles": {
            "type": "array", "items": {"type": "number"},
            "minItems": PERCENTILE_COUNT, "maxItems": PERCENTILE_COUNT,
        },
    },
    "required": [
        "version", "gridSpacingPx", "originPx", "shape", "locations",
        "valueRange", "percentiles",
    ],
}
_validateMetaSchema = fastjsonschema.compile(SCALAR_MAP_META_SCHEMA)


def _allFinite(values):
    return all(math.isfinite(value) for value in values)


def _nonDecreasing(values):
    return all(a <= b for a, b in zip(values, values[1:]))


def validateScalarMapMeta(meta):
    """Raise ValueError unless `meta` is a usable version-1 map description:
    the schema above, plus finite numbers, min <= max, non-decreasing
    percentiles, unique location keys and the cell cap."""
    try:
        _validateMetaSchema(meta)
    except fastjsonschema.JsonSchemaValueException as exc:
        raise ValueError(str(exc))
    if not _allFinite(
        [meta["gridSpacingPx"]] + meta["originPx"] + meta["valueRange"]
        + meta["percentiles"]
    ):
        raise ValueError("scalar map numbers must be finite")
    if not _nonDecreasing(meta["valueRange"]):
        raise ValueError("valueRange must be [min, max] with min <= max")
    if not _nonDecreasing(meta["percentiles"]):
        raise ValueError("percentiles must be non-decreasing")
    keys = [location["key"] for location in meta["locations"]]
    if len(set(keys)) != len(keys):
        raise ValueError("location keys must be unique")
    rows, cols = meta["shape"]
    if rows * cols > MAX_SCALAR_MAP_CELLS:
        raise ValueError(
            "scalar map is larger than %d cells" % MAX_SCALAR_MAP_CELLS
        )


def isScalarMapMeta(meta):
    try:
        validateScalarMapMeta(meta)
    except ValueError:
        return False
    return True


def scalarMapMeta(item):
    """The item's validated `nimbusScalarMap`, or ValueError."""
    meta = (item.get("meta") or {}).get(SCALAR_MAP_META_KEY)
    if meta is None:
        raise ValueError("The item is not a scalar map.")
    try:
        validateScalarMapMeta(meta)
    except ValueError as exc:
        raise ValueError("The item is not a valid scalar map: %s" % exc)
    return meta


def scalarMapRevision(fileDoc):
    """A string that changes whenever the map's file changes: a re-upload
    gets a new file id, contents replaced in place change size (and
    checksum, when Girder has one). Used by the list route, the tile ETag
    and the array cache key."""
    revision = "%s-%s" % (fileDoc["_id"], fileDoc.get("size"))
    if fileDoc.get("sha512"):
        revision += "-" + fileDoc["sha512"][:16]
    return revision


def locationKeys(meta):
    return {location["key"] for location in meta["locations"]}


def defaultDisplayRange(meta):
    """`valueRange`, widened around a constant map so min < max."""
    low, high = (float(v) for v in meta["valueRange"])
    if low == high:
        return low - 0.5, high + 0.5
    return low, high


# ---- colormaps -------------------------------------------------------------

@functools.lru_cache(maxsize=None)
def colormapLut(name):
    """(256, 3) uint8 lookup table: the colormap's anchor table
    (`colormaps.py`, shared with color-by-property and its legend)
    interpolated piecewise-linearly to 256 entries."""
    if name not in SCALAR_MAP_COLORMAPS:
        raise ValueError(
            "colormap must be one of %s" % ", ".join(SCALAR_MAP_COLORMAPS)
        )
    anchors = np.array([
        [int(color[i:i + 2], 16) for i in (1, 3, 5)]
        for color in CONTINUOUS_COLORMAPS[name]
    ], dtype=np.float64)
    positions = np.linspace(0, 1, len(anchors))
    samples = np.linspace(0, 1, COLORMAP_LUT_SIZE)
    lut = np.stack([
        np.interp(samples, positions, anchors[:, channel])
        for channel in range(3)
    ], axis=-1)
    lut = np.round(lut).astype(np.uint8)
    lut.setflags(write=False)
    return lut


# ---- sampling ---------------------------------------------------------------

def tilePixelCenters(tileSize, maxLevel, level, x, y):
    """Image coordinates of the centers of a tile's output pixels, on the
    image's tile pyramid (scale = 2 ** (level - maxLevel); tile (x, y)
    covers image pixels [x, x + 1) * tileSize / scale). Same arithmetic as
    the annotation overview raster and the transcript density tiles."""
    scale = 2.0 ** (level - maxLevel)
    offsets = (np.arange(tileSize) + 0.5) / scale
    return x * tileSize / scale + offsets, y * tileSize / scale + offsets


def _axisSamples(coordinates, origin, spacing, count):
    """For each coordinate along one axis: the cell containing it, the two
    cell-center neighbors that bracket it, the weight of the upper one, and
    whether the coordinate is inside the array at all."""
    position = (np.asarray(coordinates, dtype=np.float64) - origin) / spacing
    inside = (position >= 0) & (position < count)
    containing = np.clip(np.floor(position), 0, count - 1).astype(np.int64)
    # Cell centers sit at half-integer positions; beyond the first or last
    # center the value is extended flat (clamping the fraction to 0 or 1).
    center = np.clip(position - 0.5, 0, count - 1)
    low = np.floor(center).astype(np.int64)
    high = np.minimum(low + 1, count - 1)
    fraction = center - low
    return containing, low, high, fraction, inside


def sampleScalarMap(array, originPx, gridSpacingPx, xs, ys):
    """Bilinear samples of `array` at the image points (ys x xs), as a
    (len(ys), len(xs)) float64 grid.

    NaN-aware: a point whose containing cell is NaN, or that lies outside the
    array, is NaN; otherwise NaN neighbors drop out of the bilinear weights
    and the remaining weights are renormalized, so a NaN neighbor never
    poisons a valid point and the map's support keeps its cell edges."""
    rows, cols = array.shape
    cCell, c0, c1, fx, insideX = _axisSamples(
        xs, originPx[0], gridSpacingPx, cols
    )
    rCell, r0, r1, fy, insideY = _axisSamples(
        ys, originPx[1], gridSpacingPx, rows
    )
    fx = fx[np.newaxis, :]
    fy = fy[:, np.newaxis]
    total = np.zeros((len(ys), len(xs)), dtype=np.float64)
    weight = np.zeros_like(total)
    for rowIdx, colIdx, w in (
        (r0, c0, (1 - fy) * (1 - fx)),
        (r0, c1, (1 - fy) * fx),
        (r1, c0, fy * (1 - fx)),
        (r1, c1, fy * fx),
    ):
        values = array[np.ix_(rowIdx, colIdx)].astype(np.float64)
        valid = ~np.isnan(values)
        w = np.where(valid, w, 0.0)
        total += np.where(valid, values, 0.0) * w
        weight += w
    with np.errstate(invalid="ignore", divide="ignore"):
        result = total / weight
    result[weight <= 0] = np.nan
    result[np.isnan(array[np.ix_(rCell, cCell)])] = np.nan
    result[~insideY, :] = np.nan
    result[:, ~insideX] = np.nan
    return result


def colorizeScalarValues(values, colormap, vmin, vmax, threshold=None,
                         thresholdSide="above"):
    """(H, W, 4) uint8 RGBA: `colormap` over [vmin, vmax] (clamped), NaN
    fully transparent; with `threshold`, values on the unselected side are
    drawn at THRESHOLD_DIM_ALPHA."""
    if not vmin < vmax:
        raise ValueError("min must be less than max")
    if thresholdSide not in ("above", "below"):
        raise ValueError("thresholdSide must be 'above' or 'below'")
    lut = colormapLut(colormap)
    valid = ~np.isnan(values)
    fraction = np.clip(
        (np.where(valid, values, vmin) - vmin) / (vmax - vmin), 0, 1
    )
    index = np.round(fraction * (COLORMAP_LUT_SIZE - 1)).astype(np.int64)
    rgba = np.zeros(values.shape + (4,), dtype=np.uint8)
    rgba[..., :3] = lut[index]
    alpha = np.full(values.shape, 255, dtype=np.uint8)
    if threshold is not None:
        filled = np.where(valid, values, threshold)
        selected = (
            filled >= threshold if thresholdSide == "above"
            else filled <= threshold
        )
        alpha[~selected] = THRESHOLD_DIM_ALPHA
    alpha[~valid] = 0
    rgba[..., 3] = alpha
    rgba[~valid, :3] = 0
    return rgba


def renderScalarMapTile(array, meta, sizeX, sizeY, tileSize, maxLevel,
                        level, x, y, colormap, vmin, vmax, threshold=None,
                        thresholdSide="above"):
    """PNG bytes of one tile of the map on the image's tile pyramid. Pixels
    outside the image are transparent, as are NaN and off-array pixels."""
    xs, ys = tilePixelCenters(tileSize, maxLevel, level, x, y)
    values = sampleScalarMap(
        array, meta["originPx"], float(meta["gridSpacingPx"]), xs, ys
    )
    values[:, xs >= sizeX] = np.nan
    values[ys >= sizeY, :] = np.nan
    rgba = colorizeScalarValues(
        values, colormap, vmin, vmax, threshold, thresholdSide
    )
    output = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(output, format="PNG")
    return output.getvalue()


# ---- loading ---------------------------------------------------------------

_ARCHIVE_ERRORS = (zipfile.BadZipFile, zlib.error, EOFError, OSError)


def _readNpyHeader(member):
    """(shape, fortranOrder, dtype) from an open .npy stream, leaving it at
    the start of the data."""
    try:
        version = np.lib.format.read_magic(member)
        if version == (1, 0):
            return np.lib.format.read_array_header_1_0(member)
        if version in ((2, 0), (3, 0)):
            return np.lib.format.read_array_header_2_0(member)
    except ValueError as exc:
        raise ValueError("The map array has an unreadable header: %s" % exc)
    raise ValueError("unsupported .npy version %s" % (version,))


def readScalarMapArray(data, locationKey, expectedShape):
    """Decode one location's array from the .npz bytes as float32.

    The bytes are opened strictly as a ZIP (a bare .npy is refused, not
    decoded), and the one explicit member `<locationKey>.npy` is both
    checked (2-D float, the metadata's shape, within the cell cap) and
    decoded, reading only as many bytes as its checked header allows."""
    memberName = locationKey + ".npy"
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            if memberName not in archive.namelist():
                raise ValueError(
                    "The map file has no array for location %s"
                    % locationKey
                )
            with archive.open(memberName) as member:
                shape, fortranOrder, dtype = _readNpyHeader(member)
                if dtype.kind != "f" or len(shape) != 2:
                    raise ValueError(
                        "The map array for %s is not a 2-D float array"
                        % locationKey
                    )
                if list(shape) != list(expectedShape):
                    raise ValueError(
                        "The map array for %s has shape %s, not the "
                        "metadata's %s"
                        % (locationKey, list(shape), list(expectedShape))
                    )
                if shape[0] * shape[1] > MAX_SCALAR_MAP_CELLS:
                    raise ValueError(
                        "scalar map is larger than %d cells"
                        % MAX_SCALAR_MAP_CELLS
                    )
                expectedBytes = shape[0] * shape[1] * dtype.itemsize
                raw = member.read(expectedBytes)
    except _ARCHIVE_ERRORS as exc:
        raise ValueError("The map file is not a readable .npz: %s" % exc)
    if len(raw) != expectedBytes:
        raise ValueError("The map array for %s is truncated" % locationKey)
    flat = np.frombuffer(raw, dtype=dtype)
    array = (
        flat.reshape(shape[::-1]).T if fortranOrder else flat.reshape(shape)
    )
    array = np.array(array, dtype=np.float32, order="C")
    array.setflags(write=False)
    return array


def _readFileBytes(fileDoc):
    """The whole file, in reads Girder's FileHandle accepts."""
    if (fileDoc.get("size") or 0) > MAX_SCALAR_MAP_FILE_BYTES:
        raise ValueError(
            "The map file is larger than %d bytes" % MAX_SCALAR_MAP_FILE_BYTES
        )
    chunkSize = min(
        FILE_READ_CHUNK_BYTES,
        Setting().get(SettingKey.FILEHANDLE_MAX_SIZE),
    )
    buffer = io.BytesIO()
    with File().open(fileDoc) as handle:
        while True:
            chunk = handle.read(chunkSize)
            if not chunk:
                break
            buffer.write(chunk)
    return buffer.getvalue()


# ---- the array cache -------------------------------------------------------

# _cacheLock guards every structure below and is never held during I/O.
_cacheLock = threading.Lock()
_arrayCache = OrderedDict()
_arrayCacheBytes = 0
# key -> [lock, number of threads using it]: one cold load per key, the
# others wait for it and then read the cache.
_loadLocks = {}
# file id -> invalidation count. A load started before an invalidation of
# its file must not put its result in the cache afterwards.
_fileEpochs = {}


def _cacheKey(fileDoc, locationKey):
    return (str(fileDoc["_id"]), scalarMapRevision(fileDoc), locationKey)


def _cacheGet(key):
    with _cacheLock:
        array = _arrayCache.get(key)
        if array is not None:
            _arrayCache.move_to_end(key)
        return array


def _cachePut(key, array, epoch):
    global _arrayCacheBytes
    with _cacheLock:
        if _fileEpochs.get(key[0], 0) != epoch:
            return
        previous = _arrayCache.pop(key, None)
        if previous is not None:
            _arrayCacheBytes -= previous.nbytes
        _arrayCache[key] = array
        _arrayCacheBytes += array.nbytes
        while _arrayCache and _arrayCacheBytes > MAX_SCALAR_MAP_CACHE_BYTES:
            _, evicted = _arrayCache.popitem(last=False)
            _arrayCacheBytes -= evicted.nbytes


def invalidateScalarMapFiles(fileIds):
    """Drop cached arrays of the given files (on delete), and keep loads
    already in flight for them from caching their result."""
    global _arrayCacheBytes
    fileIds = {str(fileId) for fileId in fileIds}
    with _cacheLock:
        for fileId in fileIds:
            _fileEpochs[fileId] = _fileEpochs.get(fileId, 0) + 1
        for key in [k for k in _arrayCache if k[0] in fileIds]:
            _arrayCacheBytes -= _arrayCache.pop(key).nbytes


def clearScalarMapCache():
    global _arrayCacheBytes
    with _cacheLock:
        _arrayCache.clear()
        _arrayCacheBytes = 0


def scalarMapCacheBytes():
    with _cacheLock:
        return _arrayCacheBytes


def loadScalarMapArray(fileDoc, meta, locationKey):
    """The float32 array of `locationKey` from the map's file, through the
    process-wide byte-bounded LRU. Concurrent cold requests for the same
    array share one load."""
    key = _cacheKey(fileDoc, locationKey)
    array = _cacheGet(key)
    if array is not None:
        return array
    with _cacheLock:
        entry = _loadLocks.setdefault(key, [threading.Lock(), 0])
        entry[1] += 1
        epoch = _fileEpochs.get(key[0], 0)
    try:
        with entry[0]:
            array = _cacheGet(key)
            if array is None:
                array = readScalarMapArray(
                    _readFileBytes(fileDoc), locationKey, meta["shape"]
                )
                _cachePut(key, array, epoch)
    finally:
        with _cacheLock:
            entry[1] -= 1
            if entry[1] == 0:
                _loadLocks.pop(key, None)
    return array

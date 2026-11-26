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

import contextlib
import functools
import hashlib
import io
import json
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


def scalarMapFileIdentity(fileDoc):
    """A string that changes whenever the map's file contents change: a
    re-upload gets a new file id, and Girder's in-place content replacement
    (Upload.finalizeUpload with a fileId) rewrites `created` and `size`.
    sha512 is added when the assetstore computed one. Keys the array cache;
    scalarMapRevision builds on it."""
    created = fileDoc.get("created")
    identity = "%s-%s-%s" % (
        fileDoc["_id"], fileDoc.get("size"),
        created.strftime("%Y%m%d%H%M%S%f") if created else "",
    )
    if fileDoc.get("sha512"):
        identity += "-" + fileDoc["sha512"][:16]
    return identity


def scalarMapRevision(fileDoc, meta):
    """What the list route returns as `revision` and the tile ETag starts
    from: the file identity plus a digest of the metadata that places the
    array on the image (originPx, gridSpacingPx, shape), so a metadata-only
    correction also changes tile URLs and ETags."""
    geometry = json.dumps(
        [meta["originPx"], meta["gridSpacingPx"], meta["shape"]],
        separators=(",", ":"),
    )
    return "%s-%s" % (
        scalarMapFileIdentity(fileDoc),
        hashlib.sha1(geometry.encode()).hexdigest()[:12],
    )


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

# zipfile refuses encrypted members with RuntimeError and unknown compression
# methods with NotImplementedError (a RuntimeError subclass); both are a bad
# file, like the rest.
_ARCHIVE_ERRORS = (
    zipfile.BadZipFile, zlib.error, EOFError, OSError, RuntimeError,
)


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


def _readExactly(member, size):
    """`size` bytes of the member into one preallocated buffer, read in
    bounded chunks (no growing buffer, no final copy)."""
    buffer = bytearray(size)
    view = memoryview(buffer)
    position = 0
    while position < size:
        count = member.readinto(
            view[position:position + FILE_READ_CHUNK_BYTES]
        )
        if not count:
            break
        position += count
    return buffer, position


def readScalarMapArray(source, locationKey, expectedShape):
    """Decode one location's array from an .npz (bytes or a seekable binary
    file object) as float32.

    The source is opened strictly as a ZIP (a bare .npy is refused, not
    decoded), and the one explicit member `<locationKey>.npy` is both
    checked (2-D float, the metadata's shape, within the cell cap) and
    decoded, reading only as many bytes as its checked header allows. Only
    that member is decompressed; the archive is never held in memory."""
    if isinstance(source, (bytes, bytearray)):
        source = io.BytesIO(source)
    memberName = locationKey + ".npy"
    try:
        with zipfile.ZipFile(source) as archive:
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
                raw, received = _readExactly(member, expectedBytes)
    except _ARCHIVE_ERRORS as exc:
        raise ValueError("The map file is not a readable .npz: %s" % exc)
    if received != expectedBytes:
        raise ValueError("The map array for %s is truncated" % locationKey)
    flat = np.frombuffer(raw, dtype=dtype)
    array = (
        flat.reshape(shape[::-1]).T if fortranOrder else flat.reshape(shape)
    )
    array = np.array(array, dtype=np.float32, order="C")
    array.setflags(write=False)
    return array


class _BoundedReads:
    """A Girder FileHandle with every read split into pieces it accepts:
    it refuses one read above core.filehandle_max_size (16 MiB by default),
    and zipfile asks for a member's whole compressed size at once."""

    def __init__(self, handle, maxRead):
        self._handle = handle
        self._maxRead = maxRead

    def read(self, size=-1):
        if size is None or size < 0:
            size = None
        parts = []
        while size is None or size > 0:
            step = self._maxRead if size is None else min(size, self._maxRead)
            chunk = self._handle.read(step)
            if not chunk:
                break
            parts.append(chunk)
            if size is not None:
                size -= len(chunk)
        return parts[0] if len(parts) == 1 else b"".join(parts)

    def seek(self, offset, whence=io.SEEK_SET):
        self._handle.seek(offset, whence)
        return self._handle.tell()

    def tell(self):
        return self._handle.tell()

    def seekable(self):
        return True


@contextlib.contextmanager
def _openMapFile(fileDoc):
    """The map's file as a seekable binary file object for zipfile."""
    if (fileDoc.get("size") or 0) > MAX_SCALAR_MAP_FILE_BYTES:
        raise ValueError(
            "The map file is larger than %d bytes" % MAX_SCALAR_MAP_FILE_BYTES
        )
    maxRead = min(
        FILE_READ_CHUNK_BYTES,
        Setting().get(SettingKey.FILEHANDLE_MAX_SIZE),
    )
    with File().open(fileDoc) as handle:
        yield _BoundedReads(handle, maxRead)


# ---- the array cache -------------------------------------------------------

# _cacheLock guards every structure below and is never held during I/O.
_cacheLock = threading.Lock()
_arrayCache = OrderedDict()
_arrayCacheBytes = 0
# file identity -> [lock, number of threads using it]: at most one load per
# FILE at a time. Requests for other locations of the same file (a Z or Time
# scrub) queue behind it and then re-check the cache, so one map never has
# two archive reads in flight.
_loadLocks = {}
# file id -> invalidation count. A load started before an invalidation of
# its file must not put its result in the cache afterwards.
_fileEpochs = {}


def _cacheGet(key):
    with _cacheLock:
        array = _arrayCache.get(key)
        if array is not None:
            _arrayCache.move_to_end(key)
        return array


def _cachePut(key, array, fileId, epoch):
    global _arrayCacheBytes
    with _cacheLock:
        if _fileEpochs.get(fileId, 0) != epoch:
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


def _checkShape(array, meta, locationKey):
    # The cache is keyed by the file alone; metadata can change under it.
    if list(array.shape) != list(meta["shape"]):
        raise ValueError(
            "The map array for %s has shape %s, not the metadata's %s"
            % (locationKey, list(array.shape), list(meta["shape"]))
        )
    return array


def loadScalarMapArray(fileDoc, meta, locationKey):
    """The float32 array of `locationKey` from the map's file, through the
    process-wide byte-bounded LRU. At most one load per file runs at a
    time; concurrent requests for that file wait and re-check the cache."""
    fileId = str(fileDoc["_id"])
    identity = scalarMapFileIdentity(fileDoc)
    key = (fileId, identity, locationKey)
    array = _cacheGet(key)
    if array is not None:
        return _checkShape(array, meta, locationKey)
    with _cacheLock:
        entry = _loadLocks.setdefault(identity, [threading.Lock(), 0])
        entry[1] += 1
        epoch = _fileEpochs.get(fileId, 0)
    try:
        with entry[0]:
            array = _cacheGet(key)
            if array is None:
                with _openMapFile(fileDoc) as source:
                    array = readScalarMapArray(
                        source, locationKey, meta["shape"]
                    )
                _cachePut(key, array, fileId, epoch)
    finally:
        with _cacheLock:
            entry[1] -= 1
            if entry[1] == 0:
                _loadLocks.pop(identity, None)
    return _checkShape(array, meta, locationKey)

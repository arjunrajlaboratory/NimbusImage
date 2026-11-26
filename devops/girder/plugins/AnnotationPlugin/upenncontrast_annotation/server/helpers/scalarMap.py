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
import re
import threading
import zipfile
import zlib
from collections import OrderedDict

import numpy as np
from girder.models.file import File
from PIL import Image

from .colormaps import CONTINUOUS_COLORMAPS

SCALAR_MAP_META_KEY = "nimbusScalarMap"
SCALAR_MAP_VERSION = 1
SCALAR_MAP_COLORMAPS = ("viridis", "magma", "inferno", "gray")
LOCATION_KEY_PATTERN = re.compile(r"^xy\d+_z\d+_t\d+$")
# Cells (rows * cols) per location array. The worker writes at most ~4096^2;
# 32M cells (8192 x 4096) is 128 MiB as float32 and leaves headroom without
# letting one map item pin the cache.
MAX_SCALAR_MAP_CELLS = 32 * 1024 * 1024
# The compressed .npz is read whole into memory before the requested array is
# decompressed, so its size is bounded too.
MAX_SCALAR_MAP_FILE_BYTES = 512 * 1024 * 1024
# Process-wide budget for decoded arrays across every map and location.
MAX_SCALAR_MAP_CACHE_BYTES = 512 * 1024 * 1024
# Alpha of pixels on the unselected side of a threshold: visible enough to
# keep context, faint enough that would-be regions stand out.
THRESHOLD_DIM_ALPHA = 64
COLORMAP_LUT_SIZE = 256


def _isFiniteNumber(value):
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
    )


def _isNonNegativeInt(value):
    return isinstance(value, int) and not isinstance(value, bool) \
        and value >= 0


def _isFiniteNumberPair(value):
    return (
        isinstance(value, list) and len(value) == 2
        and all(_isFiniteNumber(v) for v in value)
    )


def validateScalarMapMeta(meta):
    """Raise ValueError unless `meta` is a usable version-1 map description.

    Only the fields the server and the layer depend on are checked: version,
    geometry (gridSpacingPx, originPx, shape), locations and valueRange,
    plus percentiles when present. Descriptive fields (name, property,
    statistic, ...) are passed through untouched."""
    if not isinstance(meta, dict):
        raise ValueError("scalar map metadata must be an object")
    version = meta.get("version")
    if isinstance(version, bool) or version != SCALAR_MAP_VERSION:
        raise ValueError("unsupported scalar map version")
    spacing = meta.get("gridSpacingPx")
    if not _isFiniteNumber(spacing) or spacing <= 0:
        raise ValueError("gridSpacingPx must be a positive number")
    if not _isFiniteNumberPair(meta.get("originPx")):
        raise ValueError("originPx must be two numbers")
    shape = meta.get("shape")
    if not (
        isinstance(shape, list) and len(shape) == 2
        and all(_isNonNegativeInt(v) and v > 0 for v in shape)
    ):
        raise ValueError("shape must be two positive integers")
    if shape[0] * shape[1] > MAX_SCALAR_MAP_CELLS:
        raise ValueError(
            "scalar map is larger than %d cells" % MAX_SCALAR_MAP_CELLS
        )
    locations = meta.get("locations")
    if not isinstance(locations, list) or not locations:
        raise ValueError("locations must be a non-empty list")
    keys = set()
    for location in locations:
        if not (
            isinstance(location, dict)
            and isinstance(location.get("key"), str)
            and LOCATION_KEY_PATTERN.match(location["key"])
            and all(
                _isNonNegativeInt(location.get(axis))
                for axis in ("XY", "Z", "Time")
            )
        ):
            raise ValueError(
                "each location must be {XY, Z, Time, key: 'xyX_zZ_tT'}"
            )
        keys.add(location["key"])
    if len(keys) != len(locations):
        raise ValueError("location keys must be unique")
    valueRange = meta.get("valueRange")
    if not _isFiniteNumberPair(valueRange) or valueRange[0] > valueRange[1]:
        raise ValueError("valueRange must be [min, max] with min <= max")
    percentiles = meta.get("percentiles")
    if percentiles is not None and not (
        isinstance(percentiles, list)
        and all(_isFiniteNumber(v) for v in percentiles)
        and all(a <= b for a, b in zip(percentiles, percentiles[1:]))
    ):
        raise ValueError("percentiles must be a non-decreasing number list")


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


# ---- loading and the array cache --------------------------------------------

def _readMemberHeader(npz, name):
    """(shape, dtype) of an .npz member from its .npy header, without
    decompressing the array."""
    with npz.zip.open(name + ".npy") as member:
        version = np.lib.format.read_magic(member)
        if version == (1, 0):
            shape, _, dtype = np.lib.format.read_array_header_1_0(member)
        elif version in ((2, 0), (3, 0)):
            shape, _, dtype = np.lib.format.read_array_header_2_0(member)
        else:
            raise ValueError("unsupported .npy version %s" % (version,))
    return shape, dtype


def readScalarMapArray(data, locationKey, expectedShape):
    """Decode one location's array from the .npz bytes as float32, checking
    its header (2-D float, the metadata's shape, within the cell cap) before
    decompressing it."""
    try:
        npz = np.load(io.BytesIO(data), allow_pickle=False)
    except (ValueError, OSError, EOFError, zipfile.BadZipFile) as exc:
        raise ValueError("The map file is not a readable .npz: %s" % exc)
    if not isinstance(npz, np.lib.npyio.NpzFile):
        raise ValueError("The map file is not a readable .npz")
    with npz:
        if locationKey not in npz.files:
            raise ValueError(
                "The map file has no array for location %s" % locationKey
            )
        try:
            shape, dtype = _readMemberHeader(npz, locationKey)
        except (OSError, EOFError, zipfile.BadZipFile, zlib.error) as exc:
            raise ValueError("The map file is not a readable .npz: %s" % exc)
        if dtype.kind != "f" or len(shape) != 2:
            raise ValueError(
                "The map array for %s is not a 2-D float array" % locationKey
            )
        if list(shape) != list(expectedShape):
            raise ValueError(
                "The map array for %s has shape %s, not the metadata's %s"
                % (locationKey, list(shape), list(expectedShape))
            )
        if shape[0] * shape[1] > MAX_SCALAR_MAP_CELLS:
            raise ValueError(
                "scalar map is larger than %d cells" % MAX_SCALAR_MAP_CELLS
            )
        try:
            array = np.ascontiguousarray(npz[locationKey], dtype=np.float32)
        except (OSError, EOFError, zipfile.BadZipFile, zlib.error) as exc:
            raise ValueError("The map file is not a readable .npz: %s" % exc)
    array.setflags(write=False)
    return array


_cacheLock = threading.Lock()
_arrayCache = OrderedDict()
_arrayCacheBytes = 0


def _cacheKey(fileDoc, locationKey):
    # The file id changes when a map is re-uploaded; size and checksum catch
    # contents replaced under the same file id.
    return (
        str(fileDoc["_id"]), fileDoc.get("size"), fileDoc.get("sha512"),
        locationKey,
    )


def _cacheGet(key):
    with _cacheLock:
        array = _arrayCache.get(key)
        if array is not None:
            _arrayCache.move_to_end(key)
        return array


def _cachePut(key, array):
    global _arrayCacheBytes
    with _cacheLock:
        previous = _arrayCache.pop(key, None)
        if previous is not None:
            _arrayCacheBytes -= previous.nbytes
        _arrayCache[key] = array
        _arrayCacheBytes += array.nbytes
        while _arrayCache and _arrayCacheBytes > MAX_SCALAR_MAP_CACHE_BYTES:
            _, evicted = _arrayCache.popitem(last=False)
            _arrayCacheBytes -= evicted.nbytes


def invalidateScalarMapFiles(fileIds):
    """Drop cached arrays of the given files (on delete)."""
    global _arrayCacheBytes
    fileIds = {str(fileId) for fileId in fileIds}
    with _cacheLock:
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
    process-wide byte-bounded LRU."""
    key = _cacheKey(fileDoc, locationKey)
    array = _cacheGet(key)
    if array is not None:
        return array
    if (fileDoc.get("size") or 0) > MAX_SCALAR_MAP_FILE_BYTES:
        raise ValueError(
            "The map file is larger than %d bytes" % MAX_SCALAR_MAP_FILE_BYTES
        )
    with File().open(fileDoc) as handle:
        data = handle.read()
    array = readScalarMapArray(data, locationKey, meta["shape"])
    _cachePut(key, array)
    return array

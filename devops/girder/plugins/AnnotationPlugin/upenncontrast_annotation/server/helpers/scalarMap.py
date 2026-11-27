"""Saved scalar maps: validation, loading and tile rendering
(codebaseDocumentation/HOTSPOT_REGIONS_WORKER.md §5.8 and §8.2).

A scalar map is an item in a dataset folder whose metadata key
`nimbusScalarMap` describes it and whose single file is an `.npz`
(`numpy.savez_compressed`) holding one 2-D float array per location key
(`xy{XY}_z{Z}_t{Time}`). Geometry: `array[row, col]` covers image pixels
`x in [originPx[0] + col * gridSpacingPx, originPx[0] + (col + 1) *
gridSpacingPx)` and the same in y with `row` and `originPx[1]`. Arrays are
float32 (or float16); every cell is finite or NaN, and NaN marks cells
outside the map's support. Anything else is refused when the array is read.

Everything here is pure numpy and raises ValueError; the API layer
(`server/api/scalarMap.py`) maps that to HTTP errors.
"""

import contextlib
import functools
import hashlib
import io
import json
import math
import struct
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
# Largest .npz accepted. It is streamed (never held whole); the cap bounds
# how much a single map can make a load read.
MAX_SCALAR_MAP_FILE_BYTES = 512 * 1024 * 1024
# Girder's FileHandle refuses a single read above core.filehandle_max_size
# (16 MiB by default), so the file is read in chunks no larger than this
# and no larger than that setting.
FILE_READ_CHUNK_BYTES = 8 * 1024 * 1024
# Process-wide budget for decoded arrays across every map and location.
MAX_SCALAR_MAP_CACHE_BYTES = 512 * 1024 * 1024
# Archive reads and decodes in flight at once, across all files. Each holds
# its member's raw bytes and the float32 copy (up to 2 x 128 MiB) before the
# cache budget accounts for any of it, so N maps shown at once would
# otherwise hold N times that.
MAX_CONCURRENT_SCALAR_MAP_DECODES = 2
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


def isScalarMapFileSet(fileDocs):
    """Whether an item's files can back a map: exactly one, stored in an
    assetstore. A Girder link file (createLinkFile: `assetstoreId` None and
    a `linkUrl`) cannot be opened as a file. The list route and the tile
    and delete routes apply this same rule, so an item is listed exactly
    when its tiles render. Needs each file's `assetstoreId`."""
    return (
        len(fileDocs) == 1 and fileDocs[0].get("assetstoreId") is not None
    )


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
    from: the file identity plus a digest of the whole validated
    `nimbusScalarMap` object (canonical JSON), so any metadata edit (the
    geometry, locations, valueRange, percentiles, ...) changes tile URLs,
    ETags and what list consumers derive their state from."""
    canonical = json.dumps(meta, sort_keys=True, separators=(",", ":"))
    return "%s-%s" % (
        scalarMapFileIdentity(fileDoc),
        hashlib.sha1(canonical.encode()).hexdigest()[:12],
    )


def locationKeys(meta):
    return {location["key"] for location in meta["locations"]}


def defaultDisplayRange(meta):
    """`valueRange`, widened around a constant map so min < max. The pad is
    relative for large values, where `v +- 0.5` rounds back to v (from
    2 ** 53); the client's `displayValueRange` uses the same rule."""
    low, high = (float(v) for v in meta["valueRange"])
    if low == high:
        pad = max(0.5, abs(low) * 1e-6)
        return low - pad, high + pad
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
    poisons a valid point and the map's support keeps its cell edges. A
    value is clamped to the range of its contributing samples (finite, with
    positive weight), so a point whose contributing cells all equal v
    samples to exactly v."""
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
    lowest = np.full_like(total, np.inf)
    highest = np.full_like(total, -np.inf)
    for rowIdx, colIdx, w in (
        (r0, c0, (1 - fy) * (1 - fx)),
        (r0, c1, (1 - fy) * fx),
        (r1, c0, fy * (1 - fx)),
        (r1, c1, fy * fx),
    ):
        values = array[np.ix_(rowIdx, colIdx)].astype(np.float64)
        # Only a finite sample with positive weight contributes. A
        # zero-weight neighbor (a pixel level with a cell center on one
        # axis, or in the half cell before the first center, where the
        # fraction is clamped to 0) must not widen the clamp bounds, or a
        # point whose contributing cells all equal v rounds a hair off v.
        valid = np.isfinite(values) & (w > 0)
        w = np.where(valid, w, 0.0)
        total += np.where(valid, values, 0.0) * w
        weight += w
        lowest = np.where(valid, np.minimum(lowest, values), lowest)
        highest = np.where(valid, np.maximum(highest, values), highest)
    with np.errstate(invalid="ignore", divide="ignore"):
        result = total / weight
    # An interpolated value never leaves the range of the samples it mixes;
    # clamping removes the rounding that made a flat region equal to a
    # threshold land a hair on either side of it.
    contributing = weight > 0
    result[contributing] = np.clip(
        result[contributing], lowest[contributing], highest[contributing]
    )
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
    # Finite min and max can still be too far apart to subtract
    # (-1e308, 1e308); with an infinite span, a cell far from min overflows
    # too and inf / inf = NaN, whose integer cast is CPU-dependent.
    span = float(vmax) - float(vmin)
    if not math.isfinite(span):
        raise ValueError("max - min must be a finite number")
    if thresholdSide not in ("above", "below"):
        raise ValueError("thresholdSide must be 'above' or 'below'")
    lut = colormapLut(colormap)
    valid = ~np.isnan(values)
    with np.errstate(over="ignore", invalid="ignore"):
        fraction = np.clip(
            (np.where(valid, values, vmin) - vmin) / span, 0, 1
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
# file, like the rest. Failures of the storage underneath arrive as
# ScalarMapStorageError instead, which is not in this tuple.
_ARCHIVE_ERRORS = (
    zipfile.BadZipFile, zlib.error, EOFError, OSError, RuntimeError,
)
# What np.savez and np.savez_compressed write. bzip2 and LZMA decompress a
# chunk without an output bound. Deflate is bounded per read, but only by
# the size the caller asks for, so every read made before the shape and
# cell caps apply (the .npy header, in _readNpyHeader) asks for a capped
# size itself.
ALLOWED_COMPRESSION = (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
# Longest .npy header read. numpy refuses a longer one too, but only after
# reading and decoding the length it declares (up to 4 GiB in .npy v2/v3);
# this is checked against the declared length first. A 2-D float header is
# ~128 bytes; 10,000 is numpy's own limit (`max_header_size`).
NPY_MAX_HEADER_BYTES = 10000
# The .npy header's length field, by format version.
_NPY_HEADER_LENGTH_FORMATS = {(1, 0): "<H", (2, 0): "<I", (3, 0): "<I"}
# Opening an archive parses its whole central directory (one ZipInfo per
# entry) before any member is looked up. A map holds one entry per location,
# ~70 directory bytes each with its name, so 16,384 locations (64 XY x 256
# time points, say) in 2 MiB (128 bytes per entry) leave headroom while
# bounding what one request makes zipfile build. The byte cap is the binding
# one: zipfile walks the directory by its size, not by the entry count the
# end record claims.
MAX_SCALAR_MAP_ENTRIES = 16384
MAX_CENTRAL_DIRECTORY_BYTES = 2 * 1024 * 1024
# The shortest ZIP: an end-of-central-directory record alone.
_ZIP_END_RECORD_BYTES = 22


class ScalarMapStorageError(Exception):
    """Reading the map's file from its assetstore failed (a network or disk
    error), as opposed to the file being malformed: a server error, not the
    caller's 400."""


def _readHeaderBytes(member, size):
    data = member.read(size)
    if len(data) != size:
        raise ValueError(
            "The map array has an unreadable header: it is truncated"
        )
    return data


def _readNpyHeader(member):
    """(shape, fortranOrder, dtype) from an open .npy stream, leaving it at
    the start of the data. The declared header length is checked against
    NPY_MAX_HEADER_BYTES before the header is read, and numpy parses only
    those bounded bytes."""
    try:
        version = np.lib.format.read_magic(member)
    except ValueError as exc:
        raise ValueError("The map array has an unreadable header: %s" % exc)
    lengthFormat = _NPY_HEADER_LENGTH_FORMATS.get(version)
    if lengthFormat is None:
        raise ValueError("unsupported .npy version %s" % (version,))
    lengthField = _readHeaderBytes(member, struct.calcsize(lengthFormat))
    (headerLength,) = struct.unpack(lengthFormat, lengthField)
    if headerLength > NPY_MAX_HEADER_BYTES:
        raise ValueError(
            "The map array has a %d-byte header, more than %d"
            % (headerLength, NPY_MAX_HEADER_BYTES)
        )
    bounded = io.BytesIO(lengthField + _readHeaderBytes(member, headerLength))
    try:
        # read_array_header_2_0 reads the 4-byte length field of v2 and v3.
        if version == (1, 0):
            return np.lib.format.read_array_header_1_0(bounded)
        return np.lib.format.read_array_header_2_0(bounded)
    except ValueError as exc:
        raise ValueError("The map array has an unreadable header: %s" % exc)


def _checkCentralDirectory(source):
    """Refuse an archive whose central directory is larger than a map's can
    be, before zipfile parses it, and rewind the source.

    Uses zipfile's own end-record reader, `zipfile._EndRecData` (private,
    but unchanged across many Python releases), so the size checked is the
    one ZipFile then reads, a zip64 end record included (it substitutes the
    64-bit fields). numpy writes zip64 directories only for members over
    4 GiB, which the file cap excludes, but one within the caps is bounded
    the same way."""
    source.seek(0, io.SEEK_END)
    if source.tell() < _ZIP_END_RECORD_BYTES:
        raise zipfile.BadZipFile("File is not a zip file")
    endRecord = zipfile._EndRecData(source)
    if endRecord is None:
        raise zipfile.BadZipFile("File is not a zip file")
    if endRecord[zipfile._ECD_ENTRIES_TOTAL] > MAX_SCALAR_MAP_ENTRIES:
        raise ValueError(
            "The map file has more than %d entries" % MAX_SCALAR_MAP_ENTRIES
        )
    if endRecord[zipfile._ECD_SIZE] > MAX_CENTRAL_DIRECTORY_BYTES:
        raise ValueError(
            "The map file's central directory is larger than %d bytes"
            % MAX_CENTRAL_DIRECTORY_BYTES
        )
    source.seek(0)


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
    checked (2-D float16 or float32, the metadata's shape, the cell cap)
    and decoded, reading only as many bytes as its checked header allows.
    Only that member is decompressed; the archive is never held in memory.
    The central directory (entry count and size) and the member's .npy
    header length are capped before either is parsed. A member holding
    +-inf is refused: cells are finite, or NaN for no data."""
    if isinstance(source, (bytes, bytearray)):
        source = io.BytesIO(source)
    memberName = locationKey + ".npy"
    try:
        _checkCentralDirectory(source)
        with zipfile.ZipFile(source) as archive:
            if memberName not in archive.namelist():
                raise ValueError(
                    "The map file has no array for location %s"
                    % locationKey
                )
            if archive.getinfo(memberName).compress_type \
                    not in ALLOWED_COMPRESSION:
                raise ValueError(
                    "The map array for %s uses an unsupported compression "
                    "method (only stored or deflated, as numpy writes)"
                    % locationKey
                )
            with archive.open(memberName) as member:
                shape, fortranOrder, dtype = _readNpyHeader(member)
                if dtype.kind != "f" or len(shape) != 2:
                    raise ValueError(
                        "The map array for %s is not a 2-D float array"
                        % locationKey
                    )
                # float16 and float32 only. float64 is refused rather than
                # rounded: a threshold equal to a float64 cell (0.7) would
                # then miss its float32 rounding (0.699999988).
                if dtype.itemsize > 4:
                    raise ValueError(
                        "The map array for %s is %s; save scalar maps as "
                        "float32" % (locationKey, dtype.name)
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
    # Checked before the float32 copy exists. Bilinear sampling weighs
    # every neighbor, and 0 * inf is NaN, so an inf cell would blank its
    # neighbors' pixels.
    if np.isinf(flat).any():
        raise ValueError(
            "The map array for %s has infinite values; cells must be finite, "
            "or NaN for no data" % locationKey
        )
    array = (
        flat.reshape(shape[::-1]).T if fortranOrder else flat.reshape(shape)
    )
    array = np.array(array, dtype=np.float32, order="C")
    array.setflags(write=False)
    return array


class _BoundedReads:
    """A Girder FileHandle with every read split into pieces it accepts:
    it refuses one read above core.filehandle_max_size (16 MiB by default),
    and zipfile asks for a member's whole compressed size at once.

    An OSError from the handle (disk, or S3 and other network assetstores:
    requests' exceptions are OSErrors) is re-raised as
    ScalarMapStorageError, so it is not reported as a malformed file."""

    def __init__(self, handle, maxRead):
        self._handle = handle
        self._maxRead = maxRead

    def read(self, size=-1):
        if size is None or size < 0:
            size = None
        parts = []
        while size is None or size > 0:
            step = self._maxRead if size is None else min(size, self._maxRead)
            try:
                chunk = self._handle.read(step)
            except OSError as exc:
                raise ScalarMapStorageError(
                    "Reading the map file failed: %s" % exc
                ) from exc
            if not chunk:
                break
            parts.append(chunk)
            if size is not None:
                size -= len(chunk)
        return parts[0] if len(parts) == 1 else b"".join(parts)

    def seek(self, offset, whence=io.SEEK_SET):
        try:
            self._handle.seek(offset, whence)
        except OSError as exc:
            raise ScalarMapStorageError(
                "Seeking in the map file failed: %s" % exc
            ) from exc
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
# Bounds archive reads across files (the per-file lock bounds them within
# one). Taken after the per-file lock, so waiters for one file still
# single-flight and a cache hit never waits on it, and released before
# _cachePut; a holder waits on nothing else, so it cannot deadlock.
_decodeSlots = threading.BoundedSemaphore(MAX_CONCURRENT_SCALAR_MAP_DECODES)


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
    time; concurrent requests for that file wait and re-check the cache.
    At most MAX_CONCURRENT_SCALAR_MAP_DECODES loads run across files."""
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
                with _decodeSlots, _openMapFile(fileDoc) as source:
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

"""Pure-Python port of the multi-source configuration logic in
``src/views/dataset/MultiSourceConfiguration.vue`` (plus the ND2 label
helpers in ``src/utils/ND2FileParsing.ts``).

Given the ordered item names and the ``large_image`` tile metadata for a
folder of uploaded files, these functions rebuild the exact
multi-source config JSON the frontend would produce, so a dataset can be
configured without the browser.

Everything here is a pure function operating on plain JSON-compatible
dicts/lists. Domain errors raise ``ValueError`` only -- never
``RestException`` (that is an API-layer concern; see CLAUDE.md).

Number formatting mirrors JavaScript precisely:

* ``js_to_fixed`` reproduces ``Number.prototype.toFixed``. The ECMAScript
  algorithm operates on the *magnitude* of the value with ties going to
  the larger scaled integer, then prepends the sign -- i.e. half away
  from zero, verified against V8 (``(-0.5).toFixed(0) === "-1"``,
  ``(-2.5).toFixed(0) === "-3"``). This is exactly Python's
  ``Decimal(x).quantize(..., ROUND_HALF_UP)`` on the exact binary
  expansion, with the sign of ``-0`` preserved.
* ``js_math_round`` reproduces ``Math.round`` (half toward +infinity):
  ``Math.round(-2.5) === -2``, ``Math.round(-0.5) === 0``.

(NOTE: an early spec draft described ``toFixed`` as half-toward-+infinity;
that is wrong for negatives. The frontend uses the real JS ``toFixed``,
which is half-away-from-zero, and that is what is ported here.)
"""

import math
import re
from decimal import Decimal, ROUND_HALF_UP

UP_DIMS = ("XY", "Z", "T", "C")

# Compositing sanity checks and defaults; the frontend's copies live in
# src/utils/ND2Compositing.ts. Two XY positions closer than this fraction
# of a tile are the same field imaged twice.
DUPLICATE_POSITION_FRACTION = 0.1
# Tiles covering less than this fraction of the mosaic's bounding box look
# like separate regions (e.g. different wells), not one stitched area.
SPARSE_COVERAGE_FRACTION = 0.25
# A composite of more tiles than this renders zoomed-out views from that
# many sources unless it is transcoded, so transcode becomes the default.
COMPOSITE_TRANSCODE_TILE_THRESHOLD = 16
# Sub-cells per tolerance cell (per axis) in the duplicate check.
DUPLICATE_SUBCELLS = 8
# Camera matrices closer than this are the same orientation.
CAMERA_MATRIX_TOLERANCE = 0.01

_DIMENSION_NAMES = {
    "XY": "Positions",
    "Z": "Z",
    "T": "Time",
    "C": "Channels",
}


# ---------------------------------------------------------------------------
# JS number-formatting helpers
# ---------------------------------------------------------------------------

def int32(x):
    """JS ``x | 0``: ToInt32 truncation toward zero, mod 2^32 signed."""
    if math.isnan(x) or math.isinf(x):
        return 0
    n = int(math.trunc(x)) & 0xFFFFFFFF
    if n >= 0x80000000:
        n -= 0x100000000
    return n


def js_math_round(x):
    """JS ``Math.round(x)``: round half toward +infinity, returns int."""
    if math.isnan(x):
        return 0
    return math.floor(x + 0.5)


def js_to_fixed(x, digits):
    """JS ``Number.prototype.toFixed(digits)``.

    Rounds the exact double value half away from zero (matching V8) and
    preserves the sign of a value that rounds to ``-0``.
    """
    if math.isnan(x):
        return "NaN"
    quantum = Decimal(1).scaleb(-digits)
    value = Decimal(x).quantize(quantum, rounding=ROUND_HALF_UP)
    text = format(value, "f")
    # Preserve the negative sign for values that round to zero.
    if value == 0 and not text.startswith("-"):
        if x < 0 or math.copysign(1.0, x) < 0:
            text = "-" + text
    return text


# JS regex used by trimFloat to strip trailing zeros.
_TRIM_TRAILING = re.compile(r"(?:\.0+|(\.\d*?[1-9])0+)$")


def _trim_trailing_zeros(text):
    return _TRIM_TRAILING.sub(lambda m: m.group(1) or "", text)


def trim_float(n):
    """Port of ``trimFloat``: pick a precision by magnitude, then strip
    trailing zeros with the exact JS regex."""
    magnitude = abs(n)
    if magnitude >= 100:
        text = js_to_fixed(n, 0)
    elif magnitude >= 10:
        text = js_to_fixed(n, 1)
    elif magnitude >= 1:
        text = js_to_fixed(n, 2)
    elif magnitude >= 0.1:
        text = js_to_fixed(n, 3)
    elif magnitude >= 0.01:
        text = js_to_fixed(n, 4)
    else:
        text = js_to_fixed(n, 5)
    return _trim_trailing_zeros(text)


def _is_finite(value):
    """JS ``Number.isFinite(value)``: only actual finite numbers.

    ``bool`` is excluded deliberately -- Python's ``isinstance(True, int)``
    is ``True`` but ``Number.isFinite(true)`` is ``false``.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    return not (
        isinstance(value, float)
        and (value != value or value in (float("inf"), float("-inf")))
    )


def _js_number_or_zero(value):
    """JS ``Number(value ?? 0) || 0``.

    Non-numeric input coerces to ``NaN`` in JS and ``|| 0`` then makes it
    ``0``, where Python's ``float()`` would raise. ``|| 0`` is falsy-based,
    so ``-0`` becomes ``+0`` too -- without that, a zero step renders as
    "-0 nm" instead of "0 nm". Infinity is truthy in JS and is deliberately
    preserved (the label formatters render it as "").

    Residual difference, not worth a JS number parser: Python accepts the
    strings ``"inf"``/``"nan"`` where ``Number()`` yields ``NaN``.
    """
    if value is None:
        return 0.0
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        number = float(value)
    elif isinstance(value, str):
        if value.strip() == "":
            return 0.0  # JS Number("") === 0
        try:
            number = float(value)
        except ValueError:
            return 0.0  # NaN, then `|| 0`
    else:
        return 0.0  # Number({}) / Number([1,2]) is NaN, then `|| 0`
    # NaN, 0 and -0 are all falsy, so `|| 0` maps every one of them to +0.
    return 0.0 if number != number or number == 0 else number


def format_duration_short(ms):
    """Port of ``formatDurationShort`` (units: ms, s, min, h, d)."""
    if not _is_finite(ms):
        return ""
    if ms < 1:
        return "%s ms" % js_to_fixed(ms, 0)
    if ms < 1000:
        return "%s ms" % js_math_round(ms)
    seconds = ms / 1000
    if seconds < 60:
        return "%s s" % trim_float(seconds)
    minutes = seconds / 60
    if minutes < 60:
        return "%s min" % trim_float(minutes)
    hours = minutes / 60
    if hours < 24:
        return "%s h" % trim_float(hours)
    return "%s d" % trim_float(hours / 24)


def format_distance_short(um):
    """Port of ``formatDistanceShort``. The micron unit uses the MICRO
    SIGN U+00B5 (µ), copied from ND2FileParsing.ts."""
    if not _is_finite(um):
        return ""
    if abs(um) >= 1000:
        return "%s mm" % trim_float(um / 1000)
    if abs(um) >= 1:
        return "%s µm" % trim_float(um)
    return "%s nm" % trim_float(um * 1000)


# ---------------------------------------------------------------------------
# ND2 label extraction (port of ND2FileParsing.ts)
# ---------------------------------------------------------------------------

def _find_experiment(internal_meta, loop_type):
    for entry in internal_meta.get("nd2_experiment") or []:
        if isinstance(entry, dict) and entry.get("type") == loop_type:
            return entry
    return None


def _get_time_labels(internal_meta):
    entry = _find_experiment(internal_meta, "TimeLoop")
    if entry is None:
        return None
    count = max(0, int32(entry.get("count", 0)))
    params = entry.get("parameters") or {}
    period_ms = params.get("periodMs") or 0
    period_ms = max(0, period_ms)
    return [format_duration_short(i * period_ms) for i in range(count)]


def _get_z_labels(internal_meta):
    entry = _find_experiment(internal_meta, "ZStackLoop")
    if entry is None:
        return None
    count = max(0, int32(entry.get("count", 0)))
    params = entry.get("parameters") or {}
    # JS: Number(z.parameters.stepUm ?? 0) || 0
    step_um = _js_number_or_zero(params.get("stepUm"))

    home_index = params.get("homeIndex")
    has_home = _is_finite(home_index)
    home = home_index if has_home else 0

    labels = []
    for i in range(count):
        delta = (i - home) * step_um if has_home else i * step_um
        labels.append(format_distance_short(delta))
    return labels


def _get_xy_labels(internal_meta):
    entry = _find_experiment(internal_meta, "XYPosLoop")
    if entry is None:
        return None
    params = entry.get("parameters") or {}
    points = params.get("points")
    if not points:
        return None
    labels = []
    for point in points:
        x, y = point["stagePositionUm"][0], point["stagePositionUm"][1]
        labels.append("%s, %s" % (trim_float(x), trim_float(y)))
    return labels


def _extract_labels_from_nd2(dim, internal_metadata, assignment_size):
    """Port of ``extractDimensionLabelsFromND2``."""
    if internal_metadata is None:
        return None
    for internal_meta in internal_metadata:
        if internal_meta and internal_meta.get("nd2_experiment"):
            if dim == "T":
                labels = _get_time_labels(internal_meta)
            elif dim == "Z":
                labels = _get_z_labels(internal_meta)
            elif dim == "XY":
                labels = _get_xy_labels(internal_meta)
            else:  # dim == "C": no ND2 extraction (returns immediately)
                return None
            if labels and len(labels) == assignment_size:
                return labels
    return None


# ---------------------------------------------------------------------------
# JS truthiness
# ---------------------------------------------------------------------------

def _truthy(value):
    """Mirror JS truthiness: None/False/0/0.0/""/NaN are falsy; every
    dict and list (even empty) is truthy."""
    if value is None or value is False:
        return False
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return not (value == 0 or value != value)
    if isinstance(value, str):
        return value != ""
    return True


# ---------------------------------------------------------------------------
# Dimension building (initializeImplementation)
# ---------------------------------------------------------------------------

def _detect_color_vs_channels(tile_meta):
    """Port of ``detectColorVsChannels``."""
    band_count = tile_meta.get("bandCount") or 1
    is_color = False

    metadata = tile_meta.get("metadata") or {}
    photo = metadata.get("photometricInterpretation")
    if photo == 2 or photo == "RGB":
        is_color = True

    index_range = tile_meta.get("IndexRange")
    if index_range is not None:
        index_c = index_range.get("IndexC")
        if index_c is not None and index_c > 1:
            is_color = False

    # JS `typeof photo === "undefined"`: an explicit null is an "object", so
    # it does NOT reach the band-count fallback. Key on key presence, not on
    # `photo is None`, which would conflate the two.
    if "photometricInterpretation" not in metadata:
        if band_count == 3 or band_count == 4:
            is_color = True

    return is_color


class _DimensionBuilder:
    """Accumulates dimensions while mirroring ``addSizeToDimension`` and
    its per-source naming counters."""

    def __init__(self):
        self.dimensions = []
        self._filename_count = 0
        self._file_count = 0
        self._image_count = 0
        self._id_count = 0

    def add(self, guess, size, source, data, name=None):
        if size == 0:
            return

        if source == "file":
            existing = next(
                (
                    dim for dim in self.dimensions
                    if dim["source"] == "file" and dim["guess"] == guess
                ),
                None,
            )
            if existing is not None:
                merged = dict(existing["data"])
                merged.update(data)
                existing["data"] = merged
                existing["size"] = max(existing["size"], size)
                return

        computed_name = name
        if not computed_name:
            if source == "filename":
                self._filename_count += 1
                computed_name = "Filename variable %d" % self._filename_count
            elif source == "file":
                self._file_count += 1
                computed_name = "Metadata %d (%s)" % (
                    self._file_count, _DIMENSION_NAMES[guess],
                )
            elif source == "images":
                self._image_count += 1
                computed_name = "Image variable %d" % self._image_count

        self.dimensions.append({
            "id": self._id_count,
            "guess": guess,
            "size": size,
            "name": computed_name,
            "source": source,
            "data": data,
        })
        self._id_count += 1


def build_dimensions(item_names, tiles_metadata):
    """Port of the dimension-building portion of
    ``initializeImplementation``.

    Returns a dict with ``dimensions``, ``transcodeDefault``,
    ``isRGBFile`` and ``rgbBandCount``.
    """
    builder = _DimensionBuilder()

    transcode_default = not all(
        name.lower().endswith(".nd2") for name in item_names
    )

    if len(item_names) > 1:
        from .filename_parsing import collect_filename_metadata
        for variable in collect_filename_metadata(item_names):
            builder.add(
                variable["guess"],
                len(variable["values"]),
                "filename",
                variable,
            )

    first_item = tiles_metadata[0] if tiles_metadata else {}
    rgb_band_count = first_item.get("bandCount") or 0
    is_rgb_file = _detect_color_vs_channels(first_item)

    max_frames_per_item = 0
    has_file_variable = False
    for tile_idx, tile in enumerate(tiles_metadata):
        frames = len(tile.get("frames") or []) or 1
        max_frames_per_item = max(max_frames_per_item, frames)

        index_range = tile.get("IndexRange")
        index_stride = tile.get("IndexStride")
        if _truthy(index_range) and _truthy(index_stride):
            has_file_variable = True
            for dim in UP_DIMS:
                index_dim = "Index" + dim
                range_size = index_range.get(index_dim)
                if _truthy(range_size):
                    builder.add(
                        dim,
                        range_size,
                        "file",
                        {
                            tile_idx: {
                                "range": range_size,
                                "stride": index_stride.get(index_dim),
                                "values": (
                                    tile.get("channels") if dim == "C"
                                    else None
                                ),
                            },
                        },
                    )

    if not has_file_variable:
        builder.add(
            "Z",
            max_frames_per_item,
            "images",
            None,
            name="All frames per item",
        )

    return {
        "dimensions": builder.dimensions,
        "transcodeDefault": transcode_default,
        "isRGBFile": is_rgb_file,
        "rgbBandCount": rgb_band_count,
    }


# ---------------------------------------------------------------------------
# Assignments
# ---------------------------------------------------------------------------

def _default_for_dim(dimensions, dim):
    """Port of ``getDefaultAssignmentItem`` (returns dimension or None)."""
    for dimension in dimensions:
        if (dimension["source"] == "file" and dimension["size"] > 0
                and dimension["guess"] == dim):
            return dimension
    for dimension in dimensions:
        if dimension["size"] > 0 and dimension["guess"] == dim:
            return dimension
    return None


def get_default_assignments(dimensions):
    """Port of ``resetDimensionsToDefault``: ``{dim: dimension|None}``."""
    return {dim: _default_for_dim(dimensions, dim) for dim in UP_DIMS}


def apply_assignment_strategy(dimensions, strategy):
    """Port of ``applyDimensionStrategy``.

    ``strategy`` maps each dimension to ``{'source', 'guess'}`` or ``None``
    (explicit unassign). Keys absent from ``strategy`` fall back to the
    default assignment for that dimension.
    """
    assignments = {}
    for dim in UP_DIMS:
        if dim not in strategy:
            assignments[dim] = _default_for_dim(dimensions, dim)
            continue

        saved = strategy[dim]
        if not saved:
            assignments[dim] = None
            continue

        source = saved.get("source")
        guess = saved.get("guess")

        match = next(
            (
                dimension for dimension in dimensions
                if dimension["source"] == source
                and dimension["guess"] == guess
                and dimension["size"] > 0
            ),
            None,
        )
        if match is None:
            match = next(
                (
                    dimension for dimension in dimensions
                    if dimension["guess"] == guess and dimension["size"] > 0
                ),
                None,
            )
        if match is None:
            match = next(
                (
                    dimension for dimension in dimensions
                    if dimension["source"] == source and dimension["size"] > 0
                ),
                None,
            )
        if match is None:
            match = _default_for_dim(dimensions, dim)

        assignments[dim] = match

    return assignments


def validate_source_dtypes(tiles_metadata):
    """Port of ``mixedSourceDtypeError``.

    Refuse to combine sources with different pixel types. Mirrors the
    frontend's ``sourceDtypes`` computed: string ``dtype`` values only,
    trimmed and lowercased, de-duplicated in first-seen order.

    Raises ``ValueError`` with the frontend's error text on failure.
    """
    dtypes = list(dict.fromkeys(
        tile.get("dtype").strip().lower()
        for tile in (tiles_metadata or [])
        if isinstance(tile, dict) and isinstance(tile.get("dtype"), str)
        and tile["dtype"].strip() != ""
    ))
    if len(dtypes) <= 1:
        return
    raise ValueError(
        "Source images use different pixel types (%s). Convert all source "
        "images to the same pixel type before combining them. You will "
        "need to start over." % ", ".join(dtypes)
    )


def validate_assignments(dimensions, assignments, is_multiband_rgb,
                         split_rgb_bands):
    """Port of ``submitEnabled`` + ``isRGBAssignmentValid``.

    Raises ``ValueError`` with the frontend's error text on failure.
    """
    filled = sum(1 for dim in UP_DIMS if assignments.get(dim) is not None)
    sized = sum(1 for dimension in dimensions if dimension["size"] > 0)
    if not (filled >= sized or filled >= 4):
        raise ValueError("Not all variables are assigned")

    if is_multiband_rgb and split_rgb_bands \
            and assignments.get("C") is not None:
        raise ValueError(
            "If splitting RGB file into channels, then filenames must be "
            "assigned to another variable"
        )


# ---------------------------------------------------------------------------
# Config generation (generateJson)
# ---------------------------------------------------------------------------

def _sorted_item_indices(data):
    """Ascending numeric-key iteration order (JS ``for..in`` over an object
    with integer keys)."""
    return sorted(data.keys(), key=int)


def _value_from_assignments(assignments, item_names, dim, item_idx,
                            frame_idx):
    """Port of ``getValueFromAssignments``."""
    assignment = assignments.get(dim)
    if not assignment:
        return 0
    source = assignment["source"]
    if source == "file":
        item_data = assignment["data"].get(item_idx)
        if item_data:
            return (
                math.floor(frame_idx / item_data["stride"])
                % item_data["range"]
            )
        return 0
    if source == "filename":
        return assignment["data"]["valueIdxPerFilename"][item_names[item_idx]]
    # images
    return frame_idx


def _channels_from_assignment(assignment):
    """Compute the base channel list from the C assignment (before RGB
    expansion). Mirrors the switch in ``generateJson``."""
    channels = None
    if assignment:
        source = assignment["source"]
        if source == "file":
            channels_per_idx = []
            for item_idx in _sorted_item_indices(assignment["data"]):
                values = assignment["data"][item_idx]["values"]
                if values:
                    for chan_idx, value in enumerate(values):
                        while len(channels_per_idx) <= chan_idx:
                            channels_per_idx.append([])
                        if value not in channels_per_idx[chan_idx]:
                            channels_per_idx[chan_idx].append(value)
            channels = ["/".join(group) for group in channels_per_idx]
        elif source == "filename":
            channels = assignment["data"]["values"]
        elif source == "images":
            channels = [
                "Default %d" % i for i in range(assignment["size"])
            ]

    if channels is None or len(channels) == 0:
        channels = ["Default"]
    return channels


def _extract_dimension_labels(assignments, internal_metadata, dim):
    """Port of ``extractDimensionLabels`` (computed before RGB expansion)."""
    assignment = assignments.get(dim)
    if not assignment:
        return None

    if assignment["source"] == "file" and internal_metadata is not None:
        nd2_labels = _extract_labels_from_nd2(
            dim, internal_metadata, assignment["size"],
        )
        if nd2_labels:
            return nd2_labels

    source = assignment["source"]
    if source == "file":
        labels_per_idx = {}
        max_idx = -1
        for item_idx in _sorted_item_indices(assignment["data"]):
            values = assignment["data"][item_idx]["values"]
            if values:
                for idx, value in enumerate(values):
                    bucket = labels_per_idx.setdefault(idx, [])
                    if value not in bucket:
                        bucket.append(value)
                    max_idx = max(max_idx, idx)
        return [
            "/".join(labels_per_idx.get(idx, []))
            for idx in range(max_idx + 1)
        ]
    if source == "filename":
        return assignment["data"]["values"]
    # images
    return [str(i + 1) for i in range(assignment["size"])]


def _camera_matrix_source(nd2):
    """Return the camera transformation matrix (or None) mirroring
    ``chan.volume !== undefined ? chan.volume : chan[0]?.volume``; a
    channel without a (dict) volume has no matrix."""
    channels = nd2.get("channels")
    if not channels:
        return None
    if isinstance(channels, dict):
        volume = channels.get("volume")
    elif isinstance(channels, list) and isinstance(channels[0], dict):
        volume = channels[0].get("volume")
    else:
        volume = None
    if not isinstance(volume, dict):
        return None
    return volume.get("cameraTransformationMatrix")


def _is_positive_number(value):
    return _is_finite(value) and value > 0


def _frame_count(tile_meta):
    return len(tile_meta.get("frames") or []) or 1


def _channels_in_file(tile_meta):
    return (tile_meta.get("IndexRange") or {}).get("IndexC") or 1


def _compositing_frame_metadata_index(tile_meta, frame_idx):
    """Port of ``compositingFrameMetadataIndex``: which of a file's
    ``nd2_frame_metadata`` entries frame ``frame_idx`` uses. ND2 records one
    entry per camera frame (position x Z x T) and large_image lists the
    file's channels fastest within it, so the entry is the frame index
    divided by the file's own channel count."""
    return math.floor(frame_idx / _channels_in_file(tile_meta))


def _stage_position(frame):
    """``frame?.position?.stagePositionUm`` for any JSON value."""
    position = frame.get("position") if isinstance(frame, dict) else None
    return (
        position.get("stagePositionUm") if isinstance(position, dict)
        else None
    )


def _has_stage_positions(internal_meta):
    frames_metadata = (
        internal_meta.get("nd2_frame_metadata")
        if isinstance(internal_meta, dict) else None
    )
    return (
        isinstance(frames_metadata, list)
        and len(frames_metadata) > 0
        and all(
            isinstance(_stage_position(frame), list)
            and len(_stage_position(frame)) >= 2
            and all(_is_finite(v) for v in _stage_position(frame)[:2])
            for frame in frames_metadata
        )
    )


def _camera_transform(internal_meta):
    """One file's camera matrix; a matrix within 0.01 of -I snaps to -I,
    and a missing one is the identity."""
    nd2 = internal_meta.get("nd2")
    matrix = _camera_matrix_source(nd2) if isinstance(nd2, dict) else None
    if (isinstance(matrix, list) and len(matrix) >= 4
            and all(_is_finite(v) for v in matrix[:4])
            and (abs(matrix[0] - 1) > CAMERA_MATRIX_TOLERANCE
                 or abs(matrix[3] - 1) > CAMERA_MATRIX_TOLERANCE)):
        if (abs(matrix[0] + 1) < CAMERA_MATRIX_TOLERANCE
                and abs(matrix[3] + 1) < CAMERA_MATRIX_TOLERANCE):
            return {"s11": -1.0, "s12": 0.0, "s21": 0.0, "s22": -1.0}
        return {"s11": matrix[0], "s12": matrix[1],
                "s21": matrix[2], "s22": matrix[3]}
    return {"s11": 1, "s12": 0, "s21": 0, "s22": 1}


def _tile_footprint(transform, size_x, size_y):
    """Port of ``tileFootprint``: one tile's mosaic-space corners under
    ``transform``, as ``(width, height, min_x, min_y)``."""
    corners = [(0, 0), (size_x, 0), (0, size_y), (size_x, size_y)]
    xs = [transform["s11"] * x + transform["s12"] * y for x, y in corners]
    ys = [transform["s21"] * x + transform["s22"] * y for x, y in corners]
    return max(xs) - min(xs), max(ys) - min(ys), min(xs), min(ys)


def _same_transform(a, b):
    return all(
        abs(a[key] - b[key]) <= CAMERA_MATRIX_TOLERANCE
        for key in ("s11", "s12", "s21", "s22")
    )


def _can_composite(tiles_metadata, internal_metadata, xy_assignment_size):
    """Port of ``canCompositeByStagePosition``: every file has a stage
    position for each camera frame its frames use, a usable pixel size and
    the same camera orientation; several files also need the same tile
    geometry and an XY assignment that tells their positions apart."""
    if (
        len(tiles_metadata) == 0
        or len(tiles_metadata) != len(internal_metadata)
        or not all(_has_stage_positions(m) for m in internal_metadata)
        or not all(
            _is_positive_number(tile.get(key))
            for tile in tiles_metadata
            for key in ("sizeX", "sizeY", "mm_x", "mm_y")
        )
        or not all(
            _compositing_frame_metadata_index(tile, _frame_count(tile) - 1)
            < len(internal_metadata[item_idx]["nd2_frame_metadata"])
            for item_idx, tile in enumerate(tiles_metadata)
        )
    ):
        return False
    first_transform = _camera_transform(internal_metadata[0])
    width, height, _min_x, _min_y = _tile_footprint(
        first_transform, tiles_metadata[0]["sizeX"],
        tiles_metadata[0]["sizeY"],
    )
    # A degenerate matrix (e.g. all zeros) collapses the tile to nothing.
    if not (width > 0 and height > 0) or not all(
        _same_transform(_camera_transform(meta), first_transform)
        for meta in internal_metadata
    ):
        return False
    if len(tiles_metadata) == 1:
        return True
    first = tiles_metadata[0]
    return xy_assignment_size > 1 and all(
        tile.get(key) == first.get(key)
        for tile in tiles_metadata
        for key in ("sizeX", "sizeY", "mm_x", "mm_y")
    )


def _compositing_positions(tiles_metadata, internal_metadata):
    """Port of ``compositingCoordinates``: pixel positions for every
    ``nd2_frame_metadata`` entry of every item, concatenated in item order,
    the offset where each item's entries start, and one tile's
    mosaic-space ``(width, height)``. All files share the
    first file's pixel size and camera orientation (the gate checks both),
    which also sets the mosaic's extent."""
    first_tile = tiles_metadata[0]
    mm_x = first_tile["mm_x"]
    mm_y = first_tile["mm_y"]
    size_x = first_tile["sizeX"]
    size_y = first_tile["sizeY"]

    coordinates = []
    item_offsets = []
    for internal_meta in internal_metadata:
        item_offsets.append(len(coordinates))
        transform = _camera_transform(internal_meta)
        for frame in internal_meta["nd2_frame_metadata"]:
            stage = frame["position"]["stagePositionUm"]
            coordinates.append({
                "x": stage[0] / (mm_x * 1000),
                "y": stage[1] / (mm_y * 1000),
                **transform,
            })

    first = coordinates[0] if coordinates else {}
    # One tile's mosaic-space footprint: a rotated non-square tile swaps
    # width and height.
    tile_width, tile_height, corner_min_x, corner_min_y = _tile_footprint(
        {key: first.get(key, default) for key, default in (
            ("s11", 1), ("s12", 0), ("s21", 0), ("s22", 1))},
        size_x, size_y,
    )
    min_x = min(c["x"] for c in coordinates) + corner_min_x
    max_y = max(c["y"] for c in coordinates) - corner_min_y
    final_coordinates = [
        {
            "x": js_math_round(c["x"] - min_x),
            "y": js_math_round(max_y - c["y"]),
            "s11": c["s11"], "s12": c["s12"],
            "s21": c["s21"], "s22": c["s22"],
        }
        for c in coordinates
    ]
    tile_size = (tile_width, tile_height)
    return final_coordinates, item_offsets, tile_size


def slim_internal_metadata(internal_meta):
    """Keep only the internal-metadata fields the configuration reads.

    ND2 internal metadata also carries ``nd2_text``, ``nd2_custom`` and full
    per-frame records, which for a folder of thousands of tiles is far more
    than the configuration needs. This keeps ``nd2_experiment`` (dimension
    labels), each frame's stage position and the first channel's camera
    matrix, in the same shapes, so every reader behaves as on the full
    metadata.
    """
    if not isinstance(internal_meta, dict):
        return internal_meta
    slim = {}
    if "nd2_experiment" in internal_meta:
        slim["nd2_experiment"] = internal_meta["nd2_experiment"]
    frames = internal_meta.get("nd2_frame_metadata")
    if isinstance(frames, list):
        slim["nd2_frame_metadata"] = [
            {"position": {"stagePositionUm": _stage_position(frame)}}
            for frame in frames
        ]
    elif "nd2_frame_metadata" in internal_meta:
        slim["nd2_frame_metadata"] = frames
    nd2 = internal_meta.get("nd2")
    if isinstance(nd2, dict) and "channels" in nd2:
        slim["nd2"] = {"channels": _slim_channels(nd2["channels"])}
    return slim


def _slim_volume(volume):
    if not isinstance(volume, dict):
        return volume
    if "cameraTransformationMatrix" not in volume:
        return {}
    return {
        "cameraTransformationMatrix": volume["cameraTransformationMatrix"],
    }


def _slim_channels(channels):
    """Keep the one volume ``_camera_matrix_source`` reads."""
    if isinstance(channels, dict):
        if "volume" in channels:
            return {"volume": _slim_volume(channels["volume"])}
        return {}
    if isinstance(channels, list) and channels:
        first = channels[0]
        if isinstance(first, dict) and "volume" in first:
            return [{"volume": _slim_volume(first["volume"])}]
        return [{}]
    return channels


def compositing_check(item_names, tiles_metadata, layout, xy_value):
    """Port of ``compositingCheck``: problems with laying these sources out
    by stage position, from every stage entry the sources use.

    ``error``: two entries with different XY values at the same stage
    position (the same field imaged twice), which refuses compositing.
    Entries sharing an XY value there (a Z stack, or channels split across
    files) are one tile. ``warning``: the tiles cover little of the mosaic,
    which does not refuse it. ``tileCount``: the distinct tiles the
    composite holds (None with an error). ``layout`` is
    ``_compositing_positions``'s result and ``xy_value(item_idx,
    frame_idx)`` the frame's XY assignment.
    """
    # Measured in mosaic space: the camera transform can rotate the tile.
    final_coordinates, item_offsets, (size_x, size_y) = layout
    tol_x = DUPLICATE_POSITION_FRACTION * size_x
    tol_y = DUPLICATE_POSITION_FRACTION * size_y

    points = []
    for item_idx in range(len(item_names)):
        tile = tiles_metadata[item_idx]
        last_entry = -1
        for frame_idx in range(_frame_count(tile)):
            entry = _compositing_frame_metadata_index(tile, frame_idx)
            if entry == last_entry:
                continue
            last_entry = entry
            position = final_coordinates[item_offsets[item_idx] + entry]
            points.append({
                "x": position["x"], "y": position["y"],
                "xy": xy_value(item_idx, frame_idx), "item": item_idx,
            })

    # Points are bucketed into tolerance-sized cells, each split into
    # DUPLICATE_SUBCELLS x DUPLICATE_SUBCELLS sub-cells. Each sub-cell keeps
    # one box per XY value covering every point of that value merged there,
    # so a long Z/T stack at one position stays a few entries (linear), and
    # no merged point is forgotten: a different-XY point within tolerance
    # of any of them is caught. A box spans at most 1/DUPLICATE_SUBCELLS of
    # the tolerance, which bounds how far "near a box" can overstate "near
    # a point".
    def near(box, x, y):
        return (max(box["minX"] - x, x - box["maxX"], 0) < tol_x
                and max(box["minY"] - y, y - box["maxY"], 0) < tol_y)

    error = None
    tile_count = 0
    cells = {}
    for index, point in enumerate(points):
        cell_x = math.floor(point["x"] / tol_x)
        cell_y = math.floor(point["y"] / tol_y)
        duplicate_of = None
        same_tile = False
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for box in cells.get((cell_x + dx, cell_y + dy), []):
                    if not near(box, point["x"], point["y"]):
                        continue
                    if box["xy"] == point["xy"]:
                        same_tile = True
                    elif duplicate_of is None or box["first"] < duplicate_of:
                        duplicate_of = box["first"]
        if duplicate_of is not None:
            first = points[duplicate_of]
            error = (
                '"%s" (XY %d) and "%s" (XY %d) are at the same stage '
                "position, so compositing would draw one on top of the "
                "other. Remove the duplicate, or leave Composite off to "
                "keep them as separate XY positions." % (
                    item_names[first["item"]], first["xy"] + 1,
                    item_names[point["item"]], point["xy"] + 1,
                )
            )
            break
        if not same_tile:
            tile_count += 1
        cell = cells.setdefault((cell_x, cell_y), [])
        sub = (
            math.floor(point["x"] / (tol_x / DUPLICATE_SUBCELLS)),
            math.floor(point["y"] / (tol_y / DUPLICATE_SUBCELLS)),
        )
        box = next(
            (b for b in cell if b["xy"] == point["xy"] and b["sub"] == sub),
            None,
        )
        if box is not None:
            box["minX"] = min(box["minX"], point["x"])
            box["maxX"] = max(box["maxX"], point["x"])
            box["minY"] = min(box["minY"], point["y"])
            box["maxY"] = max(box["maxY"], point["y"])
        else:
            cell.append({
                "xy": point["xy"], "sub": sub, "first": index,
                "minX": point["x"], "maxX": point["x"],
                "minY": point["y"], "maxY": point["y"],
            })

    warning = None
    if error is None and tile_count > 1:
        width = (max(p["x"] for p in points) - min(p["x"] for p in points)
                 + size_x)
        height = (max(p["y"] for p in points) - min(p["y"] for p in points)
                  + size_y)
        coverage = tile_count * size_x * size_y / (width * height)
        if coverage < SPARSE_COVERAGE_FRACTION:
            warning = (
                "The %d tiles cover only %d%% of the %d \u00d7 %d px "
                "composite, so they look like separate regions (for "
                "example, different wells). Consider leaving Composite off "
                "to keep them as separate XY positions." % (
                    tile_count, js_math_round(coverage * 100),
                    js_math_round(width), js_math_round(height),
                )
            )
    return {
        "error": error, "warning": warning,
        "tileCount": tile_count if error is None else None,
    }


def compositing_refusal(result, enable_compositing):
    """Port of the component's ``compositingRefusal``: the reason a
    requested composite is refused (a duplicate stage position), or None.
    It ranks after the dtype and assignment errors, as in ``submitError``,
    and turns a request into a failure rather than a quiet fallback to
    separate XY positions, which cannot be redone."""
    if not enable_compositing:
        return None
    return result["compositingCheck"]["error"]


def composite_transcode_default(transcode_default, compositing, tile_count):
    """Port of ``compositeTranscodeDefault``: transcode by default when
    compositing many tiles (composited positions, from many files or one
    multi-position file), whose zoomed-out views otherwise read every
    source."""
    return transcode_default or (
        compositing
        and (tile_count or 0) > COMPOSITE_TRANSCODE_TILE_THRESHOLD
    )


def generate_multi_source_config(item_names, tiles_metadata,
                                 internal_metadata, assignments, *,
                                 split_rgb_bands, enable_compositing,
                                 is_rgb_file, rgb_band_count):
    """Port of ``generateJson``.

    Returns ``{'config': {...}, 'dimensionLabels': {...}}``.
    """
    is_multiband_rgb = is_rgb_file and rgb_band_count > 1

    channels = _channels_from_assignment(assignments.get("C"))

    # Dimension labels are computed BEFORE RGB expansion.
    xy_labels = _extract_dimension_labels(assignments, internal_metadata,
                                          "XY")
    z_labels = _extract_dimension_labels(assignments, internal_metadata, "Z")
    t_labels = _extract_dimension_labels(assignments, internal_metadata, "T")

    if is_multiband_rgb and split_rgb_bands:
        band_suffixes = [" - Red", " - Green", " - Blue"]
        expanded = []
        for channel in channels:
            for band in range(rgb_band_count):
                suffix = band_suffixes[band] if band < 3 \
                    else "_band%d" % band
                expanded.append(channel + suffix)
        channels = expanded

    xy_assignment = assignments.get("XY")
    can_do_compositing = _can_composite(
        tiles_metadata, internal_metadata,
        xy_assignment["size"] if xy_assignment else 0,
    )

    def value(dim, item_idx, frame_idx):
        return _value_from_assignments(
            assignments, item_names, dim, item_idx, frame_idx,
        )

    check = {"error": None, "warning": None, "tileCount": None}
    layout = None
    if can_do_compositing:
        layout = _compositing_positions(tiles_metadata, internal_metadata)
        check = compositing_check(
            item_names, tiles_metadata, layout,
            lambda item_idx, frame_idx: value("XY", item_idx, frame_idx),
        )
    should_composite = (
        can_do_compositing and enable_compositing and check["error"] is None
    )

    sources = []

    if should_composite:
        final_coordinates, item_offsets, _tile_size = layout
        for item_idx in range(len(item_names)):
            name = item_names[item_idx]
            n_frames = _frame_count(tiles_metadata[item_idx])
            item_sources = []
            if is_multiband_rgb and split_rgb_bands:
                for frame_idx in range(n_frames):
                    for band_idx in range(rgb_band_count):
                        item_sources.append({
                            "path": name,
                            "xySet": value("XY", item_idx, frame_idx),
                            "zSet": value("Z", item_idx, frame_idx),
                            "tSet": value("T", item_idx, frame_idx),
                            "cSet": band_idx,
                            "frames": [frame_idx],
                            "style": {"bands": [{"band": band_idx + 1}]},
                        })
            else:
                for frame_idx in range(n_frames):
                    item_sources.append({
                        "path": name,
                        "xySet": value("XY", item_idx, frame_idx),
                        "zSet": value("Z", item_idx, frame_idx),
                        "tSet": value("T", item_idx, frame_idx),
                        "cSet": value("C", item_idx, frame_idx),
                        "frames": [frame_idx],
                    })

            # Each source takes its own file's stage position, and xySet
            # collapses to the single composited position.
            for source in item_sources:
                source["position"] = final_coordinates[
                    item_offsets[item_idx]
                    + _compositing_frame_metadata_index(
                        tiles_metadata[item_idx], source["frames"][0],
                    )
                ]
                source["xySet"] = 0
            sources.extend(item_sources)
    else:
        for item_idx in range(len(item_names)):
            name = item_names[item_idx]
            if is_multiband_rgb and split_rgb_bands:
                n_frames = (
                    len(tiles_metadata[item_idx].get("frames") or []) or 1
                )
                for frame_idx in range(n_frames):
                    for band_idx in range(rgb_band_count):
                        sources.append({
                            "path": name,
                            "style": {"bands": [{"band": band_idx + 1}]},
                            "c": band_idx,
                            "tValues": [value("T", item_idx, frame_idx)],
                            "zValues": [value("Z", item_idx, frame_idx)],
                            "xyValues": [value("XY", item_idx, frame_idx)],
                        })
            else:
                frames_as_axes = {}
                dim_values = {}
                for dim in UP_DIMS:
                    assignment = assignments.get(dim)
                    if not assignment:
                        continue
                    low = dim.lower()
                    dim_value = 0
                    source_kind = assignment["source"]
                    if source_kind == "file":
                        frames_as_axes[low] = \
                            assignment["data"][item_idx]["stride"]
                    elif source_kind == "filename":
                        dim_value = assignment["data"][
                            "valueIdxPerFilename"][name]
                    elif source_kind == "images":
                        frames_as_axes[low] = 1
                    dim_values[low] = dim_value

                new_source = {"path": name, "framesAsAxes": frames_as_axes}
                for low, dim_value in dim_values.items():
                    new_source["%sValues" % low] = [dim_value]
                sources.append(new_source)

    config = {
        "channels": channels,
        "sources": sources,
        "uniformSources": True,
        "singleBand": is_multiband_rgb,
    }
    # A composite has one XY position, so per-tile XY labels would name the
    # whole mosaic after its first tile.
    dimension_labels = {
        "xy": None if should_composite else xy_labels,
        "z": z_labels, "t": t_labels,
    }
    # `compositing` is not just an echo of the request: the sources are
    # laid out by stage position and every xySet is forced to 0, so the
    # resulting image has ONE xy position regardless of the assignment's
    # size. Callers describing the dataset's extent need to know.
    return {
        "config": config,
        "dimensionLabels": dimension_labels,
        "compositing": should_composite,
        "compositingCheck": check,
    }


def _assignment_summary(assignment):
    if assignment is None:
        return None
    return {
        "source": assignment["source"],
        "guess": assignment["guess"],
        "name": assignment["name"],
        "size": assignment["size"],
    }


def compute_configuration(item_names, tiles_metadata, internal_metadata, *,
                          strategy=None, split_rgb_bands=True,
                          enable_compositing=False):
    """Chain the pipeline: build dimensions, resolve assignments (defaults
    or an explicit strategy) and generate the config + labels.

    Returns a dict with ``config``, ``dimensionLabels``, ``compositing``
    (whether the sources were actually composited, which collapses xy to a
    single position), ``compositingCheck`` (``{error, warning}`` about the
    stage layout whenever compositing is possible, requested or not; an
    error refuses compositing), ``variables`` (the dimensions),
    ``assignments`` (summaries), ``transcodeDefault`` (also on when
    compositing more than ``COMPOSITE_TRANSCODE_TILE_THRESHOLD`` tiles),
    ``isRGBFile`` and ``rgbBandCount``.
    """
    built = build_dimensions(item_names, tiles_metadata)
    dimensions = built["dimensions"]
    is_rgb_file = built["isRGBFile"]
    rgb_band_count = built["rgbBandCount"]

    if strategy is None:
        assignments = get_default_assignments(dimensions)
    else:
        assignments = apply_assignment_strategy(dimensions, strategy)

    generated = generate_multi_source_config(
        item_names, tiles_metadata, internal_metadata, assignments,
        split_rgb_bands=split_rgb_bands,
        enable_compositing=enable_compositing,
        is_rgb_file=is_rgb_file,
        rgb_band_count=rgb_band_count,
    )

    return {
        "config": generated["config"],
        "dimensionLabels": generated["dimensionLabels"],
        "compositing": generated["compositing"],
        "compositingCheck": generated["compositingCheck"],
        "variables": dimensions,
        "assignments": {
            dim: _assignment_summary(assignments.get(dim))
            for dim in UP_DIMS
        },
        "transcodeDefault": composite_transcode_default(
            built["transcodeDefault"], generated["compositing"],
            generated["compositingCheck"]["tileCount"],
        ),
        "isRGBFile": is_rgb_file,
        "rgbBandCount": rgb_band_count,
    }

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
from decimal import Decimal, ROUND_HALF_UP

UP_DIMS = ("XY", "Z", "T", "C")

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
    if x != x or x in (float("inf"), float("-inf")):
        return 0
    n = int(math.trunc(x)) & 0xFFFFFFFF
    if n >= 0x80000000:
        n -= 0x100000000
    return n


def js_math_round(x):
    """JS ``Math.round(x)``: round half toward +infinity, returns int."""
    if x != x:
        return 0
    return math.floor(x + 0.5)


def js_to_fixed(x, digits):
    """JS ``Number.prototype.toFixed(digits)``.

    Rounds the exact double value half away from zero (matching V8) and
    preserves the sign of a value that rounds to ``-0``.
    """
    if x != x:
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
_TRIM_TRAILING = None


def _trim_trailing_zeros(text):
    global _TRIM_TRAILING
    if _TRIM_TRAILING is None:
        import re
        _TRIM_TRAILING = re.compile(r"(?:\.0+|(\.\d*?[1-9])0+)$")
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
    return isinstance(value, (int, float)) and not (
        isinstance(value, float)
        and (value != value or value in (float("inf"), float("-inf")))
    )


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
    step_um = params.get("stepUm")
    if step_um is None:
        step_um = 0
    step_um = float(step_um)
    if step_um != step_um:  # NaN -> 0 (JS `|| 0`)
        step_um = 0.0

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

    if photo is None:
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


def _channels_from_assignment(assignment, rgb_band_count_unused=None):
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
    ``chan.volume !== undefined ? chan.volume : chan[0].volume``."""
    channels = nd2.get("channels")
    if not channels:
        return None
    if isinstance(channels, dict) and channels.get("volume") is not None:
        volume = channels["volume"]
    else:
        volume = channels[0]["volume"]
    return volume.get("cameraTransformationMatrix")


def _compositing_positions(tiles_metadata, internal_metadata, channels):
    """Compute ``finalCoordinates`` for the compositing path."""
    first_tile = tiles_metadata[0]
    mm_x = first_tile["mm_x"]
    mm_y = first_tile["mm_y"]
    size_x = first_tile["sizeX"]
    size_y = first_tile["sizeY"]
    frames_metadata = internal_metadata[0]["nd2_frame_metadata"]
    nd2 = internal_metadata[0].get("nd2")

    coordinates = []
    for frame in frames_metadata:
        stage = frame["position"]["stagePositionUm"]
        pos = {
            "x": stage[0] / (mm_x * 1000),
            "y": stage[1] / (mm_y * 1000),
            "s11": 1, "s12": 0, "s21": 0, "s22": 1,
        }
        if nd2 and nd2.get("channels"):
            matrix = _camera_matrix_source(nd2)
            if matrix and (abs(matrix[0] - 1) > 0.01
                           or abs(matrix[3] - 1) > 0.01):
                if abs(matrix[0] + 1) < 0.01 and abs(matrix[3] + 1) < 0.01:
                    pos["s11"], pos["s12"] = -1.0, 0.0
                    pos["s21"], pos["s22"] = 0.0, -1.0
                else:
                    pos["s11"], pos["s12"] = matrix[0], matrix[1]
                    pos["s21"], pos["s22"] = matrix[2], matrix[3]
        coordinates.append(pos)

    corners = [
        {"x": 0, "y": 0}, {"x": size_x, "y": 0},
        {"x": 0, "y": size_y}, {"x": size_x, "y": size_y},
    ]
    first = coordinates[0] if coordinates else {}
    s11 = first.get("s11", 1)
    s12 = first.get("s12", 0)
    s21 = first.get("s21", 0)
    s22 = first.get("s22", 1)
    transformed = [
        {
            "x": s11 * corner["x"] + s12 * corner["y"],
            "y": s21 * corner["x"] + s22 * corner["y"],
        }
        for corner in corners
    ]
    offset_min = {
        "x": min(c["x"] for c in transformed),
        "y": min(c["y"] for c in transformed),
    }
    offset_max = {
        "x": max(c["x"] for c in transformed),
        "y": max(c["y"] for c in transformed),
    }
    min_coordinate = {
        "x": min(c["x"] for c in coordinates) + offset_min["x"],
        "y": min(c["y"] for c in coordinates) - offset_max["y"],
    }
    max_coordinate = {
        "x": max(c["x"] for c in coordinates) + offset_max["x"],
        "y": max(c["y"] for c in coordinates) - offset_min["y"],
    }
    return [
        {
            "x": js_math_round(c["x"] - min_coordinate["x"]),
            "y": js_math_round(max_coordinate["y"] - c["y"]),
            "s11": c["s11"], "s12": c["s12"],
            "s21": c["s21"], "s22": c["s22"],
        }
        for c in coordinates
    ]


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

    can_do_compositing = (
        len(internal_metadata) == 1
        and _truthy(internal_metadata[0].get("nd2_frame_metadata"))
        and len(tiles_metadata) == 1
    )
    should_composite = can_do_compositing and enable_compositing

    sources = []

    def value(dim, item_idx, frame_idx):
        return _value_from_assignments(
            assignments, item_names, dim, item_idx, frame_idx,
        )

    if should_composite:
        for item_idx in range(len(item_names)):
            name = item_names[item_idx]
            n_frames = len(tiles_metadata[item_idx].get("frames") or []) or 1
            if is_multiband_rgb and split_rgb_bands:
                for frame_idx in range(n_frames):
                    for band_idx in range(rgb_band_count):
                        sources.append({
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
                    sources.append({
                        "path": name,
                        "xySet": value("XY", item_idx, frame_idx),
                        "zSet": value("Z", item_idx, frame_idx),
                        "tSet": value("T", item_idx, frame_idx),
                        "cSet": value("C", item_idx, frame_idx),
                        "frames": [frame_idx],
                    })

        final_coordinates = _compositing_positions(
            tiles_metadata, internal_metadata, channels,
        )
        for source_idx, source in enumerate(sources):
            source["position"] = final_coordinates[
                math.floor(source_idx / len(channels))
            ]
            source["xySet"] = 0
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
    dimension_labels = {"xy": xy_labels, "z": z_labels, "t": t_labels}
    return {"config": config, "dimensionLabels": dimension_labels}


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

    Returns a dict with ``config``, ``dimensionLabels``, ``variables``
    (the dimensions), ``assignments`` (summaries), ``transcodeDefault``,
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
        "variables": dimensions,
        "assignments": {
            dim: _assignment_summary(assignments.get(dim))
            for dim in UP_DIMS
        },
        "transcodeDefault": built["transcodeDefault"],
        "isRGBFile": is_rgb_file,
        "rgbBandCount": rgb_band_count,
    }

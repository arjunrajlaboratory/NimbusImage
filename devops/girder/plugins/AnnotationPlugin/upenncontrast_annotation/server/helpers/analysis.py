"""Pure gating maths for the Analysis panel's server-side resolution.

This is the Python half of a two-implementation feature: the TypeScript
client (``src/utils/analysisGating.ts``) resolves gates below the plot cap
and this module resolves them above it. The two MUST agree bit-for-bit —
a dataset that grows past the cap must not change gate membership by
switching resolvers. Parity is pinned by
``test/fixtures/analysis_gating_parity.json``, generated from the TS
reference implementation; ``test_analysis_gating.py`` asserts against it.

Everything here is pure: no girder imports, no HTTP concerns, no database.
Domain errors raise ValueError (the API layer maps them to 400s). See
``codebaseDocumentation/SERVER_GATING.md`` for the semantics, in particular
"a gate is a pure predicate" and "unknown categories are outside the gate".
"""

import json
import math

import numpy as np

# Salts keeping the two axes' jitter independent. Mirrors analysisGating.ts.
X_JITTER_SALT = 17
Y_JITTER_SALT = 31

CATEGORY_KEY_PREFIX = "v1:"

CATEGORICAL_KEYS = ("tags", "shape", "channel", "xy", "z", "time")

# Ceiling on total histogram cells. A categorical axis gets one bin per
# category rather than a clamped bin count, so without this a request (or
# merely a dataset where every annotation carries a distinct tag) could ask
# for a 10,000 x 10,000 grid — 800 MB of float64 plus 100M Python ints to
# serialize, on a PUBLIC endpoint. Set to the budget the numeric cap already
# permits (MAX_HISTOGRAM_BINS squared), so no request can allocate more than
# a numeric plot already could.
MAX_HISTOGRAM_CELLS = 512 * 512

# Per-axis ceiling on categories, enforced independently of the cell budget.
# A product-only check lets one axis carry MAX_HISTOGRAM_CELLS categories
# whenever the other collapses to a single bin — and the cost is not just
# server memory: every category is returned and the client installs each as
# an explicit Plotly tick (AnalysisScatterPlot's axisLayout), so a
# distinct-tag dataset plotted against a constant property could ship
# hundreds of thousands of labels and lock the browser. 512 matches the
# numeric per-axis bin cap and is already far past readable.
MAX_HISTOGRAM_AXIS_CATEGORIES = 512


def _utf16_units(value):
    """The string as UTF-16 code units, exactly what charCodeAt iterates."""
    encoded = value.encode("utf-16-le")
    return [
        int.from_bytes(encoded[i:i + 2], "little")
        for i in range(0, len(encoded), 2)
    ]


def jitter_from_id(annotation_id, salt):
    """Bit-exact port of jitterFromId (analysisGating.ts).

    JS runs ``(h * 31 + charCode) | 0`` in signed 32-bit and finally
    ``h >>> 0``; keeping the value reduced mod 2**32 unsigned is the same
    bits. The final expression is IEEE-754 double math in both languages.
    """
    h = salt & 0xFFFFFFFF
    for unit in _utf16_units(annotation_id):
        h = (h * 31 + unit) & 0xFFFFFFFF
    return ((h % 1000) / 1000 - 0.5) * 0.56


def _code_unit_matrix(annotation_ids):
    """(codes, mask) UTF-16 code units per id, right-padded.

    Fast path for the overwhelmingly common case — every id the same length
    and pure BMP (24-char hex ObjectIds) — decodes the whole batch in one
    frombuffer instead of a Python loop per id. At 700K ids that is the
    difference between ~1.9s and ~0.2s, and it runs on every gate refresh.
    """
    count = len(annotation_ids)
    lengths = {len(i) for i in annotation_ids}
    if len(lengths) == 1:
        length = lengths.pop()
        joined = "".join(annotation_ids)
        units = np.frombuffer(joined.encode("utf-16-le"), dtype=np.uint16)
        if units.size == count * length:  # no surrogate pairs
            codes = units.reshape(count, length).astype(np.uint32)
            return codes, np.ones((count, max(length, 1)), dtype=bool)
    rows = [_utf16_units(annotation_id) for annotation_id in annotation_ids]
    width = max((len(r) for r in rows), default=0)
    codes = np.zeros((count, max(width, 1)), dtype=np.uint32)
    mask = np.zeros((count, max(width, 1)), dtype=bool)
    for row, rowUnits in enumerate(rows):
        if rowUnits:
            codes[row, : len(rowUnits)] = rowUnits
            mask[row, : len(rowUnits)] = True
    return codes, mask


def jitter_from_ids(annotation_ids, salt):
    """Vectorized jitter_from_id over many ids (float64 ndarray)."""
    if not annotation_ids:
        return np.empty(0, dtype=np.float64)
    codes, mask = _code_unit_matrix(annotation_ids)
    h = np.full(len(annotation_ids), salt & 0xFFFFFFFF, dtype=np.uint32)
    allSet = mask.all()
    for col in range(codes.shape[1]):
        step = h * np.uint32(31) + codes[:, col]
        h = step if allSet else np.where(mask[:, col], step, h)
    return ((h % 1000) / 1000.0 - 0.5) * 0.56


def utf16_sort_key(value):
    """Sort key matching JS Array.prototype.sort's UTF-16 comparison."""
    return _utf16_units(value)


def sort_tags(tags):
    """Tags in the order the client sorts them before encoding."""
    return sorted(tags, key=utf16_sort_key)


def encode_category_key(raw):
    """Port of encodeAnalysisCategoryKey: 'v1:' + JSON.stringify(raw).

    ``ensure_ascii=False`` is load-bearing: JSON.stringify emits non-ASCII
    characters raw, and an escaped key would never match a client key.
    """
    return CATEGORY_KEY_PREFIX + json.dumps(
        raw, separators=(",", ":"), ensure_ascii=False
    )


def categorical_raw_identity(doc, key):
    """The raw category identity of one annotation doc for one axis key.

    Every field is read defensively. `locationSchema` declares XY/Z/Time
    without a `required` list, so `POST /upenn_annotation` with
    `"location": {}` is a valid write — and indexing it raised KeyError, an
    uncaught 500 on the three public endpoints that gate (including `/list`,
    which breaks every page of the Objects tab, not just the panel).
    Missing reads `None`, which encodes to `"v1:null"` and matches the
    client's coercion in analysisGating.ts (the two must agree bit-exactly
    or those annotations silently drop out of a server-resolved gate).
    """
    if key == "tags":
        return sort_tags(doc.get("tags") or [])
    if key == "shape":
        return doc.get("shape")
    if key == "channel":
        return doc.get("channel")
    location = doc.get("location") or {}
    if key == "xy":
        return location.get("XY")
    if key == "z":
        return location.get("Z")
    if key == "time":
        return location.get("Time")
    raise ValueError("unknown categorical key: %s" % key)


def _category_key_encoder(key):
    """encode_category_key for one axis, memoized by raw identity.

    A dataset has a handful of distinct categories and hundreds of
    thousands of annotations, so encoding per annotation ran json.dumps
    700K times (~1s per axis per refresh) to produce a few distinct
    strings. The memo collapses that to one call per category.
    """
    cache = {}

    def encode(doc):
        raw = categorical_raw_identity(doc, key)
        # Lists are unhashable; tags are the only list-valued identity.
        memoKey = tuple(raw) if isinstance(raw, list) else raw
        # Guard the (int 0 / bool False / str) namespace collision that a
        # bare dict key would conflate.
        memoKey = (type(memoKey).__name__, memoKey)
        encoded = cache.get(memoKey)
        if encoded is None:
            encoded = encode_category_key(raw)
            cache[memoKey] = encoded
        return encoded

    return encode


def _property_value(values, path):
    """Walk a nested values document; None when the path has no number.

    Mirrors rawAxisValue: only finite numbers count, and bool is not a
    number (Python-only trap — isinstance(True, int) is True).
    """
    node = values
    for part in path:
        if not isinstance(node, dict) or part not in node:
            return None
        node = node[part]
    if isinstance(node, bool) or not isinstance(node, (int, float)):
        return None
    if not math.isfinite(node):
        return None
    return float(node)


def axis_coordinates(docs, values_by_id, axis, categories, salt):
    """Per-annotation plot coordinates for one axis (NaN = no coordinate).

    ``categories`` is the gate's pinned order for a categorical axis (a
    category outside it yields NaN — "unknown categories are outside the
    gate"), and None for a property axis.
    """
    coords = np.full(len(docs), np.nan, dtype=np.float64)
    if axis["type"] == "property":
        path = axis["path"]
        for i, doc in enumerate(docs):
            value = _property_value(values_by_id.get(doc["id"]) or {}, path)
            if value is not None:
                coords[i] = value
        return coords
    index_of = {key: i for i, key in enumerate(categories or [])}
    encode = _category_key_encoder(axis["key"])
    known = []
    for i, doc in enumerate(docs):
        index = index_of.get(encode(doc))
        if index is not None:
            coords[i] = index
            known.append(i)
    if known:
        jitters = jitter_from_ids([docs[i]["id"] for i in known], salt)
        coords[known] += jitters
    return coords


def points_in_polygon(xs, ys, vertices):
    """Vectorized even-odd ray cast, the exact isPointInPolygon algorithm.

    NaN coordinates never match (every comparison with NaN is False).
    Fewer than 3 vertices bounds no area and matches nothing.
    """
    inside = np.zeros(len(xs), dtype=bool)
    count = len(vertices)
    if count < 3:
        return inside
    j = count - 1
    for i in range(count):
        xi = float(vertices[i]["x"])
        yi = float(vertices[i]["y"])
        xj = float(vertices[j]["x"])
        yj = float(vertices[j]["y"])
        crosses = (yi > ys) != (yj > ys)
        with np.errstate(divide="ignore", invalid="ignore"):
            xint = (xj - xi) * (ys - yi) / (yj - yi) + xi
            inside ^= crosses & (xs < xint)
        j = i
    return inside


def derive_axis_categories(docs, key, pinned, name):
    """The display category order for one categorical axis.

    Pinned order first (a gate's coordinate space), then categories present
    in `docs` but unknown to it, appended in deterministic UTF-16 key order.
    Appended categories are display-only — a gate never contains them.

    The cap is enforced HERE, as the set accumulates, rather than by the
    caller once the list is built: the count can come from the data (a
    dataset where every annotation carries a distinct tag yields one
    category per annotation), so checking afterwards meant materializing
    hundreds of MB before returning the 400 that says it was too big.
    """
    known = list(pinned or [])
    distinct = set(known)
    if len(distinct) > MAX_HISTOGRAM_AXIS_CATEGORIES:
        raise ValueError(
            "%s axis has %d distinct categories, over the maximum of %d; it "
            "cannot be plotted as a categorical axis"
            % (name, len(distinct), MAX_HISTOGRAM_AXIS_CATEGORIES)
        )
    # Memoized by raw identity: a dataset has a handful of categories and
    # hundreds of thousands of annotations, and encoding per document ran
    # json.dumps once per annotation (~1s per axis per request) to produce a
    # few distinct strings.
    encode = _category_key_encoder(key)
    for doc in docs:
        distinct.add(encode(doc))
        if len(distinct) > MAX_HISTOGRAM_AXIS_CATEGORIES:
            raise ValueError(
                "%s axis has more than the maximum of %d distinct "
                "categories; it cannot be plotted as a categorical axis"
                % (name, MAX_HISTOGRAM_AXIS_CATEGORIES)
            )
    return known + sorted(distinct - set(known), key=utf16_sort_key)


def _numeric_bin_spec(paired_coords, requested_bins):
    """(bins, range) for a numeric axis over the paired-valid coordinates.

    Degenerate cases collapse to one bin: no data (range is arbitrary) and a
    single distinct value (min == max would make histogram2d divide by zero).
    """
    if len(paired_coords) == 0:
        return 1, (0.0, 1.0)
    low = float(paired_coords.min())
    high = float(paired_coords.max())
    if low == high:
        return 1, (low - 0.5, high + 0.5)
    return requested_bins, (low, high)


def histogram2d(docs, values_by_id, spec):
    """Binned 2D counts for one plot's population — display only.

    `spec` carries xAxis/yAxis, optional pinned x/yCategories, clamped
    bins {x, y}, and optionally the plot's own gate (for the chained badge
    count). Rows of `counts` are y bins, columns are x bins.
    """
    x_axis, y_axis = spec["xAxis"], spec["yAxis"]
    # Each derivation enforces MAX_HISTOGRAM_AXIS_CATEGORIES as it goes, so
    # an axis that is too wide raises before the other axis is walked and
    # before any float64 coordinate array is allocated.
    x_categories = (
        derive_axis_categories(
            docs, x_axis["key"], spec.get("xCategories"), "x"
        )
        if x_axis["type"] == "categorical"
        else None
    )
    y_categories = (
        derive_axis_categories(
            docs, y_axis["key"], spec.get("yCategories"), "y"
        )
        if y_axis["type"] == "categorical"
        else None
    )
    xs = axis_coordinates(
        docs, values_by_id, x_axis, x_categories, X_JITTER_SALT
    )
    ys = axis_coordinates(
        docs, values_by_id, y_axis, y_categories, Y_JITTER_SALT
    )
    valid = np.isfinite(xs) & np.isfinite(ys)
    paired_x, paired_y = xs[valid], ys[valid]

    if x_categories is not None:
        x_bins = max(len(x_categories), 1)
        x_range = (-0.5, x_bins - 0.5)
    else:
        x_bins, x_range = _numeric_bin_spec(paired_x, spec["bins"]["x"])
    if y_categories is not None:
        y_bins = max(len(y_categories), 1)
        y_range = (-0.5, y_bins - 0.5)
    else:
        y_bins, y_range = _numeric_bin_spec(paired_y, spec["bins"]["y"])

    # The per-axis cap is enforced inside derive_axis_categories, as the
    # distinct set accumulates. Only the product is left to check here: it
    # bounds the grid two axes can form even when each is individually legal.
    # ValueError, per the layering rule — the API maps it.
    if x_bins * y_bins > MAX_HISTOGRAM_CELLS:
        raise ValueError(
            "histogram grid of %d x %d cells exceeds the maximum of %d; "
            "these axes have too many distinct categories to plot"
            % (x_bins, y_bins, MAX_HISTOGRAM_CELLS)
        )

    counts, x_edges, y_edges = np.histogram2d(
        paired_x, paired_y, bins=[x_bins, y_bins], range=[x_range, y_range]
    )
    response = {
        # Transposed: numpy's first axis is x, plotly heatmap rows are y.
        "counts": [[int(count) for count in row] for row in counts.T],
        "xEdges": x_edges.tolist() if x_categories is None else None,
        "yEdges": y_edges.tolist() if y_categories is None else None,
        "xCategories": x_categories,
        "yCategories": y_categories,
        "inputCount": len(docs),
        "plottedCount": int(valid.sum()),
        "gateCount": None,
    }
    gate = spec.get("gate")
    if gate is not None:
        # Reuse the coordinates just computed rather than re-resolving from
        # the docs: the gate is over the SAME axes, and recomputing meant
        # every histogram paid the coordinate build twice.
        if gate["xCategories"] != spec.get("xCategories") or gate[
            "yCategories"
        ] != spec.get("yCategories"):
            # A gate pinned to a different category order has a different
            # coordinate space; fall back to a full resolve.
            response["gateCount"] = len(
                resolve_gate_ids(
                    docs,
                    values_by_id,
                    {"xAxis": x_axis, "yAxis": y_axis, "gate": gate},
                )
            )
        elif len(gate["vertices"]) < 3:
            response["gateCount"] = 0
        else:
            inside = points_in_polygon(xs, ys, gate["vertices"])
            # The reused coordinates were built from the DERIVED categories
            # (pinned order + categories the dataset has since gained), but a
            # gate only spans its pinned columns — an appended category is
            # display-only and is never inside, however far the polygon
            # reaches. Without this mask the badge over-counts relative to
            # resolve_gate_ids. Same rule, same place as the client's
            # resolveGateIds: jitter is bounded by +/-0.28, so rounding the
            # coordinate recovers the category index exactly.
            for coords, categories, pinned in (
                (xs, x_categories, gate["xCategories"]),
                (ys, y_categories, gate["yCategories"]),
            ):
                if categories is not None and pinned is not None:
                    with np.errstate(invalid="ignore"):
                        inside &= np.rint(coords) < len(pinned)
            response["gateCount"] = int(inside.sum())
    return response


def resolve_gate_ids(docs, values_by_id, plot):
    """Ids of the docs inside one plot's gate — the pure predicate.

    ``plot`` carries xAxis/yAxis/gate exactly as the client persists them
    (vertices in plot space, pinned category orders). Order of the returned
    ids follows ``docs`` order.
    """
    gate = plot["gate"]
    if len(gate["vertices"]) < 3:
        return []
    xs = axis_coordinates(
        docs, values_by_id, plot["xAxis"], gate["xCategories"], X_JITTER_SALT
    )
    ys = axis_coordinates(
        docs, values_by_id, plot["yAxis"], gate["yCategories"], Y_JITTER_SALT
    )
    inside = points_in_polygon(xs, ys, gate["vertices"])
    return [docs[i]["id"] for i in np.flatnonzero(inside)]


def describe_values(values):
    """count/mean/std/min/max of the finite numeric entries of `values`, with
    the selection summary's reading: non-numbers and NaN are missing, `std` is
    the sample standard deviation (None below two values), everything None at
    count 0."""
    numbers = np.array([
        float(value) for value in values
        if isinstance(value, (int, float)) and not isinstance(value, bool)
        and not math.isnan(value)
    ], dtype=np.float64)
    count = int(len(numbers))
    if count == 0:
        return {"count": 0, "mean": None, "std": None,
                "min": None, "max": None}
    return {
        "count": count,
        "mean": float(numbers.mean()),
        "std": float(numbers.std(ddof=1)) if count > 1 else None,
        "min": float(numbers.min()),
        "max": float(numbers.max()),
    }

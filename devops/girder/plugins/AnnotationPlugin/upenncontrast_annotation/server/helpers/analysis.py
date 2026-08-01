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


def jitter_from_ids(annotation_ids, salt):
    """Vectorized jitter_from_id over many ids (float64 ndarray)."""
    if not annotation_ids:
        return np.empty(0, dtype=np.float64)
    units = [_utf16_units(annotation_id) for annotation_id in annotation_ids]
    length = max(len(u) for u in units)
    codes = np.zeros((len(units), max(length, 1)), dtype=np.uint32)
    mask = np.zeros((len(units), max(length, 1)), dtype=bool)
    for row, rowUnits in enumerate(units):
        if rowUnits:
            codes[row, : len(rowUnits)] = rowUnits
            mask[row, : len(rowUnits)] = True
    h = np.full(len(units), salt & 0xFFFFFFFF, dtype=np.uint32)
    for col in range(codes.shape[1]):
        step = h * np.uint32(31) + codes[:, col]
        h = np.where(mask[:, col], step, h)
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
    """The raw category identity of one annotation doc for one axis key."""
    if key == "tags":
        return sort_tags(doc.get("tags") or [])
    if key == "shape":
        return doc["shape"]
    if key == "channel":
        return doc["channel"]
    if key == "xy":
        return doc["location"]["XY"]
    if key == "z":
        return doc["location"]["Z"]
    if key == "time":
        return doc["location"]["Time"]
    raise ValueError("unknown categorical key: %s" % key)


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
    known = []
    for i, doc in enumerate(docs):
        key = encode_category_key(
            categorical_raw_identity(doc, axis["key"])
        )
        index = index_of.get(key)
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

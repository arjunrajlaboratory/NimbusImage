"""Pure-Python helpers for the columnar property-value store.

This module holds the logic that is easy to get subtly wrong -- flattening
the nested per-annotation ``values`` object into leaf columns and back, and
the histogram bucketing that must match Mongo's ``$bucketAuto`` output shape.
It deliberately has **no numpy/zarr dependency** so it can be unit-tested
without the columnar-store extras installed, and so the numeric I/O layer
(``zarrValueStore``) stays a thin wrapper around this.

Leaf-path <-> column-key convention (mirrors the frontend's ``string[]`` path
representation and the Zarr ``var/index``):

    values = {"propA": 3, "propB": {"sub0": 1, "sub1": 2}}
    ->  ("propA",): 3, ("propB", "sub0"): 1, ("propB", "sub1"): 2
    column keys: "propA", "propB/sub0", "propB/sub1"

Property ids and sub-ids never contain ``/`` (they are Mongo ObjectId hex
strings / worker-defined sub-ids), so ``/`` is a safe join separator.
"""

COLUMN_KEY_SEPARATOR = "/"


def flatten_values(values):
    """Flatten a nested per-annotation ``values`` object to leaf columns.

    Returns a dict keyed by leaf path (a tuple of strings) whose values are
    the scalar leaves. Mirrors ``collectLeafPaths`` on the frontend: a dict is
    a branch, everything else (number, string, None, list) is a leaf. An empty
    dict is treated as a leaf with value ``None`` so a present-but-empty
    property still yields a column (matching the frontend walk).
    """
    leaves = {}
    stack = [((), values)]
    while stack:
        path, node = stack.pop()
        if isinstance(node, dict) and node:
            for key, child in node.items():
                stack.append((path + (key,), child))
        else:
            if path:
                leaves[path] = None if isinstance(node, dict) else node
    return leaves


def unflatten_values(flat):
    """Rebuild a nested ``values`` object from a {leaf_path: scalar} map.

    Inverse of :func:`flatten_values` (for non-empty-dict leaves). ``flat``
    maps a tuple path to a scalar; ``None`` scalars are included (a stored null
    is a real value, distinct from an absent column).
    """
    result = {}
    for path, value in flat.items():
        node = result
        for key in path[:-1]:
            node = node.setdefault(key, {})
        node[path[-1]] = value
    return result


def leaf_path_to_key(path):
    """Column key ("propId" or "propId/subId") for a leaf path tuple."""
    return COLUMN_KEY_SEPARATOR.join(path)


def key_to_leaf_path(key):
    """Leaf path tuple for a column key. Inverse of ``leaf_path_to_key``."""
    return tuple(key.split(COLUMN_KEY_SEPARATOR))


def collect_columns(value_docs):
    """Sorted union of leaf column keys across an iterable of value docs.

    Each doc is ``{"annotationId": ..., "values": {...}}``. Returns the column
    keys in a deterministic (lexicographic) order so the stored ``var/index``
    is stable across builds -- ``flatten_values`` walks with a stack and so
    does not preserve document key order, and a stable index is worth more than
    an arbitrary insertion order. Column lookups are by key, not position, so
    the ordering is purely for reproducibility. Structure is homogeneous across
    a dataset, but a partially-computed dataset can have docs missing some
    columns, so every doc is scanned.
    """
    seen = set()
    for doc in value_docs:
        for path in flatten_values(doc.get("values") or {}):
            seen.add(leaf_path_to_key(path))
    return sorted(seen)


def bucket_auto(values, buckets):
    """Approximate Mongo ``$bucketAuto`` over a list of numeric ``values``.

    Returns ``[{"min": lo, "max": hi, "count": n}, ...]`` with contiguous,
    non-overlapping buckets spanning the data range, matching the response
    shape of the existing Mongo ``histogram`` endpoint so the reader is a
    drop-in. ``None``/non-numeric entries are dropped by the caller before this
    is called. An empty input yields ``[]``.

    Like ``$bucketAuto``, buckets are equi-count where possible; ties on the
    boundary value collapse buckets, so fewer than ``buckets`` may be returned.
    """
    nums = sorted(v for v in values if isinstance(v, (int, float)))
    n = len(nums)
    if n == 0 or buckets < 1:
        return []
    result = []
    start = 0
    remaining_buckets = buckets
    while start < n:
        remaining = n - start
        size = -(-remaining // remaining_buckets)  # ceil division
        end = start + size
        # Extend the bucket over any run of the boundary value so equal values
        # never straddle two buckets (matches $bucketAuto tie handling).
        boundary = nums[end - 1]
        while end < n and nums[end] == boundary:
            end += 1
        result.append({
            "min": nums[start],
            "max": nums[end - 1],
            "count": end - start,
        })
        start = end
        remaining_buckets -= 1
        if remaining_buckets < 1:
            remaining_buckets = 1
    return result


def passes_property_filter(value, property_filter):
    """Whether a single scalar ``value`` passes one property filter.

    ``property_filter`` is ``{"path", "mode", "min"?, "max"?, "values"?}`` --
    the same shape the frontend sends and Mongo's ``_propertyFilterStages``
    consumes. A missing value (``None``) never passes (mirrors Mongo, where an
    absent field matches no ``$gte/$lte/$in``). An all-empty range/values
    filter is a no-op and passes everything (callers should have dropped these
    via ``dropNoOpPropertyFilters``, but be defensive).
    """
    if property_filter.get("mode") == "values":
        allowed = property_filter.get("values") or []
        if not allowed:
            return True
        return value in allowed
    lo = property_filter.get("min")
    hi = property_filter.get("max")
    if lo is None and hi is None:
        return True
    if value is None or not isinstance(value, (int, float)):
        return False
    if lo is not None and value < lo:
        return False
    if hi is not None and value > hi:
        return False
    return True

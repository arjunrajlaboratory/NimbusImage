"""Zarr columnar store for annotation property values (AnnData layout).

This is the numeric I/O layer of the columnar property-value store described in
``codebaseDocumentation/PROPERTY_VALUE_SCALING.md`` (Phase 3). It builds an
AnnData-compatible Zarr group from the Mongo value docs and serves the three
read shapes the existing endpoints need -- a projected row batch, a per-column
histogram, and the ids passing a set of property filters -- without ever
materializing the whole matrix in memory for the column-oriented paths.

Layout (per dataset), directly ``anndata.read_zarr``-able::

    <base>/<datasetId>.zarr
        X            csc_matrix   (obs x var) numeric values
        obs/index    str[obs]     annotation ids, row order
        var/index    str[var]     column keys ("propId" or "propId/subId")
        uns/nimbus_meta  {generation, schema}

obs = annotations, var = properties, X = values -- so a scientist can
``anndata.read_zarr(path)`` / ``scanpy`` the result directly.

**Dependency + validation note.** ``anndata``/``zarr``/``numpy``/``scipy`` are
optional extras (see setup.py ``columnar`` extra). Imports are guarded so the
plugin loads without them; :func:`require_backend` raises a clear error if a
columnar-store operation is attempted before the extras are installed (i.e.
before the girder container is rebuilt). This module's numeric paths are
covered by ``test/test_zarr_value_store.py``, which skips when the extras are
absent -- run ``tox`` inside the rebuilt container to validate end to end.
"""

import os

from .valueMatrix import (
    bucket_auto,
    collect_columns,
    flatten_values,
    key_to_leaf_path,
    leaf_path_to_key,
    passes_property_filter,
    unflatten_values,
)

# Where dataset stores live. Defaults under the assetstore volume (the only
# writable host-backed path in the girder container); overridable for tests /
# alternate deployments.
STORE_BASE_ENV = "NIMBUS_VALUE_STORE_PATH"
DEFAULT_STORE_BASE = "/assetstore/nimbus-value-store"

SCHEMA_VERSION = 1

# Import the numeric stack lazily so the plugin loads without the extras.
try:
    import numpy as np
    import anndata as ad
    import zarr
    from scipy import sparse

    _HAVE_BACKEND = True
except ImportError:  # pragma: no cover - exercised only without the extras
    np = None
    ad = None
    zarr = None
    sparse = None
    _HAVE_BACKEND = False


def backend_available():
    """Whether the columnar-store numeric extras are importable."""
    return _HAVE_BACKEND


def require_backend():
    """Raise a clear error if the columnar-store extras are not installed."""
    if not _HAVE_BACKEND:
        raise RuntimeError(
            "Columnar property-value store requires the 'columnar' extras "
            "(anndata, zarr, numpy, scipy). Rebuild the girder container "
            "after adding them to the plugin dependencies."
        )


def store_base():
    return os.environ.get(STORE_BASE_ENV, DEFAULT_STORE_BASE)


def store_path(dataset_id):
    """Filesystem path of the Zarr group for a dataset id."""
    return os.path.join(store_base(), "%s.zarr" % str(dataset_id))


def store_exists(dataset_id):
    return os.path.isdir(store_path(dataset_id))


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

def build_store(dataset_id, value_docs, generation):
    """Build (overwrite) the Zarr store for a dataset from its value docs.

    ``value_docs`` is an iterable of ``{"annotationId", "values"}`` dicts (the
    Mongo documents). Returns ``(rows, columns)``. The matrix is stored CSC so
    per-column reads (histogram/filter/sort) are cheap; missing values are
    implicit zeros in the sparse matrix and are distinguished from real zeros
    by a companion presence mask (see ``_column_values``).

    **First cut is numeric-only.** Non-numeric leaves (strings, nulls, bools)
    are not written to ``X`` -- datasets that carry string-valued properties
    keep those served from Mongo (see PROPERTY_VALUE_SCALING.md; strings are
    rare among computed properties and are a documented follow-up). The count
    of skipped non-numeric leaves is recorded in ``uns.nimbus_meta`` so the
    caller can judge whether a dataset is a good Zarr candidate.

    The whole dataset is read once to assemble the matrix. For the very large
    datasets this store targets, this runs in a background job (see
    ``helpers/zarr_value_job.py``).
    """
    require_backend()

    docs = list(value_docs)
    obs_index = [str(doc["annotationId"]) for doc in docs]
    columns = collect_columns(docs)
    col_pos = {key: j for j, key in enumerate(columns)}

    n_rows = len(obs_index)
    n_cols = len(columns)

    # COO triplets for the numeric matrix plus a parallel presence mask. The
    # mask (all ones) is the authoritative present-set: a real stored 0.0 must
    # survive even if write canonicalization drops explicit zeros from X, so
    # reads take the pattern from the mask and the value from X (defaulting a
    # mask-present, X-absent cell to 0.0). See _column_values.
    rows_idx = []
    cols_idx = []
    data = []
    skipped_non_numeric = 0
    for i, doc in enumerate(docs):
        for path, value in flatten_values(doc.get("values") or {}).items():
            # bool is an int subclass; exclude it so True/False is not silently
            # coerced to 1.0/0.0.
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                skipped_non_numeric += 1
                continue
            rows_idx.append(i)
            cols_idx.append(col_pos[leaf_path_to_key(path)])
            data.append(float(value))

    coo_rows = np.array(rows_idx, dtype="int64")
    coo_cols = np.array(cols_idx, dtype="int64")
    x = sparse.csc_matrix(
        (np.array(data, dtype="float64"), (coo_rows, coo_cols)),
        shape=(n_rows, n_cols),
    )
    present = sparse.csc_matrix(
        (np.ones(len(data), dtype="int8"), (coo_rows, coo_cols)),
        shape=(n_rows, n_cols),
    )

    adata = ad.AnnData(X=x)
    adata.obs_names = obs_index if n_rows else []
    adata.var_names = columns if n_cols else []
    adata.layers["present"] = present
    adata.uns["nimbus_meta"] = {
        "generation": int(generation),
        "schema": SCHEMA_VERSION,
        "skipped_non_numeric": int(skipped_non_numeric),
    }

    path = store_path(dataset_id)
    _rmtree(path)
    _ensure_dir(store_base())
    adata.write_zarr(path)
    return n_rows, n_cols


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------

def _open(dataset_id):
    require_backend()
    return zarr.open_group(store_path(dataset_id), mode="r")


def _read_str_index(group, which):
    # AnnData writes obs/var indices under the dataframe's index key. Read the
    # names array back as python strings.
    node = group[which]
    index_key = node.attrs.get("_index", "_index")
    return [str(v) for v in node[index_key][:]]


def _csc_column(node, j):
    """(rows, vals) for column ``j`` of a CSC zarr node (X or a layer).

    Reads only the column's slice of the CSC arrays -- O(nnz in column), not
    O(matrix).
    """
    indptr = node["indptr"]
    start = int(indptr[j])
    end = int(indptr[j + 1])
    if end <= start:
        return [], []
    rows = [int(r) for r in node["indices"][start:end]]
    vals = [v for v in node["data"][start:end]]
    return rows, vals


def _column_values(group, j):
    """(row_indices, values) of the *present* entries for column ``j``.

    The ``present`` mask layer (all ones) is the authoritative present-set, so
    a real stored 0.0 is not lost even if write canonicalization dropped
    explicit zeros from ``X``. Values come from ``X``; a row present in the
    mask but absent from ``X`` (its 0.0 was eliminated) resolves to 0.0.
    """
    mask_rows, _ = _csc_column(group["layers"]["present"], j)
    if not mask_rows:
        return [], []
    x_rows, x_vals = _csc_column(group["X"], j)
    value_by_row = {r: float(v) for r, v in zip(x_rows, x_vals)}
    return mask_rows, [value_by_row.get(r, 0.0) for r in mask_rows]


def histogram(dataset_id, property_path, buckets=255):
    """Per-column histogram, matching the Mongo endpoint's response shape."""
    group = _open(dataset_id)
    var_names = _read_str_index(group, "var")
    key = leaf_path_to_key(tuple(property_path))
    if key not in var_names:
        return []
    j = var_names.index(key)
    _, vals = _column_values(group, j)
    return bucket_auto(vals, buckets)


def filter_passing_ids(dataset_id, property_filters):
    """Annotation ids passing every property filter (AND across filters).

    Mirrors the Mongo ``/list/ids`` property-filter path: an annotation passes
    a filter only if it has a value for that column and the value satisfies the
    predicate. Absent values never pass a range/values filter.
    """
    group = _open(dataset_id)
    obs_names = _read_str_index(group, "obs")
    var_names = _read_str_index(group, "var")

    passing = None  # None = "all rows still eligible" (before first filter)
    for pf in property_filters or []:
        key = leaf_path_to_key(tuple(pf["path"]))
        if key not in var_names:
            # No column => no annotation has this value => nothing passes a
            # real predicate. (No-op filters should be dropped upstream.)
            return []
        j = var_names.index(key)
        rows, vals = _column_values(group, j)
        matched = {
            rows[k] for k in range(len(rows))
            if passes_property_filter(vals[k], pf)
        }
        passing = matched if passing is None else (passing & matched)
        if not passing:
            return []
    if passing is None:
        # No filters at all -> every annotation passes.
        return list(obs_names)
    return [obs_names[i] for i in sorted(passing)]


def read_batch(dataset_id, annotation_ids, property_paths=None):
    """Projected value rows for a set of annotation ids.

    Returns ``[{"annotationId", "values"}, ...]`` with the same shape as the
    Mongo ``findByAnnotationIds`` result, so it is a drop-in for the ``/batch``
    endpoint. ``property_paths`` (a list of path lists) projects to those
    columns; ``None`` returns every column.
    """
    group = _open(dataset_id)
    obs_names = _read_str_index(group, "obs")
    var_names = _read_str_index(group, "var")
    row_pos = {rid: i for i, rid in enumerate(obs_names)}

    if property_paths:
        wanted_cols = [
            leaf_path_to_key(tuple(p)) for p in property_paths
        ]
        col_indices = [
            var_names.index(k) for k in wanted_cols if k in var_names
        ]
    else:
        col_indices = list(range(len(var_names)))

    # Requested rows that actually exist, as matrix offsets.
    wanted_rows = [
        (rid, row_pos[str(rid)])
        for rid in annotation_ids
        if str(rid) in row_pos
    ]
    wanted_row_set = {offset for _, offset in wanted_rows}

    # Gather present numeric entries for the requested columns/rows by scanning
    # each requested column's CSC slice (few columns in the projected case).
    per_row = {offset: {} for _, offset in wanted_rows}
    for j in col_indices:
        rows, vals = _column_values(group, j)
        path = key_to_leaf_path(var_names[j])
        for k in range(len(rows)):
            r = rows[k]
            if r in wanted_row_set:
                per_row[r][path] = vals[k]

    result = []
    for rid, offset in wanted_rows:
        result.append({
            "annotationId": str(rid),
            "values": unflatten_values(per_row[offset]),
        })
    return result


def delete_store(dataset_id):
    """Remove a dataset's Zarr store from disk, if present."""
    _rmtree(store_path(dataset_id))


# ---------------------------------------------------------------------------
# Small filesystem helpers (kept here so the module has no other imports)
# ---------------------------------------------------------------------------

def _ensure_dir(path):
    os.makedirs(path, exist_ok=True)


def _rmtree(path):
    import shutil
    if os.path.isdir(path):
        shutil.rmtree(path)

"""Per-dataset columnar-store state, kept on the dataset folder metadata.

A dataset opts into the Zarr columnar property-value store by carrying a
``nimbusValueStore`` metadata block on its folder. The read endpoints consult
this to decide whether to serve property values from Mongo (the default) or
from the Zarr store. There is no pre-existing version/dirty mechanism on the
models to extend, so this is new, deliberately small machinery.

State shape (folder ``meta.nimbusValueStore``)::

    {
        "backend": "zarr",
        "status": "building" | "ready" | "dirty",
        "generation": <int>,   # bumped on each successful build
        "columns": <int>,      # var count at last build (informational)
        "rows": <int>,         # obs count at last build (informational)
    }

``status`` semantics:
  - absent / not "zarr": Mongo is the store (ordinary dataset).
  - "building": a build job is in flight; keep serving Mongo until "ready".
  - "ready": serve from Zarr at ``generation``.
  - "dirty": a write happened after the last build; serve Mongo (safe,
    possibly slow) until a rebuild flips it back to "ready".

Only "ready" routes reads to Zarr, so a half-built or stale store is never
served silently.
"""

from girder.models.folder import Folder

VALUE_STORE_META_KEY = "nimbusValueStore"
BACKEND_ZARR = "zarr"

STATUS_BUILDING = "building"
STATUS_READY = "ready"
STATUS_DIRTY = "dirty"


def get_state(dataset):
    """The ``nimbusValueStore`` block for a dataset folder, or ``None``."""
    return (dataset.get("meta") or {}).get(VALUE_STORE_META_KEY)


def is_zarr_ready(dataset):
    """Whether reads for this dataset should be served from the Zarr store."""
    state = get_state(dataset)
    return bool(
        state
        and state.get("backend") == BACKEND_ZARR
        and state.get("status") == STATUS_READY
    )


def get_generation(dataset):
    """Current build generation, or 0 if the dataset has no store yet."""
    state = get_state(dataset)
    return int(state.get("generation", 0)) if state else 0


def _write_state(dataset, state):
    # setMetadata persists and returns the updated folder. Kept in one place so
    # every transition goes through the same Girder-model write.
    return Folder().setMetadata(dataset, {VALUE_STORE_META_KEY: state})


def mark_building(dataset):
    """Record that a build has started. Reads keep using Mongo until ready."""
    state = get_state(dataset) or {"backend": BACKEND_ZARR, "generation": 0}
    state.update({"backend": BACKEND_ZARR, "status": STATUS_BUILDING})
    return _write_state(dataset, state)


def mark_ready(dataset, generation, rows, columns):
    """Record a successful build at ``generation``; reads now use Zarr."""
    return _write_state(dataset, {
        "backend": BACKEND_ZARR,
        "status": STATUS_READY,
        "generation": int(generation),
        "rows": int(rows),
        "columns": int(columns),
    })


def mark_dirty(dataset):
    """Flag the store as stale after a write; reads fall back to Mongo.

    No-op for a dataset without a Zarr store (nothing to invalidate), so this
    is safe to call unconditionally from write paths / cleanup events.
    """
    state = get_state(dataset)
    if not state or state.get("backend") != BACKEND_ZARR:
        return dataset
    if state.get("status") == STATUS_DIRTY:
        return dataset
    state["status"] = STATUS_DIRTY
    return _write_state(dataset, state)


def clear_state(dataset):
    """Remove the store block entirely (e.g. after deleting the Zarr data)."""
    meta = dataset.get("meta") or {}
    if VALUE_STORE_META_KEY not in meta:
        return dataset
    # setMetadata with a None value deletes the key in Girder.
    return Folder().setMetadata(dataset, {VALUE_STORE_META_KEY: None})

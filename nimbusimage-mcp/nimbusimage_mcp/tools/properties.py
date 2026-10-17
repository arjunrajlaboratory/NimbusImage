"""Measurements (properties): what is defined, their values, computing them.

A property is a measurement definition (e.g. "Blob metrics" on polygons
tagged "nucleus"). Its values are per-annotation trees keyed by the
property id: ``{property_id: {"Area": 12.5, "Intensity": {"mean": ...}}}``.
A *value path* is a list of keys down to one number, e.g.
``[property_id, "Area"]``.
"""

from __future__ import annotations

from typing import Literal

from mcp.server.mcpserver.exceptions import ToolError

from nimbusimage_mcp._common import (
    READ_ONLY,
    WRITES,
    clamp,
    client,
    instrumented,
    round_sig,
)

Shape = Literal["point", "polygon", "line", "rectangle"]

# Value documents read to discover value paths, from each end of the
# collection (oldest and newest), as the app does in lazy mode.
PATH_SAMPLE = 200
MAX_PATHS_PER_PROPERTY = 50
# The server summarizes at most this many paths per request.
MAX_SUMMARY_PATHS = 200
DEFAULT_BUCKETS = 20
MAX_BUCKETS = 100


def leaf_paths(tree, prefix: tuple = ()) -> list[list[str]]:
    """Every key path to a non-dict value (lists are leaves, as in the
    app's collectLeafPaths)."""
    if not isinstance(tree, dict):
        return [list(prefix)] if prefix else []
    paths = []
    for key, value in tree.items():
        paths.extend(leaf_paths(value, prefix + (key,)))
    return paths


def discover_paths(nc, dataset_id: str) -> dict[str, list[list[str]]]:
    """Value paths per property id, from a bounded sample of value
    documents (both ends of the collection) rather than every value.

    A property computed only on annotations that fall outside both ends
    of the sample is missed; ni_properties_list reports the server's exact
    uncomputed counts alongside, so that case is visible.
    """
    seen: dict[str, dict[tuple, None]] = {}
    for sortdir in (1, -1):
        docs = nc.girder.get("annotation_property_values", parameters={
            "datasetId": dataset_id, "limit": PATH_SAMPLE,
            "sort": "_id", "sortdir": sortdir,
        })
        for doc in docs:
            for path in leaf_paths(doc.get("values") or {}):
                seen.setdefault(path[0], {})[tuple(path)] = None
    return {
        property_id: [list(p) for p in paths]
        for property_id, paths in seen.items()
    }


def dataset_properties(ds) -> list:
    """The properties set up in this dataset's configuration, in its
    order. (properties.list() returns every property the user can see,
    across all configurations.)"""
    registered = ds.collections.property_ids
    by_id = {p.id: p for p in ds.properties.list()}
    return [by_id[pid] for pid in registered if pid in by_id]


@instrumented
def ni_properties_list(dataset_id: str) -> dict:
    """List the measurements (properties) set up for a dataset, e.g. area,
    intensity, or distance measurements: id, name, the annotation shape
    and tags they apply to, the worker image that computes them, how many
    matching annotations still lack a value (uncomputed), and the value
    paths found (each a list of keys, e.g. [property_id, "Area"]) to pass
    to ni_property_values_summary or ni_property_histogram. uncomputed
    is exact; value_paths come from a sample of stored values, so they
    can be missing for a property computed on only a few annotations.
    """
    nc = client()
    ds = nc.dataset(dataset_id)
    properties = dataset_properties(ds)
    if not properties:
        # Nothing to sample or count for; stored values of properties no
        # longer set up would only be downloaded and dropped.
        return {"properties": []}
    paths = discover_paths(nc, dataset_id)
    uncomputed = nc.girder.post("upenn_annotation/uncomputed_counts", json={
        "datasetId": dataset_id,
        "properties": [
            {"id": p.id, "shape": p.shape, "tags": p.tags}
            for p in properties
        ],
    })
    rows = []
    for p in properties:
        found = paths.get(p.id, [])
        rows.append({
            "id": p.id,
            "name": p.name,
            "shape": p.shape,
            "tags": p.tags.get("tags", []),
            "tags_exclusive": bool(p.tags.get("exclusive")),
            "image": p.image,
            "uncomputed": uncomputed.get(p.id),
            "value_paths": found[:MAX_PATHS_PER_PROPERTY],
            "more_value_paths": max(0, len(found) - MAX_PATHS_PER_PROPERTY),
        })
    return {"properties": rows}


@instrumented
def ni_property_values_summary(
    dataset_id: str,
    property_id: str | None = None,
    shape: Shape | None = None,
    tags: list[str] | None = None,
    exclusive: bool = False,
) -> dict:
    """Summary statistics (count, mean, std, min, max) of computed
    measurement values, e.g. "what is the mean area of my nuclei?". One
    row per value path; not a per-annotation dump. Optionally restrict to
    one property_id (from ni_properties_list) and to annotations of a
    shape and with ANY of `tags` (exactly those tags with exclusive=true).
    """
    nc = client()
    ds = nc.dataset(dataset_id)
    names = {p.id: p.name for p in dataset_properties(ds)}
    if property_id is not None and property_id not in names:
        raise ToolError(
            f"No property {property_id!r} is set up for this dataset; "
            "use ni_properties_list to find its id."
        )
    if not names:
        raise ToolError(
            "No measurements (properties) are set up for this dataset; "
            "see ni_properties_list."
        )
    wanted = [property_id] if property_id else list(names)
    discovered = discover_paths(nc, dataset_id)
    paths = [path for pid in wanted for path in discovered.get(pid, [])]
    if not paths:
        # The sample can miss a property computed on only some
        # annotations, so this must not claim "not computed".
        raise ToolError(
            "Found no values for "
            + (f"property {property_id}" if property_id else
               "any property of this dataset")
            + f" in a sample of {2 * PATH_SAMPLE} value records. Check "
            "its uncomputed count with ni_properties_list: if every "
            "matching annotation is uncomputed, compute it with "
            "ni_property_compute; otherwise its values are too sparse "
            "for the sample."
        )
    truncated = max(0, len(paths) - MAX_SUMMARY_PATHS)
    paths = paths[:MAX_SUMMARY_PATHS]
    summary = ds.annotations.summary(
        shape=shape, tags=tags or None, exclusive=exclusive and bool(tags),
        property_paths=paths,
    )
    return {
        "annotations_matching": summary.total,
        "stats": [
            {
                "property": names.get(s.path[0], s.path[0]),
                "path": ".".join(s.path[1:]),
                "property_path": s.path,
                "count": s.count,
                "mean": round_sig(s.mean),
                "std": round_sig(s.std),
                "min": round_sig(s.min),
                "max": round_sig(s.max),
            }
            for s in summary.properties
        ],
        "paths_not_shown": truncated,
    }


@instrumented
def ni_property_histogram(
    dataset_id: str,
    property_path: list[str],
    buckets: int = DEFAULT_BUCKETS,
) -> dict:
    """Distribution of one measurement value path (from
    ni_properties_list, e.g. [property_id, "Area"]) across all of a
    dataset's annotations. The server makes equal-count bins: each bucket
    holds about the same number of annotations, so narrow buckets mean
    dense values and wide ones sparse values (skew, outliers). Returns
    [{min, max, count}] with up to `buckets` buckets (default 20, max
    100).
    """
    # The keys become a Mongo field path; the histogram endpoint does not
    # validate them (the server's isValidPropertyPath also refuses these).
    if len(property_path) < 2 or any(
        not key or "." in key or "$" in key for key in property_path
    ):
        raise ValueError(
            "property_path must be a list of keys from ni_properties_list, "
            "e.g. [property_id, \"Area\"] (keys cannot contain '.' or '$')."
        )
    rows = client().dataset(dataset_id).properties.histogram(
        ".".join(property_path), buckets=clamp(buckets, 1, MAX_BUCKETS)
    )
    if not rows:
        raise ToolError(
            "No numeric values at this path; check it with "
            "ni_properties_list."
        )
    return {
        "property_path": property_path,
        "buckets": [
            {
                "min": round_sig(r.get("min")),
                "max": round_sig(r.get("max")),
                "count": r.get("count"),
            }
            for r in rows
        ],
        "total": sum(r.get("count") or 0 for r in rows),
    }


@instrumented
def ni_property_compute(dataset_id: str, property_id: str) -> dict:
    """Compute a measurement (property) for a dataset's annotations,
    using the worker and settings it was set up with in NimbusImage.
    Starts a background job that writes values and returns its job_id at
    once; wait with ni_job_wait, then read values with
    ni_property_values_summary.
    """
    ds = client().dataset(dataset_id)
    if property_id not in ds.collections.property_ids:
        raise ToolError(
            f"No property {property_id!r} is set up for this dataset; "
            "use ni_properties_list to find its id."
        )
    prop = ds.properties.get(property_id)
    job = ds.properties.compute(prop, scales=ds.collections.scales)
    return {"job_id": job.id, "status": job.status_name, "title": job.title}


TOOLS = [
    (ni_properties_list, READ_ONLY),
    (ni_property_values_summary, READ_ONLY),
    (ni_property_histogram, READ_ONLY),
    (ni_property_compute, WRITES),
]

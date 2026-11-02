"""Annotations at one location and in a region; creating and deleting
annotations in bulk; summarizing connections (linked objects)."""

from __future__ import annotations

from collections import Counter
from typing import Literal

import nimbusimage as ni

from nimbusimage_mcp._common import (
    READ_ONLY,
    WRITES,
    clamp,
    client,
    instrumented,
)

Shape = Literal["point", "polygon", "line", "rectangle"]

MAX_REGION_ROWS = 200
# Rows read from the list endpoint before a region query gives up and
# says its count is incomplete.
MAX_REGION_SCAN = 20_000
# The list endpoint's largest page (the plugin's MAX_LIST_LIMIT).
LIST_PAGE = 10_000
MAX_CREATE = 1_000
MAX_RETURNED_IDS = 200
MAX_DELETE = 50_000
# Past this, ni_connections_summary reports the count only.
MAX_CONNECTIONS_SCANNED = 200_000
CONNECTION_PAGE = 10_000
# Fewest vertices per shape (a rectangle has exactly four).
MIN_VERTICES = {"point": 1, "line": 2, "polygon": 3, "rectangle": 4}


def _tag_filter(tags: list[str] | None) -> dict | None:
    """The list endpoint's tag filter: annotations with ANY of the tags
    (exclusive=false; exclusive=true would mean exactly that set)."""
    if not tags:
        return None
    if isinstance(tags, str) or not all(
        isinstance(t, str) and t for t in tags
    ):
        raise ValueError("tags must be a list of tag names.")
    # Deduplicated, as the server compares against the list.
    return {"values": list(dict.fromkeys(tags)), "exclusive": False}


def _list_filters(tags=None, shape=None, xy=None, z=None,
                  time=None) -> dict:
    filters: dict = {}
    tag_filter = _tag_filter(tags)
    if tag_filter:
        filters["tags"] = tag_filter
    if shape:
        filters["shape"] = shape
    location = {
        key: value
        for key, value in (("XY", xy), ("Z", z), ("Time", time))
        if value is not None
    }
    for key, value in location.items():
        if isinstance(value, bool) or not isinstance(value, int) \
                or value < 0:
            raise ValueError(
                f"{key} must be a whole number of 0 or more (0-based)."
            )
    if location:
        filters["location"] = location
    return filters


def _list_page(nc, dataset_id: str, filters: dict, offset: int,
               limit: int) -> dict:
    """One page of POST upenn_annotation/list: {total, offset, rows}.
    Rows are stubs (no coordinates) with a server-computed centroid."""
    return nc.girder.post("upenn_annotation/list", json={
        "datasetId": dataset_id, "filters": filters,
        "offset": offset, "limit": limit,
    })


def _check_location(ds, xy: int, z: int, time: int,
                    channel: int | None = None) -> None:
    """Refuse indices past the dataset's ranges, which would otherwise
    match (or create) annotations no view shows."""
    for name, value, size in (
        ("xy", xy, ds.num_xy), ("z", z, ds.num_z),
        ("time", time, ds.num_time),
        *((("channel", channel, ds.num_channels),)
          if channel is not None else ()),
    ):
        if isinstance(value, bool) or not isinstance(value, int) \
                or not 0 <= value < size:
            raise ValueError(
                f"{name}={value!r} is out of range: this dataset has "
                f"{size} {name} position(s), numbered 0 to {size - 1}."
            )


def _point(value) -> tuple[float, float]:
    if (not isinstance(value, (list, tuple)) or len(value) != 2
            or any(isinstance(v, bool) or not isinstance(v, (int, float))
                   for v in value)):
        raise ValueError(
            f"Each coordinate must be [x, y] in pixels, not {value!r}."
        )
    return float(value[0]), float(value[1])


@instrumented
def ni_annotations_in_region(
    dataset_id: str,
    xy: int = 0,
    z: int = 0,
    time: int = 0,
    region: tuple[float, float, float, float] | None = None,
    tags: list[str] | None = None,
    shape: Shape | None = None,
    limit: int = 50,
) -> dict:
    """List the annotations at one location (XY position, Z slice, time
    point; all 0-based) whose center lies inside a rectangular region,
    e.g. "which nuclei are in this corner of z-slice 3?". Without a
    region, the whole frame at that location.

    region is [left, top, right, bottom] in full-resolution image pixels
    (x grows rightward, y downward; edges included). An annotation's
    center is the mean of its vertices. tags matches annotations with ANY
    of the given tags (unlike ni_annotations_count, which needs ALL);
    shape is point (spots), polygon (cells/nuclei), line, or rectangle.

    Returns {matched, returned, scanned, total_at_location, incomplete,
    annotations: [{id, shape, tags, center: [x, y], vertex_count}]}, at
    most `limit` rows (default 50, at most 200). A region query reads at
    most 20,000 annotations at that location; past that, incomplete is
    true and matched counts only the ones read, so narrow it by tags or
    shape.
    """
    limit = clamp(limit, 1, MAX_REGION_ROWS)
    if region is not None:
        if len(region) != 4 or any(
            isinstance(v, bool) or not isinstance(v, (int, float))
            for v in region
        ):
            raise ValueError(
                "region must be [left, top, right, bottom] in pixels."
            )
        left, top, right, bottom = (float(v) for v in region)
        if left > right or top > bottom:
            raise ValueError(
                "region must be [left, top, right, bottom] with left <= "
                "right and top <= bottom (y grows downward)."
            )
    filters = _list_filters(tags, shape, xy, z, time)
    nc = client()
    ds = nc.dataset(dataset_id)
    _check_location(ds, xy, z, time)

    def inside(row) -> bool:
        center = row.get("centroid") or {}
        x, y = center.get("x"), center.get("y")
        return x is not None and y is not None \
            and left <= x <= right and top <= y <= bottom

    if region is None:
        # The server's total is the exact match count; one page suffices.
        page = _list_page(nc, dataset_id, filters, 0, limit)
        total = page["total"]
        scanned = page["rows"]
        hits = scanned
        matched = total
    else:
        scanned, hits, total = [], [], None
        while total is None or len(scanned) < min(total, MAX_REGION_SCAN):
            page = _list_page(
                nc, dataset_id, filters, len(scanned),
                min(LIST_PAGE, MAX_REGION_SCAN - len(scanned)),
            )
            total = page["total"]
            if not page["rows"]:
                break
            scanned += page["rows"]
            hits += [row for row in page["rows"] if inside(row)]
        matched = len(hits)
    rows = hits[:limit]
    # Vertex counts need the coordinates, which list rows leave out: one
    # batch request for just the returned rows.
    vertices = {
        a.id: len(a.coordinates)
        for a in ds.annotations.get_many([row["_id"] for row in rows])
    } if rows else {}
    return {
        "matched": matched,
        "returned": len(rows),
        "scanned": len(scanned),
        "total_at_location": total,
        "incomplete": region is not None and len(scanned) < total,
        "location": {"xy": xy, "z": z, "time": time},
        "region": list(region) if region is not None else None,
        "annotations": [
            {
                "id": row["_id"],
                "shape": row.get("shape"),
                "tags": row.get("tags", []),
                "center": [
                    round(row["centroid"]["x"], 1),
                    round(row["centroid"]["y"], 1),
                ] if (row.get("centroid") or {}).get("x") is not None
                else None,
                "vertex_count": vertices.get(row["_id"]),
            }
            for row in rows
        ],
    }


@instrumented
def ni_annotations_create(
    dataset_id: str,
    annotations: list[dict],
    xy: int = 0,
    z: int = 0,
    time: int = 0,
    channel: int = 0,
) -> dict:
    """Create annotations in one request (at most 1,000 per call), all at
    one location (XY position, Z slice, time point; 0-based) and on one
    channel.

    Each annotation is {shape, coordinates, tags}: shape is point (one
    vertex), line (2 or more), polygon (3 or more; do not repeat the
    first vertex at the end), or rectangle (exactly 4 corners);
    coordinates are [[x, y], ...] in full-resolution image pixels, inside
    the image (x from 0 to width, y from 0 to height, y downward); tags is
    a list of tag names (e.g. ["nucleus"]). Nothing is created if any
    annotation is invalid. This adds stored annotations (undoable in the
    NimbusImage app). Returns {created, ids} (ids capped at 200).
    """
    if not isinstance(annotations, list) or not annotations:
        raise ValueError("annotations must be a non-empty list.")
    if len(annotations) > MAX_CREATE:
        raise ValueError(
            f"At most {MAX_CREATE} annotations per call; split the list."
        )
    nc = client()
    ds = nc.dataset(dataset_id)
    _check_location(ds, xy, z, time, channel)
    height, width = ds.shape
    location = ni.Location(xy=xy, z=z, time=time)
    to_create = []
    for index, entry in enumerate(annotations):
        where = f"Annotation {index}"
        if not isinstance(entry, dict):
            raise ValueError(f"{where} must be an object.")
        shape = entry.get("shape")
        if shape not in MIN_VERTICES:
            raise ValueError(
                f"{where}: shape must be point, line, polygon, or "
                f"rectangle, not {shape!r}."
            )
        coordinates = entry.get("coordinates")
        if not isinstance(coordinates, list):
            raise ValueError(f"{where}: coordinates must be [[x, y], ...].")
        points = [_point(c) for c in coordinates]
        need = MIN_VERTICES[shape]
        if shape == "point" and len(points) != 1:
            raise ValueError(f"{where}: a point has exactly 1 vertex.")
        if shape == "rectangle" and len(points) != 4:
            raise ValueError(f"{where}: a rectangle has exactly 4 corners.")
        if len(points) < need:
            raise ValueError(
                f"{where}: a {shape} needs at least {need} vertices."
            )
        outside = next(
            (p for p in points
             if not (0 <= p[0] <= width and 0 <= p[1] <= height)), None
        )
        if outside is not None:
            raise ValueError(
                f"{where}: vertex {list(outside)} is outside the image "
                f"(x 0 to {width}, y 0 to {height})."
            )
        tags = entry.get("tags") or []
        if isinstance(tags, str) or not all(
            isinstance(t, str) and t for t in tags
        ):
            raise ValueError(f"{where}: tags must be a list of tag names.")
        to_create.append(ni.Annotation(
            shape=shape, tags=list(dict.fromkeys(tags)), channel=channel,
            location=location, dataset_id=dataset_id,
            coordinates=[{"x": x, "y": y} for x, y in points],
        ))
    created = ds.annotations.create_many(to_create)
    ids = [a.id for a in created]
    return {
        "created": len(created),
        "ids": ids[:MAX_RETURNED_IDS],
        "ids_truncated": len(ids) > MAX_RETURNED_IDS,
        "location": {"xy": xy, "z": z, "time": time},
        "channel": channel,
    }


@instrumented
def ni_annotations_delete(
    dataset_id: str,
    expected_count: int,
    tags: list[str] | None = None,
    shape: Shape | None = None,
    xy: int | None = None,
    z: int | None = None,
    time: int | None = None,
) -> dict:
    """Delete the annotations matching a filter: tags (annotations with
    ANY of the given tags, unlike ni_annotations_count, which needs ALL),
    shape, and optionally a location (xy, z, time; 0-based; omitted means
    every position). At least one filter is required; this never deletes
    a whole dataset. At most 50,000 per call.

    Two steps, always: first call with expected_count=-1, which deletes
    nothing and reports how many annotations match; tell the user that
    number and get their confirmation; then call again with
    expected_count set to it. If the number matching differs from
    expected_count, nothing is deleted and the message gives the real
    count. Connections and property values of the deleted annotations
    are deleted with them.

    The delete is one entry in the user's NimbusImage edit history, so
    undo (ni_history_undo, or Undo in the app) restores the annotations,
    their connections and property values, but only while it is still in
    history: Girder keeps a user's last 10 actions and drops entries
    older than an hour.
    """
    if isinstance(expected_count, bool) or not isinstance(
            expected_count, int) or expected_count < -1:
        raise ValueError(
            "expected_count must be the number of annotations to delete, "
            "or -1 to only count them."
        )
    filters = _list_filters(tags, shape, xy, z, time)
    if not filters:
        raise ValueError(
            "Give at least one filter (tags, shape, xy, z, or time); this "
            "tool does not delete every annotation in a dataset."
        )
    nc = client()
    total = _list_page(nc, dataset_id, filters, 0, 1)["total"]
    too_many = (
        f"{total} annotations match, more than the {MAX_DELETE} one call "
        "may delete. Narrow the filter (e.g. by location)."
    )
    if expected_count == -1:
        if total == 0:
            message = "No annotations match this filter."
        elif total > MAX_DELETE:
            message = f"Nothing was deleted. {too_many}"
        else:
            message = (
                f"{total} annotations match; nothing was deleted. Confirm "
                "this number with the user, then call again with "
                f"expected_count={total}."
            )
        return {"deleted": 0, "matching": total, "message": message}
    if expected_count != total:
        raise ValueError(
            f"Nothing was deleted: {total} annotations match this filter, "
            f"not {expected_count}. Confirm the real count with the user "
            "and call again with it."
        )
    if total > MAX_DELETE:
        raise ValueError(f"Nothing was deleted. {too_many}")
    if total == 0:
        return {"deleted": 0, "matching": 0}
    ids = nc.girder.post("upenn_annotation/list/ids", json={
        "datasetId": dataset_id, "filters": filters,
    })["ids"]
    if len(ids) != expected_count:
        raise ValueError(
            f"The matching annotations changed while deleting (now "
            f"{len(ids)}, expected {expected_count}); nothing was "
            "deleted. Count again."
        )
    # One request (no per-request id cap on this endpoint), so the delete
    # is a single history entry that one undo restores.
    nc.dataset(dataset_id).annotations.delete_many(ids)
    return {"deleted": len(ids), "matching": total}


def _components(edges) -> Counter:
    """Sizes of the connected components spanned by (a, b) edges, by
    union-find with path halving and union by size."""
    parent: dict[str, str] = {}
    size: dict[str, int] = {}

    def find(node: str) -> str:
        while parent[node] != node:
            parent[node] = parent[parent[node]]
            node = parent[node]
        return node

    for a, b in edges:
        for node in (a, b):
            if node not in parent:
                parent[node] = node
                size[node] = 1
        root_a, root_b = find(a), find(b)
        if root_a == root_b:
            continue
        if size[root_a] < size[root_b]:
            root_a, root_b = root_b, root_a
        parent[root_b] = root_a
        size[root_a] += size[root_b]
    return Counter(size[node] for node in parent if find(node) == node)


@instrumented
def ni_connections_summary(dataset_id: str) -> dict:
    """Summarize a dataset's connections (links between annotations, e.g.
    the same nucleus linked across z-slices or time points, or spots
    linked to the cell containing them) as linked objects.

    Returns {connections, linked_objects, annotations_linked,
    largest_object, size_histogram: {"2", "3", "4", "5", "6+"}}: annotations
    joined directly or through others form one object (a connected
    component); size_histogram counts objects by how many annotations
    they hold. Above 200,000 connections, only the count is returned.

    Turning per-slice counts into per-cell counts: after a worker links
    one nucleus's outlines across z-slices, each linked object is one
    cell, so cells = linked_objects + (nuclei never linked) =
    linked_objects + N - annotations_linked, where N is the count of
    those nuclei from ni_annotations_count. This holds when the dataset's
    connections are all of that kind; the server cannot filter
    connections by tag.
    """
    nc = client()
    connections = nc.dataset(dataset_id).connections.count()
    if connections > MAX_CONNECTIONS_SCANNED:
        return {
            "connections": connections,
            "message": (
                f"Too many connections to group here (more than "
                f"{MAX_CONNECTIONS_SCANNED}); use the nimbusimage Python "
                "API for this dataset."
            ),
        }
    edges = []
    after_id = None
    while True:
        params = {
            "datasetId": dataset_id, "limit": CONNECTION_PAGE,
            "sort": "_id", "sortdir": 1,
        }
        if after_id:
            params["afterId"] = after_id
        # A stable _id cursor, so pages never skip or repeat.
        page = nc.girder.get("annotation_connection", parameters=params)
        edges += [(c["parentId"], c["childId"]) for c in page]
        if len(page) < CONNECTION_PAGE or \
                len(edges) > MAX_CONNECTIONS_SCANNED:
            break
        after_id = page[-1]["_id"]
    # A connection from an annotation to itself links nothing.
    sizes = _components((a, b) for a, b in edges if a != b)
    histogram = {"2": 0, "3": 0, "4": 0, "5": 0, "6+": 0}
    for component_size, number in sizes.items():
        key = str(component_size) if component_size < 6 else "6+"
        histogram[key] += number
    return {
        "connections": len(edges),
        "linked_objects": sum(sizes.values()),
        "annotations_linked": sum(s * n for s, n in sizes.items()),
        "largest_object": max(sizes, default=0),
        "size_histogram": histogram,
    }


TOOLS = [
    (ni_annotations_in_region, READ_ONLY),
    (ni_annotations_create, WRITES),
    (ni_annotations_delete, WRITES),
    (ni_connections_summary, READ_ONLY),
]

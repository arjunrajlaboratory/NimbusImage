"""Counting, summarizing, listing, and tagging annotations."""

from __future__ import annotations

from typing import Literal

from mcp.server.mcpserver.exceptions import ToolError

from nimbusimage_mcp._common import (
    READ_ONLY,
    WRITES,
    clamp,
    client,
    instrumented,
)

Shape = Literal["point", "polygon", "line", "rectangle"]

# Matches the AI panel's MAX_LIST_ANNOTATIONS.
MAX_LIST = 200
MAX_COUNT_DATASETS = 50
# The batch count endpoint's MAX_DATASET_ID_LENGTH (an ObjectId is 24).
MAX_DATASET_ID_LENGTH = 64
MAX_SUMMARY_TAGS = 200
# One tagging call loads every matching annotation (with coordinates)
# into this process and sends one bulk update; past this, narrow the
# query or run it in the app.
MAX_TAG_ANNOTATIONS = 10_000


@instrumented
def ni_annotations_count(
    dataset_ids: list[str],
    shape: Shape | None = None,
    tags: list[str] | None = None,
) -> dict:
    """Count annotations (spots, cells, nuclei, ROIs) in one or more
    datasets (up to 50 at once, e.g. to compare datasets).

    Optionally filter by shape (point = spots, polygon = cells/nuclei,
    line, rectangle) and by tags (an annotation must have ALL the given
    tags). Returns {total, counts: [{dataset_id, count}], incomplete}; an
    id that is mistyped, missing, or not readable gets an "error" instead
    of a count, and then total covers only the readable ones and
    incomplete is true. Use this before listing annotations.
    """
    ids = list(dict.fromkeys(dataset_ids))
    if not 1 <= len(ids) <= MAX_COUNT_DATASETS:
        raise ValueError(
            f"Pass between 1 and {MAX_COUNT_DATASETS} dataset_ids."
        )
    # The server refuses the whole request for an id longer than it
    # accepts; keep that one entry's error instead, like any bad id.
    sendable = [i for i in ids if len(i) <= MAX_DATASET_ID_LENGTH]
    # One request: the server counts every dataset in one aggregation
    # and reports unreadable ones as errors instead of failing.
    rows = {
        row["datasetId"]: row for row in client().count_annotations(
            sendable, shape=shape, tags=tags
        )
    } if sendable else {}
    counts = []
    for dataset_id in ids:
        row = rows.get(dataset_id) or {
            "error": "not a valid id"
            if len(dataset_id) > MAX_DATASET_ID_LENGTH else "no result"
        }
        counts.append(
            {"dataset_id": dataset_id, "count": row["count"]}
            if "count" in row else
            {"dataset_id": dataset_id, "error": row["error"]}
        )
    return {
        "total": sum(c.get("count", 0) for c in counts),
        "incomplete": any("error" in c for c in counts),
        "shape": shape,
        "tags": tags or [],
        "counts": counts,
    }


@instrumented
def ni_annotations_summary(
    dataset_id: str,
    shape: Shape | None = None,
    tags: list[str] | None = None,
    exclusive: bool = False,
    max_tags: int = 30,
) -> dict:
    """Summarize a dataset's annotations: total count, counts by tag (most
    common first, capped at max_tags, at most 200), and counts by shape.
    Use this to learn which tags exist (e.g. "nucleus", "spot", "cell")
    before counting or filtering. An annotation with several tags counts
    once per tag.

    Optionally restrict to a shape, and to annotations with ANY of `tags`
    (or exactly those tags with exclusive=true).
    """
    summary = client().dataset(dataset_id).annotations.summary(
        shape=shape, tags=tags or None, exclusive=exclusive and bool(tags)
    )
    return {
        "total": summary.total,
        "by_tag": dict(list(summary.tags.items())[
            :clamp(max_tags, 1, MAX_SUMMARY_TAGS)]),
        "distinct_tags": len(summary.tags),
        "by_shape": summary.shapes,
    }


def _center(coordinates: list[dict]) -> list[float] | None:
    """Mean of the vertices: a cheap position for any shape."""
    if not coordinates:
        return None
    n = len(coordinates)
    return [
        round(sum(c.get("x", 0) for c in coordinates) / n, 1),
        round(sum(c.get("y", 0) for c in coordinates) / n, 1),
    ]


@instrumented
def ni_annotations_list(
    dataset_id: str,
    shape: Shape | None = None,
    tags: list[str] | None = None,
    limit: int = 50,
    offset: int = 0,
) -> dict:
    """List specific annotations: id, shape, tags, channel, location
    (XY/Z/Time indices), center (x, y in image pixels), and vertex count.
    Filter by shape and by tags (an annotation must have ALL the given
    tags). At most 200 per call (default 50); the result says how many
    match in total and the offset of the next page. For counts or a
    breakdown by tag, use ni_annotations_count or ni_annotations_summary
    instead of listing.
    """
    limit = clamp(limit, 1, MAX_LIST)
    offset = max(0, offset)
    annotations = client().dataset(dataset_id).annotations
    total = annotations.count(shape=shape, tags=tags)
    rows = annotations.list(
        shape=shape, tags=tags, limit=limit, offset=offset, sort="_id"
    )
    has_more = offset + len(rows) < total
    return {
        "total_matching": total,
        "returned": len(rows),
        "has_more": has_more,
        "next_offset": offset + len(rows) if has_more else None,
        "annotations": [
            {
                "id": a.id,
                "shape": a.shape,
                "tags": a.tags,
                "channel": a.channel,
                "location": a.location.to_dict(),
                "center": _center(a.coordinates),
                "vertices": len(a.coordinates),
            }
            for a in rows
        ],
    }


def retag(current: list[str], tags: list[str], mode: str) -> list[str]:
    """The new tag list for one annotation, keeping the existing order."""
    if mode == "add":
        return current + [t for t in dict.fromkeys(tags) if t not in current]
    if mode == "remove":
        return [t for t in current if t not in tags]
    return list(dict.fromkeys(tags))


@instrumented
def ni_annotations_tag(
    dataset_id: str,
    tags: list[str],
    mode: Literal["add", "remove", "replace"],
    match_shape: Shape | None = None,
    match_tags: list[str] | None = None,
    annotation_ids: list[str] | None = None,
) -> dict:
    """Add, remove, or replace tags on annotations chosen by a query, e.g.
    "tag all polygons with 'cell'" (match_shape="polygon", tags=["cell"],
    mode="add"). Annotations match when they have the shape and ALL of
    match_tags, or pass annotation_ids instead. At least one of
    match_shape, match_tags, or annotation_ids is required. This edits
    stored annotations (the user can undo it in the NimbusImage app);
    at most 10,000 annotations per call. Returns how many matched and
    how many changed.
    """
    if not tags or any(not isinstance(t, str) or not t for t in tags):
        raise ValueError("tags must be a non-empty list of tag names.")
    if annotation_ids is not None and (match_shape or match_tags):
        raise ValueError(
            "Pass annotation_ids or a query (match_shape / match_tags), "
            "not both."
        )
    if not (annotation_ids or match_shape or match_tags):
        raise ValueError(
            "Choose the annotations: pass match_shape, match_tags, or "
            "annotation_ids (tagging a whole dataset needs an explicit "
            "query)."
        )
    annotations = client().dataset(dataset_id).annotations
    if annotation_ids:
        if len(annotation_ids) > MAX_TAG_ANNOTATIONS:
            raise ToolError(
                f"At most {MAX_TAG_ANNOTATIONS} annotation_ids per call."
            )
        # Ids of other readable datasets are dropped; an id of a dataset
        # the caller cannot read makes the server refuse the whole call.
        matched = annotations.get_many(annotation_ids)
    else:
        total = annotations.count(shape=match_shape, tags=match_tags)
        if total > MAX_TAG_ANNOTATIONS:
            raise ToolError(
                f"The query matches {total} annotations, more than the "
                f"{MAX_TAG_ANNOTATIONS} one call may change. Narrow it "
                "(e.g. by tag), or tag them in the NimbusImage app."
            )
        matched = annotations.list(
            shape=match_shape, tags=match_tags, limit=MAX_TAG_ANNOTATIONS,
            sort="_id",
        ) if total else []
    updates = []
    for annotation in matched:
        new_tags = retag(annotation.tags, tags, mode)
        # Compared as sets: a replace that only reorders changes nothing.
        if set(new_tags) != set(annotation.tags):
            updates.append((annotation.id, {"tags": new_tags}))
    if updates:
        annotations.update_many(updates)
    return {
        "matched": len(matched),
        "changed": len(updates),
        "mode": mode,
        "tags": tags,
    }


TOOLS = [
    (ni_annotations_count, READ_ONLY),
    (ni_annotations_summary, READ_ONLY),
    (ni_annotations_list, READ_ONLY),
    (ni_annotations_tag, WRITES),
]

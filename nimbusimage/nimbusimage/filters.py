"""Client-side filtering helpers for annotation lists."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from nimbusimage.models import Annotation


def filter_by_tags(
    annotations: list[Annotation],
    tags: list[str],
    exclusive: bool = False,
) -> list[Annotation]:
    """Filter annotations by tags.

    Args:
        annotations: List of Annotation objects.
        tags: Tags to filter by.
        exclusive: If False (default), annotation must have at least one
            matching tag. If True, annotation tags must exactly match
            (order independent).

    Returns:
        Filtered list.
    """
    if not tags:
        return list(annotations)

    tag_set = set(tags)
    if exclusive:
        return [a for a in annotations if set(a.tags) == tag_set]
    else:
        return [a for a in annotations if tag_set & set(a.tags)]


def filter_by_location(
    annotations: list[Annotation],
    xy: int | None = None,
    z: int | None = None,
    time: int | None = None,
) -> list[Annotation]:
    """Filter annotations by location. None means any value.

    Args:
        annotations: List of Annotation objects.
        xy: XY position to match, or None for any.
        z: Z position to match, or None for any.
        time: Time position to match, or None for any.

    Returns:
        Filtered list.
    """
    result = []
    for a in annotations:
        if xy is not None and a.location.xy != xy:
            continue
        if z is not None and a.location.z != z:
            continue
        if time is not None and a.location.time != time:
            continue
        result.append(a)
    return result


def group_by_location(
    annotations: list[Annotation],
) -> dict[tuple[int, int, int], list[Annotation]]:
    """Group annotations by location.

    Returns:
        Dict mapping ``(time, z, xy)`` tuples to lists of annotations.
        Key order is time (outermost), z, xy (innermost).
    """
    groups: dict[tuple[int, int, int], list[Annotation]] = {}
    for a in annotations:
        key = (a.location.time, a.location.z, a.location.xy)
        groups.setdefault(key, []).append(a)
    return groups

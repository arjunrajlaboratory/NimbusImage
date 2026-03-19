"""Tests for client-side filter helpers."""

import pytest

from nimbusimage.filters import (
    filter_by_tags,
    filter_by_location,
    group_by_location,
)
from nimbusimage.models import Annotation, Location


def _ann(tags, xy=0, z=0, time=0):
    """Helper to create a minimal annotation."""
    return Annotation(
        id=None, shape="point", tags=tags, channel=0,
        location=Location(xy=xy, z=z, time=time),
        coordinates=[{"x": 0, "y": 0}], dataset_id="ds",
    )


class TestFilterByTags:
    def test_inclusive_match(self):
        anns = [_ann(["a", "b"]), _ann(["b", "c"]), _ann(["d"])]
        result = filter_by_tags(anns, tags=["b"])
        assert len(result) == 2

    def test_inclusive_no_match(self):
        anns = [_ann(["a"]), _ann(["b"])]
        result = filter_by_tags(anns, tags=["c"])
        assert len(result) == 0

    def test_exclusive_exact_match(self):
        anns = [_ann(["a", "b"]), _ann(["a"]), _ann(["b", "a"])]
        result = filter_by_tags(anns, tags=["a", "b"], exclusive=True)
        # exclusive: annotation tags must exactly match (order independent)
        assert len(result) == 2  # first and third

    def test_exclusive_no_match(self):
        anns = [_ann(["a", "b", "c"])]
        result = filter_by_tags(anns, tags=["a", "b"], exclusive=True)
        assert len(result) == 0

    def test_empty_tags_returns_all(self):
        anns = [_ann(["a"]), _ann(["b"])]
        result = filter_by_tags(anns, tags=[])
        assert len(result) == 2

    def test_empty_list(self):
        result = filter_by_tags([], tags=["a"])
        assert result == []


class TestFilterByLocation:
    def test_match_all_specified(self):
        anns = [_ann([], xy=0, z=1, time=2), _ann([], xy=0, z=0, time=2)]
        result = filter_by_location(anns, xy=0, z=1, time=2)
        assert len(result) == 1

    def test_none_means_any(self):
        anns = [
            _ann([], xy=0, z=0, time=0),
            _ann([], xy=0, z=1, time=0),
            _ann([], xy=0, z=2, time=0),
        ]
        result = filter_by_location(anns, xy=0, z=None, time=0)
        assert len(result) == 3

    def test_all_none_returns_all(self):
        anns = [_ann([], xy=0, z=0, time=0), _ann([], xy=1, z=1, time=1)]
        result = filter_by_location(anns, xy=None, z=None, time=None)
        assert len(result) == 2


class TestGroupByLocation:
    def test_basic_grouping(self):
        anns = [
            _ann(["a"], xy=0, z=0, time=0),
            _ann(["b"], xy=0, z=0, time=0),
            _ann(["c"], xy=1, z=0, time=0),
        ]
        groups = group_by_location(anns)
        assert len(groups) == 2
        assert len(groups[(0, 0, 0)]) == 2
        assert len(groups[(0, 0, 1)]) == 1

    def test_empty_list(self):
        groups = group_by_location([])
        assert groups == {}

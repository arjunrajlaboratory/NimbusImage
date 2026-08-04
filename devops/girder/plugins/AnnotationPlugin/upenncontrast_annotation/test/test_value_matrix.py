"""Unit tests for the pure columnar-store helpers (server/helpers/valueMatrix).

These have no numpy/zarr dependency, so they run in the standard tox env even
before the columnar-store extras are installed.
"""

from upenncontrast_annotation.server.helpers import valueMatrix as vm


class TestFlattenUnflatten:
    def testFlattenNested(self):
        values = {"propA": 3, "propB": {"sub0": 1, "sub1": 2}}
        flat = {
            vm.leaf_path_to_key(k): v
            for k, v in vm.flatten_values(values).items()
        }
        assert flat == {"propA": 3, "propB/sub0": 1, "propB/sub1": 2}

    def testRoundTrip(self):
        values = {"propA": 3, "propB": {"sub0": 1, "sub1": 2}, "propC": None}
        assert vm.unflatten_values(vm.flatten_values(values)) == values

    def testEmptyDictIsALeaf(self):
        # Mirrors the frontend collectLeafPaths: an empty dict yields a column
        # with a None value, not zero columns.
        assert vm.flatten_values({"p": {}}) == {("p",): None}

    def testNullLeafIsPreserved(self):
        # A stored null is a real value, distinct from an absent column.
        assert vm.unflatten_values({("p",): None}) == {"p": None}

    def testKeyPathConversionRoundTrip(self):
        assert vm.key_to_leaf_path("propB/sub0") == ("propB", "sub0")
        assert vm.leaf_path_to_key(("propB", "sub0")) == "propB/sub0"


class TestCollectColumns:
    def testSortedUnionAcrossSparseDocs(self):
        docs = [
            {"values": {"b": 1, "a": {"x": 1}}},
            {"values": {"a": {"y": 2}, "c": 3}},
        ]
        # Deterministic (sorted) union across docs that differ in which columns
        # they carry -- the stored var/index must be stable across builds.
        assert vm.collect_columns(docs) == ["a/x", "a/y", "b", "c"]

    def testHandlesMissingValues(self):
        assert vm.collect_columns([{"annotationId": "z"}, {}]) == []


class TestBucketAuto:
    def testContiguousBucketsSpanRange(self):
        hist = vm.bucket_auto([1, 2, 3, 4, 5, 6, 7, 8, 9], 3)
        assert [b["count"] for b in hist] == [3, 3, 3]
        assert hist[0]["min"] == 1
        assert hist[-1]["max"] == 9

    def testEmptyInput(self):
        assert vm.bucket_auto([], 5) == []

    def testAllEqualCollapsesToOneBucket(self):
        # A run of equal values must not straddle buckets.
        assert vm.bucket_auto([2, 2, 2, 2], 3) == [
            {"min": 2, "max": 2, "count": 4}
        ]

    def testDropsNonNumericIsCallerJob(self):
        # bucket_auto only sees numerics; None must be filtered upstream, but
        # a stray None should be ignored rather than crash.
        assert vm.bucket_auto([1, None, 3], 2)[0]["min"] == 1


class TestPassesPropertyFilter:
    def testRange(self):
        f = {"path": ["p"], "mode": "range", "min": 1, "max": 5}
        assert vm.passes_property_filter(3, f)
        assert not vm.passes_property_filter(6, f)
        assert not vm.passes_property_filter(0, f)

    def testMissingValueNeverPassesARange(self):
        f = {"path": ["p"], "mode": "range", "min": 1, "max": 5}
        assert not vm.passes_property_filter(None, f)

    def testValuesMode(self):
        f = {"path": ["p"], "mode": "values", "values": [1, 2]}
        assert vm.passes_property_filter(2, f)
        assert not vm.passes_property_filter(3, f)

    def testNoOpFilterPassesEverything(self):
        f = {"path": ["p"], "mode": "range"}
        assert vm.passes_property_filter(None, f)
        assert vm.passes_property_filter(999, f)

    def testOpenEndedRange(self):
        f = {"path": ["p"], "mode": "range", "min": 10}
        assert vm.passes_property_filter(11, f)
        assert not vm.passes_property_filter(9, f)

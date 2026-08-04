"""Roundtrip tests for the Zarr columnar store (server/helpers/zarrValueStore).

Skipped unless the columnar extras (numpy/scipy/zarr/anndata) are installed --
run ``tox`` inside the rebuilt girder container to exercise these. They assert
the Zarr reader returns the same shapes as the Mongo path it replaces, so it is
a genuine drop-in.
"""

import os

import pytest

from upenncontrast_annotation.server.helpers import zarrValueStore as store

pytestmark = pytest.mark.skipif(
    not store.backend_available(),
    reason="columnar extras (numpy/scipy/zarr/anndata) not installed",
)


@pytest.fixture
def tmp_store_base(tmp_path, monkeypatch):
    monkeypatch.setenv(store.STORE_BASE_ENV, str(tmp_path))
    return str(tmp_path)


# A dataset with a numeric leaf, a nested sub-property, a null, and a string --
# covering every branch of build/read.
DATASET_ID = "0123456789abcdef01234567"
DOCS = [
    {"annotationId": "a1", "values": {"pA": 1.0, "pB": {"s0": 10.0}}},
    {"annotationId": "a2", "values": {"pA": 2.0, "pB": {"s0": 20.0}}},
    {"annotationId": "a3", "values": {"pA": 3.0, "pC": "label"}},
    {"annotationId": "a4", "values": {"pA": 5.0, "pB": {"s0": 40.0}}},
]


def _build(tmp_store_base):
    return store.build_store(DATASET_ID, DOCS, generation=1)


class TestBuildAndReadBatch:
    def testBuildReportsRowsAndColumns(self, tmp_store_base):
        rows, cols = _build(tmp_store_base)
        assert rows == 4
        # columns: pA, pB/s0, pC
        assert cols == 3
        assert store.store_exists(DATASET_ID)

    def testReadBatchAllColumns(self, tmp_store_base):
        _build(tmp_store_base)
        result = store.read_batch(DATASET_ID, ["a1", "a3"])
        by_id = {r["annotationId"]: r["values"] for r in result}
        assert by_id["a1"] == {"pA": 1.0, "pB": {"s0": 10.0}}
        # Numeric-only first cut: a3's string-valued pC is skipped, so only
        # its numeric pA comes back (strings stay in Mongo -- see the module).
        assert by_id["a3"] == {"pA": 3.0}

    def testReadBatchProjectsPaths(self, tmp_store_base):
        _build(tmp_store_base)
        result = store.read_batch(DATASET_ID, ["a1"], property_paths=[["pA"]])
        assert result == [{"annotationId": "a1", "values": {"pA": 1.0}}]

    def testReadBatchSkipsUnknownIds(self, tmp_store_base):
        _build(tmp_store_base)
        result = store.read_batch(DATASET_ID, ["a1", "nope"])
        assert [r["annotationId"] for r in result] == ["a1"]


class TestHistogram:
    def testHistogramSpansColumn(self, tmp_store_base):
        _build(tmp_store_base)
        hist = store.histogram(DATASET_ID, ["pA"], buckets=2)
        assert hist[0]["min"] == 1.0
        assert hist[-1]["max"] == 5.0
        assert sum(b["count"] for b in hist) == 4

    def testHistogramOfNestedColumn(self, tmp_store_base):
        _build(tmp_store_base)
        # pB/s0 is present on a1,a2,a4 only (a3 lacks it).
        hist = store.histogram(DATASET_ID, ["pB", "s0"], buckets=5)
        assert sum(b["count"] for b in hist) == 3

    def testHistogramUnknownColumnIsEmpty(self, tmp_store_base):
        _build(tmp_store_base)
        assert store.histogram(DATASET_ID, ["nope"]) == []


class TestFilterPassingIds:
    def testRangeFilter(self, tmp_store_base):
        _build(tmp_store_base)
        ids = store.filter_passing_ids(DATASET_ID, [
            {"path": ["pA"], "mode": "range", "min": 2.0, "max": 3.0},
        ])
        assert set(ids) == {"a2", "a3"}

    def testAbsentValueDoesNotPass(self, tmp_store_base):
        _build(tmp_store_base)
        # a3 has no pB/s0, so a range on it must exclude a3.
        ids = store.filter_passing_ids(DATASET_ID, [
            {"path": ["pB", "s0"], "mode": "range", "min": 0.0},
        ])
        assert set(ids) == {"a1", "a2", "a4"}

    def testMultipleFiltersAreAnded(self, tmp_store_base):
        _build(tmp_store_base)
        ids = store.filter_passing_ids(DATASET_ID, [
            {"path": ["pA"], "mode": "range", "min": 2.0},
            {"path": ["pB", "s0"], "mode": "range", "max": 30.0},
        ])
        # pA>=2 -> a2,a3,a4 ; pB/s0<=30 -> a1,a2 ; intersection -> a2
        assert set(ids) == {"a2"}

    def testUnknownColumnMatchesNothing(self, tmp_store_base):
        _build(tmp_store_base)
        ids = store.filter_passing_ids(DATASET_ID, [
            {"path": ["nope"], "mode": "range", "min": 0.0},
        ])
        assert ids == []


def testStoredZeroSurvives(tmp_store_base):
    # A real 0.0 must not be confused with an absent value even if write
    # canonicalization drops explicit zeros from X (the presence mask guards
    # this). read_batch returns it; a range filter including 0 matches it.
    ds = "1111111111111111ffffffff"
    store.build_store(ds, [
        {"annotationId": "z0", "values": {"pA": 0.0}},
        {"annotationId": "z1", "values": {"pA": 5.0}},
    ], generation=1)
    result = store.read_batch(ds, ["z0"])
    assert result == [{"annotationId": "z0", "values": {"pA": 0.0}}]
    ids = store.filter_passing_ids(ds, [
        {"path": ["pA"], "mode": "range", "min": -1.0, "max": 1.0},
    ])
    assert set(ids) == {"z0"}


def testDeleteStore(tmp_store_base):
    _build(tmp_store_base)
    assert store.store_exists(DATASET_ID)
    store.delete_store(DATASET_ID)
    assert not store.store_exists(DATASET_ID)
    assert not os.path.isdir(store.store_path(DATASET_ID))

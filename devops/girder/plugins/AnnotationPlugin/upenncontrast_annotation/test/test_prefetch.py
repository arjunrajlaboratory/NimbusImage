import threading
import time

import bson
import pytest

from upenncontrast_annotation.server.helpers import aggregation


class FakeRawCursor:
    """A raw-batch cursor: iterates BSON batches and records close()."""

    def __init__(self, batches, failAfter=None, failClose=False):
        self._batches = batches
        self._failAfter = failAfter
        self._failClose = failClose
        self.closed = False
        self.fetched = 0

    def __iter__(self):
        for index, batch in enumerate(self._batches):
            if self._failAfter is not None and index == self._failAfter:
                raise RuntimeError("cursor died")
            self.fetched += 1
            yield batch

    def close(self):
        self.closed = True
        if self._failClose:
            raise OSError("close failed")


def rawBatches(sizes):
    counter = iter(range(10 ** 6))
    return [
        b"".join(bson.encode({"n": next(counter)}) for _ in range(size))
        for size in sizes
    ]


def waitFor(condition, timeout=5):
    deadline = time.monotonic() + timeout
    while not condition() and time.monotonic() < deadline:
        time.sleep(0.01)
    return condition()


def testDocumentsComeBackInCursorOrder():
    cursor = FakeRawCursor(rawBatches([3, 0, 5, 1, 4]))
    documents = list(aggregation.prefetchedDocuments(
        cursor, bson.DEFAULT_CODEC_OPTIONS, depth=1
    ))
    assert [document["n"] for document in documents] == list(range(13))
    assert waitFor(lambda: cursor.closed)


def testFetchErrorIsRaisedInTheConsumer():
    cursor = FakeRawCursor(rawBatches([2, 2, 2]), failAfter=2)
    documents = aggregation.prefetchedDocuments(
        cursor, bson.DEFAULT_CODEC_OPTIONS
    )
    seen = []
    with pytest.raises(RuntimeError, match="cursor died"):
        for document in documents:
            seen.append(document["n"])
    assert seen == [0, 1, 2, 3]
    assert cursor.closed


def testCloseErrorAfterACleanRunIsRaisedInTheConsumer():
    """A close failure must not leave the consumer waiting for an end that
    never comes."""
    cursor = FakeRawCursor(rawBatches([2, 1]), failClose=True)
    documents = aggregation.prefetchedDocuments(
        cursor, bson.DEFAULT_CODEC_OPTIONS
    )
    seen = []
    with pytest.raises(OSError, match="close failed"):
        for document in documents:
            seen.append(document["n"])
    assert seen == [0, 1, 2]


def testFetchErrorWinsOverACloseError():
    cursor = FakeRawCursor(
        rawBatches([2, 2]), failAfter=1, failClose=True
    )
    documents = aggregation.prefetchedDocuments(
        cursor, bson.DEFAULT_CODEC_OPTIONS
    )
    with pytest.raises(RuntimeError, match="cursor died"):
        list(documents)
    assert cursor.closed


def testClosingEarlyStopsTheThreadAndClosesTheCursor(monkeypatch):
    monkeypatch.setattr(aggregation, "_PREFETCH_POLL_SECONDS", 0.01)
    cursor = FakeRawCursor(rawBatches([1] * 50))
    before = threading.active_count()
    documents = aggregation.prefetchedDocuments(
        cursor, bson.DEFAULT_CODEC_OPTIONS, depth=2
    )
    assert next(documents)["n"] == 0
    documents.close()
    assert waitFor(lambda: cursor.closed)
    assert waitFor(lambda: threading.active_count() <= before)
    # It stopped at the prefetch depth, not after reading everything.
    assert cursor.fetched < 10


def testNothingStartsUntilIterated():
    cursor = FakeRawCursor(rawBatches([1]))
    aggregation.prefetchedDocuments(cursor, bson.DEFAULT_CODEC_OPTIONS)
    time.sleep(0.05)
    assert cursor.fetched == 0

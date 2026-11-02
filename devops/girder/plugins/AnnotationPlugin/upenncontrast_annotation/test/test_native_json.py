"""Raw BSON batches to JSON (serialization.rawBatchJson / streamRawJsonArray,
the bson_json_native transcoder) must give byte for byte what the orjson
path gives: `orjson.dumps(doc, default=orJsonDefaults)` per decoded doc.

Tests that need the transcoder skip without it. `tox -e native` builds it
and sets NIMBUS_REQUIRE_NATIVE_JSON, which turns those skips into failures
(a wheel that builds but doesn't import must not pass as "skipped"). The
rest run either way: without the transcoder they check the Python fallback,
with it the native path through the same helpers.
"""
import datetime
import json
import os
import random
import struct
import threading
import time

import bson
import orjson
import pytest
from bson import Binary, Code, Decimal128, MaxKey, MinKey, Regex
from bson.codec_options import CodecOptions
from bson.int64 import Int64
from bson.objectid import ObjectId
from bson.son import SON
from bson.timestamp import Timestamp
from girder.models import model_base
from pytest_girder.assertions import assertStatusOk

from upenncontrast_annotation.server.helpers import aggregation, serialization
from upenncontrast_annotation.server.helpers.serialization import (
    orJsonDefaults,
    rawBatchJson,
    streamJsonArray,
    streamRawJsonArray,
)
from upenncontrast_annotation.server.models.annotation import Annotation

from . import girder_utilities as utilities
from . import upenn_testing_utilities as upenn_utilities

REQUIRE_NATIVE = os.environ.get("NIMBUS_REQUIRE_NATIVE_JSON") == "1"

# Girder's MongoClient decodes with these (tz_aware, UTC);
# testGirderCodecOptionsUseTheTranscoder checks they still do.
GIRDER_CODEC = CodecOptions(tz_aware=True, tzinfo=datetime.timezone.utc)

EDGE_FLOATS = [
    0.0, -0.0, 1.0, -1.0, 0.1, 0.5, 1 / 3, 10.0, 1234.5, 1e15, 1e16, 1e17,
    9999999999999998.0, 1e21, 1e22, 1e23, 1.5e300, 1e-4, 1e-5, 1e-6, 1e-7,
    1.2345e-7, 0.000123, 5e-324, 2.2250738585072014e-308,
    1.7976931348623157e308, 9007199254740993.0, 123456789012345680.0,
    0.30000000000000004, float("nan"), float("inf"), float("-inf"), -1e-7,
    -1e16, 29999.99999,
]

STRINGS = [
    "", "plain", 'quote " here', "back\\slash", "slash / here",
    "".join(chr(c) for c in range(0x20)), "\x7f del", "café",
    "  ", "\U0001f9ea emoji", "﻿ bom", "中文",
    "</script>", "a" * 300,
]


def expectedJson(batch):
    """The orjson path: decode, then orjson each document."""
    return b",".join(
        orjson.dumps(document, default=orJsonDefaults)
        for document in bson.decode_all(batch, codec_options=GIRDER_CODEC)
    )


def encodeAll(documents):
    return b"".join(bson.encode(document) for document in documents)


def annotationDocuments(rng, count):
    documents = []
    for index in range(count):
        coordinates = [
            {"x": rng.uniform(0, 30000), "y": rng.uniform(0, 30000)}
            for _ in range(rng.choice([0, 1, 4, 25]))
        ]
        if index % 5 == 0:
            for coordinate in coordinates:
                coordinate["z"] = rng.choice([0, 0.5, 3.0])
        documents.append({
            "_id": ObjectId(),
            "tags": ["cell", rng.choice(STRINGS)],
            "shape": "polygon",
            "channel": index % 3,
            "location": {"XY": 0, "Z": index, "Time": 0},
            "coordinates": coordinates,
            "datasetId": ObjectId(),
        })
    return documents


def edgeDocuments():
    return [
        {"f": EDGE_FLOATS},
        {
            "_id": ObjectId("000000000000000000000000"),
            "s": STRINGS,
            'k"ey\\with\n': "escaped key",
            "été": "non-ascii key",
        },
        {
            "i32": [0, 1, -1, 2 ** 31 - 1, -2 ** 31],
            "i64": [Int64(0), Int64(2 ** 63 - 1), Int64(-2 ** 63), 2 ** 40],
            "mixed": {"t": True, "f": False, "n": None, "e": {}, "a": []},
            "nested": [[1, [2.5, {"x": [None]}]], {"y": {"z": {"w": []}}}],
        },
        {},
    ]


def randomFloats(rng, count):
    values = []
    for _ in range(count):
        kind = rng.random()
        if kind < 0.4:
            values.append(struct.unpack("<d", rng.randbytes(8))[0])
        elif kind < 0.8:
            values.append(round(rng.uniform(0, 30000), rng.randint(0, 15)))
        else:
            values.append(
                rng.uniform(-1, 1) * 10.0 ** rng.randint(-320, 308)
            )
    return values


def withDuplicateKey():
    """{"a": 1, "a": 2}: bson.encode can't write a repeated key."""
    raw = bson.encode({"a": 1, "b": 2})
    return raw.replace(b"\x10b\x00", b"\x10a\x00")


def rawElement(elementType, payload):
    """A one-element document {"v": <payload>} of the given BSON type."""
    body = bytes([elementType]) + b"v\x00" + payload + b"\x00"
    return struct.pack("<i", len(body) + 4) + body


def unsupportedBatches():
    """One document per BSON type the transcoder refuses, each preceded by
    a plain document so the fallback has to redo a whole batch."""
    values = {
        "datetime": datetime.datetime(2024, 1, 2, 3, 4, 5, 123000),
        "binary": Binary(b"\x00\x01", 0),
        "binaryUuid": Binary(b"\x00" * 16, 4),
        "code": Code("x = 1"),
        "decimal128": Decimal128("1.5"),
        "regex": Regex("a.*", "i"),
        "timestamp": Timestamp(1, 2),
        "minkey": MinKey(),
        "maxkey": MaxKey(),
    }
    batches = {
        name: bson.encode({"ok": 1}) + bson.encode({"_id": ObjectId(), "v": v})
        for name, v in values.items()
    }
    # Types Python can't encode: symbol (decodes to str), undefined (None).
    batches["symbol"] = rawElement(0x0E, struct.pack("<i", 4) + b"sym\x00")
    batches["undefined"] = rawElement(0x06, b"")
    batches["duplicateKey"] = withDuplicateKey()
    # pymongo decodes an embedded {$ref, $id} to a DBRef (orjson can't
    # serialize it); at the top level it stays a dict.
    batches["dbref"] = bson.encode(
        {"p": [{"$ref": "c", "$id": 5, "x": 1}]}
    )
    batches["dbrefTopLevel"] = bson.encode({"$ref": "c", "$id": 5})
    nested = {}
    for _ in range(120):
        nested = {"a": nested}
    batches["deeperThanMongo"] = bson.encode(nested)
    return batches


class FakeRawCursor:
    def __init__(self, batches):
        self._batches = batches
        self.closed = False

    def __iter__(self):
        return iter(self._batches)

    def close(self):
        self.closed = True


def requireTranscoder():
    if serialization.bson_json_native is None:
        if REQUIRE_NATIVE:
            pytest.fail("bson_json_native did not import")
        pytest.skip("bson_json_native is not installed")
    return serialization.bson_json_native


def waitFor(condition, timeout=5):
    deadline = time.monotonic() + timeout
    while not condition() and time.monotonic() < deadline:
        time.sleep(0.01)
    return condition()


@pytest.fixture
def transcoder():
    return requireTranscoder()


@pytest.fixture(params=["installed", "missing"])
def eitherPath(request, monkeypatch):
    """Run a test with the transcoder (if built) and without it."""
    if request.param == "missing":
        monkeypatch.setattr(serialization, "bson_json_native", None)
    else:
        requireTranscoder()
    return request.param


class TestTranscoder:
    def testAnnotationsMatchOrjson(self, transcoder):
        batch = encodeAll(annotationDocuments(random.Random(1), 300))
        assert transcoder.transcode(batch) == expectedJson(batch)

    def testEdgeCasesMatchOrjson(self, transcoder):
        for document in edgeDocuments():
            batch = bson.encode(document)
            assert transcoder.transcode(batch) == expectedJson(batch)

    def testFloatSweepMatchesOrjson(self, transcoder):
        """Float formatting is the subtle part (orjson writes ryu's
        shortest digits with "+" before positive exponents)."""
        rng = random.Random(7)
        batch = encodeAll(
            {"v": randomFloats(rng, 1000)} for _ in range(300)
        )
        assert transcoder.transcode(batch) == expectedJson(batch)

    def testEmptyBatch(self, transcoder):
        assert transcoder.transcode(b"") == b""

    def testRefusesWhatItCannotRenderExactly(self, transcoder):
        for name, batch in unsupportedBatches().items():
            if name == "dbrefTopLevel":
                # Not a DBRef to pymongo either: rendered, and identical.
                assert transcoder.transcode(batch) == expectedJson(batch)
                continue
            with pytest.raises(ValueError):
                transcoder.transcode(batch)

    def testRefusesMalformedBson(self, transcoder):
        batch = bson.encode({"a": 1})
        for bad in (batch[:-1], batch + b"\x01", b"\x05\x00\x00\x00\x01"):
            with pytest.raises(ValueError):
                transcoder.transcode(bad)


class TestRawBatchJson:
    def testMatchesOrjson(self, eitherPath):
        rng = random.Random(3)
        for batch in (
            encodeAll(annotationDocuments(rng, 50)),
            encodeAll(edgeDocuments()),
            encodeAll({"v": randomFloats(rng, 1000)} for _ in range(5)),
            b"",
        ):
            assert rawBatchJson(batch, GIRDER_CODEC) == expectedJson(batch)

    def testUnsupportedTypesFallBackToTheSameBytes(self, eitherPath):
        """A datetime (or any type the transcoder refuses) sends its batch
        through decode + orjson, so the bytes still match."""
        for name, batch in unsupportedBatches().items():
            try:
                expected = expectedJson(batch)
            except TypeError:
                # orjson can't serialize it either (binary, decimal128,
                # regex, ...): the response fails the same way as before.
                with pytest.raises(TypeError):
                    rawBatchJson(batch, GIRDER_CODEC)
                continue
            assert rawBatchJson(batch, GIRDER_CODEC) == expected, name
        assert b'"2024-01-02T03:04:05.123000+00:00"' in rawBatchJson(
            unsupportedBatches()["datetime"], GIRDER_CODEC
        )

    def testOtherCodecOptionsSkipTheTranscoder(self, monkeypatch):
        """Options that change what decode_all builds (SON documents, type
        decoders) must not reach the transcoder."""
        class Refuses:
            @staticmethod
            def transcode(batch):
                raise AssertionError("transcoder used")

        monkeypatch.setattr(serialization, "bson_json_native", Refuses)
        batch = encodeAll(edgeDocuments())
        codec = CodecOptions(document_class=SON)
        assert rawBatchJson(batch, codec) == b",".join(
            orjson.dumps(document, default=orJsonDefaults)
            for document in bson.decode_all(batch, codec_options=codec)
        )
        with pytest.raises(AssertionError, match="transcoder used"):
            rawBatchJson(batch, GIRDER_CODEC)


class TestStreamRawJsonArray:
    def testSameBytesAsStreamJsonArray(self, eitherPath):
        rng = random.Random(5)
        documents = annotationDocuments(rng, 120)
        batches = [
            encodeAll(documents[:1]), b"", encodeAll(documents[1:70]),
            unsupportedBatches()["datetime"], encodeAll(documents[70:]),
        ]
        decoded = [
            document for batch in batches
            for document in bson.decode_all(batch, codec_options=GIRDER_CODEC)
        ]
        cursor = FakeRawCursor(batches)
        for prefix, suffix in ((b"[", b"]"), (b'{"rows":[', b"]}")):
            cursor = FakeRawCursor(batches)
            raw = b"".join(streamRawJsonArray(
                cursor, GIRDER_CODEC, prefix=prefix, suffix=suffix
            )())
            assert raw == b"".join(streamJsonArray(
                decoded, prefix=prefix, suffix=suffix, default=orJsonDefaults
            )())
            assert cursor.closed

    def testEmpty(self, eitherPath):
        for batches in ([], [b""], [b"", b""]):
            assert b"".join(streamRawJsonArray(
                FakeRawCursor(batches), GIRDER_CODEC
            )()) == b"[]"

    def testClosingEarlyClosesTheCursor(self, eitherPath):
        cursor = FakeRawCursor([bson.encode({"a": 1})] * 3)
        stream = streamRawJsonArray(cursor, GIRDER_CODEC)()
        assert next(stream) == b"["
        stream.close()
        assert cursor.closed

    def testClosingEarlyThroughPrefetchStopsTheThread(
        self, eitherPath, monkeypatch
    ):
        """The endpoints' composition: a dropped response stops the prefetch
        thread and closes the Mongo cursor."""
        monkeypatch.setattr(aggregation, "_PREFETCH_POLL_SECONDS", 0.01)
        cursor = FakeRawCursor([bson.encode({"a": i}) for i in range(50)])
        before = threading.active_count()
        stream = streamRawJsonArray(
            aggregation.prefetchedBatches(cursor, depth=2), GIRDER_CODEC
        )()
        assert next(stream) == b"["
        assert next(stream) == b'{"a":0}'
        stream.close()
        assert waitFor(lambda: cursor.closed)
        assert waitFor(lambda: threading.active_count() <= before)


def oldPathBody(documents, prefix=b"[", suffix=b"]"):
    """The response body before raw batches: streamJsonArray over
    decoded documents."""
    return b"".join(streamJsonArray(
        documents, prefix=prefix, suffix=suffix, default=orJsonDefaults
    )())


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestEndpointsServeTheSameBytes:
    """find, hydrate and stubs return what the orjson path returned.
    250 annotations span more than one raw batch (the first holds 101)."""

    def makeDataset(self, admin, withDatetime=False):
        folder = utilities.createFolder(
            admin, "native_json", upenn_utilities.datasetMetadata
        )
        rng = random.Random(11)
        annotations = []
        for index in range(250):
            annotation = upenn_utilities.getSampleAnnotation(folder["_id"])
            annotation["shape"] = "polygon" if index % 2 else "point"
            annotation["tags"] = ["cell", STRINGS[index % len(STRINGS)]]
            annotation["coordinates"] = [
                {"x": value, "y": rng.uniform(0, 30000), "z": 0}
                for value in rng.sample(EDGE_FLOATS[:28], 4)
            ]
            annotations.append(annotation)
        Annotation().createMultiple(annotations)
        if withDatetime:
            # Not a field annotations carry; inserted directly to send one
            # batch through the fallback, as any unexpected type would.
            Annotation().collection.update_one(
                {"datasetId": folder["_id"]},
                {"$set": {"reviewed": datetime.datetime(2024, 5, 6, 7, 8)}},
            )
        return folder

    def testFind(self, admin, server, eitherPath):
        folder = self.makeDataset(admin, withDatetime=True)
        for params in (
            {},
            {"limit": 0},
            {"limit": 120, "offset": 30},
            {"shape": "polygon", "limit": 0},
            {"tags": json.dumps(["cell", "plain"]), "limit": 0},
            {"limit": 0, "sort": "_id", "sortdir": -1},
        ):
            resp = server.request(
                path="/upenn_annotation", method="GET", user=admin,
                params={"datasetId": str(folder["_id"]), **params},
                isJson=False,
            )
            assertStatusOk(resp)
            query = {"datasetId": folder["_id"]}
            if "shape" in params:
                query["shape"] = params["shape"]
            if "tags" in params:
                query["tags"] = {"$all": json.loads(params["tags"])}
            expected = Annotation().find(
                query,
                sort=[("_id", params.get("sortdir", 1))],
                limit=params.get("limit", 50),
                offset=params.get("offset", 0),
            ).hint([("datasetId", 1), ("_id", 1)])
            body = b"".join(resp.body)
            assert body == oldPathBody(expected), params
            assert len(json.loads(body)) > 0

    def testHydrate(self, admin, server, eitherPath):
        folder = self.makeDataset(admin, withDatetime=True)
        ids = [
            document["_id"] for document in
            Annotation().find({"datasetId": folder["_id"]})
        ][::2]
        resp = server.request(
            path="/upenn_annotation/hydrate", method="POST", user=admin,
            body=json.dumps([str(i) for i in ids]),
            type="application/json", isJson=False,
        )
        assertStatusOk(resp)
        expected = Annotation().find({"_id": {"$in": ids}})
        body = b"".join(resp.body)
        assert body == oldPathBody(expected)
        assert len(json.loads(body)) == len(ids)

    def testStubs(self, admin, server, eitherPath):
        folder = self.makeDataset(admin)
        for params in ({}, {"shape": "point"}):
            resp = server.request(
                path="/upenn_annotation/stubs", method="GET", user=admin,
                params={"datasetId": str(folder["_id"]), **params},
                isJson=False,
            )
            assertStatusOk(resp)
            expected = Annotation().stubs(folder["_id"], **params)
            body = b"".join(resp.body)
            assert body == oldPathBody(expected)
            assert len(json.loads(body)) == (125 if params else 250)


CURSOR_SPEC = (
    "_spec", "_projection", "_skip", "_limit", "_ordering", "_max_time_ms",
    "_query_flags", "_cursor_type",
)


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestFindRawBatches:
    def testGirderCodecOptionsUseTheTranscoder(self, admin):
        """If Girder's client options ever stop passing the gate, every read
        silently drops to the ~4x slower Python path; fail here instead."""
        codec = Annotation().collection.codec_options
        assert serialization._transcoderMatches(codec)
        assert codec == GIRDER_CODEC

    def testFindRawBatchesMatchesFind(self, admin, monkeypatch):
        """findRawBatches repeats what Girder's Model.find adds (timeouts,
        allowed extra arguments, projection). If Girder's find changes,
        this fails."""
        model = Annotation()
        cases = [
            {},
            {"query": {"shape": "polygon"}, "offset": 3, "limit": 7,
             "sort": [("_id", -1)], "fields": ["shape"]},
            {"timeout": 1234, "fields": {"coordinates": 0}},
            {"allow_partial_results": True, "notAllowed": 1},
        ]
        for timeoutDefault in (None, 5000):
            monkeypatch.setattr(
                model_base, "_MAX_CURSOR_TIMEOUT_MS", timeoutDefault
            )
            for kwargs in cases:
                kwargs = dict(kwargs)
                if "notAllowed" in kwargs:
                    # Girder drops unknown arguments; so must we.
                    kwargs["batch_size"] = kwargs.pop("notAllowed")
                plain = model.find(**kwargs)
                raw = model.findRawBatches(**kwargs)
                for name in CURSOR_SPEC:
                    assert getattr(raw, name) == getattr(plain, name), (
                        name, kwargs, timeoutDefault
                    )

    def testFindRawBatchesReturnsTheSameDocuments(self, admin):
        folder = utilities.createFolder(
            admin, "raw_batches", upenn_utilities.datasetMetadata
        )
        Annotation().createMultiple([
            upenn_utilities.getSampleAnnotation(folder["_id"])
            for _ in range(5)
        ])
        query = {"datasetId": folder["_id"]}
        raw = [
            document
            for batch in Annotation().findRawBatches(query, sort=[("_id", 1)])
            for document in bson.decode_all(
                batch, codec_options=Annotation().collection.codec_options
            )
        ]
        assert raw == list(Annotation().find(query, sort=[("_id", 1)]))
        assert len(raw) == 5

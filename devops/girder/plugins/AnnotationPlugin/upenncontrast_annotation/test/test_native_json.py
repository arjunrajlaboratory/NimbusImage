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
from upenncontrast_annotation.server.helpers import valueProviders
from upenncontrast_annotation.server.models.annotation import Annotation
from upenncontrast_annotation.server.models.connections import (
    AnnotationConnection,
)
from upenncontrast_annotation.server.models import (
    propertyValues as propertyValuesModule,
)
from upenncontrast_annotation.server.models.propertyValues import (
    AnnotationPropertyValues,
)

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


def wideDocument(width, repeatAt=None):
    """{"values": {<width> property-id-like keys}}, the shape of a gene panel
    stored under one property; with repeatAt, the key at that position
    appears a second time at the end (bson.encode can't write that)."""
    keys = ["6a18de9586eb3776%08x" % i for i in range(width)]
    raw = bson.encode({"values": {key: 1.5 + i for i, key in enumerate(keys)}})
    if repeatAt is None:
        return raw
    extra = bson.encode({"values": {"zzzzzzzzzzzzzzzzzzzzzzzz": -1.0}})
    # Append one more element (a double, copied from a second encoded
    # document) to the values subdocument, renamed to the repeated key.
    element = extra[extra.index(b"\x01zzzz"):-2]
    element = element.replace(
        b"zzzzzzzzzzzzzzzzzzzzzzzz", keys[repeatAt].encode()
    )
    values = raw[raw.index(b"\x03values\x00") + 8:-1]
    body = values[4:-1] + element
    values = struct.pack("<i", len(body) + 5) + body + b"\x00"
    top = b"\x03values\x00" + values + b"\x00"
    return struct.pack("<i", len(top) + 4) + top


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

    def testWideDocumentsMatchOrjson(self, transcoder):
        """Levels on both sides of the transcoder's switch from a linear
        repeated-key scan to a hash set (32 keys), and far past it."""
        for width in (31, 32, 33, 2000):
            batch = wideDocument(width) * 3
            assert transcoder.transcode(batch) == expectedJson(batch), width
        # (31, 0) and (32, 31): the repeat is caught by the linear scan,
        # before or exactly at the switch; the rest after it, including a
        # repeat of the key that triggers the switch (40, 32).
        for width, repeatAt in (
            (31, 0), (32, 31), (40, 0), (40, 32), (2000, 1999),
        ):
            batch = wideDocument(width, repeatAt)
            assert bson.decode(batch)["values"][
                "6a18de9586eb3776%08x" % repeatAt
            ] == -1.0
            with pytest.raises(ValueError):
                transcoder.transcode(batch)
            # The refused batch falls back to the same bytes as orjson.
            assert rawBatchJson(batch, GIRDER_CODEC) == expectedJson(batch)

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


def girderEncoded(value):
    """What Girder's own response encoder wrote: the batch endpoint's bytes
    before this change (sort_keys, stdlib json; Infinity was a 500)."""
    from girder.api.rest import JsonEncoder
    return json.dumps(value, sort_keys=True, allow_nan=False, cls=JsonEncoder)


class StoredPlusOne:
    """A value provider (virtual path "plusone.x") for the batch fallback."""

    def valuesForIds(self, datasetId, path, annotationIds):
        if path[1] != "x":
            raise ValueError("unknown key %r" % path[1])
        return [len(annotationId) + 1 for annotationId in annotationIds]


@pytest.fixture
def plusOneProvider():
    valueProviders.registerValueProvider("plusone", StoredPlusOne())
    yield
    valueProviders._providers.pop("plusone", None)


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestValueAndConnectionEndpointsServeTheSameBytes:
    """Property values (find, batch) and connections (find) return what the
    orjson path returned. 250 documents span more than one raw batch."""

    def makeDataset(self, admin, withInfinity=False, withDatetime=False):
        folder = utilities.createFolder(
            admin, "native_json_values", upenn_utilities.datasetMetadata
        )
        annotations = Annotation().createMultiple([
            upenn_utilities.getSampleAnnotation(folder["_id"])
            for _ in range(250)
        ])
        rng = random.Random(13)
        entries = []
        for index, annotation in enumerate(annotations):
            values = {
                "area": {"mean": rng.uniform(0, 1e4), "count": index},
                "intensity": rng.choice(EDGE_FLOATS[:28]),
                "label": STRINGS[index % len(STRINGS)],
            }
            if index % 3:
                values["gene"] = {"CD3E": rng.random(), "PTPRC": 1e-7}
            entries.append({
                "datasetId": folder["_id"],
                "annotationId": annotation["_id"],
                "values": values,
            })
        if withInfinity:
            entries[5]["values"]["intensity"] = float("inf")
        AnnotationPropertyValues().appendMultipleValues(entries)
        if withDatetime:
            # Not a value the schema accepts; set directly to send one raw
            # batch through the Python fallback, as any unexpected type
            # would.
            AnnotationPropertyValues().collection.update_one(
                {"annotationId": annotations[7]["_id"]},
                {"$set": {"values.reviewed": datetime.datetime(2024, 5, 6)}},
            )
        self.entries = {
            entry["annotationId"]: entry["values"] for entry in entries
        }
        AnnotationConnection().createMultiple([
            upenn_utilities.getSampleConnection(
                annotations[i]["_id"], annotations[i + 1]["_id"],
                folder["_id"],
            )
            for i in range(249)
        ])
        return folder, annotations

    def testPropertyValuesFind(self, admin, server, eitherPath):
        folder, _ = self.makeDataset(
            admin, withInfinity=True, withDatetime=True
        )
        for params in (
            {"limit": 0, "sort": "_id"},
            {"limit": 120, "offset": 30, "sort": "_id"},
            {"limit": 0, "sort": "_id", "sortdir": -1},
        ):
            resp = server.request(
                path="/annotation_property_values", method="GET",
                user=admin, isJson=False,
                params={"datasetId": str(folder["_id"]), **params},
            )
            assertStatusOk(resp)
            expected = AnnotationPropertyValues().find(
                {"datasetId": folder["_id"]},
                sort=[("_id", params.get("sortdir", 1))],
                limit=params["limit"], offset=params.get("offset", 0),
            ).hint([("datasetId", 1), ("_id", 1)])
            body = b"".join(resp.body)
            assert body == oldPathBody(expected), params
            assert b"Infinity" not in body

    def testConnectionsFind(self, admin, server, eitherPath):
        folder, _ = self.makeDataset(admin)
        for params in ({"limit": 0, "sort": "_id"},
                       {"limit": 100, "offset": 7, "sort": "_id"}):
            resp = server.request(
                path="/annotation_connection", method="GET", user=admin,
                params={"datasetId": str(folder["_id"]), **params},
                isJson=False,
            )
            assertStatusOk(resp)
            expected = AnnotationConnection().find(
                {"datasetId": folder["_id"]}, sort=[("_id", 1)],
                limit=params["limit"], offset=params.get("offset", 0),
            ).hint([("datasetId", 1), ("_id", 1)])
            body = b"".join(resp.body)
            assert body == oldPathBody(expected), params
            assert len(json.loads(body)) == (params["limit"] or 249)

    def batch(self, server, admin, body):
        resp = server.request(
            path="/annotation_property_values/batch", method="POST",
            user=admin, body=json.dumps(body), type="application/json",
            isJson=False,
        )
        assertStatusOk(resp)
        return b"".join(resp.body)

    def testPropertyValuesBatch(self, admin, server, eitherPath):
        """Same bytes as orjson over findByAnnotationIds, and the same parsed
        value Girder's encoder produced before (key order and spacing are
        all that change)."""
        folder, annotations = self.makeDataset(admin)
        ids = [annotation["_id"] for annotation in annotations][::-2]
        for paths in (None, [["area", "mean"], ["gene"]], [["missing"]]):
            request = {
                "datasetId": str(folder["_id"]),
                "annotationIds": [str(i) for i in ids],
            }
            if paths is not None:
                request["propertyPaths"] = paths
            body = self.batch(server, admin, request)
            documents = AnnotationPropertyValues().findByAnnotationIds(
                folder["_id"], ids, paths
            )
            assert body == oldPathBody(documents), paths
            assert json.loads(body) == json.loads(girderEncoded(documents))
            assert len(json.loads(body)) == len(ids)
        # Independently of findByAnnotationIds (which shares the projection
        # code): the projected values are what was stored.
        byId = {doc["annotationId"]: doc["values"] for doc in json.loads(
            self.batch(server, admin, {
                "datasetId": str(folder["_id"]),
                "annotationIds": [str(i) for i in ids],
                "propertyPaths": [["area", "mean"], ["gene"]],
            })
        )}
        for annotationId in ids:
            stored = self.entries[annotationId]
            expected = {"area": {"mean": stored["area"]["mean"]}}
            if "gene" in stored:
                expected["gene"] = stored["gene"]
            assert byId[str(annotationId)] == expected

    def testPropertyValuesBatchAcrossInChunks(
        self, admin, server, eitherPath, monkeypatch
    ):
        """More ids than one $in holds: the chunks come back in order, on
        both paths."""
        monkeypatch.setattr(propertyValuesModule, "MAX_IDS_PER_QUERY", 7)
        folder, annotations = self.makeDataset(admin, withDatetime=True)
        ids = [annotation["_id"] for annotation in annotations][::-1][:120]
        body = self.batch(server, admin, {
            "datasetId": str(folder["_id"]),
            "annotationIds": [str(i) for i in ids],
        })
        documents = AnnotationPropertyValues().findByAnnotationIds(
            folder["_id"], ids
        )
        assert body == oldPathBody(documents)
        assert sorted(doc["annotationId"] for doc in json.loads(body)) == (
            sorted(str(i) for i in ids)
        )

    def testPropertyValuesBatchOverlappingPathsIs400(self, admin, server):
        """Mongo refuses a projection with a path and its sub-path. The
        response streams, so it must be refused before the 200."""
        folder, annotations = self.makeDataset(admin)
        resp = server.request(
            path="/annotation_property_values/batch", method="POST",
            user=admin, type="application/json", body=json.dumps({
                "datasetId": str(folder["_id"]),
                "annotationIds": [str(annotations[0]["_id"])],
                "propertyPaths": [["area"], ["gene"], ["area", "mean"]],
            }),
        )
        assert resp.status.startswith("400")
        assert "sub-path" in resp.json["message"]

    def testPropertyValuesBatchInfinityIsNull(self, admin, server, eitherPath):
        """Girder's allow_nan=False encoder made a stored Infinity a 500;
        it is now null, as in the list endpoint."""
        folder, annotations = self.makeDataset(admin, withInfinity=True)
        body = self.batch(server, admin, {
            "datasetId": str(folder["_id"]),
            "annotationIds": [str(annotations[5]["_id"])],
        })
        assert json.loads(body)[0]["values"]["intensity"] is None

    def testPropertyValuesBatchWithVirtualPath(
        self, admin, server, eitherPath, plusOneProvider
    ):
        """A virtual path is merged in Python, then written in the same JSON
        form as the raw path."""
        folder, annotations = self.makeDataset(admin)
        ids = [annotation["_id"] for annotation in annotations][:40]
        paths = [["area", "count"], ["plusone", "x"]]
        body = self.batch(server, admin, {
            "datasetId": str(folder["_id"]),
            "annotationIds": [str(i) for i in ids],
            "propertyPaths": paths,
        })
        documents = AnnotationPropertyValues().findByAnnotationIds(
            folder["_id"], ids, paths
        )
        assert body == oldPathBody(documents)
        assert json.loads(body) == json.loads(girderEncoded(documents))
        assert json.loads(body)[0]["values"]["plusone"] == {"x": 25}
        # Virtual paths only: no stored query, provider values only.
        virtualOnly = json.loads(self.batch(server, admin, {
            "datasetId": str(folder["_id"]),
            "annotationIds": [str(i) for i in ids],
            "propertyPaths": [["plusone", "x"]],
        }))
        assert virtualOnly == [
            {"annotationId": str(i), "values": {"plusone": {"x": 25}}}
            for i in ids
        ]
        resp = server.request(
            path="/annotation_property_values/batch", method="POST",
            user=admin, type="application/json", body=json.dumps({
                "datasetId": str(folder["_id"]),
                "annotationIds": [str(ids[0])],
                "propertyPaths": [["plusone", "nope"]],
            }),
        )
        assert resp.status.startswith("400")

    def testPropertyValuesBatchEmpty(self, admin, server, eitherPath):
        folder, _ = self.makeDataset(admin)
        body = self.batch(server, admin, {
            "datasetId": str(folder["_id"]), "annotationIds": [],
        })
        assert json.loads(body) == []


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

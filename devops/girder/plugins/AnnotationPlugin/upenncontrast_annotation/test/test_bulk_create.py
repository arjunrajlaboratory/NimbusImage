"""Bulk-create speedups that must not change behavior.

Two parts of POST /upenn_annotation/multiple were rewritten for speed:

* Schema validation skips fastjsonschema's per-vertex coordinates rule when a
  cheap check proves the coordinates pass (Annotation.validateSchema). The
  equivalence tests below hold it to the compiled full schema: same accepted
  documents, same error (message, path and rule) for every rejected one.
* The created documents are answered through orjson instead of Girder's
  stdlib encoder (createdDocumentsResponse), also for the connection and
  property-value bulk creates. The response tests hold the JSON to what
  Girder's encoder produced for the stored documents.
"""

import copy
import datetime
import json
import random
from collections import OrderedDict
from decimal import Decimal

import fastjsonschema
import pytest

from bson import Binary, Decimal128
from bson.objectid import ObjectId
from girder.utility import JsonEncoder
from pytest_girder.assertions import assertStatusOk
from pytest_girder.utils import getResponseBody

from upenncontrast_annotation.server.helpers.serialization import (
    createdDocumentsResponse,
)
from upenncontrast_annotation.server.models.annotation import (
    Annotation,
    AnnotationSchema,
    coordinatesMatchSchema,
)
from upenncontrast_annotation.server.models.connections import (
    AnnotationConnection,
)
from upenncontrast_annotation.server.models.propertyValues import (
    AnnotationPropertyValues,
)

from . import girder_utilities as utilities
from . import upenn_testing_utilities as upenn_utilities


VALID_ANNOTATION = {
    "name": "cell",
    "coordinates": [{"x": 1.5, "y": 2}, {"x": 3, "y": 4.25}],
    "tags": ["nucleus"],
    "channel": 0,
    "location": {"XY": 0, "Z": 0, "Time": 0},
    "shape": "polygon",
    "datasetId": ObjectId(),
}


class IntSubclass(int):
    pass


class DictSubclass(dict):
    pass


# Every shape of coordinates value worth distinguishing: the fast path's
# exact-type tests must never accept one the schema rejects, and anything it
# declines must still get the schema's own verdict and message.
COORDINATE_VARIANTS = [
    [{"x": 1, "y": 2}],
    [{"x": 1.0, "y": -2.5}],
    [{"x": 1, "y": 2, "z": 3}],
    [{"x": 1, "y": 2, "z": 3.5}],
    [{"x": 1, "y": 2, "label": "extra keys are allowed"}],
    [{"x": 1, "y": 2, "z": 0, "w": None}],
    [{"x": float("inf"), "y": float("-inf")}],
    [{"x": float("nan"), "y": 0}],
    [{"x": 10 ** 30, "y": 0}],
    [{"x": 1, "y": 2}] * 50,
    [],
    None,
    "not a list",
    {"x": 1, "y": 2},
    ({"x": 1, "y": 2},),
    [None],
    [[1, 2]],
    ["x"],
    [{"x": 1}],
    [{"y": 1}],
    [{}],
    [{"x": None, "y": 1}],
    [{"x": "1", "y": 1}],
    [{"x": 1, "y": "2"}],
    [{"x": True, "y": 1}],
    [{"x": 1, "y": False}],
    [{"x": 1, "y": 2, "z": None}],
    [{"x": 1, "y": 2, "z": "0"}],
    [{"x": 1, "y": 2, "z": True}],
    [{"x": [1], "y": 2}],
    [{"x": {"v": 1}, "y": 2}],
    [{"x": Decimal("1.5"), "y": 2}],
    [{"x": IntSubclass(1), "y": 2}],
    [DictSubclass(x=1, y=2)],
    [OrderedDict(x=1, y=2)],
    [{"x": 1, "y": 2}, {"x": 1, "y": "bad"}],
    [{"x": 1, "y": 2}, None],
    [{"x": 1, "y": 2}, {"x": 3}],
    [{"x": 1, "y": 2}, {"x": 1, "y": 2, "z": False}],
]

# Ways to break the rest of the document, so the tests also cover which
# error wins when the coordinates are fine but something else is not
# (including "name", which the schema checks before coordinates).
DOCUMENT_MUTATIONS = [
    lambda doc: None,
    lambda doc: doc.pop("tags"),
    lambda doc: doc.pop("coordinates"),
    lambda doc: doc.update(name=5),
    lambda doc: doc.update(tags="nucleus"),
    lambda doc: doc.update(tags=[1]),
    lambda doc: doc.update(channel=1.5),
    lambda doc: doc.update(channel=True),
    lambda doc: doc.update(location={"XY": "0"}),
    lambda doc: doc.update(shape="circle"),
    lambda doc: doc.update(datasetId="not an id"),
    lambda doc: doc.update(color=3),
    lambda doc: doc.update(color=None),
    lambda doc: doc.update(geometryHash=None),
    lambda doc: doc.update(extra={"anything": [1, 2]}),
]


def schemaOutcome(validate, document):
    """What a validator does with `document`: the value it returns, or the
    message, path and rule of the error it raises."""
    try:
        return ("accepted", validate(copy.deepcopy(document)))
    except fastjsonschema.JsonSchemaValueException as error:
        return ("rejected", error.message, error.name, error.rule)


def assertSameOutcome(document):
    assert schemaOutcome(Annotation.validateSchema, document) == (
        schemaOutcome(Annotation.jsonValidate, document)
    ), document


class TestAnnotationSchemaFastPath:
    def testFastPathMatchesFullSchemaForEveryVariant(self):
        for coordinates in COORDINATE_VARIANTS:
            for mutate in DOCUMENT_MUTATIONS:
                document = copy.deepcopy(VALID_ANNOTATION)
                document["coordinates"] = coordinates
                mutate(document)
                assertSameOutcome(document)

    def testFastPathMatchesFullSchemaForNonObjects(self):
        for document in (None, [], "annotation", 3, [VALID_ANNOTATION]):
            assertSameOutcome(document)

    def testFastPathNeverAcceptsWhatTheSchemaRejects(self):
        """coordinatesMatchSchema may decline valid coordinates (the full
        validator then decides) but must never pass invalid ones."""
        coordsValidator = fastjsonschema.compile(AnnotationSchema.coordsSchema)
        for coordinates in COORDINATE_VARIANTS:
            if coordinatesMatchSchema(coordinates):
                coordsValidator(coordinates)

    def testCoordinatesSchemaIsTheShapeTheFastPathEncodes(self):
        """coordinatesMatchSchema hand-codes these rules. Any new rule on a
        coordinate (a minimum, additionalProperties) must be added there
        too, or the fast path would pass what the schema now rejects."""
        assert AnnotationSchema.coordsSchema == {
            "type": "array", "items": AnnotationSchema.coordSchema,
            "minItems": 1,
        }
        assert AnnotationSchema.coordSchema == {
            "type": "object",
            "properties": {
                "x": {"type": "number"},
                "y": {"type": "number"},
                "z": {"type": "number"},
            },
            "name": "Coordinate",
            "description": "GeoJS point",
            "required": ["x", "y"],
        }
        assert AnnotationSchema.annotationSchema["properties"][
            "coordinates"] is AnnotationSchema.coordsSchema

    def testFastPathMatchesFullSchemaOnRandomDocuments(self):
        """Seeded fuzz over the value kinds a JSON body can carry, placed
        anywhere in the coordinates or the rest of the document."""
        rng = random.Random(1389)
        values = [
            0, -7, 2.5, float("inf"), True, False, None, "s", "",
            [], {}, [1], {"x": 1}, Decimal("2"), IntSubclass(3),
        ]

        def numberOrJunk():
            if rng.random() < 0.05:
                return rng.choice(values)
            return rng.uniform(-1e4, 1e4)

        def randomCoordinate():
            if rng.random() < 0.02:
                return rng.choice(values)
            coordinate = {}
            for key, presence in (("x", 0.97), ("y", 0.97), ("z", 0.3),
                                  ("w", 0.3)):
                if rng.random() < presence:
                    coordinate[key] = numberOrJunk()
            return coordinate

        accepted = 0
        for _ in range(4000):
            document = copy.deepcopy(VALID_ANNOTATION)
            document["coordinates"] = [
                randomCoordinate() for _ in range(rng.randint(0, 6))
            ]
            if rng.random() < 0.3:
                key = rng.choice(sorted(VALID_ANNOTATION))
                document[key] = rng.choice(values)
            outcome = schemaOutcome(Annotation.validateSchema, document)
            accepted += outcome[0] == "accepted"
            assert outcome == schemaOutcome(
                Annotation.jsonValidate, document
            ), document
        # The corpus exercises both verdicts, not just one.
        assert 400 < accepted < 3600

    def testRealPolygonsTakeTheFastPath(self):
        """Without this the equivalence tests would pass trivially if the
        fast path never ran."""
        document = copy.deepcopy(VALID_ANNOTATION)
        document["coordinates"] = [
            {"x": 13799.0009765625, "y": 1913.0001220703125},
            {"x": 13797, "y": 1914},
            {"x": 13790.5, "y": 1920.25, "z": 0},
        ]
        assert coordinatesMatchSchema(document["coordinates"])
        assert Annotation.validateSchema(document) is document


def girderEncoding(documents):
    """The JSON value Girder's default response encoder produced."""
    return json.loads(json.dumps(
        documents, sort_keys=True, allow_nan=False, cls=JsonEncoder
    ))


def keysInOrder(pairs):
    keys = [key for key, _ in pairs]
    assert keys == sorted(keys)
    return dict(pairs)


def parseCreatedResponse(resp):
    assertStatusOk(resp)
    assert resp.headers["Content-Type"] == "application/json"
    # isJson=False keeps the raw body: the test client would otherwise
    # consume the stream to parse it.
    body = getResponseBody(resp, text=False)
    # Girder sorted keys; the orjson response keeps them sorted.
    json.loads(body, object_pairs_hook=keysInOrder)
    return json.loads(body)


def storedInOrder(model, ids):
    byId = {
        document["_id"]: document
        for document in model.find({"_id": {"$in": ids}})
    }
    return [byId[documentId] for documentId in ids]


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestBulkCreateResponses:
    def _dataset(self, admin):
        return utilities.createFolder(
            admin, "bulk_ds", upenn_utilities.datasetMetadata
        )

    def _createAnnotations(self, server, admin, annotations):
        return server.request(
            path="/upenn_annotation/multiple",
            method="POST",
            user=admin,
            body=json.dumps(annotations),
            type="application/json",
            isJson=False,
        )

    def testCreateMultipleAnswersWhatGirderEncoded(self, admin, server):
        dataset = self._dataset(admin)
        point = upenn_utilities.getSampleAnnotation(str(dataset["_id"]))
        point["tags"] = ["nücleus", "☃"]
        point["coordinates"] = [{"x": 1e-06, "y": 1e16, "z": -0.0}]
        polygon = upenn_utilities.getSampleAnnotation(str(dataset["_id"]))
        polygon.update(shape="polygon", color="#ff0000", coordinates=[
            {"x": 0.1, "y": 0}, {"x": 10, "y": 0.5}, {"x": 5, "y": 7.25},
        ])
        created = parseCreatedResponse(
            self._createAnnotations(server, admin, [point, polygon])
        )

        ids = [ObjectId(document["_id"]) for document in created]
        stored = storedInOrder(Annotation(), ids)
        assert created == girderEncoding(stored)
        assert "geometryHash" in created[1]

    def testCreateMultipleEmptyListAnswersEmptyArray(self, admin, server):
        resp = self._createAnnotations(server, admin, [])
        assertStatusOk(resp)
        assert getResponseBody(resp, text=False) == b"[]"

    def testCreateMultipleNonFiniteCoordinateAnswersNull(
        self, admin, server
    ):
        """The one deliberate difference: a body number too large for a
        float parses to infinity, which the schema accepts and Mongo
        stores. Girder's encoder then refused it (a 500 after the write);
        the response now carries null, as the GET endpoints do."""
        dataset = self._dataset(admin)
        annotation = upenn_utilities.getSampleAnnotation(str(dataset["_id"]))
        body = json.dumps([annotation]).replace(
            '"x": 761.152955940129', '"x": 1e999'
        )
        assert "1e999" in body
        created = parseCreatedResponse(server.request(
            path="/upenn_annotation/multiple",
            method="POST",
            user=admin,
            body=body,
            type="application/json",
            isJson=False,
        ))
        assert created[0]["coordinates"][0]["x"] is None
        stored = Annotation().load(created[0]["_id"], force=True)
        assert stored["coordinates"][0]["x"] == float("inf")

    def testCreateMultipleConnectionsAnswersWhatGirderEncoded(
        self, admin, server
    ):
        dataset = self._dataset(admin)
        parent, child = (
            Annotation().create(
                upenn_utilities.getSampleAnnotation(dataset["_id"])
            )
            for _ in range(2)
        )
        connection = upenn_utilities.getSampleConnection(
            str(parent["_id"]), str(child["_id"]), str(dataset["_id"])
        )
        connection["tags"] = ["lineage"]
        created = parseCreatedResponse(server.request(
            path="/annotation_connection/multiple",
            method="POST",
            user=admin,
            body=json.dumps([connection]),
            type="application/json",
            isJson=False,
        ))

        ids = [ObjectId(document["_id"]) for document in created]
        assert created == girderEncoding(
            storedInOrder(AnnotationConnection(), ids)
        )

    def testAddMultiplePropertyValuesAnswersWhatGirderEncoded(
        self, admin, server
    ):
        dataset = self._dataset(admin)
        annotation = Annotation().create(
            upenn_utilities.getSampleAnnotation(dataset["_id"])
        )
        body = json.dumps([{
            "annotationId": str(annotation["_id"]),
            "datasetId": str(dataset["_id"]),
            "values": {"area": 12.5, "nested": {"b": 2, "a": 1e-06}},
        }]).replace('"area": 12.5', '"area": 1e999')
        created = parseCreatedResponse(server.request(
            path="/annotation_property_values/multiple",
            method="POST",
            user=admin,
            body=body,
            type="application/json",
            isJson=False,
        ))

        stored = list(AnnotationPropertyValues().find(
            {"annotationId": annotation["_id"]}
        ))
        assert stored[0]["values"]["area"] == float("inf")
        # The endpoint already answered infinity as null (jsonSafe).
        stored[0]["values"]["area"] = None
        assert created == girderEncoding(stored)


class TestCreatedDocumentsEncoding:
    def testUnusualStoredTypesEncodeAsGirderDid(self):
        """Types orjson cannot write fall back to Girder's str() instead of
        failing partway through the streamed body; datetimes keep Girder's
        UTC suffix."""
        documents = [{
            "_id": ObjectId(),
            "values": {
                "decimal": Decimal128("1.5"),
                "binary": Binary(b"\x00\x01"),
                "when": datetime.datetime(2026, 11, 2, 10, 4, 5, 123000),
                "tags": {"only"},
                "ids": [ObjectId(), {"nested": ObjectId()}],
                "zebra": 1, "apple": [1e-06, -0.0, 10 ** 18],
            },
        }]
        body = b"".join(createdDocumentsResponse(documents)())
        json.loads(body, object_pairs_hook=keysInOrder)
        assert json.loads(body) == girderEncoding(documents)

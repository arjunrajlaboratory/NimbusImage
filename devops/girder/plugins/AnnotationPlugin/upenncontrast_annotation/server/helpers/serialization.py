import math

import orjson
from bson import ObjectId
from girder.api.rest import setResponseHeader


def orJsonDefaults(obj):
    if isinstance(obj, ObjectId):
        return str(obj)
    raise ValueError("Type not supported")


def convertIdsToObjectIds(objOrObjs, keysToConvert):
    def convertIds(obj, keysToConvert):
        for keyToConvert in keysToConvert:
            if keyToConvert in obj:
                obj[keyToConvert] = ObjectId(obj[keyToConvert])
        return obj
    if isinstance(objOrObjs, dict):
        return convertIds(objOrObjs, keysToConvert)
    return [convertIds(obj, keysToConvert) for obj in objOrObjs]


def jsonSafe(value):
    """`value` with every non-finite float (Infinity, NaN) replaced by None,
    through dicts and lists. Stored property values may hold Infinity (a
    JSON body's `1e999`; it counts as a value, SELECTION_SUMMARY.md), but
    Girder serializes responses with `allow_nan=False`, so returning one
    as-is is a 500. orjson (the list endpoints) already writes them as
    null; this does the same for endpoints answered through Girder."""
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {key: jsonSafe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [jsonSafe(item) for item in value]
    if hasattr(value, "__next__"):  # a cursor or generator: materialize
        return [jsonSafe(item) for item in value]
    return value


def streamJsonArray(
    items, prefix=b"[", suffix=b"]", default=None, option=None
):
    """Stream `items` as a JSON array, orjson-encoding each element and
    wrapping them in `prefix`/`suffix` (so callers can embed the array inside
    an enclosing object, e.g. {"total": N, "rows": [...]}). Returns a
    generator suitable for a streamed response body."""
    def generate():
        chunk = [prefix]
        first = True
        for item in items:
            if not first:
                chunk.append(b",")
            chunk.append(orjson.dumps(item, default=default, option=option))
            first = False
            if len(chunk) > 1000:
                yield b"".join(chunk)
                chunk = []
        chunk.append(suffix)
        yield b"".join(chunk)
    return generate


def girderJsonDefaults(obj):
    """orjson `default` with girder.utility.JsonEncoder's fallbacks, so a
    type orjson cannot write (an ObjectId, or a stored BSON value such as
    Decimal128 or Binary) becomes what Girder wrote instead of failing
    partway through a streamed response."""
    if isinstance(obj, set):
        return list(obj)
    return str(obj)


def createdDocumentsResponse(documents):
    """Respond with the documents a bulk create wrote, as a streamed orjson
    array instead of through Girder's default encoder, which runs stdlib
    json with sort_keys and spent ~3.5 s of a 100K-annotation create.

    For documents decoded from a JSON body or from Mongo, the JSON parses to
    the same value Girder's encoder produced: keys stay sorted, ObjectIds
    and other unknown types become their str(), and naive datetimes get
    Girder's "+00:00" suffix. Only the spelling differs: no whitespace,
    `1e-06` written `1e-6`, and non-ASCII text as UTF-8 rather than `\\u`
    escapes. Python-computed values are not covered (a numpy float would
    become a string; Enums, dataclasses and non-UTC aware datetimes encode
    differently). One deliberate difference: Girder refuses a non-finite
    float (allow_nan=False), so an annotation or connection create whose
    body held `1e999` stored its documents and then answered 500 (the
    property-value create already wrote null through jsonSafe). orjson
    writes null, as GET /upenn_annotation and POST /upenn_annotation/hydrate
    do for a stored annotation. GET /upenn_annotation/{id} and both
    /annotation_connection reads (GET and GET by id), still answered by
    Girder's encoder, answer 500 for it.
    """
    setResponseHeader("Content-Type", "application/json")
    return streamJsonArray(
        documents,
        default=girderJsonDefaults,
        option=orjson.OPT_SORT_KEYS | orjson.OPT_NAIVE_UTC,
    )

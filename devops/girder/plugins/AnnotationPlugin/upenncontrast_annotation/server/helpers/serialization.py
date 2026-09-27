import math

from bson import ObjectId


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

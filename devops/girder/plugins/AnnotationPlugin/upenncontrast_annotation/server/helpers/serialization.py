import orjson

from bson import ObjectId
from pymongo.cursor import Cursor
from pymongo.synchronous.command_cursor import CommandCursor


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


JSON_KEY_CONVERSION = {
    None: "null",
    True: "true",
    False: "false",
}


def jsonGenerator(obj):
    """
    Simple recursive generator that serialize an object into JSON
    """
    if isinstance(obj, (dict, CommandCursor)):
        if isinstance(obj, CommandCursor):
            obj = next(obj, {})
        not_first = False
        for key, value in obj.items():
            prefix = b", " if not_first else b"{"
            if not isinstance(key, (str, int, float, bool)) \
                    and key is not None:
                raise TypeError(
                    "keys must be str, int, float, bool or None, not "
                    f"{key.__class__.__name__}"
                )

            yield prefix + orjson.dumps(
                str(JSON_KEY_CONVERSION.get(key, key))) + b": "
            yield from jsonGenerator(value)
            not_first = True
        yield b"}" if not_first else b"{}"
    elif isinstance(obj, (list, tuple, Cursor)):
        not_first = False
        for item in obj:
            prefix = b", " if not_first else b"["
            for j, item in enumerate(jsonGenerator(item)):
                yield item if j > 0 else prefix + item
            not_first = True
        yield b"]" if not_first else b"[]"
    else:
        yield orjson.dumps(obj, default=orJsonDefaults)

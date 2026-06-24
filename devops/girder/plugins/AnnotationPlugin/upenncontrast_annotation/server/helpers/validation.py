"""Shared input-validation helpers for the annotation API endpoints.

These run at the API boundary (not in models): they translate malformed client
input into RestException(400) so the public endpoints can't be tripped into
uncaught 500s (a bad ObjectId, a missing key, an injected projection path).
Kept here so annotation.py and propertyValues.py share one implementation
rather than importing validators across API modules.
"""

from bson.errors import InvalidId
from bson.objectid import ObjectId

from girder.exceptions import RestException

# Request-size sanity ceilings: reject only degenerate/garbage payloads that
# would build a pathological pipeline, while never affecting real use (a
# dataset has well under 1K properties; the frontend hydration budget is ~40K
# ids and even "select all" on a 700K dataset is < 1M). These are guards, not
# tuning knobs — runtime is bounded by AGGREGATION_MAX_TIME_MS, not by these.
MAX_UNCOMPUTED_PROPERTIES = 10_000_000
MAX_ANNOTATION_IDS = 10_000_000


def requireCountWithin(count, limit, name):
    """Raise RestException(400) if `count` exceeds `limit`."""
    if count > limit:
        raise RestException(
            "%s exceeds the maximum of %d" % (name, limit), code=400
        )


def validateAnnotationIdCount(count):
    """Cap the number of annotation ids accepted by the batch/hydrate
    endpoints. Reads the module constant at call time so it stays in sync if
    overridden."""
    requireCountWithin(count, MAX_ANNOTATION_IDS, "annotationIds")


def requireObjectId(value, field="id"):
    """Parse `value` into an ObjectId, raising RestException(400) if it is
    missing or malformed (bson.InvalidId is a BSONError, NOT a ValueError, so
    it must be caught explicitly)."""
    if value is None:
        raise RestException("%s is required" % field, code=400)
    try:
        return ObjectId(value)
    except InvalidId:
        raise RestException("%s is not a valid id" % field, code=400)


def requireInt(value, field):
    """Parse `value` into an int, raising RestException(400) on a non-integer.
    Pagination params reach a public endpoint, so a bad value must be a clean
    400 rather than an uncaught int() ValueError/TypeError -> 500."""
    try:
        return int(value)
    except (TypeError, ValueError):
        raise RestException("%s must be an integer" % field, code=400)


def isValidPropertyPath(path):
    """A property path is a non-empty list of non-empty strings with no '.' or
    '$' (which would build a wrong/injected projection key)."""
    return (
        isinstance(path, list)
        and len(path) > 0
        and all(
            isinstance(p, str) and p and "." not in p and "$" not in p
            for p in path
        )
    )


def validatePropertyPaths(propertyPaths):
    """Validate a list-of-paths (each a list of safe string keys). Used by the
    list endpoint and the property-values batch endpoint."""
    if not isinstance(propertyPaths, list) or not all(
        isValidPropertyPath(p) for p in propertyPaths
    ):
        raise RestException(
            "propertyPaths must be a list of valid paths", code=400
        )


def validateUncomputedCountsProperties(properties):
    """Validate the `properties` payload for the uncomputed-counts endpoint.

    Each entry must be a dict carrying a non-empty string `id` (the model does
    pf["id"] unconditionally); `shape` (if present) a string; and `tags` (if
    present) a {tags, exclusive} dict (the model does pf.get("tags") expecting
    a dict). Without this, malformed input raises KeyError/TypeError -> 500 on
    a public endpoint."""
    if not isinstance(properties, list):
        raise RestException("properties must be a list", code=400)
    requireCountWithin(
        len(properties), MAX_UNCOMPUTED_PROPERTIES, "properties"
    )
    for pf in properties:
        if not isinstance(pf, dict):
            raise RestException("each property must be an object", code=400)
        propertyId = pf.get("id")
        if not isinstance(propertyId, str) or not propertyId:
            raise RestException(
                "each property needs a non-empty string 'id'", code=400
            )
        shape = pf.get("shape")
        if shape is not None and not isinstance(shape, str):
            raise RestException("property 'shape' must be a string", code=400)
        tags = pf.get("tags")
        if tags is not None and not isinstance(tags, dict):
            raise RestException(
                "property 'tags' must be an object {tags, exclusive}",
                code=400,
            )


def dropNoOpPropertyFilters(filters):
    """Remove property filters that don't actually constrain anything, in
    place. A values-mode filter with an empty values list, or a range-mode
    filter with neither bound set, is a pass-all no-op (the client treats it
    so, and _propertyFilterStages emits no $match for it). Left in the list it
    would still make `filters.get("propertyFilters")` truthy and wrongly route
    /list, /list/ids, and the count into the PV-driven path -- which starts
    from the property-values collection and drops annotations that have no
    value document. Normalizing here keeps an inactive filter equivalent to no
    filter. Removes the key entirely when nothing active remains."""
    propertyFilters = filters.get("propertyFilters")
    if not propertyFilters:
        return

    def isActive(pf):
        if pf.get("mode") == "values":
            return bool(pf.get("values"))
        return pf.get("min") is not None or pf.get("max") is not None

    active = [pf for pf in propertyFilters if isActive(pf)]
    if active:
        filters["propertyFilters"] = active
    else:
        del filters["propertyFilters"]


def validateListInputs(filters, sort=None, propertyPaths=None):
    """Validate client-supplied filter/sort/path shape. Raises
    RestException(400) on malformed input (avoids uncaught 500s on a public
    endpoint). Mutates `filters['idConstraints']` to ObjectIds in place."""
    # A truthy non-dict `filters` (e.g. a string or list) would otherwise reach
    # filters.get(...) below and raise AttributeError -> 500 (Finding 4).
    if not isinstance(filters, dict):
        raise RestException("filters must be an object", code=400)
    propertyFilters = filters.get("propertyFilters")
    if propertyFilters is not None:
        if not isinstance(propertyFilters, list):
            raise RestException("propertyFilters must be a list", code=400)
        for pf in propertyFilters:
            if not isinstance(pf, dict) or not isValidPropertyPath(
                pf.get("path")
            ):
                raise RestException(
                    "Each property filter needs a valid 'path'", code=400
                )
            mode = pf.get("mode")
            if mode not in ("range", "values"):
                raise RestException(
                    "property filter 'mode' must be 'range' or 'values'",
                    code=400,
                )
            if mode == "values":
                values = pf.get("values")
                if values is not None and not isinstance(values, list):
                    raise RestException(
                        "property filter 'values' must be a list", code=400
                    )
            else:  # range: bounds are comparison operands, must be numeric
                for bound in ("min", "max"):
                    value = pf.get(bound)
                    if value is not None and (
                        isinstance(value, bool)
                        or not isinstance(value, (int, float))
                    ):
                        raise RestException(
                            "property filter '%s' must be a number" % bound,
                            code=400,
                        )
    idSubstring = filters.get("idSubstring")
    if idSubstring is not None and not isinstance(idSubstring, str):
        raise RestException("idSubstring must be a string", code=400)
    idConstraints = filters.get("idConstraints")
    if idConstraints is not None:
        # Each inner list must be non-empty: an empty inner list [[]] would
        # become {"_id": {"$in": []}} -- an unconditional match-none that
        # silently returns nothing (Finding 17). An empty OUTER list [] is a
        # no-op (no constraint) and stays allowed.
        if not isinstance(idConstraints, list) or not all(
            isinstance(c, list)
            and len(c) > 0
            and all(isinstance(i, str) and i for i in c)
            for c in idConstraints
        ):
            raise RestException(
                "idConstraints must be a list of non-empty lists of id "
                "strings",
                code=400,
            )
        # Convert ids to ObjectId once here (the model consumes them
        # directly); an invalid id would otherwise raise bson.InvalidId deep
        # in the aggregation as an uncaught 500 on this public endpoint.
        try:
            filters["idConstraints"] = [
                [ObjectId(i) for i in constraint]
                for constraint in idConstraints
            ]
        except InvalidId:
            raise RestException(
                "idConstraints contains an invalid id", code=400
            )
    if sort is not None:
        if not isinstance(sort, dict) or sort.get("type") not in (
            "field", "property"
        ):
            raise RestException(
                "sort.type must be 'field' or 'property'", code=400
            )
        if sort["type"] == "property" and not isValidPropertyPath(
            sort.get("key")
        ):
            raise RestException(
                "property sort needs a valid 'key' path", code=400
            )
    if propertyPaths is not None:
        validatePropertyPaths(propertyPaths)

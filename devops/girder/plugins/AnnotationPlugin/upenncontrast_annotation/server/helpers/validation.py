"""Shared input-validation helpers for the annotation API endpoints.

These run at the API boundary (not in models): they translate malformed client
input into RestException(400) so the public endpoints can't be tripped into
uncaught 500s (a bad ObjectId, a missing key, an injected projection path).
Kept here so annotation.py and propertyValues.py share one implementation
rather than importing validators across API modules.
"""

import math

from bson.errors import InvalidId
from bson.objectid import ObjectId

from girder.exceptions import RestException

from . import analysis

# Request-size sanity ceilings: reject only degenerate/garbage payloads that
# would build a pathological pipeline, while never affecting real use (a
# dataset has well under 1K properties; the frontend hydration budget is ~40K
# ids and even "select all" on a 700K dataset is < 1M). These are guards, not
# tuning knobs — runtime is bounded by AGGREGATION_MAX_TIME_MS, not by these.
MAX_UNCOMPUTED_PROPERTIES = 10_000_000
MAX_ANNOTATION_IDS = 10_000_000

# Analysis-gating request ceilings (SERVER_GATING.md "Limits"): abuse guards
# on the public gate-resolution endpoint, far above real use (a panel holds a
# handful of plots; a lasso records a few hundred vertices).
# Plots per gate-resolution request. Each plot rebuilds coordinates for both
# its axes over the whole dataset (~0.7s per categorical axis at 700K), so
# this is a CPU bound on a public endpoint, not just a payload guard: at 100
# it bought one request ~130s of work. A sequential gating strategy is a
# handful of plots; 20 is already generous. (Same shape as the categorical
# grid cap — a public endpoint with a lenient cap on an expensive unit.)
MAX_ANALYSIS_PLOTS = 20
# A drawn lasso is tens to a few hundred vertices (Plotly's drawclosedpath
# emits well under 300). The old 10,000 bought nothing real and a lot of
# CPU: points_in_polygon does one full-length numpy pass PER VERTEX, so
# cost is vertices x annotations and no Mongo timeout covers it. Measured
# on 708,983 points: 200 vertices 0.22s, 1,000 1.02s, 4,000 4.16s.
MAX_GATE_VERTICES = 1_000
# ...and a per-request total, so many modest gates cannot add up to the
# same burn. 10,000 is ~10s of polygon work on the largest dataset here.
MAX_TOTAL_GATE_VERTICES = 10_000
MAX_GATE_CATEGORIES = 10_000
# Histogram bin clamp per axis (512² cells ≈ a 1–2 MB response worst case).
MAX_HISTOGRAM_BINS = 512

# Upper clamp on the page size accepted by the public /list endpoint. This is
# an abuse guard, not a tuning knob: it caps how many full annotation rows an
# unauthenticated caller can make a single request stream/serialize, well above
# any real UI page size (the frontend caps page sizes far lower). Real paging
# stays unaffected; only a degenerate request asking for an enormous page is
# clamped down rather than served.
MAX_LIST_LIMIT = 10_000


def requireCountWithin(count, limit, name):
    """Raise RestException(400) if `count` exceeds `limit`."""
    if count > limit:
        raise RestException(
            "%s exceeds the maximum of %d" % (name, limit), code=400
        )


def requireObjectBody(body, name="Request body"):
    """Return `body` if it is a dict, else raise RestException(400).

    Public endpoints parse the request body and immediately call `.get()` on
    it. A client that POSTs a JSON array (or any non-object) would otherwise
    trip an uncaught AttributeError -> 500. Guard the shape once at the API
    boundary so a non-object body is a clean 400."""
    if not isinstance(body, dict):
        raise RestException("%s must be a JSON object" % name, code=400)
    return body


def requireList(value, field):
    """Return `value` if it is a list, else raise RestException(400).

    Guards body fields that are about to be len()'d or iterated: a scalar or
    string would otherwise raise TypeError (len of an int) or iterate
    per-character, neither of which is a clean error on a public endpoint."""
    if not isinstance(value, list):
        raise RestException("%s must be a list" % field, code=400)
    return value


def validateAnnotationIdCount(count):
    """Cap the number of annotation ids accepted by the batch/hydrate
    endpoints. Reads the module constant at call time so it stays in sync if
    overridden."""
    requireCountWithin(count, MAX_ANNOTATION_IDS, "annotationIds")


def requireObjectId(value, field="id"):
    """Parse `value` into an ObjectId, raising RestException(400) if it is
    missing or malformed. A malformed hex string raises bson.InvalidId (a
    BSONError, NOT a ValueError); a non-string value such as a JSON number
    or bool raises TypeError. Both must map to a clean 400, not a 500."""
    if value is None:
        raise RestException("%s is required" % field, code=400)
    try:
        return ObjectId(value)
    except (InvalidId, TypeError):
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

    Each entry must be a dict carrying a non-empty string `id` (the model
    does propertyFilter["id"] unconditionally); `shape` (if present) a
    string; and `tags` (if present) a {tags, exclusive} dict (the model does
    propertyFilter.get("tags") expecting a dict). Without this, malformed
    input raises KeyError/TypeError -> 500 on a public endpoint."""
    if not isinstance(properties, list):
        raise RestException("properties must be a list", code=400)
    requireCountWithin(
        len(properties), MAX_UNCOMPUTED_PROPERTIES, "properties"
    )
    for propertyFilter in properties:
        if not isinstance(propertyFilter, dict):
            raise RestException("each property must be an object", code=400)
        propertyId = propertyFilter.get("id")
        if not isinstance(propertyId, str) or not propertyId:
            raise RestException(
                "each property needs a non-empty string 'id'", code=400
            )
        shape = propertyFilter.get("shape")
        if shape is not None and not isinstance(shape, str):
            raise RestException("property 'shape' must be a string", code=400)
        tags = propertyFilter.get("tags")
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

    def isActive(propertyFilter):
        if propertyFilter.get("mode") == "values":
            return bool(propertyFilter.get("values"))
        return (
            propertyFilter.get("min") is not None
            or propertyFilter.get("max") is not None
        )

    active = [
        propertyFilter
        for propertyFilter in propertyFilters
        if isActive(propertyFilter)
    ]
    if active:
        filters["propertyFilters"] = active
    else:
        del filters["propertyFilters"]


# The client's TAnalysisCategoricalKey values and gate schema version
# (src/store/model.ts). A version mismatch means the key encoding changed;
# resolving under the wrong encoding silently gates the wrong categories.
ANALYSIS_CATEGORICAL_KEYS = ("tags", "shape", "channel", "xy", "z", "time")
ANALYSIS_CATEGORY_KEY_VERSION = 1


def _isFiniteNumber(value):
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
    )


def _validateAnalysisAxis(axis, name):
    if not isinstance(axis, dict):
        raise RestException("%s must be an object" % name, code=400)
    axisType = axis.get("type")
    if axisType == "property":
        if not isValidPropertyPath(axis.get("path")):
            raise RestException(
                "%s needs a valid property 'path'" % name, code=400
            )
    elif axisType == "categorical":
        if axis.get("key") not in ANALYSIS_CATEGORICAL_KEYS:
            raise RestException(
                "%s has an unknown categorical key" % name, code=400
            )
    else:
        raise RestException(
            "%s type must be 'property' or 'categorical'" % name, code=400
        )


def _validateGateCategories(axis, categories, name):
    if axis.get("type") == "property":
        if categories is not None:
            raise RestException(
                "%s must be null for a property axis" % name, code=400
            )
        return
    # A categorical axis without a pinned order has no defined coordinate
    # space — the client always pins categories when a gate is drawn.
    if (
        not isinstance(categories, list)
        or not all(isinstance(key, str) for key in categories)
    ):
        raise RestException(
            "%s must be a list of category keys" % name, code=400
        )
    requireCountWithin(len(categories), MAX_GATE_CATEGORIES, name)


def _validateGateObject(gate, xAxis, yAxis):
    """One drawn gate: version, vertex polygon, pinned category orders."""
    if not isinstance(gate, dict):
        raise RestException("gate must be an object", code=400)
    if gate.get("categoryKeyVersion") != ANALYSIS_CATEGORY_KEY_VERSION:
        raise RestException(
            "gate categoryKeyVersion must be %d"
            % ANALYSIS_CATEGORY_KEY_VERSION,
            code=400,
        )
    vertices = requireList(gate.get("vertices"), "gate vertices")
    requireCountWithin(len(vertices), MAX_GATE_VERTICES, "gate vertices")
    for vertex in vertices:
        if (
            not isinstance(vertex, dict)
            or not _isFiniteNumber(vertex.get("x"))
            or not _isFiniteNumber(vertex.get("y"))
        ):
            raise RestException(
                "gate vertices must be {x, y} finite numbers", code=400
            )
    _validateGateCategories(
        xAxis, gate.get("xCategories"), "gate.xCategories"
    )
    _validateGateCategories(
        yAxis, gate.get("yCategories"), "gate.yCategories"
    )


def _requireTotalVertexBudget(gates):
    """Aggregate vertex ceiling for ONE request.

    Must be applied by every endpoint that accepts gates, not just
    gate_ids: the cost is vertices x annotations of numpy work, and 20
    modest gates reach the same burn as one enormous one. `gates` is any
    iterable of dicts carrying a "gate".
    """
    total = sum(len(gate["gate"]["vertices"]) for gate in gates)
    requireCountWithin(total, MAX_TOTAL_GATE_VERTICES, "total gate vertices")


def validateAnalysisGatePlots(plots):
    """Validate the `plots` payload of a gate-resolution request.

    Each plot carries both axes and a drawn gate (vertices in plot space +
    per-axis pinned category orders). Returns the validated list. Fewer than
    3 vertices is NOT an error — it resolves to an empty gate, matching the
    client's resolveGateIds.
    """
    plots = requireList(plots, "plots")
    requireCountWithin(len(plots), MAX_ANALYSIS_PLOTS, "plots")
    for plot in plots:
        if not isinstance(plot, dict):
            raise RestException("each plot must be an object", code=400)
        if not isinstance(plot.get("id"), str) or not plot["id"]:
            raise RestException(
                "each plot needs a non-empty string 'id'", code=400
            )
        _validateAnalysisAxis(plot.get("xAxis"), "xAxis")
        _validateAnalysisAxis(plot.get("yAxis"), "yAxis")
        _validateGateObject(plot.get("gate"), plot["xAxis"], plot["yAxis"])
    _requireTotalVertexBudget(plots)
    return plots


def validateAnalysisHistogramRequest(body):
    """Validate a histogram2d request body in place; returns the body.

    Unlike a gate's pinned categories, the request-level display categories
    may be null for a categorical axis — the server derives them for a
    gateless plot. `bins` values are CLAMPED to [1, MAX_HISTOGRAM_BINS]
    rather than rejected (mirroring MAX_LIST_LIMIT); non-integers still 400.
    """
    xAxis = body.get("xAxis")
    yAxis = body.get("yAxis")
    _validateAnalysisAxis(xAxis, "xAxis")
    _validateAnalysisAxis(yAxis, "yAxis")
    for name, axis in (("xCategories", xAxis), ("yCategories", yAxis)):
        categories = body.get(name)
        if categories is not None:
            _validateGateCategories(axis, categories, name)
    # Reject an oversized categorical grid up front, before any query runs.
    # analysis.histogram2d re-checks after deriving categories from the data,
    # which is the case this cannot see.
    xCount = len(body.get("xCategories") or []) or 1
    yCount = len(body.get("yCategories") or []) or 1
    for count, name in ((xCount, "xCategories"), (yCount, "yCategories")):
        if count > analysis.MAX_HISTOGRAM_AXIS_CATEGORIES:
            raise RestException(
                "%s exceeds the maximum of %d categories per axis"
                % (name, analysis.MAX_HISTOGRAM_AXIS_CATEGORIES),
                code=400,
            )
    if xCount * yCount > analysis.MAX_HISTOGRAM_CELLS:
        raise RestException(
            "requested categorical grid exceeds the maximum of %d cells"
            % analysis.MAX_HISTOGRAM_CELLS,
            code=400,
        )
    bins = body.get("bins")
    if not isinstance(bins, dict):
        raise RestException("bins must be an object", code=400)
    body["bins"] = {
        key: min(MAX_HISTOGRAM_BINS, max(1, requireInt(
            bins.get(key), "bins.%s" % key
        )))
        for key in ("x", "y")
    }
    upstream = requireList(body.get("upstreamGates", []), "upstreamGates")
    requireCountWithin(len(upstream), MAX_ANALYSIS_PLOTS, "upstreamGates")
    for gatePlot in upstream:
        if not isinstance(gatePlot, dict):
            raise RestException(
                "each upstream gate must be an object", code=400
            )
        _validateAnalysisAxis(gatePlot.get("xAxis"), "upstream xAxis")
        _validateAnalysisAxis(gatePlot.get("yAxis"), "upstream yAxis")
        _validateGateObject(
            gatePlot.get("gate"), gatePlot["xAxis"], gatePlot["yAxis"]
        )
    if body.get("gate") is not None:
        _validateGateObject(body["gate"], xAxis, yAxis)
    # Upstream gates AND this plot's own gate are all resolved server-side
    # for one response, so they share the request budget.
    _requireTotalVertexBudget(
        list(upstream)
        + ([{"gate": body["gate"]}] if body.get("gate") is not None else [])
    )
    filters = body.get("filters") or {}
    # Gating on this endpoint travels through `upstreamGates`, which share
    # one request budget with the plot's own gate. `filters.analysisGates`
    # is a SECOND gate channel with its own ceiling — and analysisHistogram
    # calls listIds without resolveListGateConstraints, so those gates would
    # be validated and then silently ignored, quietly changing the picture.
    if isinstance(filters, dict) and filters.get("analysisGates"):
        raise RestException(
            "filters.analysisGates is not accepted here; pass gates as "
            "upstreamGates so they share the request budget",
            code=400,
        )
    validateListInputs(filters)
    dropNoOpPropertyFilters(filters)
    body["filters"] = filters
    return body


def validateListInputs(filters, sort=None, propertyPaths=None):
    """Validate client-supplied filter/sort/path shape. Raises
    RestException(400) on malformed input (avoids uncaught 500s on a public
    endpoint). Mutates `filters['idConstraints']` to ObjectIds in place."""
    # A truthy non-dict `filters` (e.g. a string or list) would otherwise reach
    # filters.get(...) below and raise AttributeError -> 500.
    if not isinstance(filters, dict):
        raise RestException("filters must be an object", code=400)
    # `gateMatchClauses` is INTERNAL: resolveListGateConstraints writes it and
    # _buildListMatchStages splices its contents straight into the aggregation
    # `$match.$and`. It is not part of the client-facing filter shape, and the
    # resolver appends to it (setdefault) rather than replacing it, so a
    # client-supplied value survived into the query. On these public endpoints
    # that made it an arbitrary-operator channel: a string yielded
    # `{"$and": ["x"]}` -> OperationFailure -> uncaught 500, and a list of real
    # clauses ANDed anything the caller liked into the dataset-scoped match
    # (a catastrophic-backtracking $regex could burn AGGREGATION_MAX_TIME_MS of
    # Mongo CPU per unauthenticated request). Drop it before anything reads it.
    filters.pop("gateMatchClauses", None)
    analysisGates = filters.get("analysisGates")
    if analysisGates is not None:
        # Gate DEFINITIONS as filter terms (SERVER_GATING.md, Phase 3): the
        # model resolves them to id constraints once per request.
        analysisGates = requireList(analysisGates, "analysisGates")
        requireCountWithin(
            len(analysisGates), MAX_ANALYSIS_PLOTS, "analysisGates"
        )
        for gatePlot in analysisGates:
            if not isinstance(gatePlot, dict):
                raise RestException(
                    "each analysis gate must be an object", code=400
                )
            _validateAnalysisAxis(gatePlot.get("xAxis"), "gate xAxis")
            _validateAnalysisAxis(gatePlot.get("yAxis"), "gate yAxis")
            _validateGateObject(
                gatePlot.get("gate"), gatePlot["xAxis"], gatePlot["yAxis"]
            )
        _requireTotalVertexBudget(analysisGates)
    propertyFilters = filters.get("propertyFilters")
    if propertyFilters is not None:
        if not isinstance(propertyFilters, list):
            raise RestException("propertyFilters must be a list", code=400)
        for propertyFilter in propertyFilters:
            if not isinstance(propertyFilter, dict) or not isValidPropertyPath(
                propertyFilter.get("path")
            ):
                raise RestException(
                    "Each property filter needs a valid 'path'", code=400
                )
            mode = propertyFilter.get("mode")
            if mode not in ("range", "values"):
                raise RestException(
                    "property filter 'mode' must be 'range' or 'values'",
                    code=400,
                )
            if mode == "values":
                values = propertyFilter.get("values")
                if values is not None and not isinstance(values, list):
                    raise RestException(
                        "property filter 'values' must be a list", code=400
                    )
            else:  # range: bounds are comparison operands, must be numeric
                for bound in ("min", "max"):
                    value = propertyFilter.get(bound)
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
        # silently returns nothing. An empty OUTER list [] is a
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
    # _buildListMatchStages assigns these values straight into the aggregation
    # `$match`, so validating only the CONTAINER shape leaves the leaves as an
    # operator channel: `{"shape": {"$ne": "polygon"}}` was applied as written,
    # and `{"shape": {"$nope": 1}}` reached MongoDB as an unknown operator ->
    # OperationFailure -> uncaught 500 on three @access.public endpoints. Same
    # shape as the gateMatchClauses hole above; these are its siblings, so
    # every leaf that lands in `$match` is type-checked to its scalar type.
    tags = filters.get("tags")
    if tags is not None:
        if not isinstance(tags, dict):
            raise RestException("filters.tags must be an object", code=400)
        tagValues = tags.get("values")
        if tagValues is not None:
            requireList(tagValues, "filters.tags.values")
            if not all(isinstance(tag, str) for tag in tagValues):
                raise RestException(
                    "filters.tags.values must be a list of strings", code=400
                )
    shape = filters.get("shape")
    if shape is not None and not isinstance(shape, str):
        raise RestException("filters.shape must be a string", code=400)
    location = filters.get("location")
    if location is not None:
        if not isinstance(location, dict):
            raise RestException(
                "filters.location must be an object", code=400
            )
        for axis in ("XY", "Z", "Time"):
            value = location.get(axis)
            # bool is an int in Python, and `{"XY": true}` is not a frame.
            if value is not None and (
                isinstance(value, bool) or not isinstance(value, int)
            ):
                raise RestException(
                    "filters.location.%s must be an integer" % axis, code=400
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

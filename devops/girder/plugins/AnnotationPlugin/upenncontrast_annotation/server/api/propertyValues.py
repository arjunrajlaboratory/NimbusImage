from girder.api import access
from girder.api.describe import Description, describeRoute
from girder.api.rest import Resource, setResponseHeader
from girder.constants import AccessType, TokenScope
from girder.exceptions import RestException
from girder.models.folder import Folder

from ..helpers.access_helpers import (
    requireAnnotationsInDatasets,
    requireDatasetsAccess,
)
from ..helpers import valueProviders
from ..helpers.aggregation import STREAM_PREFETCH_BATCHES, prefetchedBatches
from ..helpers.serialization import (
    jsonSafe,
    orJsonDefaults,
    streamJsonArray,
    streamRawJsonArray,
)
from ..helpers.validation import (
    MAX_DISTINCT_SEARCH_LENGTH,
    MAX_DISTINCT_VALUES,
    isValidPropertyPath,
    requireBulkCreateBody,
    requireInt,
    requireList,
    requireObjectBody,
    requireObjectId,
    validateAnnotationIdCount,
    validateDisjointPropertyPaths,
    validatePropertyPaths,
)
from ..models.propertyValues import (
    AnnotationPropertyValues as PropertyValuesModel,
)


class PropertyValues(Resource):
    def __init__(self):
        super().__init__()
        self.resourceName = "annotation_property_values"
        self._annotationPropertyValuesModel = PropertyValuesModel()

        self.route("DELETE", (), self.delete)
        self.route("POST", (), self.add)
        self.route("POST", ("multiple",), self.addMultiple)
        self.route("POST", ("batch",), self.batch)
        self.route("GET", (), self.find)
        self.route("GET", ("count",), self.count)
        self.route("GET", ("histogram",), self.histogram)
        self.route("GET", ("distinct",), self.distinct)

    # TODO: anytime a dataset is mentioned, load the dataset and check for
    #   existence and that the user has access to it
    # TODO: creation date, update date, creatorId ?
    # TODO(performance): proper indexing
    # TODO(performance): use objectId whenever possible

    @access.user(scope=TokenScope.DATA_WRITE)
    @describeRoute(
        Description("Save computed property values")
        .param(
            "body",
            (
                "Property values of type "
                "{ [propertyId: string]: number | Map<string, number> }"
            ),
            paramType="body",
        )
        .param("annotationId", "The ID of the annotation")
        .param("datasetId", "The ID of the dataset")
    )
    def add(self, params):
        params = self._annotationPropertyValuesModel.convertIdsToObjectIds(
            params)
        Folder().load(
            params["datasetId"],
            user=self.getCurrentUser(),
            level=AccessType.WRITE,
            exc=True,
        )
        requireAnnotationsInDatasets([params])
        return jsonSafe(self._annotationPropertyValuesModel.appendValues(
            self.getBodyJson(),
            params["annotationId"],
            params["datasetId"],
        ))

    @access.user(scope=TokenScope.DATA_WRITE)
    @describeRoute(
        Description("Save multiple computed property values").param(
            "body",
            (
                "List of property values of type "
                "{ datasetId: string, annotationId: string, values: "
                "{ [propertyId: string]: any } }[]"
            ),
            paramType="body",
        )
    )
    def addMultiple(self, params):
        propertyValuesList = requireBulkCreateBody(
            self.getBodyJson(),
            self._annotationPropertyValuesModel,
            "property value entry",
        )
        datasetIds = {
            entry["datasetId"]
            for entry in propertyValuesList
            if "datasetId" in entry
        }
        requireDatasetsAccess(datasetIds, self.getCurrentUser())
        requireAnnotationsInDatasets(propertyValuesList)
        return jsonSafe(
            self._annotationPropertyValuesModel.appendMultipleValues(
                propertyValuesList
            )
        )

    @describeRoute(
        Description(
            (
                "Delete all the values for annotations"
                "in this dataset with this property's id"
            )
        )
        .param("propertyId", "The property's Id", paramType="path")
        .param("datasetId", "The dataset's Id", paramType="path")
        .errorResponse("Property ID was invalid.")
        .errorResponse("Dataset ID was invalid.")
        .errorResponse("Write access was denied for the property values.", 403)
    )
    @access.user(scope=TokenScope.DATA_WRITE)
    def delete(self, params):
        if "propertyId" not in params:
            raise RestException(
                code=400, message="Property ID was invalid"
            )
        if "datasetId" not in params:
            raise RestException(
                code=400, message="Dataset ID was invalid"
            )
        params = self._annotationPropertyValuesModel.convertIdsToObjectIds(
            params)
        Folder().load(
            params["datasetId"],
            user=self.getCurrentUser(),
            level=AccessType.WRITE,
            exc=True,
        )
        self._annotationPropertyValuesModel.delete(
            params["propertyId"], params["datasetId"]
        )

    @access.public(scope=TokenScope.DATA_READ)
    @describeRoute(
        Description("Get property values for a set of annotation ids")
        .notes(
            "POST to send the id list (avoids URL length limits). "
            "Optionally projects only the requested property paths."
        )
        .param(
            "body",
            (
                "{ datasetId: string, annotationIds: string[], "
                "propertyPaths?: string[][] }"
            ),
            paramType="body",
        )
        .errorResponse()
        .errorResponse("Read access was denied for the dataset.", 403)
    )
    def batch(self, params):
        body = requireObjectBody(self.getBodyJson())
        datasetId = requireObjectId(body.get("datasetId"), "datasetId")
        propertyPaths = body.get("propertyPaths")
        if propertyPaths is not None:
            # A component containing '.'/'$' would silently build a wrong or
            # injected projection key; a non-list-of-lists-of-strings would
            # raise TypeError in findByAnnotationIds. Reject at the boundary.
            validatePropertyPaths(propertyPaths)
            validateDisjointPropertyPaths(propertyPaths)
        # Guard the list shape before len()/iterating: a scalar would raise
        # TypeError on len(), a string would iterate per-character. Both must
        # be a clean 400 on this public endpoint, not a 500.
        rawIds = requireList(body.get("annotationIds", []), "annotationIds")
        validateAnnotationIdCount(len(rawIds))
        Folder().load(
            datasetId,
            user=self.getCurrentUser(),
            level=AccessType.READ,
            exc=True,
        )
        annotationIds = [requireObjectId(i, "annotationId") for i in rawIds]
        model = self._annotationPropertyValuesModel
        _, virtualPaths = valueProviders.splitPaths(propertyPaths or [])
        if not virtualPaths:
            # Stored values only: raw batches straight to JSON, without
            # decoding every value into Python (serialization.py).
            setResponseHeader("Content-Type", "application/json")
            return streamRawJsonArray(
                model.findRawBatchesByAnnotationIds(
                    datasetId, annotationIds, propertyPaths
                ),
                model.collection.codec_options,
            )
        try:
            documents = model.findByAnnotationIds(
                datasetId, annotationIds, propertyPaths
            )
        except ValueError as exc:
            # A virtual path the provider cannot resolve (unknown key).
            raise RestException(str(exc), code=400)
        # Virtual values are merged into the documents in Python; written in
        # the same JSON form as the raw path (orjson: Infinity/NaN as null).
        setResponseHeader("Content-Type", "application/json")
        return streamJsonArray(documents, default=orJsonDefaults)

    @access.public(scope=TokenScope.DATA_READ)
    @describeRoute(
        Description("Search for property values")
        .responseClass("annotation")
        .param(
            "datasetId",
            "Get all property values for this dataset",
            required=True,
        )
        .param(
            "annotationId",
            "Get all property values for this annotation",
            required=False,
        )
        .param("afterId", "Cursor for pagination", required=False)
        .pagingParams(defaultSort="_id")
        .errorResponse()
    )
    def find(self, params):
        limit, offset, sort = self.getPagingParameters(params, "_id")
        # datasetId is required: it is what the READ check is made against.
        # Optional, a request without it listed every dataset's values.
        datasetId = requireObjectId(params.get("datasetId"), "datasetId")
        Folder().load(
            datasetId, user=self.getCurrentUser(), level=AccessType.READ,
            exc=True,
        )
        query = {"datasetId": datasetId}

        if "annotationId" in params:
            query["annotationId"] = requireObjectId(
                params["annotationId"], "annotationId"
            )

        # Support cursor pagination
        after_id = params.get("afterId")
        if after_id:
            query["_id"] = {"$gt": requireObjectId(after_id, "afterId")}
            offset = 0  # Ignore offset when using cursor

        # Use regular find instead of findWithPermissions. Raw batches go
        # straight to JSON (findRawBatches): decoding 100K value documents
        # into dicts cost several times the rest of the request.
        cursor = self._annotationPropertyValuesModel.findRawBatches(
            query,
            sort=sort,
            limit=limit,
            offset=offset,
        ).hint([("datasetId", 1), ("_id", 1)])

        # Stream, never materialize: limit=0 returns the whole dataset, and
        # building that list (plus Girder's JSON string of it) took ~1.6 GiB
        # per 100K documents, enough to OOM-kill Girder on a 709K-cell
        # dataset. Infinity/NaN come out as null, as jsonSafe did. Fetching
        # overlaps transcoding, as in the annotation list.
        setResponseHeader("Content-Type", "application/json")
        return streamRawJsonArray(
            prefetchedBatches(cursor, depth=STREAM_PREFETCH_BATCHES),
            self._annotationPropertyValuesModel.collection.codec_options,
        )

    @access.public(scope=TokenScope.DATA_READ)
    @describeRoute(
        Description("Get property value count for a dataset")
        .param("datasetId", "Get count for this dataset", required=True)
        .errorResponse()
    )
    def count(self, params):
        datasetId = requireObjectId(params.get("datasetId"), "datasetId")
        Folder().load(
            datasetId, user=self.getCurrentUser(), level=AccessType.READ,
            exc=True
        )

        query = {"datasetId": datasetId}
        return {
            "count": (
                self._annotationPropertyValuesModel.collection
                .count_documents(query)
            )
        }

    @access.public(scope=TokenScope.DATA_READ)
    @describeRoute(
        Description(
            "Get a histogram for property values in the specified dataset"
        )
        .param(
            "propertyPath",
            (
                "The path to the property: a property ID and eventually "
                "subIds separated with dots (e.g. propertyId.subId0.subId1)"
            ),
        )
        .param("datasetId", "The id of the dataset")
        .param("buckets", "The number of buckets", required=False)
    )
    def histogram(self, params):
        params = self._annotationPropertyValuesModel.convertIdsToObjectIds(
            params)
        Folder().load(
            params["datasetId"],
            user=self.getCurrentUser(),
            level=AccessType.READ,
            exc=True,
        )
        if "buckets" in params:
            return jsonSafe(self._annotationPropertyValuesModel.histogram(
                params["propertyPath"],
                params["datasetId"],
                int(params["buckets"]),
            ))
        else:
            return jsonSafe(self._annotationPropertyValuesModel.histogram(
                params["propertyPath"], params["datasetId"]
            ))

    @access.public(scope=TokenScope.DATA_READ)
    @describeRoute(
        Description(
            "List the distinct string values of a property in a dataset"
        )
        .notes(
            "Returns {values: [{value, count}], truncated}, most common "
            "first. Only string values are listed (numeric properties "
            "filter by range). truncated is true when more distinct values "
            "exist than limit; narrow with search."
        )
        .param("datasetId", "The id of the dataset")
        .param(
            "propertyPath",
            "The path to the property, keys separated with dots",
        )
        .param(
            "search",
            "Keep only values containing this text (case-insensitive)",
            required=False,
        )
        .param(
            "limit",
            "Maximum number of values to return (default and maximum %d)"
            % MAX_DISTINCT_VALUES,
            required=False,
            dataType="integer",
        )
        .errorResponse()
    )
    def distinct(self, params):
        datasetId = requireObjectId(params.get("datasetId"), "datasetId")
        propertyPath = (params.get("propertyPath") or "").split(".")
        if not isValidPropertyPath(propertyPath):
            raise RestException("propertyPath is not a valid path", code=400)
        search = params.get("search") or ""
        if len(search) > MAX_DISTINCT_SEARCH_LENGTH:
            raise RestException(
                "search must be at most %d characters"
                % MAX_DISTINCT_SEARCH_LENGTH,
                code=400,
            )
        limit = MAX_DISTINCT_VALUES
        if params.get("limit") is not None:
            limit = min(
                max(requireInt(params["limit"], "limit"), 1),
                MAX_DISTINCT_VALUES,
            )
        Folder().load(
            datasetId,
            user=self.getCurrentUser(),
            level=AccessType.READ,
            exc=True,
        )
        values, truncated = (
            self._annotationPropertyValuesModel.distinctStringValues(
                datasetId, propertyPath, search, limit
            )
        )
        return {"values": values, "truncated": truncated}

import orjson
import cherrypy

from bson.errors import InvalidId
from bson.objectid import ObjectId

from girder.api import access
from girder.api.describe import Description, describeRoute, autoDescribeRoute
from girder.api.rest import Resource, loadmodel, setResponseHeader
from girder.constants import AccessType, TokenScope
from girder.exceptions import RestException
from girder.models.folder import Folder

from ..helpers.access_helpers import requireDatasetsAccess
from ..helpers.proxiedModel import recordable, memoizeBodyJson
from ..models.annotation import Annotation as AnnotationModel
from ..helpers.serialization import orJsonDefaults


# Helper functions to get dataset ID for recordable endpoints


def _isValidPropertyPath(path):
    return (
        isinstance(path, list)
        and len(path) > 0
        and all(
            isinstance(p, str) and p and "." not in p and "$" not in p
            for p in path
        )
    )


def _validateListInputs(filters, sort=None, propertyPaths=None):
    """Validate client-supplied filter/sort/path shape. Raises
    RestException(400) on malformed input (avoids uncaught 500s on a
    public endpoint)."""
    propertyFilters = filters.get("propertyFilters")
    if propertyFilters is not None:
        if not isinstance(propertyFilters, list):
            raise RestException("propertyFilters must be a list", code=400)
        for pf in propertyFilters:
            if not isinstance(pf, dict) or not _isValidPropertyPath(
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
        if not isinstance(idConstraints, list) or not all(
            isinstance(c, list)
            and all(isinstance(i, str) and i for i in c)
            for c in idConstraints
        ):
            raise RestException(
                "idConstraints must be a list of lists of id strings",
                code=400,
            )
        # Each id must be a valid ObjectId; the model converts them when
        # building the match stage, where an InvalidId would otherwise
        # surface as an uncaught 500 on this public endpoint.
        for constraint in idConstraints:
            for annotationId in constraint:
                try:
                    ObjectId(annotationId)
                except InvalidId:
                    raise RestException(
                        "idConstraints contains an invalid id: %s"
                        % annotationId,
                        code=400,
                    )
    if sort is not None:
        if not isinstance(sort, dict) or sort.get("type") not in (
            "field", "property"
        ):
            raise RestException(
                "sort.type must be 'field' or 'property'", code=400
            )
        if sort["type"] == "property" and not _isValidPropertyPath(
            sort.get("key")
        ):
            raise RestException(
                "property sort needs a valid 'key' path", code=400
            )
    if propertyPaths is not None:
        if not isinstance(propertyPaths, list) or not all(
            _isValidPropertyPath(p) for p in propertyPaths
        ):
            raise RestException(
                "propertyPaths must be a list of valid paths", code=400
            )


def _streamJsonArray(items, prefix=b"[", suffix=b"]", default=None):
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
            chunk.append(orjson.dumps(item, default=default))
            first = False
            if len(chunk) > 1000:
                yield b"".join(chunk)
                chunk = []
        chunk.append(suffix)
        yield b"".join(chunk)
    return generate


def getDatasetIdFromAnnotationInBody(self: "Annotation", *args, **kwargs):
    annotation = kwargs["memoizedBodyJson"]
    return annotation["datasetId"]


def getDatasetIdFromAnnotationListInBody(self: "Annotation", *args, **kwargs):
    annotations = kwargs["memoizedBodyJson"]
    if (not isinstance(annotations, list)
            or len(annotations) <= 0):
        return None
    first = annotations[0]
    if not isinstance(first, dict):
        return None
    # If datasetId is present in the payload, use it directly
    datasetId = first.get("datasetId")
    if datasetId:
        return datasetId
    # For partial updates (e.g. updateMultiple), look up from DB
    annId = first.get("id") or first.get("_id")
    if annId:
        ann = AnnotationModel().load(annId, force=True)
        if ann:
            return ann.get("datasetId")
    return None


def getDatasetIdFromLoadedAnnotation(self: "Annotation", *args, **kwargs):
    annotation = kwargs["upenn_annotation"]
    return annotation["datasetId"]


def getDatasetIdFromAnnotationIdListInBody(
    self: "Annotation", *args, **kwargs
):
    annotationStringIds = kwargs["memoizedBodyJson"]
    query = {
        "_id": {
            "$in": [ObjectId(stringId) for stringId in annotationStringIds]
        },
    }
    cursor = self._annotationModel.findWithPermissions(
        query, user=self.getCurrentUser(), level=AccessType.READ, limit=1
    )
    annotation = next(cursor, None)
    return None if annotation is None else annotation["datasetId"]


class Annotation(Resource):

    def __init__(self):
        super().__init__()
        self.resourceName = "upenn_annotation"

        self._annotationModel: AnnotationModel = AnnotationModel()

        self.route("DELETE", (":id",), self.delete)
        self.route("GET", (":id",), self.get)
        self.route("GET", (), self.find)
        self.route("GET", ("count",), self.count)
        self.route("POST", (), self.create)
        self.route("PUT", (":id",), self.update)
        self.route("PUT", ("multiple",), self.updateMultiple)
        self.route("POST", ("compute",), self.compute)
        self.route("POST", ("multiple",), self.createMultiple)
        self.route("DELETE", ("multiple",), self.deleteMultiple)
        self.route("GET", ("stubs",), self.stubs)
        self.route("POST", ("hydrate",), self.hydrate)
        self.route("POST", ("list",), self.listAnnotations)
        self.route("POST", ("list", "ids"), self.listAnnotationIds)

    # TODO: anytime a dataset is mentioned, load the dataset and check for
    #   existence and that the user has access to it
    # TODO: creation date, update date, creatorId
    # TODO: find annotations by roi, tag, childOf and parentOf
    # TODO(performance): smarter indexing
    # TODO(performance): use objectId whenever possible
    # TODO: error handling and documentation

    @access.user(scope=TokenScope.DATA_WRITE)
    @describeRoute(
        Description("Create a new annotation").param(
            "body", "Annotation Object", paramType="body"
        )
    )
    @memoizeBodyJson
    @recordable("Create an annotation", getDatasetIdFromAnnotationInBody)
    def create(self, params, *args, **kwargs):
        bodyJson = kwargs["memoizedBodyJson"]
        annotation = self._annotationModel.convertIdsToObjectIds(bodyJson)
        Folder().load(
            annotation["datasetId"],
            user=self.getCurrentUser(),
            level=AccessType.WRITE,
            exc=True,
        )
        return self._annotationModel.create(annotation)

    @access.user(scope=TokenScope.DATA_WRITE)
    @describeRoute(
        Description("Create multiple new annotations").param(
            "body", "Annotation Object List", paramType="body"
        )
    )
    @memoizeBodyJson
    @recordable(
        "Create multiple annotations", getDatasetIdFromAnnotationListInBody
    )
    def createMultiple(self, params, *args, **kwargs):
        bodyJson = kwargs["memoizedBodyJson"]
        annotations = self._annotationModel.convertIdsToObjectIds(bodyJson)
        datasetIds = {
            ann["datasetId"] for ann in annotations
            if "datasetId" in ann
        }
        requireDatasetsAccess(datasetIds, self.getCurrentUser())
        return self._annotationModel.createMultiple(annotations)

    @describeRoute(
        Description("Delete an existing annotation")
        .param("id", "The annotation's Id", paramType="path")
        .errorResponse("ID was invalid.")
        .errorResponse("Write access was denied for the annotation.", 403)
    )
    @access.user(scope=TokenScope.DATA_WRITE)
    @loadmodel(
        model="upenn_annotation",
        plugin="upenncontrast_annotation",
        level=AccessType.WRITE,
    )
    @recordable("Delete an annotation", getDatasetIdFromLoadedAnnotation)
    def delete(self, upenn_annotation, params):
        self._annotationModel.delete(upenn_annotation)

    @access.user(scope=TokenScope.DATA_WRITE)
    @describeRoute(
        Description("Delete all annotations in the id list")
        .param(
            "body",
            "A list of all annotation ids to delete.",
            paramType="body",
        )
    )
    @memoizeBodyJson
    @recordable(
        "Delete multiple annotations",
        getDatasetIdFromAnnotationIdListInBody,
    )
    def deleteMultiple(self, params, *args, **kwargs):
        bodyJson = kwargs["memoizedBodyJson"]
        stringIds = [stringId for stringId in bodyJson]
        objectIds = [ObjectId(sid) for sid in stringIds]
        # Find all distinct datasets these annotations belong to
        datasetIds = [
            doc["_id"] for doc in
            self._annotationModel.collection.aggregate([
                {"$match": {"_id": {"$in": objectIds}}},
                {"$group": {"_id": "$datasetId"}},
            ], hint="_id_")
        ]
        requireDatasetsAccess(datasetIds, self.getCurrentUser())
        self._annotationModel.deleteMultiple(stringIds)

    @describeRoute(
        Description("Update an existing annotation")
        .param("id", "The ID of the annotation.", paramType="path")
        .param(
            "body",
            "A JSON object containing the annotation.",
            paramType="body",
        )
        .errorResponse("Write access was denied for the item.", 403)
        .errorResponse("Invalid JSON passed in request body.")
        .errorResponse("Validation Error: JSON doesn't follow schema.")
    )
    @access.user(scope=TokenScope.DATA_WRITE)
    @loadmodel(
        model="upenn_annotation",
        plugin="upenncontrast_annotation",
        level=AccessType.WRITE,
    )
    @memoizeBodyJson
    @recordable("Update an annotation", getDatasetIdFromLoadedAnnotation)
    def update(self, upenn_annotation, params, *args, **kwargs):
        bodyJson = kwargs["memoizedBodyJson"]
        filtered = self._annotationModel.filterUpdateFields(
            bodyJson
        )
        upenn_annotation.update(filtered)
        self._annotationModel.save(upenn_annotation)

    @describeRoute(
        Description("Update multiple existing annotation")
        .param(
            "body",
            (
                "A JSON array of objects containing the annotations to update."
                "Each annotation must at least have an 'id' field"
            ),
            paramType="body",
        )
        .errorResponse("Write access was denied for the item.", 403)
        .errorResponse("Invalid JSON passed in request body.")
        .errorResponse("Validation Error: JSON doesn't follow schema.")
    )
    @access.user(scope=TokenScope.DATA_WRITE)
    @memoizeBodyJson
    @recordable("Update an annotation", getDatasetIdFromAnnotationListInBody)
    def updateMultiple(self, params, *args, **kwargs):
        bodyJson = kwargs["memoizedBodyJson"]

        # --- Input validation (API layer responsibility) ---
        if not isinstance(bodyJson, list):
            raise RestException(
                "Request body must be a JSON array."
            )
        if len(bodyJson) == 0:
            return []

        # Normalize: accept both "id" and "_id", validate entries
        annotationIdToUpdate = {}
        newDatasetIds = set()
        for update in bodyJson:
            if not isinstance(update, dict):
                raise RestException(
                    "Each annotation update must be a JSON object."
                )
            annId = update.get("id") or update.get("_id")
            if not annId:
                raise RestException(
                    "Each annotation must have an 'id' or '_id'"
                    " field."
                )
            try:
                objId = ObjectId(annId)
            except InvalidId:
                raise RestException(
                    "Invalid annotation id: %s" % annId
                )
            # Build clean update dict (no id keys, whitelist)
            updateDoc = update.copy()
            updateDoc.pop("id", None)
            updateDoc.pop("_id", None)
            updateDoc = (
                self._annotationModel.filterUpdateFields(
                    updateDoc
                )
            )
            if "datasetId" in updateDoc:
                try:
                    dsId = ObjectId(
                        updateDoc["datasetId"]
                    )
                except InvalidId:
                    raise RestException(
                        "Invalid datasetId: %s"
                        % updateDoc["datasetId"]
                    )
                updateDoc["datasetId"] = dsId
                newDatasetIds.add(dsId)
            annotationIdToUpdate[objId] = updateDoc

        # Check WRITE access on any destination datasets
        if newDatasetIds:
            requireDatasetsAccess(
                newDatasetIds, self.getCurrentUser()
            )

        self._annotationModel.updateMultiple(
            annotationIdToUpdate, self.getCurrentUser()
        )

    @access.public(scope=TokenScope.DATA_READ)
    @autoDescribeRoute(
        Description("Search for annotations")
        .responseClass("upenn_annotation")
        .param(
            "datasetId", "Get all annotations in this dataset", required=True
        )
        .param("shape", "Filter annotations by shape", required=False)
        .jsonParam(
            "tags",
            (
                "Filter annotations by tags: get annotations which contain"
                "the given tags (and potentially other additional tags)"
            ),
            required=False,
            requireArray=True,
        )
        .param("afterId", "Cursor for pagination", required=False)
        .pagingParams(defaultSort="_id")
        .errorResponse()
    )
    def find(self, params):
        limit, offset, sort = self.getPagingParameters(params, "lowerName")

        # First, check dataset permissions explicitly
        datasetId = ObjectId(params["datasetId"])
        Folder().load(
            datasetId,
            user=self.getCurrentUser(),
            level=AccessType.READ,
            exc=True,
        )

        # Now query annotations directly without ACL filtering
        query = {"datasetId": datasetId}
        if params["shape"] is not None:
            query["shape"] = params["shape"]
        if params["tags"] is not None and len(params["tags"]) > 0:
            query["tags"] = {"$all": params["tags"]}

        # Support cursor pagination
        after_id = params.get("afterId")
        if after_id:
            query["_id"] = {"$gt": ObjectId(after_id)}
            offset = 0  # Ignore offset when using cursor

        # Use regular find instead of findWithPermissions
        cursor = self._annotationModel.find(
            query,
            sort=sort,
            limit=limit,
            offset=offset,
        ).hint([("datasetId", 1), ("_id", 1)])

        setResponseHeader("Content-Type", "application/json")
        if callable(getattr(cursor, 'count', None)):
            cherrypy.response.headers['Girder-Total-Count'] = cursor.count()
        return _streamJsonArray(cursor, default=orJsonDefaults)

    @access.public(scope=TokenScope.DATA_READ)
    @autoDescribeRoute(
        Description("Get annotation count for a dataset")
        .param("datasetId", "Get count for this dataset", required=True)
        .param("shape", "Filter annotations by shape", required=False)
        .jsonParam(
            "tags",
            (
                "Filter annotations by tags: get annotations which contain"
                "the given tags (and potentially other additional tags)"
            ),
            required=False,
            requireArray=True,
        )
        .errorResponse()
    )
    def count(self, params):
        datasetId = ObjectId(params["datasetId"])
        Folder().load(
            datasetId,
            user=self.getCurrentUser(),
            level=AccessType.READ,
            exc=True,
        )

        query = {"datasetId": datasetId}
        if params.get("shape"):
            query["shape"] = params["shape"]
        if params.get("tags") and len(params["tags"]) > 0:
            query["tags"] = {"$all": params["tags"]}

        return {
            "count": self._annotationModel.collection.count_documents(query)
        }

    @access.public(scope=TokenScope.DATA_READ)
    @describeRoute(
        Description("Get an annotation by its id.").param(
            "id", "The annotation's id", paramType="path"
        )
    )
    @loadmodel(
        model="upenn_annotation",
        plugin="upenncontrast_annotation",
        level=AccessType.READ,
    )
    def get(self, upenn_annotation, params):
        return upenn_annotation

    @access.user(scope=TokenScope.DATA_WRITE)
    @describeRoute(
        Description("Compute annotations from a worker tool")
        .param("datasetId", "The dataset Id", required=False)
        .param(
            "body",
            "A JSON object containing the worker tool",
            paramType="body",
        )
    )
    @memoizeBodyJson
    def compute(self, params, *args, **kwargs):
        bodyJson = kwargs["memoizedBodyJson"]
        datasetId = params.get("datasetId", None)
        if not datasetId:
            raise RestException(
                code=400, message="Missing datasetId parameter"
            )
        return self._annotationModel.compute(
            datasetId, bodyJson, self.getCurrentUser()
        )

    @access.public(scope=TokenScope.DATA_READ)
    @autoDescribeRoute(
        Description("Get annotation stubs (without coordinates)")
        .notes(
            "Returns lightweight annotation stubs with server-computed "
            "centroid and estimatedRadius but no coordinates array. "
            "Used by the frontend stub/hydration architecture to "
            "quickly load annotation metadata for large datasets."
        )
        .param(
            "datasetId",
            "Get stubs for all annotations in this dataset",
            required=True,
        )
        .param(
            "shape",
            "Filter annotations by shape",
            required=False,
        )
        .jsonParam(
            "tags",
            "Filter annotations by tags",
            required=False,
            requireArray=True,
        )
        .errorResponse()
    )
    def stubs(self, params):
        datasetId = ObjectId(params["datasetId"])
        Folder().load(
            datasetId,
            user=self.getCurrentUser(),
            level=AccessType.READ,
            exc=True,
        )

        match = {"datasetId": datasetId}
        if params.get("shape"):
            match["shape"] = params["shape"]
        if params.get("tags") and len(params["tags"]) > 0:
            match["tags"] = {"$all": params["tags"]}

        pipeline = [
            {"$match": match},
            {"$addFields": {
                "centroid": {
                    "x": {"$avg": "$coordinates.x"},
                    "y": {"$avg": "$coordinates.y"},
                },
                "estimatedRadius": {
                    "$divide": [
                        {"$sqrt": {"$add": [
                            {"$pow": [
                                {"$subtract": [
                                    {"$max": "$coordinates.x"},
                                    {"$min": "$coordinates.x"},
                                ]},
                                2,
                            ]},
                            {"$pow": [
                                {"$subtract": [
                                    {"$max": "$coordinates.y"},
                                    {"$min": "$coordinates.y"},
                                ]},
                                2,
                            ]},
                        ]}},
                        2,
                    ]
                },
            }},
            {"$project": {"coordinates": 0}},
        ]

        cursor = self._annotationModel.collection.aggregate(
            pipeline,
            hint={"datasetId": 1, "_id": 1},
        )

        setResponseHeader("Content-Type", "application/json")
        return _streamJsonArray(cursor, default=orJsonDefaults)

    @access.public(scope=TokenScope.DATA_READ)
    @autoDescribeRoute(
        Description("Hydrate annotations by ID list")
        .notes(
            "Accepts a list of annotation IDs and returns full "
            "annotation documents (with coordinates). Used by the "
            "frontend stub/hydration architecture to load full "
            "geometry for viewport-visible annotations on demand.\n\n"
            "Note: For very large ID lists (500K+), the $in query "
            "could approach MongoDB's 16MB BSON document size limit. "
            "The frontend hydration budget (default 5K-10K) keeps "
            "requests well under this, but if this endpoint is ever "
            "used for larger batches, add $in chunking as done in "
            "the CSV export endpoint."
        )
        .jsonParam(
            "annotationIds",
            "List of annotation IDs to hydrate",
            paramType="body",
            requireArray=True,
        )
        .errorResponse()
        .errorResponse("Read access denied.", 403)
    )
    def hydrate(self, annotationIds):
        if not annotationIds:
            return []

        objectIds = [ObjectId(sid) for sid in annotationIds]

        # Find the distinct datasets these annotations belong to
        # and verify READ access on each.
        datasetIds = [
            doc["_id"] for doc in
            self._annotationModel.collection.aggregate([
                {"$match": {"_id": {"$in": objectIds}}},
                {"$group": {"_id": "$datasetId"}},
            ], hint="_id_")
        ]
        requireDatasetsAccess(
            datasetIds, self.getCurrentUser(), level=AccessType.READ
        )

        cursor = self._annotationModel.find(
            {"_id": {"$in": objectIds}}
        )

        setResponseHeader("Content-Type", "application/json")
        return _streamJsonArray(cursor, default=orJsonDefaults)

    @access.public(scope=TokenScope.DATA_READ)
    @describeRoute(
        Description("Annotation IDs matching list filters")
        .param("body", "JSON: {datasetId, filters}", paramType="body")
        .errorResponse()
        .errorResponse("Read access denied.", 403)
    )
    @memoizeBodyJson
    def listAnnotationIds(self, params, *args, **kwargs):
        body = kwargs["memoizedBodyJson"]
        datasetId = ObjectId(body["datasetId"])
        Folder().load(
            datasetId, user=self.getCurrentUser(),
            level=AccessType.READ, exc=True,
        )
        filters = body.get("filters") or {}
        _validateListInputs(filters)
        ids = self._annotationModel.listIds(datasetId, filters)

        prefix = b'{"total":' + str(len(ids)).encode() + b',"ids":['
        setResponseHeader("Content-Type", "application/json")
        return _streamJsonArray(ids, prefix=prefix, suffix=b"]}")

    @access.public(scope=TokenScope.DATA_READ)
    @describeRoute(
        Description("List annotations (paged), stub-shaped + property values")
        .param("body", "JSON: {datasetId, filters, sort, propertyPaths, "
                       "offset, limit}", paramType="body")
        .errorResponse()
        .errorResponse("Read access denied.", 403)
    )
    @memoizeBodyJson
    def listAnnotations(self, params, *args, **kwargs):
        body = kwargs["memoizedBodyJson"]
        datasetId = ObjectId(body["datasetId"])
        Folder().load(
            datasetId, user=self.getCurrentUser(),
            level=AccessType.READ, exc=True,
        )
        filters = body.get("filters") or {}
        sort = body.get("sort")
        propertyPaths = body.get("propertyPaths") or []
        offset = int(body.get("offset", 0))
        limit = max(1, int(body.get("limit", 50)))

        _validateListInputs(filters, sort, propertyPaths)

        # Build the page first: its pipeline construction validates the sort
        # field (ValueError -> 400) before the expensive count aggregation
        # runs, so a bad sort key doesn't pay for a full count (Finding #5).
        try:
            cursor = self._annotationModel.listPage(
                datasetId, filters, sort, propertyPaths, offset, limit
            )
        except ValueError as e:
            raise RestException(str(e), code=400)
        total = self._annotationModel.listCount(datasetId, filters)

        prefix = b'{"total":' + str(total).encode() + b',"rows":['
        setResponseHeader("Content-Type", "application/json")
        return _streamJsonArray(
            cursor, prefix=prefix, suffix=b"]}", default=orJsonDefaults
        )

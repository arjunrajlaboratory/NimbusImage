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
from ..helpers.validation import (
    MAX_LIST_LIMIT,
    dropNoOpPropertyFilters,
    requireInt,
    requireObjectBody,
    requireObjectId,
    validateAnnotationIdCount,
    validateListInputs,
    validateUncomputedCountsProperties,
)
from ..models.annotation import Annotation as AnnotationModel
from ..helpers.serialization import orJsonDefaults


# Helper functions to get dataset ID for recordable endpoints


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
        self.route("POST", ("uncomputed_counts",), self.uncomputedCounts)

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
        datasetIds = self._annotationModel.distinctDatasetIds(objectIds)
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
    @recordable("Update an annotation", getDatasetIdFromLoadedAnnotation)
    def update(self, upenn_annotation, params):
        filtered = self._annotationModel.filterUpdateFields(
            self.getBodyJson()
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
        limit, offset, sort = self.getPagingParameters(params, "_id")

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
    @autoDescribeRoute(
        Description("Per-property count of annotations awaiting computation")
        .notes(
            "For each property, the number of annotations matching its "
            "compute criteria (shape + tags) that have no computed value "
            "for it. Returns counts only -- never values -- so a large "
            "dataset's properties panel never transfers the full value "
            "map. Body: {datasetId, properties: [{id, shape, tags: "
            "{tags, exclusive}}]}."
        )
        .jsonParam(
            "body",
            "datasetId and the properties to count uncomputed annotations for",
            paramType="body",
            requireObject=True,
        )
        .errorResponse()
        .errorResponse("Read access denied.", 403)
    )
    def uncomputedCounts(self, body):
        datasetId = requireObjectId(body.get("datasetId"), "datasetId")
        properties = body.get("properties") or []
        validateUncomputedCountsProperties(properties)
        Folder().load(
            datasetId,
            user=self.getCurrentUser(),
            level=AccessType.READ,
            exc=True,
        )
        return self._annotationModel.uncomputedCounts(datasetId, properties)

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
    def compute(self, params):
        datasetId = params.get("datasetId", None)
        if not datasetId:
            raise RestException(
                code=400, message="Missing datasetId parameter"
            )
        return self._annotationModel.compute(
            datasetId, self.getBodyJson(), self.getCurrentUser()
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
        datasetId = requireObjectId(params.get("datasetId"), "datasetId")
        Folder().load(
            datasetId,
            user=self.getCurrentUser(),
            level=AccessType.READ,
            exc=True,
        )

        cursor = self._annotationModel.stubs(
            datasetId,
            shape=params.get("shape"),
            tags=params.get("tags"),
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
        validateAnnotationIdCount(len(annotationIds))

        objectIds = [requireObjectId(sid, "annotationId") for sid in
                     annotationIds]

        # Find the distinct datasets these annotations belong to
        # and verify READ access on each.
        datasetIds = self._annotationModel.distinctDatasetIds(objectIds)
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
    def listAnnotationIds(self, params):
        bodyJson = requireObjectBody(self.getBodyJson())
        datasetId = requireObjectId(bodyJson.get("datasetId"), "datasetId")
        Folder().load(
            datasetId, user=self.getCurrentUser(),
            level=AccessType.READ, exc=True,
        )
        filters = bodyJson.get("filters") or {}
        validateListInputs(filters)
        dropNoOpPropertyFilters(filters)
        ids = self._annotationModel.listIds(datasetId, filters)

        prefix = b'{"total":' + str(len(ids)).encode() + b',"ids":['
        setResponseHeader("Content-Type", "application/json")
        return _streamJsonArray(ids, prefix=prefix, suffix=b"]}")

    @access.public(scope=TokenScope.DATA_READ)
    @describeRoute(
        Description("List annotations (paged), stub-shaped + property values")
        .param("body", "JSON: {datasetId, filters, sort, propertyPaths, "
                       "offset, limit, anchorId?}", paramType="body")
        .errorResponse()
        .errorResponse("Read access denied.", 403)
    )
    def listAnnotations(self, params):
        bodyJson = requireObjectBody(self.getBodyJson())
        datasetId = requireObjectId(bodyJson.get("datasetId"), "datasetId")
        Folder().load(
            datasetId, user=self.getCurrentUser(),
            level=AccessType.READ, exc=True,
        )
        filters = bodyJson.get("filters") or {}
        sort = bodyJson.get("sort")
        propertyPaths = bodyJson.get("propertyPaths") or []
        anchorIdValue = bodyJson.get("anchorId")
        anchorId = (
            requireObjectId(anchorIdValue, "anchorId")
            if anchorIdValue is not None else None
        )
        # Parse-or-400 at the boundary, then clamp: a non-integer
        # offset/limit would otherwise raise an uncaught int() error -> 500 on
        # this public endpoint. The limit is clamped to MAX_LIST_LIMIT so a
        # public caller can't request an arbitrarily large page and force
        # serialization of that many full rows.
        offset = max(0, requireInt(bodyJson.get("offset", 0), "offset"))
        limit = min(
            MAX_LIST_LIMIT,
            max(1, requireInt(bodyJson.get("limit", 50), "limit")),
        )

        validateListInputs(filters, sort, propertyPaths)
        dropNoOpPropertyFilters(filters)

        # Build the page first: its pipeline construction validates the sort
        # field (ValueError -> 400) before the expensive count aggregation
        # runs, so a bad sort key doesn't pay for a full count.
        try:
            resolvedOffset = offset
            if anchorId is not None:
                position = self._annotationModel.listPosition(
                    datasetId, filters, sort, anchorId
                )
                resolvedOffset = (
                    (position // limit) * limit
                    if position is not None else None
                )
            cursor = (
                self._annotationModel.listPage(
                    datasetId, filters, sort, propertyPaths,
                    resolvedOffset, limit
                )
                if resolvedOffset is not None else []
            )
        except ValueError as e:
            raise RestException(str(e), code=400)
        total = self._annotationModel.listCount(datasetId, filters)

        encodedOffset = (
            b"null" if resolvedOffset is None
            else str(resolvedOffset).encode()
        )
        prefix = (
            b'{"total":' + str(total).encode()
            + b',"offset":' + encodedOffset + b',"rows":['
        )
        setResponseHeader("Content-Type", "application/json")
        return _streamJsonArray(
            cursor, prefix=prefix, suffix=b"]}", default=orJsonDefaults
        )

from girder.api import access
from girder.api.describe import Description, autoDescribeRoute, describeRoute
from girder.api.rest import Resource, loadmodel, setResponseHeader
from girder.constants import AccessType, TokenScope
from girder.exceptions import AccessException
from girder.models.folder import Folder

from ..helpers.access_helpers import requireDatasetsAccess
from ..helpers.proxiedModel import recordable, memoizeBodyJson
from ..helpers.aggregation import STREAM_PREFETCH_BATCHES, prefetchedBatches
from ..helpers.serialization import (
    createdDocumentsResponse,
    streamRawJsonArray,
)
from ..helpers.validation import requireBulkCreateBody, requireObjectId
from ..models.annotation import Annotation as AnnotationModel
from ..models.connections import AnnotationConnection as ConnectionModel

from bson.objectid import ObjectId


# Helper functions to get dataset ID for recordable endpoints


def getDatasetIdFromConnectionInBody(
    self: "AnnotationConnection", *args, **kwargs
):
    connection = kwargs["memoizedBodyJson"]
    return connection["datasetId"]


def getDatasetIdFromConnectionListInBody(
    self: "AnnotationConnection", *args, **kwargs
):
    connections = kwargs["memoizedBodyJson"]
    # This runs in the @recordable wrapper, before the handler validates the
    # body: a malformed body must skip recording (return None), not raise a
    # 500, so the handler can reject it with a clean 400.
    if not isinstance(connections, list) or len(connections) <= 0:
        return None
    first = connections[0]
    if not isinstance(first, dict):
        return None
    return first.get("datasetId")


def getDatasetIdFromLoadedConnection(
    self: "AnnotationConnection", *args, **kwargs
):
    connection = kwargs["annotation_connection"]
    return connection["datasetId"]


def getDatasetIdFromConnectionIdListInBody(
    self: "AnnotationConnection", *args, **kwargs
):
    connectionStringIds = kwargs["memoizedBodyJson"]
    query = {
        "_id": {
            "$in": [ObjectId(stringId) for stringId in connectionStringIds]
        },
    }
    cursor = self._connectionModel.findWithPermissions(
        query, user=self.getCurrentUser(), level=AccessType.READ, limit=1
    )
    connection = next(cursor, None)
    return None if connection is None else connection["datasetId"]


def getDatasetIdFromInfoInBody(self: "AnnotationConnection", *args, **kwargs):
    info = kwargs["memoizedBodyJson"]
    annotationsIdsToConnect = info["annotationsIds"]
    annotationModel: AnnotationModel = AnnotationModel()
    for stringId in annotationsIdsToConnect:
        id = ObjectId(stringId)
        annotation = annotationModel.getAnnotationById(
            id, self.getCurrentUser()
        )
        if annotation is not None:
            return annotation["datasetId"]
    return None


class AnnotationConnection(Resource):

    def __init__(self):
        super().__init__()
        self.resourceName = "annotation_connection"

        self._connectionModel: ConnectionModel = ConnectionModel()

        self.route("DELETE", (":id",), self.delete)
        self.route("GET", (":id",), self.get)
        self.route("GET", (), self.find)
        self.route("GET", ("count",), self.count)
        self.route("POST", (), self.create)
        self.route("PUT", (":id",), self.update)
        self.route("POST", ("connectTo",), self.connectToNearest)
        self.route("POST", ("multiple",), self.multipleCreate)
        self.route("DELETE", ("multiple",), self.deleteMultiple)

    # TODO: anytime a dataset is mentioned, load the dataset and check for
    #   existence and that the user has access to it
    # TODO: load both childe and parent annotations, and check that they share
    #   existence, access and location
    # TODO: creation date, update date, creatorId
    # TODO: error handling and documentation

    @access.user(scope=TokenScope.DATA_WRITE)
    @describeRoute(
        Description("Create a new connection").param(
            "body", "Connection Object", paramType="body"
        )
    )
    @memoizeBodyJson
    @recordable("Create a connection", getDatasetIdFromConnectionInBody)
    def create(self, params, *args, **kwargs):
        bodyJson = kwargs["memoizedBodyJson"]
        connection = self._connectionModel.convertIdsToObjectIds(bodyJson)
        Folder().load(
            connection["datasetId"],
            user=self.getCurrentUser(),
            level=AccessType.WRITE,
            exc=True,
        )
        return self._connectionModel.create(connection)

    @access.user(scope=TokenScope.DATA_WRITE)
    @describeRoute(
        Description("Create multiple new connections").param(
            "body", "Connection Object List", paramType="body"
        )
    )
    @memoizeBodyJson
    @recordable(
        "Create multiple connections", getDatasetIdFromConnectionListInBody
    )
    def multipleCreate(self, params, *args, **kwargs):
        connections = requireBulkCreateBody(
            kwargs["memoizedBodyJson"], self._connectionModel, "connection"
        )
        datasetIds = {
            conn["datasetId"] for conn in connections
            if "datasetId" in conn
        }
        requireDatasetsAccess(datasetIds, self.getCurrentUser())
        return createdDocumentsResponse(
            self._connectionModel.createMultiple(connections)
        )

    @describeRoute(
        Description("Delete an existing connection")
        .param("id", "The connection's Id", paramType="path")
        .errorResponse("ID was invalid.")
        .errorResponse("Write access was denied for the connection.", 403)
    )
    @access.user(scope=TokenScope.DATA_WRITE)
    @loadmodel(
        model="annotation_connection",
        plugin="upenncontrast_annotation",
        level=AccessType.WRITE,
    )
    @recordable("Delete a connection", getDatasetIdFromLoadedConnection)
    def delete(self, annotation_connection, params):
        self._connectionModel.remove(annotation_connection)

    @access.user(scope=TokenScope.DATA_WRITE)
    @describeRoute(
        Description("Delete all annotation connections in the id list")
        .param(
            "body",
            "A list of all annotation connection ids to delete.",
            paramType="body",
        )
    )
    @memoizeBodyJson
    @recordable(
        "Delete multiple connections",
        getDatasetIdFromConnectionIdListInBody,
    )
    def deleteMultiple(self, params, *args, **kwargs):
        bodyJson = kwargs["memoizedBodyJson"]
        stringIds = [stringId for stringId in bodyJson]
        objectIds = [ObjectId(sid) for sid in stringIds]
        # Find all distinct datasets these connections belong to
        datasetIds = [
            doc["_id"] for doc in
            self._connectionModel.collection.aggregate([
                {"$match": {"_id": {"$in": objectIds}}},
                {"$group": {"_id": "$datasetId"}},
            ], hint="_id_")
        ]
        requireDatasetsAccess(datasetIds, self.getCurrentUser())
        return self._connectionModel.deleteMultiple(stringIds)

    @describeRoute(
        Description("Update an existing connection")
        .param("id", "The ID of the connection.", paramType="path")
        .param(
            "body",
            "A JSON object containing the connection.",
            paramType="body",
        )
        .errorResponse("Write access was denied for the item.", 403)
        .errorResponse("Invalid JSON passed in request body.")
        .errorResponse("Validation Error: JSON doesn't follow schema.")
    )
    @access.user(scope=TokenScope.DATA_WRITE)
    @loadmodel(
        model="annotation_connection",
        plugin="upenncontrast_annotation",
        level=AccessType.WRITE,
    )
    @memoizeBodyJson
    @recordable("Update a connection", getDatasetIdFromLoadedConnection)
    def update(self, annotation_connection, params, *args, **kwargs):
        bodyJson = kwargs["memoizedBodyJson"]
        filtered = self._connectionModel.filterUpdateFields(
            bodyJson
        )
        annotation_connection.update(filtered)
        self._connectionModel.save(annotation_connection)

    @access.public(scope=TokenScope.DATA_READ)
    @autoDescribeRoute(
        Description("Search for connections")
        .responseClass("annotation_connection")
        .param(
            "datasetId", "Get all connections in this dataset", required=True
        )
        .param(
            "parentId",
            "Get all connections from this annotation",
            required=False,
        )
        .param(
            "childId", "Get all connections to this annotation", required=False
        )
        .param(
            "nodeAnnotationId",
            "Get all connections to or from this annotation",
            required=False,
        )
        .param("afterId", "Cursor for pagination", required=False)
        .pagingParams(defaultSort="_id")
        .errorResponse()
    )
    def find(self, params):
        limit, offset, sort = self.getPagingParameters(params, "_id")
        # An empty datasetId passes the route's required check; parse it
        # unconditionally so the READ check always runs.
        datasetId = requireObjectId(params.get("datasetId"), "datasetId")
        Folder().load(
            datasetId, user=self.getCurrentUser(), level=AccessType.READ,
            exc=True,
        )
        query = {"datasetId": datasetId}

        if "childId" in params and params["childId"]:
            query["childId"] = requireObjectId(params["childId"], "childId")
        if "parentId" in params and params["parentId"]:
            query["parentId"] = requireObjectId(
                params["parentId"], "parentId"
            )
        if "nodeAnnotationId" in params and params["nodeAnnotationId"]:
            nodeId = requireObjectId(
                params["nodeAnnotationId"], "nodeAnnotationId"
            )
            query["$or"] = [{"parentId": nodeId}, {"childId": nodeId}]

        # Support cursor pagination
        after_id = params.get("afterId")
        if after_id:
            query["_id"] = {"$gt": requireObjectId(after_id, "afterId")}
            offset = 0  # Ignore offset when using cursor

        # Use regular find instead of findWithPermissions. Raw batches go
        # straight to JSON (findRawBatches), as in the annotation list.
        cursor = self._connectionModel.findRawBatches(
            query,
            sort=sort,
            limit=limit,
            offset=offset,
        ).hint([("datasetId", 1), ("_id", 1)])

        # Stream: Girder would otherwise list() the cursor and JSON-encode
        # it in one string, so limit=0 on a large dataset grows Girder's
        # memory with the dataset.
        setResponseHeader("Content-Type", "application/json")
        return streamRawJsonArray(
            prefetchedBatches(cursor, depth=STREAM_PREFETCH_BATCHES),
            self._connectionModel.collection.codec_options,
        )

    @access.public(scope=TokenScope.DATA_READ)
    @autoDescribeRoute(
        Description("Get connection count for a dataset")
        .param("datasetId", "Get count for this dataset", required=True)
        .errorResponse()
    )
    def count(self, params):
        datasetId = requireObjectId(params["datasetId"], "datasetId")
        Folder().load(
            datasetId, user=self.getCurrentUser(), level=AccessType.READ,
            exc=True
        )

        query = {"datasetId": datasetId}
        return {
            "count": self._connectionModel.collection.count_documents(query)
        }

    @access.public(scope=TokenScope.DATA_READ)
    @autoDescribeRoute(
        Description("Get an connection by its id.").param(
            "id", "The connection's id", paramType="path"
        )
    )
    @loadmodel(
        model="annotation_connection",
        plugin="upenncontrast_annotation",
        level=AccessType.READ,
    )
    def get(self, annotation_connection):
        return annotation_connection

    @access.user(scope=TokenScope.DATA_WRITE)
    @describeRoute(
        Description("Create connections between annotations").param(
            "body", "Connection Object", paramType="body"
        )
    )
    @memoizeBodyJson
    @recordable("Create connections with nearest", getDatasetIdFromInfoInBody)
    def connectToNearest(self, params, *args, **kwargs):
        bodyJson = kwargs["memoizedBodyJson"]
        currentUser = self.getCurrentUser()
        if not currentUser:
            raise AccessException("User not found", "currentUser")
        return self._connectionModel.connectToNearest(
            user=currentUser, info=bodyJson
        )

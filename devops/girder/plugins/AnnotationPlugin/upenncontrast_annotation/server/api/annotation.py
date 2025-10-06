import orjson
import cherrypy

from bson.objectid import ObjectId

from girder.api import access
from girder.api.describe import Description, describeRoute, autoDescribeRoute
from girder.api.rest import Resource, loadmodel, setResponseHeader
from girder.constants import AccessType
from girder.exceptions import RestException
from girder.models.folder import Folder

from ..helpers.proxiedModel import recordable, memoizeBodyJson
from ..models.annotation import Annotation as AnnotationModel
from ..helpers.serialization import orJsonDefaults


# Helper functions to get dataset ID for recordable endpoints


def getDatasetIdFromAnnotationInBody(self: "Annotation", *args, **kwargs):
    annotation = kwargs["memoizedBodyJson"]
    return annotation["datasetId"]


def getDatasetIdFromAnnotationListInBody(self: "Annotation", *args, **kwargs):
    annotations = kwargs["memoizedBodyJson"]
    return None if len(annotations) <= 0 else annotations[0]["datasetId"]


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
        self.route("POST", (), self.create)
        self.route("PUT", (":id",), self.update)
        self.route("PUT", ("multiple",), self.updateMultiple)
        self.route("POST", ("compute",), self.compute)
        self.route("POST", ("multiple",), self.createMultiple)
        self.route("DELETE", ("multiple",), self.deleteMultiple)

    # TODO: anytime a dataset is mentioned, load the dataset and check for
    #   existence and that the user has access to it
    # TODO: creation date, update date, creatorId
    # TODO: find annotations by roi, tag, childOf and parentOf
    # TODO(performance): smarter indexing
    # TODO(performance): use objectId whenever possible
    # TODO: error handling and documentation

    @access.user
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
        return self._annotationModel.create(annotation)

    @access.user
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
        return self._annotationModel.createMultiple(annotations)

    @describeRoute(
        Description("Delete an existing annotation")
        .param("id", "The annotation's Id", paramType="path")
        .errorResponse("ID was invalid.")
        .errorResponse("Write access was denied for the annotation.", 403)
    )
    @access.user
    @loadmodel(
        model="upenn_annotation",
        plugin="upenncontrast_annotation",
        level=AccessType.WRITE,
    )
    @recordable("Delete an annotation", getDatasetIdFromLoadedAnnotation)
    def delete(self, upenn_annotation, params):
        self._annotationModel.delete(upenn_annotation)

    @access.user
    @describeRoute(
        Description("Delete all annotations in the id list").param(
            "body", "A list of all annotation ids to delete.", paramType="body"
        )
    )
    @memoizeBodyJson
    @recordable(
        "Delete multiple annotations", getDatasetIdFromAnnotationIdListInBody
    )
    def deleteMultiple(self, params, *args, **kwargs):
        bodyJson = kwargs["memoizedBodyJson"]
        stringIds = [stringId for stringId in bodyJson]
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
    @access.user
    @loadmodel(
        model="upenn_annotation",
        plugin="upenncontrast_annotation",
        level=AccessType.WRITE,
    )
    @memoizeBodyJson
    @recordable("Update an annotation", getDatasetIdFromLoadedAnnotation)
    def update(self, upenn_annotation, params, *args, **kwargs):
        bodyJson = kwargs["memoizedBodyJson"]
        upenn_annotation.update(bodyJson)
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
    @access.user
    @memoizeBodyJson
    @recordable("Update an annotation", getDatasetIdFromAnnotationListInBody)
    def updateMultiple(self, params, *args, **kwargs):
        bodyJson = kwargs["memoizedBodyJson"]
        self._annotationModel.updateMultiple(bodyJson, self.getCurrentUser())

    @access.user
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
        .pagingParams(defaultSort="_id")
        .errorResponse()
    )
    def find(self, params):
        limit, offset, sort = self.getPagingParameters(params, "lowerName")

        # First, check dataset permissions explicitly
        datasetId = ObjectId(params["datasetId"])
        dataset = Folder().load(
            datasetId, user=self.getCurrentUser(), level=AccessType.READ
        )
        if not dataset:
            raise RestException(code=403, message="Access denied to dataset")

        # Now query annotations directly without ACL filtering
        query = {"datasetId": datasetId}
        if params["shape"] is not None:
            query["shape"] = params["shape"]
        if params["tags"] is not None and len(params["tags"]) > 0:
            query["tags"] = {"$all": params["tags"]}

        # Use regular find instead of findWithPermissions
        cursor = self._annotationModel.find(
            query,
            sort=sort,
            limit=limit,
            offset=offset,
        )

        def generateResult():
            chunk = [b"["]
            first = True
            for annotation in cursor:
                if not first:
                    chunk.append(b",")
                # Otherwise, we can use json
                # chunk.append(json.dumps(annotation, allow_nan=False,
                #             cls=JsonEncoder, separators=(",", ":")).encode())
                # If we got rid of ObjectIds, using the json defaults is faster
                # chunk.append(json.dumps(annotation).encode())
                # But orjson is faster yet
                chunk.append(orjson.dumps(annotation, default=orJsonDefaults))
                first = False
                if len(chunk) > 1000:
                    yield b"".join(chunk)
                    chunk = []
            chunk.append(b"]")
            yield b"".join(chunk)

        setResponseHeader("Content-Type", "application/json")
        if callable(getattr(cursor, 'count', None)):
            cherrypy.response.headers['Girder-Total-Count'] = cursor.count()
        return generateResult

    @access.user
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

    @access.user
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

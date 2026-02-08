from bson import ObjectId

from girder.api import access
from girder.api.describe import Description, describeRoute
from girder.api.rest import Resource
from girder.constants import AccessType
from girder.exceptions import RestException
from girder.models.folder import Folder

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
        self.route("GET", (), self.find)
        self.route("GET", ("count",), self.count)
        self.route("GET", ("histogram",), self.histogram)

    # TODO: anytime a dataset is mentioned, load the dataset and check for
    #   existence and that the user has access to it
    # TODO: creation date, update date, creatorId ?
    # TODO(performance): proper indexing
    # TODO(performance): use objectId whenever possible

    @access.user
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
        return self._annotationPropertyValuesModel.appendValues(
            self.getBodyJson(),
            params["annotationId"],
            params["datasetId"],
        )

    @access.user
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
        propertyValuesList = self._annotationPropertyValuesModel.\
            convertIdsToObjectIds(self.getBodyJson())
        return self._annotationPropertyValuesModel.appendMultipleValues(
            propertyValuesList
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
    @access.user
    def delete(self, params):
        if "propertyId" not in params:
            raise RestException(code=400, message="Property ID was invalid")
        if "datasetId" not in params:
            raise RestException(code=400, message="Dataset ID was invalid")
        params = self._annotationPropertyValuesModel.convertIdsToObjectIds(
            params)
        self._annotationPropertyValuesModel.delete(
            params["propertyId"], params["datasetId"]
        )

    @access.public
    @describeRoute(
        Description("Search for property values")
        .responseClass("annotation")
        .param(
            "datasetId",
            "Get all property values for this dataset",
            required=False,
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
        limit, offset, sort = self.getPagingParameters(params, "lowerName")
        query = {}

        # Check dataset permissions if datasetId is provided
        if "datasetId" in params:
            datasetId = ObjectId(params["datasetId"])
            dataset = Folder().load(
                datasetId, user=self.getCurrentUser(), level=AccessType.READ
            )
            if not dataset:
                raise RestException(
                    code=403, message="Access denied to dataset"
                )
            query["datasetId"] = datasetId

        if "annotationId" in params:
            query["annotationId"] = ObjectId(params["annotationId"])

        # Support cursor pagination
        after_id = params.get("afterId")
        if after_id:
            query["_id"] = {"$gt": ObjectId(after_id)}
            offset = 0  # Ignore offset when using cursor

        # Use regular find instead of findWithPermissions
        return self._annotationPropertyValuesModel.find(
            query,
            sort=sort,
            limit=limit,
            offset=offset,
        ).hint([("datasetId", 1), ("_id", 1)])

    @access.public
    @describeRoute(
        Description("Get property value count for a dataset")
        .param("datasetId", "Get count for this dataset", required=True)
        .errorResponse()
    )
    def count(self, params):
        if "datasetId" not in params:
            raise RestException(code=400, message="Dataset ID is required")
        datasetId = ObjectId(params["datasetId"])
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

    @access.public
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
        if "buckets" in params:
            return self._annotationPropertyValuesModel.histogram(
                params["propertyPath"],
                params["datasetId"],
                int(params["buckets"]),
            )
        else:
            return self._annotationPropertyValuesModel.histogram(
                params["propertyPath"], params["datasetId"]
            )

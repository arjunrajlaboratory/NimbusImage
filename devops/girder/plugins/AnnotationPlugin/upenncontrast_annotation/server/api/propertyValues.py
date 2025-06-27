from girder.api import access
from girder.api.describe import Description, describeRoute
from girder.constants import AccessType
from girder.api.rest import Resource
from ..models.propertyValues import (
    AnnotationPropertyValues as PropertyValuesModel,
)
from girder.exceptions import AccessException, RestException


class PropertyValues(Resource):
    def __init__(self):
        super().__init__()
        self.resourceName = "annotation_property_values"
        self._annotationPropertyValuesModel = PropertyValuesModel()

        self.route("DELETE", (), self.delete)
        self.route("POST", (), self.add)
        self.route("POST", ("multiple",), self.addMultiple)
        self.route("GET", (), self.find)
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
        currentUser = self.getCurrentUser()
        if not currentUser:
            raise AccessException("User not found", "currentUser")
        return self._annotationPropertyValuesModel.appendValues(
            currentUser,
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
        currentUser = self.getCurrentUser()
        if not currentUser:
            raise AccessException("User not found", "currentUser")
        return self._annotationPropertyValuesModel.appendMultipleValues(
            currentUser, self.getBodyJson()
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
        self._annotationPropertyValuesModel.delete(
            params["propertyId"], params["datasetId"]
        )

    @access.user
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
        .pagingParams(defaultSort="_id")
        .errorResponse()
    )
    def find(self, params):
        limit, offset, sort = self.getPagingParameters(params, "lowerName")
        query = {}
        if "datasetId" in params:
            query["datasetId"] = params["datasetId"]
        if "annotationId" in params:
            query["annotationId"] = params["annotationId"]
        return self._annotationPropertyValuesModel.findWithPermissions(
            query,
            sort=sort,
            user=self.getCurrentUser(),
            level=AccessType.READ,
            limit=limit,
            offset=offset,
        )

    @access.user
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

from girder.api import access
from girder.api.describe import Description, describeRoute
from girder.constants import AccessType
from girder.api.rest import Resource, loadmodel
from ..models.property import AnnotationProperty as PropertyModel
from girder.exceptions import AccessException


class AnnotationProperty(Resource):

    def __init__(self):
        super().__init__()
        self.resourceName = "annotation_property"
        self._propertyModel = PropertyModel()

        self.route("DELETE", (":id",), self.delete)
        self.route("GET", (":id",), self.get)
        self.route("GET", (), self.find)
        self.route("POST", (), self.create)
        self.route("PUT", (":id",), self.update)
        self.route(
            "POST",
            (
                ":id",
                "compute",
            ),
            self.compute,
        )

    @access.user
    @describeRoute(
        Description(
            (
                "Compute a property for all annotations in the specified"
                "dataset, or a specific list of annotations"
            )
        )
        .param("id", "The id of the property", paramType="path")
        .param(
            "datasetId",
            (
                "The dataset for whose annotations "
                "the property should be computed"
            ),
            required=False,
        )
        .param(
            "body",
            "A JSON object containing parameters for the computation",
            paramType="body",
        )
    )
    @loadmodel(
        model="annotation_property",
        plugin="upenncontrast_annotation",
        level=AccessType.READ,
    )
    def compute(self, annotation_property, params):
        datasetId = params.get("datasetId", None)
        if datasetId and id:
            return self._propertyModel.compute(
                annotation_property, datasetId, self.getBodyJson()
            )
        return {}

    @access.user
    @describeRoute(
        Description("Create a new property").param(
            "body", "Property Object", paramType="body"
        )
    )
    def create(self, params):
        currentUser = self.getCurrentUser()
        if not currentUser:
            raise AccessException("User not found", "currentUser")
        return self._propertyModel.create(currentUser, self.getBodyJson())

    @describeRoute(
        Description("Delete an existing property")
        .param("id", "The property's Id", paramType="path")
        .errorResponse("ID was invalid.")
        .errorResponse("Write access was denied for the property.", 403)
    )
    @access.user
    @loadmodel(
        model="annotation_property",
        plugin="upenncontrast_annotation",
        level=AccessType.WRITE,
    )
    def delete(self, annotation_property, params):
        self._propertyModel.delete(annotation_property)

    @describeRoute(
        Description("Update an existing property")
        .param("id", "The ID of the property.", paramType="path")
        .param(
            "body", "A JSON object containing the property.", paramType="body"
        )
        .errorResponse("Write access was denied for the item.", 403)
        .errorResponse("Invalid JSON passed in request body.")
        .errorResponse("Validation Error: JSON doesn't follow schema.")
    )
    @access.user
    @loadmodel(
        model="annotation_property",
        plugin="upenncontrast_annotation",
        level=AccessType.WRITE,
    )
    def update(self, property, params):
        property.update(self.getBodyJson())
        self._propertyModel.save(property)

    @access.public
    @describeRoute(
        Description("Search for properties")
        .responseClass("property")
        .pagingParams(defaultSort="_id")
        .errorResponse()
    )
    def find(self, params):
        limit, offset, sort = self.getPagingParameters(params, "lowerName")
        query = {}
        # if 'datasetId' in params:
        #     query['datasetId'] = params['datasetId']
        return self._propertyModel.findWithPermissions(
            query,
            sort=sort,
            user=self.getCurrentUser(),
            level=AccessType.READ,
            limit=limit,
            offset=offset,
        )

    @access.public
    @describeRoute(
        Description("Get a property by its id.").param(
            "id", "The annotation property's id", paramType="path"
        )
    )
    @loadmodel(
        model="annotation_property",
        plugin="upenncontrast_annotation",
        level=AccessType.READ,
    )
    def get(self, annotation_property, params):
        return annotation_property

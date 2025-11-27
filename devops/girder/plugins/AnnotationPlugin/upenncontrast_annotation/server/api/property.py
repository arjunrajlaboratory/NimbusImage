from girder.api import access
from girder.api.describe import Description, describeRoute
from girder.constants import AccessType
from girder.api.rest import Resource, loadmodel
from ..models.property import AnnotationProperty as PropertyModel
from ..models.collection import Collection as CollectionModel
from girder.exceptions import RestException, AccessException
from bson import ObjectId


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
        user = self.getCurrentUser()

        # Get all accessible configurations
        accessible_configs = list(CollectionModel().findWithPermissions(
            {},
            user=user,
            level=AccessType.READ
        ))

        # Collect all property IDs from accessible configurations
        accessible_property_ids = set()
        for config in accessible_configs:
            if 'meta' in config and 'propertyIds' in config['meta']:
                for pid in config['meta']['propertyIds']:
                    accessible_property_ids.add(ObjectId(pid))

        # Query properties
        if accessible_property_ids:
            query = {'_id': {'$in': list(accessible_property_ids)}}
        else:
            # User has no accessible configurations, return empty
            query = {'_id': {'$in': []}}

        return self._propertyModel.find(
            query,
            sort=sort,
            limit=limit,
            offset=offset,
        )

    @access.public
    @describeRoute(
        Description("Get a property by its id.").param(
            "id", "The annotation property's id", paramType="path"
        )
    )
    def get(self, id, params):
        # 1. Validate ID format
        if not ObjectId.is_valid(id):
            raise RestException('Invalid Id', code=400)

        user = self.getCurrentUser()

        # 2. Load property strictly to ensure it exists (force=True ignores
        # ACLs) using the 'id' argument passed from the URL
        prop = self._propertyModel.load(ObjectId(id), force=True)

        if not prop:
            raise RestException('Property not found', code=404)

        # 3. Check if user has READ access to ANY configuration that
        # references this property.
        # Note: CollectionSchema defines propertyIds as strings, so we pass
        # 'id' directly.
        accessible_configs = CollectionModel().findWithPermissions(
            {'meta.propertyIds': id},
            user=user,
            level=AccessType.READ,
            limit=1  # Optimization: We only need to know if ONE exists
        )

        # 4. If the cursor is empty, access is denied
        if accessible_configs.count() == 0:
            # If the user is anonymous and fails check, usually 401 is better,
            # but 403 or 404 is standard for "hidden" items.
            raise AccessException(f'Read access denied for property {id}')

        return prop

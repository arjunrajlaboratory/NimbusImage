from girder.api import access
from girder.api.describe import Description, describeRoute
from girder.constants import AccessType
from girder.api.rest import Resource, loadmodel
from ..models.property import AnnotationProperty as PropertyModel
from ..models.collection import Collection as CollectionModel
from girder.exceptions import RestException, AccessException
from bson import ObjectId
from bson.errors import InvalidId


class AnnotationProperty(Resource):

    def __init__(self):
        super().__init__()
        self.resourceName = "annotation_property"
        self._propertyModel = PropertyModel()

        self.route("DELETE", (":id",), self.delete)
        self.route("GET", (":id",), self.get)
        self.route("GET", (), self.getAllProperties)
        self.route("GET", ("count",), self.count)
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
            "body",
            "A JSON object containing the property.",
            paramType="body"
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
    def getAllProperties(self, params):
        # Note that this function is analogous to the "find" function in other
        # classes, but here we don't have any filtering criteria, so we can
        # just get all properties.

        limit, offset, sort = self.getPagingParameters(params, "lowerName")
        user = self.getCurrentUser()

        # Get all accessible configurations
        accessible_configs = list(CollectionModel().findWithPermissions(
            {},
            user=user,
            level=AccessType.READ
        ))

        # Collect all property IDs from accessible configurations
        # Note: propertyIds are stored as strings in meta.propertyIds (per
        # schema), but we need ObjectIds to query the _id field, so conversion
        # is necessary.
        accessible_property_ids = set()
        for config in accessible_configs:
            if 'meta' in config and 'propertyIds' in config['meta']:
                for pid in config['meta']['propertyIds']:
                    accessible_property_ids.add(ObjectId(pid))

        # Query properties
        # Note: $in with an empty list returns no results, same as empty set
        query = {'_id': {'$in': list(accessible_property_ids)}}

        return self._propertyModel.find(
            query,
            sort=sort,
            limit=limit,
            offset=offset,
        )

    @access.public
    @describeRoute(
        Description("Get property count for a configuration")
        .param(
            "configurationId",
            "Get count for this configuration",
            required=True
        )
        .errorResponse()
    )
    def count(self, params):
        if "configurationId" not in params:
            raise RestException(
                code=400, message="Configuration ID is required"
            )

        configId = params["configurationId"]
        user = self.getCurrentUser()

        # Check access to configuration
        try:
            config = CollectionModel().load(
                ObjectId(configId), user=user, level=AccessType.READ
            )
        except InvalidId as exc:
            raise RestException(
                code=400, message="Invalid configuration ID"
            ) from exc

        if not config:
            raise RestException(
                code=403, message="Access denied to configuration"
            )

        # Count properties in this configuration
        count = 0
        if 'meta' in config and 'propertyIds' in config['meta']:
            count = len(config['meta']['propertyIds'])

        return {"count": count}

    @access.public
    @describeRoute(
        Description("Get a property by its id.").param(
            "id", "The annotation property's id", paramType="path"
        )
    )
    def get(self, id, params):
        # Note that params is not used in this method, but it is required by
        # the describeRoute decorator. This is because the describeRoute
        # decorator expects a params argument, but we don't need it in this
        # method.

        user = self.getCurrentUser()

        # 1. Convert ID to ObjectId (will raise InvalidId if invalid)
        try:
            propertyId = ObjectId(id)
        except InvalidId as exc:
            raise RestException('Invalid Id', code=400) from exc

        # 2. Load property strictly to ensure it exists (force=True ignores
        # ACLs, exc=True raises exception if not found)
        prop = self._propertyModel.load(propertyId, force=True, exc=True)

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

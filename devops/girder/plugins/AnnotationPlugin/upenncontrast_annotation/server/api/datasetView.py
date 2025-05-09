from bson import ObjectId

from girder import logprint
from girder.api import access
from girder.api.describe import autoDescribeRoute, Description, describeRoute
from girder.api.rest import Resource, loadmodel
from girder.constants import AccessType
from girder.exceptions import AccessException
from girder.exceptions import RestException
from girder.models.folder import Folder
from girder.models.user import User

from upenncontrast_annotation.server.models.datasetView import \
    DatasetView as DatasetViewModel
from upenncontrast_annotation.server.models.collection import \
    Collection as CollectionModel


class DatasetView(Resource):

    def __init__(self):
        super().__init__()
        self.resourceName = "dataset_view"
        self._datasetViewModel = DatasetViewModel()

        self.route("GET", (":id",), self.get)
        self.route("POST", (), self.create)
        self.route("DELETE", (":id",), self.delete)
        self.route("PUT", (":id",), self.update)
        self.route("GET", (), self.find)
        self.route("POST", ("share",), self.share)

    @access.user
    @describeRoute(
        Description("Get a dataset view by its id.").param(
            "id", "The dataset view's id", paramType="path"
        )
    )
    @loadmodel(
        model="dataset_view",
        plugin="upenncontrast_annotation",
        level=AccessType.READ,
    )
    def get(self, dataset_view, params):
        return dataset_view

    @access.user
    @describeRoute(
        Description("Create a new dataset view.").param(
            "body", "Dataset View Object", paramType="body"
        )
    )
    def create(self, params):
        new_document = self._datasetViewModel.convertIdsToObjectIds(
            self.getBodyJson())
        currentUser = self.getCurrentUser()
        if not currentUser:
            raise AccessException("User not found", "currentUser")
        # Check with same datasetId and configurationId already exists
        query = {
            "datasetId": new_document["datasetId"],
            "configurationId": new_document["configurationId"],
        }
        cursor = self._datasetViewModel.findWithPermissions(
            query, user=currentUser, level=AccessType.WRITE
        )
        old_document = next(cursor, None)
        # If it exists, just update the document instead of creating a new one
        if old_document:
            return self._datasetViewModel.update(old_document, new_document)
        return self._datasetViewModel.create(currentUser, new_document)

    @describeRoute(
        Description("Delete an existing dataset view.")
        .param("id", "The dataset view's Id", paramType="path")
        .errorResponse("ID was invalid.")
        .errorResponse("Write access was denied for the dataset view.", 403)
    )
    @access.user
    @loadmodel(
        model="dataset_view",
        plugin="upenncontrast_annotation",
        level=AccessType.WRITE,
    )
    def delete(self, dataset_view, params):
        self._datasetViewModel.delete(dataset_view)

    @describeRoute(
        Description("Update an existing dataset view.")
        .param("id", "The ID of the dataset view.", paramType="path")
        .param(
            "body",
            "A JSON object containing the dataset view.",
            paramType="body",
        )
        .errorResponse("Write access was denied for the item.", 403)
        .errorResponse("Invalid JSON passed in request body.")
        .errorResponse("Validation Error: JSON doesn't follow schema.")
    )
    @access.user
    @loadmodel(
        model="dataset_view",
        plugin="upenncontrast_annotation",
        level=AccessType.WRITE,
    )
    def update(self, dataset_view, params):
        new_dataset_view = self._datasetViewModel.convertIdsToObjectIds(
            self.getBodyJson())
        self._datasetViewModel.updateDatasetView(
            dataset_view, new_dataset_view)

    @access.user
    @describeRoute(
        Description("Search for dataset views.")
        .responseClass("dataset_view")
        .param(
            "datasetId",
            "Get all dataset views on this dataset",
            required=False,
        )
        .param(
            "configurationId",
            "Get all dataset views using this configuration",
            required=False,
        )
        .pagingParams(defaultSort="_id")
        .errorResponse()
    )
    def find(self, params):
        limit, offset, sort = self.getPagingParameters(params, "lowerName")
        query = {}
        for key in ["datasetId", "configurationId"]:
            if key in params:
                query[key] = ObjectId(params[key])
        return self._datasetViewModel.findWithPermissions(
            query,
            sort=sort,
            user=self.getCurrentUser(),
            level=AccessType.READ,
            limit=limit,
            offset=offset,
        )

    @access.user
    @autoDescribeRoute(
        Description("Share a DatasetView to another user")
        .jsonParam(
            "body",
            description="Should match schema",
            paramType="body",
            schema={
                "$schema": "http://json-schema.org/draft-04/schema",
                "id": "datasetView_share",
                "type": "object",
                "properties": {
                    "datasetViewIds": {"type": "array"},
                    "userMailOrUsername": {"type": "string"},
                    "accessType": {"type": "number"},
                },
                "required": [
                    "datasetViewIds", "userMailOrUsername", "accessType"],
            }
        )
    )
    def share(self, body):
        user = self.getCurrentUser()

        def loadDocument(model, documentId):
            return model.load(documentId, AccessType.WRITE, user, exc=True)

        targetUser = User().findOne(
            {"$or": [{"login": body["userMailOrUsername"]},
                     {"email": body["userMailOrUsername"]}]})
        if not targetUser:
            logprint.error(f"Cannot find user {body['userMailOrUsername']}")
            raise RestException("badEmailOrUsername")
        # Will raise if accessType is a bad value
        accessType = AccessType().validate(body["accessType"])

        # Will raise if user has not WRITE permissions on a datasetView
        datasetViews = [
            loadDocument(DatasetViewModel(), datasetViewId)
            for datasetViewId in body["datasetViewIds"]]

        # Will raise if user has not WRITE permissions on the dataset
        dataset = loadDocument(Folder(), datasetViews[0]["datasetId"])

        # Will raise if user has not WRITE permissions on a configuration
        for datasetView in datasetViews:
            datasetView['configuration'] = loadDocument(
                CollectionModel(), datasetView['configurationId'])

        # Iterating twice so we first make sure all elements are accessible
        # before modifying anything
        for datasetView in datasetViews:
            CollectionModel().setUserAccess(
                datasetView['configuration'], targetUser, accessType,
                save=True)
            datasetView.pop('configuration')
            DatasetViewModel().setUserAccess(
                datasetView, targetUser, accessType,
                save=True)

        Folder().setUserAccess(
            dataset, targetUser, accessType, save=True)

        return True

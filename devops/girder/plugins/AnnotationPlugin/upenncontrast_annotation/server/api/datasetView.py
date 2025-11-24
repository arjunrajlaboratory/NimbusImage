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
        self.route("POST", ("bulk_find",), self.findBulk)
        self.route("POST", ("share",), self.share)
        self.route("POST", ("set_public",), self.setDatasetPublic)
        # Bulk mapping endpoint to resolve datasetId <-> configurationId pairs
        self.route("POST", ("map",), self.map)

    @access.public
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

    @access.public
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

        # Handle single IDs from query params
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

    @access.public
    @autoDescribeRoute(
        Description("""
        Bulk search for dataset views (READ OPERATION).

        NOTE: This is a POST endpoint for technical reasons (to avoid URL
        length limits with large arrays), but it performs a READ operation
        only. No data is created, updated, or deleted.

        Use this endpoint when you need to search for dataset views across
        multiple datasets or configurations efficiently.
        """)
        .responseClass("dataset_view", array=True)
        .jsonParam(
            "body",
            "Request body with optional arrays: datasetIds, configurationIds",
            required=False,
            paramType='body'
        )
        .errorResponse()
        .notes("""
        Example request body:
        {
            "datasetIds": ["id1", "id2", "id3"],
            "configurationIds": ["config1", "config2"]
        }

        Returns all dataset views that match ANY of the provided datasets
        OR configurations (uses MongoDB $in operator for efficient querying).
        """)
    )
    def findBulk(self, body):
        query = {}

        # Handle multiple IDs from request body
        if body:
            for single_key, plural_key in [
                ("datasetId", "datasetIds"),
                ("configurationId", "configurationIds")
            ]:
                if plural_key in body and body[plural_key]:
                    # Handle JSON array of IDs
                    ids = (body[plural_key]
                           if isinstance(body[plural_key], list)
                           else [])
                    if ids:
                        query[single_key] = {
                            "$in": [ObjectId(id) for id in ids]
                        }

        return list(self._datasetViewModel.findWithPermissions(
            query,
            sort=None,
            user=self.getCurrentUser(),
            level=AccessType.READ,
        ))

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

    @access.user
    @autoDescribeRoute(
        Description(
            "Make a dataset and all associated views/configs public or private"
        )
        .notes("""
            Sets public READ access on:
            - The dataset folder itself
            - All datasetViews for this dataset
            - All configurations used by those datasetViews

            Write operations remain restricted to users with WRITE permissions.
        """)
        .modelParam('datasetId', 'The dataset folder ID', model=Folder, 
                    level=AccessType.ADMIN, destName='dataset')
        .param('public', 'True to make public, False to make private',
               dataType='boolean', required=True)
    )
    def setDatasetPublic(self, dataset, public):
        """Set a dataset and all associated resources to public or private."""

        # 1. Set the dataset (folder) itself to public
        Folder().setPublic(dataset, public, save=True)

        # 2. Find all DatasetViews
        # Use collection.find to get all regardless of permissions
        # This used to be datasetViews = list(self._datasetViewModel.find({
        # but changed it here while getting things to work; could test.
        datasetViews = list(self._datasetViewModel.collection.find({
            'datasetId': dataset['_id']
        }))

        # 3. Collect unique configuration IDs
        configIds = {dv['configurationId'] for dv in datasetViews}

        # 4. Set permissions on DatasetViews
        for dv in datasetViews:
            self._datasetViewModel.setPublic(dv, public, save=True)

        # 5. Set permissions on Configurations
        for configId in configIds:
            config = CollectionModel().load(configId, force=True)
            if config:
                CollectionModel().setPublic(config, public, save=True)

        return {
            'dataset': str(dataset['_id']),
            'public': public,
            'datasetViewsUpdated': len(datasetViews),
            'configurationsUpdated': len(configIds)
        }

    @access.public
    @autoDescribeRoute(
        Description("Bulk map dataset and configuration ids")
        .notes(
            "Given many datasetIds and/or configurationIds, returns all "
            "matching dataset_view pairs. Optionally includes names so the "
            "client can avoid additional resource lookups."
        )
        .jsonParam(
            "body",
            description=(
                "Object with optional keys: datasetIds, configurationIds, "
                "includeNames, limit, offset"
            ),
            paramType="body",
            requireObject=True,
        )
    )
    def map(self, body):
        # Parse input
        includeNames = bool(body.get("includeNames", False))
        # Ensure valid integers for pagination (PyMongo requires int, not None)
        try:
            limit = int(body.get("limit", 0))
        except ValueError:
            limit = 0
        try:
            offset = int(body.get("offset", 0))
        except ValueError:
            offset = 0

        # Build query
        query = {}
        # Map body field names to query field names (plural to singular)
        fieldMapping = {
            "datasetIds": "datasetId",
            "configurationIds": "configurationId"
        }
        for bodyKey, queryKey in fieldMapping.items():
            if bodyKey in body:
                idsArray = body.get(bodyKey, [])
                if idsArray:
                    query[queryKey] = {
                        "$in": [ObjectId(x) for x in idsArray]
                    }

        # Use same sort as find() by default
        sort = None

        cursor = self._datasetViewModel.findWithPermissions(
            query,
            sort=sort,
            user=self.getCurrentUser(),
            level=AccessType.READ,
            limit=limit,
            offset=offset,
        )

        results = []
        if includeNames:
            # Preload names maps to avoid per-document lookups later
            dsIds = set()
            cfgIds = set()
            # We must materialize cursor to iterate twice safely
            views = list(cursor)
            for v in views:
                dsIds.add(v["datasetId"])  # ObjectId
                cfgIds.add(v["configurationId"])  # ObjectId

            # Load names under READ access using bulk aggregation
            user = self.getCurrentUser()

            def loadNamesBulk(model, ids):
                if not ids:
                    return {}

                # Use findWithPermissions to bulk load with permission checking
                # This respects user permissions and is much more efficient
                # than loading each document individually
                docs = model.findWithPermissions(
                    query={"_id": {"$in": list(ids)}},
                    user=user,
                    level=AccessType.READ
                )

                # Build the mapping from the results
                mapping = {}
                for doc in docs:
                    mapping[doc["_id"]] = doc.get("name")

                return mapping

            datasetNames = loadNamesBulk(Folder(), dsIds)
            configurationNames = loadNamesBulk(CollectionModel(), cfgIds)

        def formatView(v):
            dsId = str(v["datasetId"])
            cfgId = str(v["configurationId"])

            result = {
                "datasetId": dsId,
                "configurationId": cfgId,
            }

            if includeNames:
                result["datasetName"] = datasetNames.get(v["datasetId"])
                result["configurationName"] = configurationNames.get(
                    v["configurationId"]
                )

            return result

        if includeNames:
            results = [formatView(v) for v in views]
        else:
            results = [formatView(v) for v in cursor]

        return results

import logging

from bson import ObjectId

from girder.api import access
from girder.api.describe import autoDescribeRoute, Description, describeRoute
from girder.api.rest import Resource, filtermodel, loadmodel
from girder.constants import AccessType, TokenScope
from girder.exceptions import AccessException
from girder.exceptions import RestException
from girder.models.folder import Folder

from upenncontrast_annotation.server.helpers.access_helpers import (
    findShareTarget, formatAccessList, parseShareAccessType,
    requireCanSetUserAccess
)
from upenncontrast_annotation.server.helpers.params import getBooleanParam
from upenncontrast_annotation.server.helpers.validation import (
    requireObjectBody, requireObjectId
)
from upenncontrast_annotation.server.models.datasetView import \
    DatasetView as DatasetViewModel
from upenncontrast_annotation.server.models.collection import \
    Collection as CollectionModel

logger = logging.getLogger(__name__)


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
        self.route("GET", ("access", ":datasetId"), self.getDatasetAccess)
        self.route(
            "GET", ("configuration_access", ":configurationId"),
            self.getConfigurationAccess)
        # Bulk mapping endpoint to resolve datasetId <-> configurationId pairs
        self.route("POST", ("map",), self.map)

    @access.public(scope=TokenScope.DATA_READ)
    @filtermodel(model=DatasetViewModel)
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
        # @filtermodel adds the caller's _accessLevel.
        return dataset_view

    @access.user(scope=TokenScope.DATA_WRITE)
    @filtermodel(model=DatasetViewModel)
    @describeRoute(
        Description("Create a new dataset view.").param(
            "body", "Dataset View Object", paramType="body"
        )
    )
    def create(self, params):
        # Keep only the schema's fields: the body is saved as the document,
        # so an `access` or `public` key would otherwise land in the ACL.
        body = self._datasetViewModel.filterUpdateFields(
            requireObjectBody(self.getBodyJson()))
        currentUser = self.getCurrentUser()
        if not currentUser:
            raise AccessException("User not found", "currentUser")
        # A view pairs a dataset with a configuration; the caller must be
        # able to read both (and a missing id is a 400, not a KeyError 500).
        datasetId = requireObjectId(body.get("datasetId"), "datasetId")
        configurationId = requireObjectId(
            body.get("configurationId"), "configurationId")
        Folder().load(
            datasetId, user=currentUser, level=AccessType.READ, exc=True)
        CollectionModel().load(
            configurationId, user=currentUser, level=AccessType.READ,
            exc=True)
        new_document = self._datasetViewModel.convertIdsToObjectIds(body)
        # Check with same datasetId and configurationId already exists
        query = {
            "datasetId": datasetId,
            "configurationId": configurationId,
        }
        cursor = self._datasetViewModel.findWithPermissions(
            query, user=currentUser, level=AccessType.WRITE
        )
        old_document = next(cursor, None)
        # If it exists, just update the document instead of creating a new one
        if old_document:
            return self._datasetViewModel.updateDatasetView(
                old_document, new_document
            )
        return self._datasetViewModel.create(currentUser, new_document)

    @describeRoute(
        Description("Delete an existing dataset view.")
        .param("id", "The dataset view's Id", paramType="path")
        .errorResponse("ID was invalid.")
        .errorResponse("Write access was denied for the dataset view.", 403)
    )
    @access.user(scope=TokenScope.DATA_WRITE)
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
    @access.user(scope=TokenScope.DATA_WRITE)
    @loadmodel(
        model="dataset_view",
        plugin="upenncontrast_annotation",
        level=AccessType.WRITE,
    )
    def update(self, dataset_view, params):
        # As in create: a WRITE user's body must not reach `access`/`public`
        # (granting themselves ADMIN on the view) or other Girder fields.
        new_dataset_view = self._datasetViewModel.convertIdsToObjectIds(
            self._datasetViewModel.filterUpdateFields(
                requireObjectBody(self.getBodyJson())))
        self._datasetViewModel.updateDatasetView(
            dataset_view, new_dataset_view)

    @access.public(scope=TokenScope.DATA_READ)
    @filtermodel(model=DatasetViewModel)
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
        .param(
            "currentUserOnly",
            "If true, only return views owned by the current user "
            "(where the user has ADMIN access).",
            required=False,
            dataType="boolean",
        )
        .pagingParams(defaultSort="_id")
        .errorResponse()
    )
    def find(self, params):
        limit, offset, sort = self.getPagingParameters(params, "lowerName")
        query = {}
        user = self.getCurrentUser()

        # Handle single IDs from query params
        for key in ["datasetId", "configurationId"]:
            if key in params:
                query[key] = ObjectId(params[key])

        if getBooleanParam(params, "currentUserOnly") and user:
            # Intentionally checks only direct user grants (not group-based
            # access): "Mine only" means views the user personally owns,
            # which corresponds to the explicit ADMIN entry creators receive.
            query["access.users"] = {
                "$elemMatch": {
                    "id": user["_id"],
                    "level": AccessType.ADMIN,
                }
            }

        return self._datasetViewModel.findWithPermissions(
            query,
            sort=sort,
            user=user,
            level=AccessType.READ,
            limit=limit,
            offset=offset,
        )

    @access.public(scope=TokenScope.DATA_READ)
    @filtermodel(model=DatasetViewModel)
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

    @access.user(scope=TokenScope.DATA_WRITE)
    @autoDescribeRoute(
        Description("Share or revoke access to DatasetViews for another user")
        .notes("""
            Set accessType to:
            - 0 (READ) for view-only access
            - 1 (WRITE) for edit access
            - 2 (ADMIN) for owner access
            - -1 to remove user's access entirely

            Requires WRITE on the dataset and on every view and
            configuration; all views must belong to one dataset. The caller
            cannot grant a level above their own, nor change or remove a
            user whose current level is above their own.
            Nobody but a site admin can take the dataset's creator below
            ADMIN (400, nothing changed).
        """)
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
                    "accessType": {"type": "integer"},
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

        targetUser = findShareTarget(body["userMailOrUsername"])

        # Will raise if accessType is a bad value; -1 (remove) becomes None
        accessType = parseShareAccessType(body["accessType"])

        # Will raise if user has not WRITE permissions on a datasetView
        datasetViews = [
            loadDocument(DatasetViewModel(), datasetViewId)
            for datasetViewId in body["datasetViewIds"]]

        # Only the dataset's own views and configurations may change here
        if len({view["datasetId"] for view in datasetViews}) != 1:
            raise RestException(
                "datasetViewIds must all belong to one dataset", code=400)

        # Will raise if user has not WRITE permissions on the dataset
        dataset = loadDocument(Folder(), datasetViews[0]["datasetId"])

        # Will raise if user has not WRITE permissions on a configuration
        for datasetView in datasetViews:
            datasetView['configuration'] = loadDocument(
                CollectionModel(), datasetView['configurationId'])

        # WRITE is enough to share, but never above the caller's own level:
        # a WRITE collaborator can't grant ADMIN or demote/remove an owner.
        requireCanSetUserAccess(
            Folder(), dataset, user, targetUser, accessType)
        for datasetView in datasetViews:
            requireCanSetUserAccess(
                DatasetViewModel(), datasetView, user, targetUser, accessType)
            requireCanSetUserAccess(
                CollectionModel(), datasetView['configuration'], user,
                targetUser, accessType)

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

    @access.user(scope=TokenScope.DATA_WRITE)
    @autoDescribeRoute(
        Description(
            "Make a dataset and all associated views/configs public or private"
        )
        .notes("""
            Sets public READ access on:
            - The dataset folder itself
            - The datasetViews for this dataset that the caller administers
            - The configurations used by those datasetViews that the caller
              administers

            Views and configurations owned by other users are left as they
            are, whether publishing or making private; those not already in
            the requested state are counted in datasetViewsSkipped /
            configurationsSkipped.

            Write operations remain restricted to users with WRITE permissions.
        """)
        .modelParam('datasetId', 'The dataset folder ID', model=Folder,
                    level=AccessType.ADMIN, destName='dataset')
        .param('public', 'True to make public, False to make private',
               dataType='boolean', required=True)
    )
    def setDatasetPublic(self, dataset, public):
        """Make a dataset, and the views/configurations of it the caller
        administers, public or private."""
        user = self.getCurrentUser()

        # 1. Set the dataset (folder) itself to public
        Folder().setPublic(dataset, public, save=True)

        # 2. Find all DatasetViews of the dataset, and the configurations
        # they use. Other users may have opened the dataset with their own
        # configuration, so both lists can hold documents the caller does
        # not own.
        datasetViews = list(self._datasetViewModel.find({
            'datasetId': dataset['_id']
        }))
        viewQuery = {'_id': {'$in': [dv['_id'] for dv in datasetViews]}}
        configQuery = {'_id': {'$in': list(
            {dv['configurationId'] for dv in datasetViews}
        )}}
        # Counted against configurations that still exist: a view can
        # outlive its (deleted) configuration.
        configs = list(CollectionModel().find(configQuery))

        # 3. Change only what the caller administers, in both directions:
        # setting public is an ADMIN operation, and owning the dataset must
        # not let the caller publish or unpublish another user's
        # configuration or view. A configuration can also serve another
        # owner's public dataset, which unpublishing it would break.
        # setPublic must be called individually as it modifies ACLs.
        views = list(self._datasetViewModel.findWithPermissions(
            viewQuery, user=user, level=AccessType.ADMIN))
        changedConfigs = list(CollectionModel().findWithPermissions(
            configQuery, user=user, level=AccessType.ADMIN))
        for dv in views:
            self._datasetViewModel.setPublic(dv, public, save=True)
        for config in changedConfigs:
            CollectionModel().setPublic(config, public, save=True)

        # Skipped: left unchanged although not already in the requested
        # state (another user's resource that is already public was not
        # skipped, it simply needed nothing).
        def skipped(docs, changed):
            changedIds = {doc['_id'] for doc in changed}
            return sum(
                1 for doc in docs
                if doc['_id'] not in changedIds
                and bool(doc.get('public', False)) != public
            )

        # The Share dialog shows the Skipped counts (what other users' items
        # stayed as they were). The Updated counts are not displayed yet:
        # the tests use them to check that only the caller's own items
        # changed, and they let a future UI report what a publish did.
        return {
            'dataset': str(dataset['_id']),
            'public': public,
            'datasetViewsUpdated': len(views),
            'configurationsUpdated': len(changedConfigs),
            'datasetViewsSkipped': skipped(datasetViews, views),
            'configurationsSkipped': skipped(configs, changedConfigs),
        }

    @access.user(scope=TokenScope.DATA_READ)
    @autoDescribeRoute(
        Description("Get access list for a dataset and its associated configs")
        .notes("""
            Returns the current access list for a dataset, including:
            - List of users with their access levels
            - Public status of the dataset
            - Associated configurations with their public status
            - currentUserLevel: the caller's effective level on the dataset
              and on each configuration
            - writableViewIds: the dataset's views the caller can write,
              i.e. the ones a share request from them may include

            Requires READ access to the dataset folder.
        """)
        .modelParam('datasetId', 'The dataset folder ID', model=Folder,
                    level=AccessType.READ, destName='dataset',
                    paramType='path')
        .errorResponse('ID was invalid.')
        .errorResponse('Read access was denied for the dataset.', 403)
    )
    def getDatasetAccess(self, dataset):
        """Return the full access list for a dataset
        and its configurations."""
        user = self.getCurrentUser()
        result = formatAccessList(Folder(), dataset, user)
        result['datasetId'] = str(dataset['_id'])

        # Find all DatasetViews for this dataset
        datasetViews = list(
            self._datasetViewModel.find({
                'datasetId': dataset['_id']
            })
        )

        # Bulk load configurations (avoid N+1 queries)
        configIds = {
            dv['configurationId']
            for dv in datasetViews
        }
        # Only configurations the caller can read: the list names them and
        # says whether they are public.
        collectionModel = CollectionModel()
        configs = list(collectionModel.findWithPermissions(
            {'_id': {'$in': list(configIds)}},
            user=user,
            level=AccessType.READ,
        ))
        # The share endpoint needs WRITE on every view and configuration it
        # touches, so tell the client which ones the caller can include
        # (from the documents already loaded, no extra queries).
        result['configurations'] = [
            {
                'id': str(config['_id']),
                'name': config.get('name', ''),
                'public': config.get(
                    'public', False
                ),
                'currentUserLevel': collectionModel.getAccessLevel(
                    config, user),
            }
            for config in configs
        ]
        result['writableViewIds'] = [
            str(view['_id']) for view in datasetViews
            if self._datasetViewModel.hasAccess(
                view, user, AccessType.WRITE)
        ]
        return result

    @access.user(scope=TokenScope.DATA_READ)
    @autoDescribeRoute(
        Description(
            "Get access list for a configuration and its "
            "associated datasets"
        )
        .notes("""
            Returns the current access list for a configuration,
            including:
            - List of users with their access levels
            - Public status of the configuration
            - Associated datasets with their public status

            Requires READ access to the configuration.
        """)
        .modelParam(
            'configurationId',
            'The configuration ID',
            model=CollectionModel,
            level=AccessType.READ,
            destName='configuration',
            paramType='path',
        )
        .errorResponse('ID was invalid.')
        .errorResponse(
            'Read access was denied for the configuration.',
            403,
        )
    )
    def getConfigurationAccess(self, configuration):
        """Return the access list for a configuration
        and its datasets."""
        result = formatAccessList(
            CollectionModel(), configuration, self.getCurrentUser()
        )
        result['configurationId'] = str(
            configuration['_id']
        )

        # Find all DatasetViews for this configuration
        datasetViews = list(self._datasetViewModel.find({
            'configurationId': configuration['_id']
        }))

        # Get unique dataset IDs
        datasetIds = {
            dv['datasetId'] for dv in datasetViews
        }

        # Bulk load all datasets at once
        datasets = []
        if datasetIds:
            # Only datasets the caller can read: other users may have
            # opened their own private datasets with this configuration.
            folders = list(Folder().findWithPermissions(
                {'_id': {'$in': list(datasetIds)}},
                user=self.getCurrentUser(),
                level=AccessType.READ,
            ))
            datasets = [
                {
                    'id': str(f['_id']),
                    'name': f.get('name', ''),
                    'public': f.get(
                        'public', False
                    ),
                }
                for f in folders
            ]
        result['datasets'] = datasets
        return result

    @access.public(scope=TokenScope.DATA_READ)
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

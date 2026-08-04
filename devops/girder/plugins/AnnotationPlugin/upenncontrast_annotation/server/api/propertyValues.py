from bson import ObjectId

from girder.api import access
from girder.api.describe import Description, describeRoute
from girder.api.rest import Resource
from girder.constants import AccessType, TokenScope
from girder.exceptions import RestException
from girder.models.folder import Folder
from girder_jobs.models.job import Job as JobModel

from ..helpers import valueStoreState
from ..helpers import zarrValueStore
from ..helpers.access_helpers import requireDatasetsAccess
from ..helpers.validation import (
    requireList,
    requireObjectBody,
    requireObjectId,
    validateAnnotationIdCount,
    validatePropertyPaths,
)
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
        self.route("POST", ("batch",), self.batch)
        self.route("GET", (), self.find)
        self.route("GET", ("count",), self.count)
        self.route("GET", ("histogram",), self.histogram)
        self.route("GET", ("columnar",), self.columnarStatus)
        self.route("POST", ("columnar", "build"), self.columnarBuild)
        self.route("DELETE", ("columnar",), self.columnarDelete)

    # TODO: anytime a dataset is mentioned, load the dataset and check for
    #   existence and that the user has access to it
    # TODO: creation date, update date, creatorId ?
    # TODO(performance): proper indexing
    # TODO(performance): use objectId whenever possible

    @access.user(scope=TokenScope.DATA_WRITE)
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
        dataset = Folder().load(
            params["datasetId"],
            user=self.getCurrentUser(),
            level=AccessType.WRITE,
            exc=True,
        )
        result = self._annotationPropertyValuesModel.appendValues(
            self.getBodyJson(),
            params["annotationId"],
            params["datasetId"],
        )
        # Values changed: any columnar store for this dataset is now stale, so
        # reads must fall back to MongoDB until it is rebuilt. No-op for a
        # dataset without a store.
        valueStoreState.mark_dirty(dataset)
        return result

    @access.user(scope=TokenScope.DATA_WRITE)
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
        datasetIds = {
            entry["datasetId"]
            for entry in propertyValuesList
            if "datasetId" in entry
        }
        requireDatasetsAccess(datasetIds, self.getCurrentUser())
        result = self._annotationPropertyValuesModel.appendMultipleValues(
            propertyValuesList
        )
        # See add(): values changed, so any columnar store is stale. Batched
        # into one query over the affected datasets.
        valueStoreState.mark_datasets_dirty(datasetIds)
        return result

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
    @access.user(scope=TokenScope.DATA_WRITE)
    def delete(self, params):
        if "propertyId" not in params:
            raise RestException(
                code=400, message="Property ID was invalid"
            )
        if "datasetId" not in params:
            raise RestException(
                code=400, message="Dataset ID was invalid"
            )
        params = self._annotationPropertyValuesModel.convertIdsToObjectIds(
            params)
        dataset = Folder().load(
            params["datasetId"],
            user=self.getCurrentUser(),
            level=AccessType.WRITE,
            exc=True,
        )
        self._annotationPropertyValuesModel.delete(
            params["propertyId"], params["datasetId"]
        )
        # See add(): a removed property's values make any columnar store stale.
        valueStoreState.mark_dirty(dataset)

    @access.public(scope=TokenScope.DATA_READ)
    @describeRoute(
        Description("Get property values for a set of annotation ids")
        .notes(
            "POST to send the id list (avoids URL length limits). "
            "Optionally projects only the requested property paths."
        )
        .param(
            "body",
            (
                "{ datasetId: string, annotationIds: string[], "
                "propertyPaths?: string[][] }"
            ),
            paramType="body",
        )
        .errorResponse()
        .errorResponse("Read access was denied for the dataset.", 403)
    )
    def batch(self, params):
        body = requireObjectBody(self.getBodyJson())
        datasetId = requireObjectId(body.get("datasetId"), "datasetId")
        propertyPaths = body.get("propertyPaths")
        if propertyPaths is not None:
            # A component containing '.'/'$' would silently build a wrong or
            # injected projection key; a non-list-of-lists-of-strings would
            # raise TypeError in findByAnnotationIds. Reject at the boundary.
            validatePropertyPaths(propertyPaths)
        # Guard the list shape before len()/iterating: a scalar would raise
        # TypeError on len(), a string would iterate per-character. Both must
        # be a clean 400 on this public endpoint, not a 500.
        rawIds = requireList(body.get("annotationIds", []), "annotationIds")
        validateAnnotationIdCount(len(rawIds))
        dataset = Folder().load(
            datasetId,
            user=self.getCurrentUser(),
            level=AccessType.READ,
            exc=True,
        )
        # Validate before dispatching, so a malformed id is a 400 on both
        # backends rather than only on the Mongo one.
        annotationIds = [requireObjectId(i, "annotationId") for i in rawIds]
        # Columnar store, when this dataset has a current one. Same response
        # shape either way (annotationId + projected values), so this is a pure
        # backend swap. The Zarr obs index holds string ids.
        if valueStoreState.should_serve_from_zarr(dataset):
            return zarrValueStore.read_batch(
                datasetId, [str(i) for i in annotationIds], propertyPaths
            )
        return self._annotationPropertyValuesModel.findByAnnotationIds(
            datasetId, annotationIds, propertyPaths
        )

    @access.public(scope=TokenScope.DATA_READ)
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

    @access.public(scope=TokenScope.DATA_READ)
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

    @access.user(scope=TokenScope.DATA_READ)
    @describeRoute(
        Description("Columnar (Zarr) property-value store state for a dataset")
        .notes(
            "Returns {backend, status, generation, rows, columns} when the "
            "dataset has a columnar store, else {backend: 'mongo'}. "
            "`available` reports whether the server has the numeric extras "
            "installed at all."
        )
        .param("datasetId", "The dataset's id")
        .errorResponse()
        .errorResponse("Read access was denied for the dataset.", 403)
    )
    def columnarStatus(self, params):
        datasetId = requireObjectId(params.get("datasetId"), "datasetId")
        dataset = Folder().load(
            datasetId, user=self.getCurrentUser(), level=AccessType.READ,
            exc=True,
        )
        state = valueStoreState.get_state(dataset)
        return {
            "available": zarrValueStore.backend_available(),
            "storeExists": zarrValueStore.store_exists(datasetId),
            "servingFromZarr": valueStoreState.should_serve_from_zarr(dataset),
            "state": state or {"backend": "mongo"},
        }

    @access.user(scope=TokenScope.DATA_WRITE)
    @describeRoute(
        Description("Build (or rebuild) the columnar property-value store")
        .notes(
            "Schedules a background job. Reads keep using MongoDB until the "
            "build completes, so this is safe to call on a live dataset. "
            "Requires write access, since it writes a derived artifact for "
            "the dataset."
        )
        .param("datasetId", "The dataset's id")
        .errorResponse()
        .errorResponse("Write access was denied for the dataset.", 403)
    )
    def columnarBuild(self, params):
        datasetId = requireObjectId(params.get("datasetId"), "datasetId")
        user = self.getCurrentUser()
        dataset = Folder().load(
            datasetId, user=user, level=AccessType.WRITE, exc=True,
        )
        if not zarrValueStore.backend_available():
            raise RestException(
                code=501,
                message=(
                    "This server does not have the columnar-store extras "
                    "installed (numpy, scipy, zarr, anndata). Rebuild the "
                    "girder image with the plugin's 'columnar' extra."
                ),
            )
        job = JobModel().createLocalJob(
            module=(
                "upenncontrast_annotation.server.helpers.zarr_value_job"
            ),
            title="Build columnar property store: %s" % dataset["name"],
            type="nimbus_columnar_build",
            user=user,
            kwargs={
                "datasetId": str(datasetId),
                "userId": str(user["_id"]),
            },
            asynchronous=True,
        )
        JobModel().scheduleJob(job)
        return {"jobId": str(job["_id"])}

    @access.user(scope=TokenScope.DATA_WRITE)
    @describeRoute(
        Description("Delete a dataset's columnar property-value store")
        .notes(
            "Removes the Zarr data and the dataset's store state, so reads "
            "return to MongoDB. The property values themselves (in MongoDB) "
            "are untouched."
        )
        .param("datasetId", "The dataset's id")
        .errorResponse()
        .errorResponse("Write access was denied for the dataset.", 403)
    )
    def columnarDelete(self, params):
        datasetId = requireObjectId(params.get("datasetId"), "datasetId")
        dataset = Folder().load(
            datasetId, user=self.getCurrentUser(), level=AccessType.WRITE,
            exc=True,
        )
        # Clear the state first: if the data removal fails partway, the dataset
        # is already back on MongoDB rather than pointing at a half-deleted
        # store.
        valueStoreState.clear_state(dataset)
        zarrValueStore.delete_store(datasetId)
        return {"deleted": True}

    @access.public(scope=TokenScope.DATA_READ)
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
        dataset = Folder().load(
            params["datasetId"],
            user=self.getCurrentUser(),
            level=AccessType.READ,
            exc=True,
        )
        buckets = int(params["buckets"]) if "buckets" in params else None
        # Columnar store, when current: a per-column read instead of a
        # collection-wide $bucketAuto. Same {min, max, count} bucket shape.
        if valueStoreState.should_serve_from_zarr(dataset):
            # The Mongo endpoint takes a dotted path; the Zarr reader takes
            # path segments.
            propertyPath = params["propertyPath"].split(".")
            if buckets is None:
                return zarrValueStore.histogram(
                    params["datasetId"], propertyPath
                )
            return zarrValueStore.histogram(
                params["datasetId"], propertyPath, buckets
            )
        if buckets is not None:
            return self._annotationPropertyValuesModel.histogram(
                params["propertyPath"],
                params["datasetId"],
                buckets,
            )
        return self._annotationPropertyValuesModel.histogram(
            params["propertyPath"], params["datasetId"]
        )

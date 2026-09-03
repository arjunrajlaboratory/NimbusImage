import zipfile

import numpy as np
import orjson
from bson.objectid import ObjectId
from girder.api import access
from girder.api.describe import Description, describeRoute
from girder.api.rest import Resource, setRawResponse, setResponseHeader
from girder.constants import AccessType, TokenScope
from girder.exceptions import RestException
from girder.models.file import File
from girder.models.folder import Folder
from girder.models.item import Item
from girder_jobs.models.job import Job

from upenncontrast_annotation.server.helpers.validation import (
    dropNoOpPropertyFilters,
    requireCountWithin,
    requireInt,
    requireList,
    requireObjectBody,
    requireObjectId,
    validateListInputs,
)
from upenncontrast_annotation.server.models.annotation import (
    Annotation as AnnotationModel,
)
from upenncontrast_annotation.server.models.collection import (
    Collection as CollectionModel,
)
from upenncontrast_annotation.server.models.datasetView import (
    DatasetView as DatasetViewModel,
)
from upenncontrast_annotation.server.models.property import (
    AnnotationProperty as PropertyModel,
)

from .. import materialize
from ..models.registry import DatasetSpatial
from ..store import (
    invalidateStore,
    liveAnnotationCount,
    openStore,
    registryEntry,
)

# Features per aggregate/materialize request. Matches the plan's guidance of
# roughly 64 sub-values per materialized property; an aggregate over more is
# a sign the caller wants the whole matrix, which is not what these are for.
MAX_FEATURES_PER_REQUEST = 64
MAX_FEATURE_SEARCH_RESULTS = 200
DEFAULT_FEATURE_SEARCH_RESULTS = 25
# Property definition for values this plugin writes: no worker, polygon
# cells — the same sentinel the Python client uses for client-computed values.
MATERIALIZED_PROPERTY_IMAGE = "properties/none:latest"
DEFAULT_PROPERTY_NAME = "Gene Expression"


def _serialize(document):
    return {
        key: str(value) if isinstance(value, ObjectId) else value
        for key, value in document.items()
    }


class Spatial(Resource):
    def __init__(self):
        super().__init__()
        self.resourceName = "spatial"
        self._registry = DatasetSpatial()
        self._annotationModel = AnnotationModel()

        self.route("GET", (":datasetId",), self.get)
        self.route("POST", (":datasetId", "register"), self.register)
        self.route("DELETE", (":datasetId",), self.unregister)
        self.route("GET", (":datasetId", "features"), self.features)
        self.route("GET", (":datasetId", "column"), self.column)
        self.route("GET", (":datasetId", "row"), self.row)
        self.route("POST", (":datasetId", "aggregate"), self.aggregate)
        self.route("POST", (":datasetId", "materialize"), self.materialize)

    # ---- helpers --------------------------------------------------------

    def _loadDataset(self, datasetId, level):
        datasetId = requireObjectId(datasetId, "datasetId")
        Folder().load(
            datasetId, user=self.getCurrentUser(), level=level, exc=True,
        )
        return datasetId

    def _registered(self, datasetId):
        entry = self._registry.forDataset(datasetId)
        if entry is None:
            raise RestException(
                "No spatial table is registered for this dataset.", code=404
            )
        return entry

    def _openStore(self, datasetId):
        entry = self._registered(datasetId)
        # The file inherits the dataset folder's ACL, which _loadDataset has
        # already checked; loading with the user keeps that chain explicit.
        fileDoc = File().load(
            entry["fileId"], user=self.getCurrentUser(),
            level=AccessType.READ, exc=True,
        )
        return entry, openStore(fileDoc)

    def _requireSymbols(self, store, value, field="features"):
        symbols = requireList(value, field)
        requireCountWithin(len(symbols), MAX_FEATURES_PER_REQUEST, field)
        if not symbols:
            raise RestException("%s must not be empty" % field, code=400)
        for symbol in symbols:
            if not isinstance(symbol, str):
                raise RestException(
                    "%s must be a list of feature symbols" % field, code=400
                )
            try:
                store.featureColumn(symbol)
            except ValueError as exc:
                raise RestException(str(exc), code=400)
        return symbols

    def _rowsForFilters(self, datasetId, store, filters):
        """Row indices matching a list-filter object (None = every row), plus
        how many matching annotations have no row in the store."""
        validateListInputs(filters)
        dropNoOpPropertyFilters(filters)
        try:
            self._annotationModel.resolveListGateConstraints(
                datasetId, filters
            )
        except ValueError as exc:
            raise RestException(str(exc), code=400)
        if not self._annotationModel.narrowsPopulation(filters):
            return None, 0
        rows = store.rowsForAnnotationIds(
            self._annotationModel.listIds(datasetId, filters)
        )
        return rows[rows >= 0], int((rows < 0).sum())

    # ---- registry -------------------------------------------------------

    @access.public(scope=TokenScope.DATA_READ)
    @describeRoute(
        Description("The dataset's registered spatial table and its schema")
        .param("datasetId", "The dataset (folder) id", paramType="path")
        .param("verify", "Also count the rows that still join to a live "
               "annotation (`liveAnnotations`). Scans the dataset's "
               "annotation ids, ~1.5 s at 700K cells, so it is opt-in.",
               required=False, dataType="boolean", default=False)
        .errorResponse("No spatial table is registered.", 404)
        .errorResponse("Read access denied.", 403)
    )
    def get(self, datasetId, params):
        datasetId = self._loadDataset(datasetId, AccessType.READ)
        entry, store = self._openStore(datasetId)
        result = _serialize(entry)
        result["features"] = store.nVar
        if self.boolParam("verify", params, default=False):
            result["liveAnnotations"] = liveAnnotationCount(
                self._annotationModel, datasetId, store
            )
        return result

    @access.user(scope=TokenScope.DATA_WRITE)
    @describeRoute(
        Description("Register an item in the dataset folder as its spatial "
                    "table")
        .notes("The item must hold exactly one file: a zipped zarr store in "
               "AnnData layout with obs.annotation_id. Replaces any earlier "
               "registration for the dataset.")
        .param("datasetId", "The dataset (folder) id", paramType="path")
        .param("body", "JSON: {itemId}", paramType="body")
        .errorResponse()
        .errorResponse("Write access denied.", 403)
    )
    def register(self, datasetId, params):
        datasetId = self._loadDataset(datasetId, AccessType.WRITE)
        body = requireObjectBody(self.getBodyJson())
        item = Item().load(
            requireObjectId(body.get("itemId"), "itemId"),
            user=self.getCurrentUser(), level=AccessType.READ, exc=True,
        )
        if item["folderId"] != datasetId:
            raise RestException(
                "The item must live in the dataset folder.", code=400
            )
        files = list(Item().childFiles(item))
        if len(files) != 1:
            raise RestException(
                "The item must hold exactly one file (the zipped store)."
            )
        invalidateStore(files[0]["_id"])
        try:
            store = openStore(files[0])
        except (ValueError, KeyError, OSError, zipfile.BadZipFile) as exc:
            raise RestException(
                "Not a readable spatial store: %s" % exc, code=400
            )
        return _serialize(self._registry.register(
            registryEntry(datasetId, item, files[0], store)
        ))

    @access.user(scope=TokenScope.DATA_WRITE)
    @describeRoute(
        Description("Forget the dataset's spatial table (the item stays)")
        .param("datasetId", "The dataset (folder) id", paramType="path")
        .errorResponse("Write access denied.", 403)
    )
    def unregister(self, datasetId, params):
        datasetId = self._loadDataset(datasetId, AccessType.WRITE)
        entry = self._registry.unregister(datasetId)
        if entry is not None:
            invalidateStore(entry["fileId"])

    # ---- reads ----------------------------------------------------------

    @access.public(scope=TokenScope.DATA_READ)
    @describeRoute(
        Description("Search the table's features by symbol")
        .param("datasetId", "The dataset (folder) id", paramType="path")
        .param("search", "Case-insensitive symbol query (prefix matches "
               "first); empty lists the first features", required=False)
        .param("limit", "Maximum results (default %d, at most %d)"
               % (DEFAULT_FEATURE_SEARCH_RESULTS, MAX_FEATURE_SEARCH_RESULTS),
               required=False, dataType="int")
        .errorResponse()
    )
    def features(self, datasetId, params):
        datasetId = self._loadDataset(datasetId, AccessType.READ)
        _, store = self._openStore(datasetId)
        limit = min(
            MAX_FEATURE_SEARCH_RESULTS,
            max(1, requireInt(
                params.get("limit", DEFAULT_FEATURE_SEARCH_RESULTS), "limit"
            )),
        )
        return store.searchFeatures(params.get("search", ""), limit)

    @access.public(scope=TokenScope.DATA_READ)
    @describeRoute(
        Description("One feature across all cells: its non-zero values")
        .param("datasetId", "The dataset (folder) id", paramType="path")
        .param("feature", "Feature symbol", required=True)
        .errorResponse()
    )
    def column(self, datasetId, params):
        datasetId = self._loadDataset(datasetId, AccessType.READ)
        _, store = self._openStore(datasetId)
        symbol = self._requireSymbols(
            store, [params.get("feature")], "feature"
        )[0]
        rows, values = store.column(symbol)
        # A dense gene at 700K cells is hundreds of thousands of pairs, so
        # the numeric array goes to orjson as-is (integral counts as ints,
        # matching `row`) and the body goes out as bytes. Ids are strings,
        # which orjson's numpy path does not take, so they become a list.
        if np.all(values == np.floor(values)):
            values = values.astype(np.int64)
        setRawResponse()
        setResponseHeader("Content-Type", "application/json")
        return orjson.dumps(
            {
                "symbol": symbol,
                "annotationIds": store.annotationIds[rows].tolist(),
                "values": values,
            },
            option=orjson.OPT_SERIALIZE_NUMPY,
        )

    @access.public(scope=TokenScope.DATA_READ)
    @describeRoute(
        Description("One cell across all features: its non-zero values")
        .param("datasetId", "The dataset (folder) id", paramType="path")
        .param("annotationId", "The cell's annotation id", required=True)
        .errorResponse()
        .errorResponse("The annotation has no row in the table.", 404)
    )
    def row(self, datasetId, params):
        datasetId = self._loadDataset(datasetId, AccessType.READ)
        _, store = self._openStore(datasetId)
        annotationId = requireObjectId(
            params.get("annotationId"), "annotationId"
        )
        rowIndex = int(store.rowsForAnnotationIds([str(annotationId)])[0])
        if rowIndex < 0:
            raise RestException(
                "The annotation has no row in the spatial table.", code=404
            )
        try:
            values = store.row(rowIndex)
        except ValueError as exc:
            raise RestException(str(exc), code=400)
        return {"annotationId": str(annotationId), "values": values}

    @access.public(scope=TokenScope.DATA_READ)
    @describeRoute(
        Description("Mean and fraction expressing per feature over the "
                    "annotations matching a list-filter object")
        .notes("`filters` is the object the list, list/ids and summary "
               "endpoints accept, analysis gate definitions included, so a "
               "gate resolves identically here and there. Means include "
               "zeros. `unmatched` counts matching annotations without a "
               "row in the table.")
        .param("datasetId", "The dataset (folder) id", paramType="path")
        .param("body", "JSON: {filters, features}", paramType="body")
        .errorResponse()
    )
    def aggregate(self, datasetId, params):
        datasetId = self._loadDataset(datasetId, AccessType.READ)
        _, store = self._openStore(datasetId)
        body = requireObjectBody(self.getBodyJson())
        symbols = self._requireSymbols(store, body.get("features"))
        filters = body.get("filters") or {}
        rows, unmatched = self._rowsForFilters(datasetId, store, filters)
        result = store.aggregate(symbols, rows)
        result["unmatched"] = unmatched
        return result

    # ---- materialize ----------------------------------------------------

    @access.user(scope=TokenScope.DATA_WRITE)
    @describeRoute(
        Description("Write a feature panel as dense sub-values of an "
                    "annotation property")
        .notes("Finds or creates a polygon property named `propertyName` "
               "(default '%s') registered into the dataset's "
               "configurations, then writes values[property][symbol] for "
               "every cell in the table. Runs inline below %d cells, as a "
               "job above (returns jobId)."
               % (DEFAULT_PROPERTY_NAME,
                  materialize.MATERIALIZE_INLINE_MAX_ROWS))
        .param("datasetId", "The dataset (folder) id", paramType="path")
        .param("body", "JSON: {features, propertyName?}", paramType="body")
        .errorResponse()
        .errorResponse("Write access denied.", 403)
    )
    def materialize(self, datasetId, params):
        datasetId = self._loadDataset(datasetId, AccessType.WRITE)
        entry, store = self._openStore(datasetId)
        body = requireObjectBody(self.getBodyJson())
        symbols = self._requireSymbols(store, body.get("features"))
        propertyName = body.get("propertyName") or DEFAULT_PROPERTY_NAME
        if not isinstance(propertyName, str):
            raise RestException("propertyName must be a string", code=400)
        user = self.getCurrentUser()
        try:
            prop = self._materializedProperty(datasetId, user, propertyName)
        except ValueError as exc:
            raise RestException(str(exc), code=400)

        if store.nObs <= materialize.MATERIALIZE_INLINE_MAX_ROWS:
            written = materialize.writeValues(
                store, datasetId, prop["_id"], symbols
            )
            return {
                "propertyId": str(prop["_id"]), "written": written,
                "jobId": None,
            }
        job = Job().createLocalJob(
            module="upenncontrast_spatial.server.materialize",
            title=(
                "Materialize %d features into %s"
                % (len(symbols), propertyName)
            ),
            type="spatial_materialize",
            user=user,
            kwargs={
                "datasetId": str(datasetId),
                "fileId": str(entry["fileId"]),
                "propertyId": str(prop["_id"]),
                "symbols": symbols,
            },
            asynchronous=True,
        )
        Job().scheduleJob(job)
        return {
            "propertyId": str(prop["_id"]), "written": 0,
            "jobId": str(job["_id"]),
        }

    def _materializedProperty(self, datasetId, user, propertyName):
        """The polygon property named `propertyName` among the dataset's
        configurations, created and registered into all of them if absent.
        Registration is what makes a property visible (the configuration's
        meta.propertyIds), mirroring the Python client's register()."""
        configurationIds = {
            view["configurationId"]
            for view in DatasetViewModel().find({"datasetId": datasetId})
        }
        if not configurationIds:
            raise ValueError(
                "the dataset has no configuration to register the property "
                "into; open it once in NimbusImage first"
            )
        collections = list(CollectionModel().findWithPermissions(
            {"_id": {"$in": list(configurationIds)}},
            user=user, level=AccessType.WRITE,
        ))
        if len(collections) != len(configurationIds):
            raise ValueError(
                "write access to every configuration of the dataset is "
                "required to register the property"
            )
        knownIds = {
            pid
            for collection in collections
            for pid in collection.get("meta", {}).get("propertyIds", [])
        }
        prop = PropertyModel().findOne({
            "_id": {"$in": [ObjectId(pid) for pid in knownIds]},
            "name": propertyName,
            "shape": "polygon",
        }) if knownIds else None
        if prop is None:
            prop = PropertyModel().create(user, {
                "name": propertyName,
                "image": MATERIALIZED_PROPERTY_IMAGE,
                "tags": {"tags": [], "exclusive": False},
                "shape": "polygon",
                "workerInterface": {},
            })
        propertyId = str(prop["_id"])
        for collection in collections:
            propertyIds = list(collection.get("meta", {}).get(
                "propertyIds", []
            ))
            if propertyId not in propertyIds:
                CollectionModel().setMetadata(
                    collection, {"propertyIds": propertyIds + [propertyId]}
                )
        return prop

"""Neighborhood and region statistics routes (plan §15), mixed into the
Spatial resource."""

from girder.api import access
from girder.api.describe import Description, describeRoute
from girder.constants import AccessType, TokenScope
from girder.exceptions import RestException
from girder_jobs.models.job import Job

from upenncontrast_annotation.server.helpers.validation import (
    requireCountWithin,
    requireFloat,
    requireList,
    requireObjectBody,
    requireObjectId,
)

# Aliased: the class below has a route method named `neighborhood`, which
# would shadow the module inside the class body.
from .. import neighborhood as analysis

MAX_EXCLUDED_TAGS = 32
MAX_RADIUS_PIXELS = 100_000


def _requireTagList(value, name, limit):
    tags = requireList(value, name)
    requireCountWithin(len(tags), limit, name)
    if not all(isinstance(tag, str) and tag for tag in tags):
        raise RestException("%s must be non-empty strings" % name, code=400)
    return tags


class AnalysisRoutes:
    def _addAnalysisRoutes(self):
        self.route("GET", (":datasetId", "neighborhood"), self.neighborhood)
        self.route(
            "POST", (":datasetId", "neighborhood"), self.computeNeighborhood
        )
        self.route(
            "POST", (":datasetId", "regions", "summary"), self.regionSummary
        )

    @access.public(scope=TokenScope.DATA_READ)
    @describeRoute(
        Description("The dataset's last neighborhood enrichment")
        .notes("{radius, excludeTags, types, counts, pairs, matrix "
               "(log2 observed/expected), cells, typed, propertyId, "
               "computed}; 404 until computed.")
        .param("datasetId", "The dataset (folder) id", paramType="path")
        .errorResponse("Not computed yet.", 404)
    )
    def neighborhood(self, datasetId, params):
        datasetId = self._loadDataset(datasetId, AccessType.READ)
        entry = self._registry.forDataset(datasetId)
        if entry is None or "neighborhood" not in entry:
            raise RestException(
                "No neighborhood has been computed for this dataset.",
                code=404,
            )
        return entry["neighborhood"]

    @access.user(scope=TokenScope.DATA_WRITE)
    @describeRoute(
        Description("Compute every cell's neighborhood composition and the "
                    "type enrichment matrix, as a job")
        .notes("Body: {radius (image pixels, > 0), excludeTags? (default "
               "['cell']: tags that are not cell types), propertyName? "
               "(default 'Neighborhood')}. Writes per-cell fractions of "
               "each neighbor type and the neighbor count as sub-values "
               "of the property; the enrichment matrix is stored and served "
               "by GET. The job's `spatialResult` carries the same summary.")
        .param("datasetId", "The dataset (folder) id", paramType="path")
        .param("body", "JSON, see notes", paramType="body")
        .errorResponse()
        .errorResponse("Write access denied.", 403)
    )
    def computeNeighborhood(self, datasetId, params):
        datasetId = self._loadDataset(datasetId, AccessType.WRITE)
        body = requireObjectBody(self.getBodyJson())
        radius = requireFloat(body.get("radius"), "radius")
        if not 0 < radius <= MAX_RADIUS_PIXELS:
            raise RestException(
                "radius must be between 0 and %d pixels" % MAX_RADIUS_PIXELS,
                code=400,
            )
        excludeTags = _requireTagList(
            body.get("excludeTags", list(analysis.DEFAULT_EXCLUDED_TAGS)),
            "excludeTags", MAX_EXCLUDED_TAGS,
        )
        propertyName = self._requirePropertyName(
            body.get("propertyName"), analysis.DEFAULT_PROPERTY_NAME
        )
        user = self.getCurrentUser()
        try:
            prop = self._materializedProperty(datasetId, user, propertyName)
        except ValueError as exc:
            raise RestException(str(exc), code=400)
        job = Job().createLocalJob(
            module="upenncontrast_spatial.server.neighborhood",
            title="Neighborhood composition (%g px)" % radius,
            type="spatial_neighborhood",
            user=user,
            kwargs={
                "datasetId": str(datasetId),
                "radius": radius,
                "excludeTags": excludeTags,
                "propertyId": str(prop["_id"]),
            },
            asynchronous=True,
        )
        Job().scheduleJob(job)
        return {"jobId": str(job["_id"]), "propertyId": str(prop["_id"])}

    @access.public(scope=TokenScope.DATA_READ)
    @describeRoute(
        Description("Composition and expression of the cells inside region "
                    "polygons")
        .notes("Body: {regionTag? | regionIds? (at most %d), excludeTags?, "
               "features? (at most 64; needs a registered table)}. A region "
               "is a polygon annotation; its cells are the polygon centroids "
               "inside it. Returns [{id, name, tags, cells, composition: "
               "[{type, count}], expression: [{symbol, mean, "
               "fractionExpressing, expressing}], rows}]."
               % analysis.MAX_REGIONS)
        .param("datasetId", "The dataset (folder) id", paramType="path")
        .param("body", "JSON, see notes", paramType="body")
        .errorResponse()
    )
    def regionSummary(self, datasetId, params):
        datasetId = self._loadDataset(datasetId, AccessType.READ)
        body = requireObjectBody(self.getBodyJson())
        regionIds = body.get("regionIds")
        regionTag = body.get("regionTag")
        if regionIds is not None:
            regionIds = requireList(regionIds, "regionIds")
            requireCountWithin(
                len(regionIds), analysis.MAX_REGIONS, "regionIds"
            )
            if not regionIds:
                raise RestException("regionIds must not be empty", code=400)
            regionIds = [requireObjectId(i, "regionIds") for i in regionIds]
        elif not isinstance(regionTag, str) or not regionTag:
            raise RestException(
                "regionTag (a tag) or regionIds is required", code=400
            )
        excludeTags = _requireTagList(
            body.get("excludeTags", list(analysis.DEFAULT_EXCLUDED_TAGS)),
            "excludeTags", MAX_EXCLUDED_TAGS,
        )
        regions = analysis.regionPolygons(datasetId, regionTag, regionIds)
        if len(regions) > analysis.MAX_REGIONS:
            raise RestException(
                "at most %d regions per request" % analysis.MAX_REGIONS,
                code=400,
            )
        store, symbols = None, []
        features = body.get("features")
        if features:
            entry = self._registry.forDataset(datasetId)
            if entry is None or "fileId" not in entry:
                raise RestException(
                    "features need a registered spatial table", code=400
                )
            _, store = self._openStore(datasetId)
            symbols = self._requireSymbols(store, features)
        if regionTag is not None and regionTag not in excludeTags:
            excludeTags = excludeTags + [regionTag]
        return analysis.regionSummary(
            datasetId, regions, excludeTags, store, symbols
        )

"""Table versions, staleness and recompute routes (plan §13), mixed into the
Spatial resource like the transcript routes."""

from bson.objectid import ObjectId
from girder.api import access
from girder.api.describe import Description, describeRoute
from girder.constants import AccessType, TokenScope
from girder.exceptions import RestException
from girder.models.file import File
from girder_jobs.models.job import Job

from upenncontrast_annotation.server.helpers.validation import (
    requireFloat,
    requireList,
    requireObjectBody,
    requireObjectId,
)

from .. import recompute
from ..store import invalidateStore, openStore

MAX_LABEL_LENGTH = 80
MAX_TAGS = 16


def _serializeVersion(version):
    return {
        key: str(value) if isinstance(value, ObjectId) else value
        for key, value in version.items()
    }


class VersionRoutes:
    def _addVersionRoutes(self):
        self.route("GET", (":datasetId", "versions"), self.versions)
        self.route(
            "POST", (":datasetId", "versions", ":itemId", "activate"),
            self.activateVersion,
        )
        self.route(
            "DELETE", (":datasetId", "versions", ":itemId"),
            self.forgetVersion,
        )
        self.route("GET", (":datasetId", "staleness"), self.staleness)
        self.route("POST", (":datasetId", "recompute"), self.recompute)

    # ---- versions -----------------------------------------------------------

    @access.public(scope=TokenScope.DATA_READ)
    @describeRoute(
        Description("The dataset's expression-table versions")
        .notes("`active` is the table every read uses; `versions` are the "
               "others, oldest first. Each carries itemId, label, "
               "provenance, nObs, nVar and created.")
        .param("datasetId", "The dataset (folder) id", paramType="path")
        .errorResponse("No table is registered.", 404)
    )
    def versions(self, datasetId, params):
        datasetId = self._loadDataset(datasetId, AccessType.READ)
        entry = self._registered(datasetId)
        return {
            "active": _serializeVersion(self._registry._versionOf(entry)),
            "versions": [
                _serializeVersion(v) for v in entry.get("versions", [])
            ],
        }

    @access.user(scope=TokenScope.DATA_WRITE)
    @describeRoute(
        Description("Make a version the active table")
        .param("datasetId", "The dataset (folder) id", paramType="path")
        .param("itemId", "The version's item id", paramType="path")
        .errorResponse("Unknown version.", 404)
        .errorResponse("Write access denied.", 403)
    )
    def activateVersion(self, datasetId, itemId, params):
        datasetId = self._loadDataset(datasetId, AccessType.WRITE)
        itemId = requireObjectId(itemId, "itemId")
        document = self._registry.activateVersion(datasetId, itemId)
        if document is None:
            raise RestException("Unknown table version.", code=404)
        return self.versions(str(datasetId), params)

    @access.user(scope=TokenScope.DATA_WRITE)
    @describeRoute(
        Description("Forget a non-active table version (the item stays)")
        .param("datasetId", "The dataset (folder) id", paramType="path")
        .param("itemId", "The version's item id", paramType="path")
        .errorResponse("Unknown version.", 404)
        .errorResponse("Write access denied.", 403)
    )
    def forgetVersion(self, datasetId, itemId, params):
        datasetId = self._loadDataset(datasetId, AccessType.WRITE)
        itemId = requireObjectId(itemId, "itemId")
        version = self._registry.forgetVersion(datasetId, itemId)
        if version is None:
            raise RestException(
                "Unknown table version (the active table cannot be "
                "forgotten this way).", code=404,
            )
        invalidateStore(version["fileId"])
        return self.versions(str(datasetId), params)

    # ---- staleness and recompute -------------------------------------------

    @access.public(scope=TokenScope.DATA_READ)
    @describeRoute(
        Description("How the live cell polygons differ from the active table")
        .notes("Counts (and up to %d ids each) of cells without a row "
               "(added), cells whose polygon changed since the table was "
               "built (changed; needs a table with geometry hashes, i.e. "
               "one this plugin recomputed) and rows whose cell is gone "
               "(removed). Cached until the next annotation edit."
               % recompute.MAX_STALENESS_IDS)
        .param("datasetId", "The dataset (folder) id", paramType="path")
        .errorResponse("No table is registered.", 404)
    )
    def staleness(self, datasetId, params):
        datasetId = self._loadDataset(datasetId, AccessType.READ)
        entry, store = self._openStore(datasetId)
        return recompute.summarizeStaleness(
            recompute.staleness(datasetId, store, entry["fileId"])
        )

    @access.user(scope=TokenScope.DATA_WRITE)
    @describeRoute(
        Description("Rebuild the expression table from the current cell "
                    "polygons and the transcript store, as a job")
        .notes("Body: {label?, scope: 'all' | 'dirty', minQv? (default 20), "
               "tags? (only cells carrying all of them), "
               "recomputeEmbeddings? (PCA/UMAP/k-means, minutes)}. 'dirty' "
               "reassigns only the tiles touched by added/changed/removed "
               "cells and carries the other rows over from the active "
               "table. The new table becomes active; the previous one a "
               "version. The job's `spatialResult` carries {itemId, nObs, "
               "nVar, assigned, unassigned, tilesProcessed, seconds}.")
        .param("datasetId", "The dataset (folder) id", paramType="path")
        .param("body", "JSON, see notes", paramType="body")
        .errorResponse()
        .errorResponse("No transcript store is registered.", 404)
        .errorResponse("Write access denied.", 403)
    )
    def recompute(self, datasetId, params):
        datasetId = self._loadDataset(datasetId, AccessType.WRITE)
        body = requireObjectBody(self.getBodyJson())
        transcriptsEntry, transcripts = self._openTranscripts(datasetId)
        if transcripts.transform is not None:
            raise RestException(
                "Recompute needs the transcripts on this image's pixel "
                "grid (no transform).", code=400,
            )
        scope = body.get("scope", "all")
        if scope not in recompute.SCOPES:
            raise RestException(
                "scope must be one of %s" % (recompute.SCOPES,), code=400
            )
        label = body.get("label", recompute.DEFAULT_LABEL)
        if not isinstance(label, str) or not 0 < len(label.strip()) <= (
            MAX_LABEL_LENGTH
        ):
            raise RestException(
                "label must be 1-%d characters" % MAX_LABEL_LENGTH, code=400
            )
        minQv = requireFloat(body.get("minQv", 20), "minQv")
        if minQv < 0:
            raise RestException("minQv must not be negative", code=400)
        tags = body.get("tags")
        if tags is not None:
            tags = requireList(tags, "tags")
            if len(tags) > MAX_TAGS or not all(
                isinstance(t, str) for t in tags
            ):
                raise RestException(
                    "tags must be at most %d strings" % MAX_TAGS, code=400
                )
        withEmbeddings = bool(body.get("recomputeEmbeddings", False))
        activeFileId = transcriptsEntry.get("fileId")
        if scope == "dirty" and activeFileId is None:
            raise RestException(
                "dirty scope needs an active table; run scope 'all' first.",
                code=400,
            )
        if activeFileId is not None:
            # Fail now, not in the job, if the active table is unreadable.
            openStore(File().load(
                activeFileId, user=self.getCurrentUser(),
                level=AccessType.READ, exc=True,
            ))
        user = self.getCurrentUser()
        job = Job().createLocalJob(
            module="upenncontrast_spatial.server.recompute",
            title="Recompute expression table (%s)" % scope,
            type="spatial_recompute",
            user=user,
            kwargs={
                "datasetId": str(datasetId),
                "userId": str(user["_id"]),
                "transcriptsFileId": str(
                    transcriptsEntry["transcriptsFileId"]
                ),
                "pixelSize": transcriptsEntry["pixelSize"],
                "transform": transcriptsEntry.get("transform"),
                "activeFileId": (
                    str(activeFileId) if activeFileId is not None else None
                ),
                "label": label.strip(),
                "scope": scope,
                "minQv": minQv,
                "tags": tags,
                "recomputeEmbeddings": withEmbeddings,
            },
            asynchronous=True,
        )
        Job().scheduleJob(job)
        return {"jobId": str(job["_id"])}

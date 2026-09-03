"""Transcript routes under /spatial/{datasetId}/transcripts (plan §12).

Mixed into the Spatial resource so they share its dataset loading and
registry; kept in their own file because the per-molecule store is a
different artifact from the expression table (a dataset may have either).
"""

import math
import zipfile

import cherrypy
import numpy as np
from girder.api import access
from girder.api.describe import Description, describeRoute
from girder.api.rest import setRawResponse, setResponseHeader
from girder.constants import AccessType, TokenScope
from girder.exceptions import RestException
from girder.models.file import File
from girder.models.item import Item

from upenncontrast_annotation.server.helpers.annotationRaster import (
    parseHexColor,
)
from upenncontrast_annotation.server.helpers.validation import (
    requireCountWithin,
    requireFloat,
    requireInt,
    requireList,
    requireObjectBody,
    requireObjectId,
)

from ..transcripts import (
    MAX_GENES_PER_REQUEST,
    MAX_POINTS_PER_RESPONSE,
    MAX_TILES_PER_REQUEST,
    TILE_KEY_PATTERN,
    encodePoints,
    invalidateTranscriptStore,
    openTranscriptStore,
    parseTransform,
)

MAX_GENE_SEARCH_RESULTS = 200
DEFAULT_GENE_SEARCH_RESULTS = 25
# Same pyramid parameters as the annotation overview raster.
RASTER_TILE_SIZES = (256, 512, 1024)
MAX_IMAGE_EDGE = 131072
MAX_PYRAMID_LEVEL = 30
DEFAULT_DENSITY_COLOR = (255, 255, 255)


def _requireIntWithin(value, name, minimum, maximum):
    number = requireInt(value, name)
    if not minimum <= number <= maximum:
        raise RestException(
            "%s must be between %d and %d" % (name, minimum, maximum), code=400
        )
    return number


def _requireGenes(store, value):
    if isinstance(value, str):
        value = [gene for gene in value.split(",") if gene]
    genes = requireList(value, "genes")
    requireCountWithin(len(genes), MAX_GENES_PER_REQUEST, "genes")
    if not genes:
        raise RestException("genes must not be empty", code=400)
    if not all(isinstance(gene, str) for gene in genes):
        raise RestException("genes must be gene symbols", code=400)
    try:
        return store.geneIndices(genes)
    except ValueError as exc:
        raise RestException(str(exc), code=400)


class TranscriptRoutes:
    def _addTranscriptRoutes(self):
        base = (":datasetId", "transcripts")
        self.route("GET", base, self.transcripts)
        self.route("POST", base + ("register",), self.registerTranscripts)
        self.route("DELETE", base, self.unregisterTranscripts)
        self.route("GET", base + ("genes",), self.transcriptGenes)
        self.route("POST", base + ("points",), self.transcriptPoints)
        self.route(
            "GET", base + ("density", ":z", ":x", ":y"),
            self.transcriptDensityTile,
        )

    # ---- helpers --------------------------------------------------------

    def _openTranscripts(self, datasetId):
        entry = self._registry.forDataset(datasetId)
        if entry is None or "transcriptsFileId" not in entry:
            raise RestException(
                "No transcript store is registered for this dataset.",
                code=404,
            )
        fileDoc = File().load(
            entry["transcriptsFileId"], user=self.getCurrentUser(),
            level=AccessType.READ, exc=True,
        )
        return entry, openTranscriptStore(
            fileDoc, entry["pixelSize"], parseTransform(entry.get("transform"))
        )

    # ---- routes ---------------------------------------------------------

    @access.public(scope=TokenScope.DATA_READ)
    @describeRoute(
        Description("Describe the dataset's transcript store")
        .notes("Levels of the tile pyramid with their tile sizes in microns "
               "and image pixels, the keys and point counts of each tile, "
               "and the registration (pixelSize, transform).")
        .param("datasetId", "The dataset (folder) id", paramType="path")
        .errorResponse("No transcript store is registered.", 404)
    )
    def transcripts(self, datasetId, params):
        datasetId = self._loadDataset(datasetId, AccessType.READ)
        entry, store = self._openTranscripts(datasetId)
        result = store.schema()
        result["itemId"] = str(entry["transcriptsItemId"])
        return result

    @access.user(scope=TokenScope.DATA_WRITE)
    @describeRoute(
        Description("Register an item in the dataset folder as its transcript "
                    "store")
        .notes("The item must hold exactly one file: the 10x "
               "transcripts.zarr.zip. pixelSize is microns per image pixel; "
               "transform is an optional 3x3 matrix taking pixels on the "
               "transcripts' grid to this image's pixels (for H&E).")
        .param("datasetId", "The dataset (folder) id", paramType="path")
        .param("body", "JSON: {itemId, pixelSize, transform?}",
               paramType="body")
        .errorResponse()
        .errorResponse("Write access denied.", 403)
    )
    def registerTranscripts(self, datasetId, params):
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
        pixelSize = requireFloat(body.get("pixelSize"), "pixelSize")
        if pixelSize <= 0:
            raise RestException("pixelSize must be positive", code=400)
        try:
            transform = parseTransform(body.get("transform"))
        except ValueError as exc:
            raise RestException(str(exc), code=400)
        files = list(Item().childFiles(item))
        if len(files) != 1:
            raise RestException(
                "The item must hold exactly one file (the zipped store)."
            )
        invalidateTranscriptStore(files[0]["_id"])
        try:
            store = openTranscriptStore(files[0], pixelSize, transform)
        except (ValueError, KeyError, OSError, zipfile.BadZipFile) as exc:
            raise RestException(
                "Not a readable transcript store: %s" % exc, code=400
            )
        self._registry.registerTranscripts(datasetId, {
            "transcriptsItemId": item["_id"],
            "transcriptsFileId": files[0]["_id"],
            "pixelSize": pixelSize,
            "transform": None if transform is None else transform.tolist(),
        })
        return store.schema()

    @access.user(scope=TokenScope.DATA_WRITE)
    @describeRoute(
        Description("Forget the dataset's transcript store (the item stays)")
        .param("datasetId", "The dataset (folder) id", paramType="path")
        .errorResponse("Write access denied.", 403)
    )
    def unregisterTranscripts(self, datasetId, params):
        datasetId = self._loadDataset(datasetId, AccessType.WRITE)
        entry = self._registry.forDataset(datasetId)
        if entry is not None and "transcriptsFileId" in entry:
            invalidateTranscriptStore(entry["transcriptsFileId"])
            self._registry.unregisterTranscripts(datasetId)

    @access.public(scope=TokenScope.DATA_READ)
    @describeRoute(
        Description("Search the transcript store's genes by symbol")
        .param("datasetId", "The dataset (folder) id", paramType="path")
        .param("search", "Case-insensitive query (prefix matches first)",
               required=False)
        .param("limit", "Maximum results (default %d, at most %d)"
               % (DEFAULT_GENE_SEARCH_RESULTS, MAX_GENE_SEARCH_RESULTS),
               required=False, dataType="int")
        .errorResponse()
    )
    def transcriptGenes(self, datasetId, params):
        datasetId = self._loadDataset(datasetId, AccessType.READ)
        _, store = self._openTranscripts(datasetId)
        limit = _requireIntWithin(
            params.get("limit", DEFAULT_GENE_SEARCH_RESULTS), "limit",
            1, MAX_GENE_SEARCH_RESULTS,
        )
        return store.searchGenes(params.get("search", ""), limit)

    @access.public(scope=TokenScope.DATA_READ)
    @describeRoute(
        Description("Transcript points of up to %d genes in a set of pyramid "
                    "tiles" % MAX_GENES_PER_REQUEST)
        .notes("Body: {genes: [symbol], level, tiles: ['gx,gy'], minQv?}. "
               "Binary response (application/octet-stream): uint32 n, "
               "uint8 hasQuality, float32[n*2] x,y in image pixels, "
               "uint8[n] index into genes, then at level 0 float32[n] "
               "quality. The store carries no cell reference; which cell a "
               "molecule sits in is a geometric question for the client. "
               "Points above %d are refused with 413."
               % MAX_POINTS_PER_RESPONSE)
        .param("datasetId", "The dataset (folder) id", paramType="path")
        .param("body", "JSON, see notes", paramType="body")
        .errorResponse()
        .errorResponse("Too many points; ask for a coarser level.", 413)
    )
    def transcriptPoints(self, datasetId, params):
        datasetId = self._loadDataset(datasetId, AccessType.READ)
        _, store = self._openTranscripts(datasetId)
        body = requireObjectBody(self.getBodyJson())
        geneIndices = _requireGenes(store, body.get("genes"))
        level = _requireIntWithin(
            body.get("level", 0), "level", 0, store.levels - 1
        )
        tiles = requireList(body.get("tiles"), "tiles")
        requireCountWithin(len(tiles), MAX_TILES_PER_REQUEST, "tiles")
        if not tiles:
            raise RestException("tiles must not be empty", code=400)
        if not all(
            isinstance(key, str) and TILE_KEY_PATTERN.match(key)
            for key in tiles
        ):
            raise RestException("tiles must be 'gx,gy' keys", code=400)
        minQv = requireFloat(body.get("minQv", 0), "minQv")
        if minQv < 0:
            raise RestException("minQv must not be negative", code=400)

        xys, slots, qvs = [], [], []
        total = 0
        for key in dict.fromkeys(tiles):
            xy, slot, qv = store.tilePoints(level, key, geneIndices, minQv)
            total += len(xy)
            if total > MAX_POINTS_PER_RESPONSE:
                raise RestException(
                    "More than %d points; ask for a coarser level or fewer "
                    "tiles." % MAX_POINTS_PER_RESPONSE, code=413,
                )
            xys.append(xy)
            slots.append(slot)
            if qv is not None:
                qvs.append(qv)
        setRawResponse()
        setResponseHeader("Content-Type", "application/octet-stream")
        return encodePoints(
            store.toPixels(np.concatenate(xys)),
            np.concatenate(slots),
            np.concatenate(qvs) if level == 0 else None,
        )

    # GeoJS loads OSM tiles through <img> requests, which cannot attach the
    # Girder-Token header; opt into the HttpOnly auth cookie like the
    # annotation overview raster does.
    @access.public(scope=TokenScope.DATA_READ, cookie=True)
    @describeRoute(
        Description("Render a transcript density heat-map tile")
        .notes("Same pyramid as the annotation overview raster: "
               "scale = 2 ** (z - maxLevel), tile (x, y) covers image pixels "
               "[x, x + 1) * tileSize / scale. Alpha is the square root of "
               "the requested genes' count per 10 um bin relative to the "
               "99.5th percentile of their occupied bins.")
        .param("z", "Tile pyramid level", paramType="path")
        .param("x", "Tile x index", paramType="path")
        .param("y", "Tile y index", paramType="path")
        .param("datasetId", "The dataset (folder) id", paramType="path")
        .param("genes", "Comma-separated gene symbols (at most %d)"
               % MAX_GENES_PER_REQUEST, required=True)
        .param("sizeX", "Full-resolution image width", required=True)
        .param("sizeY", "Full-resolution image height", required=True)
        .param("tileSize", "Output tile edge", required=False)
        .param("maxLevel", "Maximum level of the image pyramid",
               required=True)
        .param("color", "#RRGGBB heat-map color", required=False)
        .errorResponse("Invalid tile request", 400)
        .errorResponse("Authentication required for private dataset", 401)
        .errorResponse("Read access denied", 403)
    )
    def transcriptDensityTile(self, datasetId, z, x, y, params):
        datasetId = self._loadDataset(datasetId, AccessType.READ)
        _, store = self._openTranscripts(datasetId)
        geneIndices = _requireGenes(store, params.get("genes"))
        maxLevel = _requireIntWithin(
            params.get("maxLevel"), "maxLevel", 0, MAX_PYRAMID_LEVEL
        )
        level = _requireIntWithin(z, "z", 0, maxLevel)
        tileX = _requireIntWithin(x, "x", 0, MAX_IMAGE_EDGE)
        tileY = _requireIntWithin(y, "y", 0, MAX_IMAGE_EDGE)
        sizeX = _requireIntWithin(
            params.get("sizeX"), "sizeX", 1, MAX_IMAGE_EDGE
        )
        sizeY = _requireIntWithin(
            params.get("sizeY"), "sizeY", 1, MAX_IMAGE_EDGE
        )
        tileSize = requireInt(params.get("tileSize", 256), "tileSize")
        if tileSize not in RASTER_TILE_SIZES:
            raise RestException(
                "tileSize must be one of %s" % (RASTER_TILE_SIZES,), code=400
            )
        # Same pyramid arithmetic as the annotation raster: a tile outside it
        # is a bad request, not a blank image.
        scale = 2.0 ** (level - maxLevel)
        if (
            tileX >= math.ceil(sizeX * scale / tileSize)
            or tileY >= math.ceil(sizeY * scale / tileSize)
        ):
            raise RestException("x or y is outside the tile pyramid", code=400)
        color = DEFAULT_DENSITY_COLOR
        if "color" in params:
            parsed = parseHexColor(params["color"])
            if parsed is None:
                raise RestException("color must be #RRGGBB", code=400)
            color = parsed[:3]
        try:
            png = store.densityTile(
                geneIndices, color, sizeX, sizeY, tileSize, maxLevel,
                level, tileX, tileY,
            )
        except ValueError as exc:
            raise RestException(str(exc), code=400)
        setRawResponse()
        setResponseHeader("Content-Type", "image/png")
        # The store is immutable once registered, so tiles can be cached
        # per registration; the client bumps the URL when genes change.
        setResponseHeader("Cache-Control", "private, max-age=3600")
        cherrypy.response.headers.pop("Pragma", None)
        return png

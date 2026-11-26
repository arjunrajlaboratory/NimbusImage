"""Saved scalar maps (hotspot density/statistic maps) as an image overlay
(codebaseDocumentation/HOTSPOT_REGIONS_WORKER.md §5.8, §8.2).

No model: a map is an item in the dataset folder whose `nimbusScalarMap`
metadata describes it; its single file is an .npz of float arrays.
Rendering and the array cache live in `helpers/scalarMap.py`.
"""

import math
import cherrypy
from girder.api import access
from girder.api.describe import Description, describeRoute
from girder.api.rest import Resource, setRawResponse, setResponseHeader
from girder.constants import AccessType, TokenScope
from girder.exceptions import RestException
from girder.models.folder import Folder
from girder.models.item import Item

from ..helpers.scalarMap import (
    SCALAR_MAP_COLORMAPS,
    SCALAR_MAP_META_KEY,
    defaultDisplayRange,
    invalidateScalarMapFiles,
    isScalarMapMeta,
    loadScalarMapArray,
    locationKeys,
    renderScalarMapTile,
    scalarMapMeta,
)
from ..helpers.validation import requireFloat, requireInt, requireObjectId

# Same pyramid limits as the annotation overview raster.
TILE_SIZES = (256, 512, 1024)
MAX_IMAGE_EDGE = 131072
MAX_PYRAMID_LEVEL = 30


def _requireIntWithin(value, name, minimum, maximum):
    number = requireInt(value, name)
    if not minimum <= number <= maximum:
        raise RestException(
            "%s must be between %d and %d" % (name, minimum, maximum),
            code=400,
        )
    return number


class ScalarMap(Resource):
    def __init__(self):
        super().__init__()
        self.resourceName = "scalar_map"
        self.route("GET", (), self.find)
        self.route("GET", (":itemId", "tiles", ":z", ":x", ":y"), self.tile)
        self.route("DELETE", (":itemId",), self.delete)

    def _loadMap(self, itemId, level):
        """(item, validated meta) or 400 when the item is not a map."""
        item = Item().load(
            requireObjectId(itemId, "itemId"), user=self.getCurrentUser(),
            level=level, exc=True,
        )
        try:
            return item, scalarMapMeta(item)
        except ValueError as exc:
            raise RestException(str(exc), code=400)

    @access.public(scope=TokenScope.DATA_READ)
    @describeRoute(
        Description("List the scalar maps saved in a dataset")
        .notes("One entry per item directly in the dataset folder whose "
               "meta.%s is a valid version-1 map: {itemId, updated, meta}. "
               "Other items are skipped." % SCALAR_MAP_META_KEY)
        .param("datasetId", "The dataset (folder) id", required=True)
        .errorResponse("Read access denied", 403)
    )
    def find(self, params):
        datasetId = requireObjectId(params.get("datasetId"), "datasetId")
        folder = Folder().load(
            datasetId, user=self.getCurrentUser(), level=AccessType.READ,
            exc=True,
        )
        items = Item().find(
            {
                "folderId": folder["_id"],
                "meta.%s" % SCALAR_MAP_META_KEY: {"$exists": True},
            },
            sort=[("created", 1)],
            fields=["_id", "updated", "meta.%s" % SCALAR_MAP_META_KEY],
        )
        return [
            {
                "itemId": str(item["_id"]),
                "updated": item.get("updated"),
                "meta": item["meta"][SCALAR_MAP_META_KEY],
            }
            for item in items
            if isScalarMapMeta(item["meta"][SCALAR_MAP_META_KEY])
        ]

    # GeoJS loads OSM tiles through <img> requests, which cannot attach the
    # Girder-Token header: opt into the HttpOnly auth cookie like the
    # annotation overview raster. Share links pass their token as the
    # `token` query parameter, which Girder reads on any route.
    @access.public(scope=TokenScope.DATA_READ, cookie=True)
    @describeRoute(
        Description("Render a scalar map tile on the image's tile pyramid")
        .notes("scale = 2 ** (z - maxLevel); tile (x, y) covers image "
               "pixels [x, x + 1) * tileSize / scale. Bilinear, NaN-aware "
               "sampling; NaN and off-map pixels are transparent. With "
               "threshold, pixels on the other side of it are dimmed.")
        .param("itemId", "The map item id", paramType="path")
        .param("z", "Tile pyramid level", paramType="path")
        .param("x", "Tile x index", paramType="path")
        .param("y", "Tile y index", paramType="path")
        .param("location", "Location key, e.g. xy0_z0_t0", required=True)
        .param("sizeX", "Full-resolution image width", required=True)
        .param("sizeY", "Full-resolution image height", required=True)
        .param("maxLevel", "Maximum level of the image pyramid",
               required=True)
        .param("tileSize", "Output tile edge (default 256)", required=False)
        .param("colormap", "One of %s (default viridis)"
               % ", ".join(SCALAR_MAP_COLORMAPS), required=False)
        .param("min", "Value at the bottom of the colormap "
               "(default valueRange[0])", required=False)
        .param("max", "Value at the top of the colormap "
               "(default valueRange[1])", required=False)
        .param("threshold", "Highlight values past this", required=False)
        .param("thresholdSide", "above (default) or below", required=False)
        .errorResponse("Invalid tile request or not a scalar map", 400)
        .errorResponse("Authentication required for private dataset", 401)
        .errorResponse("Read access denied", 403)
    )
    def tile(self, itemId, z, x, y, params):
        item, meta = self._loadMap(itemId, AccessType.READ)
        location = params.get("location")
        if location not in locationKeys(meta):
            raise RestException(
                "location must be one of the map's location keys", code=400
            )
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
        if tileSize not in TILE_SIZES:
            raise RestException(
                "tileSize must be one of %s" % (TILE_SIZES,), code=400
            )
        scale = 2.0 ** (level - maxLevel)
        if (
            tileX >= math.ceil(sizeX * scale / tileSize)
            or tileY >= math.ceil(sizeY * scale / tileSize)
        ):
            raise RestException("x or y is outside the tile pyramid", code=400)
        colormap = params.get("colormap", "viridis")
        if colormap not in SCALAR_MAP_COLORMAPS:
            raise RestException(
                "colormap must be one of %s"
                % ", ".join(SCALAR_MAP_COLORMAPS), code=400,
            )
        defaultMin, defaultMax = defaultDisplayRange(meta)
        vmin = requireFloat(params.get("min", defaultMin), "min")
        vmax = requireFloat(params.get("max", defaultMax), "max")
        if vmin >= vmax:
            raise RestException("min must be less than max", code=400)
        threshold = None
        if params.get("threshold") not in (None, ""):
            threshold = requireFloat(params["threshold"], "threshold")
        thresholdSide = params.get("thresholdSide", "above")
        if thresholdSide not in ("above", "below"):
            raise RestException(
                "thresholdSide must be above or below", code=400
            )
        files = list(Item().childFiles(item, limit=2))
        if len(files) != 1:
            raise RestException(
                "A scalar map item must hold exactly one file", code=400
            )
        try:
            array = loadScalarMapArray(files[0], meta, location)
            png = renderScalarMapTile(
                array, meta, sizeX, sizeY, tileSize, maxLevel, level,
                tileX, tileY, colormap, vmin, vmax, threshold, thresholdSide,
            )
        except ValueError as exc:
            raise RestException(str(exc), code=400)
        setRawResponse()
        setResponseHeader("Content-Type", "image/png")
        # Every input is in the URL; a replaced map changes its item's
        # `updated`, which the client puts in the URL to bust this.
        setResponseHeader("Cache-Control", "private, max-age=3600")
        cherrypy.response.headers.pop("Pragma", None)
        return png

    @access.user(scope=TokenScope.DATA_WRITE)
    @describeRoute(
        Description("Delete a scalar map item")
        .param("itemId", "The map item id", paramType="path")
        .errorResponse("The item is not a scalar map", 400)
        .errorResponse("Write access denied", 403)
    )
    def delete(self, itemId, params):
        item, _ = self._loadMap(itemId, AccessType.WRITE)
        fileIds = [f["_id"] for f in Item().childFiles(item)]
        Item().remove(item)
        invalidateScalarMapFiles(fileIds)

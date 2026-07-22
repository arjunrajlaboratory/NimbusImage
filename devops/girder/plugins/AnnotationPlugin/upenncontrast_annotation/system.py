import datetime
import io
import json
import logging
import re

import large_image
import yaml
from girder import events
from girder.api import access
from girder.api.describe import Description, autoDescribeRoute
from girder.api.rest import boundHandler, filtermodel
from girder.constants import AccessType, TokenScope
from girder.exceptions import RestException
from girder.models.file import File
from girder.models.folder import Folder
from girder.models.item import Item
from girder.models.token import Token
from girder.models.upload import Upload
from girder.models.user import User
from girder_jobs.constants import JobStatus
from girder_large_image.models.image_item import ImageItem


logger = logging.getLogger(__name__)

conversionJobs = {}

# Look-back window units accepted by the active-users endpoint, expressed in
# seconds.
ACTIVE_USERS_WINDOW_UNITS = {
    "s": 1,
    "m": 60,
    "h": 3600,
    "d": 86400,
    "w": 604800,
}

# Upper bound on the look-back window. Girder deletes tokens once they expire
# (default ~180 days), so counts for windows longer than the token lifetime
# are inherently limited by token retention; this cap keeps an unbounded
# client-supplied value from scanning an arbitrarily large token range.
MAX_ACTIVE_USERS_WINDOW_SECONDS = 366 * 86400


def addSystemEndpoints(apiRoot):
    """
    This adds endpoints to routes that already exist in Girder.

    :param apiRoot: Girder api root class.
    """
    # Added to the item route
    apiRoot.item.route("GET", ("query",), getItemsByQuery)
    apiRoot.item.route("PUT", (":itemId", "cache_maxmerge"), cacheMaxMerge)
    # Added to the folder route
    apiRoot.folder.route("GET", ("query",), getFoldersByQuery)
    # Added to the system route (admin-only usage metrics)
    apiRoot.system.route("GET", ("active_users",), getActiveUsers)

    # Also bind some events
    events.bind(
        "jobs.job.update.after", "upenncontrast_annotation", _updateJob
    )
    events.bind("model.job.save", "upenncontrast_annotation", _updateJob)
    events.bind("model.job.remove", "upenncontrast_annotation", _updateJob)

    events.bind("model.user.save", "upenncontrast_annotation",
                lambda event: event.info.update({'public': False}))


@access.public(scope=TokenScope.DATA_READ)
@filtermodel(model=Item)
@autoDescribeRoute(
    Description("List items that match a query.")
    .responseClass("Item", array=True)
    .jsonParam(
        "query",
        "Find items that match this Mongo query.",
        required=True,
        requireObject=True,
    )
    .pagingParams(defaultSort="_id")
    .errorResponse()
)
@boundHandler()
def getItemsByQuery(self, query, limit, offset, sort):
    user = self.getCurrentUser()
    return Item().findWithPermissions(
        query, offset=offset, limit=limit, sort=sort, user=user
    )


@access.public(scope=TokenScope.DATA_READ)
@filtermodel(model=Folder)
@autoDescribeRoute(
    Description("List folders that match a query.")
    .responseClass("Folder", array=True)
    .jsonParam(
        "query",
        "Find folders that match this Mongo query.",
        required=True,
        requireObject=True,
    )
    .pagingParams(defaultSort="_id")
    .errorResponse()
)
@boundHandler()
def getFoldersByQuery(self, query, limit, offset, sort):
    user = self.getCurrentUser()
    return Folder().findWithPermissions(
        query, offset=offset, limit=limit, sort=sort, user=user
    )


def _parseActiveUsersWindow(window):
    """
    Convert a window string (e.g. "1d", "24h", "7d") to a number of seconds.

    :param window: an integer amount followed by a unit (s, m, h, d, w).
    :returns: the window length in seconds.
    :raises RestException: if the value is malformed or out of range.
    """
    match = re.fullmatch(r"(\d+)([smhdw])", window.strip().lower())
    if not match:
        raise RestException(
            "window must be a positive integer followed by one of "
            "s, m, h, d, w (e.g. '1d', '7d', '24h').",
            code=400,
        )
    seconds = int(match.group(1)) * ACTIVE_USERS_WINDOW_UNITS[match.group(2)]
    if seconds <= 0:
        raise RestException("window must be greater than zero.", code=400)
    if seconds > MAX_ACTIVE_USERS_WINDOW_SECONDS:
        raise RestException(
            "window is too large; the maximum is 366d.", code=400
        )
    return seconds


@access.admin
@autoDescribeRoute(
    Description("Count distinct authenticated users active within a window.")
    .notes(
        "Returns the number of distinct users who obtained an authentication "
        "token within the given look-back window. This counts users who "
        "authenticated (logged in or refreshed a session) during the window, "
        "deduplicated per user. Requires site administrator access.\n\n"
        "Because Girder deletes tokens once they expire (default ~180 days), "
        "counts for windows longer than the token lifetime are limited by "
        "token retention."
    )
    .param(
        "window",
        "Length of the look-back window: a positive integer followed by a "
        "unit (s, m, h, d, w). Defaults to 1d.",
        required=False,
        default="1d",
    )
    .errorResponse("You are not a site administrator.", 403)
    .errorResponse("The window parameter is invalid.", 400)
)
@boundHandler()
def getActiveUsers(self, window):
    windowSeconds = _parseActiveUsersWindow(window)
    end = datetime.datetime.utcnow()
    start = end - datetime.timedelta(seconds=windowSeconds)
    # Aggregation is the one sanctioned use of collection directly; Girder's
    # find() does not support aggregation pipelines. Grouping on userId
    # deduplicates so the result is a distinct-user count, not a token count.
    aggregation = list(Token().collection.aggregate([
        {"$match": {"created": {"$gte": start}, "userId": {"$ne": None}}},
        {"$group": {"_id": "$userId"}},
        {"$count": "count"},
    ]))
    return {
        "window": window,
        "windowSeconds": windowSeconds,
        "start": start,
        "end": end,
        "activeUsers": aggregation[0]["count"] if aggregation else 0,
    }


@access.user
@autoDescribeRoute(
    Description("Create images that cache max-merge values.")
    .modelParam("itemId", model=Item, level=AccessType.READ)
    .errorResponse()
)
@boundHandler()
def cacheMaxMerge(self, item):
    if len(item["largeImage"].get("merge_substitutes", {})):
        # we already have some computed, so we probably don't need to do it
        # again
        return
    user = self.getCurrentUser()
    ts = ImageItem._loadTileSource(
        item, format=large_image.constants.TILE_FORMAT_NUMPY
    )
    if ts.tileWidth != ts.tileHeight and (
        ts.tileWidth < ts.sizeX or ts.tileHeight < ts.sizeY
    ):
        raise RestException("Cannot generate merge file")
    metadata = ts.getMetadata()
    if "IndexRange" not in metadata or "IndexStride" not in metadata:
        raise Exception("Specified item is not multi-frame")
    sample = ts.getSingleTile()
    jobs = []
    for axis in ["Z", "T", "ZT"]:
        if axis != "ZT":
            stride = metadata["IndexStride"].get(f"Index{axis}", 1)
            count = metadata["IndexRange"].get(f"Index{axis}", 0)
            stride2 = 1
            count2 = 1
        else:
            stride = metadata["IndexStride"].get("IndexZ", 1)
            count = metadata["IndexRange"].get("IndexZ", 0)
            stride2 = metadata["IndexStride"].get("IndexT", 1)
            count2 = metadata["IndexRange"].get("IndexT", 0)
        if stride and count * count2 > 1:
            style = {
                "dtype": str(sample["tile"].dtype),
                "bands": [
                    {"framedelta": idx * stride, "min": "full", "max": "full"}
                    for idx in range(count)
                ],
            }
            if sample["tile"].shape[2] == 1:
                style["axis"] = 0
            multi = {
                "tileWidth": ts.tileWidth,
                "tileHeight": ts.tileHeight,
                "sources": [
                    {
                        "path": "girder://%s" % item["_id"],
                        "frames": [
                            idx
                            for idx in range(len(metadata["frames"]))
                            if not (idx // stride) % count
                            and not (idx // stride2) % count2
                        ],
                        "style": style,
                    }
                ],
            }
            # If this is a file we converted because we used the multi-source
            # make sure we use the same source to read it back
            if item.get("largeImage", {}).get("sourceName", "") in {"tiff"}:
                multi["sources"][0]["sourceName"] = item["largeImage"][
                    "sourceName"]
            datasetFolder = Folder().load(
                item["folderId"], user=user, level=AccessType.WRITE
            )
            foldername = "maxmerge_cache"
            multi["sources"][0]["path"] = "../%s" % item["name"]
            destfolder = Folder().createFolder(
                datasetFolder,
                foldername,
                public=datasetFolder["public"],
                creator=user,
                reuseExisting=True,
            )
            dest = io.BytesIO()
            dest.write(yaml.dump(multi).encode())
            destsize = dest.tell()
            dest.seek(0)
            destname = item["name"] + "_maxmerge_" + axis.lower() + ".yaml"
            destfile = Upload().uploadFromFile(
                dest, destsize, destname, "folder", destfolder, user=user
            )
            destitem = Item().load(
                destfile["itemId"], user=user, level=AccessType.READ
            )
            ImageItem().delete(destitem)
            destitem = Item().load(
                destfile["itemId"], user=user, level=AccessType.READ
            )

            job = ImageItem().convertImage(
                destitem,
                destfile,
                user,
                localJob=True,
                tileSize=max(ts.tileWidth, ts.tileHeight),
            )
            jobs.append(str(job["_id"]))
            subs = {}
            for idx, frame in enumerate(multi["sources"][0]["frames"]):
                framelist = [
                    frame + band["framedelta"]
                    for band in multi["sources"][0]["style"]["bands"]
                ]
                subs[json.dumps(framelist, separators=(",", ":"))] = {
                    "frame": idx
                }
            conversionJobs[str(job["_id"])] = {
                "item": item["_id"],
                "destitem": destitem["_id"],
                "user": user["_id"],
                "merge_substitutes": subs,
            }
    return {"scheduledJobs": jobs}


def _updateJob(event):
    job = (
        event.info["job"]
        if event.name == "jobs.job.update.after"
        else event.info
    )
    if "_id" not in job or str(job["_id"]) not in conversionJobs:
        return
    status = job["status"]
    if event.name == "model.job.remove" and status not in (
        JobStatus.ERROR,
        JobStatus.CANCELED,
        JobStatus.SUCCESS,
    ):
        status = JobStatus.CANCELED
    if status not in (JobStatus.ERROR, JobStatus.CANCELED, JobStatus.SUCCESS):
        return
    info = conversionJobs.pop(str(job["_id"]))
    user = User().load(info["user"], force=True)
    try:
        Item().remove(
            Item().load(info["destitem"], user=user, level=AccessType.ADMIN)
        )
    except Exception:
        pass
    if status != JobStatus.SUCCESS:
        return
    item = Item().load(info["item"], user=user, level=AccessType.WRITE)
    if "largeImage" not in item:
        return
    item["largeImage"].setdefault("merge_substitutes", {})
    newFile = File().load(
        job["results"]["file"][0], user=user, level=AccessType.READ
    )
    for sub, record in info["merge_substitutes"].items():
        record["itemId"] = newFile["itemId"]
        item["largeImage"]["merge_substitutes"][sub] = record
    item = Item().save(item)


_origImageItem_loadTileSource = ImageItem._loadTileSource


@classmethod
def _loadTileSource(cls, item, **kwargs):
    style = kwargs.get("style", None)
    if style and not isinstance(style, dict):
        try:
            style = json.loads(style)
        except Exception:
            style = None
    if (
        style
        and "bands" in style
        and len(style["bands"]) > 1
        and "merge_substitutes" in item["largeImage"]
    ):
        framelist = []
        uniform = sub = None
        for entry in style["bands"]:
            if "frame" not in entry:
                uniform = False
            else:
                band = entry.copy()
                framelist.append(band.pop("frame"))
                if uniform is None:
                    uniform = band
                elif uniform != band:
                    uniform = False
        if uniform:
            key = json.dumps(framelist, separators=(",", ":"))
            sub = item["largeImage"]["merge_substitutes"].get(key)
        if sub:
            try:
                subitem = Item().load(sub["itemId"], force=True)
            except Exception:
                logger.info("merge substitute file is no longer available")
                subitem = None
        if sub and subitem:
            subkwargs = kwargs.copy()
            subkwargs.pop("frame", None)
            uniform["frame"] = sub["frame"]
            subkwargs["style"] = json.dumps(
                {"bands": [uniform]}, separators=(",", ":")
            )
            return _origImageItem_loadTileSource(subitem, **subkwargs)
    return _origImageItem_loadTileSource(item, **kwargs)


ImageItem._loadTileSource = _loadTileSource

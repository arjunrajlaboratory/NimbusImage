import io
import json

import large_image
import yaml
from girder.api import access
from girder.api.describe import Description, autoDescribeRoute
from girder.api.rest import boundHandler, filtermodel
from girder.constants import AccessType, TokenScope
from girder.exceptions import RestException
from girder.models.file import File
from girder.models.folder import Folder
from girder.models.item import Item
from girder.models.upload import Upload
from girder.models.user import User
from girder_jobs.constants import JobStatus
from girder_large_image.models.image_item import ImageItem

from girder import events, logger

conversionJobs = {}


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

"""
Dataset API for turning a folder of uploaded images into a working
NimbusImage multi-source dataset via the REST API.

This mirrors the frontend flow implemented by
``src/views/dataset/MultiSourceConfiguration.vue``: it marks plain image
items as large images, computes a multi-source tile configuration from
filenames and tile metadata, uploads that configuration as a JSON item,
optionally schedules a transcode job, and records dimension labels on the
folder.

Out of scope: warming caches (tile_frames quad_info, cache_maxmerge,
histogram) the way the frontend does immediately after configuration.
Callers that need those should hit the corresponding endpoints separately.
"""

import copy
import io
import json
import logging

from large_image.exceptions import TileGeneralError

from girder.api import access
from girder.api.describe import autoDescribeRoute, Description
from girder.api.rest import Resource
from girder.constants import AccessType, TokenScope
from girder.exceptions import RestException
from girder.models.file import File
from girder.models.folder import Folder
from girder.models.item import Item
from girder.models.upload import Upload
from girder_jobs.models.job import Job
from girder_large_image.models.image_item import ImageItem

from ..helpers.multi_source import (
    UP_DIMS, compute_configuration, validate_assignments,
)

MULTI_SOURCE_ITEM_NAME = "multi-source2.json"
_NO_DIMENSION_LABELS = object()

logger = logging.getLogger(__name__)


class Dataset(Resource):
    """REST API resource for multi-source dataset configuration."""

    def __init__(self):
        super().__init__()
        self.resourceName = "dataset"

        self._imageItemModel = ImageItem()

        self.route("POST", (":id", "multi_source"), self.createMultiSource)

    @access.user(scope=TokenScope.DATA_WRITE)
    @autoDescribeRoute(
        Description(
            "Configure a folder of uploaded images as a multi-source "
            "NimbusImage dataset."
        )
        .notes(
            'Mirrors the frontend\'s MultiSourceConfiguration flow: marks '
            'plain image items as large images, computes a multi-source '
            'tile configuration from filenames and tile metadata, uploads '
            'it as "%s", optionally schedules a transcode job, and '
            "records dimension labels on the folder. Does not warm "
            "caches (tile_frames quad_info, cache_maxmerge, histogram) "
            "the way the frontend does after configuration." % (
                MULTI_SOURCE_ITEM_NAME
            )
        )
        .modelParam(
            "id", "The dataset folder id.", model=Folder,
            destName="folder", level=AccessType.WRITE, paramType="path",
        )
        .jsonParam(
            "body", "Multi-source configuration options.",
            paramType="body", required=False, requireObject=True,
        )
        .errorResponse("ID was invalid.")
        .errorResponse("Write access was denied for the folder.", 403)
    )
    def createMultiSource(self, folder, body):
        body = body or {}
        assignmentStrategy = self._parseAssignmentStrategy(
            body.get("assignments")
        )
        transcodeOption = self._parseBooleanOption(
            body, "transcode", None
        )
        splitRGBBands = self._parseBooleanOption(
            body, "splitRGBBands", True
        )
        enableCompositing = self._parseBooleanOption(
            body, "enableCompositing", False
        )
        dryRun = self._parseBooleanOption(body, "dryRun", False)

        if folder.get("meta", {}).get("subtype") != "contrastDataset":
            raise RestException(
                "Folder is not a contrastDataset.", code=400
            )

        items = list(Item().find(
            {"folderId": folder["_id"]}, sort=[("lowerName", 1)]
        ))
        if any(item["name"] == MULTI_SOURCE_ITEM_NAME for item in items):
            raise RestException(
                "Dataset is already configured for multiple sources.",
                code=409,
            )
        if not items:
            raise RestException("Folder has no items.", code=400)

        user = self.getCurrentUser()
        token = self.getCurrentToken()

        newlyMarked = []
        newItem = None
        job = None
        dimensionLabelsSet = False
        committed = False
        folderMeta = folder.get("meta", {})
        previousDimensionLabels = (
            copy.deepcopy(folderMeta["dimensionLabels"])
            if "dimensionLabels" in folderMeta
            else _NO_DIMENSION_LABELS
        )
        try:
            newlyMarked = self._markLargeImages(items, user, token)

            itemNames = [item["name"] for item in items]
            tilesMetadata = [
                self._imageItemModel.getMetadata(item) for item in items
            ]
            internalMetadata = [
                self._imageItemModel.getInternalMetadata(item)
                for item in items
            ]

            try:
                result = compute_configuration(
                    itemNames, tilesMetadata, internalMetadata,
                    strategy=assignmentStrategy,
                    split_rgb_bands=splitRGBBands,
                    enable_compositing=enableCompositing,
                )
                # compute_configuration does not itself enforce the
                # frontend's submitEnabled/isRGBAssignmentValid rules, so
                # validate explicitly (see 1e in the spec).
                isMultiBandRGB = (
                    result["isRGBFile"] and result["rgbBandCount"] > 1
                )
                validate_assignments(
                    result["variables"], result["assignments"],
                    isMultiBandRGB, splitRGBBands,
                )
            except ValueError as e:
                raise RestException(str(e), code=400)

            transcode = (
                result["transcodeDefault"] if transcodeOption is None
                else transcodeOption
            )

            if dryRun:
                return dict(result, transcode=transcode)

            newItem, newFile = self._uploadConfiguration(
                folder, result["config"], user
            )

            # Store reversible folder metadata before starting a transcode
            # job or removing source large images.  If either operation
            # fails, the exception handler below restores the old value.
            Folder().setMetadata(
                folder, {"dimensionLabels": result["dimensionLabels"]}
            )
            dimensionLabelsSet = True

            if transcode:
                job = self._imageItemModel.createImageItem(
                    newItem, newFile, user=user, token=token,
                    createJob="always", localJob=True,
                )

            self._removeLargeImages(items, transcode)
            committed = True

            return {
                "itemId": str(newItem["_id"]),
                "jobId": str(job["_id"]) if job is not None else None,
                "config": result["config"],
                "dimensionLabels": result["dimensionLabels"],
                "variables": result["variables"],
                "assignments": result["assignments"],
                "transcode": transcode,
            }
        except Exception:
            if job is not None:
                try:
                    Job().cancelJob(job)
                except Exception:
                    logger.exception(
                        "Could not cancel failed dataset transcode job %s",
                        job.get("_id"),
                    )
            if newItem is not None:
                try:
                    Item().remove(newItem)
                except Exception:
                    logger.exception(
                        "Could not remove failed multi-source item %s",
                        newItem.get("_id"),
                    )
            if dimensionLabelsSet:
                try:
                    self._restoreDimensionLabels(
                        folder, previousDimensionLabels
                    )
                except Exception:
                    logger.exception(
                        "Could not restore dimension labels on folder %s",
                        folder.get("_id"),
                    )
            raise
        finally:
            if not committed:
                # This also covers successful dry runs and exceptions while
                # reading tile metadata, uploading, or finalizing the config.
                self._rollbackLargeImages(newlyMarked)

    @staticmethod
    def _parseAssignmentStrategy(strategy):
        """Validate the optional per-dimension assignment strategy from
        the request body: ``{dim: {"source", "guess"} | null}``."""
        if strategy is None:
            return None
        if not isinstance(strategy, dict):
            raise RestException("assignments must be an object.", code=400)
        for dim, saved in strategy.items():
            if dim not in UP_DIMS:
                raise RestException(
                    'Unknown dimension "%s" in assignments (expected one '
                    "of %s)." % (dim, ", ".join(UP_DIMS)),
                    code=400,
                )
            if saved is None:
                continue
            if not (isinstance(saved, dict)
                    and isinstance(saved.get("source"), str)
                    and isinstance(saved.get("guess"), str)):
                raise RestException(
                    'assignments["%s"] must be null or an object with '
                    'string "source" and "guess" fields.' % dim,
                    code=400,
                )
        return strategy

    @staticmethod
    def _parseBooleanOption(body, name, default):
        """Return a JSON boolean option without Python truthy coercion."""
        if name not in body:
            return default
        value = body[name]
        if not isinstance(value, bool):
            raise RestException("%s must be a boolean." % name, code=400)
        return value

    @staticmethod
    def _restoreDimensionLabels(folder, previous):
        """Restore the folder's dimension labels after failed finalization."""
        if previous is _NO_DIMENSION_LABELS:
            Folder().setMetadata(folder, {"dimensionLabels": None})
        else:
            Folder().setMetadata(
                folder, {"dimensionLabels": previous}, allowNull=True
            )

    def _markLargeImages(self, items, user, token):
        """Mark plain image items as large images without a job.

        Mirrors the frontend's assumption that every item in the folder
        is directly usable as a tile source (e.g. a TIFF); items that
        already have a largeImage are left untouched. Returns the items
        newly marked here, so dry runs and failed requests can roll the
        marking back; a mid-loop failure rolls back its own partial
        marks before raising.
        """
        newlyMarked = []
        unmarked = [item for item in items if "largeImage" not in item]
        if not unmarked:
            return newlyMarked
        # Batch-load the first file of each unmarked item (no per-item
        # childFiles queries; see CLAUDE.md on looped DB calls).
        firstFileByItemId = {}
        for file in File().find(
            {"itemId": {"$in": [item["_id"] for item in unmarked]}}
        ):
            firstFileByItemId.setdefault(file["itemId"], file)

        for item in unmarked:
            file = firstFileByItemId.get(item["_id"])
            if file is None:
                self._rollbackLargeImages(newlyMarked)
                raise RestException(
                    'Item "%s" has no files and cannot be used as an '
                    "image source." % item["name"],
                    code=400,
                )
            try:
                self._imageItemModel.createImageItem(
                    item, file, user=user, token=token,
                    createJob=False,
                )
            except TileGeneralError as e:
                self._rollbackLargeImages(newlyMarked)
                raise RestException(
                    'Could not use item "%s" as a large image: %s' % (
                        item["name"], e
                    ),
                    code=400,
                )
            newlyMarked.append(item)
        return newlyMarked

    def _rollbackLargeImages(self, markedItems):
        """Clear largeImage marks created earlier in this request."""
        for item in markedItems:
            self._imageItemModel.delete(item)

    def _uploadConfiguration(self, folder, config, user):
        """Upload the generated config JSON as a new item in the folder."""
        configBytes = json.dumps(config).encode("utf-8")
        newFile = Upload().uploadFromFile(
            io.BytesIO(configBytes), len(configBytes),
            MULTI_SOURCE_ITEM_NAME, "folder", folder, user=user,
            mimeType="application/json",
        )
        newItem = Item().load(
            newFile["itemId"], user=user, level=AccessType.READ, exc=True
        )
        return newItem, newFile

    def _removeLargeImages(self, items, transcode):
        """Remove the largeImage marking, mirroring the frontend.

        If transcoding, the large image is removed from every source item.
        The new configuration item is left untouched because its transcode
        job has already been scheduled. Otherwise, only source items that
        were marked as large images are cleared.
        """
        if transcode:
            itemsToClear = items
        else:
            itemsToClear = [item for item in items if "largeImage" in item]
        for item in itemsToClear:
            self._imageItemModel.delete(item)

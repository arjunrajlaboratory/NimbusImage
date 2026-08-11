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

from ..helpers.default_configuration import build_default_configuration
from ..helpers.multi_source import (
    UP_DIMS, compute_configuration, validate_assignments,
    validate_source_dtypes,
)
from ..models.collection import Collection as CollectionModel
from ..models.datasetView import DatasetView as DatasetViewModel
from ..models.userColors import UserColors as UserColorsModel

MULTI_SOURCE_ITEM_NAME = "multi-source2.json"
_NO_DIMENSION_LABELS = object()

logger = logging.getLogger(__name__)


class Dataset(Resource):
    """REST API resource for multi-source dataset configuration."""

    def __init__(self):
        super().__init__()
        self.resourceName = "dataset"

        self._imageItemModel = ImageItem()
        self._collectionModel = CollectionModel()
        self._datasetViewModel = DatasetViewModel()
        self._userColorsModel = UserColorsModel()

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
            "the way the frontend does after configuration. "
            "With dryRun, nothing is written and the computed "
            "configuration is returned along with a validationError "
            "field (null when valid): use it to discover the variables "
            "and build an assignments override. A non-dry run rejects "
            "the same condition with a 400." % (
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
        createView = self._parseBooleanOption(body, "createView", True)

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
        newItemId = None
        newItem = None
        job = None
        collection = None
        datasetView = None
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
            except ValueError as e:
                raise RestException(str(e), code=400)

            # compute_configuration does not itself enforce the frontend's
            # mixed-dtype / submitEnabled / isRGBAssignmentValid rules, so
            # validate explicitly (see 1e in the spec).  The order matches
            # the frontend's `mixedSourceDtypeError ?? assignmentError`.
            validationError = None
            try:
                validate_source_dtypes(tilesMetadata)
                validate_assignments(
                    result["variables"], result["assignments"],
                    result["isRGBFile"] and result["rgbBandCount"] > 1,
                    splitRGBBands,
                )
            except ValueError as e:
                validationError = str(e)

            transcode = (
                result["transcodeDefault"] if transcodeOption is None
                else transcodeOption
            )

            # A dry run is how a caller discovers what to assign, so report
            # the failure in the body rather than raising: a 400 would
            # withhold the very `variables` list needed to build a valid
            # `assignments` override.  Real runs still refuse.
            if dryRun:
                return dict(
                    result, transcode=transcode,
                    validationError=validationError,
                )
            if validationError is not None:
                raise RestException(validationError, code=400)

            # Record the id the moment the upload returns: Item().load
            # below is itself fallible, and if it raised, the caller would
            # be left with newItem = None and no way to remove the file it
            # had just created -- every retry would then hit the preflight
            # 409 forever. Same shape as the collection/view creation
            # above: never let a resource exist without a handle to it.
            newFile = self._uploadConfiguration(
                folder, result["config"], user
            )
            newItemId = newFile["itemId"]
            newItem = Item().load(
                newItemId, user=user, level=AccessType.READ, exc=True
            )
            if newItem["name"] != MULTI_SOURCE_ITEM_NAME:
                raise RestException(
                    "Dataset was configured by another request.", code=409
                )

            # Store reversible folder metadata before starting a transcode
            # job or removing source large images.  If either operation
            # fails, the exception handler below restores the old value.
            Folder().setMetadata(
                folder, {"dimensionLabels": result["dimensionLabels"]}
            )
            dimensionLabelsSet = True

            if transcode:
                # The configuration we just uploaded has already been
                # marked by girder's largeImage.autoSet (large_image's
                # "multi" source reads JSON), and createImageItem refuses
                # an item that already has one, so clear it first. Its own
                # file survives: ImageItem().delete only removes the
                # underlying file for worker-converted images, which carry
                # largeImage.originalId.
                self._imageItemModel.delete(newItem)
                job = self._imageItemModel.createImageItem(
                    newItem, newFile, user=user, token=token,
                    createJob="always", localJob=True,
                )

            if createView:
                # Assign each resource to its own variable as it is
                # created, never via a tuple returned from a helper: if
                # the second call raises, a helper's locals are lost and
                # the except-handler below would have nothing to roll the
                # first one back with.
                collection = self._createDefaultCollection(
                    folder, result, tilesMetadata, user,
                )
                datasetView = self._datasetViewModel.create(user, {
                    "datasetId": folder["_id"],
                    "configurationId": collection["_id"],
                    "layerContrasts": {},
                    "lastLocation": {"xy": 0, "z": 0, "time": 0},
                })

            # Everything that defines the dataset now exists, so commit
            # before the last step rather than after it.
            committed = True

            # Clearing the SOURCE items is destructive and NOT undoable:
            # items that autoSet marked before this request are absent from
            # newlyMarked, so the rollback cannot put them back, and for a
            # worker-converted source ImageItem().delete also removes the
            # derived image file. It is also several deletes, so a failure
            # part way through has already destroyed some of them. Treat it
            # as best-effort cleanup AFTER committing: a leftover mark is
            # harmless, whereas unwinding a good dataset over it would turn
            # a success into a 500 and destroy state on the way out.
            try:
                self._removeLargeImages(items)
            except Exception:
                logger.exception(
                    "Could not clear source large images in folder %s; the "
                    "dataset is configured and usable regardless",
                    folder.get("_id"),
                )

            return {
                "itemId": str(newItem["_id"]),
                "jobId": str(job["_id"]) if job is not None else None,
                "collectionId": (
                    str(collection["_id"]) if collection is not None else None
                ),
                "viewId": (
                    str(datasetView["_id"]) if datasetView is not None
                    else None
                ),
                "config": result["config"],
                "dimensionLabels": result["dimensionLabels"],
                "variables": result["variables"],
                "assignments": result["assignments"],
                "transcode": transcode,
                "isRGBFile": result["isRGBFile"],
                "rgbBandCount": result["rgbBandCount"],
                "transcodeDefault": result["transcodeDefault"],
            }
        except Exception:
            # Newest resources first, so a view is never left pointing at a
            # collection that has already been removed.
            if datasetView is not None:
                try:
                    self._datasetViewModel.delete(datasetView)
                except Exception:
                    logger.exception(
                        "Could not remove failed dataset view %s",
                        datasetView.get("_id"),
                    )
            if collection is not None:
                try:
                    self._collectionModel.remove(collection)
                except Exception:
                    logger.exception(
                        "Could not remove failed collection %s",
                        collection.get("_id"),
                    )
            if job is not None:
                try:
                    Job().cancelJob(job)
                except Exception:
                    logger.exception(
                        "Could not cancel failed dataset transcode job %s",
                        job.get("_id"),
                    )
            if newItemId is not None:
                try:
                    # newItem may be None if its load was what failed, so
                    # fall back to the id recorded at upload time.
                    staleItem = newItem or Item().load(
                        newItemId, force=True, exc=False
                    )
                    if staleItem is not None:
                        Item().remove(staleItem)
                except Exception:
                    logger.exception(
                        "Could not remove failed multi-source item %s",
                        newItemId,
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
        # Batch-load the files of each unmarked item (no per-item childFiles
        # queries; see CLAUDE.md on looped DB calls).
        filesByItemId = {}
        for file in File().find(
            {"itemId": {"$in": [item["_id"] for item in unmarked]}}
        ):
            filesByItemId.setdefault(file["itemId"], []).append(file)

        for item in unmarked:
            files = filesByItemId.get(item["_id"], [])
            if not files:
                self._rollbackLargeImages(newlyMarked)
                raise RestException(
                    'Item "%s" has no files and cannot be used as an '
                    "image source." % item["name"],
                    code=400,
                )
            if len(files) > 1:
                # Mirror girder's own POST item/{id}/tiles, which requires an
                # explicit fileId once an item has more than one file rather
                # than guessing. Picking whichever file mongo returned first
                # would be non-deterministic.
                self._rollbackLargeImages(newlyMarked)
                raise RestException(
                    'Item "%s" has %d files; an image source item must have '
                    "exactly one." % (item["name"], len(files)),
                    code=400,
                )
            file = files[0]
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
        """Upload the generated config JSON as a new item in the folder.

        Returns only the file: the caller loads the item itself so the
        created resource's id is in a caller variable before anything else
        that can fail runs.
        """
        configBytes = json.dumps(config).encode("utf-8")
        return Upload().uploadFromFile(
            io.BytesIO(configBytes), len(configBytes),
            MULTI_SOURCE_ITEM_NAME, "folder", folder, user=user,
            mimeType="application/json",
        )

    @staticmethod
    def _assignedSize(assignments, dim):
        """The dataset's extent along ``dim``; 1 when nothing is assigned."""
        assignment = assignments.get(dim)
        return assignment["size"] if assignment else 1

    def _createDefaultCollection(self, folder, result, tilesMetadata, user):
        """Create the collection (configuration) for a configured dataset.

        Paired with a dataset view by the caller. Without the two of them
        the dataset is readable but effectively hidden: the UI has nothing
        to open, and dataset listings enumerate views, so an API-created
        one would not appear anywhere. The frontend does this on the
        "Select a collection" step; the configuration content is the port
        in ``helpers/default_configuration.py``.
        """
        assignments = result["assignments"]
        firstTile = tilesMetadata[0] if tilesMetadata else {}

        # Compositing lays the sources out by stage position and forces
        # every xySet to 0, so the configured image has ONE xy position no
        # matter how big the XY assignment was. Recording the assignment
        # size here would make areCompatibles() report the collection as
        # incompatible with the dataset it was just created for.
        xyCount = 1 if result["compositing"] else self._assignedSize(
            assignments, "XY",
        )

        metadata = build_default_configuration(
            # Post-RGB-expansion channel names, so the layers match what
            # the configured image actually exposes.
            result["config"]["channels"],
            xy_count=xyCount,
            z_count=self._assignedSize(assignments, "Z"),
            t_count=self._assignedSize(assignments, "T"),
            mm_x=firstTile.get("mm_x"),
            mm_y=firstTile.get("mm_y"),
            dimension_labels=result["dimensionLabels"],
            # The UI threads the configuring user's saved palette into
            # newLayer; without it an API-created collection silently
            # ignores their colours.
            user_colors=self._userColorsModel.getUserColors(user),
        )
        return self._collectionModel.createCollection(
            folder["name"], user, folder, metadata,
            description="Created with the dataset",
        )

    def _removeLargeImages(self, items):
        """Clear the largeImage marking from the source items.

        Mirrors the frontend, which stops treating the individual files as
        images once they are only inputs to the combined one. The
        configuration item is not in ``items`` and keeps its own mark --
        that mark is what makes the dataset readable.
        """
        for item in items:
            if "largeImage" in item:
                self._imageItemModel.delete(item)

"""Dataset — central object for accessing one NimbusImage dataset."""

from __future__ import annotations

import os
from typing import TYPE_CHECKING

from nimbusimage.annotations import AnnotationAccessor
from nimbusimage.collections import CollectionAccessor
from nimbusimage.connections import ConnectionAccessor
from nimbusimage.export import ExportAccessor
from nimbusimage.history import HistoryAccessor
from nimbusimage.images import ImageAccessor
from nimbusimage.models import (
    FrameInfo,
    MultiSourceConfiguration,
    PixelSize,
)
from nimbusimage.properties import PropertyAccessor
from nimbusimage.sharing import SharingAccessor
from nimbusimage.urls import (
    DEFAULT_FRONTEND_URL,
    dataset_info_url,
    dataset_view_url,
    configuration_url,
    open_url,
)

if TYPE_CHECKING:
    import girder_client


class Dataset:
    """Access point for a single NimbusImage dataset.

    Metadata is fetched lazily on first access to any property.
    """

    def __init__(
        self,
        gc: girder_client.GirderClient,
        dataset_id: str,
        frontend_url: str = DEFAULT_FRONTEND_URL,
    ):
        self._gc = gc
        self._id = dataset_id
        self._frontend_url = frontend_url
        self._tiles: dict | None = None
        self._item_id: str | None = None
        self._folder_data: dict | None = None

        # Create accessor sub-objects
        self.images = ImageAccessor(self)
        self.annotations = AnnotationAccessor(gc, dataset_id)
        self.connections = ConnectionAccessor(gc, dataset_id)
        self.properties = PropertyAccessor(gc, dataset_id)
        self.collections = CollectionAccessor(
            gc, dataset_id, frontend_url=frontend_url,
        )
        self.export = ExportAccessor(gc, dataset_id)
        self.history = HistoryAccessor(gc, dataset_id)
        self.sharing = SharingAccessor(gc, dataset_id)

    def _ensure_metadata(self):
        """Fetch and cache metadata if not already loaded."""
        if self._tiles is not None:
            return

        # Get folder info
        self._folder_data = self._gc.get(f"folder/{self._id}")

        # Find the large image item in this folder
        selected_id = self._folder_data.get("meta", {}).get(
            "selectedLargeImageId"
        )
        if selected_id:
            # Fast path: fetch the specific item directly
            item = self._gc.get(f"item/{selected_id}")
        else:
            # Fallback: scan items for one with largeImage metadata
            items = self._gc.get(
                "item", parameters={"folderId": self._id, "limit": 0}
            )
            item = next(
                (i for i in items if "largeImage" in i), None
            )

        if item is None:
            raise ValueError(
                f"No large image found in dataset {self._id}"
            )

        self._item_id = item["_id"]

        # Fetch tiles metadata
        self._tiles = self._gc.get(f"item/{self._item_id}/tiles")

    @property
    def id(self) -> str:
        return self._id

    @property
    def name(self) -> str:
        self._ensure_metadata()
        return self._folder_data["name"]

    @property
    def num_channels(self) -> int:
        self._ensure_metadata()
        return self._tiles.get("IndexRange", {}).get("IndexC", 1)

    @property
    def num_z(self) -> int:
        self._ensure_metadata()
        return self._tiles.get("IndexRange", {}).get("IndexZ", 1)

    @property
    def num_time(self) -> int:
        self._ensure_metadata()
        return self._tiles.get("IndexRange", {}).get("IndexT", 1)

    @property
    def num_xy(self) -> int:
        self._ensure_metadata()
        return self._tiles.get("IndexRange", {}).get("IndexXY", 1)

    @property
    def channels(self) -> list[str]:
        self._ensure_metadata()
        return self._tiles.get("channels", [])

    @property
    def pixel_size(self) -> PixelSize:
        self._ensure_metadata()
        mm_x = self._tiles.get("mm_x")
        if mm_x is not None:
            return PixelSize(value=mm_x, unit="mm")
        return PixelSize(value=1.0, unit="um")

    @property
    def shape(self) -> tuple[int, int]:
        self._ensure_metadata()
        return (self._tiles["sizeY"], self._tiles["sizeX"])

    @property
    def dtype(self) -> str:
        self._ensure_metadata()
        return self._tiles.get("dtype", "uint8")

    @property
    def mm_x(self) -> float | None:
        self._ensure_metadata()
        return self._tiles.get("mm_x")

    @property
    def mm_y(self) -> float | None:
        self._ensure_metadata()
        return self._tiles.get("mm_y")

    @property
    def magnification(self) -> float | None:
        self._ensure_metadata()
        return self._tiles.get("magnification")

    @property
    def frames(self) -> list[FrameInfo]:
        self._ensure_metadata()
        result = []
        channels = self._tiles.get("channels", [])
        for f in self._tiles.get("frames", []):
            ch_idx = f.get("IndexC", 0)
            result.append(FrameInfo(
                index=f["Frame"],
                xy=f.get("IndexXY", 0),
                z=f.get("IndexZ", 0),
                time=f.get("IndexT", 0),
                channel=ch_idx,
                channel_name=(
                    channels[ch_idx] if ch_idx < len(channels) else None
                ),
            ))
        return result

    # --- Building a dataset from image files ---

    def upload(self, paths) -> list[str]:
        """Upload image files into this dataset's folder.

        Call before :meth:`configure`. Uploading does not by itself make a
        usable dataset -- the files are just items in a folder until they
        are configured into a multi-source image.

        Args:
            paths: A file path, a directory, or an iterable of paths.
                Directories are not recursed into; a subdirectory raises
                rather than being skipped, so a partial upload can't look
                like a complete one. Dotfiles are ignored.

        Returns:
            The ids of the created items, ordered as uploaded.

        Raises:
            ValueError: a directory contains a subdirectory.
            RuntimeError: an upload failed AND the files already uploaded
                by this call could not be removed again (the message names
                them). Any other upload failure propagates unchanged, with
                the folder left as it was found.
        """
        if isinstance(paths, (str, os.PathLike)):
            paths = [paths]
        expanded: list[str] = []
        for path in paths:
            path = os.fspath(path)
            if os.path.isdir(path):
                entries = [
                    entry for entry in sorted(os.listdir(path))
                    if not entry.startswith(".")
                ]
                subdirs = [
                    entry for entry in entries
                    if os.path.isdir(os.path.join(path, entry))
                ]
                if subdirs:
                    raise ValueError(
                        "%s contains subdirectories (%s); upload is not "
                        "recursive. Pass the image files or the leaf "
                        "directories explicitly." % (
                            path, ", ".join(subdirs))
                    )
                expanded.extend(os.path.join(path, e) for e in entries)
            else:
                expanded.append(path)

        item_ids: list[str] = []
        try:
            for path in expanded:
                file = self._gc.uploadFileToFolder(self._id, path)
                item_ids.append(file["itemId"])
        except Exception as exc:
            # Leaving the earlier files behind is worse than removing them:
            # retrying the same directory uploads them a second time, girder
            # renames the duplicates, and configure() then sees two sources
            # per image and infers the wrong dimensions. Put the folder back
            # the way it was found so a retry is a retry.
            undeleted = []
            for item_id in item_ids:
                try:
                    self._gc.delete("item/%s" % item_id)
                except Exception:
                    undeleted.append(item_id)
            self._invalidate_cache()
            if undeleted:
                raise RuntimeError(
                    "Upload failed, and these already-uploaded items could "
                    "not be removed: %s. Delete them before retrying, or "
                    "configure() will see duplicate sources."
                    % ", ".join(undeleted)
                ) from exc
            raise
        # Items changed, so any cached tile metadata is stale.
        self._invalidate_cache()
        return item_ids

    def configure(
        self,
        *,
        assignments: dict | None = None,
        transcode: bool | None = None,
        split_rgb_bands: bool = True,
        enable_compositing: bool = False,
        create_view: bool = True,
        dry_run: bool = False,
    ) -> MultiSourceConfiguration:
        """Configure the uploaded files as one multi-dimensional image.

        This is the API equivalent of the web UI's dataset-configuration
        screen: it works out which filename tokens and file metadata map to
        XY / Z / Time / Channel, writes the multi-source configuration, and
        (unless every file is ``.nd2``) schedules a transcode job.

        **Start with ``dry_run=True``.** It computes and returns everything
        without writing, including ``validation_error`` and ``variables``.
        A real run turns that error into an exception, so the dry run is the
        only way to see the variable list you need in order to fix it::

            plan = ds.configure(dry_run=True)
            if not plan.is_valid:
                print(plan.validation_error)
                print(plan.unassigned_variables)

        Args:
            assignments: Per-dimension overrides, ``{dim: {"source",
                "guess"} | None}`` for dims ``XY``/``Z``/``T``/``C``. Copy
                ``source``/``guess`` from a variable returned by a dry run;
                ``None`` leaves a dimension unassigned, and omitted
                dimensions keep their default.
            transcode: Convert to a single tiled TIFF. Defaults to the
                same rule the UI uses (on unless every file is ``.nd2``).
            split_rgb_bands: Split an RGB image into three channels.
            enable_compositing: Lay out a single multi-position ND2 by
                stage coordinates instead of as separate XY positions. Only
                takes effect for a single source with ND2 frame metadata --
                check ``result.compositing`` for what actually happened,
                and note that when it applies, XY collapses to one
                position.
            create_view: Also create the collection and dataset view the
                web UI needs. On by default: without them the dataset is
                readable through this API but has nothing to open in the
                browser, and ``client.list_datasets()`` -- which
                enumerates dataset views -- will not show it.
            dry_run: Compute without writing anything.

        Returns:
            MultiSourceConfiguration. When transcoding, ``job_id`` is the
            conversion job -- pass it to ``client.job(...)`` to wait on it.
            With ``create_view``, ``view_id`` is set and ``ds.open()``
            works.

        Raises:
            girder_client.HttpError: 400 if the configuration is invalid
                (unassigned variables, mixed pixel types across sources, an
                item with zero or several files, or filenames whose parts do
                not line up -- the web UI cannot configure that folder
                either), 409 if the dataset is already configured.

        Note:
            Unlike the web UI, this does not warm the tile/histogram
            caches, so the first open of a large dataset is slower.

            When ``transcode`` is on this returns as soon as the job is
            queued, so checking it is the caller's job::

                result = ds.configure()
                if result.job_id and not client.job(result.job_id).wait():
                    ...  # the dataset is configured but its image is broken

            A failed transcode leaves the dataset configured with an
            unusable image, and configuring again raises 409 because the
            configuration item exists. Recovering means deleting that item
            (``result.item_id``) or starting from a new dataset.
        """
        body: dict = {
            "splitRGBBands": split_rgb_bands,
            "enableCompositing": enable_compositing,
            "createView": create_view,
            "dryRun": dry_run,
        }
        if assignments is not None:
            body["assignments"] = assignments
        if transcode is not None:
            body["transcode"] = transcode

        result = self._gc.post(
            f"dataset/{self._id}/multi_source", json=body
        )
        if not dry_run:
            self._invalidate_cache()
        return MultiSourceConfiguration(**result)

    def _invalidate_cache(self) -> None:
        """Drop the lazily-fetched metadata after the folder changes."""
        self._tiles = None
        self._item_id = None
        self._folder_data = None

    # --- URLs ---

    def _get_view_id(self) -> str | None:
        """Get the first dataset view ID for this dataset."""
        views = self.collections.list_views()
        if views:
            return views[0].get("_id")
        return None

    def _get_config_id(self) -> str | None:
        """Get the first configuration ID for this dataset."""
        views = self.collections.list_views()
        if views:
            return views[0].get("configurationId")
        return None

    def info_url(self) -> str:
        """URL for the dataset info page."""
        return dataset_info_url(self._id, self._frontend_url)

    def view_url(
        self,
        xy: int | None = None,
        z: int | None = None,
        time: int | None = None,
        layer: str | None = None,
        unroll_xy: bool | None = None,
        unroll_z: bool | None = None,
        unroll_t: bool | None = None,
    ) -> str:
        """URL for the dataset image viewer.

        Args:
            xy: XY position to navigate to.
            z: Z-slice to navigate to.
            time: Time point to navigate to.
            layer: Layer mode ('single', 'multiple', 'unroll').
            unroll_xy: Unroll XY dimension.
            unroll_z: Unroll Z dimension.
            unroll_t: Unroll time dimension.

        Returns:
            URL string for the image viewer.

        Raises:
            ValueError: If no dataset view exists for this dataset.
        """
        view_id = self._get_view_id()
        if view_id is None:
            raise ValueError(
                f"No dataset view found for dataset {self._id}"
            )
        return dataset_view_url(
            view_id, self._frontend_url,
            xy=xy, z=z, time=time, layer=layer,
            unroll_xy=unroll_xy, unroll_z=unroll_z, unroll_t=unroll_t,
        )

    def configuration_url(self) -> str:
        """URL for this dataset's configuration page."""
        config_id = self._get_config_id()
        if config_id is None:
            raise ValueError(
                f"No configuration found for dataset {self._id}"
            )
        return configuration_url(config_id, self._frontend_url)

    def open(
        self,
        xy: int | None = None,
        z: int | None = None,
        time: int | None = None,
        **kwargs,
    ) -> str:
        """Open the dataset viewer in the default browser.

        Args:
            xy, z, time: Navigate to this position.
            **kwargs: Additional args passed to view_url().

        Returns:
            The URL that was opened.
        """
        url = self.view_url(xy=xy, z=z, time=time, **kwargs)
        open_url(url)
        return url

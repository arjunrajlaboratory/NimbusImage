"""Dataset — central object for accessing one NimbusImage dataset."""

from __future__ import annotations

from typing import TYPE_CHECKING

from nimbusimage.annotations import AnnotationAccessor
from nimbusimage.config import ConfigAccessor
from nimbusimage.connections import ConnectionAccessor
from nimbusimage.export import ExportAccessor
from nimbusimage.history import HistoryAccessor
from nimbusimage.images import ImageAccessor
from nimbusimage.models import FrameInfo, PixelSize
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
        self._metadata: dict | None = None
        self._tiles: dict | None = None
        self._item_id: str | None = None
        self._folder_data: dict | None = None

        # Create accessor sub-objects
        self.images = ImageAccessor(self)
        self.annotations = AnnotationAccessor(gc, dataset_id)
        self.connections = ConnectionAccessor(gc, dataset_id)
        self.properties = PropertyAccessor(gc, dataset_id)
        self.config = ConfigAccessor(gc, dataset_id)
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
        items = self._gc.get(
            f"item", parameters={"folderId": self._id, "limit": 0}
        )
        selected_id = self._folder_data.get("meta", {}).get(
            "selectedLargeImageId"
        )
        if selected_id:
            item = next(
                (i for i in items if i["_id"] == selected_id), None
            )
        else:
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

    # --- URLs ---

    def _get_view_id(self) -> str | None:
        """Get the first dataset view ID for this dataset."""
        views = self.config.list_views()
        if views:
            return views[0].get("_id")
        return None

    def _get_config_id(self) -> str | None:
        """Get the first configuration ID for this dataset."""
        views = self.config.list_views()
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

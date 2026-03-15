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

if TYPE_CHECKING:
    import girder_client


class Dataset:
    """Access point for a single NimbusImage dataset.

    Metadata is fetched lazily on first access to any property.
    """

    def __init__(self, gc: girder_client.GirderClient, dataset_id: str):
        self._gc = gc
        self._id = dataset_id
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

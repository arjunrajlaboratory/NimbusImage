"""Collection — a saved configuration with layers, tools, and properties.

In NimbusImage, "collections" and "configurations" are the same thing.
The backend endpoint is /upenn_collection. The UI calls them "collections".
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from nimbusimage.urls import DEFAULT_FRONTEND_URL, configuration_url, open_url

if TYPE_CHECKING:
    import girder_client


class Collection:
    """A NimbusImage collection (configuration).

    Contains layer settings, tool definitions, property registrations,
    snapshots, and scales for a dataset view.
    """

    def __init__(
        self,
        gc: girder_client.GirderClient,
        data: dict,
        frontend_url: str = DEFAULT_FRONTEND_URL,
    ):
        self._gc = gc
        self._data = data
        self._frontend_url = frontend_url

    @property
    def id(self) -> str:
        return self._data["_id"]

    @property
    def name(self) -> str:
        return self._data.get("name", "")

    @property
    def folder_id(self) -> str:
        """The parent folder ID this collection belongs to."""
        return self._data.get("folderId", "")

    @property
    def layers(self) -> list[dict]:
        """Layer settings (channel, color, contrast, visibility)."""
        return self._data.get("meta", {}).get("layers", [])

    @property
    def tools(self) -> list[dict]:
        """Tool definitions."""
        return self._data.get("meta", {}).get("tools", [])

    @property
    def property_ids(self) -> list[str]:
        """Registered property IDs."""
        return self._data.get("meta", {}).get("propertyIds", [])

    @property
    def snapshots(self) -> list[dict]:
        """Saved view snapshots."""
        return self._data.get("meta", {}).get("snapshots", [])

    @property
    def scales(self) -> dict:
        """Scale settings (pixel size, z step, time step)."""
        return self._data.get("meta", {}).get("scales", {})

    # --- URLs ---

    def url(self) -> str:
        """URL for the collection/configuration page."""
        return configuration_url(self.id, self._frontend_url)

    def open(self) -> str:
        """Open the collection page in the default browser."""
        url = self.url()
        open_url(url)
        return url

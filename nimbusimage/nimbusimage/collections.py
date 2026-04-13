"""Collection — a saved configuration with layers, tools, and properties.

In NimbusImage, "collections" and "configurations" are the same thing.
The backend endpoint is /upenn_collection. The UI calls them "collections".
A dataset_view links a dataset to a collection. Datasets and collections
have a many-to-many relationship.
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


class CollectionAccessor:
    """Access collections for a specific dataset.

    This accessor finds collections via dataset_views, which link
    datasets to collections.
    """

    def __init__(
        self,
        gc: girder_client.GirderClient,
        dataset_id: str,
        frontend_url: str = DEFAULT_FRONTEND_URL,
    ):
        self._gc = gc
        self._dataset_id = dataset_id
        self._frontend_url = frontend_url
        self._cache: dict | None = None

    def list_views(self) -> list[dict]:
        """List dataset views for this dataset.

        Each view links this dataset to a collection and stores
        per-user view state (last location, contrast overrides, etc.).
        """
        return self._gc.get(
            f"dataset_view?datasetId={self._dataset_id}"
        )

    def get(self, collection_id: str | None = None) -> Collection | None:
        """Get a collection for this dataset.

        Args:
            collection_id: Specific collection ID. If None, returns
                the collection from the first dataset view.

        Returns:
            Collection object, or None if no views/collections exist.
        """
        if collection_id is None:
            views = self.list_views()
            if not views:
                return None
            collection_id = views[0].get("configurationId")
            if not collection_id:
                return None
        data = self._gc.get(f"upenn_collection/{collection_id}")
        return Collection(self._gc, data, frontend_url=self._frontend_url)

    def list(self) -> list[Collection]:
        """List all collections linked to this dataset via views.

        Note:
            Makes one HTTP call per unique collection. No batch-by-IDs
            endpoint exists yet on the server.
        """
        views = self.list_views()
        seen = set()
        collections = []
        for v in views:
            cid = v.get("configurationId")
            if cid and cid not in seen:
                seen.add(cid)
                data = self._gc.get(f"upenn_collection/{cid}")
                collections.append(
                    Collection(self._gc, data, frontend_url=self._frontend_url)
                )
        return collections

    def get_raw(self, collection_id: str | None = None) -> dict:
        """Get a collection as a raw dict.

        Args:
            collection_id: Specific collection ID. If None, returns
                the first collection for this dataset.

        Returns:
            Raw collection dict, or empty dict if none exist.
        """
        if collection_id is None:
            views = self.list_views()
            if not views:
                return {}
            collection_id = views[0].get("configurationId")
            if not collection_id:
                return {}
        return self._gc.get(f"upenn_collection/{collection_id}")

    def _ensure_cached(self):
        if self._cache is None:
            self._cache = self.get_raw()

    def refresh(self) -> None:
        """Clear cached collection. Next access will re-fetch from server."""
        self._cache = None

    @property
    def layers(self) -> list[dict]:
        """Layer settings from the first collection.

        Used by ImageAccessor.get_composite() for contrast and color.
        """
        self._ensure_cached()
        return self._cache.get("meta", {}).get("layers", [])

    @property
    def property_ids(self) -> list[str]:
        """Property IDs registered in the first collection."""
        self._ensure_cached()
        return self._cache.get("meta", {}).get("propertyIds", [])

"""ConfigAccessor — dataset views and collections (configurations).

In NimbusImage, "collections" and "configurations" are the same thing.
The backend endpoint is /upenn_collection. A dataset_view links a
dataset to a collection. Datasets and collections have a many-to-many
relationship — one dataset can have multiple collections, and one
collection can be used with multiple datasets.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from nimbusimage.collections import Collection

if TYPE_CHECKING:
    import girder_client


class ConfigAccessor:
    """Access collections (configurations) for a specific dataset.

    This accessor finds collections via dataset_views, which link
    datasets to collections.
    """

    def __init__(self, gc: girder_client.GirderClient, dataset_id: str):
        self._gc = gc
        self._dataset_id = dataset_id
        self._config_cache: dict | None = None

    def list_views(self) -> list[dict]:
        """List dataset views for this dataset.

        Each view links this dataset to a collection and stores
        per-user view state (last location, contrast overrides, etc.).
        """
        return self._gc.get(
            f"/dataset_view?datasetId={self._dataset_id}"
        )

    def get_collection(self, collection_id: str | None = None) -> Collection | None:
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
        data = self._gc.get(f"/upenn_collection/{collection_id}")
        return Collection(self._gc, data)

    def list_collections(self) -> list[Collection]:
        """List all collections linked to this dataset via views."""
        views = self.list_views()
        seen = set()
        collections = []
        for v in views:
            cid = v.get("configurationId")
            if cid and cid not in seen:
                seen.add(cid)
                data = self._gc.get(f"/upenn_collection/{cid}")
                collections.append(Collection(self._gc, data))
        return collections

    # Keep get_configuration as an alias for backwards compatibility
    def get_configuration(self, config_id: str | None = None) -> dict:
        """Get a configuration dict. Alias for get_collection().

        Returns raw dict for backwards compatibility with code that
        accesses config['meta']['layers'] directly.
        """
        if config_id is None:
            views = self.list_views()
            if not views:
                return {}
            config_id = views[0].get("configurationId")
            if not config_id:
                return {}
        return self._gc.get(f"/upenn_collection/{config_id}")

    def _ensure_config(self):
        if self._config_cache is None:
            self._config_cache = self.get_configuration()

    @property
    def layers(self) -> list[dict]:
        """Layer settings from the first collection.

        Used by ImageAccessor.get_composite() for contrast and color.
        """
        self._ensure_config()
        return self._config_cache.get("meta", {}).get("layers", [])

    @property
    def property_ids(self) -> list[str]:
        """Property IDs registered in the first collection."""
        self._ensure_config()
        return self._config_cache.get("meta", {}).get("propertyIds", [])

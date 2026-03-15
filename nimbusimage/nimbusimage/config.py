"""ConfigAccessor — dataset views and configurations."""

from __future__ import annotations
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import girder_client


class ConfigAccessor:
    def __init__(self, gc: girder_client.GirderClient, dataset_id: str):
        self._gc = gc
        self._dataset_id = dataset_id
        self._config_cache: dict | None = None

    def list_views(self) -> list[dict]:
        """List dataset views for this dataset."""
        return self._gc.get(
            f"/dataset_view?datasetId={self._dataset_id}"
        )

    def get_configuration(self, config_id: str | None = None) -> dict:
        """Get a configuration. If config_id is None, gets the first one."""
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
        """Layer settings from the first configuration."""
        self._ensure_config()
        return self._config_cache.get("meta", {}).get("layers", [])

    @property
    def property_ids(self) -> list[str]:
        """Property IDs registered in the first configuration."""
        self._ensure_config()
        return self._config_cache.get("meta", {}).get("propertyIds", [])

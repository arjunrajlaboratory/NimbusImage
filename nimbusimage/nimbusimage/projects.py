"""Project — grouping datasets and configurations."""

from __future__ import annotations
from typing import TYPE_CHECKING

from nimbusimage.urls import DEFAULT_FRONTEND_URL, project_url, open_url

if TYPE_CHECKING:
    import girder_client

_ACCESS_MAP = {"read": 0, "write": 1, "remove": -1}


class Project:
    """A NimbusImage project."""

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
    def status(self) -> str:
        return self._data.get("meta", {}).get("status", "draft")

    @property
    def description(self) -> str:
        return self._data.get("description", "")

    @property
    def dataset_ids(self) -> list[str]:
        """List of dataset IDs in this project."""
        entries = self._data.get("meta", {}).get("datasets", [])
        return [e["datasetId"] for e in entries]

    @property
    def configuration_ids(self) -> list[str]:
        """List of configuration (collection) IDs in this project."""
        entries = self._data.get("meta", {}).get("collections", [])
        return [e["collectionId"] for e in entries]

    @property
    def publication_metadata(self) -> dict:
        """Publication metadata (title, keywords, license, etc.)."""
        return self._data.get("meta", {}).get("metadata", {})

    @property
    def zenodo(self) -> dict | None:
        """Zenodo publication info, if any."""
        return self._data.get("meta", {}).get("zenodo")

    def add_dataset(self, dataset_id: str) -> None:
        self._gc.post(
            f"project/{self.id}/dataset",
            json={"datasetId": dataset_id},
        )

    def remove_dataset(self, dataset_id: str) -> None:
        self._gc.delete(f"project/{self.id}/dataset/{dataset_id}")

    def add_configuration(self, config_id: str) -> None:
        self._gc.post(
            f"project/{self.id}/collection",
            json={"collectionId": config_id},
        )

    def remove_configuration(self, config_id: str) -> None:
        self._gc.delete(f"project/{self.id}/collection/{config_id}")

    def update(
        self, name: str | None = None, description: str | None = None
    ) -> None:
        params = {}
        if name is not None:
            params["name"] = name
        if description is not None:
            params["description"] = description
        self._data = self._gc.put(
            f"project/{self.id}", parameters=params
        )

    def set_status(self, status: str) -> None:
        self._gc.put(
            f"project/{self.id}/status",
            json={"status": status},
        )

    def update_metadata(self, metadata: dict) -> None:
        self._gc.put(
            f"project/{self.id}/metadata", json=metadata
        )

    def share(
        self, user_email_or_name: str, access: str = "read"
    ) -> None:
        self._gc.post(
            f"project/{self.id}/share",
            json={
                "userMailOrUsername": user_email_or_name,
                "accessType": _ACCESS_MAP[access],
            },
        )

    def set_public(self, public: bool = True) -> None:
        self._gc.post(
            f"project/{self.id}/set_public",
            json={"public": public},
        )

    def get_access(self) -> dict:
        return self._gc.get(f"project/{self.id}/access")

    def delete(self) -> None:
        self._gc.delete(f"project/{self.id}")

    # --- URLs ---

    def url(self) -> str:
        """URL for the project info page."""
        return project_url(self.id, self._frontend_url)

    def open(self) -> str:
        """Open the project page in the default browser.

        Returns:
            The URL that was opened.
        """
        url = self.url()
        open_url(url)
        return url

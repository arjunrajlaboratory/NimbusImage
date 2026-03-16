"""NimbusClient — authenticated entry point for the NimbusImage API."""

from __future__ import annotations

import os
from typing import Any

from nimbusimage._girder import create_client
from nimbusimage.collections import Collection
from nimbusimage.dataset import Dataset
from nimbusimage.projects import Project
from nimbusimage.urls import DEFAULT_FRONTEND_URL


class NimbusClient:
    """Authenticated session to a NimbusImage server.

    Create via ni.connect():
        client = ni.connect(api_url, token=...)
        client = ni.connect(api_url, username=..., password=...)
        client = ni.connect()  # from NI_API_URL + NI_TOKEN env vars
    """

    def __init__(
        self,
        api_url: str | None = None,
        token: str | None = None,
        username: str | None = None,
        password: str | None = None,
        frontend_url: str = DEFAULT_FRONTEND_URL,
    ):
        # Resolve api_url from env if not provided (mirrors _girder.create_client)
        resolved_url = api_url or os.environ.get("NI_API_URL")
        self._gc = create_client(
            api_url=api_url,
            token=token,
            username=username,
            password=password,
        )
        self._api_url = resolved_url or self._gc.getServerApiUrl()
        self._frontend_url = os.environ.get("NI_FRONTEND_URL", frontend_url)

    @property
    def api_url(self) -> str:
        return self._api_url

    @property
    def token(self) -> str:
        return self._gc.token

    @property
    def user_id(self) -> str:
        me = self._gc.get("user/me")
        return me["_id"]

    @property
    def frontend_url(self) -> str:
        return self._frontend_url

    @property
    def girder(self):
        """Raw girder_client.GirderClient escape hatch."""
        return self._gc

    # --- Datasets ---

    def dataset(
        self, dataset_id: str | None = None, *, name: str | None = None
    ) -> Dataset:
        """Get a Dataset object.

        Args:
            dataset_id: The folder ID of the dataset.
            name: Look up dataset by name (searches all accessible folders).

        Returns:
            Dataset object (lazy — no HTTP call until data is accessed).
        """
        if dataset_id is not None:
            return Dataset(self._gc, dataset_id, frontend_url=self._frontend_url)
        if name is not None:
            folders = self._gc.get(
                "resource/search",
                parameters={"q": name, "mode": "prefix", "types": '["folder"]'},
            )
            # Handle both list response and dict-with-folder-key response
            if isinstance(folders, dict):
                folders = folders.get("folder", [])
            for f in folders:
                if f.get("name") == name:
                    return Dataset(self._gc, f["_id"], frontend_url=self._frontend_url)
            raise ValueError(f"Dataset with name '{name}' not found")
        raise ValueError("Provide either dataset_id or name=")

    def list_datasets(self) -> list[dict]:
        """List all accessible datasets.

        Returns:
            List of dataset info dicts with _id, name, meta.
        """
        result = self._gc.get(
            "resource/search",
            parameters={
                "q": "contrastDataset",
                "mode": "prefix",
                "types": '["folder"]',
            },
        )
        # Handle both list response and dict-with-folder-key response
        if isinstance(result, dict):
            return result.get("folder", [])
        return result

    # --- Projects ---

    def list_projects(self) -> list[dict]:
        """List all accessible projects."""
        return self._gc.get("project")

    def create_project(
        self, name: str, description: str = ""
    ) -> Project:
        """Create a new project."""
        data = self._gc.post(
            "project",
            parameters={"name": name, "description": description},
        )
        return Project(self._gc, data, frontend_url=self._frontend_url)

    def project(self, project_id: str) -> Project:
        """Get a Project by ID."""
        data = self._gc.get(f"project/{project_id}")
        return Project(self._gc, data, frontend_url=self._frontend_url)

    # --- Collections (aka Configurations) ---

    def list_collections(self, folder_id: str | None = None) -> list[Collection]:
        """List collections (configurations).

        In NimbusImage, "collections" and "configurations" are the same
        thing. The backend uses /upenn_collection endpoints. The UI
        calls them "collections".

        Args:
            folder_id: Filter by parent folder. If None, lists collections
                in the current user's Private folder.

        Returns:
            List of Collection objects.
        """
        if folder_id is None:
            me = self._gc.get("user/me")
            folders = self._gc.get(
                "folder",
                parameters={
                    "parentType": "user",
                    "parentId": me["_id"],
                    "name": "Private",
                },
            )
            if folders:
                folder_id = folders[0]["_id"]
            else:
                return []

        data = self._gc.get(
            f"/upenn_collection?folderId={folder_id}"
        )
        return [
            Collection(self._gc, d, frontend_url=self._frontend_url)
            for d in data
        ]

    def collection(self, collection_id: str) -> Collection:
        """Get a Collection (configuration) by ID."""
        data = self._gc.get(f"/upenn_collection/{collection_id}")
        return Collection(self._gc, data, frontend_url=self._frontend_url)

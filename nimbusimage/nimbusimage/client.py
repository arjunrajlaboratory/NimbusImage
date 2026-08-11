"""NimbusClient — authenticated entry point for the NimbusImage API."""

from __future__ import annotations

import json
import os

from nimbusimage._girder import create_client
from nimbusimage.collections import Collection
from nimbusimage.dataset import Dataset
from nimbusimage.jobs import Job
from nimbusimage.projects import Project
from nimbusimage.urls import DEFAULT_FRONTEND_URL


class NimbusClient:
    """Authenticated session to a NimbusImage server.

    Create via ni.connect():
        client = ni.connect(api_url, token=...)
        client = ni.connect(api_url, username=..., password=...)
        client = ni.connect()  # from NI_API_URL + NI_TOKEN env vars
        client = ni.connect(api_url, anonymous=True)  # public data only
    """

    def __init__(
        self,
        api_url: str | None = None,
        token: str | None = None,
        api_key: str | None = None,
        username: str | None = None,
        password: str | None = None,
        frontend_url: str = DEFAULT_FRONTEND_URL,
        anonymous: bool = False,
    ):
        self._gc = create_client(
            api_url=api_url,
            token=token,
            api_key=api_key,
            username=username,
            password=password,
            anonymous=anonymous,
        )
        self._api_url = api_url or os.environ.get(
            "NI_API_URL", self._gc.urlBase
        )
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
            return Dataset(
                self._gc, dataset_id,
                frontend_url=self._frontend_url,
            )
        if name is not None:
            folders = self._gc.get(
                "resource/search",
                parameters={
                    "q": name, "mode": "prefix",
                    "types": '["folder"]',
                },
            )
            # Handle both list response and dict-with-folder-key response
            if isinstance(folders, dict):
                folders = folders.get("folder", [])
            for f in folders:
                if f.get("name") == name:
                    return Dataset(
                        self._gc, f["_id"],
                        frontend_url=self._frontend_url,
                    )
            raise ValueError(f"Dataset with name '{name}' not found")
        raise ValueError("Provide either dataset_id or name=")

    def create_dataset(
        self,
        name: str,
        *,
        description: str = "",
        parent_folder_id: str | None = None,
    ) -> Dataset:
        """Create an empty dataset, ready for image files.

        A dataset is not usable until files are uploaded into it and
        configured, so this is normally step one of three::

            ds = client.create_dataset("My Experiment")
            ds.upload("path/to/images/")
            ds.configure()

        Args:
            name: Dataset name.
            description: Optional description.
            parent_folder_id: Folder to create it in. Defaults to the
                calling user's Private folder, so a new dataset is not
                world-readable by accident; use ``ds.sharing`` to share it.

        Returns:
            Dataset with no image data yet. Its metadata properties
            (``shape``, ``channels``, ...) raise until it is configured.
        """
        if parent_folder_id is None:
            parent_folder_id = self._private_folder_id()

        folder = self._gc.post(
            "folder",
            parameters={
                "parentType": "folder",
                "parentId": parent_folder_id,
                "name": name,
                "description": description,
                "reuseExisting": "false",
                "metadata": json.dumps({
                    "subtype": "contrastDataset",
                    "selectedLargeImageId": None,
                }),
            },
        )
        return Dataset(
            self._gc, folder["_id"], frontend_url=self._frontend_url,
        )

    def _private_folder_id(self) -> str:
        """The calling user's Private folder id."""
        folders = self._gc.get(
            "folder",
            parameters={
                "parentType": "user", "parentId": self.user_id, "limit": 0,
            },
        )
        for folder in folders:
            if folder.get("name") == "Private":
                return folder["_id"]
        raise ValueError(
            "No Private folder found for the current user; pass "
            "parent_folder_id= explicitly."
        )

    def list_datasets(self) -> list[dict]:
        """List all accessible datasets.

        Discovers datasets via dataset_views, which link datasets
        to collections. Each unique dataset folder is returned once.

        Returns:
            List of dataset folder dicts with _id, name, meta.
        """
        views = self._gc.get("/dataset_view", parameters={"limit": 0})
        seen: set[str] = set()
        datasets: list[dict] = []
        for v in views:
            did = v.get("datasetId")
            if did and did not in seen:
                seen.add(did)
                try:
                    folder = self._gc.get(f"folder/{did}")
                    datasets.append(folder)
                except Exception:
                    pass
        return datasets

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

    def list_collections(
        self, folder_id: str | None = None,
    ) -> list[Collection]:
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

    # --- Workers ---

    def list_workers(self) -> dict[str, dict]:
        """List available worker Docker images on the server.

        Returns:
            Dict mapping image name (e.g., ``'myworker:latest'``)
            to a dict of Docker labels:

            - ``isAnnotationWorker``: ``'true'`` if it creates annotations
            - ``isPropertyWorker``: ``'true'`` if it computes properties
            - ``interfaceName``: display name
            - ``description``: worker description
            - ``annotationShape``: shape it produces (point/polygon/...)
        """
        return self._gc.get("/worker_interface/available")

    def get_worker_interface(
        self, image: str, request_if_missing: bool = True
    ) -> dict | None:
        """Get the parameter interface for a worker image.

        Args:
            image: Docker image name (e.g., ``'myworker:latest'``).
            request_if_missing: If True and no cached interface exists,
                request the worker to register its interface and wait.

        Returns:
            Dict mapping parameter IDs to their definitions, or None
            if no interface is available.
        """
        result = self._gc.get(
            "/worker_interface",
            parameters={"image": image},
        )
        if result and isinstance(result, dict):
            # Response may be the interface directly, or wrapped
            # in an 'interface' key — handle both.
            if "interface" in result:
                return result["interface"]
            # If it has parameter-like keys (not just metadata),
            # it IS the interface
            if result:
                return result

        if not request_if_missing:
            return None

        # Request the worker to register its interface
        resp = self._gc.post(
            "/worker_interface/request",
            parameters={"image": image},
        )
        if isinstance(resp, (list, tuple)) and resp:
            job = Job(self._gc, resp[0])
            job.wait(verbose=False)

        # Fetch the newly registered interface
        result = self._gc.get(
            "/worker_interface",
            parameters={"image": image},
        )
        if result and isinstance(result, dict):
            if "interface" in result:
                return result["interface"]
            if result:
                return result
        return None

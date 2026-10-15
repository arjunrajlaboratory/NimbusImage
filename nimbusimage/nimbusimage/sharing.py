"""SharingAccessor — dataset access control.

All access changes go through the `dataset_view/share` endpoint, which is
**incremental** (modifies one user's access at a time), and the server
refuses any share that would take the dataset's creator below ADMIN.
This is the only safe way to change a dataset's ACL from Python.

DO NOT bypass this accessor by calling the raw Girder endpoint:

    # WRONG — replaces the entire ACL and can lock the owner out
    client._gc.put(f"folder/{ds.id}/access", parameters={"access": ...})

The raw `PUT /folder/{id}/access` replaces the access list with whatever
you send. If the new list omits the dataset creator, the owner is
silently locked out (``_accessLevel`` becomes ``-1`` and only a site
admin can recover). The backend now rejects such saves on
``contrastDataset`` folders, but the right answer is to never reach for
the raw endpoint in the first place. See
``plugins/nimbusimage/references/gotchas.md``.
"""

from __future__ import annotations
from typing import TYPE_CHECKING

from nimbusimage._access import resolve_access as _resolve_access

if TYPE_CHECKING:
    import girder_client


class SharingAccessor:
    def __init__(self, gc: girder_client.GirderClient, dataset_id: str):
        self._gc = gc
        self._dataset_id = dataset_id

    def share(
        self, user_email_or_name: str, access: str = "read"
    ) -> None:
        """Share this dataset with a user.

        Grants (or revokes) access on the dataset folder and on every
        dataset view of it, plus each view's collection — the same set
        the web app's Share dialog changes by default. The caller needs
        WRITE access on all of them.

        Args:
            user_email_or_name: User's email or username.
            access: 'read', 'write', 'admin', or 'remove'.

        Raises:
            ValueError: If the dataset has no dataset views (the server
                derives the dataset and collections from the views, so
                there is nothing to share through).
        """
        access_type = _resolve_access(access)
        views = self._gc.get(
            "dataset_view",
            parameters={"datasetId": self._dataset_id, "limit": 0},
        )
        if not views:
            raise ValueError(
                f"Dataset {self._dataset_id} has no dataset views; "
                "link it to a collection before sharing."
            )
        self._gc.post(
            "dataset_view/share",
            json={
                "datasetViewIds": [view["_id"] for view in views],
                "userMailOrUsername": user_email_or_name,
                "accessType": access_type,
            },
        )

    def set_public(self, public: bool = True) -> dict:
        """Set whether this dataset is publicly accessible.

        Also sets the public flag on the dataset's views and their
        collections. Requires ADMIN (owner) access on the dataset.

        Returns:
            The server's summary: ``dataset``, ``public``,
            ``datasetViewsUpdated`` and ``configurationsUpdated``.
        """
        return self._gc.post(
            "dataset_view/set_public",
            parameters={
                "datasetId": self._dataset_id,
                "public": "true" if public else "false",
            },
        )

    def get_access(self) -> dict:
        """Get the access list for this dataset.

        Returns:
            ``{"datasetId", "public", "users", "groups",
            "configurations"}``; each user entry has ``id``, ``login``,
            ``name``, ``email`` and ``level`` (0 read, 1 write, 2 admin).
        """
        return self._gc.get(
            f"dataset_view/access/{self._dataset_id}"
        )

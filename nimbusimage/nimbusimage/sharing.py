"""SharingAccessor — dataset access control.

All access changes go through the `dataset_view/share` endpoint, which is
**incremental** (modifies one user's access at a time). This is the only
safe way to change a dataset's ACL from Python. It sends any target, you
included; the server refuses (400) any change that would leave the dataset
with no user at ADMIN. To hand a dataset over, give the new owner "admin"
first, then remove yourself.

DO NOT bypass this accessor by calling the raw Girder endpoint:

    # WRONG — replaces the entire ACL and can lock the owner out
    client._gc.put(f"folder/{ds.id}/access", parameters={"access": ...})

The raw `PUT /folder/{id}/access` replaces the access list with whatever
you send, so everyone the new list omits silently loses access. The
backend refuses a list that leaves no user at ADMIN on a
``contrastDataset`` folder, but the right answer is to never reach for
the raw endpoint in the first place. See
``plugins/nimbusimage/references/gotchas.md``.
"""

from __future__ import annotations
from typing import TYPE_CHECKING

from nimbusimage._access import ACCESS_MAP
from nimbusimage._access import resolve_access as _resolve_access

if TYPE_CHECKING:
    import girder_client

_WRITE = ACCESS_MAP["write"]


class SharingAccessor:
    def __init__(self, gc: girder_client.GirderClient, dataset_id: str):
        self._gc = gc
        self._dataset_id = dataset_id

    def share(
        self, user_email_or_name: str, access: str = "read"
    ) -> None:
        """Share this dataset with a user.

        Grants (or revokes) access on the dataset folder and on each of
        its dataset views that the caller can write, plus those views'
        collections. A view is included only if the caller can write both
        the view and its collection: the server refuses a whole request
        that names anything else (403). Views and collections the caller
        can't write are left unchanged, as in the web app's Share dialog.

        Args:
            user_email_or_name: User's email or username.
            access: 'read', 'write', 'admin', or 'remove'.

        Raises:
            ValueError: If the caller lacks WRITE on the dataset, or the
                dataset has no dataset views (the server derives the
                dataset and collections from the views, so there is
                nothing to share through), or none the caller can write.
        """
        access_type = _resolve_access(access)
        # Permission first: without WRITE the views a caller can read may
        # be none at all, and "no views" would name the wrong problem.
        access_list = self.get_access()
        if access_list["currentUserLevel"] < _WRITE:
            raise ValueError(
                f"Sharing needs WRITE access on dataset {self._dataset_id}."
            )
        views = self._gc.get(
            "dataset_view",
            parameters={"datasetId": self._dataset_id, "limit": 0},
        )
        if not views:
            raise ValueError(
                f"Dataset {self._dataset_id} has no dataset views; "
                "link it to a collection before sharing."
            )
        writable_view_ids = set(access_list["writableViewIds"])
        # Only collections the caller can read are listed; an absent one
        # is not writable either.
        writable_config_ids = {
            config["id"]
            for config in access_list["configurations"]
            if config["currentUserLevel"] >= _WRITE
        }
        view_ids = [
            view["_id"] for view in views
            if view["_id"] in writable_view_ids
            and view["configurationId"] in writable_config_ids
        ]
        if not view_ids:
            raise ValueError(
                f"You can't write any of dataset {self._dataset_id}'s "
                "views together with its collection, so there is "
                "nothing to share it through."
            )
        self._gc.post(
            "dataset_view/share",
            json={
                "datasetViewIds": view_ids,
                "userMailOrUsername": user_email_or_name,
                "accessType": access_type,
            },
        )

    def set_public(self, public: bool = True) -> dict:
        """Set whether this dataset is publicly accessible.

        Also sets the public flag on the dataset's views and their
        collections that the caller owns (ADMIN); other users' views and
        collections are left unchanged. Requires ADMIN (owner) access on
        the dataset.

        Returns:
            The server's summary: ``dataset``, ``public``,
            ``datasetViewsUpdated`` and ``configurationsUpdated``, and
            ``datasetViewsSkipped`` and ``configurationsSkipped`` for
            other users' items left in the other state.
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
            "configurations", "writableViewIds", "currentUserLevel"}``;
            each user entry has ``id``, ``login``, ``name``, ``email`` and
            ``level`` (0 read, 1 write, 2 admin). Each configuration
            carries the caller's ``currentUserLevel`` on it, and
            ``writableViewIds`` lists the views the caller can write.
        """
        return self._gc.get(
            f"dataset_view/access/{self._dataset_id}"
        )

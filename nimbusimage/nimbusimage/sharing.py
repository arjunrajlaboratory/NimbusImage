"""SharingAccessor — dataset access control."""

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

        Args:
            user_email_or_name: User's email or username.
            access: 'read', 'write', 'admin', or 'remove'.
        """
        self._gc.post(
            "/dataset_view/share",
            json={
                "datasetId": self._dataset_id,
                "userMailOrUsername": user_email_or_name,
                "accessType": _resolve_access(access),
            },
        )

    def set_public(self, public: bool = True) -> None:
        """Set whether this dataset is publicly accessible."""
        self._gc.post(
            f"/dataset_view/set_public"
            f"?datasetId={self._dataset_id}"
            f"&public={'true' if public else 'false'}"
        )

    def get_access(self) -> dict:
        """Get the access list for this dataset."""
        return self._gc.get(
            f"/dataset_view/access/{self._dataset_id}"
        )

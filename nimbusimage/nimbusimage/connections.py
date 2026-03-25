"""ConnectionAccessor — CRUD operations for annotation connections."""

from __future__ import annotations

from typing import TYPE_CHECKING

from nimbusimage.models import Connection

if TYPE_CHECKING:
    import girder_client


class ConnectionAccessor:
    """Access connections for a specific dataset."""

    def __init__(self, gc: girder_client.GirderClient, dataset_id: str):
        self._gc = gc
        self._dataset_id = dataset_id

    def list(
        self,
        parent_id: str | None = None,
        child_id: str | None = None,
        node_id: str | None = None,
        limit: int = 0,
        offset: int = 0,
    ) -> list[Connection]:
        """List connections in this dataset."""
        url = f"/annotation_connection/?datasetId={self._dataset_id}"
        if parent_id:
            url += f"&parentId={parent_id}"
        if child_id:
            url += f"&childId={child_id}"
        if node_id:
            url += f"&nodeAnnotationId={node_id}"
        url += f"&limit={limit}&offset={offset}"

        data = self._gc.get(url)
        return [Connection.from_dict(d) for d in data]

    def get(self, connection_id: str) -> Connection:
        """Get a single connection by ID."""
        data = self._gc.get(f"/annotation_connection/{connection_id}")
        return Connection.from_dict(data)

    def count(self) -> int:
        """Count connections in this dataset."""
        url = f"/annotation_connection/count?datasetId={self._dataset_id}"
        return self._gc.get(url)["count"]

    def create(
        self,
        parent_id: str,
        child_id: str,
        tags: list[str] | None = None,
    ) -> Connection:
        """Create a single connection."""
        body = {
            "parentId": parent_id,
            "childId": child_id,
            "datasetId": self._dataset_id,
            "tags": tags or [],
        }
        data = self._gc.post("/annotation_connection/", json=body)
        return Connection.from_dict(data)

    def create_many(self, connections: list[Connection]) -> list[Connection]:
        """Create multiple connections in bulk."""
        dicts = [c.to_dict() for c in connections]
        data = self._gc.post(
            "/annotation_connection/multiple", json=dicts
        )
        return [Connection.from_dict(d) for d in data]

    def connect_to_nearest(
        self,
        annotation_ids: list[str],
        tags: list[str],
        channel: int,
    ) -> None:
        """Auto-connect annotations to nearest neighbors.

        Server-side operation. Translates 'channel' to 'channelId'
        in the wire format.
        """
        self._gc.post(
            "/annotation_connection/connectTo",
            json={
                "annotationsIds": annotation_ids,
                "tags": tags,
                "channelId": channel,
                "datasetId": self._dataset_id,
            },
        )

    def update(self, connection_id: str, updates: dict) -> Connection:
        """Update a single connection."""
        data = self._gc.put(
            f"/annotation_connection/{connection_id}", json=updates
        )
        return Connection.from_dict(data)

    def delete(self, connection_id: str) -> None:
        """Delete a single connection."""
        self._gc.delete(f"/annotation_connection/{connection_id}")

    def delete_many(self, connection_ids: list[str]) -> None:
        """Delete multiple connections."""
        self._gc.sendRestRequest(
            "DELETE", "/annotation_connection/multiple", json=connection_ids
        )

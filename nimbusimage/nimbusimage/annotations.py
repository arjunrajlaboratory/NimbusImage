"""AnnotationAccessor — CRUD operations for annotations."""

from __future__ import annotations

import json
from typing import Any, TYPE_CHECKING

from nimbusimage.models import Annotation

if TYPE_CHECKING:
    import girder_client


class AnnotationAccessor:
    """Access annotations for a specific dataset."""

    def __init__(self, gc: girder_client.GirderClient, dataset_id: str):
        self._gc = gc
        self._dataset_id = dataset_id

    def list(
        self,
        shape: str | None = None,
        tags: list[str] | None = None,
        limit: int = 0,
        offset: int = 0,
    ) -> list[Annotation]:
        """List annotations in this dataset.

        Args:
            shape: Filter by shape ('polygon', 'point', 'line').
            tags: Filter by tags (JSON-encoded array sent to server).
            limit: Max results. 0 = unlimited.
            offset: Skip this many results.

        Returns:
            List of Annotation objects.
        """
        url = (
            f"/upenn_annotation?datasetId={self._dataset_id}"
            f"&limit={limit}&offset={offset}"
        )
        if shape:
            url += f"&shape={shape}"
        if tags:
            url += f"&tags={json.dumps(tags)}"

        data = self._gc.get(url)
        return [Annotation.from_dict(d) for d in data]

    def get(self, annotation_id: str) -> Annotation:
        """Get a single annotation by ID."""
        data = self._gc.get(f"/upenn_annotation/{annotation_id}")
        return Annotation.from_dict(data)

    def count(
        self,
        shape: str | None = None,
        tags: list[str] | None = None,
    ) -> int:
        """Count annotations matching filters."""
        url = f"/upenn_annotation/count?datasetId={self._dataset_id}"
        if shape:
            url += f"&shape={shape}"
        if tags:
            url += f"&tags={json.dumps(tags)}"
        return self._gc.get(url)["count"]

    def create(self, annotation: Annotation) -> Annotation:
        """Create a single annotation."""
        data = self._gc.post("/upenn_annotation/", json=annotation.to_dict())
        return Annotation.from_dict(data)

    def create_many(
        self,
        annotations: list[Annotation],
        connect_to: dict | None = None,
    ) -> list[Annotation]:
        """Create multiple annotations in bulk.

        Args:
            annotations: List of Annotation objects to create.
            connect_to: If provided, auto-connect created annotations
                to nearest matching annotation. Dict with 'tags' and
                'channel' keys.

        Returns:
            List of created Annotations (with server-assigned IDs).
        """
        dicts = [a.to_dict() for a in annotations]
        data = self._gc.post("/upenn_annotation/multiple", json=dicts)
        created = [Annotation.from_dict(d) for d in data]

        if connect_to is not None:
            annotation_ids = [a.id for a in created if a.id]
            if annotation_ids:
                self._gc.post(
                    "/annotation_connection/connectToNearest",
                    json={
                        "annotationsIds": annotation_ids,
                        "tags": connect_to["tags"],
                        "channelId": connect_to["channel"],
                    },
                )

        return created

    def update(self, annotation_id: str, updates: dict) -> Annotation:
        """Update a single annotation.

        Returns the updated annotation. If the server returns no body,
        fetches the annotation by ID to return the current state.
        """
        data = self._gc.put(
            f"/upenn_annotation/{annotation_id}", json=updates
        )
        if data is None:
            data = self._gc.get(f"/upenn_annotation/{annotation_id}")
        return Annotation.from_dict(data)

    def update_many(
        self, updates: list[tuple[str, dict]]
    ) -> list[Annotation]:
        """Update multiple annotations.

        Args:
            updates: List of (annotation_id, updates_dict) tuples.
        """
        payload = [
            {"_id": aid, **upd} for aid, upd in updates
        ]
        data = self._gc.put("/upenn_annotation/multiple", json=payload)
        return [Annotation.from_dict(d) for d in (data or [])]

    def delete(self, annotation_id: str) -> None:
        """Delete a single annotation."""
        self._gc.delete(f"/upenn_annotation/{annotation_id}")

    def delete_many(self, annotation_ids: list[str]) -> None:
        """Delete multiple annotations."""
        self._gc.sendRestRequest(
            "DELETE", "/upenn_annotation/multiple", json=annotation_ids
        )

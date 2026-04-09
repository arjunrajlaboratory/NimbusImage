"""AnnotationAccessor — CRUD operations for annotations."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING

from nimbusimage.jobs import Job
from nimbusimage.models import Annotation, Location

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
            f"upenn_annotation?datasetId={self._dataset_id}"
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
        data = self._gc.get(f"upenn_annotation/{annotation_id}")
        return Annotation.from_dict(data)

    def count(
        self,
        shape: str | None = None,
        tags: list[str] | None = None,
    ) -> int:
        """Count annotations matching filters."""
        url = f"upenn_annotation/count?datasetId={self._dataset_id}"
        if shape:
            url += f"&shape={shape}"
        if tags:
            url += f"&tags={json.dumps(tags)}"
        return self._gc.get(url)["count"]

    def create(self, annotation: Annotation) -> Annotation:
        """Create a single annotation."""
        data = self._gc.post("upenn_annotation/", json=annotation.to_dict())
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
        data = self._gc.post("upenn_annotation/multiple", json=dicts)
        created = [Annotation.from_dict(d) for d in data]

        if (
            connect_to is not None
            and connect_to.get("tags")
            and "channel" in connect_to
        ):
            annotation_ids = [a.id for a in created if a.id]
            if annotation_ids:
                self._gc.post(
                    "annotation_connection/connectTo",
                    json={
                        "annotationsIds": annotation_ids,
                        "tags": connect_to["tags"],
                        "channelId": connect_to["channel"],
                        "datasetId": self._dataset_id,
                    },
                )

        return created

    def update(self, annotation_id: str, updates: dict) -> Annotation:
        """Update a single annotation.

        Returns the updated annotation. If the server returns no body,
        fetches the annotation by ID to return the current state.
        """
        data = self._gc.put(
            f"upenn_annotation/{annotation_id}", json=updates
        )
        if data is None:
            data = self._gc.get(f"upenn_annotation/{annotation_id}")
        return Annotation.from_dict(data)

    def update_many(
        self, updates: list[tuple[str, dict]]
    ) -> list[Annotation]:
        """Update multiple annotations.

        Args:
            updates: List of (annotation_id, updates_dict) tuples.
                Each updates_dict must include 'datasetId'.

        Note:
            The bulk PUT endpoint has a known bug (#780) — it expects
            'id' (not '_id') and may return internal server errors.
            Prefer using update() in a loop until this is fixed.

        TODO: Once #780 is fixed, verify this works correctly and
        remove the warning. The payload format may need to change
        from '_id' to 'id' depending on the fix.
        """
        payload = [
            {"id": aid, **upd} for aid, upd in updates
        ]
        data = self._gc.put("upenn_annotation/multiple", json=payload)
        return [Annotation.from_dict(d) for d in (data or [])]

    def delete(self, annotation_id: str) -> None:
        """Delete a single annotation."""
        self._gc.delete(f"upenn_annotation/{annotation_id}")

    def delete_many(self, annotation_ids: list[str]) -> None:
        """Delete multiple annotations."""
        self._gc.sendRestRequest(
            "DELETE", "upenn_annotation/multiple", json=annotation_ids
        )

    def compute(
        self,
        image: str,
        channel: int = 0,
        tags: list[str] | None = None,
        location: Location | None = None,
        assignment: dict | str | None = None,
        worker_interface: dict | None = None,
        scales: dict | None = None,
        connect_to: dict | None = None,
        name: str = "worker",
    ) -> Job:
        """Run an annotation worker on this dataset.

        Submits a Docker worker job via ``POST /upenn_annotation/compute``.
        The worker container receives the parameters as a JSON string via
        ``--parameters`` and parses them with ``WorkerClient``.

        Args:
            image: Docker image name
                (e.g., ``'annotations/random_squares:latest'``).
            channel: Channel index for the worker to process.
            tags: Tags to assign to created annotations.
            location: Location (XY/Z/Time) for single-tile processing.
                Defaults to ``Location()``.
            assignment: Assignment range for batch processing. Can be
                a dict like ``{'XY': '0-2', 'Z': 0, 'Time': 0}`` or
                range strings like ``{'XY': '0-2', 'Z': 0, 'Time': '0-4'}``.
                Defaults to the location if not provided.
            worker_interface: Parameter values matching the worker's
                interface schema (from ``client.get_worker_interface()``).
                Keys must match exactly (e.g., ``'Square size'``, not
                ``'square_size'``).
            scales: Scale metadata (pixel size, etc.). Passed through
                to the worker for unit-aware computations.
            connect_to: Auto-connect created annotations to nearest
                neighbors. Dict with ``tags`` (list[str]) and
                ``channel`` (int) keys. If not provided, no connections
                are created.
            name: Job name shown in the Girder UI.

        Returns:
            A Job object. Call ``job.wait()`` to block until completion.

        Note:
            The worker container uses ``WorkerClient`` from the
            ``worker_client`` package, which requires all of these keys
            in the parameters: ``assignment``, ``channel``, ``connectTo``,
            ``tags``, ``tile``, ``workerInterface``. Missing keys cause
            the worker to skip initialization silently. The ``connectTo``
            dict must always contain a ``tags`` key (use ``[]`` for no
            connections) — omitting it causes a ``KeyError`` after
            annotations are uploaded.
        """
        loc = location or Location()
        loc_dict = loc.to_dict()
        if assignment is None:
            assignment = loc_dict

        # Validate connect_to has required 'tags' key if provided
        if connect_to is not None and "tags" not in connect_to:
            raise ValueError(
                "connect_to must contain a 'tags' key "
                "(e.g., {'tags': ['nucleus'], 'channel': 0})"
            )

        body = {
            "datasetId": self._dataset_id,
            "image": image,
            "channel": channel,
            "tags": tags or [],
            "assignment": assignment,
            "tile": loc_dict,
            "workerInterface": worker_interface or {},
            "connectTo": connect_to or {"tags": []},
            "scales": scales or {},
            "name": name,
            "type": "worker",
            "id": "",
        }

        resp = self._gc.post(
            f"upenn_annotation/compute?datasetId={self._dataset_id}",
            json=body,
        )
        job_data = resp[0] if isinstance(resp, (list, tuple)) else resp
        return Job(self._gc, job_data)

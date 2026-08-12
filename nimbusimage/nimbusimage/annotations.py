"""AnnotationAccessor — CRUD operations for annotations."""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import TYPE_CHECKING

from nimbusimage._workers import ANNOTATION_ROLE_LABEL, check_worker_role
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
        after_id: str | None = None,
        sort: str | None = None,
        sortdir: int = 1,
    ) -> list[Annotation]:
        """List annotations in this dataset.

        Args:
            shape: Filter by shape ('polygon', 'point', 'line').
            tags: Filter by tags (JSON-encoded array sent to server).
            limit: Max results. 0 = unlimited.
            offset: Skip this many results. NOTE: ``offset`` is positional
                and **not stable across mutations** — if you delete or add
                annotations between paged calls, an offset loop will skip or
                repeat records. Use :meth:`iter_all` (a stable ``after_id``
                cursor) for delete/modify-as-you-go loops.
            after_id: Return only annotations whose ``_id`` is greater than
                this one (a stable cursor). When set, the server ignores
                ``offset``. Only meaningful with ``sort="_id"`` (the server
                otherwise defaults to a non-``_id`` sort); prefer
                :meth:`iter_all`, which sets this for you.
            sort: Field to sort by (e.g. ``"_id"``). If omitted, the server
                uses its own default sort, which is **not** ``_id``.
            sortdir: Sort direction, ``1`` ascending or ``-1`` descending.
                Only applied when ``sort`` is set.

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
        if after_id:
            url += f"&afterId={after_id}"
        if sort:
            url += f"&sort={sort}&sortdir={sortdir}"

        data = self._gc.get(url)
        return [Annotation.from_dict(d) for d in data]

    def iter_all(
        self,
        shape: str | None = None,
        tags: list[str] | None = None,
        page_size: int = 1000,
    ) -> Iterator[Annotation]:
        """Iterate over every matching annotation, one page at a time.

        Walks the backend's stable ``afterId`` cursor: each page asks for
        annotations whose ``_id`` is greater than the largest ``_id`` seen
        so far. This is **mutation-safe** — unlike offset pagination, you
        can delete or modify annotations as you iterate without skipping
        records (the cursor only ever advances past IDs already yielded).

        This is the recommended way to fetch large result sets and to drive
        delete-as-you-go cleanup loops.

        The cursor's correctness requires each page to come back in
        ascending ``_id`` order (so ``page[-1]`` is the largest ``_id`` in
        the page). The server's default sort is **not** ``_id``, so this
        explicitly requests ``sort="_id"`` on every page — without it the
        cursor could skip, duplicate, or loop on records.

        Args:
            shape: Filter by shape ('polygon', 'point', 'line').
            tags: Filter by tags.
            page_size: Number of annotations to fetch per request.

        Yields:
            Annotation objects, in ascending ``_id`` order.
        """
        after_id: str | None = None
        while True:
            page = self.list(
                shape=shape,
                tags=tags,
                limit=page_size,
                after_id=after_id,
                sort="_id",
                sortdir=1,
            )
            if not page:
                break
            for annotation in page:
                yield annotation
            after_id = page[-1].id
            if after_id is None:
                raise RuntimeError(
                    "Server returned an annotation without an _id; "
                    "cannot advance the iter_all cursor."
                )

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

        if (
            connect_to is not None
            and connect_to.get("tags")
            and "channel" in connect_to
        ):
            annotation_ids = [a.id for a in created if a.id]
            if annotation_ids:
                self._gc.post(
                    "/annotation_connection/connectTo",
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
            f"/upenn_annotation/{annotation_id}", json=updates
        )
        if data is None:
            data = self._gc.get(f"/upenn_annotation/{annotation_id}")
        return Annotation.from_dict(data)

    def update_many(
        self, updates: list[tuple[str, dict]]
    ) -> None:
        """Update multiple annotations in a single HTTP request.

        Args:
            updates: List of (annotation_id, updates_dict) tuples.
                Each updates_dict may include 'datasetId' (required
                only if moving the annotation to a different dataset).

        Note:
            The bulk PUT endpoint returns no body, so this method
            does not return the updated annotations. Call ``get()``
            on individual IDs if you need their fresh state.
        """
        payload = [
            {"id": aid, **upd} for aid, upd in updates
        ]
        self._gc.put("/upenn_annotation/multiple", json=payload)

    def delete(self, annotation_id: str) -> None:
        """Delete a single annotation."""
        self._gc.delete(f"/upenn_annotation/{annotation_id}")

    def delete_many(self, annotation_ids: list[str]) -> None:
        """Delete multiple annotations."""
        self._gc.sendRestRequest(
            "DELETE", "/upenn_annotation/multiple", json=annotation_ids
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
                Defaults to ``Location()``. Mutually exclusive with
                ``assignment``: in batch mode the worker iterates the
                ``assignment`` ranges and ignores ``location``/``tile``,
                so passing both raises ``ValueError``.
            assignment: Assignment range for batch processing. Can be
                a dict like ``{'XY': '0-2', 'Z': 0, 'Time': 0}`` or
                range strings like ``{'XY': '0-2', 'Z': 0, 'Time': '0-4'}``.
                Defaults to the location if not provided. Do not combine
                with ``location=`` (see above).
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

        Raises:
            ValueError: If ``location`` and ``assignment`` conflict, if
                ``connect_to`` lacks a ``tags`` key, or if ``image`` is
                a property worker (its role labels from
                ``/worker_interface/available`` have ``isPropertyWorker``
                but not ``isAnnotationWorker``) — property workers must
                run through ``ds.properties.compute`` instead.

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
        # NIM-004: in batch mode the worker iterates the ``assignment``
        # ranges and ignores ``tile``/``location`` entirely. Silently
        # dropping a caller-supplied location is a footgun, so reject the
        # conflicting combination instead of ignoring one of the arguments.
        if location is not None and assignment is not None:
            raise ValueError(
                "location= is ignored in batch mode; pass ranges via "
                "assignment= only (the worker iterates assignment ranges "
                "and ignores location/tile). Provide either a single-tile "
                "location= or batch ranges via assignment=, not both."
            )

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

        # Reject property workers before submitting: they crash on the
        # annotation-compute payload (list-valued tags) after the job
        # has already started. After the cheap argument checks above so
        # bad arguments fail without an HTTP round-trip.
        check_worker_role(self._gc, image, ANNOTATION_ROLE_LABEL)

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
            f"/upenn_annotation/compute?datasetId={self._dataset_id}",
            json=body,
        )
        job_data = resp[0] if isinstance(resp, (list, tuple)) else resp
        return Job(self._gc, job_data)

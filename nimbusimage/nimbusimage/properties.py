"""PropertyAccessor — property definitions and computed values."""

from __future__ import annotations

from typing import Any, TYPE_CHECKING

from nimbusimage.jobs import Job
from nimbusimage.models import Property

if TYPE_CHECKING:
    import girder_client

_BATCH_SIZE = 10000


class PropertyAccessor:
    """Access property definitions and values for a dataset."""

    def __init__(self, gc: girder_client.GirderClient, dataset_id: str):
        self._gc = gc
        self._dataset_id = dataset_id

    # --- Definitions ---

    def list(self) -> list[Property]:
        """List all property definitions accessible to the user."""
        data = self._gc.get("/annotation_property")
        return [Property.from_dict(d) for d in data]

    def get(self, property_id: str) -> Property:
        """Get a property definition by ID."""
        data = self._gc.get(f"/annotation_property/{property_id}")
        return Property.from_dict(data)

    def create(
        self,
        name: str,
        shape: str = "polygon",
        tags: list[str] | None = None,
        image: str = "properties/none:latest",
        worker_interface: dict | None = None,
    ) -> Property:
        """Create a new property definition."""
        body = {
            "name": name,
            "shape": shape,
            "image": image,
            "tags": {"exclusive": False, "tags": tags or []},
            "workerInterface": worker_interface or {},
        }
        data = self._gc.post("/annotation_property", json=body)
        return Property.from_dict(data)

    def get_or_create(
        self,
        name: str,
        shape: str = "polygon",
        **kwargs,
    ) -> Property:
        """Get existing property by name+shape, or create it."""
        existing = self.list()
        for p in existing:
            if p.name == name and p.shape == shape:
                return p
        return self.create(name=name, shape=shape, **kwargs)

    def register(self, property_id: str) -> None:
        """Add property to all collections for this dataset.

        Fetches each unique collection, appends property_id if not
        present, and saves. Deduplicates by collection ID so shared
        collections are only updated once.
        """
        views = self._gc.get(
            f"/dataset_view?datasetId={self._dataset_id}"
        )
        seen: dict[str, dict] = {}
        for view in views:
            cid = view.get("configurationId")
            if not cid or cid in seen:
                continue
            seen[cid] = self._gc.get(f"/upenn_collection/{cid}")

        for cid, config in seen.items():
            prop_ids = config.get("meta", {}).get("propertyIds", [])
            if property_id not in prop_ids:
                prop_ids.append(property_id)
                self._gc.put(
                    f"/upenn_collection/{cid}/metadata",
                    json={"propertyIds": prop_ids},
                )

    def delete(self, property_id: str) -> None:
        """Delete a property definition."""
        self._gc.delete(f"/annotation_property/{property_id}")

    # --- Values ---

    def get_values(self, annotation_id: str | None = None) -> list[dict]:
        """Get property values.

        Args:
            annotation_id: If provided, get values for this annotation only.
                Otherwise, get all values for the dataset.
        """
        url = f"/annotation_property_values?datasetId={self._dataset_id}"
        if annotation_id:
            url += f"&annotationId={annotation_id}"
        return self._gc.get(url)

    def submit_values(
        self, property_id: str, values: dict[str, dict]
    ) -> None:
        """Submit property values in bulk.

        Transforms user-friendly format to backend wire format and
        auto-batches at 10K entries.

        Args:
            property_id: The property these values belong to.
            values: Dict mapping annotation_id to {key: value} dicts.
                Example: {"ann_1": {"Area": 100}, "ann_2": {"Area": 200}}
        """
        entries = []
        for ann_id, ann_values in values.items():
            entries.append({
                "datasetId": self._dataset_id,
                "annotationId": ann_id,
                "values": {property_id: ann_values},
            })

        for i in range(0, len(entries), _BATCH_SIZE):
            batch = entries[i:i + _BATCH_SIZE]
            self._gc.post(
                "/annotation_property_values/multiple", json=batch
            )

    def delete_values(self, property_id: str) -> None:
        """Delete all values for a property in this dataset."""
        self._gc.delete(
            f"/annotation_property_values"
            f"?propertyId={property_id}&datasetId={self._dataset_id}"
        )

    def histogram(
        self, property_path: str, buckets: int = 255
    ) -> list[dict]:
        """Get histogram for a property across all annotations."""
        return self._gc.get(
            f"/annotation_property_values/histogram"
            f"?propertyPath={property_path}"
            f"&datasetId={self._dataset_id}"
            f"&buckets={buckets}"
        )

    def compute(
        self,
        property: Property,
        worker_interface: dict | None = None,
        scales: dict | None = None,
    ) -> Job:
        """Run a property worker to compute values.

        Submits a Docker worker job via
        ``POST /annotation_property/{id}/compute``. The worker container
        receives the property definition and scales as JSON parameters.

        Args:
            property: The Property definition. Must have a non-empty
                ``image`` field (the Docker image to run) and an ``id``
                (must be saved to the server first via ``create()`` or
                ``get_or_create()``).
            worker_interface: Parameter values matching the worker's
                interface schema (from ``client.get_worker_interface()``).
                If not provided, uses the property's own
                ``workerInterface``.
            scales: Scale metadata (pixel size, etc.). Passed through
                to the worker for unit-aware computations.

        Returns:
            A Job object. Call ``job.wait()`` to block until completion.

        Raises:
            ValueError: If the property has no ``id`` or ``image``.
        """
        if not property.id:
            raise ValueError(
                "Property must be saved to the server first "
                "(use create() or get_or_create())"
            )
        if not property.image:
            raise ValueError("Property must have a Docker image set")

        body = property.to_dict()
        # The worker reads params.get("id") to identify which property
        # it's computing for (used as the key when storing values).
        # Property.to_dict() serializes as "_id" (the MongoDB convention),
        # but the frontend sends "id" and WorkerClient expects "id".
        # TODO: harmonize id vs _id across the backend/worker/frontend
        if "_id" in body:
            body["id"] = body.pop("_id")
        elif property.id and "id" not in body:
            body["id"] = property.id
        if worker_interface is not None:
            body["workerInterface"] = worker_interface
        if scales is not None:
            body["scales"] = scales

        resp = self._gc.post(
            f"/annotation_property/{property.id}/compute"
            f"?datasetId={self._dataset_id}",
            json=body,
        )
        job_data = resp[0] if isinstance(resp, (list, tuple)) else resp
        return Job(self._gc, job_data)

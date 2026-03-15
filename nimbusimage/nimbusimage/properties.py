"""PropertyAccessor — property definitions and computed values."""

from __future__ import annotations

import json
from typing import Any, TYPE_CHECKING

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
        """Add property to all configurations for this dataset.

        Fetches current config, appends property_id if not present,
        and saves.
        """
        views = self._gc.get(
            f"/dataset_view?datasetId={self._dataset_id}"
        )
        for view in views:
            config_id = view.get("configurationId")
            if not config_id:
                continue
            config = self._gc.get(f"/item/{config_id}")
            prop_ids = config.get("meta", {}).get("propertyIds", [])
            if property_id not in prop_ids:
                prop_ids.append(property_id)
                self._gc.put(
                    f"/item/{config_id}",
                    parameters={"metadata": json.dumps(
                        {"propertyIds": prop_ids}
                    )},
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

"""ExportAccessor — JSON and CSV export."""

from __future__ import annotations
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import girder_client


class ExportAccessor:
    def __init__(self, gc: girder_client.GirderClient, dataset_id: str):
        self._gc = gc
        self._dataset_id = dataset_id

    def to_json(
        self,
        include_annotations: bool = True,
        include_connections: bool = True,
        include_properties: bool = True,
        include_property_values: bool = True,
    ) -> dict:
        """Export dataset as JSON."""
        params = (
            f"includeAnnotations="
            f"{'true' if include_annotations else 'false'}"
            f"&includeConnections="
            f"{'true' if include_connections else 'false'}"
            f"&includeProperties="
            f"{'true' if include_properties else 'false'}"
            f"&includePropertyValues="
            f"{'true' if include_property_values else 'false'}"
        )
        return self._gc.get(
            f"/export/json?datasetId={self._dataset_id}&{params}"
        )

    def to_csv(
        self,
        property_paths: list[list[str]],
        delimiter: str = ",",
        undefined_value: str = "",
        path: str | None = None,
    ) -> bytes:
        """Export dataset as CSV.

        Args:
            property_paths: List of property path lists
                (e.g., [["propId", "Area"]]).
            delimiter: CSV delimiter.
            undefined_value: Value for undefined fields.
            path: If provided, write to this file path.

        Returns:
            CSV bytes (also written to path if provided).
        """
        body = {
            "datasetId": self._dataset_id,
            "propertyPaths": property_paths,
            "delimiter": delimiter,
            "undefinedValue": undefined_value,
        }
        import json as json_mod

        response = self._gc.sendRestRequest(
            "POST", "/export/csv",
            data=json_mod.dumps(body),
            headers={"Content-Type": "application/json"},
            jsonResp=False,
        )
        data = response.content

        if path is not None:
            with open(path, "wb") as f:
                f.write(data)

        return data

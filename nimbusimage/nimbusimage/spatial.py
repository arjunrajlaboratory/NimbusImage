"""Spatial-transcriptomics table accessor (``ds.spatial``).

A dataset may hold one ``spatial.zarr.zip`` item: an AnnData-layout zarr
store whose ``obs.annotation_id`` joins each row to a cell annotation. The
``upenncontrast_spatial`` Girder plugin registers and serves it under
``/spatial/{datasetId}``.
"""

from __future__ import annotations

import os
from typing import TYPE_CHECKING

import girder_client

from nimbusimage.jobs import Job

if TYPE_CHECKING:  # pragma: no cover
    pass

DEFAULT_PROPERTY_NAME = "Gene Expression"


class SpatialAccessor:
    """Register and read a dataset's spatial expression table."""

    def __init__(self, gc: girder_client.GirderClient, dataset_id: str):
        self._gc = gc
        self._dataset_id = dataset_id

    @property
    def _base(self) -> str:
        return f"spatial/{self._dataset_id}"

    # --- registry ---

    def info(self, verify: bool = False) -> dict | None:
        """The registered table's schema, or None when none is registered.

        Keys include ``nObs``, ``nVar``, ``obsColumns`` and ``itemId``.
        With ``verify=True`` the server also counts ``liveAnnotations``,
        the rows that still join to an annotation (a scan of the dataset's
        ids, about 1.5 s at 700K cells).
        """
        try:
            return self._gc.get(
                self._base, parameters={"verify": "true"} if verify else None
            )
        except girder_client.HttpError as exc:
            if exc.status == 404:
                return None
            raise

    def upload(self, path: str | os.PathLike) -> dict:
        """Upload a ``spatial.zarr.zip`` into the dataset folder.

        Returns the created item (girder_client hands back the FILE, whose
        ``itemId`` is what ``register`` needs). Or use
        ``upload_and_register``.
        """
        file = self._gc.uploadFileToFolder(self._dataset_id, str(path))
        return self._gc.getItem(file["itemId"])

    def register(self, item_id: str) -> dict:
        """Make an item in the dataset folder the dataset's spatial table."""
        return self._gc.post(f"{self._base}/register", json={"itemId": item_id})

    def upload_and_register(self, path: str | os.PathLike) -> dict:
        return self.register(self.upload(path)["_id"])

    def unregister(self) -> None:
        """Forget the registration; the item stays in the folder."""
        self._gc.delete(self._base)

    # --- reads ---

    def features(self, search: str = "", limit: int = 25) -> list[dict]:
        """Feature symbols matching ``search`` (prefix matches first)."""
        return self._gc.get(
            f"{self._base}/features",
            parameters={"search": search, "limit": limit},
        )

    def column(self, symbol: str) -> dict:
        """One feature across all cells: ``{annotationIds, values}`` of the
        non-zero entries."""
        return self._gc.get(
            f"{self._base}/column", parameters={"feature": symbol}
        )

    def row(self, annotation_id: str) -> dict[str, float]:
        """One cell across all features: ``{symbol: value}`` non-zero."""
        return self._gc.get(
            f"{self._base}/row", parameters={"annotationId": annotation_id}
        )["values"]

    def aggregate(
        self, symbols: list[str], filters: dict | None = None
    ) -> dict:
        """Mean (zeros included) and fraction expressing per feature over the
        annotations matching ``filters`` — the list-filter object the
        Objects tab uses, e.g. ``{"tags": {"values": ["B Cell"],
        "exclusive": False}}``; ``None`` means every cell."""
        return self._gc.post(
            f"{self._base}/aggregate",
            json={"features": symbols, "filters": filters or {}},
        )

    # --- materialize ---

    def materialize(
        self,
        symbols: list[str],
        property_name: str = DEFAULT_PROPERTY_NAME,
        wait: bool = True,
    ) -> dict:
        """Write ``symbols`` as dense sub-values of a property (created and
        registered into the dataset's configurations if needed).

        Small tables are written inline; large ones run as a job, which is
        awaited when ``wait`` is True. Returns ``{propertyId, written,
        jobId}``.
        """
        result = self._gc.post(
            f"{self._base}/materialize",
            json={"features": symbols, "propertyName": property_name},
        )
        if wait and result.get("jobId"):
            Job(self._gc, self._gc.get(f"job/{result['jobId']}")).wait()
        return result

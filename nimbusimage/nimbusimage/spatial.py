"""Spatial-transcriptomics accessor (``ds.spatial``).

A dataset may hold one ``spatial.zarr.zip`` item: an AnnData-layout zarr
store whose ``obs.annotation_id`` joins each row to a cell annotation. It may
also hold the 10x ``transcripts.zarr.zip`` (per-molecule points, served as a
tile pyramid and density heat map). The ``upenncontrast_spatial`` Girder
plugin registers and serves both under ``/spatial/{datasetId}``.
"""

from __future__ import annotations

import os
import struct
from typing import TYPE_CHECKING

import girder_client

from nimbusimage.jobs import Job

if TYPE_CHECKING:  # pragma: no cover
    pass

DEFAULT_PROPERTY_NAME = "Gene Expression"
DEFAULT_SCORE_PROPERTY_NAME = "Gene set scores"


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

    def score(
        self,
        symbols: list[str],
        name: str,
        method: str = "mean",
        property_name: str = DEFAULT_SCORE_PROPERTY_NAME,
        wait: bool = True,
    ) -> dict:
        """Write a gene-set score (``mean`` or ``sum`` of the features'
        counts per cell) as sub-value ``name`` of a property. Same job
        behaviour as ``materialize``."""
        result = self._gc.post(
            f"{self._base}/score",
            json={
                "features": symbols, "name": name, "method": method,
                "propertyName": property_name,
            },
        )
        if wait and result.get("jobId"):
            Job(self._gc, self._gc.get(f"job/{result['jobId']}")).wait()
        return result

    def differential(
        self,
        filters_a: dict,
        filters_b: dict | None = None,
        max_features: int = 50,
        wait: bool = True,
    ) -> dict:
        """Rank features by differential expression (Welch t-test) between
        the cells matching ``filters_a`` and those matching ``filters_b``
        (``None`` = every other cell). Runs as a server job; with ``wait``
        the ranked table is returned (``{nA, nB, featuresTested,
        features: [...]}``), otherwise ``{jobId, nA}``."""
        result = self._gc.post(
            f"{self._base}/differential",
            json={
                "filtersA": filters_a, "filtersB": filters_b,
                "maxFeatures": max_features,
            },
        )
        if not wait:
            return result
        job = Job(self._gc, self._gc.get(f"job/{result['jobId']}"))
        job.wait()
        return self._gc.get(f"job/{result['jobId']}")["spatialResult"]

    def virtual_path(self, symbol: str) -> list[str]:
        """The property path that reads ``symbol`` straight from the table
        (no materialization): usable wherever a property path is accepted —
        filters, analysis axes, color-by, export columns."""
        return ["spatial", symbol]

    # --- transcripts (per-molecule store) ---

    def transcripts(self) -> dict | None:
        """The registered transcript store's pyramid, or None when none is
        registered: ``levels``, ``pixelSize``, ``transform``, ``genes``,
        ``totalPoints`` and per-level ``tiles`` (keys and counts)."""
        try:
            return self._gc.get(f"{self._base}/transcripts")
        except girder_client.HttpError as exc:
            if exc.status == 404:
                return None
            raise

    def upload_transcripts(self, path: str | os.PathLike) -> dict:
        """Upload a ``transcripts.zarr.zip`` into the dataset folder and
        return its item."""
        file = self._gc.uploadFileToFolder(self._dataset_id, str(path))
        return self._gc.getItem(file["itemId"])

    def register_transcripts(
        self, item_id: str, pixel_size: float, transform=None
    ) -> dict:
        """Make an item in the dataset folder the dataset's transcript store.

        ``pixel_size`` is microns per image pixel; ``transform`` an optional
        3x3 matrix taking pixels on the transcripts' grid to this image's
        pixels (H&E). Returns the pyramid description (see ``transcripts``).
        """
        body: dict = {"itemId": item_id, "pixelSize": pixel_size}
        if transform is not None:
            body["transform"] = [
                [float(value) for value in row] for row in transform
            ]
        return self._gc.post(f"{self._base}/transcripts/register", json=body)

    def unregister_transcripts(self) -> None:
        self._gc.delete(f"{self._base}/transcripts")

    def transcript_genes(self, search: str = "", limit: int = 25) -> list[str]:
        """Gene symbols of the transcript store matching ``search`` (control
        codewords are never listed)."""
        return self._gc.get(
            f"{self._base}/transcripts/genes",
            parameters={"search": search, "limit": limit},
        )

    def transcript_points(
        self,
        genes: list[str],
        tiles: list[str],
        level: int = 0,
        min_qv: float = 0,
    ) -> dict:
        """Molecules of ``genes`` in pyramid ``tiles`` (``"gx,gy"`` keys of
        ``transcripts()["tiles"][level]``), decoded from the binary response.

        Returns numpy arrays: ``x``/``y`` in image pixels, ``gene`` (index
        into ``genes``), and at level 0 ``quality``. The store carries no
        cell reference; a molecule's cell is whichever annotation contains
        its point.
        """
        import numpy as np

        resp = self._gc.sendRestRequest(
            "POST", f"{self._base}/transcripts/points",
            json={"genes": genes, "tiles": tiles, "level": level,
                  "minQv": min_qv},
            jsonResp=False,
        )
        body = resp.content
        (n,) = struct.unpack_from("<I", body, 0)
        has_quality = body[4] == 1
        offset = 5
        xy = np.frombuffer(body, dtype="<f4", count=2 * n, offset=offset)
        offset += 8 * n
        gene = np.frombuffer(body, dtype=np.uint8, count=n, offset=offset)
        offset += n
        result = {"x": xy[0::2], "y": xy[1::2], "gene": gene}
        if has_quality:
            result["quality"] = np.frombuffer(
                body, dtype="<f4", count=n, offset=offset
            )
        return result

    # --- table versions and recompute (Phase 4) ---

    def versions(self) -> dict:
        """``{"active": {...}, "versions": [...]}``: the table every read
        uses and the others kept beside it (itemId, label, provenance, nObs,
        nVar, created)."""
        return self._gc.get(f"{self._base}/versions")

    def activate_version(self, item_id: str) -> dict:
        """Make a kept version the active table; the active one is kept."""
        return self._gc.post(f"{self._base}/versions/{item_id}/activate")

    def forget_version(self, item_id: str) -> dict:
        """Drop a non-active version from the registry (the item stays)."""
        return self._gc.delete(f"{self._base}/versions/{item_id}")

    def staleness(self) -> dict:
        """How the live cell polygons differ from the active table: counts
        and ids of ``added``, ``changed`` and ``removed`` cells, and
        ``upToDate``."""
        return self._gc.get(f"{self._base}/staleness")

    def recompute(
        self,
        label: str = "Recomputed",
        scope: str = "all",
        min_qv: float = 20,
        tags: list[str] | None = None,
        embeddings: bool = False,
        wait: bool = True,
        timeout: float = 7200,
    ) -> dict:
        """Rebuild the expression table from the current cell polygons and
        the transcript store (a server job). ``scope="dirty"`` reassigns only
        the tiles touched by edited cells and carries the other rows over.
        With ``wait`` (default) returns the job's result ``{itemId, nObs,
        nVar, assigned, unassigned, tilesProcessed, seconds}``; otherwise
        ``{"jobId"}``.
        """
        body: dict = {
            "label": label, "scope": scope, "minQv": min_qv,
            "recomputeEmbeddings": embeddings,
        }
        if tags is not None:
            body["tags"] = list(tags)
        response = self._gc.post(f"{self._base}/recompute", json=body)
        if not wait:
            return response
        job = Job(self._gc, self._gc.get(f"job/{response['jobId']}"))
        if not job.wait(timeout=timeout):
            raise RuntimeError(
                "recompute job %s failed" % response["jobId"]
            )
        return self._gc.get(f"job/{response['jobId']}")["spatialResult"]


"""Reading one ROI of a Spatial Genomics (GenePS / sganalysis) data export.

An export holds one project folder with two trees per ROI::

    <project>/basic_results/roi_N/
        roi_N_Boundaries.geojson     cell polygons, MICRONS, id = cell label
        roi_N_CellCoordinates.csv    label, area (um^2), center_x, center_y
        roi_N_CellxGene.csv          raw counts, one row per label
        roi_N_TranscriptList.csv     name, x, y, z (microns)
        roi_N_Segmentation.tiff      uint32 cell-label mask
        roi_N_DAPI.tiff              duplicate of images/dapi.tiff
    <project>/mini_project/roi_N/
        images/*.tiff                OME-TIFF channels (dapi, GFP_image, ...)
        clusters/matrix_*_cells.h5ad AnnData: obs leiden, obsm X_umap
        genes/<project>.hdf5         per-gene points in PIXELS (+ UNUSED*)
        sganalysis.session           JSON: shape, res (um / pixel)

The cell label is the join key everywhere: the GeoJSON feature id, the
CellxGene row index, the h5ad obs index and the segmentation mask value.
"""

from __future__ import annotations

import json
import os
import re
from functools import cached_property
from pathlib import Path

import numpy as np

from nimbusimage.sg.errors import SGError
from nimbusimage.xenium.bundle import safe_symbol

SESSION_FILE = "sganalysis.session"
ROI_PATTERN = re.compile(r"^roi_(\d+)$")
IMAGE_SUFFIXES = (".tif", ".tiff")


def _roi_number(name: str) -> int:
    return int(ROI_PATTERN.match(name).group(1))


def find_project_dir(path: str | os.PathLike) -> Path:
    """The folder holding ``basic_results/`` and ``mini_project/``.

    Accepts that folder itself or any parent up to two levels above it
    (``DataExport_X/`` or the folder the zip was extracted into), as long
    as exactly one project folder is found.
    """
    root = Path(path)
    if not root.is_dir():
        raise SGError(f"{root} is not a directory")
    candidates = [root, *root.glob("*"), *root.glob("*/*")]
    found = [
        p
        for p in candidates
        if (p / "basic_results").is_dir() and (p / "mini_project").is_dir()
    ]
    if len(found) != 1:
        raise SGError(
            f"expected one folder with basic_results/ and mini_project/ "
            f"under {root}, found {len(found)}: {[str(p) for p in found]}"
        )
    return found[0]


def list_rois(path: str | os.PathLike) -> list[str]:
    """The ROI names of an export (``roi_1``, ``roi_2``, ...) in order."""
    project = find_project_dir(path)
    names = {
        p.name
        for p in (project / "basic_results").iterdir()
        if p.is_dir() and ROI_PATTERN.match(p.name)
    }
    return sorted(names, key=_roi_number)


def channel_name(path: Path) -> str:
    """``dapi.tiff`` -> ``DAPI``; ``GFP_image.tiff`` -> ``GFP``.

    NimbusImage's filename parser splits on ``_``, so the name must not
    contain one.
    """
    stem = path.name
    for suffix in (".ome.tiff", ".ome.tif", *IMAGE_SUFFIXES):
        if stem.lower().endswith(suffix):
            stem = stem[: -len(suffix)]
            break
    stem = re.sub(r"[_\-]?image$", "", stem, flags=re.I)
    if stem.lower() == "dapi":
        return "DAPI"
    return re.sub(r"[\s_/\\]+", "-", stem).strip("-") or "channel"


class SGRoi:
    """One ROI of a Spatial Genomics export.

    ``SGRoi(export_dir, "roi_3")``; ``export_dir`` may be the project
    folder or a parent of it (see :func:`find_project_dir`). Files are read
    lazily, and a missing one raises :class:`SGError`.
    """

    def __init__(self, export_dir: str | os.PathLike, roi: str):
        if not ROI_PATTERN.match(roi):
            raise SGError(f"ROI names look like 'roi_3', got {roi!r}")
        self.project_dir = find_project_dir(export_dir)
        self.name = roi
        self.basic_dir = self.project_dir / "basic_results" / roi
        self.mini_dir = self.project_dir / "mini_project" / roi
        if not self.basic_dir.is_dir():
            raise SGError(
                f"no {roi} in {self.project_dir / 'basic_results'} "
                f"(found {list_rois(self.project_dir)})"
            )

    def __repr__(self) -> str:
        return f"SGRoi({str(self.project_dir)!r}, {self.name!r})"

    @property
    def project(self) -> str:
        return self.project_dir.name

    # --- paths ---

    def _require(self, path: Path) -> Path:
        if not path.is_file():
            raise SGError(f"missing {path}")
        return path

    def _basic(self, suffix: str) -> Path:
        return self._require(self.basic_dir / f"{self.name}_{suffix}")

    @property
    def boundaries_path(self) -> Path:
        return self._basic("Boundaries.geojson")

    @property
    def coordinates_path(self) -> Path:
        return self._basic("CellCoordinates.csv")

    @property
    def counts_path(self) -> Path:
        return self._basic("CellxGene.csv")

    @property
    def transcripts_path(self) -> Path:
        return self._basic("TranscriptList.csv")

    @property
    def segmentation_path(self) -> Path:
        return self._basic("Segmentation.tiff")

    @property
    def session_path(self) -> Path:
        return self._require(self.mini_dir / SESSION_FILE)

    @property
    def clusters_path(self) -> Path | None:
        """The cells' h5ad (``clusters/matrix_*_cells.h5ad``), or None."""
        found = sorted((self.mini_dir / "clusters").glob("*_cells.h5ad"))
        if len(found) > 1:
            raise SGError(f"more than one cells h5ad: {found}")
        return found[0] if found else None

    def image_paths(self) -> list[tuple[str, Path]]:
        """``(channel name, path)`` for each image, DAPI first."""
        directory = self.mini_dir / "images"
        files = sorted(
            p
            for p in (directory.iterdir() if directory.is_dir() else [])
            if p.suffix.lower() in IMAGE_SUFFIXES
        )
        if not files:
            raise SGError(f"no images in {directory}")
        named = [(channel_name(p), p) for p in files]
        names = [n for n, _ in named]
        if len(set(names)) != len(names):
            raise SGError(f"two images map to one channel name: {names}")
        return sorted(named, key=lambda item: (item[0] != "DAPI", item[0]))

    # --- session ---

    @cached_property
    def session(self) -> dict:
        try:
            return json.loads(self.session_path.read_text())
        except ValueError as exc:
            raise SGError(f"{self.session_path} is not JSON: {exc}") from exc

    @property
    def pixel_size(self) -> float:
        """Microns per image pixel (``res`` in ``sganalysis.session``)."""
        try:
            value = float(self.session["res"])
        except (KeyError, TypeError, ValueError) as exc:
            raise SGError(f"{self.session_path} has no numeric 'res'") from exc
        if not value > 0:
            raise SGError(f"pixel size must be positive, got {value}")
        return value

    @property
    def shape(self) -> tuple[int, int]:
        """Image ``(rows, cols)`` in pixels."""
        try:
            rows, cols = (int(v) for v in self.session["shape"])
        except (KeyError, TypeError, ValueError) as exc:
            raise SGError(f"{self.session_path} has no 'shape'") from exc
        return rows, cols

    # --- cells ---

    def polygons(self) -> tuple[np.ndarray, list[np.ndarray]]:
        """``(labels, rings)``: each ring is an ``[n, 2]`` array of micron
        vertices with the closing vertex dropped; outer ring only."""
        try:
            features = json.loads(self.boundaries_path.read_text())[
                "features"
            ]
        except (ValueError, KeyError, TypeError) as exc:
            raise SGError(
                f"{self.boundaries_path} is not a FeatureCollection: {exc}"
            ) from exc
        labels, rings = [], []
        for feature in features:
            geometry = feature.get("geometry") or {}
            if geometry.get("type") != "Polygon":
                raise SGError(
                    f"feature {feature.get('id')!r} is a "
                    f"{geometry.get('type')!r}, expected Polygon"
                )
            try:
                label = int(feature["id"])
            except (KeyError, TypeError, ValueError) as exc:
                raise SGError(
                    f"feature without an integer id: {feature.get('id')!r}"
                ) from exc
            ring = np.asarray(geometry["coordinates"][0], dtype=np.float64)
            if len(ring) > 1 and np.array_equal(ring[0], ring[-1]):
                ring = ring[:-1]
            labels.append(label)
            rings.append(ring)
        labels = np.asarray(labels, dtype=np.int64)
        if len(np.unique(labels)) != len(labels):
            raise SGError(f"{self.boundaries_path} repeats a cell label")
        return labels, rings

    def coordinates(self):
        """CellCoordinates as a DataFrame indexed by label: ``area``
        (um^2), ``center_x``, ``center_y`` (microns)."""
        import pandas as pd

        table = pd.read_csv(self.coordinates_path)
        missing = {"label", "area", "center_x", "center_y"} - set(table)
        if missing:
            raise SGError(f"{self.coordinates_path} lacks {sorted(missing)}")
        return table.set_index("label")

    def counts(self):
        """``(labels, symbols, names, counts)``: raw counts as a
        cells x genes ``scipy.sparse.csr_matrix``; ``symbols`` are the
        names as NimbusImage stores them (:func:`safe_symbol`)."""
        import pandas as pd
        import scipy.sparse as sp

        table = pd.read_csv(self.counts_path, index_col=0)
        names = [str(c) for c in table.columns]
        symbols = [safe_symbol(n) for n in names]
        if len(set(symbols)) != len(symbols):
            raise SGError(f"{self.counts_path} has duplicate gene symbols")
        labels = table.index.to_numpy(dtype=np.int64)
        if len(np.unique(labels)) != len(labels):
            raise SGError(f"{self.counts_path} repeats a cell label")
        return labels, symbols, names, sp.csr_matrix(table.to_numpy())

    def clusters(self) -> dict | None:
        """From the cells' h5ad: ``labels``, ``leiden`` (int, -1 for
        missing), ``umap`` (``[n, 2]`` or None) and ``gene_ids``
        ({name: Ensembl id}). None when the export has no h5ad."""
        path = self.clusters_path
        if path is None:
            return None
        import anndata as ad

        adata = ad.read_h5ad(path)
        try:
            labels = adata.obs.index.astype(np.int64).to_numpy()
        except (TypeError, ValueError) as exc:
            raise SGError(f"{path} obs index is not cell labels") from exc
        leiden = None
        if "leiden" in adata.obs:
            leiden = (
                adata.obs["leiden"].astype(str).replace("nan", "-1")
                .astype(np.int64).to_numpy()
            )
        umap = adata.obsm.get("X_umap")
        gene_ids = {}
        if "refids" in adata.var:
            gene_ids = dict(
                zip(
                    adata.var.index.astype(str),
                    adata.var["refids"].astype(str),
                )
            )
        return {
            "labels": labels,
            "leiden": leiden,
            "umap": None if umap is None else np.asarray(umap, np.float64),
            "gene_ids": gene_ids,
        }

    def transcripts(self) -> tuple[list[str], np.ndarray, np.ndarray]:
        """``(gene_names, gene_codes, xyz)``: sorted names (stored form,
        :func:`safe_symbol`, matching the table's symbols), an int index
        into them per molecule, and ``[n, 3]`` float32 microns."""
        import pandas as pd

        table = pd.read_csv(
            self.transcripts_path,
            dtype={"name": "category", "x": np.float32, "y": np.float32,
                   "z": np.float32},
        )
        missing = {"name", "x", "y", "z"} - set(table)
        if missing:
            raise SGError(f"{self.transcripts_path} lacks {sorted(missing)}")
        raw = sorted(str(n) for n in table["name"].cat.categories)
        codes = pd.Categorical(table["name"], categories=raw).codes
        if (codes < 0).any():
            raise SGError(f"{self.transcripts_path} has rows without a name")
        names = [safe_symbol(n) for n in raw]
        if len(set(names)) != len(names):
            raise SGError(
                f"{self.transcripts_path}: gene names collide once '.'/'$' "
                "become '_'"
            )
        xyz = table[["x", "y", "z"]].to_numpy(np.float32)
        return names, codes.astype(np.int64), xyz

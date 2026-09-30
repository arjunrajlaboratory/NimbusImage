"""Read a 10x Xenium output bundle (XOA 1-4) without touching the server.

The files a bundle holds, and the traps in reading them::

    experiment.xenium            run manifest; ``pixel_size`` (um/px)
    cells.zarr.zip               polygon_sets {0: nucleus, 1: cell} in MICRONS,
                                 packed ``cell_id``
    cell_feature_matrix.zarr.zip counts, GENE-MAJOR CSR (row = feature,
                                 indices = cell); controls mixed in
    analysis.zarr.zip            ``cell_groups`` clusterings only, ZERO-PADDED
    morphology_focus/*.ome.tif   one logical multi-channel image, one file per
                                 channel; stain names only in the OME XML
    transcripts.zarr.zip         molecule pyramid, used as shipped
"""

from __future__ import annotations

import csv
import json
import re
from functools import cached_property
from pathlib import Path

import numpy as np

from nimbusimage.xenium.errors import XeniumError

try:
    import zarr
except ImportError as exc:  # pragma: no cover - depends on the environment
    raise ImportError(
        "nimbusimage.xenium needs the xenium extra: "
        "pip install 'nimbusimage[xenium]'"
    ) from exc

CELL_POLYGON_SET = "cell"
NUCLEUS_POLYGON_SET = "nucleus"

# XOA 4 "Protein" bundles quantify antibodies in the same matrix. Several
# share a gene's name (CD3E, CD4, CD68, ...), and table symbols must be
# unique, so proteins are named "<key> (protein)".
PROTEIN_SUFFIX = " (protein)"


def open_zarr_zip(path: str | Path):
    """A read-only zarr group over a ``.zarr.zip`` (zarr 2 or 3)."""
    return zarr.open_group(
        zarr.storage.ZipStore(str(path), mode="r"), mode="r"
    )


def decode_cell_id(cell_id: str) -> tuple[int, int]:
    """CSV ``'aaaaadoa-1'`` -> zarr ``(992, 1)``.

    The first 8 characters are nibbles ``a..p = 0..15``; the suffix is the
    dataset suffix.
    """
    prefix, suffix = cell_id.split("-")
    value = 0
    for char in prefix:
        value = (value << 4) | (ord(char) - ord("a"))
    return value, int(suffix)


def decode_cell_groups(
    analysis_zarr: str | Path, n_cells: int
) -> dict[str, np.ndarray]:
    """``{grouping: labels[n_cells]}`` with 0 = unassigned, 1-based ids.

    ``indices`` is ZERO-PADDED: unassigned cells occupy slots holding 0, so
    cell 0 appears many times. A zero is genuine only as the FIRST element of
    its block (blocks are strictly ascending). Decoding naively gives cell 0
    the last cluster id of every grouping.
    """
    groups = open_zarr_zip(analysis_zarr)["cell_groups"]
    labels = {}
    for group_index, name in enumerate(groups.attrs["grouping_names"]):
        indices = groups[str(group_index)]["indices"][:]
        pointers = np.append(
            groups[str(group_index)]["indptr"][:], len(indices)
        )
        label = np.zeros(n_cells, dtype=np.int32)
        for k in range(len(pointers) - 1):
            block = indices[int(pointers[k]):int(pointers[k + 1])]
            if len(block) == 0:
                continue
            keep = block > 0
            if block[0] == 0:
                keep[0] = True
            label[block[keep]] = k + 1
        labels[name.replace("gene_expression_", "")] = label
    return labels


_OME_CHANNEL = re.compile(r"<Channel\b[^>]*>", re.S)
_OME_ATTRIBUTE = re.compile(r'(\w+)="([^"]*)"')
_OME_TIFF_DATA = re.compile(r"<TiffData\b([^>]*)>\s*<UUID\b([^>]*)>", re.S)


def ome_channel_names(ome_xml: str, files: list[Path]) -> dict[Path, str]:
    """Stain name per file from one file's OME XML.

    Every file of a morphology set carries the whole multi-file description:
    ``<Channel Name="DAPI">`` per channel and ``TiffData FirstC`` ->
    ``UUID FileName`` for which file holds it. Falls back to file order and
    then to the file's stem.
    """
    names = [
        dict(_OME_ATTRIBUTE.findall(match.group(0))).get("Name")
        for match in _OME_CHANNEL.finditer(ome_xml)
    ]
    channel_of_file = {}
    for tiff_data, uuid in _OME_TIFF_DATA.findall(ome_xml):
        first = dict(_OME_ATTRIBUTE.findall(tiff_data)).get("FirstC")
        file_name = dict(_OME_ATTRIBUTE.findall(uuid)).get("FileName")
        if first is not None and file_name:
            channel_of_file[file_name] = int(first)
    result = {}
    for order, path in enumerate(files):
        index = channel_of_file.get(path.name, order)
        name = names[index] if index < len(names) and names[index] else None
        result[path] = name or path.name.split(".")[0]
    return result


def staged_channel_file_name(index: int, stain: str) -> str:
    """``c01-ATP1A1+CD45+E-Cadherin.ome.tif``.

    NimbusImage's filename parser splits on ``_`` (and ``/`` is a path), so
    those become ``+``/``-``; the two-digit prefix keeps channel order, since
    values sort as text.
    """
    safe = re.sub(r"[/\\]", "+", stain)
    safe = re.sub(r"[\s_]+", "-", safe).strip("-")
    return f"c{index:02d}-{safe}.ome.tif"


class XeniumBundle:
    """An extracted Xenium output directory.

    Example:
        bundle = XeniumBundle("extracted/")
        bundle.pixel_size                  # 0.2125
        n_vertices, vertices = bundle.polygons()
        labels = bundle.cell_groups()      # {"graphclust": [...], ...}
    """

    def __init__(self, directory: str | Path):
        self.directory = Path(directory)

    def __repr__(self) -> str:
        return f"XeniumBundle({str(self.directory)!r})"

    # --- files ---

    @property
    def cells_zarr(self) -> Path:
        return self.directory / "cells.zarr.zip"

    @property
    def feature_matrix_zarr(self) -> Path:
        return self.directory / "cell_feature_matrix.zarr.zip"

    @property
    def analysis_zarr(self) -> Path:
        return self.directory / "analysis.zarr.zip"

    @property
    def transcripts_zarr(self) -> Path:
        return self.directory / "transcripts.zarr.zip"

    def require(self, *paths: Path) -> None:
        """Raise ``XeniumError`` naming every missing bundle file.

        Steps call this before any server work, so a mistyped
        ``--bundle-dir`` fails at once instead of after an upload.
        """
        missing = [str(path) for path in paths if not path.exists()]
        if missing:
            raise XeniumError(f"missing from the bundle: {missing}")

    # --- manifest ---

    @cached_property
    def pixel_size(self) -> float:
        """``pixel_size`` (um/px) from experiment.xenium — the scale every
        micron-to-pixel transform uses (not whatever NimbusImage reports)."""
        manifest = self.directory / "experiment.xenium"
        self.require(manifest)
        with manifest.open() as fh:
            return float(json.load(fh)["pixel_size"])

    @cached_property
    def number_of_cells(self) -> int:
        self.require(self.cells_zarr)
        return int(open_zarr_zip(self.cells_zarr).attrs["number_cells"])

    # --- segmentation ---

    def polygons(self, polygon_set: str = CELL_POLYGON_SET):
        """``(num_vertices[N], vertices[N, 2*maxV])`` in MICRONS."""
        self.require(self.cells_zarr)
        group = open_zarr_zip(self.cells_zarr)
        names = list(group.attrs["polygon_set_names"])
        if polygon_set not in names:
            raise XeniumError(f"polygon set {polygon_set!r} not in {names}")
        polygons = group["polygon_sets"][str(names.index(polygon_set))]
        return polygons["num_vertices"][:], polygons["vertices"][:]

    def cell_index_by_id(self) -> dict[tuple[int, int], int]:
        """Packed zarr ``cell_id`` -> ``cell_index``."""
        packed = open_zarr_zip(self.cells_zarr)["cell_id"][:]
        return {(int(p), int(s)): i for i, (p, s) in enumerate(packed)}

    def cell_types(
        self, cell_types_csv: str | Path, *, complete: bool = True
    ) -> list:
        """Group label per ``cell_index`` from ``*_cell_types.csv``.

        Rows are joined on the decoded ``cell_id``; row order is not trusted.
        With ``complete`` (the default) a duplicate or a missing cell raises;
        otherwise missing cells are None.
        """
        index_of = self.cell_index_by_id()
        labels: list[str | None] = [None] * len(index_of)
        path = Path(cell_types_csv)
        self.require(path)
        with path.open(newline="", encoding="utf-8") as fh:
            reader = csv.DictReader(fh)
            if not {"cell_id", "group"} <= set(reader.fieldnames or []):
                raise XeniumError(
                    f"{path} needs cell_id and group columns, "
                    f"has {reader.fieldnames}"
                )
            for row in reader:
                try:
                    index = index_of[decode_cell_id(row["cell_id"])]
                except (KeyError, ValueError) as exc:
                    raise XeniumError(
                        f"cell_id {row.get('cell_id')!r} in {cell_types_csv} "
                        "is not a cell of this bundle"
                    ) from exc
                if complete and labels[index] is not None:
                    raise XeniumError(
                        f"duplicate cell_id {row['cell_id']} "
                        f"in {cell_types_csv}"
                    )
                labels[index] = row["group"].strip()
        if complete:
            missing = sum(1 for label in labels if label is None)
            if missing:
                raise XeniumError(
                    f"{missing} cells have no row in {cell_types_csv}"
                )
        return labels

    def cell_groups(self) -> dict[str, np.ndarray]:
        """Clusterings from analysis.zarr.zip (see ``decode_cell_groups``)."""
        self.require(self.analysis_zarr)
        return decode_cell_groups(self.analysis_zarr, self.number_of_cells)

    # --- counts ---

    def _feature_matrix(self):
        self.require(self.feature_matrix_zarr)
        return open_zarr_zip(self.feature_matrix_zarr)["cell_features"]

    def gene_rows(self, symbols: list[str]) -> dict[str, int]:
        """``{symbol: matrix row}`` for a gene panel, validated.

        Every symbol must name a ``feature_type == "gene"`` row: development
        panels omit canonical markers, so a missing one raises rather than
        silently uploading nothing. Protein panels reuse gene names (CD3E
        gene and CD3E antibody), so only gene rows are searched.
        """
        attrs = dict(self._feature_matrix().attrs)
        keys, types = attrs["feature_keys"], attrs["feature_types"]
        gene_row = {
            key: row
            for row, (key, kind) in enumerate(zip(keys, types))
            if kind == "gene"
        }
        missing = [symbol for symbol in symbols if symbol not in gene_row]
        if missing:
            raise XeniumError(
                f"not genes of this panel: {missing} — substitute and retry"
            )
        return {symbol: gene_row[symbol] for symbol in symbols}

    def gene_counts(
        self, symbols: list[str]
    ) -> dict[str, tuple[np.ndarray, np.ndarray]]:
        """``{symbol: (cell_indices, counts)}`` for a gene panel.

        Gene-major CSR makes one gene across all cells one contiguous slice,
        so a panel reads without the full matrix. See ``gene_rows`` for the
        validation.
        """
        rows = self.gene_rows(symbols)
        matrix = self._feature_matrix()
        indptr = matrix["indptr"][:]
        data, indices = matrix["data"], matrix["indices"]
        result = {}
        for symbol, row in rows.items():
            start, end = int(indptr[row]), int(indptr[row + 1])
            result[symbol] = (
                indices[start:end].astype(np.int64),
                data[start:end].astype(np.int64),
            )
        return result

    def counts(self, feature_types: tuple[str, ...] = ("gene", "protein")):
        """``(csc cells x features float32, symbols, feature_ids, kinds)``.

        The 10x matrix is gene-major CSR (row = feature, indices = cell). Read
        as ``(data, indices, indptr)`` with shape (cells, features) it IS the
        cells x features CSC matrix, so no transpose is materialized; dropping
        control rows is a column selection on that CSC. Proteins are named
        ``"<key> (protein)"``.
        """
        from scipy import sparse

        matrix = self._feature_matrix()
        attrs = dict(matrix.attrs)
        n_features, n_cells = int(attrs["number_features"]), int(
            attrs["number_cells"]
        )
        types = np.asarray(attrs["feature_types"])
        csc = sparse.csc_matrix(
            (
                matrix["data"][:].astype(np.float32),
                matrix["indices"][:].astype(np.int32),
                matrix["indptr"][:].astype(np.int64),
            ),
            shape=(n_cells, n_features),
        )
        keep = np.flatnonzero(np.isin(types, feature_types))
        keys = np.asarray(attrs["feature_keys"])[keep]
        kinds = [str(t) for t in types[keep]]
        symbols = [
            str(key) + (PROTEIN_SUFFIX if kind == "protein" else "")
            for key, kind in zip(keys, kinds)
        ]
        feature_ids = [str(f) for f in np.asarray(attrs["feature_ids"])[keep]]
        return csc[:, keep], symbols, feature_ids, kinds

    # --- images ---

    def morphology_files(self) -> list[Path]:
        """``morphology_focus/*.ome.tif`` in order (one file per channel)."""
        files = sorted((self.directory / "morphology_focus").glob("*.ome.tif"))
        if not files:
            raise XeniumError(
                f"no morphology_focus/*.ome.tif in {self.directory}"
            )
        return files

    def morphology_channel_names(self) -> dict[Path, str]:
        """Stain name per morphology file, from the OME metadata.

        File names can't supply them: XOA 1-3 ships
        ``morphology_focus_000N.ome.tif`` and XOA 4 ``ch00NN_<stain>.ome.tif``,
        which NimbusImage's filename parser splits on ``_``.
        """
        import tifffile

        files = self.morphology_files()
        with tifffile.TiffFile(files[0]) as tiff:
            xml = tiff.ome_metadata or ""
        return ome_channel_names(xml, files)

"""Write molecules as a transcript store the SpatialPlugin can register.

The plugin reads one layout, 10x Xenium's ``transcripts.zarr.zip`` (see
``codebaseDocumentation/SPATIAL_PLUGIN.md``, "the transcript layer"), so a
Spatial Genomics transcript list is rewritten into it::

    attrs gene_names
    grids attrs number_levels, grid_size [250], grid_keys, grid_number_objects
    grids/{L}/{gx},{gy}   tiles of 250 um * 2**L from the origin, rows sorted
                          by gene; gene_offset[g] = [lowStart, lowEnd,
                          highStart, highEnd]
      level 0             location (x, y, z um), quality_score,
                          gene_identity, id
      level L > 0         each gene's molecules merged on a grid of
                          0.5 um * 2**L: location (centroid),
                          gene_identity, cluster_count
    density/gene          attrs rows, cols, grid_size [10]; CSR over
                          (gene * rows + row) of a 10 um grid

The store is written in zarr format 2 (the server reads with zarr 2),
through either zarr 2 or zarr 3 on the client.
"""

from __future__ import annotations

import os
import tempfile
import time
from pathlib import Path

import numpy as np

from nimbusimage.sg.errors import SGError

TILE_MICRONS = 250.0
LEVELS = 7
MERGE_MICRONS = 0.5
DENSITY_MICRONS = 10.0
# Spatial Genomics reports no per-molecule quality. Every molecule goes in
# the high-quality run (>= the plugin's 20) so none is hidden by the
# overlay's threshold.
DEFAULT_QUALITY = 40.0


def _open_v2_group(path: Path):
    import zarr

    try:
        return zarr.open_group(str(path), mode="w", zarr_format=2)
    except TypeError:  # zarr 2: no zarr_format, always format 2
        return zarr.open_group(str(path), mode="w")


def _array(group, name: str, data: np.ndarray):
    if hasattr(group, "create_array"):  # zarr 3
        return group.create_array(name, data=data)
    return group.create_dataset(name, data=data)


def _zip_directory(directory: Path, out: Path) -> None:
    from nimbusimage.xenium.ingest import _zip_directory as zip_directory

    zip_directory(directory, out)


def _tiles(xy: np.ndarray, size: float):
    """Row indices of each non-empty tile, as ``(key, indices)``."""
    tx = np.floor(xy[:, 0] / size).astype(np.int64)
    ty = np.floor(xy[:, 1] / size).astype(np.int64)
    tile_id = ty * (int(tx.max()) + 1) + tx
    order = np.argsort(tile_id, kind="stable")
    bounds = np.flatnonzero(np.diff(tile_id[order])) + 1
    for chunk in np.split(order, bounds):
        yield f"{tx[chunk[0]]},{ty[chunk[0]]}", chunk


def _write_tile(group, key, n_genes, genes, location, extra) -> None:
    order = np.argsort(genes, kind="stable")
    genes = genes[order]
    gene_range = np.arange(n_genes)
    starts = np.searchsorted(genes, gene_range, "left")
    ends = np.searchsorted(genes, gene_range, "right")
    # Low-quality run empty, all molecules in the high run.
    offsets = np.stack([starts, starts, starts, ends], axis=1)
    tile = group.create_group(key)
    _array(tile, "gene_offset", offsets.astype(np.int64))
    _array(tile, "location", np.ascontiguousarray(location[order]))
    _array(tile, "gene_identity", genes.astype(np.uint16)[:, None])
    for name, values in extra.items():
        _array(tile, name, np.ascontiguousarray(values[order]))


def _merge(genes, location, counts, cell):
    """Merge points of the same gene on a grid of ``cell`` microns:
    count-weighted centroids, so merging merged points stays exact."""
    bx = np.floor(location[:, 0] / cell).astype(np.int64)
    by = np.floor(location[:, 1] / cell).astype(np.int64)
    nx, ny = int(bx.max()) + 1, int(by.max()) + 1
    key = (genes * ny + by) * nx + bx
    unique, inverse = np.unique(key, return_inverse=True)
    inverse = inverse.ravel()
    weight = counts.astype(np.float64)
    merged_counts = np.bincount(inverse, weights=weight)
    merged = np.empty((len(unique), 3), np.float64)
    for axis in range(3):
        merged[:, axis] = np.bincount(
            inverse, weights=location[:, axis] * weight
        ) / merged_counts
    merged_genes = (unique // (nx * ny)).astype(np.int64)
    return merged_genes, merged.astype(np.float32), merged_counts


def write_transcript_store(
    gene_names: list[str],
    genes: np.ndarray,
    xyz: np.ndarray,
    out: str | os.PathLike,
    *,
    source: dict | None = None,
    quality: float = DEFAULT_QUALITY,
    levels: int = LEVELS,
) -> Path:
    """Write ``out`` (a ``.zarr.zip``) from per-molecule gene indices into
    ``gene_names`` and ``[n, 3]`` micron positions. ``source`` is stored as
    the root attribute ``nimbus_source`` (``register_transcripts`` checks
    it against the cell map). Returns ``out``."""
    out = Path(out)
    genes = np.asarray(genes, dtype=np.int64)
    xyz = np.asarray(xyz, dtype=np.float32)
    n_genes = len(gene_names)
    if levels < 1:
        raise SGError(f"levels must be >= 1, got {levels}")
    if len(genes) == 0:
        raise SGError("no molecules to write")
    if len(set(gene_names)) != n_genes:
        raise SGError("gene names must be unique")
    if n_genes > np.iinfo(np.uint16).max:
        raise SGError(f"{n_genes} genes do not fit gene_identity (uint16)")
    if xyz.ndim != 2 or xyz.shape != (len(genes), 3):
        raise SGError(f"xyz must be [n, 3], got {xyz.shape}")
    if genes.min() < 0 or genes.max() >= n_genes:
        raise SGError("a molecule's gene index is outside gene_names")
    if not np.isfinite(xyz).all() or (xyz[:, :2] < 0).any():
        raise SGError("molecule positions must be finite and non-negative")
    started = time.time()
    with tempfile.TemporaryDirectory() as tmp:
        directory = Path(tmp) / "transcripts.zarr"
        root = _open_v2_group(directory)
        root.attrs["gene_names"] = list(gene_names)
        root.attrs["nimbus_source"] = dict(source or {})
        grids = root.create_group("grids")
        all_keys, all_counts = [], []
        level_genes, location = genes, xyz
        level_counts = np.ones(len(genes), np.float64)
        for level in range(levels):
            group = grids.create_group(str(level))
            if level > 0:
                level_genes, location, level_counts = _merge(
                    level_genes, location, level_counts,
                    MERGE_MICRONS * 2 ** level,
                )
            keys, counts = [], []
            for key, rows in _tiles(location, TILE_MICRONS * 2 ** level):
                if level == 0:
                    extra = {
                        "quality_score": np.full(
                            (len(rows), 1), quality, np.float32
                        ),
                        "id": rows.astype(np.uint64)[:, None],
                    }
                else:
                    extra = {
                        "cluster_count": level_counts[rows]
                        .astype(np.uint32)[:, None]
                    }
                _write_tile(
                    group, key, n_genes, level_genes[rows], location[rows],
                    extra,
                )
                keys.append(key)
                counts.append(int(len(rows)))
            all_keys.append(keys)
            all_counts.append(counts)
        grids.attrs.update(
            {
                "number_levels": levels,
                "grid_size": [TILE_MICRONS],
                "grid_keys": all_keys,
                "grid_number_objects": all_counts,
            }
        )
        _write_density(root, genes, xyz, n_genes)
        _zip_directory(directory, out)
    _log(
        "wrote %s: %s molecules, %d genes, %.0f MB (%.0fs)",
        out, f"{len(genes):,}", n_genes, out.stat().st_size / 1e6,
        time.time() - started,
    )
    return out


def _write_density(root, genes, xyz, n_genes) -> None:
    cols = int(np.floor(xyz[:, 0].max() / DENSITY_MICRONS)) + 1
    rows = int(np.floor(xyz[:, 1].max() / DENSITY_MICRONS)) + 1
    row = np.floor(xyz[:, 1] / DENSITY_MICRONS).astype(np.int64)
    col = np.floor(xyz[:, 0] / DENSITY_MICRONS).astype(np.int64)
    unique, data = np.unique(
        (genes * rows + row) * cols + col, return_counts=True
    )
    gene_row = unique // cols  # sorted: gene * rows + row
    indptr = np.searchsorted(gene_row, np.arange(n_genes * rows + 1))
    density = root.create_group("density").create_group("gene")
    density.attrs.update(
        {"rows": rows, "cols": cols, "grid_size": [DENSITY_MICRONS]}
    )
    _array(density, "indptr", indptr.astype(np.int64))
    _array(density, "indices", (unique % cols).astype(np.int32))
    _array(density, "data", data.astype(np.uint32))


def _log(message, *args) -> None:
    import logging

    logging.getLogger("nimbusimage.sg").info(message, *args)

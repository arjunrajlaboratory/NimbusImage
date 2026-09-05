"""Shared helpers for the Xenium -> NimbusImage ingest scripts.

Every script in this directory imports from here. Nothing is dataset-specific:
paths, ids, and the pixel size come from the command line, credentials from
the environment (NI_API_URL + NI_API_KEY, or NI_USERNAME + NI_PASSWORD).
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import numpy as np
import zarr

import nimbusimage as ni

CELL_POLYGON_SET = "cell"
NUCLEUS_POLYGON_SET = "nucleus"


def log(message: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {message}", file=sys.stderr, flush=True)


def connect():
    """ni.connect() from the environment; username/password as a fallback."""
    if os.environ.get("NI_API_KEY") or os.environ.get("NI_TOKEN"):
        return ni.connect()
    username, password = os.environ.get("NI_USERNAME"), os.environ.get("NI_PASSWORD")
    if not (username and password):
        raise SystemExit(
            "set NI_API_URL and NI_API_KEY (or NI_USERNAME + NI_PASSWORD) in the environment"
        )
    return ni.connect(username=username, password=password)


def open_zarr_zip(path: Path):
    return zarr.open_group(zarr.storage.ZipStore(str(path), mode="r"), mode="r")


def read_pixel_size(bundle_dir: Path) -> float:
    """`pixel_size` (µm/px) from experiment.xenium — the scale every transform uses."""
    with (bundle_dir / "experiment.xenium").open() as fh:
        return float(json.load(fh)["pixel_size"])


def load_polygon_set(cells_zarr: Path, name: str = CELL_POLYGON_SET):
    """(num_vertices[N], vertices[N, 2*maxV]) in MICRONS for the named polygon set."""
    group = open_zarr_zip(cells_zarr)
    names = list(group.attrs["polygon_set_names"])
    if name not in names:
        raise SystemExit(f"polygon set {name!r} not in {names}")
    polygon_set = group["polygon_sets"][str(names.index(name))]
    return polygon_set["num_vertices"][:], polygon_set["vertices"][:]


def number_of_cells(cells_zarr: Path) -> int:
    return int(open_zarr_zip(cells_zarr).attrs["number_cells"])


def inverse_alignment(alignment_csv: Path | None) -> np.ndarray | None:
    """`*_he_imagealignment.csv` maps H&E px -> morphology px. Annotations live
    in morphology px, so drawing them on the H&E image needs the INVERSE."""
    if alignment_csv is None:
        return None
    matrix = np.loadtxt(alignment_csv, delimiter=",")
    if matrix.shape != (3, 3):
        raise SystemExit(f"alignment matrix must be 3x3, got {matrix.shape}")
    return np.linalg.inv(matrix)


def microns_to_pixels(xy_um: np.ndarray, pixel_size: float, inverse_alignment_matrix=None):
    """[K, 2] microns -> [K, 2] pixels of the target image."""
    xy = xy_um / pixel_size
    if inverse_alignment_matrix is None:
        return xy
    homogeneous = np.column_stack([xy, np.ones(len(xy))])
    return (inverse_alignment_matrix @ homogeneous.T).T[:, :2]


def polygon_coordinates(vertices_um, n_vertices, pixel_size, inverse_alignment_matrix=None):
    """One polygon's NimbusImage coordinate list from its interleaved micron vertices."""
    xy_um = vertices_um[: 2 * n_vertices].reshape(-1, 2)
    xy = microns_to_pixels(xy_um, pixel_size, inverse_alignment_matrix)
    return [{"x": float(x), "y": float(y)} for x, y in xy]


def decode_cell_id(cell_id: str) -> tuple[int, int]:
    """CSV 'aaaaadoa-1' -> zarr (992, 1): first 8 chars are nibbles a..p = 0..15."""
    prefix, suffix = cell_id.split("-")
    value = 0
    for char in prefix:
        value = (value << 4) | (ord(char) - ord("a"))
    return value, int(suffix)


def cell_index_by_id(cells_zarr: Path) -> dict[tuple[int, int], int]:
    packed = open_zarr_zip(cells_zarr)["cell_id"][:]
    return {(int(p), int(s)): i for i, (p, s) in enumerate(packed)}


def fetch_annotation_ids(ds, cells_zarr: Path, pixel_size: float,
                         inverse_alignment_matrix=None, page: int = 20000,
                         polygon_set: str = CELL_POLYGON_SET) -> np.ndarray:
    """Annotation ids in cell_index order, VERIFIED against the segmentation.

    ds.annotations.list() returns creation order, so row i is cell i when the
    polygons were uploaded in cell_index order — but a silent off-by-N here
    attaches every cell's data to the wrong cell, so each annotation's first
    vertex is checked against the vertex recomputed from cells.zarr.
    """
    n_vertices, vertices = load_polygon_set(cells_zarr, polygon_set)
    n_cells = len(n_vertices)
    ids = np.empty(n_cells, dtype=object)
    firsts = np.empty((n_cells, 2))
    offset = 0
    while offset < n_cells:
        chunk = ds.annotations.list(shape="polygon", limit=page, offset=offset)
        if not chunk:
            break
        for j, annotation in enumerate(chunk):
            i = offset + j
            if i >= n_cells:
                break
            ids[i] = annotation.id
            firsts[i] = (annotation.coordinates[0]["x"], annotation.coordinates[0]["y"])
        offset += len(chunk)
        log(f"  fetched {min(offset, n_cells):,}/{n_cells:,} annotation ids")
    if offset < n_cells:
        raise SystemExit(f"only {offset} of {n_cells} annotations exist in the dataset")
    expected = microns_to_pixels(vertices[:, :2], pixel_size, inverse_alignment_matrix)
    mismatches = int(np.sum(np.any(np.abs(expected - firsts) > 0.01, axis=1)))
    if mismatches:
        raise SystemExit(
            f"ABORT: {mismatches} annotations' first vertex != the cell's first vertex; "
            "the dataset's polygons are not in cell_index order"
        )
    log(f"  verified {n_cells:,} annotations map to their cell_index (0 mismatches)")
    return ids


def load_or_fetch_annotation_ids(ds, ids_path: Path | None, cells_zarr: Path,
                                 pixel_size: float, inverse_alignment_matrix=None):
    """Use a cached `--ids` .npy when present and complete; otherwise fetch,
    verify, and cache it there.

    Entries may be None: the polygon upload skips degenerate polygons (fewer
    than three vertices) and leaves their slot empty, so consumers iterate
    with `cell_indices_with_annotations(ids)` rather than `range(len(ids))`.
    """
    n_cells = number_of_cells(cells_zarr)
    if ids_path and ids_path.exists():
        ids = np.load(ids_path, allow_pickle=True)
        if len(ids) == n_cells:
            log(f"  using cached annotation ids from {ids_path}")
            return ids
        log(f"  {ids_path} holds {len(ids)} ids, expected {n_cells}; refetching")
    ids = fetch_annotation_ids(ds, cells_zarr, pixel_size, inverse_alignment_matrix)
    if ids_path:
        np.save(ids_path, ids)
        log(f"  cached annotation ids to {ids_path}")
    return ids


def ensure_property(ds, name: str, shape: str = "polygon"):
    """Client-side property (no worker) registered into the dataset's collections."""
    prop = ds.properties.get_or_create(name, shape=shape)
    # Idempotent: register() appends the id only where it is missing, so a
    # re-run never raises for an already-registered property.
    ds.properties.register(prop.id)
    return prop


def cell_indices_with_annotations(ids, start: int, stop: int):
    """Cell indices in [start, stop) that have an annotation (skips the None
    slots left by degenerate polygons)."""
    return [c for c in range(start, stop) if ids[c] is not None]

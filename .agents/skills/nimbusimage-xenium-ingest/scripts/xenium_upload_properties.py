#!/usr/bin/env python3
"""Attach per-cell Xenium data to NimbusImage cell annotations as nested properties.

One property carries many sub-values (`values[propertyId][subKey]`), so:

    Gene Expression  -> {"MS4A1": 3, "CD3E": 0, ...}     a marker panel, dense
    Clustering       -> {"graphclust": 12, "kmeans_2_clusters": 1, ...}
    UMAP             -> {"x": 1.23, "y": 4.56}            (from xenium_compute_umap.py)

Never upload the whole matrix: 4,624 genes x 700k cells is billions of values.
Pick a marker panel (`--genes`), verify every symbol exists, upload DENSE so
the UI can tell zero from missing.

`submit_values` does NOT overwrite existing values (silent no-op). To replace,
pass `--replace`, which deletes the property's values for this dataset first.

    python xenium_upload_properties.py --bundle-dir extracted/ --dataset <folderId> \
        --ids ann_ids_morphology.npy --what genes --genes MS4A1,CD19,CD3E --limit 2000
    python xenium_upload_properties.py --bundle-dir extracted/ --dataset <folderId> \
        --ids ann_ids_morphology.npy --what genes,clusters,umap --genes-file panel.txt \
        --umap umap_xy.npy
"""
from __future__ import annotations

import argparse
import time
from pathlib import Path

import numpy as np

from xenium_common import (
    cell_indices_with_annotations,
    connect,
    ensure_property,
    inverse_alignment,
    load_or_fetch_annotation_ids,
    log,
    number_of_cells,
    open_zarr_zip,
    read_pixel_size,
)


def submit(ds, prop, values: dict, label: str) -> None:
    ds.properties.submit_values(prop.id, values)
    log(f"    {label}: {len(values):,} annotations")


def prepare_property(ds, name: str, replace: bool):
    prop = ensure_property(ds, name)
    if replace:
        ds.properties.delete_values(prop.id)
        log(f"  deleted existing {name!r} values for this dataset")
    return prop


def upload_genes(ds, ids, panel, bundle_dir, chunk, dense, limit, replace):
    matrix = open_zarr_zip(bundle_dir / "cell_feature_matrix.zarr.zip")["cell_features"]
    attrs = dict(matrix.attrs)
    keys, types = list(attrs["feature_keys"]), list(attrs["feature_types"])
    missing = [symbol for symbol in panel if symbol not in keys]
    if missing:
        raise SystemExit(f"not in this panel: {missing} — substitute and retry")
    rows = {symbol: keys.index(symbol) for symbol in panel}
    for symbol, row in rows.items():
        if types[row] != "gene":
            raise SystemExit(f"{symbol} is a {types[row]}, not a gene")

    # Gene-major CSR: one gene across all cells is one contiguous slice.
    indptr = matrix["indptr"][:]
    data, indices = matrix["data"], matrix["indices"]
    gene_cells, gene_values = {}, {}
    for symbol, row in rows.items():
        start, end = int(indptr[row]), int(indptr[row + 1])
        gene_cells[symbol] = indices[start:end].astype(np.int64)
        gene_values[symbol] = data[start:end].astype(np.int64)

    prop = prepare_property(ds, "Gene Expression", replace)
    stop = min(limit or len(ids), len(ids))
    started = time.time()
    for c0 in range(0, stop, chunk):
        c1 = min(c0 + chunk, stop)
        buckets = [({symbol: 0 for symbol in panel} if dense else {}) for _ in range(c1 - c0)]
        for symbol in panel:
            cells, values = gene_cells[symbol], gene_values[symbol]
            lo, hi = np.searchsorted(cells, c0), np.searchsorted(cells, c1)
            for cell, value in zip(cells[lo:hi], values[lo:hi]):
                buckets[cell - c0][symbol] = int(value)
        submit(ds, prop, {
            ids[c]: buckets[c - c0]
            for c in cell_indices_with_annotations(ids, c0, c1)
            if buckets[c - c0]
        }, f"genes, cells {c0:,}-{c1:,}")
    log(f"  GENES done: {stop:,} cells x {len(panel)} genes ({time.time() - started:.0f}s)")


def decode_cell_groups(analysis_zarr: Path, n_cells: int) -> dict[str, np.ndarray]:
    """{grouping: labels[n_cells]} with 0 = unassigned, 1-based cluster ids.

    `indices` is ZERO-PADDED: unassigned cells occupy slots holding 0, so cell
    0 appears many times. A zero is genuine only as the FIRST element of its
    block (blocks are strictly ascending). Decoding naively gives cell 0 the
    last cluster id of every grouping.
    """
    groups = open_zarr_zip(analysis_zarr)["cell_groups"]
    labels = {}
    for group_index, name in enumerate(groups.attrs["grouping_names"]):
        indices = groups[str(group_index)]["indices"][:]
        pointers = np.append(groups[str(group_index)]["indptr"][:], len(indices))
        label = np.zeros(n_cells, dtype=np.int32)
        for k in range(len(pointers) - 1):
            block = indices[int(pointers[k]):int(pointers[k + 1])]
            if len(block) == 0:
                continue
            keep = block > 0
            if block[0] == 0:
                keep[0] = True
            label[block[keep]] = k + 1
        short = name.replace("gene_expression_", "")
        labels[short] = label
        unassigned = int((label == 0).sum())
        log(f"  {short}: {int(label.max())} clusters, {unassigned} unassigned")
    return labels


def upload_clusters(ds, ids, bundle_dir, chunk, limit, replace):
    labels = decode_cell_groups(bundle_dir / "analysis.zarr.zip", len(ids))
    prop = prepare_property(ds, "Clustering", replace)
    stop = min(limit or len(ids), len(ids))
    for c0 in range(0, stop, chunk):
        c1 = min(c0 + chunk, stop)
        submit(ds, prop, {
            ids[c]: {name: int(label[c]) for name, label in labels.items()}
            for c in cell_indices_with_annotations(ids, c0, c1)
        }, f"clusters, cells {c0:,}-{c1:,}")
    log(f"  CLUSTERS done: {stop:,} cells")


def upload_umap(ds, ids, umap_path: Path, chunk, limit, replace):
    embedding = np.load(umap_path)
    if embedding.shape != (len(ids), 2):
        raise SystemExit(f"{umap_path} is {embedding.shape}, expected ({len(ids)}, 2)")
    prop = prepare_property(ds, "UMAP", replace)
    stop = min(limit or len(ids), len(ids))
    for c0 in range(0, stop, chunk):
        c1 = min(c0 + chunk, stop)
        submit(ds, prop, {
            ids[c]: {"x": float(embedding[c, 0]), "y": float(embedding[c, 1])}
            for c in cell_indices_with_annotations(ids, c0, c1)
        }, f"umap, cells {c0:,}-{c1:,}")
    log(f"  UMAP done: {stop:,} cells")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--bundle-dir", type=Path, required=True)
    parser.add_argument("--dataset", required=True, help="NimbusImage dataset (folder) id")
    parser.add_argument("--ids", type=Path, default=None,
                        help=".npy of annotation ids in cell_index order (from the polygon "
                             "upload); fetched and verified if absent, then cached here")
    parser.add_argument("--alignment", type=Path, default=None,
                        help="H&E alignment csv, needed to VERIFY ids on the H&E dataset")
    parser.add_argument("--what", default="genes",
                        help="comma-separated subset of genes,clusters,umap")
    parser.add_argument("--genes", default=None, help="comma-separated gene symbols")
    parser.add_argument("--genes-file", type=Path, default=None,
                        help="file with one gene symbol per line (# comments allowed)")
    parser.add_argument("--umap", type=Path, default=None, help="umap_xy.npy")
    parser.add_argument("--chunk", type=int, default=20000)
    parser.add_argument("--limit", type=int, default=None, help="only the first N cells")
    parser.add_argument("--sparse", action="store_true",
                        help="genes: omit zero counts (default dense, explicit zeros)")
    parser.add_argument("--replace", action="store_true",
                        help="delete the property's existing values first")
    args = parser.parse_args()

    what = {item.strip() for item in args.what.split(",")}
    unknown = what - {"genes", "clusters", "umap"}
    if unknown:
        raise SystemExit(f"unknown --what entries: {sorted(unknown)}")
    panel = []
    if "genes" in what:
        if args.genes:
            panel = [symbol.strip() for symbol in args.genes.split(",") if symbol.strip()]
        elif args.genes_file:
            panel = [line.split("#")[0].strip() for line in args.genes_file.read_text().splitlines()]
            panel = [symbol for symbol in panel if symbol]
        if not panel:
            raise SystemExit("--what genes needs --genes or --genes-file")
    if "umap" in what and not args.umap:
        raise SystemExit("--what umap needs --umap umap_xy.npy (see xenium_compute_umap.py)")

    cells_zarr = args.bundle_dir / "cells.zarr.zip"
    ds = connect().dataset(args.dataset)
    log(f"=== {ds.name} ({number_of_cells(cells_zarr):,} cells) ===")
    ids = load_or_fetch_annotation_ids(
        ds, args.ids, cells_zarr, read_pixel_size(args.bundle_dir),
        inverse_alignment(args.alignment),
    )
    if "genes" in what:
        upload_genes(ds, ids, panel, args.bundle_dir, args.chunk, not args.sparse,
                     args.limit, args.replace)
    if "clusters" in what:
        upload_clusters(ds, ids, args.bundle_dir, args.chunk, args.limit, args.replace)
    if "umap" in what:
        upload_umap(ds, ids, args.umap, args.chunk, args.limit, args.replace)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

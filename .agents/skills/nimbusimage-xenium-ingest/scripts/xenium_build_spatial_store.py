#!/usr/bin/env python3
"""Build a dataset's `spatial.zarr.zip` from a Xenium bundle, upload it, register it.

The store is an AnnData written with `anndata` (zarr v2) and zipped:

    X              counts, cells x genes, CSC  (the 10x gene-major CSR, reinterpreted)
    layers/X_csr   the same counts, CSR, for per-cell reads
    obs            annotation_id (the NimbusImage cell annotation, the ONLY join key),
                   cell_index, cell_type (from --cell-types), one column per clustering
    var            index = gene symbol; gene_id; feature_type (genes only)
    obsm/X_umap    from --umap (xenium_compute_umap.py), optional
    uns/nimbus     schemaVersion, datasetId, source bundle, created

Then `POST spatial/{dataset}/register {itemId}` makes NimbusImage serve it:
feature search, per-gene and per-cell reads, aggregation under any filter or
gate, and "materialize" of a gene panel into a property.

    python xenium_build_spatial_store.py --bundle-dir extracted --dataset <folderId> \
        --ids ids_morph.npy --cell-types cell_types.csv --umap umap/umap_xy.npy \
        --out spatial.zarr.zip

Requires anndata, scipy, zarr (any major), numpy, nimbusimage.
"""
from __future__ import annotations

import argparse
import csv
import datetime
import os
import tempfile
import time
import zipfile
from pathlib import Path

import numpy as np
from scipy import sparse

from xenium_common import (
    cell_index_by_id,
    connect,
    decode_cell_id,
    inverse_alignment,
    load_or_fetch_annotation_ids,
    log,
    number_of_cells,
    open_zarr_zip,
    read_pixel_size,
)

from xenium_upload_properties import decode_cell_groups  # sibling script

SCHEMA_VERSION = 1


def load_counts(bundle_dir: Path):
    """(csc cells x genes float32, symbols, gene_ids) for feature_type == gene.

    The 10x matrix is gene-major CSR (row = feature, indices = cell). Read as
    (data, indices, indptr) with shape (cells, genes) it IS the cells x genes CSC
    matrix, so no transpose is materialized; dropping the control rows is a
    column selection on that CSC.
    """
    matrix = open_zarr_zip(bundle_dir / "cell_feature_matrix.zarr.zip")["cell_features"]
    attrs = dict(matrix.attrs)
    n_features, n_cells = int(attrs["number_features"]), int(attrs["number_cells"])
    types = np.asarray(attrs["feature_types"])
    csc = sparse.csc_matrix(
        (matrix["data"][:].astype(np.float32), matrix["indices"][:].astype(np.int32),
         matrix["indptr"][:].astype(np.int64)),
        shape=(n_cells, n_features),
    )
    is_gene = np.flatnonzero(types == "gene")
    symbols = np.asarray(attrs["feature_keys"])[is_gene]
    gene_ids = np.asarray(attrs["feature_ids"])[is_gene]
    return csc[:, is_gene], [str(s) for s in symbols], [str(g) for g in gene_ids]


def load_cell_types(cells_zarr: Path, cell_types_csv: Path, n_cells: int) -> list[str | None]:
    index_of = cell_index_by_id(cells_zarr)
    labels: list[str | None] = [None] * n_cells
    with cell_types_csv.open(newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            labels[index_of[decode_cell_id(row["cell_id"])]] = row["group"].strip()
    return labels


def zip_directory(directory: Path, out: Path) -> None:
    """Zip `directory` so entries sit at the archive root (what zarr.ZipStore
    opens). Chunks are already blosc-compressed, so ZIP_STORED."""
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_STORED) as zf:
        for path in sorted(directory.rglob("*")):
            if path.is_file():
                zf.write(path, path.relative_to(directory).as_posix())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--bundle-dir", type=Path, required=True)
    parser.add_argument("--dataset", required=True, help="NimbusImage dataset (folder) id")
    parser.add_argument("--ids", type=Path, default=None,
                        help=".npy of annotation ids in cell_index order (from the polygon "
                             "upload); fetched and verified if absent")
    parser.add_argument("--alignment", type=Path, default=None,
                        help="H&E alignment csv, needed to VERIFY ids on the H&E dataset")
    parser.add_argument("--cell-types", type=Path, default=None, help="*_cell_types.csv")
    parser.add_argument("--umap", type=Path, default=None, help="umap_xy.npy")
    parser.add_argument("--out", type=Path, default=Path("spatial.zarr.zip"))
    parser.add_argument("--no-upload", action="store_true",
                        help="build the file only; do not upload or register")
    args = parser.parse_args()

    import anndata as ad
    import pandas as pd
    ad.settings.zarr_write_format = 2  # the server reads with zarr 2

    started = time.time()
    cells_zarr = args.bundle_dir / "cells.zarr.zip"
    n_cells = number_of_cells(cells_zarr)
    client = connect()
    ds = client.dataset(args.dataset)
    log(f"=== {ds.name} ({n_cells:,} cells) ===")
    ids = load_or_fetch_annotation_ids(
        ds, args.ids, cells_zarr, read_pixel_size(args.bundle_dir),
        inverse_alignment(args.alignment),
    )
    with_annotation = np.array([value is not None for value in ids])
    if not with_annotation.all():
        log(f"  dropping {int((~with_annotation).sum())} cells without an annotation")

    counts, symbols, gene_ids = load_counts(args.bundle_dir)
    counts = counts[np.flatnonzero(with_annotation)]
    log(f"  counts: {counts.shape[0]:,} cells x {counts.shape[1]:,} genes, "
        f"nnz={counts.nnz:,} ({time.time() - started:.0f}s)")

    obs = pd.DataFrame(index=[str(i) for i in np.flatnonzero(with_annotation)])
    obs["annotation_id"] = np.array([str(v) for v in ids[with_annotation]], dtype=object)
    obs["cell_index"] = np.flatnonzero(with_annotation).astype(np.int64)
    if args.cell_types:
        labels = load_cell_types(cells_zarr, args.cell_types, n_cells)
        obs["cell_type"] = pd.Categorical(
            [labels[i] for i in np.flatnonzero(with_annotation)]
        )
    for name, label in decode_cell_groups(args.bundle_dir / "analysis.zarr.zip", n_cells).items():
        obs[name] = label[with_annotation].astype(np.int32)

    var = pd.DataFrame(index=pd.Index(symbols, name="symbol"))
    var["gene_id"] = gene_ids
    var["feature_type"] = "gene"

    adata = ad.AnnData(X=counts, obs=obs, var=var)
    adata.layers["X_csr"] = counts.tocsr()
    if args.umap:
        embedding = np.load(args.umap)
        if embedding.shape != (n_cells, 2):
            raise SystemExit(f"{args.umap} is {embedding.shape}, expected ({n_cells}, 2)")
        adata.obsm["X_umap"] = embedding[with_annotation].astype(np.float32)
    adata.uns["nimbus"] = {
        "schemaVersion": SCHEMA_VERSION,
        "datasetId": args.dataset,
        "source": str(args.bundle_dir.resolve().name),
        "created": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }

    with tempfile.TemporaryDirectory() as tmp:
        store_dir = Path(tmp) / "spatial.zarr"
        adata.write_zarr(store_dir)
        zip_directory(store_dir, args.out)
    log(f"  wrote {args.out} ({os.path.getsize(args.out) / 1e6:.0f} MB, "
        f"{time.time() - started:.0f}s)")
    if args.no_upload:
        return 0

    gc = client.girder
    uploaded = gc.uploadFileToFolder(args.dataset, str(args.out))  # returns the FILE
    log(f"  uploaded as item {uploaded['itemId']}")
    entry = gc.post(f"spatial/{args.dataset}/register", json={"itemId": uploaded["itemId"]})
    log(f"  registered: {entry['nObs']:,} cells x {entry['nVar']:,} genes "
        f"(schema v{entry['schemaVersion']}); total {time.time() - started:.0f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

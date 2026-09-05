#!/usr/bin/env python3
"""Compute the UMAP that a Xenium bundle does NOT ship.

`analysis.zarr.zip` holds only `cell_groups` (clusterings) — no PCA, no UMAP.
Pipeline: gene rows of the counts matrix -> cells x genes -> normalize per cell
(1e4) -> log1p -> TruncatedSVD(--components) -> UMAP(2D).

Writes `<out>/umap_xy.npy` (float32 [N, 2], row i = cell_index i) and
`<out>/pca.npy` so the embedding can be re-derived without redoing the SVD.
Measured: ~335 s for 709k cells (20 s SVD + ~5 min UMAP).

Requires scipy, scikit-learn, umap-learn.

    python xenium_compute_umap.py --bundle-dir extracted/ --out outputs/
"""
from __future__ import annotations

import argparse
import time
from pathlib import Path

import numpy as np
from scipy import sparse

from xenium_common import log, open_zarr_zip


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--bundle-dir", type=Path, required=True)
    parser.add_argument("--out", type=Path, default=Path("."))
    parser.add_argument("--components", type=int, default=50)
    parser.add_argument("--n-neighbors", type=int, default=15)
    parser.add_argument("--min-dist", type=float, default=0.3)
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    started = time.time()
    matrix = open_zarr_zip(args.bundle_dir / "cell_feature_matrix.zarr.zip")["cell_features"]
    attrs = dict(matrix.attrs)
    n_features, n_cells = attrs["number_features"], attrs["number_cells"]
    is_gene = np.array(attrs["feature_types"]) == "gene"
    counts = sparse.csr_matrix(
        (matrix["data"][:].astype(np.float32), matrix["indices"][:].astype(np.int32),
         matrix["indptr"][:].astype(np.int64)),
        shape=(n_features, n_cells),
    )[is_gene]  # gene-major: rows are features
    log(f"{int(is_gene.sum())} genes x {n_cells:,} cells, nnz={counts.nnz:,}")

    cells = counts.T.tocsr()
    totals = np.asarray(cells.sum(axis=1)).ravel()
    totals[totals == 0] = 1.0
    cells = sparse.diags((1e4 / totals).astype(np.float32)) @ cells
    cells.data = np.log1p(cells.data, dtype=np.float32)

    from sklearn.decomposition import TruncatedSVD
    svd = TruncatedSVD(n_components=args.components, random_state=args.seed,
                       algorithm="randomized")
    components = svd.fit_transform(cells).astype(np.float32)
    np.save(args.out / "pca.npy", components)
    log(f"SVD done: explained variance {svd.explained_variance_ratio_.sum():.3f} "
        f"({time.time() - started:.0f}s)")

    import umap
    embedding = umap.UMAP(
        n_components=2, n_neighbors=args.n_neighbors, min_dist=args.min_dist,
        random_state=args.seed, low_memory=True,
    ).fit_transform(components).astype(np.float32)
    np.save(args.out / "umap_xy.npy", embedding)
    log(f"UMAP done -> {args.out / 'umap_xy.npy'} ({time.time() - started:.0f}s total)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

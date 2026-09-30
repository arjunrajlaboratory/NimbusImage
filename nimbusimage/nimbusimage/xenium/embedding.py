"""The UMAP a Xenium bundle does NOT ship.

``analysis.zarr.zip`` holds only ``cell_groups`` (clusterings) — no PCA, no
UMAP. Needs the ``xenium-umap`` extra (scikit-learn, umap-learn).
"""

from __future__ import annotations

import logging
import time
from pathlib import Path

import numpy as np

from nimbusimage.xenium.bundle import XeniumBundle

logger = logging.getLogger("nimbusimage.xenium")


def compute_umap(
    bundle: XeniumBundle,
    out_dir: str | Path | None = None,
    *,
    components: int = 50,
    n_neighbors: int = 15,
    min_dist: float = 0.3,
    seed: int = 0,
) -> np.ndarray:
    """float32 [N, 2] embedding, row i = cell_index i.

    Gene rows of the counts -> normalize per cell (1e4) -> log1p ->
    TruncatedSVD(``components``) -> UMAP(2D). With ``out_dir``, writes
    ``umap_xy.npy`` and ``pca.npy`` there. ~335 s for 709k cells.
    """
    from scipy import sparse
    from sklearn.decomposition import TruncatedSVD
    import umap

    if out_dir is not None:
        # Created up front: an unwritable path fails before minutes of work.
        out_dir = Path(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
    started = time.time()
    counts, _, _, _ = bundle.counts(feature_types=("gene",))
    logger.info(
        "%d genes x %s cells, nnz=%s",
        counts.shape[1],
        f"{counts.shape[0]:,}",
        f"{counts.nnz:,}",
    )
    cells = counts.tocsr()
    totals = np.asarray(cells.sum(axis=1)).ravel()
    totals[totals == 0] = 1.0
    cells = sparse.diags((1e4 / totals).astype(np.float32)) @ cells
    cells.data = np.log1p(cells.data, dtype=np.float32)

    svd = TruncatedSVD(
        n_components=components, random_state=seed, algorithm="randomized"
    )
    reduced = svd.fit_transform(cells).astype(np.float32)
    if out_dir is not None:
        # Saved before UMAP (the slow, memory-heavy step), so a failure there
        # can be retried from pca.npy without redoing the SVD.
        np.save(out_dir / "pca.npy", reduced)
    logger.info(
        "SVD done: explained variance %.3f (%.0fs)",
        svd.explained_variance_ratio_.sum(),
        time.time() - started,
    )

    embedding = (
        umap.UMAP(
            n_components=2,
            n_neighbors=n_neighbors,
            min_dist=min_dist,
            random_state=seed,
            low_memory=True,
        )
        .fit_transform(reduced)
        .astype(np.float32)
    )
    logger.info("UMAP done (%.0fs total)", time.time() - started)
    if out_dir is not None:
        np.save(out_dir / "umap_xy.npy", embedding)
        logger.info("  wrote %s", out_dir / "umap_xy.npy")
    return embedding

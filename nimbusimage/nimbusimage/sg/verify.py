"""Local checks of an export before (and independent of) any upload.

- :func:`check_frame`: cell centroids land on their own label in the
  segmentation mask at ``floor(um / pixel_size)`` — the frame the polygons
  and molecules will be drawn in.
- :func:`recount`: assigning every molecule to the mask label under it
  reproduces ``CellxGene.csv`` — molecules, cells and the matrix agree.

Mask lookups decode only the tiles they touch, so neither check reads a
whole (up to ~11 GB) label image.
"""

from __future__ import annotations

import os

import numpy as np

from nimbusimage.sg.errors import SGError
from nimbusimage.sg.export import SGRoi


def labels_at(
    path: str | os.PathLike, x: np.ndarray, y: np.ndarray
) -> np.ndarray:
    """Values of a (tiled) label TIFF's full-resolution level at integer
    pixel ``(x, y)``; out-of-image positions give 0."""
    import tifffile

    x = np.asarray(x, dtype=np.int64)
    y = np.asarray(y, dtype=np.int64)
    with tifffile.TiffFile(path) as tif:
        page = tif.series[0].levels[0].keyframe
        height, width = page.imagelength, page.imagewidth
        inside = (x >= 0) & (x < width) & (y >= 0) & (y < height)
        out = np.zeros(len(x), dtype=page.dtype)
        if not page.is_tiled:
            image = page.asarray()
            out[inside] = image[y[inside], x[inside]]
            return out
        tile_w, tile_h = page.tilewidth, page.tilelength
        tiles_x = -(-width // tile_w)
        tile = (y // tile_h) * tiles_x + (x // tile_w)
        rows = np.flatnonzero(inside)
        order = rows[np.argsort(tile[rows], kind="stable")]
        bounds = np.flatnonzero(np.diff(tile[order])) + 1
        handle = tif.filehandle
        for chunk in np.split(order, bounds):
            if not len(chunk):
                continue
            index = int(tile[chunk[0]])
            handle.seek(page.dataoffsets[index])
            data = handle.read(page.databytecounts[index])
            try:
                decoded, _, _ = page.decode(data, index)
            except (ImportError, ValueError) as exc:
                raise SGError(
                    f"cannot decode {path} (compression "
                    f"{page.compression!r}); install the sg extra "
                    f"(imagecodecs): {exc}"
                ) from exc
            block = np.asarray(decoded).reshape(tile_h, tile_w)
            ty, tx = divmod(index, tiles_x)
            out[chunk] = block[
                y[chunk] - ty * tile_h, x[chunk] - tx * tile_w
            ]
        return out


def _pixels(microns: np.ndarray, pixel_size: float) -> np.ndarray:
    # floor, not round: the convention CellxGene.csv was built with
    # (a mask recount with round loses ~6% of matrix entries).
    return np.floor(np.asarray(microns, np.float64) / pixel_size).astype(
        np.int64
    )


def check_frame(roi: SGRoi, sample: int = 300, seed: int = 0) -> dict:
    """Fraction of sampled cell centroids that land on their own label."""
    if sample < 1:
        raise SGError(f"sample must be >= 1, got {sample}")
    coords = roi.coordinates()
    picked = coords.sample(
        n=min(sample, len(coords)), random_state=seed
    )
    found = labels_at(
        roi.segmentation_path,
        _pixels(picked["center_x"], roi.pixel_size),
        _pixels(picked["center_y"], roi.pixel_size),
    )
    matched = int((found == picked.index.to_numpy()).sum())
    return {
        "checked": len(picked),
        "matched": matched,
        "fraction": matched / max(len(picked), 1),
    }


def recount(roi: SGRoi) -> dict:
    """Reassign every molecule by the mask and compare with CellxGene.csv.

    Returns molecule totals (inside cells, and in the matrix), the
    fraction of identical matrix entries, the correlation, and the
    largest per-entry difference.
    """
    labels, symbols, _, counts = roi.counts()
    gene_names, genes, xyz = roi.transcripts()
    if not len(genes):
        raise SGError("no molecules to recount")
    found = labels_at(
        roi.segmentation_path,
        _pixels(xyz[:, 0], roi.pixel_size),
        _pixels(xyz[:, 1], roi.pixel_size),
    ).astype(np.int64)
    row_of = np.full(int(max(labels.max(), found.max())) + 1, -1, np.int64)
    row_of[labels] = np.arange(len(labels))
    column_of = {s: i for i, s in enumerate(symbols)}
    gene_column = np.array(
        [column_of.get(name, -1) for name in gene_names], dtype=np.int64
    )
    rows = row_of[found]
    columns = gene_column[genes]
    keep = (found > 0) & (rows >= 0) & (columns >= 0)
    import scipy.sparse as sp

    mine = sp.csr_matrix(
        (np.ones(int(keep.sum())), (rows[keep], columns[keep])),
        shape=counts.shape,
    )
    theirs = counts.astype(np.float64)
    difference = abs(mine - theirs).tocsr()
    difference.eliminate_zeros()
    nonzero = (mine + theirs).nnz
    unequal = difference.nnz
    total_entries = counts.shape[0] * counts.shape[1]
    a = mine.toarray().ravel() if total_entries <= 5e7 else None
    correlation = None
    if a is not None:
        b = theirs.toarray().ravel()
        correlation = float(np.corrcoef(a, b)[0, 1])
    return {
        "molecules": int(len(genes)),
        "inCells": int(keep.sum()),
        "matrixTotal": int(theirs.sum()),
        "entriesEqual": 1 - unequal / total_entries,
        "nonzeroEntriesEqual": 1 - unequal / max(nonzero, 1),
        "maxDifference": int(difference.max()) if unequal else 0,
        "correlation": correlation,
    }

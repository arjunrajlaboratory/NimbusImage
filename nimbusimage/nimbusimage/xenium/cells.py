"""``CellMap``: which annotation is which cell, on which dataset, drawn how.

Every per-cell step (gene panel, clusterings, UMAP, cell types, the spatial
table) joins bundle data to annotations by ``cell_index``. The join is only
right if the ids belong to the dataset being written, were drawn from the
CELL polygons (nucleus order is not cell order), and cover exactly this
bundle's cells. ``CellMap`` carries those facts with the ids, and
``CellMap.check`` is the one guard every per-cell step runs before writing.

Its ``frame`` records how the polygons were drawn (image, pixel size,
alignment), so later steps reuse it instead of being re-told — and the saved
file can be verified on its own.
"""

from __future__ import annotations

import io
import json
import logging
import os
import pickle
import zipfile
import zlib
from pathlib import Path
from typing import TYPE_CHECKING

import numpy as np

from nimbusimage.xenium.bundle import CELL_POLYGON_SET, XeniumBundle
from nimbusimage.xenium.errors import XeniumError
from nimbusimage.xenium.geometry import ImageFrame

if TYPE_CHECKING:
    from nimbusimage.dataset import Dataset

logger = logging.getLogger("nimbusimage.xenium")

CELLS_FILE_FORMAT = 1
# Polygons carrying this tag are regions of interest, never cells: every
# spatial analysis (and the cell match below) leaves them out.
REGION_TAG = "region"
# How far a stored vertex may sit from where the frame puts it. Uploads by
# different code versions differ by ~1e-3 px at H&E scale (float32 vs
# float64 arithmetic), so matching is by tolerance, never exact equality.
VERIFY_TOLERANCE_PX = 0.01
# Grid for looking up candidate cells by first vertex; the 3x3 neighbourhood
# of a bucket covers any point within the tolerance.
MATCH_BUCKET_PX = 0.5


class CellMap:
    """Annotation id per polygon, in bundle order, for one dataset.

    ``ids[i]`` is the annotation drawn for polygon ``i`` of ``polygon_set``,
    or None where there is none (a degenerate polygon, or past ``--limit``).
    ``ids`` always has one slot per polygon, so a limited upload is still
    indexed by ``cell_index``.
    """

    def __init__(
        self,
        dataset_id: str,
        frame: ImageFrame,
        ids,
        polygon_set: str = CELL_POLYGON_SET,
    ):
        self.dataset_id = str(dataset_id)
        self.frame = frame
        self.ids = np.asarray(
            [None if i is None or i == "" else str(i) for i in ids],
            dtype=object,
        )
        self.polygon_set = polygon_set

    def __len__(self) -> int:
        return len(self.ids)

    def __repr__(self) -> str:
        return (
            f"CellMap(dataset_id={self.dataset_id!r}, {self.polygon_set}, "
            f"{self.count():,}/{len(self):,} with annotations, {self.frame})"
        )

    def count(self) -> int:
        return int(sum(i is not None for i in self.ids))

    def indices(self, start: int = 0, stop: int | None = None) -> list[int]:
        """Cell indices in [start, stop) that have an annotation."""
        stop = len(self.ids) if stop is None else min(stop, len(self.ids))
        return [c for c in range(start, stop) if self.ids[c] is not None]

    def check_dataset(self, ds: Dataset) -> None:
        """The map (and its frame) must be ``ds``'s."""
        if self.dataset_id != ds.id:
            raise XeniumError(
                f"these cells belong to dataset {self.dataset_id}, "
                f"not {ds.id}"
            )

    def check(self, bundle: XeniumBundle, ds: Dataset | None = None) -> None:
        """The guard every per-cell step runs before writing anything."""
        if ds is not None:
            self.check_dataset(ds)
        if self.polygon_set != CELL_POLYGON_SET:
            raise XeniumError(
                f"per-cell data needs the cell polygons; these are "
                f"{self.polygon_set!r} polygons, which are not in cell_index "
                "order"
            )
        if len(self.ids) != bundle.number_of_cells:
            raise XeniumError(
                f"{len(self.ids)} ids for {bundle.number_of_cells} cells: "
                "not this bundle's cell map"
            )

    # --- storage

    def save(self, path: str | os.PathLike) -> Path:
        """Write to ``path`` as-is (``.npz`` content, no pickled objects)."""
        path = Path(path)
        meta = {
            "format": CELLS_FILE_FORMAT,
            "datasetId": self.dataset_id,
            "polygonSet": self.polygon_set,
            "frame": self.frame.to_dict(),
        }
        buffer = io.BytesIO()
        np.savez(
            buffer,
            ids=np.array(
                ["" if i is None else i for i in self.ids], dtype=str
            ),
            meta=np.array(json.dumps(meta)),
        )
        try:
            path.write_bytes(buffer.getvalue())
        except OSError as exc:
            raise XeniumError(f"cannot write {path}: {exc}") from exc
        return path

    @classmethod
    def read(cls, path: str | os.PathLike) -> CellMap | np.ndarray:
        """A saved ``CellMap``, or the bare id array of a pre-CellMap
        ``--ids-out`` file (which records no dataset or frame).

        A saved map is read without unpickling anything. Only a bare-id
        ``.npy`` (an object array) needs pickle — read your own files only.
        """
        path = Path(path)
        if not path.is_file():
            raise XeniumError(f"no cells file at {path}")
        with path.open("rb") as fh:
            magic = fh.read(6)
        try:
            if zipfile.is_zipfile(path):
                with np.load(path, allow_pickle=False) as loaded:
                    meta = json.loads(str(loaded["meta"]))
                    if meta.get("format") != CELLS_FILE_FORMAT:
                        raise XeniumError(f"{path}: unknown cells file format")
                    return cls(
                        meta["datasetId"],
                        ImageFrame.from_dict(meta["frame"]),
                        loaded["ids"],
                        meta["polygonSet"],
                    )
            if magic != b"\x93NUMPY":
                raise XeniumError(f"{path} is not a cells file")
            # Only a real .npy gets pickle, which its object array needs;
            # np.load would otherwise unpickle any file handed to it.
            ids = np.load(path, allow_pickle=True)
        except (
            OSError,
            ValueError,
            KeyError,
            TypeError,
            EOFError,
            pickle.UnpicklingError,
            zipfile.BadZipFile,
            zlib.error,
        ) as exc:
            raise XeniumError(f"{path} is not a cells file: {exc}") from exc
        if not isinstance(ids, np.ndarray) or ids.ndim != 1:
            raise XeniumError(f"{path} is not a cells file")
        return ids


def read_frame(path: str | os.PathLike, ds: Dataset) -> ImageFrame:
    """The frame saved in ``ds``'s cells file — the one reader of a saved
    frame. A missing file, a bare-id file (which saves no frame) or another
    dataset's map is an error, never a silent fall back to a default."""
    stored = CellMap.read(path)
    if not isinstance(stored, CellMap):
        raise XeniumError(
            f"{path} is a bare-id file with no saved frame; state the frame "
            "(--image/--alignment/--pixel-size) instead"
        )
    stored.check_dataset(ds)
    return stored.frame


# --- deriving and verifying


def _first_vertex(annotation) -> tuple[float, float]:
    return annotation.coordinates[0]["x"], annotation.coordinates[0]["y"]


def fetch_cells(
    ds: Dataset,
    bundle: XeniumBundle,
    frame: ImageFrame,
    *,
    page: int = 20000,
) -> CellMap:
    """Re-derive a dataset's ``CellMap`` from the server by geometry.

    Each polygon annotation is matched to the cell whose first two vertices
    and vertex count ``frame`` puts at the same place — never by list
    position, which the server does not promise. So other polygons in the
    dataset (regions, nuclei) are ignored, a limited or partial upload maps
    the cells it has (the rest are None), and a cell uploaded twice, or two
    cells with the same geometry, is an error. ``frame`` is the one the
    upload used.
    """
    n_vertices = bundle.vertex_counts()
    leading = bundle.first_vertices(count=2)  # [N, 4]: x0 y0 x1 y1, microns
    usable = np.flatnonzero(n_vertices >= 3)
    # Each cell's first two vertices, where the frame draws them.
    first = frame.microns_to_pixels(leading[usable, 0:2])
    second = frame.microns_to_pixels(leading[usable, 2:4])
    buckets: dict[tuple[int, int], list[int]] = {}
    for row, (x, y) in enumerate(first):
        key = (int(x // MATCH_BUCKET_PX), int(y // MATCH_BUCKET_PX))
        buckets.setdefault(key, []).append(row)

    def cell_of(xy0, xy1, n) -> int | None:
        bx, by = int(xy0[0] // MATCH_BUCKET_PX), int(xy0[1] // MATCH_BUCKET_PX)
        hits = [
            row
            for dx in (-1, 0, 1)
            for dy in (-1, 0, 1)
            for row in buckets.get((bx + dx, by + dy), ())
            if n_vertices[usable[row]] == n
            and np.all(np.abs(first[row] - xy0) <= VERIFY_TOLERANCE_PX)
            and np.all(np.abs(second[row] - xy1) <= VERIFY_TOLERANCE_PX)
        ]
        if len(hits) > 1:
            raise XeniumError(
                f"cells {[int(usable[r]) for r in hits]} have the same first "
                "vertices and vertex count; their annotations can't be told "
                "apart — keep the file polygons --cells-out wrote"
            )
        return int(usable[hits[0]]) if hits else None

    ids = np.full(len(n_vertices), None, dtype=object)
    seen = 0
    for annotation in ds.annotations.iter_all(shape="polygon", page_size=page):
        seen += 1
        coordinates = annotation.coordinates
        if len(coordinates) < 3 or REGION_TAG in (annotation.tags or ()):
            continue  # regions are never cells, whatever their outline
        cell = cell_of(
            np.array([coordinates[0]["x"], coordinates[0]["y"]]),
            np.array([coordinates[1]["x"], coordinates[1]["y"]]),
            len(coordinates),
        )
        if cell is None:
            continue  # a region, a nucleus, or another bundle's polygon
        if ids[cell] is not None:
            raise XeniumError(
                f"cell {cell} has two annotations ({ids[cell]}, "
                f"{annotation.id}): the cells were uploaded twice, or nuclei "
                "identical to their cells were uploaded too — keep the file "
                "polygons --cells-out wrote"
            )
        ids[cell] = annotation.id
    cells = CellMap(ds.id, frame, ids)
    found = cells.count()
    if not found:
        raise XeniumError(
            f"none of the {seen:,} polygon annotations of dataset {ds.id} "
            f"is a cell of this bundle drawn with {frame}"
        )
    logger.info(
        "  matched %s of %s cells to annotations by geometry",
        f"{found:,}",
        f"{len(ids):,}",
    )
    return cells


def verify_cells(
    ds: Dataset,
    bundle: XeniumBundle,
    cells: CellMap,
    *,
    sample: int = 50,
    source: str = "the cell map",
) -> None:
    """Spot-check ``sample`` cells against the server: each id must be an
    annotation of ``ds`` whose first vertex is where ``cells.frame`` puts
    the cell's. One request."""
    cells.check(bundle, ds)
    present = cells.indices()
    if not present:
        raise XeniumError(f"{source} holds no annotation ids")
    rng = np.random.default_rng(0)
    picked = sorted(
        int(c)
        for c in rng.choice(
            present, size=min(sample, len(present)), replace=False
        )
    )
    found = {
        annotation.id: annotation
        for annotation in ds.annotations.get_many(cells.ids[picked])
    }
    missing = [c for c in picked if cells.ids[c] not in found]
    if missing:
        raise XeniumError(
            f"{len(missing)} of {len(picked)} sampled ids in {source} are "
            f"not annotations of dataset {ds.id} (another dataset's cells?)"
        )
    expected = cells.frame.microns_to_pixels(bundle.first_vertices(picked))
    firsts = np.array([_first_vertex(found[cells.ids[c]]) for c in picked])
    if np.any(np.abs(expected - firsts) > VERIFY_TOLERANCE_PX):
        raise XeniumError(
            f"{source} does not match this bundle's cells on dataset "
            f"{ds.id}: wrong file, or drawn with another frame than "
            f"{cells.frame}"
        )


def open_cells(
    ds: Dataset,
    bundle: XeniumBundle,
    path: str | os.PathLike | None = None,
    *,
    frame: ImageFrame | None = None,
    sample: int = 50,
) -> CellMap:
    """The dataset's verified ``CellMap`` — the one way steps get one.

    ``path`` holding a saved map: it is checked (right dataset, cells, this
    bundle) and spot-checked against the server with the frame it was saved
    with; a ``frame`` given as well must match it. ``path`` holding a bare
    id array (written before CellMap existed): spot-checked with ``frame``.
    No file: re-derived by geometry with ``frame``, then saved to ``path``.
    ``frame`` defaults to the bundle's morphology frame — safe here because
    everything returned is verified against the server, so a wrong frame is
    refused, never used.
    """
    path = Path(path) if path else None
    if path and path.exists():
        stored = CellMap.read(path)
        if isinstance(stored, CellMap):
            if frame is not None and not frame.matches(stored.frame):
                raise XeniumError(
                    f"{frame} conflicts with the {stored.frame} saved in "
                    f"{path}"
                )
            cells = stored
        else:
            cells = CellMap(ds.id, frame or _default(bundle), stored)
        verify_cells(ds, bundle, cells, sample=sample, source=str(path))
        logger.info("  using the cell map in %s", path)
        return cells
    cells = fetch_cells(ds, bundle, frame or _default(bundle))
    cells.check(bundle, ds)
    if path:
        cells.save(path)
        logger.info("  saved the cell map to %s", path)
    return cells


def _default(bundle: XeniumBundle) -> ImageFrame:
    return ImageFrame.create(bundle=bundle)

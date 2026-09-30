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
VERIFY_TOLERANCE_PX = 0.01


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

    def check(self, bundle: XeniumBundle, ds: Dataset | None = None) -> None:
        """The guard every per-cell step runs before writing anything."""
        if ds is not None and self.dataset_id != ds.id:
            raise XeniumError(
                f"these cells belong to dataset {self.dataset_id}, "
                f"not {ds.id}"
            )
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
        """Write to ``path`` as-is (``.npz`` content; no pickle needed)."""
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
        path.write_bytes(buffer.getvalue())
        return path

    @classmethod
    def read(cls, path: str | os.PathLike) -> CellMap | np.ndarray:
        """A saved ``CellMap``, or the bare id array of a pre-CellMap
        ``--ids-out`` file (which records no dataset or frame)."""
        try:
            loaded = np.load(Path(path), allow_pickle=True)
        except (OSError, ValueError) as exc:
            raise XeniumError(f"cannot read {path}: {exc}") from exc
        if isinstance(loaded, np.ndarray):
            return loaded
        with loaded:
            meta = json.loads(str(loaded["meta"]))
            if meta.get("format") != CELLS_FILE_FORMAT:
                raise XeniumError(f"{path}: unknown cells file format")
            return cls(
                meta["datasetId"],
                ImageFrame.from_dict(meta["frame"]),
                loaded["ids"],
                meta["polygonSet"],
            )


def read_frame(path: str | os.PathLike | None) -> ImageFrame | None:
    """The frame saved in a cells file, or None (no file, or a bare-id
    file)."""
    if path is None or not Path(path).exists():
        return None
    stored = CellMap.read(path)
    return stored.frame if isinstance(stored, CellMap) else None


# --- deriving and verifying


def _first_vertex(annotation) -> tuple[float, float]:
    return annotation.coordinates[0]["x"], annotation.coordinates[0]["y"]


def fetch_cells(
    ds: Dataset,
    bundle: XeniumBundle,
    frame: ImageFrame | None = None,
    *,
    page: int = 20000,
) -> CellMap:
    """The ``CellMap`` of a dataset whose cell polygons were uploaded
    earlier, VERIFIED against cells.zarr.

    ``ds.annotations.list()`` returns creation order, so annotation i is cell
    i when the polygons were uploaded in ``cell_index`` order — but a silent
    off-by-N attaches every cell's data to the wrong cell, so each
    annotation's first vertex is checked against the one ``frame`` puts it
    at. Only valid for a dataset whose first polygons came from one full
    ``upload_polygons`` of the cells (no skipped cells). ``frame`` is the one
    the upload used (default: the bundle's morphology frame).
    """
    frame = frame or ImageFrame.create(bundle=bundle)
    expected = frame.microns_to_pixels(bundle.first_vertices())
    n_cells = len(expected)
    ids = np.empty(n_cells, dtype=object)
    firsts = np.empty((n_cells, 2))
    offset = 0
    while offset < n_cells:
        chunk = ds.annotations.list(shape="polygon", limit=page, offset=offset)
        if not chunk:
            break
        for j, annotation in enumerate(chunk[: n_cells - offset]):
            ids[offset + j] = annotation.id
            firsts[offset + j] = _first_vertex(annotation)
        offset += len(chunk)
        logger.info(
            "  fetched %s/%s annotation ids",
            f"{min(offset, n_cells):,}",
            f"{n_cells:,}",
        )
    if offset < n_cells:
        raise XeniumError(
            f"only {offset} of {n_cells} polygon annotations exist in the "
            "dataset (a limited or partial upload can't be re-derived; keep "
            "the file polygons --cells-out wrote)"
        )
    wrong = np.any(np.abs(expected - firsts) > VERIFY_TOLERANCE_PX, axis=1)
    if wrong.any():
        raise XeniumError(
            f"{int(wrong.sum())} annotations' first vertex != their cell's: "
            "the polygons are not in cell_index order, are nuclei, or were "
            f"drawn with another frame than {frame}"
        )
    logger.info("  verified %s cells map to annotations", f"{n_cells:,}")
    return CellMap(ds.id, frame, ids)


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
    id array (written before CellMap existed): spot-checked with ``frame``
    (default: the bundle's morphology frame). No file: fetched and verified
    in full, then saved to ``path`` if given.
    """
    path = Path(path) if path else None
    if path and path.exists():
        stored = CellMap.read(path)
        if isinstance(stored, CellMap):
            if frame is not None and not frame.matches(stored.frame):
                raise XeniumError(
                    f"{frame} conflicts with the {stored.frame} saved in "
                    f"{path}; omit --alignment/--pixel-size"
                )
            cells = stored
        else:
            cells = CellMap(
                ds.id, frame or ImageFrame.create(bundle=bundle), stored
            )
        verify_cells(ds, bundle, cells, sample=sample, source=str(path))
        logger.info("  using the cell map in %s", path)
        return cells
    cells = fetch_cells(ds, bundle, frame)
    if path:
        cells.save(path)
        logger.info("  saved the cell map to %s", path)
    return cells

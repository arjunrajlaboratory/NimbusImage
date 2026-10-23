"""The cell map: Spatial Genomics cell label -> NimbusImage annotation id.

Saved by ``upload_polygons`` together with what it belongs to — the
dataset, the ROI and project, and the pixel size the polygons were drawn
with — so a later step can refuse a map of another dataset or ROI before
writing anything.
"""

from __future__ import annotations

import os
import zipfile
from pathlib import Path

import numpy as np

from nimbusimage.sg.errors import SGError
from nimbusimage.sg.export import SGRoi


class SGCellMap:
    """``labels[i]`` was uploaded as annotation ``ids[i]``."""

    def __init__(
        self,
        dataset_id: str,
        roi: str,
        project: str,
        pixel_size: float,
        labels,
        ids,
        tags: list[str] | None = None,
    ):
        self.dataset_id = str(dataset_id)
        self.roi = str(roi)
        self.project = str(project)
        self.pixel_size = float(pixel_size)
        self.labels = np.asarray(labels, dtype=np.int64)
        self.ids = np.asarray([str(i) for i in ids], dtype=object)
        # the tags the polygons were created with; per-cell steps keep them
        self.tags = ["cell"] if tags is None else [str(t) for t in tags]
        if len(self.labels) != len(self.ids):
            raise SGError("cell map: labels and ids differ in length")
        if len(np.unique(self.labels)) != len(self.labels):
            raise SGError("cell map: a label appears twice")

    def __len__(self) -> int:
        return len(self.labels)

    def __repr__(self) -> str:
        return (
            f"SGCellMap({len(self)} cells, dataset={self.dataset_id}, "
            f"{self.project}/{self.roi}, {self.pixel_size} um/px)"
        )

    @property
    def id_of(self) -> dict[int, str]:
        return dict(zip(self.labels.tolist(), self.ids.tolist()))

    def check(self, ds, roi: SGRoi | None = None) -> None:
        """Refuse a map of another dataset, ROI, or pixel size."""
        if ds is not None and ds.id != self.dataset_id:
            raise SGError(
                f"the cell map belongs to dataset {self.dataset_id}, "
                f"not {ds.id}"
            )
        if roi is not None:
            if (roi.project, roi.name) != (self.project, self.roi):
                raise SGError(
                    f"the cell map is of {self.project}/{self.roi}, not "
                    f"{roi.project}/{roi.name}"
                )
            if not np.isclose(roi.pixel_size, self.pixel_size):
                raise SGError(
                    f"the cell map was drawn at {self.pixel_size} um/px, "
                    f"the ROI's session says {roi.pixel_size}"
                )

    def save(self, path: str | os.PathLike) -> Path:
        path = Path(path)
        np.savez(
            path,
            labels=self.labels,
            ids=self.ids.astype(str),
            dataset_id=self.dataset_id,
            roi=self.roi,
            project=self.project,
            pixel_size=self.pixel_size,
            tags=np.asarray(self.tags, dtype=str),
            kind="spatial-genomics-cell-map",
        )
        # np.savez appends .npz when missing
        return path if path.suffix == ".npz" else path.with_suffix(
            path.suffix + ".npz"
        )

    @classmethod
    def read(cls, path: str | os.PathLike) -> SGCellMap:
        path = Path(path)
        if not path.is_file():
            raise SGError(f"no cell map at {path}")
        try:
            with np.load(path, allow_pickle=False) as saved:
                if str(saved.get("kind", "")) != "spatial-genomics-cell-map":
                    raise SGError(
                        f"{path} is not a Spatial Genomics cell map"
                    )
                return cls(
                    str(saved["dataset_id"]),
                    str(saved["roi"]),
                    str(saved["project"]),
                    float(saved["pixel_size"]),
                    saved["labels"],
                    saved["ids"],
                    tags=saved["tags"].tolist() if "tags" in saved else None,
                )
        except (OSError, ValueError, KeyError, zipfile.BadZipFile) as exc:
            raise SGError(f"{path} is not a readable cell map: {exc}") from exc


def _xy(vertex) -> tuple[float, float]:
    if isinstance(vertex, dict):
        return float(vertex["x"]), float(vertex["y"])
    return float(vertex.x), float(vertex.y)


def verify_cells(
    ds, roi: SGRoi, cells: SGCellMap, sample: int = 50, seed: int = 0
) -> int:
    """Read back a random sample of the map's annotations and compare each
    first vertex with the GeoJSON's (at ``cells.pixel_size``). Returns the
    number checked; raises on any mismatch or missing annotation."""
    if sample < 1:
        raise SGError(f"sample must be >= 1, got {sample}")
    cells.check(ds, roi)
    labels, rings = roi.polygons()
    ring_of = dict(zip(labels.tolist(), rings))
    rng = np.random.default_rng(seed)
    chosen = rng.choice(
        len(cells), size=min(sample, len(cells)), replace=False
    )
    wanted = {cells.ids[i]: int(cells.labels[i]) for i in chosen}
    found = {a.id: a for a in ds.annotations.get_many(list(wanted))}
    for annotation_id, label in wanted.items():
        annotation = found.get(annotation_id)
        if annotation is None:
            raise SGError(
                f"annotation {annotation_id} (label {label}) is not in "
                f"dataset {ds.id}"
            )
        if label not in ring_of:
            raise SGError(f"label {label} is not in the ROI's boundaries")
        x0, y0 = ring_of[label][0] / cells.pixel_size
        x, y = _xy(annotation.coordinates[0])
        if abs(x - x0) > 1e-3 or abs(y - y0) > 1e-3:
            raise SGError(
                f"label {label}: annotation {annotation_id} starts at "
                f"({x:.3f}, {y:.3f}), the boundary at ({x0:.3f}, {y0:.3f})"
            )
    return len(wanted)

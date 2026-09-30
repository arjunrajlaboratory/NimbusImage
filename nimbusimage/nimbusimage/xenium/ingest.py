"""Load a Xenium bundle into NimbusImage datasets.

Each step takes a ``Dataset`` (or the client, to create one) and a
``XeniumBundle``. The steps after the polygon upload join per-cell data to
annotations through ``ids``: annotation ids in ``cell_index`` order, None
where a degenerate polygon was skipped. ``upload_polygons`` returns them;
``load_annotation_ids`` re-derives (and verifies) them for a dataset whose
polygons were uploaded earlier.

Alignment arguments take the ``*_he_imagealignment.csv`` path or its 3x3
matrix AS SHIPPED (H&E px -> morphology px); each step inverts it where the
direction needs it.
"""

from __future__ import annotations

import datetime
import json
import logging
import os
import tempfile
import time
import zipfile
from collections import Counter
from pathlib import Path
from typing import TYPE_CHECKING

import numpy as np

from nimbusimage.models import Annotation, Location
from nimbusimage.xenium.bundle import (
    CELL_POLYGON_SET,
    PROTEIN_SUFFIX,
    XeniumBundle,
    staged_channel_file_name,
)
from nimbusimage.xenium.errors import XeniumError
from nimbusimage.xenium.geometry import (
    geojson_class_name,
    geojson_outer_rings,
    inverse_alignment,
    load_alignment,
    microns_to_pixels,
    polygon_coordinates,
    region_transform,
)

if TYPE_CHECKING:
    from nimbusimage.client import NimbusClient
    from nimbusimage.dataset import Dataset
    from nimbusimage.models import Property

logger = logging.getLogger("nimbusimage.xenium")

SPATIAL_TABLE_SCHEMA_VERSION = 1
REGION_TAG = "region"


def _polygon_annotation(
    dataset_id: str, tags: list[str], coordinates: list[dict]
):
    return Annotation(
        shape="polygon",
        tags=tags,
        channel=0,
        dataset_id=dataset_id,
        coordinates=coordinates,
        location=Location(xy=0, z=0, time=0),
    )


def cell_indices_with_annotations(
    ids: np.ndarray, start: int, stop: int
) -> list[int]:
    """Cell indices in [start, stop) that have an annotation (skips the None
    slots left by degenerate polygons)."""
    return [c for c in range(start, stop) if ids[c] is not None]


def load_embedding(
    embedding: np.ndarray | str | os.PathLike, n_cells: int
) -> np.ndarray:
    """A [n_cells, 2] embedding from an array or ``.npy``, shape-checked."""
    if not isinstance(embedding, np.ndarray):
        try:
            embedding = np.load(embedding)
        except (OSError, ValueError) as exc:
            raise XeniumError(f"cannot read {embedding}: {exc}") from exc
    if embedding.shape != (n_cells, 2):
        raise XeniumError(
            f"embedding is {embedding.shape}, expected ({n_cells}, 2)"
        )
    return embedding


def _cell_type_labels(
    bundle: XeniumBundle, cell_types, *, complete: bool = True
) -> list:
    """Labels per ``cell_index`` from a ``*_cell_types.csv`` path, or the
    list ``bundle.cell_types`` already returned."""
    if isinstance(cell_types, (list, tuple)):
        if len(cell_types) != bundle.number_of_cells:
            raise XeniumError(
                f"{len(cell_types)} cell-type labels for "
                f"{bundle.number_of_cells} cells"
            )
        return list(cell_types)
    return bundle.cell_types(cell_types, complete=complete)


def _chunks(stop: int, chunk: int):
    for c0 in range(0, stop, chunk):
        yield c0, min(c0 + chunk, stop)


def _stop(ids: np.ndarray, limit: int | None) -> int:
    return min(limit or len(ids), len(ids))


# --- images ---


def upload_morphology(
    client: NimbusClient,
    bundle: XeniumBundle,
    name: str,
    parent_folder_id: str | None = None,
    wait: bool = True,
) -> Dataset:
    """A dataset from ``morphology_focus/``, channels named by stain.

    Uploads the per-channel OME-TIFFs under staged names
    (``c00-DAPI.ome.tif``, ...) and pins the channel axis to the one varying
    filename token. Waits for the transcode job unless ``wait=False``.
    """
    files = bundle.morphology_files()
    names = bundle.morphology_channel_names()
    for path in files:
        logger.info("  %s -> %s", path.name, names[path])

    dataset = client.create_dataset(name, parent_folder_id=parent_folder_id)
    with tempfile.TemporaryDirectory() as stage:
        for index, path in enumerate(files):
            (
                Path(stage) / staged_channel_file_name(index, names[path])
            ).symlink_to(path.resolve())
        dataset.upload(stage)

    # The staged names have one varying token; make it the channel axis
    # whatever the filename heuristics guessed for it.
    dry = dataset.configure(dry_run=True)
    variable = next(
        (
            v
            for v in dry.variables
            if v.get("source") == "filename" and v.get("size") == len(files)
        ),
        None,
    )
    if variable is None:
        raise XeniumError(
            f"no filename variable of size {len(files)}: {dry.variables}"
        )
    result = dataset.configure(
        assignments={
            "C": {"source": variable["source"], "guess": variable["guess"]},
        }
    )
    logger.info("  channels: %s", result.config["channels"])
    if result.job_id and wait:
        logger.info("  waiting for the transcode job")
        if not client.job(result.job_id).wait():
            raise XeniumError("transcode job failed")
    return dataset


# --- polygons and the cell_index -> annotation id map ---


def delete_tagged(ds: Dataset, tag: str) -> int:
    """Delete every annotation carrying ``tag`` (for test uploads)."""
    existing = ds.annotations.list(tags=[tag])
    if existing:
        ds.annotations.delete_many([annotation.id for annotation in existing])
    return len(existing)


def upload_polygons(
    ds: Dataset,
    bundle: XeniumBundle,
    *,
    alignment=None,
    pixel_size: float | None = None,
    polygon_set: str = CELL_POLYGON_SET,
    tags: list[str] | None = None,
    batch: int = 5000,
    limit: int | None = None,
    delete_tag: str | None = None,
) -> np.ndarray:
    """Bulk-create the segmentation polygons in ``cell_index`` order.

    Pass ``alignment`` when ``ds`` is the H&E image. Polygons with fewer than
    three vertices are skipped. ``delete_tag`` first removes the annotations
    of an earlier test upload — only once every input has been read, so a
    bad path never deletes them without uploading replacements. Returns the
    created ids in ``cell_index`` order (None for skipped cells) — keep them;
    every later step wants them.
    """
    tags = ["cell"] if tags is None else tags
    pixel_size = pixel_size or bundle.pixel_size
    inverse = inverse_alignment(alignment)
    n_vertices, vertices = bundle.polygons(polygon_set)
    logger.info(
        "%s %s polygons, pixel size %s um/px, %s transform",
        f"{len(n_vertices):,}",
        polygon_set,
        pixel_size,
        "H&E inverse-affine" if inverse is not None else "identity",
    )
    if delete_tag:
        removed = delete_tagged(ds, delete_tag)
        logger.info("removed %d annotations tagged %r", removed, delete_tag)

    stop = min(limit or len(n_vertices), len(n_vertices))
    ids = np.empty(stop, dtype=object)
    started = time.time()
    buffer: list[Annotation] = []
    buffer_indices: list[int] = []

    def flush():
        created = ds.annotations.create_many(buffer)
        if len(created) != len(buffer):
            raise XeniumError(
                f"server created {len(created)} of {len(buffer)} annotations"
            )
        for index, annotation in zip(buffer_indices, created):
            ids[index] = annotation.id
        buffer.clear()
        buffer_indices.clear()

    for i in range(stop):
        n = int(n_vertices[i])
        if n < 3:
            continue
        buffer.append(
            _polygon_annotation(
                ds.id,
                tags,
                polygon_coordinates(vertices[i], n, pixel_size, inverse),
            )
        )
        buffer_indices.append(i)
        if len(buffer) >= batch:
            flush()
            logger.info(
                "  %s/%s (%.0fs)",
                f"{i + 1:,}",
                f"{stop:,}",
                time.time() - started,
            )
    if buffer:
        flush()
    logger.info(
        "DONE %s polygons in %.0fs", f"{stop:,}", time.time() - started
    )
    return ids


def fetch_annotation_ids(
    ds: Dataset,
    bundle: XeniumBundle,
    *,
    alignment=None,
    polygon_set: str = CELL_POLYGON_SET,
    page: int = 20000,
) -> np.ndarray:
    """Annotation ids in ``cell_index`` order, VERIFIED against cells.zarr.

    ``ds.annotations.list()`` returns creation order, so row i is cell i when
    the polygons were uploaded in ``cell_index`` order — but a silent
    off-by-N here attaches every cell's data to the wrong cell, so each
    annotation's first vertex is checked against the vertex recomputed from
    cells.zarr. Only valid for a dataset whose every polygon came from one
    full ``upload_polygons`` (no skipped cells, no other polygons first).
    """
    inverse = inverse_alignment(alignment)
    n_vertices, vertices = bundle.polygons(polygon_set)
    n_cells = len(n_vertices)
    ids = np.empty(n_cells, dtype=object)
    firsts = np.empty((n_cells, 2))
    offset = 0
    while offset < n_cells:
        chunk = ds.annotations.list(shape="polygon", limit=page, offset=offset)
        if not chunk:
            break
        for j, annotation in enumerate(chunk[: n_cells - offset]):
            ids[offset + j] = annotation.id
            firsts[offset + j] = (
                annotation.coordinates[0]["x"],
                annotation.coordinates[0]["y"],
            )
        offset += len(chunk)
        logger.info(
            "  fetched %s/%s annotation ids",
            f"{min(offset, n_cells):,}",
            f"{n_cells:,}",
        )
    if offset < n_cells:
        raise XeniumError(
            f"only {offset} of {n_cells} annotations exist in the dataset"
        )
    expected = microns_to_pixels(vertices[:, :2], bundle.pixel_size, inverse)
    mismatches = int(np.sum(np.any(np.abs(expected - firsts) > 0.01, axis=1)))
    if mismatches:
        raise XeniumError(
            f"{mismatches} annotations' first vertex != their cell's; "
            "the dataset's polygons are not in cell_index order"
        )
    logger.info(
        "  verified %s annotations map to their cell_index", f"{n_cells:,}"
    )
    return ids


def load_annotation_ids(
    ds: Dataset,
    bundle: XeniumBundle,
    ids_path: str | os.PathLike | None = None,
    *,
    alignment=None,
) -> np.ndarray:
    """``ids`` from a cached ``.npy`` when present and complete; otherwise
    ``fetch_annotation_ids`` and cache the result at ``ids_path``."""
    ids_path = Path(ids_path) if ids_path else None
    if ids_path and ids_path.exists():
        ids = np.load(ids_path, allow_pickle=True)
        if len(ids) == bundle.number_of_cells:
            logger.info("  using cached annotation ids from %s", ids_path)
            return ids
        logger.info(
            "  %s holds %d ids, expected %d; refetching",
            ids_path,
            len(ids),
            bundle.number_of_cells,
        )
    ids = fetch_annotation_ids(ds, bundle, alignment=alignment)
    if ids_path:
        np.save(ids_path, ids)
        logger.info("  cached annotation ids to %s", ids_path)
    return ids


# --- per-cell data as nested property values ---


def ensure_property(
    ds: Dataset, name: str, shape: str = "polygon"
) -> Property:
    """A client-side property (no worker) registered into the dataset's
    collections. Idempotent: ``register()`` appends only where missing."""
    prop = ds.properties.get_or_create(name, shape=shape)
    ds.properties.register(prop.id)
    return prop


def _prepare_property(ds: Dataset, name: str, replace: bool) -> Property:
    prop = ensure_property(ds, name)
    if replace:
        ds.properties.delete_values(prop.id)
        logger.info("  deleted existing %r values for this dataset", name)
    return prop


def _submit(ds: Dataset, prop: Property, values: dict, label: str) -> None:
    ds.properties.submit_values(prop.id, values)
    logger.info("    %s: %s annotations", label, f"{len(values):,}")


def upload_gene_panel(
    ds: Dataset,
    bundle: XeniumBundle,
    ids: np.ndarray,
    genes: list[str],
    *,
    property_name: str = "Gene Expression",
    dense: bool = True,
    chunk: int = 20000,
    limit: int | None = None,
    replace: bool = False,
) -> Property:
    """A marker panel as one nested property: ``{"MS4A1": 3, "CD3E": 0, ...}``.

    Never the whole matrix (4,624 genes x 700k cells is billions of values):
    use ``build_spatial_table`` for that. ``dense`` writes explicit zeros so
    the UI can tell zero from missing. Values are not overwritten on
    re-submit (a silent no-op), so pass ``replace=True`` to re-run.
    """
    gene_counts = bundle.gene_counts(genes)
    prop = _prepare_property(ds, property_name, replace)
    stop = _stop(ids, limit)
    started = time.time()
    for c0, c1 in _chunks(stop, chunk):
        buckets = [
            ({symbol: 0 for symbol in genes} if dense else {})
            for _ in range(c1 - c0)
        ]
        for symbol, (cells, values) in gene_counts.items():
            lo, hi = np.searchsorted(cells, c0), np.searchsorted(cells, c1)
            for cell, value in zip(cells[lo:hi], values[lo:hi]):
                buckets[cell - c0][symbol] = int(value)
        _submit(
            ds,
            prop,
            {
                ids[c]: buckets[c - c0]
                for c in cell_indices_with_annotations(ids, c0, c1)
                if buckets[c - c0]
            },
            f"genes, cells {c0:,}-{c1:,}",
        )
    logger.info(
        "  GENES done: %s cells x %d genes (%.0fs)",
        f"{stop:,}",
        len(genes),
        time.time() - started,
    )
    return prop


def upload_clusters(
    ds: Dataset,
    bundle: XeniumBundle,
    ids: np.ndarray,
    *,
    property_name: str = "Clustering",
    chunk: int = 20000,
    limit: int | None = None,
    replace: bool = False,
    labels: dict[str, np.ndarray] | None = None,
) -> Property:
    """Every clustering as one nested property:
    ``{"graphclust": 12, "kmeans_2_clusters": 1, ...}``, 0 = unassigned.

    ``labels`` reuses a ``bundle.cell_groups()`` already read."""
    labels = bundle.cell_groups() if labels is None else labels
    for name, label in labels.items():
        logger.info(
            "  %s: %d clusters, %d unassigned",
            name,
            int(label.max()),
            int((label == 0).sum()),
        )
    prop = _prepare_property(ds, property_name, replace)
    stop = _stop(ids, limit)
    for c0, c1 in _chunks(stop, chunk):
        _submit(
            ds,
            prop,
            {
                ids[c]: {name: int(label[c]) for name, label in labels.items()}
                for c in cell_indices_with_annotations(ids, c0, c1)
            },
            f"clusters, cells {c0:,}-{c1:,}",
        )
    logger.info("  CLUSTERS done: %s cells", f"{stop:,}")
    return prop


def upload_umap(
    ds: Dataset,
    ids: np.ndarray,
    embedding: np.ndarray | str | os.PathLike,
    *,
    property_name: str = "UMAP",
    chunk: int = 20000,
    limit: int | None = None,
    replace: bool = False,
) -> Property:
    """A 2-D embedding (``compute_umap``) as ``{"x": ..., "y": ...}``."""
    embedding = load_embedding(embedding, len(ids))
    prop = _prepare_property(ds, property_name, replace)
    stop = _stop(ids, limit)
    for c0, c1 in _chunks(stop, chunk):
        _submit(
            ds,
            prop,
            {
                ids[c]: {
                    "x": float(embedding[c, 0]),
                    "y": float(embedding[c, 1]),
                }
                for c in cell_indices_with_annotations(ids, c0, c1)
            },
            f"umap, cells {c0:,}-{c1:,}",
        )
    logger.info("  UMAP done: %s cells", f"{stop:,}")
    return prop


# --- cell types as tags ---


def upload_cell_types(
    ds: Dataset,
    bundle: XeniumBundle,
    ids: np.ndarray,
    cell_types: str | os.PathLike | list,
    *,
    base_tags: list[str] | None = None,
    chunk: int = 5000,
    limit: int | None = None,
    reset: bool = False,
    verify_sample: int = 20,
) -> Counter:
    """Tag each cell polygon ``base_tags + [group]``, e.g.
    ``["cell", "Memory B Cell"]``.

    Categorical data are tags, not property values. Tags are REPLACED on
    every touched annotation; ``reset=True`` writes ``base_tags`` only, which
    undoes this. A random sample is read back (the bulk update returns no
    body). ``cell_types`` is the ``*_cell_types.csv`` path or the labels
    ``bundle.cell_types`` returned. Returns the label counts.
    """
    base_tags = ["cell"] if base_tags is None else base_tags
    labels = _cell_type_labels(bundle, cell_types)
    counts = Counter(labels)
    logger.info(
        "%s cell-type labels in %d groups", f"{len(labels):,}", len(counts)
    )
    for group, count in counts.most_common():
        logger.info("  %9s  %s", f"{count:,}", group)

    def tags_for(cell: int) -> list[str]:
        return base_tags if reset else [*base_tags, labels[cell]]

    stop = _stop(ids, limit)
    started = time.time()
    for c0, c1 in _chunks(stop, chunk):
        ds.annotations.update_many(
            [
                (str(ids[c]), {"tags": tags_for(c)})
                for c in cell_indices_with_annotations(ids, c0, c1)
            ]
        )
        logger.info(
            "  tagged cells %s-%s (%.0fs)",
            f"{c0:,}",
            f"{c1:,}",
            time.time() - started,
        )

    tagged = cell_indices_with_annotations(ids, 0, stop)
    rng = np.random.default_rng(0)
    sample = rng.choice(
        tagged, size=min(verify_sample, len(tagged)), replace=False
    )
    read_back = {
        annotation.id: annotation.tags
        for annotation in ds.annotations.get_many(
            [str(ids[c]) for c in sample]
        )
    }
    for c in sample:
        actual = read_back.get(str(ids[c]))
        if actual is None or sorted(actual) != sorted(tags_for(c)):
            raise XeniumError(
                f"verify failed for cell {c}: {actual!r} != {tags_for(c)!r}"
            )
    logger.info(
        "DONE: %s cells %s; %d verified by read-back",
        f"{stop:,}",
        "reset" if reset else "tagged",
        min(verify_sample, len(tagged)),
    )
    return counts


# --- the full matrix as a spatial table ---


def _zip_directory(directory: Path, out: Path) -> None:
    """Zip so entries sit at the archive root (what zarr.ZipStore opens).
    Chunks are already blosc-compressed, so ZIP_STORED."""
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_STORED) as zf:
        for path in sorted(directory.rglob("*")):
            if path.is_file():
                zf.write(path, path.relative_to(directory).as_posix())


def build_spatial_table(
    bundle: XeniumBundle,
    ids: np.ndarray,
    out: str | os.PathLike,
    *,
    dataset_id: str,
    cell_types: str | os.PathLike | list | None = None,
    umap: np.ndarray | str | os.PathLike | None = None,
) -> Path:
    """Write the dataset's ``spatial.zarr.zip`` (AnnData, zarr v2, zipped).

    ::

        X              counts, cells x features, CSC
        layers/X_csr   the same counts, CSR, for per-cell reads
        obs            annotation_id (the ONLY join key), cell_index,
                       cell_type, one column per clustering
        var            index = symbol; gene_id; feature_type
        obsm/X_umap    from ``umap``, optional
        uns/nimbus     schemaVersion, datasetId, source bundle, created

    Cells without an annotation are dropped. Proteins are features named
    ``"<key> (protein)"``. ``cell_types`` is a ``*_cell_types.csv`` path or
    the labels ``bundle.cell_types`` returned. Needs ``anndata`` and
    ``pandas``.
    """
    import anndata as ad
    import pandas as pd

    ad.settings.zarr_write_format = 2  # the server reads with zarr 2
    out = Path(out)
    started = time.time()
    n_cells = bundle.number_of_cells
    if len(ids) != n_cells:
        raise XeniumError(f"{len(ids)} ids for {n_cells} cells")
    # The small inputs first: a bad one fails before the matrix is read.
    labels = (
        None
        if cell_types is None
        else _cell_type_labels(bundle, cell_types, complete=False)
    )
    embedding = None if umap is None else load_embedding(umap, n_cells)
    with_annotation = np.array([value is not None for value in ids])
    kept = np.flatnonzero(with_annotation)
    if len(kept) < n_cells:
        logger.info(
            "  dropping %d cells without an annotation", n_cells - len(kept)
        )

    counts, symbols, feature_ids, kinds = bundle.counts()
    counts = counts[kept]
    proteins = sum(kind == "protein" for kind in kinds)
    if proteins:
        logger.info(
            "  including %d protein features as '<name>%s'",
            proteins,
            PROTEIN_SUFFIX,
        )
    logger.info(
        "  counts: %s cells x %s features, nnz=%s",
        f"{counts.shape[0]:,}",
        f"{counts.shape[1]:,}",
        f"{counts.nnz:,}",
    )

    obs = pd.DataFrame(index=[str(i) for i in kept])
    obs["annotation_id"] = np.array(
        [str(v) for v in ids[with_annotation]], dtype=object
    )
    obs["cell_index"] = kept.astype(np.int64)
    if labels is not None:
        obs["cell_type"] = pd.Categorical([labels[i] for i in kept])
    for name, label in bundle.cell_groups().items():
        obs[name] = label[with_annotation].astype(np.int32)

    var = pd.DataFrame(index=pd.Index(symbols, name="symbol"))
    var["gene_id"] = feature_ids
    var["feature_type"] = kinds

    adata = ad.AnnData(X=counts, obs=obs, var=var)
    adata.layers["X_csr"] = counts.tocsr()
    if embedding is not None:
        adata.obsm["X_umap"] = embedding[with_annotation].astype(np.float32)
    adata.uns["nimbus"] = {
        "schemaVersion": SPATIAL_TABLE_SCHEMA_VERSION,
        "datasetId": dataset_id,
        "source": bundle.directory.resolve().name,
        "created": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }

    with tempfile.TemporaryDirectory() as tmp:
        store_dir = Path(tmp) / "spatial.zarr"
        adata.write_zarr(store_dir)
        _zip_directory(store_dir, out)
    logger.info(
        "  wrote %s (%.0f MB, %.0fs)",
        out,
        os.path.getsize(out) / 1e6,
        time.time() - started,
    )
    return out


# --- molecules ---


def register_transcripts(
    ds: Dataset,
    bundle: XeniumBundle,
    *,
    alignment=None,
    item_id: str | None = None,
) -> dict:
    """Upload ``transcripts.zarr.zip`` as shipped and register it.

    The file is already a level-of-detail pyramid, so nothing is rebuilt;
    registration records the bundle's pixel size and, for the H&E dataset
    (``alignment``), the inverse alignment as the transform. ``item_id``
    registers an item already in the folder and skips the (slow) upload.
    The alignment and pixel size are read first, so a bad one fails before
    a multi-GB upload.
    """
    pixel_size = bundle.pixel_size
    transform = inverse_alignment(alignment)
    if item_id is None:
        path = bundle.transcripts_zarr
        bundle.require(path)
        logger.info(
            "  uploading %s (%.1f GB)", path, os.path.getsize(path) / 1e9
        )
        item_id = ds.spatial.upload_transcripts(path)["_id"]
        logger.info("  uploaded as item %s", item_id)
    return ds.spatial.register_transcripts(item_id, pixel_size, transform)


# --- regions ---


def region_annotations(
    geojson: dict,
    dataset_id: str,
    *,
    frame: str,
    target: str = "morphology",
    alignment=None,
    pixel_size: float | None = None,
    tag: str = REGION_TAG,
) -> list[Annotation]:
    """Tagged polygon annotations from a GeoJSON FeatureCollection.

    Each outer ring becomes one polygon tagged ``[<class>, tag]`` — class
    first, because GeoJSON export writes the first tag as QuPath's
    ``classification``. See ``region_transform`` for ``frame``/``target``.
    """
    to_pixels = region_transform(
        frame, target, load_alignment(alignment), pixel_size
    )
    annotations = []
    for feature in geojson.get("features", []):
        name = geojson_class_name(feature.get("properties") or {})
        tags = ([name] if name else []) + [tag]
        for ring in geojson_outer_rings(feature.get("geometry") or {}):
            xy = to_pixels(np.asarray(ring, dtype=np.float64)[:, :2])
            if len(xy) >= 2 and np.allclose(xy[0], xy[-1]):
                xy = xy[:-1]  # GeoJSON rings repeat their first vertex
            if len(xy) < 3:
                continue
            annotations.append(
                _polygon_annotation(
                    dataset_id,
                    tags,
                    [{"x": float(x), "y": float(y)} for x, y in xy],
                )
            )
    return annotations


def upload_regions(
    ds: Dataset,
    geojson: dict | str | os.PathLike,
    *,
    frame: str,
    target: str = "morphology",
    alignment=None,
    pixel_size: float | None = None,
    tag: str = REGION_TAG,
) -> list[Annotation]:
    """Upload region polygons (e.g. a pathologist's layer, which 10x ships in
    H&E pixels) for the Region statistics dialog.

    ``region`` is a reserved tag: spatial analyses never treat those polygons
    as cells. ``pixel_size`` is needed for ``frame="microns"``.
    """
    if not isinstance(geojson, dict):
        try:
            geojson = json.loads(Path(geojson).read_text())
        except (OSError, ValueError) as exc:
            raise XeniumError(f"cannot read GeoJSON {geojson}: {exc}") from exc
    annotations = region_annotations(
        geojson,
        ds.id,
        frame=frame,
        target=target,
        alignment=alignment,
        pixel_size=pixel_size,
        tag=tag,
    )
    if not annotations:
        raise XeniumError("no polygons in the GeoJSON")
    created = ds.annotations.create_many(annotations)
    classes = sorted({t for a in annotations for t in a.tags} - {tag})
    logger.info(
        "created %d region polygons tagged %r (%s)",
        len(created),
        tag,
        ", ".join(classes),
    )
    return created

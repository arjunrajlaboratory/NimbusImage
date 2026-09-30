"""Load a Xenium bundle into NimbusImage datasets.

Each step takes a ``Dataset`` (or the client, to create one) and a
``XeniumBundle``. Two validated objects carry everything the steps share:

- ``ImageFrame`` — how microns map onto the dataset's pixels (image, pixel
  size, alignment). Every coordinate-producing step takes one.
- ``CellMap`` — the annotation id of every cell, with the dataset and frame
  it belongs to. ``upload_polygons`` returns it; ``open_cells`` loads or
  re-derives it, verified. Every per-cell step starts with
  ``cells.check(bundle, ds)``, so ids of another dataset, of nuclei or of
  another bundle never reach the server.

Inputs that come as files (CSV, ``.npy``, GeoJSON) are converted and checked
by one function each, and every check runs before the step's first write.
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
from nimbusimage.xenium.cells import REGION_TAG, CellMap
from nimbusimage.xenium.errors import XeniumError
from nimbusimage.xenium.geometry import (
    ImageFrame,
    geojson_class_name,
    geojson_outer_rings,
)

if TYPE_CHECKING:
    from nimbusimage.client import NimbusClient
    from nimbusimage.dataset import Dataset
    from nimbusimage.models import Property

logger = logging.getLogger("nimbusimage.xenium")

SPATIAL_TABLE_SCHEMA_VERSION = 1


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


def load_embedding(
    embedding: np.ndarray | str | os.PathLike, n_cells: int
) -> np.ndarray:
    """A [n_cells, 2] embedding (row i = cell_index i) from an array or
    ``.npy``, shape-checked against the bundle's cell count."""
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
        missing = sum(1 for label in cell_types if label is None)
        if complete and missing:
            raise XeniumError(f"{missing} cells have no cell-type label")
        return list(cell_types)
    return bundle.cell_types(cell_types, complete=complete)


def _chunks(stop: int, chunk: int):
    if chunk < 1:
        raise XeniumError(f"chunk/batch size must be >= 1, got {chunk}")
    for c0 in range(0, stop, chunk):
        yield c0, min(c0 + chunk, stop)


def _frame_for(ds: Dataset, source) -> ImageFrame:
    """The frame a coordinate step uses on ``ds``: that of ``ds``'s own
    ``CellMap`` (checked against ``ds``), or an ``ImageFrame`` stated
    explicitly. Never a default: these steps have nothing to verify a
    wrong frame against, so a guess would silently misplace everything."""
    if isinstance(source, CellMap):
        source.check_dataset(ds)
        return source.frame
    if isinstance(source, ImageFrame):
        return source
    raise XeniumError(
        "pass the dataset's CellMap (upload_polygons / open_cells) or an "
        "explicit ImageFrame"
    )


def _check_limit(limit: int | None, n: int) -> int:
    """How many items a ``limit`` covers (None = all)."""
    if limit is None:
        return n
    if limit < 1:
        raise XeniumError(f"limit must be >= 1, got {limit}")
    return min(limit, n)


def _per_cell_stop(
    ds: Dataset | None,
    bundle: XeniumBundle,
    cells: CellMap,
    limit: int | None,
) -> int:
    """The guard every per-cell step runs first: the right dataset's cell
    polygons for this bundle. Returns the cell count ``limit`` covers."""
    if not isinstance(cells, CellMap):
        raise XeniumError(
            "pass the CellMap from upload_polygons or open_cells, not bare ids"
        )
    cells.check(bundle, ds)
    return _check_limit(limit, len(cells))


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
    frame: ImageFrame | None = None,
    *,
    polygon_set: str = CELL_POLYGON_SET,
    tags: list[str] | None = None,
    batch: int = 5000,
    limit: int | None = None,
    delete_tag: str | None = None,
) -> CellMap:
    """Bulk-create the segmentation polygons in bundle order.

    ``frame`` says how microns land on ``ds`` (default: the bundle's
    morphology frame; ``ImageFrame.create(alignment=...)`` for the H&E
    image). Polygons with fewer than three vertices are skipped.
    ``delete_tag`` first removes the annotations of an earlier test upload —
    only once every input has been read, so a bad input never deletes them
    without uploading replacements.

    Returns the ``CellMap`` — save it (``.save(path)``); every per-cell step
    wants it. A nucleus upload returns one too, for display only: per-cell
    steps refuse it, since nuclei are not in ``cell_index`` order.
    """
    tags = ["cell"] if tags is None else tags
    if batch < 1:
        raise XeniumError(f"batch must be >= 1, got {batch}")
    frame = frame or ImageFrame.create(bundle=bundle)
    n_vertices, vertices = bundle.polygons(polygon_set)
    stop = _check_limit(limit, len(n_vertices))
    logger.info(
        "%s %s polygons onto the %s image, pixel size %s um/px",
        f"{len(n_vertices):,}",
        polygon_set,
        frame.image,
        frame.pixel_size,
    )
    if delete_tag:
        removed = delete_tagged(ds, delete_tag)
        logger.info("removed %d annotations tagged %r", removed, delete_tag)

    # One slot per polygon, so a limited upload is still indexed by bundle
    # order; slots past the limit stay None.
    ids = np.empty(len(n_vertices), dtype=object)
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
                frame.polygon_coordinates(vertices[i], n),
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
    return CellMap(ds.id, frame, ids, polygon_set)


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
    cells: CellMap,
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
    stop = _per_cell_stop(ds, bundle, cells, limit)
    gene_counts = bundle.gene_counts(genes)
    prop = _prepare_property(ds, property_name, replace)
    started = time.time()
    for c0, c1 in _chunks(stop, chunk):
        buckets = [
            ({symbol: 0 for symbol in genes} if dense else {})
            for _ in range(c1 - c0)
        ]
        for symbol, (expressing, values) in gene_counts.items():
            lo = np.searchsorted(expressing, c0)
            hi = np.searchsorted(expressing, c1)
            for cell, value in zip(expressing[lo:hi], values[lo:hi]):
                buckets[cell - c0][symbol] = int(value)
        _submit(
            ds,
            prop,
            {
                cells.ids[c]: buckets[c - c0]
                for c in cells.indices(c0, c1)
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
    cells: CellMap,
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
    stop = _per_cell_stop(ds, bundle, cells, limit)
    labels = bundle.cell_groups() if labels is None else labels
    for name, label in labels.items():
        logger.info(
            "  %s: %d clusters, %d unassigned",
            name,
            int(label.max()),
            int((label == 0).sum()),
        )
    prop = _prepare_property(ds, property_name, replace)
    for c0, c1 in _chunks(stop, chunk):
        _submit(
            ds,
            prop,
            {
                cells.ids[c]: {
                    name: int(label[c]) for name, label in labels.items()
                }
                for c in cells.indices(c0, c1)
            },
            f"clusters, cells {c0:,}-{c1:,}",
        )
    logger.info("  CLUSTERS done: %s cells", f"{stop:,}")
    return prop


def upload_umap(
    ds: Dataset,
    bundle: XeniumBundle,
    cells: CellMap,
    embedding: np.ndarray | str | os.PathLike,
    *,
    property_name: str = "UMAP",
    chunk: int = 20000,
    limit: int | None = None,
    replace: bool = False,
) -> Property:
    """A 2-D embedding (``compute_umap``) as ``{"x": ..., "y": ...}``.

    ``embedding`` (an array or ``.npy``) must cover exactly this bundle's
    cells (row i = cell_index i), which catches another run's file.
    """
    stop = _per_cell_stop(ds, bundle, cells, limit)
    embedding = load_embedding(embedding, bundle.number_of_cells)
    prop = _prepare_property(ds, property_name, replace)
    for c0, c1 in _chunks(stop, chunk):
        _submit(
            ds,
            prop,
            {
                cells.ids[c]: {
                    "x": float(embedding[c, 0]),
                    "y": float(embedding[c, 1]),
                }
                for c in cells.indices(c0, c1)
            },
            f"umap, cells {c0:,}-{c1:,}",
        )
    logger.info("  UMAP done: %s cells", f"{stop:,}")
    return prop


# --- cell types as tags ---


def upload_cell_types(
    ds: Dataset,
    bundle: XeniumBundle,
    cells: CellMap,
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
    stop = _per_cell_stop(ds, bundle, cells, limit)
    base_tags = ["cell"] if base_tags is None else base_tags
    labels = _cell_type_labels(bundle, cell_types, complete=not reset)
    counts = Counter(labels)
    logger.info(
        "%s cell-type labels in %d groups", f"{len(labels):,}", len(counts)
    )
    for group, count in counts.most_common():
        logger.info("  %9s  %s", f"{count:,}", group)

    def tags_for(cell: int) -> list[str]:
        return base_tags if reset else [*base_tags, labels[cell]]

    started = time.time()
    for c0, c1 in _chunks(stop, chunk):
        ds.annotations.update_many(
            [
                (cells.ids[c], {"tags": tags_for(c)})
                for c in cells.indices(c0, c1)
            ]
        )
        logger.info(
            "  tagged cells %s-%s (%.0fs)",
            f"{c0:,}",
            f"{c1:,}",
            time.time() - started,
        )

    tagged = cells.indices(0, stop)
    rng = np.random.default_rng(0)
    sample = rng.choice(
        tagged, size=min(verify_sample, len(tagged)), replace=False
    )
    read_back = {
        annotation.id: annotation.tags
        for annotation in ds.annotations.get_many(
            [cells.ids[c] for c in sample]
        )
    }
    for c in sample:
        actual = read_back.get(cells.ids[c])
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
    cells: CellMap,
    out: str | os.PathLike,
    *,
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

    ``uns/nimbus/datasetId`` is ``cells.dataset_id``: upload the file to
    that dataset. Cells without an annotation are dropped. Proteins are
    features named ``"<key> (protein)"``. ``cell_types`` is a
    ``*_cell_types.csv`` path or the labels ``bundle.cell_types`` returned.
    Needs ``anndata`` and ``pandas``.
    """
    import anndata as ad
    import pandas as pd

    ad.settings.zarr_write_format = 2  # the server reads with zarr 2
    out = Path(out)
    started = time.time()
    _per_cell_stop(None, bundle, cells, None)
    n_cells = bundle.number_of_cells
    ids = cells.ids
    # The small inputs first: a bad one fails before the matrix is read.
    labels = (
        None
        if cell_types is None
        else _cell_type_labels(bundle, cell_types, complete=False)
    )
    embedding = None if umap is None else load_embedding(umap, n_cells)
    groups = bundle.cell_groups()
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
    for name, label in groups.items():
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
        "datasetId": cells.dataset_id,
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


def spatial_table_dataset(path: str | os.PathLike) -> str:
    """The dataset a ``build_spatial_table`` file was built for
    (``uns/nimbus/datasetId``) — its join keys are that dataset's ids."""
    from nimbusimage.xenium.bundle import open_zarr_zip

    try:
        group = open_zarr_zip(path)
        return str(group["uns"]["nimbus"]["datasetId"][()])
    except (OSError, KeyError, ValueError, zipfile.BadZipFile) as exc:
        raise XeniumError(
            f"{path} is not a spatial table built by build_spatial_table "
            f"(no uns/nimbus/datasetId): {exc}"
        ) from exc


def upload_spatial_table(ds: Dataset, path: str | os.PathLike) -> dict:
    """Upload and register a ``build_spatial_table`` file on ``ds`` — only
    if the file was built for ``ds``: the table records its dataset, and
    its join keys match nothing anywhere else."""
    built_for = spatial_table_dataset(path)
    if built_for != ds.id:
        raise XeniumError(
            f"{path} was built for dataset {built_for}, not {ds.id}"
        )
    return ds.spatial.upload_and_register(path)


# --- molecules ---


def register_transcripts(
    ds: Dataset,
    bundle: XeniumBundle,
    frame: CellMap | ImageFrame,
    *,
    item_id: str | None = None,
) -> dict:
    """Upload ``transcripts.zarr.zip`` as shipped and register it.

    The file is already a level-of-detail pyramid, so nothing is rebuilt;
    registration records how molecules land on ``ds``: ``frame``'s pixel
    size and, for the H&E image, its inverse alignment. Pass the dataset's
    ``CellMap`` (its polygons' frame, so molecules and cells line up) or an
    explicit ``ImageFrame``. ``item_id`` registers an item already in the
    folder and skips the (slow) upload.
    """
    frame = _frame_for(ds, frame)
    if frame.pixel_size is None:
        raise XeniumError("registering transcripts needs a pixel size")
    if item_id is None:
        path = bundle.transcripts_zarr
        bundle.require(path)
        logger.info(
            "  uploading %s (%.1f GB)", path, os.path.getsize(path) / 1e9
        )
        item_id = ds.spatial.upload_transcripts(path)["_id"]
        logger.info("  uploaded as item %s", item_id)
    return ds.spatial.register_transcripts(
        item_id, frame.pixel_size, frame.transform
    )


# --- regions ---


def region_annotations(
    geojson: dict,
    dataset_id: str,
    frame: ImageFrame,
    *,
    drawn_in: str,
    tag: str = REGION_TAG,
) -> list[Annotation]:
    """Tagged polygon annotations from a GeoJSON FeatureCollection.

    Each outer ring becomes one polygon tagged ``[<class>, tag]`` — class
    first, because GeoJSON export writes the first tag as QuPath's
    ``classification``. ``drawn_in`` is what the file's coordinates are
    (``"he"``, ``"morphology"`` px or ``"microns"``); ``frame`` is the
    dataset's (see ``ImageFrame.region_transform``).
    """
    to_pixels = frame.region_transform(drawn_in)
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
    frame: CellMap | ImageFrame,
    *,
    drawn_in: str,
    alignment=None,
    tag: str = REGION_TAG,
) -> list[Annotation]:
    """Upload region polygons (e.g. a pathologist's layer, which 10x ships in
    H&E pixels) for the Region statistics dialog.

    ``region`` is a reserved tag: spatial analyses never treat those polygons
    as cells. ``frame`` is the dataset's ``CellMap`` or an explicit
    ``ImageFrame``. On the morphology image, regions drawn in H&E pixels
    need an alignment: pass ``alignment`` to add it to a frame that lacks
    one (one that differs from the frame's own is an error).
    """
    frame = _frame_for(ds, frame).with_alignment(alignment)
    if not isinstance(geojson, dict):
        try:
            geojson = json.loads(Path(geojson).read_text())
        except (OSError, ValueError) as exc:
            raise XeniumError(f"cannot read GeoJSON {geojson}: {exc}") from exc
    annotations = region_annotations(
        geojson, ds.id, frame, drawn_in=drawn_in, tag=tag
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

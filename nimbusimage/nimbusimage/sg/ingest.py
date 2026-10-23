"""Upload steps of the Spatial Genomics ingest.

Reuses the Xenium machinery where the data model is the same (channel
staging, polygon annotations, property helpers, the spatial-table upload
that refuses another dataset's table); what differs is how each input is
read and that the transcript list must be converted into a store.
"""

from __future__ import annotations

import datetime
import logging
import os
import tempfile
import time
from collections import Counter
from pathlib import Path

import numpy as np

from nimbusimage.sg.cells import SGCellMap
from nimbusimage.sg.errors import SGError
from nimbusimage.sg.export import SGRoi
from nimbusimage.sg.transcripts import write_transcript_store
from nimbusimage.xenium.bundle import staged_channel_file_name
from nimbusimage.xenium.errors import XeniumError
from nimbusimage.xenium.ingest import (
    SPATIAL_TABLE_SCHEMA_VERSION,
    _configure_channels,
    _polygon_annotation,
    _prepare_property,
    _zip_directory,
    upload_spatial_table as _upload_table,
)

logger = logging.getLogger("nimbusimage.sg")

CELL_TAG = "cell"
CLUSTER_TAG_PREFIX = "Leiden "
SOURCE_FORMAT = "spatial-genomics"


def _source(roi: SGRoi) -> dict:
    return {
        "format": SOURCE_FORMAT,
        "project": roi.project,
        "roi": roi.name,
        "pixelSize": roi.pixel_size,
    }


# --- images ---


def upload_images(
    client,
    roi: SGRoi,
    name: str,
    parent_folder_id: str | None = None,
    wait: bool = True,
):
    """A dataset from the ROI's ``mini_project/roi_N/images``, one channel
    per file (``DAPI`` first), named by file (``GFP_image`` -> ``GFP``).
    Waits for the transcode unless ``wait=False``."""
    images = roi.image_paths()
    for channel, path in images:
        logger.info("  %s -> %s", path.name, channel)
    dataset = client.create_dataset(name, parent_folder_id=parent_folder_id)
    with tempfile.TemporaryDirectory() as stage:
        for index, (channel, path) in enumerate(images):
            staged = Path(stage) / staged_channel_file_name(index, channel)
            staged.symlink_to(path.resolve())
        dataset.upload(stage)
    try:
        result = (
            dataset.configure()
            if len(images) == 1
            else _configure_channels(dataset, len(images))
        )
    except XeniumError as exc:
        raise SGError(str(exc)) from exc
    logger.info("  channels: %s", result.config["channels"])
    if result.job_id and wait:
        logger.info("  waiting for the transcode job")
        if not client.job(result.job_id).wait():
            raise SGError("transcode job failed")
    return dataset


# --- polygons ---


def upload_polygons(
    ds,
    roi: SGRoi,
    *,
    tags: list[str] | None = None,
    batch: int = 5000,
    limit: int | None = None,
) -> SGCellMap:
    """Bulk-create the ROI's cell polygons (``px = um / pixel_size``).

    Returns the cell map; save it (``.save(path)``), every later step
    takes it. Polygons with fewer than three vertices are skipped.
    """
    tags = [CELL_TAG] if tags is None else list(tags)
    if batch < 1:
        raise SGError(f"batch must be >= 1, got {batch}")
    if limit is not None and int(limit) < 1:
        # labels[:-1] would upload nearly every cell
        raise SGError(f"limit must be >= 1 (or None for all), got {limit}")
    pixel_size = roi.pixel_size
    labels, rings = roi.polygons()
    stop = len(labels) if limit is None else min(int(limit), len(labels))
    logger.info(
        "%s cell polygons (%s uploaded) at %s um/px",
        f"{len(labels):,}", f"{stop:,}", pixel_size,
    )
    kept_labels, ids = [], []
    buffer, buffer_labels = [], []
    started = time.time()

    def flush():
        created = ds.annotations.create_many(buffer)
        if len(created) != len(buffer):
            raise SGError(
                f"server created {len(created)} of {len(buffer)} annotations"
            )
        kept_labels.extend(buffer_labels)
        ids.extend(annotation.id for annotation in created)
        buffer.clear()
        buffer_labels.clear()

    for label, ring in zip(labels[:stop], rings[:stop]):
        if len(ring) < 3:
            continue
        px = ring / pixel_size
        buffer.append(
            _polygon_annotation(
                ds.id, tags, [{"x": float(x), "y": float(y)} for x, y in px]
            )
        )
        buffer_labels.append(int(label))
        if len(buffer) >= batch:
            flush()
            logger.info(
                "  %s/%s (%.0fs)", f"{len(ids):,}", f"{stop:,}",
                time.time() - started,
            )
    if buffer:
        flush()
    logger.info("DONE %s polygons in %.0fs", f"{len(ids):,}",
                time.time() - started)
    return SGCellMap(
        ds.id, roi.name, roi.project, pixel_size, kept_labels, ids,
        tags=tags,
    )


# --- per-cell data ---


def upload_cell_data(
    ds,
    roi: SGRoi,
    cells: SGCellMap,
    *,
    base_tags: list[str] | None = None,
    chunk: int = 5000,
    verify_sample: int = 20,
) -> Counter:
    """From the export: per cell

    - tags ``base_tags + ["Leiden k"]`` (categorical, for the tag filter
      and selection summary; replaces the cell's tags). ``base_tags``
      defaults to the tags the polygons were created with (``cells.tags``),
    - ``SG Area / area_um2`` (CellCoordinates),
    - ``UMAP / x, y`` and ``Clustering / leiden`` (the h5ad) — the numeric
      cluster is what Color by Property (and so the overview raster) can
      color by.

    Property values are replaced, not merged (a re-run is exact). Returns
    cluster sizes.
    """
    # Before any write: chunk < 1 would skip every tag update while the
    # property writes still ran, and a negative sample fails only after them.
    if chunk < 1:
        raise SGError(f"chunk must be >= 1, got {chunk}")
    if verify_sample < 0:
        raise SGError(f"verify_sample must be >= 0, got {verify_sample}")
    cells.check(ds, roi)
    base_tags = list(cells.tags if base_tags is None else base_tags)
    id_of = cells.id_of
    coords = roi.coordinates()
    unknown = sorted(set(id_of) - set(coords.index.tolist()))
    if unknown:
        raise SGError(
            f"{len(unknown)} mapped cells are not in CellCoordinates "
            f"(e.g. {unknown[:5]})"
        )
    clusters = roi.clusters()

    leiden_of: dict[int, int] = {}
    umap_of: dict[int, np.ndarray] = {}
    if clusters is not None:
        if clusters["leiden"] is not None:
            leiden_of = {
                int(label): int(value)
                for label, value in zip(clusters["labels"], clusters["leiden"])
                if value >= 0
            }
        if clusters["umap"] is not None:
            umap_of = dict(zip(clusters["labels"].tolist(), clusters["umap"]))
    else:
        logger.info("  no clusters h5ad: area only, no Leiden or UMAP")

    def tags_for(label: int) -> list[str]:
        if label in leiden_of:
            return [*base_tags, f"{CLUSTER_TAG_PREFIX}{leiden_of[label]}"]
        return list(base_tags)

    # Every input is read before the first write.
    area = {
        id_of[label]: {"area_um2": float(coords.at[label, "area"])}
        for label in id_of
    }
    umap = {
        id_of[label]: {"x": float(umap_of[label][0]),
                       "y": float(umap_of[label][1])}
        for label in id_of
        if label in umap_of and np.isfinite(umap_of[label]).all()
    }
    leiden = {
        id_of[label]: {"leiden": leiden_of[label]}
        for label in id_of
        if label in leiden_of
    }

    updates = [(id_of[label], {"tags": tags_for(label)}) for label in id_of]
    for start in range(0, len(updates), chunk):
        ds.annotations.update_many(updates[start:start + chunk])
    logger.info("  tagged %s cells", f"{len(updates):,}")

    for name, values in (
        ("SG Area", area), ("UMAP", umap), ("Clustering", leiden)
    ):
        if not values:
            continue
        prop = _prepare_property(ds, name, replace=True)
        ds.properties.submit_values(prop.id, values)
        logger.info("  %s: %s cells", name, f"{len(values):,}")

    rng = np.random.default_rng(0)
    sample = rng.choice(
        cells.labels, size=min(verify_sample, len(cells)), replace=False
    )
    read_back = {
        a.id: a.tags
        for a in ds.annotations.get_many([id_of[int(lb)] for lb in sample])
    }
    for label in sample:
        actual = read_back.get(id_of[int(label)])
        if actual is None or sorted(actual) != sorted(tags_for(int(label))):
            raise SGError(
                f"tag read-back failed for label {label}: {actual!r}"
            )
    return Counter(leiden_of[label] for label in id_of if label in leiden_of)


# --- the full matrix as a spatial table ---


def build_spatial_table(
    roi: SGRoi, cells: SGCellMap, out: str | os.PathLike
) -> Path:
    """Write the dataset's ``spatial.zarr.zip`` from ``CellxGene.csv``.

    ::

        X              raw counts, cells x genes, CSC
        layers/X_csr   the same, CSR
        obs            annotation_id (the join key), cell_index (= label),
                       cell_type ("Leiden k"), leiden
        var            index = symbol; gene_id (Ensembl, from the h5ad);
                       feature_type "gene"; feature_name (as exported)
        obsm/X_umap    when the h5ad has one
        uns/nimbus     schemaVersion, datasetId, source, created

    Rows are the mapped cells (others are dropped and logged).
    """
    import anndata as ad
    import pandas as pd

    cells.check(None, roi)
    ad.settings.zarr_write_format = 2  # the server reads with zarr 2
    out = Path(out)
    labels, symbols, names, counts = roi.counts()
    id_of = cells.id_of
    unmatched = sorted(set(id_of) - set(labels.tolist()))
    if unmatched:
        # Every uploaded cell needs its row; a short table would register
        # and verify as complete while some cells silently have no data.
        raise SGError(
            f"{len(unmatched)} mapped cells have no CellxGene row "
            f"(e.g. labels {unmatched[:5]})"
        )
    keep = np.array([int(label) in id_of for label in labels])
    if (~keep).any():
        logger.info("  dropping %d matrix rows without a polygon",
                    int((~keep).sum()))
    labels, counts = labels[keep], counts[keep]
    clusters = roi.clusters() or {}
    leiden_of, umap_of = {}, {}
    if clusters.get("leiden") is not None:
        leiden_of = dict(zip(clusters["labels"].tolist(),
                             clusters["leiden"].tolist()))
    if clusters.get("umap") is not None:
        umap_of = dict(zip(clusters["labels"].tolist(), clusters["umap"]))
    gene_ids = clusters.get("gene_ids") or {}

    obs = pd.DataFrame(index=[str(label) for label in labels])
    obs["annotation_id"] = np.array(
        [id_of[int(label)] for label in labels], dtype=object
    )
    obs["cell_index"] = labels.astype(np.int64)
    if leiden_of:
        cluster = [leiden_of.get(int(label), -1) for label in labels]
        obs["cell_type"] = pd.Categorical(
            [f"{CLUSTER_TAG_PREFIX}{c}" if c >= 0 else "unclustered"
             for c in cluster]
        )
        obs["leiden"] = np.array(cluster, dtype=np.int32)
    var = pd.DataFrame(index=pd.Index(symbols, name="symbol"))
    var["gene_id"] = [gene_ids.get(name, "") for name in names]
    var["feature_type"] = "gene"
    var["feature_name"] = names

    matrix = counts.astype(np.float32).tocsc()
    adata = ad.AnnData(X=matrix, obs=obs, var=var)
    adata.layers["X_csr"] = matrix.tocsr()
    if umap_of:
        adata.obsm["X_umap"] = np.array(
            [umap_of.get(int(label), (np.nan, np.nan)) for label in labels],
            dtype=np.float32,
        )
    adata.uns["nimbus"] = {
        "schemaVersion": SPATIAL_TABLE_SCHEMA_VERSION,
        "datasetId": cells.dataset_id,
        "source": f"{roi.project}/{roi.name} (Spatial Genomics)",
        "created": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }
    with tempfile.TemporaryDirectory() as tmp:
        store_dir = Path(tmp) / "spatial.zarr"
        adata.write_zarr(store_dir)
        _zip_directory(store_dir, out)
    logger.info(
        "  table %s cells x %s genes, nnz %s -> %s (%.1f MB)",
        f"{matrix.shape[0]:,}", f"{matrix.shape[1]:,}", f"{matrix.nnz:,}",
        out, out.stat().st_size / 1e6,
    )
    return out


def upload_spatial_table(ds, path: str | os.PathLike) -> dict:
    """Upload and register a table built for ``ds`` (refuses another
    dataset's)."""
    try:
        return _upload_table(ds, path)
    except XeniumError as exc:
        raise SGError(str(exc)) from exc


# --- molecules ---


def build_transcript_store(roi: SGRoi, out: str | os.PathLike) -> Path:
    """Convert ``TranscriptList.csv`` into a registrable transcript store
    (see :mod:`nimbusimage.sg.transcripts`)."""
    gene_names, genes, xyz = roi.transcripts()
    logger.info("  %s molecules, %d genes", f"{len(genes):,}",
                len(gene_names))
    return write_transcript_store(
        gene_names, genes, xyz, out, source=_source(roi)
    )


def transcript_store_source(path: str | os.PathLike) -> dict:
    """The ``nimbus_source`` a store was written with ({} if none)."""
    import zipfile
    import json

    try:
        with zipfile.ZipFile(path) as zf:
            attrs = json.loads(zf.read(".zattrs"))
    except (OSError, KeyError, ValueError, zipfile.BadZipFile) as exc:
        raise SGError(f"{path} is not a transcript store: {exc}") from exc
    return attrs.get("nimbus_source") or {}


def register_transcripts(
    ds, cells: SGCellMap, path: str | os.PathLike
) -> dict:
    """Upload a store from :func:`build_transcript_store` and register it
    at the cell map's pixel size — the frame the polygons were drawn in.
    Refuses a store written for another ROI."""
    cells.check(ds)
    source = transcript_store_source(path)
    expected = (cells.project, cells.roi)
    if (source.get("project"), source.get("roi")) != expected:
        raise SGError(
            f"{path} was built from {source.get('project')}/"
            f"{source.get('roi')}, the cell map is of "
            f"{cells.project}/{cells.roi}"
        )
    item = ds.spatial.upload_transcripts(path)
    return ds.spatial.register_transcripts(
        item["_id"], pixel_size=cells.pixel_size, transform=None
    )

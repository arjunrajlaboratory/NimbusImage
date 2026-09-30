"""``nimbusimage-xenium`` (or ``python -m nimbusimage.xenium``): the Xenium
ingest from the shell, one subcommand per step.

Credentials come from the environment: NI_API_URL + NI_API_KEY (or
NI_TOKEN), or NI_USERNAME + NI_PASSWORD. Progress goes to stderr; the only
stdout output is ``morphology``'s new dataset id, so it can be captured::

    MORPH=$(nimbusimage-xenium morphology --bundle-dir extracted --name LN)
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path

import numpy as np

from nimbusimage.xenium.bundle import (
    CELL_POLYGON_SET,
    NUCLEUS_POLYGON_SET,
    XeniumBundle,
)
from nimbusimage.xenium.errors import XeniumError
from nimbusimage.xenium.geometry import REGION_FRAMES, REGION_TARGETS
from nimbusimage.xenium import ingest

logger = logging.getLogger("nimbusimage.xenium")


def _connect():
    import nimbusimage as ni

    if os.environ.get("NI_API_KEY") or os.environ.get("NI_TOKEN"):
        return ni.connect()
    username, password = os.environ.get("NI_USERNAME"), os.environ.get(
        "NI_PASSWORD"
    )
    if not (username and password):
        raise XeniumError(
            "set NI_API_URL and NI_API_KEY (or NI_USERNAME + NI_PASSWORD) "
            "in the environment"
        )
    return ni.connect(username=username, password=password)


def _split(value: str | None) -> list[str]:
    return [item.strip() for item in (value or "").split(",") if item.strip()]


def _read_panel(args) -> list[str]:
    if args.genes:
        return _split(args.genes)
    if args.genes_file:
        try:
            lines = args.genes_file.read_text().splitlines()
        except OSError as exc:
            raise XeniumError(f"cannot read {args.genes_file}: {exc}") from exc
        return [s for s in (line.split("#")[0].strip() for line in lines) if s]
    return []


def _dataset_ids(args, bundle):
    ds = _connect().dataset(args.dataset)
    logger.info(
        "=== %s (%s cells) ===", ds.name, f"{bundle.number_of_cells:,}"
    )
    ids = ingest.load_annotation_ids(
        ds,
        bundle,
        args.ids,
        alignment=args.alignment,
        pixel_size=args.pixel_size,
    )
    return ds, ids


# --- subcommands ---
#
# Each one reads and validates its local inputs (bundle files, CSVs, the
# gene panel, the embedding, the alignment) before any slow or destructive
# server work — an id fetch, an upload, a delete — so a typo fails in a
# second. Connecting and opening the dataset first is harmless.


def cmd_morphology(args) -> None:
    dataset = ingest.upload_morphology(
        _connect(),
        XeniumBundle(args.bundle_dir),
        args.name,
        parent_folder_id=args.parent_folder,
        wait=not args.no_wait,
    )
    print(dataset.id)


def cmd_polygons(args) -> None:
    ds = _connect().dataset(args.dataset)
    # upload_polygons deletes --delete-tag only after reading its inputs.
    ids = ingest.upload_polygons(
        ds,
        XeniumBundle(args.bundle_dir),
        alignment=args.alignment,
        pixel_size=args.pixel_size,
        polygon_set=args.polygon_set,
        tags=_split(args.tags),
        batch=args.batch,
        limit=args.limit,
        delete_tag=args.delete_tag,
    )
    logger.info(
        "dataset now has %s polygon annotations",
        f"{ds.annotations.count(shape='polygon'):,}",
    )
    if args.ids_out:
        np.save(args.ids_out, ids)
        logger.info("saved annotation ids to %s", args.ids_out)


def cmd_umap(args) -> None:
    from nimbusimage.xenium.embedding import compute_umap

    compute_umap(
        XeniumBundle(args.bundle_dir),
        args.out,
        components=args.components,
        n_neighbors=args.n_neighbors,
        min_dist=args.min_dist,
        seed=args.seed,
    )


def cmd_properties(args) -> None:
    what = set(_split(args.what))
    if not what:
        raise XeniumError("--what is empty; pick from genes,clusters,umap")
    unknown = what - {"genes", "clusters", "umap"}
    if unknown:
        raise XeniumError(f"unknown --what entries: {sorted(unknown)}")
    panel = _read_panel(args) if "genes" in what else []
    if "genes" in what and not panel:
        raise XeniumError("--what genes needs --genes or --genes-file")
    if "umap" in what and not args.umap:
        raise XeniumError(
            "--what umap needs --umap umap_xy.npy (see the umap step)"
        )

    bundle = XeniumBundle(args.bundle_dir)
    if panel:
        bundle.gene_rows(panel)
    clusters = bundle.cell_groups() if "clusters" in what else None
    embedding = (
        ingest.load_embedding(args.umap, bundle.number_of_cells)
        if "umap" in what
        else None
    )

    ds, ids = _dataset_ids(args, bundle)
    common = dict(chunk=args.chunk, limit=args.limit, replace=args.replace)
    if panel:
        ingest.upload_gene_panel(
            ds, bundle, ids, panel, dense=not args.sparse, **common
        )
    if clusters is not None:
        ingest.upload_clusters(ds, bundle, ids, labels=clusters, **common)
    if embedding is not None:
        ingest.upload_umap(ds, bundle, ids, embedding, **common)


def cmd_cell_types(args) -> None:
    bundle = XeniumBundle(args.bundle_dir)
    # --reset writes only --base-tags, so a CSV with gaps is fine there.
    labels = bundle.cell_types(args.cell_types, complete=not args.reset)
    ds, ids = _dataset_ids(args, bundle)
    ingest.upload_cell_types(
        ds,
        bundle,
        ids,
        labels,
        base_tags=_split(args.base_tags),
        chunk=args.chunk,
        limit=args.limit,
        reset=args.reset,
    )


def cmd_spatial_table(args) -> None:
    bundle = XeniumBundle(args.bundle_dir)
    bundle.require(bundle.feature_matrix_zarr, bundle.analysis_zarr)
    labels = (
        bundle.cell_types(args.cell_types, complete=False)
        if args.cell_types
        else None
    )
    embedding = (
        ingest.load_embedding(args.umap, bundle.number_of_cells)
        if args.umap
        else None
    )
    ds, ids = _dataset_ids(args, bundle)
    out = ingest.build_spatial_table(
        bundle,
        ids,
        args.out or bundle.directory / "spatial.zarr.zip",
        dataset_id=ds.id,
        cell_types=labels,
        umap=embedding,
    )
    if args.no_upload:
        return
    entry = ds.spatial.upload_and_register(out)
    logger.info(
        "  registered: %s cells x %s features (schema v%s)",
        f"{entry['nObs']:,}",
        f"{entry['nVar']:,}",
        entry["schemaVersion"],
    )


def cmd_transcripts(args) -> None:
    # register_transcripts reads the alignment and pixel size before its
    # upload, so a bad input fails before the multi-GB transfer.
    ds = _connect().dataset(args.dataset)
    logger.info("=== %s ===", ds.name)
    schema = ingest.register_transcripts(
        ds,
        XeniumBundle(args.bundle_dir),
        alignment=args.alignment,
        pixel_size=args.pixel_size,
        item_id=args.item,
    )
    logger.info(
        "  registered: %s molecules, %s genes, %s pyramid levels%s",
        f"{schema['totalPoints']:,}",
        f"{schema['genes']:,}",
        schema["levels"],
        " with H&E transform" if args.alignment else "",
    )


def cmd_regions(args) -> None:
    pixel_size = None
    if args.frame == "microns":
        if args.bundle_dir is None:
            raise XeniumError("--frame microns needs --bundle-dir")
        pixel_size = (
            args.pixel_size or XeniumBundle(args.bundle_dir).pixel_size
        )
    ingest.upload_regions(
        _connect().dataset(args.dataset),
        args.geojson,
        frame=args.frame,
        target=args.target,
        alignment=args.alignment,
        pixel_size=pixel_size,
        tag=args.tag,
    )


# --- parser ---


def _add_dataset_args(parser, *, ids: bool = True) -> None:
    parser.add_argument(
        "--bundle-dir",
        type=Path,
        required=True,
        help="the extracted Xenium bundle",
    )
    parser.add_argument(
        "--dataset", required=True, help="NimbusImage dataset (folder) id"
    )
    parser.add_argument(
        "--alignment",
        type=Path,
        default=None,
        help="*_he_imagealignment.csv when the dataset is the H&E image "
        "(also needed there to verify a cached --ids file)",
    )
    if ids:
        parser.add_argument(
            "--pixel-size",
            type=float,
            default=None,
            help="um/px the polygons were uploaded with, if overridden "
            "(default: experiment.xenium); used to verify --ids",
        )
        parser.add_argument(
            "--ids",
            type=Path,
            default=None,
            help=".npy of annotation ids in cell_index order "
            "(from polygons --ids-out); fetched, verified and "
            "cached here if absent",
        )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="nimbusimage-xenium",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser(
        "morphology",
        help="create a dataset from morphology_focus/, "
        "channels named by stain; prints its id",
    )
    p.add_argument("--bundle-dir", type=Path, required=True)
    p.add_argument("--name", required=True, help="dataset name")
    p.add_argument(
        "--parent-folder",
        default=None,
        help="folder to create the dataset in (default: Private)",
    )
    p.add_argument(
        "--no-wait",
        action="store_true",
        help="return once the transcode job is queued",
    )
    p.set_defaults(func=cmd_morphology)

    p = sub.add_parser(
        "polygons", help="upload segmentation polygons in cell_index order"
    )
    _add_dataset_args(p, ids=False)
    p.add_argument(
        "--pixel-size",
        type=float,
        default=None,
        help="um/px override (default: experiment.xenium)",
    )
    p.add_argument(
        "--polygon-set",
        default=CELL_POLYGON_SET,
        choices=[CELL_POLYGON_SET, NUCLEUS_POLYGON_SET],
    )
    p.add_argument("--tags", default="cell", help="comma-separated tags")
    p.add_argument("--batch", type=int, default=5000)
    p.add_argument(
        "--limit", type=int, default=None, help="only the first N polygons"
    )
    p.add_argument(
        "--delete-tag",
        default=None,
        help="first delete every annotation carrying this tag",
    )
    p.add_argument(
        "--ids-out",
        type=Path,
        default=None,
        help="save the created ids (cell_index order) to this .npy",
    )
    p.set_defaults(func=cmd_polygons)

    p = sub.add_parser(
        "umap", help="compute a UMAP (needs the xenium-umap extra)"
    )
    p.add_argument("--bundle-dir", type=Path, required=True)
    p.add_argument("--out", type=Path, default=Path("."))
    p.add_argument("--components", type=int, default=50)
    p.add_argument("--n-neighbors", type=int, default=15)
    p.add_argument("--min-dist", type=float, default=0.3)
    p.add_argument("--seed", type=int, default=0)
    p.set_defaults(func=cmd_umap)

    p = sub.add_parser(
        "properties",
        help="gene panel, clusterings and UMAP as nested property values",
    )
    _add_dataset_args(p)
    p.add_argument(
        "--what",
        default="genes",
        help="comma-separated subset of genes,clusters,umap",
    )
    p.add_argument(
        "--genes", default=None, help="comma-separated gene symbols"
    )
    p.add_argument(
        "--genes-file",
        type=Path,
        default=None,
        help="one gene symbol per line (# comments allowed)",
    )
    p.add_argument("--umap", type=Path, default=None, help="umap_xy.npy")
    p.add_argument("--chunk", type=int, default=20000)
    p.add_argument(
        "--limit", type=int, default=None, help="only the first N cells"
    )
    p.add_argument(
        "--sparse",
        action="store_true",
        help="genes: omit zero counts (default: explicit zeros)",
    )
    p.add_argument(
        "--replace",
        action="store_true",
        help="delete the property's existing values first",
    )
    p.set_defaults(func=cmd_properties)

    p = sub.add_parser("cell-types", help="cell-type calls as tags")
    _add_dataset_args(p)
    p.add_argument(
        "--cell-types", type=Path, required=True, help="*_cell_types.csv"
    )
    p.add_argument(
        "--base-tags",
        default="cell",
        help="comma-separated tags every cell keeps",
    )
    p.add_argument("--chunk", type=int, default=5000)
    p.add_argument(
        "--limit", type=int, default=None, help="only the first N cells"
    )
    p.add_argument(
        "--reset",
        action="store_true",
        help="write --base-tags only (removes the cell-type tags)",
    )
    p.set_defaults(func=cmd_cell_types)

    p = sub.add_parser(
        "spatial-table",
        help="build, upload and register the "
        "full matrix as spatial.zarr.zip",
    )
    _add_dataset_args(p)
    p.add_argument(
        "--cell-types", type=Path, default=None, help="*_cell_types.csv"
    )
    p.add_argument("--umap", type=Path, default=None, help="umap_xy.npy")
    p.add_argument(
        "--out",
        type=Path,
        default=None,
        help="default: <bundle-dir>/spatial.zarr.zip",
    )
    p.add_argument(
        "--no-upload", action="store_true", help="build the file only"
    )
    p.set_defaults(func=cmd_spatial_table)

    p = sub.add_parser(
        "transcripts",
        help="upload and register transcripts.zarr.zip as shipped",
    )
    _add_dataset_args(p, ids=False)
    p.add_argument(
        "--item",
        default=None,
        help="register this already-uploaded item instead",
    )
    p.add_argument(
        "--pixel-size",
        type=float,
        default=None,
        help="um/px override, as given to polygons "
        "(default: experiment.xenium)",
    )
    p.set_defaults(func=cmd_transcripts)

    p = sub.add_parser("regions", help="GeoJSON regions as tagged polygons")
    p.add_argument("--geojson", type=Path, required=True)
    p.add_argument(
        "--dataset", required=True, help="NimbusImage dataset (folder) id"
    )
    p.add_argument(
        "--frame",
        choices=REGION_FRAMES,
        required=True,
        help="what the GeoJSON is drawn in (10x ships H&E pixels)",
    )
    p.add_argument(
        "--target",
        choices=REGION_TARGETS,
        default="morphology",
        help="which image the dataset shows",
    )
    p.add_argument(
        "--alignment",
        type=Path,
        default=None,
        help="*_he_imagealignment.csv (H&E px -> morphology px)",
    )
    p.add_argument(
        "--bundle-dir",
        type=Path,
        default=None,
        help="for --frame microns: reads pixel_size",
    )
    p.add_argument("--tag", default=ingest.REGION_TAG)
    p.add_argument(
        "--pixel-size",
        type=float,
        default=None,
        help="um/px override, as given to polygons "
        "(default: experiment.xenium)",
    )
    p.set_defaults(func=cmd_regions)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(
        logging.Formatter("[%(asctime)s] %(message)s", "%H:%M:%S")
    )
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    try:
        args.func(args)
    except XeniumError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    finally:
        logger.removeHandler(handler)
    return 0

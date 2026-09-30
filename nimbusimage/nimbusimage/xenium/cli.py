"""``nimbusimage-xenium`` (or ``python -m nimbusimage.xenium``): the Xenium
ingest from the shell, one subcommand per step.

Credentials come from the environment: NI_API_URL + NI_API_KEY (or
NI_TOKEN), or NI_USERNAME + NI_PASSWORD. Progress goes to stderr; the only
stdout output is ``morphology``'s new dataset id, so it can be captured::

    MORPH=$(nimbusimage-xenium morphology --bundle-dir extracted --name LN)

``polygons --cells-out cells.npz`` saves the dataset's cell map (ids, the
dataset they belong to, and the frame they were drawn with); every later
step takes it as ``--cells`` and reuses that frame, so ``--alignment`` and
``--pixel-size`` are given once, to ``polygons``.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path


from nimbusimage.xenium import ingest
from nimbusimage.xenium.bundle import (
    CELL_POLYGON_SET,
    NUCLEUS_POLYGON_SET,
    XeniumBundle,
)
from nimbusimage.xenium.cells import CellMap, open_cells, read_frame
from nimbusimage.xenium.errors import XeniumError
from nimbusimage.xenium.geometry import (
    IMAGES,
    REGION_FRAMES,
    ImageFrame,
    load_alignment,
    same_value,
)

logger = logging.getLogger("nimbusimage.xenium")


def _connect():
    import nimbusimage as ni

    if os.environ.get("NI_API_KEY") or os.environ.get("NI_TOKEN"):
        return ni.connect()
    username = os.environ.get("NI_USERNAME")
    password = os.environ.get("NI_PASSWORD")
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


# --- the dataset's frame and cell map ---
#
# One rule, applied to every subcommand before any server write: a frame
# comes from the dataset's saved --cells map, or is stated by flags
# (--image/--alignment/--pixel-size). Flags given alongside a saved map must
# agree with it (compared by geometry.same_value); only `regions` may add an
# alignment the map lacks. Defaults are used only where the result is
# verified against the server (per-cell steps); transcripts and regions,
# which have nothing to verify against, never guess.


def _check_flags(args) -> None:
    """Validate the frame flags before connecting (pixel sizes are checked
    by argparse)."""
    load_alignment(getattr(args, "alignment", None))


def _stated_frame(args, bundle, *, infer_image=True) -> ImageFrame | None:
    """The frame the flags state, or None when no frame flag is given.

    ``--alignment`` alone means "the dataset is the H&E image" — except for
    regions (``infer_image=False``), where it can also be the matrix that
    carries H&E-drawn regions onto the morphology image. There the image is
    never inferred: ``--image`` must say which it is.
    """
    image = getattr(args, "image", None)
    alignment = getattr(args, "alignment", None)
    pixel_size = getattr(args, "pixel_size", None)
    if image is None and alignment is None and pixel_size is None:
        return None
    if image is None and not infer_image:
        raise XeniumError(
            "regions need --image (or --target) without --cells: whether "
            "the dataset is the H&E or the morphology image decides where "
            "every region lands, and no flag implies it"
        )
    return ImageFrame.create(
        bundle=bundle, alignment=alignment, pixel_size=pixel_size, image=image
    )


def _require_flags_match(args, saved: ImageFrame, *, may_add_alignment=False):
    image = getattr(args, "image", None)
    alignment = load_alignment(getattr(args, "alignment", None))
    pixel_size = getattr(args, "pixel_size", None)
    conflicts = []
    if image is not None and image != saved.image:
        conflicts.append(f"--image {image}")
    if pixel_size is not None and not same_value(pixel_size, saved.pixel_size):
        conflicts.append(f"--pixel-size {pixel_size}")
    if alignment is not None:
        if saved.alignment is None:
            if not may_add_alignment:
                conflicts.append("--alignment (the saved frame has none)")
        elif not same_value(alignment, saved.alignment):
            conflicts.append("--alignment")
    if conflicts:
        raise XeniumError(
            f"{', '.join(conflicts)} conflicts with the {saved} saved in "
            f"{args.cells}"
        )


def _saved_map(args) -> CellMap | None:
    """The saved map in --cells, None for no file / a bare-id file."""
    path = getattr(args, "cells", None)
    if path is None or not Path(path).exists():
        return None
    stored = CellMap.read(path)
    return stored if isinstance(stored, CellMap) else None


def _dataset_cells(args, bundle):
    _check_flags(args)
    ds = _connect().dataset(args.dataset)
    logger.info(
        "=== %s (%s cells) ===", ds.name, f"{bundle.number_of_cells:,}"
    )
    saved = _saved_map(args)
    if saved is not None:
        # open_cells checks the dataset; here only flags vs the saved frame.
        _require_flags_match(args, saved.frame)
        frame = None  # open_cells uses the saved frame
    else:
        frame = _stated_frame(args, bundle)  # None: the verified default
    return ds, open_cells(ds, bundle, args.cells, frame=frame)


def _frame_source(args, bundle, ds, *, regions=False) -> ImageFrame:
    """For transcripts and regions, the dataset's frame: the one saved in
    its --cells map (read by cells.read_frame, which checks the dataset),
    or the one the flags state — never a default. For regions, --alignment
    may add the matrix a saved morphology frame lacks."""
    if args.cells is not None:
        saved = read_frame(args.cells, ds)
        _require_flags_match(args, saved, may_add_alignment=regions)
        return saved.with_alignment(args.alignment) if regions else saved
    stated = _stated_frame(args, bundle, infer_image=not regions)
    if stated is None:
        raise XeniumError(
            "state the dataset's frame: --cells (the map polygons saved), "
            "or --image/--alignment/--pixel-size"
        )
    return stated


# --- subcommands ---
#
# Each one reads and validates its local inputs (bundle files, CSVs, the
# gene panel, the embedding, the frame) before any slow or destructive
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
    bundle = XeniumBundle(args.bundle_dir)
    _check_flags(args)
    frame = _stated_frame(args, bundle) or ImageFrame.create(bundle=bundle)
    if args.cells_out is not None:
        # Checked before the upload: a limited upload's map can be
        # re-derived, but a lost file should never be the first failure.
        out = Path(args.cells_out)
        if out.is_dir() or not out.parent.is_dir():
            raise XeniumError(f"cannot write the cell map to {out}")
        if not os.access(out.parent, os.W_OK) or (
            out.exists() and not os.access(out, os.W_OK)
        ):
            raise XeniumError(f"cannot write the cell map to {out}")
    ds = _connect().dataset(args.dataset)
    # upload_polygons deletes --delete-tag only after reading its inputs.
    cells = ingest.upload_polygons(
        ds,
        bundle,
        frame,
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
    if args.cells_out:
        cells.save(args.cells_out)
        logger.info("saved the cell map to %s", args.cells_out)


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

    ds, cells = _dataset_cells(args, bundle)
    common = dict(chunk=args.chunk, limit=args.limit, replace=args.replace)
    if panel:
        ingest.upload_gene_panel(
            ds, bundle, cells, panel, dense=not args.sparse, **common
        )
    if clusters is not None:
        ingest.upload_clusters(ds, bundle, cells, labels=clusters, **common)
    if embedding is not None:
        ingest.upload_umap(ds, bundle, cells, embedding, **common)


def cmd_cell_types(args) -> None:
    bundle = XeniumBundle(args.bundle_dir)
    # --reset writes only --base-tags, so a CSV with gaps is fine there.
    labels = bundle.cell_types(args.cell_types, complete=not args.reset)
    ds, cells = _dataset_cells(args, bundle)
    ingest.upload_cell_types(
        ds,
        bundle,
        cells,
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
    ds, cells = _dataset_cells(args, bundle)
    out = ingest.build_spatial_table(
        bundle,
        cells,
        args.out or bundle.directory / "spatial.zarr.zip",
        cell_types=labels,
        umap=embedding,
    )
    if args.no_upload:
        return
    entry = ingest.upload_spatial_table(ds, out)
    logger.info(
        "  registered: %s cells x %s features (schema v%s)",
        f"{entry['nObs']:,}",
        f"{entry['nVar']:,}",
        entry["schemaVersion"],
    )


def cmd_transcripts(args) -> None:
    bundle = XeniumBundle(args.bundle_dir)
    _check_flags(args)
    ds = _connect().dataset(args.dataset)
    source = _frame_source(args, bundle, ds)
    logger.info("=== %s === %s", ds.name, source)
    # register_transcripts checks its inputs before the multi-GB upload.
    schema = ingest.register_transcripts(ds, bundle, source, item_id=args.item)
    logger.info(
        "  registered: %s molecules, %s genes, %s pyramid levels",
        f"{schema['totalPoints']:,}",
        f"{schema['genes']:,}",
        schema["levels"],
    )


def cmd_regions(args) -> None:
    bundle = XeniumBundle(args.bundle_dir) if args.bundle_dir else None
    _check_flags(args)
    ds = _connect().dataset(args.dataset)
    ingest.upload_regions(
        ds,
        args.geojson,
        _frame_source(args, bundle, ds, regions=True),
        drawn_in=args.drawn_in,
        tag=args.tag,
    )


# --- parser ---


def _positive_int(value: str) -> int:
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError(f"must be >= 1, got {number}")
    return number


def _positive_float(value: str) -> float:
    number = float(value)
    if not number > 0:
        raise argparse.ArgumentTypeError(f"must be > 0, got {value}")
    return number


def _add_frame_args(parser, *, saved: bool, regions: bool = False) -> None:
    if regions:
        alignment_help = (
            "*_he_imagealignment.csv (H&E px -> morphology px): for regions "
            "drawn in H&E pixels on the morphology image, or with --image he"
        )
    else:
        alignment_help = (
            "*_he_imagealignment.csv (H&E px -> morphology px): marks the "
            "dataset as the H&E image"
            + ("; not needed with a saved --cells" if saved else "")
        )
    parser.add_argument(
        "--alignment",
        type=Path,
        default=None,
        help=alignment_help,
    )
    parser.add_argument(
        "--pixel-size",
        type=_positive_float,
        default=None,
        help="um per morphology px, to override experiment.xenium"
        + ("; not needed with a saved --cells" if saved else ""),
    )


def _add_cells_arg(parser, *, required_file: bool = False) -> None:
    parser.add_argument(
        "--cells",
        "--ids",
        dest="cells",
        type=Path,
        default=None,
        help="the dataset's cell map from polygons --cells-out"
        + (
            "; its frame is reused (or state the frame with --image/"
            "--alignment/--pixel-size)"
            if required_file
            else "; re-derived, verified and saved here if absent"
        ),
    )


def _add_image_arg(parser, *aliases) -> None:
    parser.add_argument(
        "--image",
        *aliases,
        dest="image",
        choices=IMAGES,
        default=None,
        help="which image the dataset shows, when there is no --cells "
        "(transcripts: --alignment alone implies he; regions: required)",
    )


def _add_dataset_args(parser) -> None:
    parser.add_argument(
        "--bundle-dir",
        type=Path,
        required=True,
        help="the extracted Xenium bundle",
    )
    parser.add_argument(
        "--dataset", required=True, help="NimbusImage dataset (folder) id"
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
    _add_dataset_args(p)
    _add_frame_args(p, saved=False)
    p.add_argument(
        "--polygon-set",
        default=CELL_POLYGON_SET,
        choices=[CELL_POLYGON_SET, NUCLEUS_POLYGON_SET],
        help="nucleus polygons are for display; per-cell steps need cells",
    )
    p.add_argument("--tags", default="cell", help="comma-separated tags")
    p.add_argument("--batch", type=_positive_int, default=5000)
    p.add_argument(
        "--limit",
        type=_positive_int,
        default=None,
        help="only the first N polygons",
    )
    p.add_argument(
        "--delete-tag",
        default=None,
        help="first delete every annotation carrying this tag",
    )
    p.add_argument(
        "--cells-out",
        "--ids-out",
        dest="cells_out",
        type=Path,
        default=None,
        help="save the cell map (ids + dataset + frame) to this file",
    )
    p.set_defaults(func=cmd_polygons)

    p = sub.add_parser(
        "umap", help="compute a UMAP (needs the xenium-umap extra)"
    )
    p.add_argument("--bundle-dir", type=Path, required=True)
    p.add_argument("--out", type=Path, default=Path("."))
    p.add_argument("--components", type=_positive_int, default=50)
    p.add_argument("--n-neighbors", type=_positive_int, default=15)
    p.add_argument("--min-dist", type=float, default=0.3)
    p.add_argument("--seed", type=int, default=0)
    p.set_defaults(func=cmd_umap)

    p = sub.add_parser(
        "properties",
        help="gene panel, clusterings and UMAP as nested property values",
    )
    _add_dataset_args(p)
    _add_cells_arg(p)
    _add_frame_args(p, saved=True)
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
    p.add_argument("--chunk", type=_positive_int, default=20000)
    p.add_argument(
        "--limit",
        type=_positive_int,
        default=None,
        help="only the first N cells",
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
    _add_cells_arg(p)
    _add_frame_args(p, saved=True)
    p.add_argument(
        "--cell-types", type=Path, required=True, help="*_cell_types.csv"
    )
    p.add_argument(
        "--base-tags",
        default="cell",
        help="comma-separated tags every cell keeps",
    )
    p.add_argument("--chunk", type=_positive_int, default=5000)
    p.add_argument(
        "--limit",
        type=_positive_int,
        default=None,
        help="only the first N cells",
    )
    p.add_argument(
        "--reset",
        action="store_true",
        help="write --base-tags only (removes the cell-type tags)",
    )
    p.set_defaults(func=cmd_cell_types)

    p = sub.add_parser(
        "spatial-table",
        help="build, upload and register the full matrix as spatial.zarr.zip",
    )
    _add_dataset_args(p)
    _add_cells_arg(p)
    _add_frame_args(p, saved=True)
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
    _add_dataset_args(p)
    _add_cells_arg(p, required_file=True)
    _add_image_arg(p)
    _add_frame_args(p, saved=True)
    p.add_argument(
        "--item",
        default=None,
        help="register this already-uploaded item instead",
    )
    p.set_defaults(func=cmd_transcripts)

    p = sub.add_parser("regions", help="GeoJSON regions as tagged polygons")
    p.add_argument("--geojson", type=Path, required=True)
    p.add_argument(
        "--dataset", required=True, help="NimbusImage dataset (folder) id"
    )
    p.add_argument(
        "--drawn-in",
        choices=REGION_FRAMES,
        required=True,
        help="what the GeoJSON coordinates are (10x ships H&E pixels)",
    )
    _add_image_arg(p, "--target")
    _add_cells_arg(p, required_file=True)
    _add_frame_args(p, saved=True, regions=True)
    p.add_argument(
        "--bundle-dir",
        type=Path,
        default=None,
        help="for --drawn-in microns: reads pixel_size",
    )
    p.add_argument(
        "--tag",
        default=ingest.REGION_TAG,
        help="extra tag for the regions; 'region' is always kept, since "
        "spatial analyses treat polygons without it as cells",
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

"""``nimbusimage-sg`` (or ``python -m nimbusimage.sg``): the Spatial
Genomics ingest from the shell, one subcommand per step.

Credentials come from the environment: NI_API_URL + NI_API_KEY (or
NI_TOKEN), or NI_USERNAME + NI_PASSWORD. Progress goes to stderr; the only
stdout output is ``images``'s new dataset id and the JSON reports of
``inventory``, ``check`` and ``verify``::

    DS=$(nimbusimage-sg images --export-dir X --roi roi_3 --name "roi 3")

``ingest`` runs every step for one ROI. ``polygons --cells-out cells.npz``
saves the label -> annotation map; every later step takes it as
``--cells`` and refuses a map of another dataset or ROI.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from pathlib import Path

import girder_client

from nimbusimage.sg import cells as sg_cells
from nimbusimage.sg import ingest, verify
from nimbusimage.sg.errors import SGError
from nimbusimage.sg.export import SGRoi, list_rois

logger = logging.getLogger("nimbusimage.sg")

# A frame check below this fraction stops `ingest` before any upload.
MIN_FRAME_MATCH = 0.99


def _connect():
    try:
        return _connect_from_env()
    except ValueError as exc:  # e.g. a key without NI_API_URL
        raise SGError(str(exc)) from exc


def _connect_from_env():
    import nimbusimage as ni

    if os.environ.get("NI_API_KEY") or os.environ.get("NI_TOKEN"):
        return ni.connect()
    username = os.environ.get("NI_USERNAME")
    password = os.environ.get("NI_PASSWORD")
    if not (username and password):
        raise SGError(
            "set NI_API_URL and NI_API_KEY (or NI_USERNAME + NI_PASSWORD) "
            "in the environment"
        )
    return ni.connect(username=username, password=password)


def _server_message(exc) -> str:
    try:
        return json.loads(exc.responseText)["message"]
    except (ValueError, KeyError, TypeError):
        return str(exc)


def _require_writable(path: Path, what: str) -> None:
    """Checked before any upload or build: a lost cell map (or an output
    that cannot be written after minutes of work) should never be the
    first failure."""
    path = Path(path)
    parent = path.parent
    if (
        path.is_dir()
        or not parent.is_dir()
        or not os.access(parent, os.W_OK)
        or (path.exists() and not os.access(path, os.W_OK))
    ):
        raise SGError(f"cannot write the {what} to {path}")


def _print_json(value) -> None:
    print(json.dumps(value, indent=2, default=str))


def _roi(args) -> SGRoi:
    return SGRoi(args.export_dir, args.roi)


def _dataset(args, client=None):
    return (client or _connect()).dataset(args.dataset)


def _cells(args) -> sg_cells.SGCellMap:
    return sg_cells.SGCellMap.read(args.cells)


def _count_lines(path: Path) -> int:
    count = 0
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 24), b""):
            count += block.count(b"\n")
    return count


def _header_columns(path: Path) -> int:
    with open(path) as handle:
        return len(handle.readline().split(","))


# --- subcommands ---


def cmd_inventory(args) -> None:
    report = []
    for name in list_rois(args.export_dir):
        roi = SGRoi(args.export_dir, name)
        rows, cols = roi.shape
        entry = {
            "roi": name,
            "cells": _count_lines(roi.coordinates_path) - 1,
            "genes": _header_columns(roi.counts_path) - 1,
            "pixelSize": roi.pixel_size,
            "imagePixels": [cols, rows],
            "areaMm2": round(rows * cols * roi.pixel_size ** 2 / 1e6, 2),
        }
        if args.count_spots:
            entry["spots"] = _count_lines(roi.transcripts_path) - 1
        report.append(entry)
    _print_json(report)


def cmd_check(args) -> None:
    roi = _roi(args)
    report = {"frame": verify.check_frame(roi, sample=args.sample)}
    if args.recount:
        report["recount"] = verify.recount(roi)
    _print_json(report)
    if report["frame"]["fraction"] < MIN_FRAME_MATCH:
        raise SGError(
            f"only {report['frame']['matched']}/{report['frame']['checked']}"
            " centroids land on their own label: the frame is wrong"
        )


def cmd_images(args) -> None:
    ds = ingest.upload_images(
        _connect(), _roi(args), args.name, parent_folder_id=args.parent
    )
    print(ds.id)


def cmd_polygons(args) -> None:
    roi = _roi(args)
    _require_writable(args.cells_out, "cell map")
    ds = _dataset(args)
    cells = ingest.upload_polygons(
        ds, roi, tags=args.tags.split(",") if args.tags else None,
        limit=args.limit,
    )
    path = cells.save(args.cells_out)
    logger.info("cell map -> %s", path)


def cmd_cell_data(args) -> None:
    roi = _roi(args)
    counts = ingest.upload_cell_data(_dataset(args), roi, _cells(args))
    for cluster, count in sorted(counts.items()):
        logger.info("  Leiden %s: %s cells", cluster, f"{count:,}")


def _checked(args):
    """ROI, cell map, and (unless --no-upload) the dataset — the map
    checked against both before anything is built or written."""
    roi, cells = _roi(args), _cells(args)
    _require_writable(args.out, "output")
    ds = None if args.no_upload else _dataset(args)
    cells.check(ds, roi)
    return roi, cells, ds


def cmd_spatial_table(args) -> None:
    roi, cells, ds = _checked(args)
    path = ingest.build_spatial_table(roi, cells, args.out)
    if ds is not None:
        result = ingest.upload_spatial_table(ds, path)
        logger.info("registered: %s x %s", result.get("nObs"),
                    result.get("nVar"))


def cmd_transcripts(args) -> None:
    roi, cells, ds = _checked(args)
    path = ingest.build_transcript_store(roi, args.out)
    if ds is not None:
        result = ingest.register_transcripts(ds, cells, path)
        logger.info("registered: %s molecules, %s genes",
                    result.get("totalPoints"), result.get("genes"))


def cmd_verify(args) -> None:
    roi, cells = _roi(args), _cells(args)
    ds = _dataset(args)
    report = {"mapChecked": sg_cells.verify_cells(ds, roi, cells)}
    info = ds.spatial.info(verify=True)
    if info:
        report["table"] = {
            "nObs": info.get("nObs"),
            "liveAnnotations": info.get("liveAnnotations"),
        }
    transcripts = ds.spatial.transcripts()
    if transcripts:
        report["transcripts"] = {
            "totalPoints": transcripts.get("totalPoints"),
            "genes": transcripts.get("genes"),
        }
    _print_json(report)
    table = report.get("table")
    if table is None:
        raise SGError("no spatial table is registered on the dataset")
    if table["nObs"] != len(cells):
        raise SGError(
            f"the table has {table['nObs']} rows, the cell map "
            f"{len(cells)} cells"
        )
    if table["liveAnnotations"] != table["nObs"]:
        raise SGError("some table rows no longer join a live annotation")
    if not transcripts:
        raise SGError("no transcripts are registered on the dataset")


def cmd_ingest(args) -> None:
    """Every step for one ROI, state in --work-dir."""
    roi = _roi(args)
    work = Path(args.work_dir)
    try:
        work.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise SGError(f"cannot create the work directory {work}: {exc}")
    outputs = {
        "dataset": work / f"{roi.name}_dataset.txt",
        "cells": work / f"{roi.name}_cells.npz",
        "table": work / f"{roi.name}_spatial.zarr.zip",
        "transcripts": work / f"{roi.name}_transcripts.zarr.zip",
    }
    # Before anything is uploaded: a dataset whose id and cell map were
    # never saved is the one failure the work dir exists to prevent.
    for what, path in outputs.items():
        _require_writable(path, what)
    frame = verify.check_frame(roi)
    logger.info("frame check: %d/%d centroids on their label",
                frame["matched"], frame["checked"])
    if frame["fraction"] < MIN_FRAME_MATCH:
        raise SGError("the frame check failed; nothing uploaded")
    client = _connect()
    ds = ingest.upload_images(
        client, roi, args.name or f"{roi.project} {roi.name}",
        parent_folder_id=args.parent,
    )
    outputs["dataset"].write_text(ds.id)
    logger.info("dataset %s", ds.id)
    cells = ingest.upload_polygons(ds, roi)
    cells.save(outputs["cells"])
    ingest.upload_cell_data(ds, roi, cells)
    table = ingest.build_spatial_table(roi, cells, outputs["table"])
    ingest.upload_spatial_table(ds, table)
    store = ingest.build_transcript_store(roi, outputs["transcripts"])
    ingest.register_transcripts(ds, cells, store)
    logger.info("verified %d cells against the server",
                sg_cells.verify_cells(ds, roi, cells))
    print(ds.id)


# --- parser ---


def _positive_int(value: str) -> int:
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("must be >= 1")
    return number


def _add_roi(parser) -> None:
    parser.add_argument("--export-dir", required=True, type=Path,
                        help="the export (project folder or a parent)")
    parser.add_argument("--roi", required=True, help="e.g. roi_3")


def _add_dataset(parser) -> None:
    parser.add_argument("--dataset", required=True,
                        help="dataset FOLDER id (not a dataset view id)")


def _add_cells(parser) -> None:
    parser.add_argument("--cells", required=True, type=Path,
                        help="cell map saved by `polygons --cells-out`")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="nimbusimage-sg",
        description="Load a Spatial Genomics export into NimbusImage.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("inventory", help="ROIs, cells, genes, image sizes")
    p.add_argument("--export-dir", required=True, type=Path)
    p.add_argument("--count-spots", action="store_true",
                   help="also count TranscriptList rows (reads every file)")
    p.set_defaults(func=cmd_inventory)

    p = sub.add_parser("check", help="local frame check (and recount)")
    _add_roi(p)
    p.add_argument("--sample", type=_positive_int, default=300)
    p.add_argument("--recount", action="store_true",
                   help="reassign every molecule and compare to CellxGene")
    p.set_defaults(func=cmd_check)

    p = sub.add_parser("images", help="create the dataset from the images")
    _add_roi(p)
    p.add_argument("--name", required=True)
    p.add_argument("--parent", help="parent folder id")
    p.set_defaults(func=cmd_images)

    p = sub.add_parser("polygons", help="cell polygons + the cell map")
    _add_roi(p)
    _add_dataset(p)
    p.add_argument("--cells-out", required=True, type=Path)
    p.add_argument("--tags", help="comma-separated (default: cell)")
    p.add_argument("--limit", type=_positive_int,
                   help="upload only the first N cells (a test slice)")
    p.set_defaults(func=cmd_polygons)

    p = sub.add_parser("cell-data", help="Leiden tags, area, UMAP, cluster")
    _add_roi(p)
    _add_dataset(p)
    _add_cells(p)
    p.set_defaults(func=cmd_cell_data)

    p = sub.add_parser("spatial-table", help="CellxGene as a spatial table")
    _add_roi(p)
    _add_dataset(p)
    _add_cells(p)
    p.add_argument("--out", required=True, type=Path)
    p.add_argument("--no-upload", action="store_true")
    p.set_defaults(func=cmd_spatial_table)

    p = sub.add_parser("transcripts", help="TranscriptList as an overlay")
    _add_roi(p)
    _add_dataset(p)
    _add_cells(p)
    p.add_argument("--out", required=True, type=Path)
    p.add_argument("--no-upload", action="store_true")
    p.set_defaults(func=cmd_transcripts)

    p = sub.add_parser("verify", help="check the uploaded dataset")
    _add_roi(p)
    _add_dataset(p)
    _add_cells(p)
    p.set_defaults(func=cmd_verify)

    p = sub.add_parser("ingest", help="every step for one ROI")
    _add_roi(p)
    p.add_argument("--name", help="dataset name (default: '<project> roi')")
    p.add_argument("--parent", help="parent folder id")
    p.add_argument("--work-dir", required=True, type=Path,
                   help="where the cell map and built stores are kept")
    p.set_defaults(func=cmd_ingest)
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
    except SGError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except girder_client.HttpError as exc:
        print(
            f"error: the server refused: {_server_message(exc)}",
            file=sys.stderr,
        )
        return 1
    finally:
        logger.removeHandler(handler)
    return 0

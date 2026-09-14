#!/usr/bin/env python3
"""Attach Xenium cell-type calls to NimbusImage cell annotations as TAGS.

`*_cell_types.csv` is `cell_id,group`. Cell types are categorical, and
property values are numeric, so each cell polygon is tagged
`--base-tags + [group]`, e.g. ["cell", "Memory B Cell"]. Tags drive the tag
filter, the Analysis panel's categorical axes, and the selection summary.

The CSV cell_id ('aaaaadoa-1') is decoded and matched to the packed zarr
cell_id — row order is NOT trusted. Tags are REPLACED on every touched
annotation; `--reset` writes `--base-tags` only, which undoes this script.

    python xenium_upload_cell_types.py --bundle-dir extracted/ \
        --cell-types *_cell_types.csv --dataset <folderId> \
        --ids ann_ids_morphology.npy --limit 2000       # validate first
"""
from __future__ import annotations

import argparse
import csv
import time
from collections import Counter
from pathlib import Path

import numpy as np

from xenium_common import (
    cell_index_by_id,
    cell_indices_with_annotations,
    connect,
    decode_cell_id,
    inverse_alignment,
    load_or_fetch_annotation_ids,
    log,
    number_of_cells,
    read_pixel_size,
)


def load_labels(cells_zarr: Path, cell_types_csv: Path) -> list[str]:
    """Group label per zarr cell_index, joined on the decoded cell_id."""
    index_of = cell_index_by_id(cells_zarr)
    labels: list[str | None] = [None] * len(index_of)
    with cell_types_csv.open(newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            index = index_of[decode_cell_id(row["cell_id"])]
            if labels[index] is not None:
                raise SystemExit(f"duplicate cell_id {row['cell_id']} in {cell_types_csv}")
            labels[index] = row["group"].strip()
    missing = sum(1 for label in labels if label is None)
    if missing:
        raise SystemExit(f"{missing} cells have no row in {cell_types_csv}")
    return labels  # type: ignore[return-value]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--bundle-dir", type=Path, required=True)
    parser.add_argument("--cell-types", type=Path, required=True, help="*_cell_types.csv")
    parser.add_argument("--dataset", required=True, help="NimbusImage dataset (folder) id")
    parser.add_argument("--ids", type=Path, default=None,
                        help=".npy of annotation ids in cell_index order")
    parser.add_argument("--alignment", type=Path, default=None,
                        help="H&E alignment csv, needed to VERIFY ids on the H&E dataset")
    parser.add_argument("--base-tags", default="cell",
                        help="comma-separated tags every cell keeps (default: cell)")
    parser.add_argument("--chunk", type=int, default=5000)
    parser.add_argument("--limit", type=int, default=None, help="only the first N cells")
    parser.add_argument("--reset", action="store_true",
                        help="write --base-tags only (removes the cell-type tags)")
    args = parser.parse_args()

    cells_zarr = args.bundle_dir / "cells.zarr.zip"
    base_tags = [tag.strip() for tag in args.base_tags.split(",") if tag.strip()]
    labels = load_labels(cells_zarr, args.cell_types)
    counts = Counter(labels)
    log(f"{len(labels):,} cell-type labels in {len(counts)} groups")
    for group, count in counts.most_common():
        log(f"  {count:>9,}  {group}")

    ds = connect().dataset(args.dataset)
    log(f"=== {ds.name} ({number_of_cells(cells_zarr):,} cells) ===")
    ids = load_or_fetch_annotation_ids(
        ds, args.ids, cells_zarr, read_pixel_size(args.bundle_dir),
        inverse_alignment(args.alignment),
    )
    stop = min(args.limit or len(ids), len(ids))
    started = time.time()
    for c0 in range(0, stop, args.chunk):
        c1 = min(c0 + args.chunk, stop)
        ds.annotations.update_many([
            (str(ids[c]), {"tags": base_tags if args.reset else [*base_tags, labels[c]]})
            for c in cell_indices_with_annotations(ids, c0, c1)
        ])
        log(f"  tagged cells {c0:,}-{c1:,} ({time.time() - started:.0f}s)")

    # Read a sample back: the bulk update returns no body.
    rng = np.random.default_rng(0)
    tagged = cell_indices_with_annotations(ids, 0, stop)
    for c in rng.choice(tagged, size=min(20, len(tagged)), replace=False):
        expected = base_tags if args.reset else [*base_tags, labels[c]]
        actual = ds.annotations.get(str(ids[c])).tags
        if sorted(actual) != sorted(expected):
            raise SystemExit(f"VERIFY FAILED cell {c}: {actual!r} != {expected!r}")
    log(f"DONE: {stop:,} cells {'reset' if args.reset else 'tagged'}; 20 verified by read-back")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

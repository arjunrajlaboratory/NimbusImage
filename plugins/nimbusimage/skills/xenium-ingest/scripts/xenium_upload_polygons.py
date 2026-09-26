#!/usr/bin/env python3
"""Upload Xenium segmentation polygons to a NimbusImage dataset.

Reads `cells.zarr.zip` (polygon set "cell" by default, "nucleus" optional),
converts micron vertices to pixels of the target image, and bulk-creates
polygon annotations in cell_index order. Saves the server-assigned ids to
`--ids-out` so the property/cell-type scripts never have to re-derive the
cell_index -> annotation_id map.

Transforms:
    morphology image : px = micron / pixel_size
    H&E image        : px = inverse(alignment) @ [micron / pixel_size, 1]

Validate orientation empirically BEFORE a full run (see SKILL.md §3), then
upload a slice with a distinct tag:

    python xenium_upload_polygons.py --bundle-dir extracted/ --dataset <folderId> \
        --limit 5000 --tags xenium-test
    # ... eyeball it in the viewer, then remove and run for real:
    python xenium_upload_polygons.py --bundle-dir extracted/ --dataset <folderId> \
        --delete-tag xenium-test --ids-out ann_ids_morphology.npy
    # H&E dataset:
    python xenium_upload_polygons.py --bundle-dir extracted/ --dataset <heFolderId> \
        --alignment *_he_imagealignment.csv --ids-out ann_ids_he.npy
"""
from __future__ import annotations

import argparse
import time
from pathlib import Path

import numpy as np

import nimbusimage as ni
from xenium_common import (
    CELL_POLYGON_SET,
    connect,
    inverse_alignment,
    load_polygon_set,
    log,
    polygon_coordinates,
    read_pixel_size,
)


def delete_tagged(ds, tag: str) -> int:
    existing = ds.annotations.list(tags=[tag])
    if existing:
        ds.annotations.delete_many([annotation.id for annotation in existing])
    return len(existing)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--bundle-dir", type=Path, required=True,
                        help="directory holding experiment.xenium and cells.zarr.zip")
    parser.add_argument("--dataset", required=True, help="NimbusImage dataset (folder) id")
    parser.add_argument("--alignment", type=Path, default=None,
                        help="*_he_imagealignment.csv when the target is the H&E image")
    parser.add_argument("--pixel-size", type=float, default=None,
                        help="µm/px override (default: experiment.xenium pixel_size)")
    parser.add_argument("--polygon-set", default=CELL_POLYGON_SET, choices=["cell", "nucleus"])
    parser.add_argument("--tags", default="cell", help="comma-separated tags (default: cell)")
    parser.add_argument("--batch", type=int, default=5000)
    parser.add_argument("--limit", type=int, default=None, help="only the first N polygons")
    parser.add_argument("--delete-tag", default=None,
                        help="first delete every annotation carrying this tag (test runs)")
    parser.add_argument("--ids-out", type=Path, default=None,
                        help="save created annotation ids (cell_index order) to this .npy")
    args = parser.parse_args()

    pixel_size = args.pixel_size or read_pixel_size(args.bundle_dir)
    inverse_matrix = inverse_alignment(args.alignment)
    n_vertices, vertices = load_polygon_set(args.bundle_dir / "cells.zarr.zip", args.polygon_set)
    tags = [tag.strip() for tag in args.tags.split(",") if tag.strip()]
    log(f"{len(n_vertices):,} {args.polygon_set} polygons, pixel size {pixel_size} µm/px, "
        f"{'H&E inverse-affine' if inverse_matrix is not None else 'identity'} transform")

    ds = connect().dataset(args.dataset)
    if args.delete_tag:
        removed = delete_tagged(ds, args.delete_tag)
        log(f"removed {removed} annotations tagged {args.delete_tag!r}")

    stop = min(args.limit or len(n_vertices), len(n_vertices))
    ids = np.empty(stop, dtype=object)
    started = time.time()
    buffer, buffer_indices = [], []

    def flush():
        created = ds.annotations.create_many(buffer)
        if len(created) != len(buffer):
            raise SystemExit(f"server created {len(created)} of {len(buffer)} annotations")
        for index, annotation in zip(buffer_indices, created):
            ids[index] = annotation.id
        buffer.clear()
        buffer_indices.clear()

    for i in range(stop):
        n = int(n_vertices[i])
        if n < 3:
            continue
        buffer.append(ni.Annotation(
            shape="polygon", tags=tags, channel=0, dataset_id=args.dataset,
            coordinates=polygon_coordinates(vertices[i], n, pixel_size, inverse_matrix),
            location=ni.Location(xy=0, z=0, time=0),
        ))
        buffer_indices.append(i)
        if len(buffer) >= args.batch:
            flush()
            log(f"  {i + 1:,}/{stop:,} ({time.time() - started:.0f}s)")
    if buffer:
        flush()
    log(f"DONE {stop:,} polygons in {time.time() - started:.0f}s; dataset now has "
        f"{ds.annotations.count(shape='polygon'):,} polygon annotations")
    if args.ids_out:
        np.save(args.ids_out, ids)
        log(f"saved annotation ids to {args.ids_out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

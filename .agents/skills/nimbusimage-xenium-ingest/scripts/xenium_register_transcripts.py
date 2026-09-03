#!/usr/bin/env python3
"""Upload a Xenium bundle's transcripts.zarr.zip into a dataset and register it.

The file is used AS SHIPPED by 10x: it is already a level-of-detail pyramid
(`grids/{level}/{gx},{gy}`, 250 um * 2**level tiles) with a per-gene 10 um
density grid, so nothing is rebuilt. Registration records how molecule
coordinates (microns) land on this dataset's pixels:

    pixelSize   microns per pixel, from experiment.xenium
    transform   only for the H&E dataset: the INVERSE of *_he_imagealignment.csv
                (morphology px -> H&E px), the same matrix the polygons used

Run this once per dataset (morphology and, with --alignment, H&E). The
expression table (xenium_build_spatial_store.py) is independent; when both
are registered, clicking a molecule in the viewer can name its cell.

    python xenium_register_transcripts.py --bundle-dir extracted/ --dataset <folderId>
    python xenium_register_transcripts.py --bundle-dir extracted/ --dataset <heFolderId> \\
        --alignment extracted/*_he_imagealignment.csv

Upload is the slow part (the lymph node file is 4.7 GB); `--item` skips it and
registers an item already in the folder.
"""
from __future__ import annotations

import argparse
import os
import time
from pathlib import Path

from xenium_common import connect, inverse_alignment, log, read_pixel_size


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--bundle-dir", type=Path, required=True)
    parser.add_argument("--dataset", required=True, help="NimbusImage dataset (folder) id")
    parser.add_argument("--alignment", type=Path, default=None,
                        help="*_he_imagealignment.csv when the dataset is the H&E image")
    parser.add_argument("--item", default=None,
                        help="register this already-uploaded item instead of uploading")
    args = parser.parse_args()

    started = time.time()
    client = connect()
    ds = client.dataset(args.dataset)
    log(f"=== {ds.name} ===")
    pixel_size = read_pixel_size(args.bundle_dir)
    transform = inverse_alignment(args.alignment)

    item_id = args.item
    if item_id is None:
        path = args.bundle_dir / "transcripts.zarr.zip"
        log(f"  uploading {path} ({os.path.getsize(path) / 1e9:.1f} GB)")
        item_id = ds.spatial.upload_transcripts(path)["_id"]
        log(f"  uploaded as item {item_id} ({time.time() - started:.0f}s)")

    schema = ds.spatial.register_transcripts(item_id, pixel_size, transform)
    log(f"  registered: {schema['totalPoints']:,} molecules, {schema['genes']:,} genes, "
        f"{schema['levels']} pyramid levels, pixelSize {pixel_size} um/px"
        + (" with H&E transform" if transform is not None else "")
        + f"; total {time.time() - started:.0f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
